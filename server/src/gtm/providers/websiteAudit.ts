/**
 * Website audit signal for SMB / local leads: one homepage fetch plus robots.txt, no keys.
 * Findings make concrete first lines — who built the site, whether customers can book
 * online, ad pixels running, a stale footer, basic SEO gaps, AI crawlers blocked.
 * The value is a plain-English line of the stable findings, so a re-run that sees new
 * ads, a new agency or a booking tool counts as a change (response time is kept out).
 */
import { decode, fetchPage, meta, type Page } from '../lib/html.ts';
import { request } from '../lib/http.ts';
import { toDomain } from '../lib/sandbox.ts';
import type { Ctx, Hit } from './types.ts';
import type { SignalInput } from './signals.ts';

export const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot'];

// "Website by X", "Designed & developed by X", "Powered by X" — website builders and hosts aren't agencies.
const CREDIT = /(?:web\s*site|site|web\s*design|designed(?:\s*(?:&amp;|&|and)\s*(?:built|developed))?|developed|built|created|crafted|made|powered|maintained|managed)(?:\s+with\s+[^<]{1,20}?)?\s+by\s*:?\s*((?:<(?!\/?a\b)[^>]*>\s*)*)(?:<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{1,120}?)<\/a>|([A-Za-z0-9][\w&.' -]{1,60}))/gi;
const PLATFORMS = /^(wordpress|shopify|wix|squarespace|godaddy|weebly|webflow|jimdo|duda|hubspot|google|cloudflare|framer|joomla|drupal|ghost|bigcommerce|woocommerce|strikingly|site123|yola|hostinger|ionos|1&1|blogger|carrd|elementor|divi|astra|genesis|our\s|us\b|you\b|hand\b)/i;

const LOCAL_BUSINESS = /["']@type["']\s*:\s*\[?\s*["'](?:LocalBusiness|Restaurant|FoodEstablishment|CafeOrCoffeeShop|Bakery|BarOrPub|Dentist|MedicalBusiness|MedicalClinic|Physician|Optician|Pharmacy|HealthAndBeautyBusiness|BeautySalon|HairSalon|NailSalon|DaySpa|TattooParlor|ExerciseGym|SportsActivityLocation|AutoRepair|AutomotiveBusiness|AutoDealer|LegalService|Attorney|Notary|AccountingService|FinancialService|InsuranceAgency|RealEstateAgent|HomeAndConstructionBusiness|Plumber|Electrician|HVACBusiness|RoofingContractor|GeneralContractor|HousePainter|Locksmith|MovingCompany|ProfessionalService|ChildCare|VeterinaryCare|TravelAgency|LodgingBusiness|Hotel|BedAndBreakfast|Store|ClothingStore|Florist|EmploymentAgency|DryCleaningOrLaundry|EntertainmentBusiness)["']|itemtype=["']https?:\/\/schema\.org\/LocalBusiness/i;

const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The site's agency / designer credit, if the page has one. */
export function agencyCredit(html: string, base: string): { name: string; url?: string } | null {
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const own = host(base);
  // Credits live in the footer: look there (or in the last third of the page), last match first.
  const footer = html.match(/<footer\b[\s\S]*<\/footer>/i)?.[0] ?? html.slice(Math.floor(html.length * 0.66));
  const hits = [...footer.matchAll(CREDIT)].reverse();
  for (const m of hits) {
    const raw = m[3] != null ? stripTags(m[3]) : (m[4] ?? '').replace(/\s+(?:and|&|\||-|–|·).*$/i, '').trim();
    const name = raw.replace(/[.,;:|]+$/, '').slice(0, 60).trim();
    if (!name || name.length < 2 || PLATFORMS.test(name)) continue;
    let url: string | undefined;
    if (m[2]) { try { url = new URL(m[2], base).toString(); } catch { /* bad href */ } }
    if (url && (!/^https?:/.test(url) || host(url) === own)) url = undefined;
    return { name, url };
  }
  return null;
}

/** Latest year in a copyright notice (©, &copy;, "Copyright"), e.g. "© 2019–2021" → 2021. */
export function copyrightYear(html: string): number | null {
  const text = stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '));
  let best: number | null = null;
  for (const m of text.matchAll(/(?:©|&copy;|&#169;|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})\b/gi)) {
    const y = Number(m[1]);
    if (best == null || y > best) best = y;
  }
  return best;
}

/** AI crawlers that robots.txt keeps off the whole site (their own group, else the `*` group). */
export function blockedAiCrawlers(robots: string): string[] {
  const groups: { agents: string[]; rules: [string, string][] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') {
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(m[2].toLowerCase());
    } else if (cur && (field === 'disallow' || field === 'allow')) cur.rules.push([field, m[2]]);
  }
  const blocksAll = (g?: (typeof groups)[number]) => !!g && g.rules.some(([f, v]) => f === 'disallow' && v === '/') && !g.rules.some(([f, v]) => f === 'allow' && v === '/');
  const star = groups.find((g) => g.agents.includes('*'));
  return AI_CRAWLERS.filter((bot) => {
    const own = groups.find((g) => g.agents.includes(bot.toLowerCase()));
    return blocksAll(own ?? star);
  });
}

export interface AuditFindings {
  url: string;
  agency: { name: string; url?: string } | null;
  booking: string[];
  ads: string[];
  copyrightYear: number | null;
  staleCopyright: boolean;
  https: boolean;
  mobileViewport: boolean;
  metaDescription: boolean;
  localBusinessSchema: boolean;
  aiCrawlersBlocked: string[];
  responseMs: number;
  slow: boolean;
}

/** Findings from an already-fetched homepage (pure; used by the signal and tests). */
export function auditPage(page: Pick<Page, 'url' | 'html' | 'headers'>, robots: string, responseMs: number, fingerprints: [string, string, RegExp][], opts: { now?: Date; slowMs?: number } = {}): AuditFindings {
  const hay = `${page.html}\n${Object.entries(page.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  const tools = (cats: string[]) => fingerprints.filter(([, c, re]) => cats.includes(c) && re.test(hay)).map(([n]) => n);
  const year = copyrightYear(page.html);
  const thisYear = (opts.now ?? new Date()).getFullYear();
  return {
    url: page.url,
    agency: agencyCredit(page.html, page.url),
    booking: tools(['booking', 'scheduling']),
    ads: tools(['ads']),
    copyrightYear: year,
    staleCopyright: year != null && year <= thisYear - 2,
    https: page.url.startsWith('https:'),
    mobileViewport: /<meta[^>]+name=["']viewport["']/i.test(page.html),
    metaDescription: !!meta(page.html, 'description').trim(),
    localBusinessSchema: LOCAL_BUSINESS.test(page.html),
    aiCrawlersBlocked: blockedAiCrawlers(robots),
    responseMs,
    slow: responseMs > (opts.slowMs ?? 3000),
  };
}

/** The stable findings as one plain-English line (the cell value). */
export function auditSummary(f: AuditFindings): string {
  const parts: string[] = [];
  if (f.agency) parts.push(`Site by ${f.agency.name}${f.agency.url ? ` (${toDomain(f.agency.url)})` : ''}`);
  parts.push(f.booking.length ? `online booking via ${f.booking.join(', ')}` : 'no online booking');
  parts.push(f.ads.length ? `running ads (${f.ads.join(', ')})` : 'no ad pixels');
  if (f.staleCopyright) parts.push(`footer still says © ${f.copyrightYear}`);
  const gaps = [!f.https && 'HTTPS', !f.mobileViewport && 'mobile viewport', !f.metaDescription && 'meta description', !f.localBusinessSchema && 'LocalBusiness schema'].filter(Boolean);
  if (gaps.length) parts.push(`no ${gaps.join(', no ')}`);
  if (f.aiCrawlersBlocked.length) parts.push(`blocks AI crawlers (${f.aiCrawlersBlocked.join(', ')})`);
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What moved since the last run: ads started/stopped, agency changed, booking added/removed. */
function auditChanges(prev: Partial<AuditFindings> | undefined, f: AuditFindings): string[] {
  if (!prev || !Array.isArray(prev.ads)) return [];
  const out: string[] = [];
  const diff = (a: string[] = [], b: string[] = []) => b.filter((x) => !a.includes(x));
  for (const x of diff(prev.ads, f.ads)) out.push(`started ${x} ads`);
  for (const x of diff(f.ads, prev.ads)) out.push(`stopped ${x} ads`);
  for (const x of diff(prev.booking, f.booking)) out.push(`added booking (${x})`);
  for (const x of diff(f.booking, prev.booking)) out.push(`removed booking (${x})`);
  const was = prev.agency?.name ?? null, now = f.agency?.name ?? null;
  if (was !== now) out.push(now ? (was ? `changed agency: ${was} → ${now}` : `agency credit added: ${now}`) : `agency credit removed (was ${was})`);
  if (prev.https === false && f.https) out.push('moved to HTTPS');
  return out;
}

export async function websiteAudit(input: SignalInput, ctx: Ctx, fingerprints: [string, string, RegExp][], opts: { now?: Date; slowMs?: number } = {}): Promise<Hit | null> {
  const domain = toDomain(input.target || input.domain);
  if (!domain) return null;
  const target = input.target?.includes('://') ? input.target : `https://${domain}`;
  let page: Page | null = null;
  const started = Date.now();
  try { page = await fetchPage(target, 15_000); } catch { /* try plain http below */ }
  if (!page || page.status >= 400) {
    // No working HTTPS: plain HTTP still tells us what's there (and that HTTPS is missing).
    try { page = await fetchPage(`http://${domain}`, 15_000); } catch { /* unreachable */ }
  }
  const responseMs = Date.now() - started;
  if (!page || page.status >= 400) return { value: null, data: { note: `${domain} did not load${page ? ` (HTTP ${page.status})` : ''}` } };
  let robots = '';
  try {
    const res = await request(new URL('/robots.txt', page.url).toString(), { timeoutMs: 8000 });
    const text = res.ok ? await res.text() : '';
    if (!/<html/i.test(text)) robots = text.slice(0, 100_000);
  } catch { /* no robots.txt */ }
  const f = auditPage(page, robots, responseMs, fingerprints, opts);
  const value = auditSummary(f);
  const changes = auditChanges((ctx.prev as any)?.data, f);
  ctx.log(`audit ${domain}: ${value}`);
  return { value, data: { ...f, summary: f.slow ? `${value}; slow to load (${(responseMs / 1000).toFixed(1)}s)` : value, changes } };
}
