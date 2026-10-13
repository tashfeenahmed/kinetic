/**
 * Norway: Brønnøysund Register Centre open data (no key). The entity update feed lists
 * every change since a date as JSON patches; a patch to `/kapital/belop` is a registered
 * share-capital change. The entity record adds the website, email, phone, industry code
 * and capital; the roles endpoint names the CEO (daglig leder) and board chair.
 */
import { getJson } from '../../gtm/lib/http.ts';
import { FUND_WORDS, mapLimit, money, nameCase, person, type CountryFetcher, type FundingEvent, type Person } from './common.ts';

const API = 'https://data.brreg.no/enhetsregisteret/api';
const ROLE_TITLES: Record<string, string> = { DAGL: 'CEO (Daglig leder)', LEDE: 'Chair of the Board', NEST: 'Deputy Chair', MEDL: 'Board Member', KONT: 'Contact person' };

export interface CapitalChange { orgnr: string; at: string; belop: number; shares?: number }

/** Capital changes from one page of the update feed (latest per company). */
export function capitalChanges(updates: any[]): CapitalChange[] {
  const by = new Map<string, CapitalChange>();
  for (const u of updates) {
    const ch = (u.endringer ?? []).filter((e: any) => String(e.path).startsWith('/kapital'));
    const belop = ch.find((e: any) => e.path === '/kapital/belop')?.value;
    if (belop == null) continue;
    by.set(u.organisasjonsnummer, { orgnr: u.organisasjonsnummer, at: String(u.dato).slice(0, 10), belop: Number(belop), shares: ch.find((e: any) => e.path === '/kapital/antallAksjer')?.value });
  }
  return [...by.values()];
}

export function rolesPeople(roller: any): Person[] {
  const out: Person[] = [];
  for (const g of roller?.rollegrupper ?? []) for (const r of g.roller ?? []) {
    const code = r.type?.kode;
    if (!ROLE_TITLES[code] || r.avregistrert || r.fratraadt || !r.person?.navn || r.person.erDoed) continue;
    const n = r.person.navn;
    out.push(person([n.fornavn, n.mellomnavn].filter(Boolean).join(' '), n.etternavn, ROLE_TITLES[code]));
  }
  const rank = Object.values(ROLE_TITLES);
  const seen = new Set<string>();
  return out.sort((a, b) => rank.indexOf(a.title!) - rank.indexOf(b.title!)).filter((x) => !seen.has(x.name) && seen.add(x.name));
}

export const fetchNo: CountryFetcher = async (p, ctx) => {
  // Page through the update feed by update id (the API caps page*size at 10,000).
  const changes = new Map<string, CapitalChange>();
  let next: number | undefined;
  for (let page = 0; page < 40; page++) {
    const d = await getJson(`${API}/oppdateringer/enheter`, { direct: true, timeoutMs: 60_000, query: next ? { oppdateringsid: next, size: 10000, includeChanges: 'true' } : { dato: `${p.since}T00:00:00.000Z`, size: 10000, includeChanges: 'true' } });
    const ups: any[] = d?._embedded?.oppdaterteEnheter ?? [];
    for (const c of capitalChanges(ups.filter((u) => String(u.dato).slice(0, 10) <= p.until))) changes.set(c.orgnr, c);
    if (ups.length < 10000 || String(ups.at(-1)?.dato).slice(0, 10) > p.until) break;
    next = Number(ups.at(-1).oppdateringsid) + 1;
  }
  const list = [...changes.values()].filter((c) => c.belop >= p.minCapital).sort((a, b) => b.at.localeCompare(a.at));
  const out: FundingEvent[] = [];
  for (let i = 0; i < list.length && out.length < p.limit; i += 20) {
    const evs = await mapLimit(list.slice(i, i + 20), 4, async (c): Promise<FundingEvent | null> => {
      try {
        const e = await getJson(`${API}/enheter/${c.orgnr}`, { direct: true });
        if (e.organisasjonsform?.kode !== 'AS' && e.organisasjonsform?.kode !== 'ASA') return null; // limited companies only
        if (e.konkurs || e.underAvvikling || e.slettedato) return null;
        const ev: FundingEvent = {
          country: 'no', company: nameCase(e.navn).replace(/\b(As|Asa)$/, (m: string) => m.toUpperCase()), date: c.at, capitalAfter: c.belop, currency: e.kapital?.valuta ?? 'NOK',
          signal: `Share capital changed, now ${money(c.belop, e.kapital?.valuta ?? 'NOK')}${c.shares ? ` (${c.shares.toLocaleString('en')} shares)` : ''} (Brønnøysund)`,
          industry: e.naeringskode1?.beskrivelse, industryCode: e.naeringskode1?.kode, city: nameCase(e.forretningsadresse?.poststed ?? ''),
          website: e.hjemmeside, email: e.epostadresse, phone: e.mobil ?? e.telefon, people: [],
          filingUrl: `https://virksomhet.brreg.no/nb/oppslag/enheter/${c.orgnr}`, registryId: `Org.nr ${c.orgnr}`, source: 'Brønnøysund',
          text: [...(e.aktivitet ?? []), ...(e.vedtektsfestetFormaal ?? [])].join(' '),
        };
        if (!p.includeFunds && (FUND_WORDS.test(`${e.navn} ${ev.text}`) || /^64\.2|^68/.test(ev.industryCode ?? ''))) return null; // holding / property companies
        if (!p.keep(ev)) return null;
        ev.people = rolesPeople(await getJson(`${API}/enheter/${c.orgnr}/roller`, { direct: true }).catch(() => null));
        return ev;
      } catch (err: any) { ctx.log(`Brønnøysund ${c.orgnr}: ${err.message}`); return null; }
    });
    for (const ev of evs) if (ev && out.length < p.limit) out.push(ev);
  }
  ctx.log(`Norway Brønnøysund: ${out.length} companies (${changes.size} capital changes ${p.since}…${p.until})`);
  return out;
};
