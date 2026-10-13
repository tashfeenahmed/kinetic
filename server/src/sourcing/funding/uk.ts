/**
 * United Kingdom: SH01 "return of allotment of shares" filings. Companies House's REST
 * API can't list filings across companies, so `ukStreamJob` follows the free filing
 * stream (needs a *stream* key, separate from the REST key) and keeps SH01s in
 * funding_uk_filings. The source then adds the company profile, the capital before
 * (previous capital filing) and the active directors from the REST API.
 */
import type { Ctx as AppCtx } from '../../context.ts';
import type { Db } from '../../db/db.ts';
import { getSetting, setSetting } from '../../settings.ts';
import { getJson, request } from '../../gtm/lib/http.ts';
import { FUND_WORDS, mapLimit, money, nameCase, surnameFirst, type CountryFetcher, type FundingEvent, type Person } from './common.ts';

const REST = 'https://api.company-information.service.gov.uk';
const STREAM = 'https://stream.companieshouse.gov.uk/filings';
const TIMEPOINT = 'ch_stream_timepoint';
const KEEP_DAYS = 90;

const basic = (key: string) => ({ authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` });

/** Total capital from SH01 / statement-of-capital description values: [{ figure: "1,234.50", currency: "GBP" }]. */
export function capitalOf(values: any): { amount: number; currency: string } | null {
  const list: any[] = Array.isArray(values?.capital) ? values.capital : [];
  if (!list.length) return null;
  const currency = String(list[0].currency ?? 'GBP');
  const amount = list.filter((c) => String(c.currency ?? 'GBP') === currency).reduce((n, c) => n + (Number(String(c.figure ?? '').replace(/,/g, '')) || 0), 0);
  return amount ? { amount, currency } : null;
}

/** One stream line → an SH01 row to keep (null for anything else). */
export function parseStreamLine(line: string): { timepoint?: number; row?: { transaction_id: string; company_number: string; filed: string; capital: string; published_at: string } } {
  if (!line.trim()) return {};
  let ev: any;
  try { ev = JSON.parse(line); } catch { return {}; }
  const timepoint = Number(ev.event?.timepoint) || undefined;
  const d = ev.data ?? {};
  if (d.type !== 'SH01' || ev.event?.type === 'deleted') return { timepoint };
  const number = String(ev.resource_uri ?? '').match(/\/company\/([A-Z0-9]+)\//i)?.[1];
  if (!number) return { timepoint };
  return {
    timepoint,
    row: { transaction_id: String(d.transaction_id ?? ev.resource_id), company_number: number, filed: String(d.date ?? '').slice(0, 10), capital: JSON.stringify(d.description_values?.capital ?? []), published_at: String(ev.event?.published_at ?? new Date().toISOString()) },
  };
}

/** Reads the stream for up to `maxMs` from the saved timepoint, storing SH01s. Returns how many were stored. */
export async function drainStream(db: Db, streamKey: string, maxMs = 50_000, log: (m: string) => void = () => {}): Promise<number> {
  const saved = getSetting(db, TIMEPOINT);
  let res = await request(STREAM, { headers: basic(streamKey), query: saved ? { timepoint: saved } : {}, timeoutMs: maxMs, direct: true });
  if (res.status === 416 && saved) { // timepoint too old: start from now
    setSetting(db, TIMEPOINT, null);
    res = await request(STREAM, { headers: basic(streamKey), timeoutMs: maxMs, direct: true });
  }
  if (res.status === 401) throw new Error('Companies House stream key rejected — create a "Streaming API" key at developer.company-information.service.gov.uk and save it as COMPANIES_HOUSE_STREAM_KEY');
  if (!res.ok || !res.body) throw new Error(`Companies House stream ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let stored = 0;
  let last: number | undefined;
  const flush = () => { if (last) setSetting(db, TIMEPOINT, String(last)); };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const { timepoint, row } = parseStreamLine(line);
        if (timepoint) last = timepoint;
        if (row) stored += db.run('INSERT OR IGNORE INTO funding_uk_filings (transaction_id, company_number, filed, capital, published_at) VALUES (?, ?, ?, ?, ?)', [row.transaction_id, row.company_number, row.filed, row.capital, row.published_at]).changes;
      }
      flush();
    }
  } catch (e: any) {
    if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') log(`Companies House stream: ${e.message}`);
  } finally {
    flush();
    reader.cancel().catch(() => {});
  }
  db.run('DELETE FROM funding_uk_filings WHERE published_at < ?', [new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()]);
  return stored;
}

/** Worker job: keep following the stream when a stream key is set. */
export async function ukStreamJob(app: AppCtx) {
  const key = app.gtm?.settings.get('COMPANIES_HOUSE_STREAM_KEY');
  if (!key) return;
  const n = await drainStream(app.db, key, 50_000, (m) => app.gtm!.store.log('error', 'funding', m));
  if (n) app.gtm!.store.log('info', 'funding', `Companies House stream: ${n} new share allotments (SH01)`);
}

const RANK = /chief executive|ceo|founder|managing director|president|chief/i;

