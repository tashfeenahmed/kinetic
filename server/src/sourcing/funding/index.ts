/**
 * "Recently funded companies": new money from official registers, one row per company
 * with a named person, for cold outreach right after a raise.
 *
 * params: countries ("us,uk,fr,es,ch,no" or "all"), days (default 7), sector
 * (tech|health|fintech|energy|consumer), query/keywords, industry_codes, min_amount (US $),
 * min_capital (Europe, nominal), include_funds, region (US state code).
 * One country failing (missing key, API down) doesn't stop the others; its error is
 * returned in `warnings`.
 */
import type { Ctx } from '../../gtm/providers/types.ts';
import type { Db } from '../../db/db.ts';
import { COUNTRIES, day, matches, SECTORS, toRow, type Country, type CountryFetcher, type FundingEvent, type FundingParams, type Sector } from './common.ts';
import { fetchUs } from './us.ts';
import { fetchUk } from './uk.ts';
import { fetchFr } from './fr.ts';
import { fetchEs } from './es.ts';
import { fetchCh } from './ch.ts';
import { fetchNo } from './no.ts';

export { COUNTRIES, SECTORS };
export const FETCHERS: Record<Country, CountryFetcher> = { us: fetchUs, uk: fetchUk, fr: fetchFr, es: fetchEs, ch: fetchCh, no: fetchNo };

const ALIASES: Record<string, Country> = {
  us: 'us', usa: 'us', 'united states': 'us', america: 'us',
  uk: 'uk', gb: 'uk', 'united kingdom': 'uk', britain: 'uk', england: 'uk',
  fr: 'fr', france: 'fr', es: 'es', spain: 'es', españa: 'es',
  ch: 'ch', switzerland: 'ch', schweiz: 'ch', suisse: 'ch', no: 'no', norway: 'no', norge: 'no',
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\n,]+/)).map((x) => x.trim()).filter(Boolean);

export function parseCountries(v: unknown): Country[] {
  const raw = list(v).map((x) => x.toLowerCase());
  if (!raw.length || raw.includes('all') || raw.includes('*')) return Object.keys(COUNTRIES) as Country[];
  const out = raw.map((x) => ALIASES[x]).filter(Boolean);
  if (!out.length) throw new Error(`Unknown countries "${raw.join(', ')}" — use any of ${Object.keys(COUNTRIES).join(', ')} or "all"`);
  return [...new Set(out)];
}

export function fundingParams(params: Record<string, any>, limit: number, now = new Date()): FundingParams {
  const days = Math.min(90, Math.max(1, Number(params.days ?? 7)));
  const sector = params.sector && params.sector !== 'any' ? String(params.sector).toLowerCase() as Sector : undefined;
  if (sector && !SECTORS[sector]) throw new Error(`Unknown sector "${params.sector}" — use ${Object.keys(SECTORS).join(', ')} or leave it empty`);
  // `query` is the free-text box (Find prospects / saved searches): words, or a sector name, or "all".
  let keywords = list(params.keywords ?? params.query).filter((k) => !/^(all|any|\*|funded|funding|recently funded)$/i.test(k));
  let fromQuery: Sector | undefined;
  if (!sector && keywords.length === 1 && SECTORS[keywords[0].toLowerCase() as Sector]) { fromQuery = keywords[0].toLowerCase() as Sector; keywords = []; }
  const p: FundingParams = {
    days, since: day(new Date(now.getTime() - days * 86_400_000)), until: day(now), limit,
    keywords, sector: sector ?? fromQuery, industryCodes: list(params.industry_codes ?? params.industryCodes),
    minAmount: Number(params.min_amount ?? 0) || 0, minCapital: Number(params.min_capital ?? 0) || 0,
    includeFunds: params.include_funds === true || params.include_funds === 'yes', region: params.region ? String(params.region) : undefined,
    keep: () => true,
  };
  p.keep = (ev) => matches(ev, p);
  return p;
}

export interface FundingRun { rows: Record<string, unknown>[]; events: FundingEvent[]; perCountry: Record<string, number>; warnings: string[] }

/** Runs the chosen countries in parallel and merges them newest first. `limit` is split across countries. */
export async function fundingRounds(ctx: Ctx & { db?: Db }, params: Record<string, any>, limit: number): Promise<FundingRun> {
  const countries = parseCountries(params.countries ?? params.country);
  const base = fundingParams(params, limit);
  const share = Math.max(5, Math.ceil(limit / countries.length));
  const perCountry: Record<string, number> = {};
  const warnings: string[] = [];
  const results = await Promise.all(countries.map(async (c) => {
    try {
      const evs = await FETCHERS[c]({ ...base, limit: share }, ctx);
      perCountry[c] = evs.length;
      return evs;
    } catch (e: any) {
      warnings.push(`${COUNTRIES[c]}: ${e.message}`);
      ctx.log(`${COUNTRIES[c]} failed: ${e.message}`);
      perCountry[c] = 0;
      return [];
    }
  }));
  // Interleave countries so a busy register doesn't crowd out the others, newest first within each.
  const queues = results.map((r) => [...r].sort((a, b) => b.date.localeCompare(a.date)));
  const events: FundingEvent[] = [];
  while (events.length < limit && queues.some((q) => q.length)) for (const q of queues) if (q.length && events.length < limit) events.push(q.shift()!);
  return { rows: events.map(toRow), events, perCountry, warnings };
}
