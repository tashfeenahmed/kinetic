/** Enrichment steps that need no paid API. */
import { promises as dns } from 'node:dns';
import { fetchPage, links, meta, pageContacts } from '../lib/html.ts';
import { toDomain } from '../lib/sandbox.ts';
import { webSearch } from './search.ts';
import { nameParts, type Ctx, type EnrichInput, type Hit } from './types.ts';

export async function mxProvider(domain: string): Promise<{ provider: string; mx: string[] } | null> {
  const records = await dns.resolveMx(domain).catch(() => []);
  if (!records.length) return null;
  const mx = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
  const joined = mx.join(' ');
  const provider = /google|googlemail/.test(joined) ? 'Google Workspace'
    : /outlook|protection\.outlook|microsoft/.test(joined) ? 'Microsoft 365'
    : /pphosted|proofpoint/.test(joined) ? 'Proofpoint'
    : /mimecast/.test(joined) ? 'Mimecast'
    : /zoho/.test(joined) ? 'Zoho'
    : /secureserver/.test(joined) ? 'GoDaddy'
    : /barracuda/.test(joined) ? 'Barracuda'
    : 'Other';
  return { provider, mx };
}

/**
 * Last-resort email: the most common corporate pattern (first.last@) on a domain
 * that accepts mail. Unverified — run a verification column before sending.
 */
export async function patternGuess(input: EnrichInput): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  const { first, last } = nameParts(input);
  if (!domain || !first) return null;
  const mx = await mxProvider(domain);
  if (!mx) return null;
  const f = slug(first), l = slug(last);
  const candidates = l ? [`${f}.${l}`, `${f}`, `${f}${l}`, `${f[0]}${l}`, `${f}_${l}`, `${f[0]}.${l}`] : [f];
  return { value: `${candidates[0]}@${domain}`, confidence: 'guess', data: { candidates: candidates.map((c) => `${c}@${domain}`), mailProvider: mx.provider } };
}

let domainLists: { at: number; disposable: Set<string>; freemail: Set<string> } | null = null;

