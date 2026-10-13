/**
 * Shared shapes for the "recently funded companies" source: every country module turns
 * its official filings (SEC Form D, UK SH01, BODACC, BORME, SOGC, Brønnøysund) into
 * FundingEvents, and `toRow` turns those into table rows with a named person, ready for
 * "Find company domain" → "Find work email".
 */
import type { Ctx } from '../../gtm/providers/types.ts';
import { request } from '../../gtm/lib/http.ts';
import { ownDomain } from '../normalize.ts';

export type Country = 'us' | 'uk' | 'fr' | 'es' | 'ch' | 'no';
export const COUNTRIES: Record<Country, string> = {
  us: 'United States', uk: 'United Kingdom', fr: 'France', es: 'Spain', ch: 'Switzerland', no: 'Norway',
};

export interface Person { name: string; title?: string; firstName?: string; lastName?: string }

export interface FundingEvent {
  country: Country;
  company: string;
  date: string; // YYYY-MM-DD the filing/notice was published
  /** Money raised, when the filing says (Form D only). */
  amountRaised?: number;
  currency?: string;
  /** Registered share capital before → after (European notices; nominal, not the round size). */
  capitalBefore?: number;
  capitalAfter?: number;
  signal: string; // human summary: "Raised $2.5M (Form D, equity)"
  industry?: string;
  industryCode?: string;
  city?: string;
  website?: string;
  email?: string;
  phone?: string;
  people: Person[];
  filingUrl?: string;
  registryId?: string;
  source: string;
  /** Text searched by keyword filters (name, activity, purpose…). */
  text?: string;
}

export interface FundingParams {
  days: number;
  since: string; // YYYY-MM-DD
  until: string;
  limit: number;
  keywords: string[];
  sector?: Sector;
  industryCodes: string[];
  /** US only: smallest amount raised (USD). */
  minAmount: number;
  /** Europe: smallest share capital after the change (local currency, nominal). */
  minCapital: number;
  includeFunds: boolean;
  region?: string;
  /** Keyword/sector filter; modules apply it before enriching so `limit` counts matches. */
  keep: (ev: FundingEvent) => boolean;
}

export type Sector = 'tech' | 'health' | 'fintech' | 'energy' | 'consumer';

/**
 * Sector presets. `codes` are NACE-style prefixes (UK SIC 2007, French NAF and Norwegian
 * NACE share the first digits); `formD` are SEC industry groups; `words` match names and
 * activity/purpose text in English, French, German, Spanish, Italian and Norwegian.
 */
export const SECTORS: Record<Sector, { label: string; codes: string[]; formD: string[]; words: string[] }> = {
  tech: {
    label: 'Software, internet and IT',
    codes: ['582', '62', '631', '7211', '7219'],
    formD: ['Other Technology', 'Computers', 'Telecommunications'],
    words: ['software', 'saas', 'logiciel', 'informati', 'programvare', 'digital', 'platform', 'plattform', 'plateforme', 'plataforma', 'cloud', 'data', 'artificial intelligence', 'intelligence artificielle', 'künstliche intelligenz', 'intelligenza artificiale', 'machine learning', 'apps', 'internet', 'online', 'technolog', 'cyber', 'robot'],
  },
  health: {
    label: 'Health, biotech and medtech',
    codes: ['21', '266', '325', '7211', '86'],
    formD: ['Biotechnology', 'Pharmaceuticals', 'Other Health Care', 'Hospitals and Physicians', 'Health Insurance'],
    words: ['health', 'santé', 'gesundheit', 'salud', 'salute', 'helse', 'medic', 'médic', 'pharma', 'biotech', 'therap', 'clinic', 'klinik', 'diagnos', 'medtech'],
  },
  fintech: {
    label: 'Fintech and insurtech',
    codes: ['6419', '6499', '6612', '6619', '6622', '6629'],
    formD: ['Other Banking and Financial Services', 'Commercial Banking', 'Insurance'],
    words: ['fintech', 'payment', 'paiement', 'zahlung', 'pago', 'pagament', 'betaling', 'insur', 'assurance', 'versicher', 'seguro', 'lending', 'crédit', 'crypto', 'blockchain', 'banking'],
  },
  energy: {
    label: 'Energy and climate',
    codes: ['35', '3821', '7112'],
    formD: ['Coal Mining', 'Electric Utilities', 'Energy Conservation', 'Environmental Services', 'Oil and Gas', 'Other Energy'],
    words: ['energy', 'énergie', 'energie', 'energía', 'energia', 'solar', 'solaire', 'wind', 'battery', 'batterie', 'hydrogen', 'hydrogène', 'wasserstoff', 'climate', 'climat', 'klima', 'carbon', 'carbone'],
  },
  consumer: {
    label: 'Consumer, e-commerce and retail',
    codes: ['4791', '47', '1089', '1107', '14', '15', '3299'],
    formD: ['Retailing', 'Restaurants', 'Other'],
    words: ['e-commerce', 'ecommerce', 'shop', 'retail', 'commerce en ligne', 'onlinehandel', 'brand', 'marque', 'food', 'beverage', 'fashion'],
  },
};

