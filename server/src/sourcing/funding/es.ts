/**
 * Spain: BORME (Boletín Oficial del Registro Mercantil), section A, through the BOE
 * open-data API (no key). Each working day has one XML file per province listing the
 * acts registered for each company; "Ampliación de capital. Capital: X Euros.
 * Resultante Suscrito: Y Euros." is a share issue. A small, odd-sized issue (a few % of
 * the company) is the shape of a priced investment round; appointments in the same
 * notice name the directors.
 */
import { getJson } from '../../gtm/lib/http.ts';
import { decodeXml, FUND_WORDS, getText, mapLimit, money, nameCase, person, type CountryFetcher, type FundingEvent, type Person } from './common.ts';

const num = (s?: string) => (s ? Number(s.replace(/\./g, '').replace(',', '.')) : undefined);
const ROLES = 'Adm\\. Unico|Adm\\. Solid\\.|Adm\\. Mancom\\.|Consejero|Presidente|Vicepresidente|Con\\.Delegado|Cons\\.Del\\.Man|Consejero Delegado|Director General|Apoderado|Adm\\. Concursal|Secretario';
const ROLE_LABEL: Record<string, string> = { 'Adm. Unico': 'Sole Director', 'Adm. Solid.': 'Joint Director', 'Adm. Mancom.': 'Joint Director', 'Con.Delegado': 'CEO (Consejero Delegado)', 'Cons.Del.Man': 'CEO (Consejero Delegado)', 'Consejero Delegado': 'CEO (Consejero Delegado)', Presidente: 'Chair', Vicepresidente: 'Vice Chair', Consejero: 'Board Member', Apoderado: 'Attorney', Secretario: 'Secretary', 'Director General': 'General Manager' };
const RANK = ['CEO (Consejero Delegado)', 'Sole Director', 'General Manager', 'Chair', 'Joint Director', 'Board Member'];

/** "RODRIGUEZ PUERTA JUAN JOSE" (surnames first) → Juan Jose Rodriguez Puerta. */
export function spanishName(s: string, title?: string): Person {
  const w = s.trim().split(/\s+/);
  const surnames = w.length >= 3 ? 2 : 1;
  return person(w.slice(surnames).join(' '), w.slice(0, surnames).join(' '), title);
}

/** People appointed or re-elected in one company paragraph (companies acting as directors skipped). */
export function borPeople(text: string): Person[] {
  const out: Person[] = [];
  const re = new RegExp(`(?:Nombramientos|Reelecciones)\\.\\s*((?:(?:${ROLES})\\s*:\\s*[^.]+\\.\\s*)+)`, 'g');
  for (const block of text.matchAll(re)) {
    for (const m of block[1].matchAll(new RegExp(`(${ROLES})\\s*:\\s*([^.]+)\\.`, 'g'))) {
      const title = ROLE_LABEL[m[1]] ?? m[1];
      if (title === 'Attorney' || title === 'Secretary') continue;
      for (const n of m[2].split(';')) if (n.trim() && !/\b(SL|SA|SLU|SAU|SLP|SOCIEDAD|S\.L|S\.A)\b/i.test(n)) out.push(spanishName(n, title));
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => !seen.has(x.name) && seen.add(x.name)).sort((a, b) => (RANK.indexOf(a.title ?? '') + 100) % 100 - (RANK.indexOf(b.title ?? '') + 100) % 100);
}

export interface BormeEntry { company: string; text: string; province: string }

/** Company entries of one province XML: `<p class="articulo">123 - NAME.</p><p class="parrafo">…</p>`. */
export function parseBormeXml(xml: string): BormeEntry[] {
  const province = decodeXml(xml.match(/<titulo>([^<]+)<\/titulo>/)?.[1] ?? '');
  const out: BormeEntry[] = [];
  for (const m of xml.matchAll(/<p class="articulo">\s*\d+\s*-\s*([\s\S]*?)<\/p>\s*((?:<p class="parrafo(?:_2)?">[\s\S]*?<\/p>\s*)+)/g)) {
    const text = decodeXml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    out.push({ company: decodeXml(m[1]).replace(/\.\s*$/, '').trim(), text, province });
  }
  return out;
}

/** "VALERO GREEN QUALITY, S.L(R.M. ALMERIA)." → "Valero Green Quality". */
export function bormeCompany(s: string): string {
  return nameCase(s.replace(/\(R\.M\.[^)]*\)/gi, '').replace(/[,\s]+(S\.?\s?L\.?\s?[UP]?|S\.?\s?A\.?\s?U?|S\.?\s?COOP\.?.*|S\.?\s?L\.?\s?N\.?\s?E\.?|SOCIEDAD LIMITADA(?: UNIPERSONAL)?|SOCIEDAD AN[OÓ]NIMA)\.?\s*$/i, '').trim());
}