/** Open lists: disposable-email-domains (CC0, ~10k) and Kikobeats/free-email-domains (MIT, ~33k). */
async function lists() {
  if (domainLists && Date.now() - domainLists.at < 86_400_000) return domainLists;
  try {
    const [disp, free] = await Promise.all([
      fetch('https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf', { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()),
      fetch('https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json', { signal: AbortSignal.timeout(20_000) }).then((r) => r.json() as Promise<string[]>),
    ]);
    const disposable = new Set([...DISPOSABLE, ...disp.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'))]);
    // The free-mail list also contains disposable domains; keep them apart.
    const freemail = new Set([...FREEMAIL, ...free.map((d) => d.toLowerCase()).filter((d) => !disposable.has(d))]);
    domainLists = { at: Date.now(), disposable, freemail };
  } catch {
    domainLists = { at: Date.now() - 23 * 3_600_000, disposable: DISPOSABLE, freemail: FREEMAIL }; // retry in an hour
  }
  return domainLists;
}

/** Free sanity check: syntax, MX and known disposable/free-mail domains. */
export async function mxVerify(input: EnrichInput): Promise<Hit | null> {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { value: 'invalid', data: { reason: 'syntax' } };
  const domain = email.split('@')[1];
  const { disposable, freemail } = await lists();
  if (disposable.has(domain)) return { value: 'risky', data: { reason: 'disposable domain' } };
  const mx = await mxProvider(domain);
  if (!mx) return { value: 'invalid', data: { reason: 'domain has no MX records' } };
  // MX alone can't confirm a mailbox, so report unknown and let a verifier decide.
  return { value: freemail.has(domain) ? 'risky' : 'unknown', data: { reason: freemail.has(domain) ? 'free mail provider' : 'domain accepts mail; mailbox unconfirmed', mailProvider: mx.provider } };
}

/** Scrape the company homepage for name, description, socials and contact details. */
export async function websiteCompany(input: EnrichInput): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const page = await fetchPage(domain).catch(() => null);
  if (!page || page.status >= 400) return null;
  const all = links(page.html, page.url);
  const find = (re: RegExp) => all.find((l) => re.test(l));
  const emails = [...new Set((page.html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e) && !/sentry|example|wixpress|your/.test(e)).slice(0, 10);
  const phones = [...new Set(all.filter((l) => l.startsWith('tel:')).map((l) => decodeURIComponent(l.slice(4))))].slice(0, 5);
  const name = meta(page.html, 'og:site_name') || page.title.split(/[|\-–—:]/)[0].trim();
  return {
    value: name || domain,
    data: {
      name, domain, title: page.title,
      description: meta(page.html, 'description') || meta(page.html, 'og:description'),
      linkedin: find(/linkedin\.com\/company\//i), twitter: find(/(twitter|x)\.com\/(?!share|intent)[^/]+$/i),
      facebook: find(/facebook\.com\/(?!sharer)/i), instagram: find(/instagram\.com\//i), youtube: find(/youtube\.com\//i), github: find(/github\.com\/[^/]+\/?$/i),
      careersUrl: find(/\/(careers|jobs|join-us|work-with-us)\b/i) ?? find(/(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)/i),
      emails, phones,
    },
  };
}

/** `"First Last" "Company" site:linkedin.com/in` via web search. */
export async function searchLinkedin(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const { full } = nameParts(input);
  if (!full) return null;
  const company = input.companyName || toDomain(input.domain).split('.')[0];
  const { engine, results } = await webSearch(`"${full}" ${company ? `"${company}"` : ''} site:linkedin.com/in`, ctx, 5);
  const hit = results.find((r) => /linkedin\.com\/in\//i.test(r.url));
  if (!hit) return null;
  const url = hit.url.replace(/^https?:\/\/[a-z]{2,3}\.linkedin/i, 'https://www.linkedin').split('?')[0];
  return { value: url, confidence: 'search match', data: { title: hit.title, snippet: hit.snippet, engine } };
}

export async function searchCompanyLinkedin(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const name = input.companyName || toDomain(input.domain);
  if (!name) return null;
  const { engine, results } = await webSearch(`"${name}" site:linkedin.com/company`, ctx, 5);
  const hit = results.find((r) => /linkedin\.com\/company\//i.test(r.url));
  return hit ? { value: hit.url.split('?')[0], confidence: 'search match', data: { title: hit.title, engine } } : null;
}

const NOT_COMPANY_SITES = /(linkedin|facebook|twitter|x\.com|instagram|youtube|wikipedia|crunchbase|bloomberg|glassdoor|indeed|zoominfo|dnb\.com|yelp|pitchbook|craft\.co|owler|apollo\.io|rocketreach|tracxn|cbinsights|github|medium|reddit|google\.|bing\.|amazon\.|myhome\.ie|daft\.ie|goldenpages|yellowpages|yell\.com|propertypal|rightmove|zoopla|tripadvisor|trustpilot|cylex|hotfrog|foursquare|solocheck|vision-net|companieshouse|opencorporates|bizapedia|checkatrade|houzz|thumbtack|findglocal|infobel|irishjobs|cybo|brownbook|manta|cgf\.ie|allbiz)/i;

/** Company name → website domain via web search. */
export async function searchDomain(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.companyName) return null;
  const { engine, results } = await webSearch(`${input.companyName} ${input.context ?? ''} official website`.replace(/\s+/g, ' '), ctx, 8);
  const sites = results.filter((r) => !NOT_COMPANY_SITES.test(r.url));
  // Prefer a domain that carries a word of the name: the first result is often a directory.
  const hit = sites.find((r) => nameInDomain(input.companyName!, r.url)) ?? sites[0];
  return hit ? { value: toDomain(hit.url), confidence: nameInDomain(input.companyName, hit.url) ? 'search match' : 'search match (name not in domain)', weak: !nameInDomain(input.companyName, hit.url), data: { title: hit.title, url: hit.url, engine } } : null;
}

const GENERIC_WORDS = new Set(['the', 'and', 'company', 'group', 'limited', 'services', 'properties', 'property', 'estate', 'estates', 'agents', 'auctioneers', 'homes', 'real', 'associates', 'partners', 'advisors', 'solutions', 'international', 'holdings']);
function nameInDomain(name: string, url: string): boolean {
  const host = slug(toDomain(url).split('.').slice(0, -1).join(''));
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)).some((w) => host.includes(slug(w)));
}

/**
 * Company name → domain from directory listings (local businesses rarely rank for
 * "official website"): the listing's page data names the website or a work email.
 */
export async function listingDomain(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.companyName) return null;
  const { results } = await webSearch(`"${input.companyName}" ${input.context ?? ''}`.trim(), ctx, 8);
  const key = slug(input.companyName).slice(0, 12);
  const { freemail } = await lists();
  for (const r of results.filter((x) => slug(x.title).includes(key)).slice(0, 3)) {
    if (!NOT_COMPANY_SITES.test(r.url)) {
      if (nameInDomain(input.companyName, r.url)) return { value: toDomain(r.url), confidence: 'search match', data: { url: r.url } };
      continue;
    }
    const page = await fetchPage(r.url, 15_000).catch(() => null);
    if (!page || page.status >= 400) continue;
    const c = pageContacts(page.html);
    const site = c.websites.map(toDomain).find((d) => d && !NOT_COMPANY_SITES.test(d));
    const mail = c.emails.map((e) => e.split('@')[1]).find((d) => d && !freemail.has(d) && !NOT_COMPANY_SITES.test(d));
    if (site || mail) return { value: site || mail, confidence: site ? 'listing website' : 'listing email domain', data: { source_url: page.url, emails: c.emails } };
  }
  return null;
}

function slug(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com', 'zoho.com']);
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com']);

// ---------- Company phone (free) ----------
const PHONE_RE = /(?:\+|\(|\b)\d[\d ().\/-]{5,18}\d\b(?!\.\.\.)/g;
const phoneDigits = (p: string) => p.replace(/\D/g, '');
const plausiblePhone = (p: string) => { const n = phoneDigits(p).length; return n >= 7 && n <= 15 && !/^(19|20)\d\d$/.test(p.trim()); };

/** The company's own site: page data (JSON-LD, tel: links), then its contact page. */
export async function websitePhone(input: EnrichInput): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const home = await fetchPage(domain).catch(() => null);
  if (!home || home.status >= 400) return null;
  let found = pageContacts(home.html).phones.filter(plausiblePhone);
  let url = home.url;
  if (!found.length) {
    const contact = links(home.html, home.url).find((l) => toDomain(l) === toDomain(home.url) && /contact|get-in-touch|find-us|locations?\b/i.test(l));
    const page = contact ? await fetchPage(contact).catch(() => null) : null;
    if (page && page.status < 400) {
      found = pageContacts(page.html).phones.filter(plausiblePhone);
      url = page.url;
    }
  }
  return found.length ? { value: found[0], confidence: 'company website', data: { phones: found, source_url: url } } : null;
}

/**
 * Web search: business directories and listings that name the company. Reads each
 * matching result page's data (full numbers even where the page masks them), then
 * falls back to numbers quoted in the search snippets.
 */
export async function searchPhone(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.companyName) return null;
  const name = input.companyName.trim();
  const { engine, results } = await webSearch(`"${name}" phone ${input.context ?? ''}`.trim(), ctx, 8);
  const key = slug(name).slice(0, 12);
  const matching = results.filter((r) => slug(r.title).includes(key) || slug(r.snippet).includes(key));
  for (const r of matching.slice(0, 3)) {
    const page = await fetchPage(r.url, 15_000).catch(() => null);
    const phones = page && page.status < 400 ? pageContacts(page.html).phones.filter(plausiblePhone) : [];
    if (phones.length) return { value: phones[0], confidence: 'listing page data', data: { phones, source_url: page!.url, engine } };
  }
  const counts = new Map<string, number>();
  for (const r of matching) for (const m of r.snippet.match(PHONE_RE) ?? []) if (plausiblePhone(m)) counts.set(m.trim(), (counts.get(m.trim()) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? { value: best[0], confidence: 'search snippet', weak: true, data: { phones: [...counts.keys()].slice(0, 5), engine } } : null;
}
