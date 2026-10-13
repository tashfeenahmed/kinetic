/**
 * Switzerland: SOGC / SHAB commercial-register "changes" (HR02) on the Amtsblattportal
 * open API (no key). A keyword search narrows the day's notices to those mentioning the
 * share capital; each notice's XML flags `capitalChanged/nominal` and carries the
 * capital after (commonsNew) and before (commonsActual), the company purpose and the
 * people newly registered.
 */
import { getJson } from '../../gtm/lib/http.ts';
import { FUND_WORDS, getText, mapLimit, money, nameCase, person, tag, tags, type CountryFetcher, type FundingEvent, type Person } from './common.ts';

const API = 'https://amtsblattportal.ch/api/v1/publications';
const KEYWORDS = ['Aktienkapital', 'Stammkapital', 'capital-actions', 'capital social', 'capitale azionario', 'capitale sociale'];
const ROLE = /(präsident|vizepräsident|mitglied|geschäftsführ|direktor|vorsitz|président|vice-président|membre|gérant|directeur|presidente|membro|gerente|direttore|ceo|cfo|cto)[^,;]*/i;
const ROLE_EN: [RegExp, string][] = [[/präsident des verwaltungsrates|président du conseil|presidente del consiglio/i, 'Chair of the Board'], [/vorsitzende[rn]? der geschäfts(?:führung|leitung)|directeur général|direttore generale|\bceo\b/i, 'CEO'], [/geschäftsführ|gérant|gerente/i, 'Managing Director'], [/direktor|directeur|direttore/i, 'Director'], [/mitglied des verwaltungsrates|membre du conseil|membro del consiglio/i, 'Board Member']];
const RANK = ['CEO', 'Managing Director', 'Chair of the Board', 'Director', 'Board Member'];

/** People registered new or changed: "Muster, Hans, deutscher Staatsangehöriger, in Zürich, Präsident des Verwaltungsrates, …". */
export function sogcPeople(text: string): Person[] {
  const sec = text.match(/(?:Eingetragene Personen neu oder mutierend|Personnes? inscrites? nouvelles? ou modifiées?|Persone iscritte nuove o modificate)\s*:\s*([\s\S]*?)(?:\.\s*(?:Ausgeschiedene|Personnes? radiées?|Persone radiate)|$)/i)?.[1];
  if (!sec) return [];
  const out: Person[] = [];
  for (const entry of sec.split(/;\s*/)) {
    const parts = entry.split(',').map((s) => s.trim());
    if (parts.length < 3 || /\b(AG|SA|GmbH|Sàrl|S\.A\.|Ltd)\b/.test(parts[0])) continue;
    const roleRaw = parts.slice(2).find((x) => ROLE.test(x)) ?? '';
    if (/revision|réviseur|revisore|liquidat/i.test(roleRaw) || /revisionsstelle|organe de révision/i.test(entry)) continue;
    const title = ROLE_EN.find(([re]) => re.test(roleRaw))?.[1] ?? (roleRaw ? nameCase(roleRaw) : undefined);
    out.push(person(parts[1].replace(/\[.*$/, ''), parts[0], title));
  }
  return out.filter((p) => p.title).sort((a, b) => (RANK.indexOf(a.title ?? '') + 100) % 100 - (RANK.indexOf(b.title ?? '') + 100) % 100);
}

export function parseSogc(xml: string, id: string): FundingEvent | null {
  const changed = tags(xml, 'capitalChanged')[0] ?? '';
  if (!/<nominal>true/.test(changed)) return null;
  const now = tags(xml, 'commonsNew')[0] ?? '';
  const was = tags(xml, 'commonsActual')[0] ?? '';
  const after = Number(tag(tags(now, 'capital')[0] ?? '', 'nominal')) || undefined;
  const before = Number(tag(tags(was, 'capital')[0] ?? '', 'nominal')) || undefined;
  if (!after || (before && after <= before)) return null;
  const co = tags(now, 'company')[0] ?? '';
  const text = tag(xml, 'publicationText');
  const cur = text.match(/kapital neu:\s*([A-Z]{3})|capital[^:]{0,20}:\s*([A-Z]{3})/i);
  const currency = (cur?.[1] ?? cur?.[2] ?? 'CHF').toUpperCase();
  return {
    country: 'ch', company: tag(co, 'name'), date: tag(xml, 'publicationDate'),
    capitalBefore: before, capitalAfter: after, currency,
    signal: before ? `Capital increase ${money(before, currency)} → ${money(after, currency)} (SOGC)` : `Capital increase to ${money(after, currency)} (SOGC)`,
    city: tag(co, 'seat'), people: sogcPeople(text), industry: tag(now, 'purpose').slice(0, 160) || undefined,
    filingUrl: `https://amtsblattportal.ch/#!/search/publications/detail/${id}`, registryId: tag(co, 'uid') || undefined,
    source: 'SOGC', text: tag(now, 'purpose'),
  };
}

export const fetchCh: CountryFetcher = async (p, ctx) => {
  const ids = new Set<string>();
  for (const keyword of KEYWORDS) {
    for (let page = 0; page < 20; page++) {
      const d = await getJson(API, { direct: true, query: { publicationStates: 'PUBLISHED', subRubrics: 'HR02', 'publicationDate.start': p.since, 'publicationDate.end': p.until, keyword, 'pageRequest.size': 100, 'pageRequest.page': page } });
      for (const c of d?.content ?? []) ids.add(c.meta.id);
      if ((d?.content ?? []).length < 100) break;
    }
  }
  const out: FundingEvent[] = [];
  const list = [...ids];
  for (let i = 0; i < list.length && out.length < p.limit; i += 20) {
    const evs = await mapLimit(list.slice(i, i + 20), 4, async (id) => {
      try { return parseSogc(await getText(`${API}/${id}/xml`), id); } catch (e: any) { ctx.log(`SOGC ${id}: ${e.message}`); return null; }
    });
    for (const ev of evs) {
      if (!ev || out.length >= p.limit) continue;
      if (!p.includeFunds && FUND_WORDS.test(`${ev.company} ${ev.text ?? ''}`.slice(0, 200))) continue;
      if ((ev.capitalAfter ?? 0) < p.minCapital) continue;
      if (p.keep(ev)) out.push(ev);
    }
  }
  ctx.log(`Switzerland SOGC: ${out.length} companies (${ids.size} capital notices ${p.since}…${p.until})`);
  return out;
};