export const fetchUk: CountryFetcher = async (p, ctx) => {
  const restKey = ctx.settings.get('COMPANIES_HOUSE_API_KEY');
  if (!ctx.settings.get('COMPANIES_HOUSE_STREAM_KEY')) throw new Error('UK needs a free Companies House stream key (COMPANIES_HOUSE_STREAM_KEY): SH01 share allotments are only listed on the filing stream');
  if (!restKey) throw new Error('UK needs COMPANIES_HOUSE_API_KEY (free) to read company details and directors');
  if (!ctx.db) throw new Error('UK funding source needs the app database');
  const rows = ctx.db.all<{ transaction_id: string; company_number: string; filed: string; capital: string; published_at: string }>(
    'SELECT * FROM funding_uk_filings WHERE published_at >= ? AND substr(published_at, 1, 10) <= ? ORDER BY published_at DESC', [`${p.since}T00:00:00`, p.until]);
  if (!rows.length) {
    const any = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM funding_uk_filings')!.n;
    ctx.log(any ? `UK: no SH01s captured between ${p.since} and ${p.until}` : 'UK: the Companies House stream has not captured any SH01s yet (it starts from when the stream key was added)');
    return [];
  }
  const auth = basic(restKey);
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.company_number) && seen.add(r.company_number));
  const out: FundingEvent[] = [];
  for (let i = 0; i < unique.length && out.length < p.limit; i += 10) {
    const evs = await mapLimit(unique.slice(i, i + 10), 3, async (r): Promise<FundingEvent | null> => {
      try {
        const co = await getJson(`${REST}/company/${r.company_number}`, { headers: auth, direct: true });
        if (co.company_status !== 'active' || !/^(ltd|plc|private-limited-shares-section-30-exemption)$/.test(co.type)) return null;
        const ageDays = (Date.parse(r.published_at) - Date.parse(co.date_of_creation)) / 86_400_000;
        if (!p.includeFunds && (ageDays < 90 || FUND_WORDS.test(co.company_name))) return null; // founder allotments right after incorporation, vehicles
        const after = capitalOf({ capital: JSON.parse(r.capital || '[]') });
        if (after && after.amount < p.minCapital) return null;
        const ev: FundingEvent = {
          country: 'uk', company: nameCase(co.company_name), date: r.published_at.slice(0, 10), capitalAfter: after?.amount, currency: after?.currency ?? 'GBP',
          signal: '', industryCode: co.sic_codes?.[0], industry: co.sic_codes?.length ? `SIC ${co.sic_codes.join(', ')}` : undefined,
          city: nameCase(co.registered_office_address?.locality ?? ''), people: [],
          filingUrl: `https://find-and-update.company-information.service.gov.uk/company/${r.company_number}/filing-history`, registryId: `Company ${r.company_number}`,
          source: 'Companies House SH01', text: co.company_name,
        };
        if (!p.keep(ev)) return null;
        // Capital before: the newest earlier capital filing with a statement of capital.
        const hist = await getJson(`${REST}/company/${r.company_number}/filing-history`, { headers: auth, query: { category: 'capital,incorporation', items_per_page: 25 }, direct: true }).catch(() => null);
        const earlier = (hist?.items ?? []).filter((x: any) => x.transaction_id !== r.transaction_id && String(x.date) <= (r.filed || ev.date)).map((x: any) => capitalOf(x.description_values)).find(Boolean);
        if (earlier && after && earlier.currency === after.currency && earlier.amount < after.amount) ev.capitalBefore = earlier.amount;
        const pct = ev.capitalBefore && ev.capitalAfter ? (ev.capitalAfter - ev.capitalBefore) / ev.capitalAfter : undefined;
        if (!p.includeFunds && pct != null && pct > 0.6) return null; // founders topping up, not an outside round
        const off = await getJson(`${REST}/company/${r.company_number}/officers`, { headers: auth, query: { items_per_page: 35 }, direct: true }).catch(() => null);
        ev.people = (off?.items ?? []).filter((o: any) => !o.resigned_on && /director/.test(o.officer_role) && !/corporate/.test(o.officer_role))
          .map((o: any): Person => surnameFirst(o.name, o.occupation && !/^(director|none|company director)$/i.test(o.occupation) ? nameCase(o.occupation) : 'Director'))
          .sort((a: Person, b: Person) => Number(RANK.test(b.title ?? '')) - Number(RANK.test(a.title ?? '')));
        ev.signal = `Allotted new shares (SH01)${ev.capitalBefore ? `: capital ${money(ev.capitalBefore, ev.currency)} → ${money(ev.capitalAfter, ev.currency)}` : after ? `: capital now ${money(after.amount, after.currency)}` : ''}`;
        return ev;
      } catch (e: any) { ctx.log(`Companies House ${r.company_number}: ${e.message}`); return null; }
    });
    for (const ev of evs) if (ev && out.length < p.limit) out.push(ev);
  }
  ctx.log(`UK Companies House: ${out.length} companies (${unique.length} SH01 filers ${p.since}…${p.until})`);
  return out;
};