export function bormeEvent(e: BormeEntry, date: string, url: string): FundingEvent | null {
  const m = e.text.match(/Ampliación de capital\.\s*Capital:\s*([\d.,]+)\s*Euros\.(?:\s*Resultante Suscrito:\s*([\d.,]+)\s*Euros)?/i);
  if (!m) return null;
  const added = num(m[1])!;
  const after = num(m[2]);
  const before = after && after > added ? after - added : undefined;
  return {
    country: 'es', company: bormeCompany(e.company), date, capitalBefore: before, capitalAfter: after, currency: 'EUR',
    signal: before ? `Capital increase +${money(added, 'EUR')} → ${money(after, 'EUR')} (BORME)` : `Capital increase +${money(added, 'EUR')} (BORME)`,
    city: nameCase(e.province.split('/')[0]), people: borPeople(e.text), filingUrl: url, source: 'BORME', text: e.text.slice(0, 400),
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

export const fetchEs: CountryFetcher = async (p, ctx) => {
  const days: string[] = [];
  for (let t = new Date(`${p.until}T00:00:00Z`); t >= new Date(`${p.since}T00:00:00Z`); t = new Date(t.getTime() - 86_400_000)) if (t.getUTCDay() % 6) days.push(ymd(t));
  const out: FundingEvent[] = [];
  let files = 0;
  for (const d of days) {
    if (out.length >= p.limit) break;
    let sum: any;
    try { sum = await getJson(`https://www.boe.es/datosabiertos/api/borme/sumario/${d}`, { headers: { accept: 'application/json' }, direct: true }); } catch { continue; } // no bulletin that day
    const items: any[] = (sum?.data?.sumario?.diario ?? []).flatMap((x: any) => x.seccion ?? []).filter((s: any) => s.codigo === 'A').flatMap((s: any) => (Array.isArray(s.item) ? s.item : [s.item])).filter(Boolean);
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    const perFile = await mapLimit(items, 4, async (it: any) => {
      try {
        const xml = await getText(it.url_xml);
        files++;
        return parseBormeXml(xml).map((e) => bormeEvent(e, date, it.url_html ?? it.url_pdf?.texto)).filter(Boolean) as FundingEvent[];
      } catch (e: any) { ctx.log(`BORME ${it.identificador}: ${e.message}`); return []; }
    });
    for (const ev of perFile.flat()) {
      if (out.length >= p.limit) break;
      if (!p.includeFunds && FUND_WORDS.test(ev.company)) continue;
      const pct = ev.capitalBefore && ev.capitalAfter ? (ev.capitalAfter - ev.capitalBefore) / ev.capitalAfter : undefined;
      // Investment-round shape: some new shares, but not a founder top-up that doubles the company.
      if (!p.includeFunds && (pct == null || pct < 0.005 || pct > 0.6)) continue;
      if ((ev.capitalAfter ?? 0) < p.minCapital) continue;
      if (p.keep(ev)) out.push(ev);
    }
  }
  ctx.log(`Spain BORME: ${out.length} companies (${files} province files, ${days.length} days)`);
  return out;
};