/** Legal/financial vehicles that file capital changes but aren't prospects. */
export const FUND_WORDS = /\b(midco|bidco|topco|holdco|prise de participations?|fund|fonds|fondo|holding|holdings|invest|investment|investments|capital partners|spv|feeder|lp|l\.p\.|reit|properties|property|real estate|immobili|immobiliare|eiendom|sci|participations|beteiligungen|gestion de patrimoine|family office|trust)\b/i;

export const day = (d: Date) => d.toISOString().slice(0, 10);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch text (XML/HTML) with the shared HTTP client; throws on non-2xx. */
export async function getText(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number; query?: Record<string, string | number | undefined> } = {}): Promise<string> {
  const res = await request(url, { headers: opts.headers, timeoutMs: opts.timeoutMs ?? 30_000, query: opts.query });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  return text;
}

/** Runs `fn` over items with at most `n` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** First XML element text (namespace-agnostic, CDATA-aware). */
export function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</(?:\\w+:)?${name}>`));
  return m ? decodeXml(m[1].trim()) : '';
}
export function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g'))].map((m) => m[1]);
}
export function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

/** "JEAN-PIERRE" → "Jean-Pierre"; keeps already mixed-case names. */
export function nameCase(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
}

export function person(first: string, last: string, title?: string): Person {
  const firstName = nameCase(first);
  const lastName = nameCase(last);
  return { name: `${firstName} ${lastName}`.trim(), firstName, lastName, title };
}

/** "Doe, Jane" / "DOE Jane" (surname first) → Person. */
export function surnameFirst(s: string, title?: string): Person {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.includes(',')) { const [last, first] = t.split(',', 2); return person(first, last, title); }
  // French/Spanish registries write the SURNAME(S) in capitals, then given names.
  const words = t.split(' ');
  const caps = words.filter((w) => w === w.toUpperCase() && /\p{L}/u.test(w));
  if (caps.length && caps.length < words.length) return person(words.filter((w) => !caps.includes(w)).join(' '), caps.join(' '), title);
  return person(words.slice(1).join(' '), words[0] ?? '', title);
}

export const money = (n: number | undefined, cur = 'USD') => {
  if (n == null || !Number.isFinite(n)) return '';
  const sym: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', CHF: 'CHF ', NOK: 'NOK ' };
  const s = n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 100 ? Math.round(n).toLocaleString('en-US') : String(+n.toFixed(2));
  return `${sym[cur] ?? `${cur} `}${s.replace(/\.0([MB])/, '$1')}`;
};

/** Share of the company issued as new shares, from capital before/after (nominal). */
export function dilution(before?: number, after?: number): number | undefined {
  if (!before || !after || after <= before) return undefined;
  return (after - before) / after;
}

/** Keyword / sector / industry-code filter shared by all countries. */
export function matches(ev: FundingEvent, p: FundingParams): boolean {
  const hay = ` ${[ev.company, ev.industry, ev.text].filter(Boolean).join(' ')} `.toLowerCase();
  // Words match at the start of a word ("informati" → "informatique"), never inside one ("tech" ≠ "biotech").
  const has = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(hay);
  const code = (ev.industryCode ?? '').replace(/[.\s]/g, '');
  if (p.industryCodes.length && !(code && p.industryCodes.some((c) => code.startsWith(c.replace(/[.\s]/g, ''))))) return false;
  if (p.keywords.length && !p.keywords.some((k) => has(k.toLowerCase()))) return false;
  if (p.sector) {
    const s = SECTORS[p.sector];
    const byCode = !!code && s.codes.some((c) => code.startsWith(c));
    const byFormD = ev.country === 'us' && !!ev.industry && s.formD.includes(ev.industry);
    // An official industry code beats words: French/Norwegian activity texts list everything.
    const byWord = !code && s.words.some(has);
    if (!(byCode || byFormD || byWord)) return false;
  }
  return true;
}

/** One table row per company; the first named person fills Full name / Title so email finders can run. */
export function toRow(ev: FundingEvent): Record<string, unknown> {
  const lead = ev.people[0];
  const pct = dilution(ev.capitalBefore, ev.capitalAfter);
  return {
    Company: ev.company,
    'Company domain': ownDomain(ev.website ?? ''),
    Country: COUNTRIES[ev.country],
    City: ev.city ?? '',
    'Funding date': ev.date,
    'Amount raised': ev.amountRaised != null ? money(ev.amountRaised, ev.currency) : '',
    'New shares issued': pct != null ? `${(pct * 100).toFixed(pct < 0.01 ? 2 : 1)}%` : '',
    Signal: ev.signal,
    Industry: ev.industry ?? '',
    'Full name': lead?.name ?? '',
    'First name': lead?.firstName ?? '',
    'Last name': lead?.lastName ?? '',
    Title: lead?.title ?? '',
    People: ev.people.slice(0, 6).map((x) => (x.title ? `${x.name} (${x.title})` : x.name)).join('; '),
    'Company email': ev.email ?? '',
    'Company phone': ev.phone ?? '',
    'Filing URL': ev.filingUrl ?? '',
    'Registry ID': ev.registryId ?? '',
    Source: ev.source,
  };
}

/** Every country module has this signature. */
export type CountryFetcher = (p: FundingParams, ctx: Ctx & { db?: import('../../db/db.ts').Db }) => Promise<FundingEvent[]>;
