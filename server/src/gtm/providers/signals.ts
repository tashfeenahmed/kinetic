/**
 * Signal columns: free public sources, re-run on a schedule. A cell's value is
 * the headline number/flag; when it changes the engine records `changed_at`
 * and re-runs any auto-run columns (e.g. a Slack alert) that reference it.
 */
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { getJson, HttpError, request } from '../lib/http.ts';
import { fetchPage, links, parseFeed } from '../lib/html.ts';
import { toDomain } from '../lib/sandbox.ts';
import { join } from 'node:path';
import { detect, loadFingerprints } from '../lib/wappalyzer.ts';
import { mxProvider } from './free.ts';
import { apolloPerson, pdlPerson } from './vendors.ts';
import type { Ctx, Hit } from './types.ts';
import { websiteVisits } from '../../visitors/signal.ts';

export interface SignalInput {
  domain?: string;
  companyName?: string;
  /** jobs: ATS board slug override; github: org; website_change: URL */
  target?: string;
  /** jobs/news: keyword filter (comma-separated, any match) */
  keywords?: string;
  /** news/sec/crt: look-back window in days */
  days?: number;
  /** job_change / outreach_status: person identifiers + the company we last knew */
  email?: string;
  linkedinUrl?: string;
  fullName?: string;
}

export interface SignalKind {
  id: string;
  label: string;
  description: string;
  inputs: (keyof SignalInput)[];
  requires: string[];
  run: (input: SignalInput, ctx: Ctx) => Promise<Hit | null>;
}

// ---------- Hiring: public ATS job boards ----------
interface Job { title: string; location?: string; department?: string; url?: string; posted?: string }

const ATS: { id: string; boardRe: RegExp; fetch: (slug: string) => Promise<Job[] | null> }[] = [
  {
    id: 'greenhouse',
    boardRe: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
    fetch: async (slug) => {
      const d = await json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      return d?.jobs?.map((j: any) => ({ title: j.title, location: j.location?.name, department: j.departments?.[0]?.name, url: j.absolute_url, posted: j.first_published ?? j.updated_at })) ?? null;
    },
  },
  {
    id: 'lever',
    boardRe: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i,
    fetch: async (slug) => {
      const d = await json(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      return Array.isArray(d) ? d.map((j: any) => ({ title: j.text, location: j.categories?.location, department: j.categories?.team ?? j.categories?.department, url: j.hostedUrl, posted: j.createdAt ? new Date(j.createdAt).toISOString() : undefined })) : null;
    },
  },
  {
    id: 'ashby',
    boardRe: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i,
    fetch: async (slug) => {
      const d = await json(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      return d?.jobs?.map((j: any) => ({ title: j.title, location: j.location, department: j.department ?? j.team, url: j.jobUrl, posted: j.publishedAt })) ?? null;
    },
  },
  {
    id: 'workable',
    boardRe: /apply\.workable\.com\/([a-z0-9_-]+)/i,
    fetch: async (slug) => {
      const d = await json(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
      return d?.jobs?.map((j: any) => ({ title: j.title, location: [j.city, j.country].filter(Boolean).join(', '), department: j.department, url: j.url ?? j.shortlink, posted: j.published_on ?? j.created_at })) ?? null;
    },
  },
  {
    id: 'smartrecruiters',
    boardRe: /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i,
    fetch: async (slug) => {
      const d = await json(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
      return d?.content?.length ? d.content.map((j: any) => ({ title: j.name, location: j.location?.city, department: j.department?.label, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, posted: j.releasedDate })) : null;
    },
  },
  {
    id: 'recruitee',
    boardRe: /([a-z0-9-]+)\.recruitee\.com/i,
    fetch: async (slug) => {
      const d = await json(`https://${slug}.recruitee.com/api/offers/`);
      return d?.offers?.map((j: any) => ({ title: j.title, location: j.location ?? j.city, department: j.department, url: j.careers_url, posted: j.published_at ?? j.created_at })) ?? null;
    },
  },
  {
    id: 'personio',
    boardRe: /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i,
    fetch: async (slug) => {
      const res = await request(`https://${slug}.jobs.personio.de/xml`, { timeoutMs: 15_000 });
      if (!res.ok) return null;
      const xml = await res.text();
      const positions = xml.match(/<position>[\s\S]*?<\/position>/g);
      if (!positions) return null;
      const tag = (x: string, t: string) => x.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`))?.[1]?.trim();
      return positions.map((x) => ({ title: tag(x, 'name') ?? '', location: tag(x, 'office'), department: tag(x, 'department'), url: `https://${slug}.jobs.personio.de/job/${tag(x, 'id')}`, posted: tag(x, 'createdAt') }));
    },
  },
];

async function json(url: string): Promise<any> {
  try {
    return await getJson(url, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return null;
    throw e;
  }
}

async function hiring(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  let found: { ats: string; slug: string; jobs: Job[] } | null = null;

  // 1. Explicit board URL/slug, 2. links on the careers page, 3. guess slugs from domain/name.
  const explicit = input.target?.trim();
  if (explicit) {
    for (const a of ATS) {
      const slug = explicit.match(a.boardRe)?.[1];
      if (slug) { const jobs = await a.fetch(slug); if (jobs) found = { ats: a.id, slug, jobs }; break; }
    }
  }
  if (!found && domain) {
    for (const path of ['', '/careers', '/jobs']) {
      const page = await fetchPage(`https://${domain}${path}`, 12_000).catch(() => null);
      if (!page) continue;
      const hay = [page.html, ...links(page.html, page.url)].join(' ');
      for (const a of ATS) {
        const slug = hay.match(a.boardRe)?.[1];
        if (slug && !/^(embed|api|v1)$/i.test(slug)) {
          const jobs = await a.fetch(slug);
          if (jobs) { found = { ats: a.id, slug, jobs }; break; }
        }
      }
      if (found) break;
    }
  }
  if (!found) {
    const guesses = new Set<string>([explicit, domain.split('.')[0], input.companyName?.toLowerCase().replace(/[^a-z0-9]/g, ''), input.companyName?.toLowerCase().trim().replace(/\s+/g, '-')].filter(Boolean) as string[]);
    outer: for (const slug of guesses) {
      for (const a of ATS) {
        const jobs = await a.fetch(slug).catch(() => null);
        if (jobs && jobs.length) { found = { ats: a.id, slug, jobs }; break outer; }
      }
    }
  }
  if (!found) return { value: null, data: { note: 'No public Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee/Personio board found — paste the board URL into Target' } };

  const kw = splitKeywords(input.keywords);
  const matching = kw.length ? found.jobs.filter((j) => kw.some((k) => `${j.title} ${j.department ?? ''}`.toLowerCase().includes(k))) : found.jobs;
  const departments: Record<string, number> = {};
  for (const j of found.jobs) departments[j.department || 'Other'] = (departments[j.department || 'Other'] ?? 0) + 1;
  ctx.log(`${found.ats}/${found.slug}: ${found.jobs.length} jobs, ${matching.length} matching`);
  return {
    value: matching.length,
    data: { ats: found.ats, board: found.slug, total: found.jobs.length, matching: matching.length, departments, jobs: matching.slice(0, 500) },
  };
}

// ---------- News: Google News RSS ----------
async function news(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const name = input.companyName || input.domain;
  if (!name) return null;
  const days = input.days ?? 30;
  const kw = splitKeywords(input.keywords);
  const q = `"${name}"${kw.length ? ` (${kw.map((k) => `"${k}"`).join(' OR ')})` : ''} when:${days}d`;
  const res = await request('https://news.google.com/rss/search', { query: { q, hl: 'en-US', gl: 'US', ceid: 'US:en' } });
  if (!res.ok) throw new Error(`Google News ${res.status}`);
  const items = parseFeed(await res.text()).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  ctx.log(`news "${q}": ${items.length}`);
  // Headline (not count) as the value: a rolling count changes daily, a new top story is a real change.
  return { value: items[0]?.title ?? null, data: { query: q, count: items.length, latestDate: items[0]?.date ?? null, url: items[0]?.link, items: items.slice(0, 15) } };
}

// ---------- Funding: SEC Form D filings (US private raises) ----------
async function secFormD(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const name = input.companyName;
  if (!name) return null;
  const ua = ctx.settings.get('SEC_USER_AGENT') || 'kineticsand personal research admin@example.com';
  const days = input.days ?? 365;
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const d = await getJson('https://efts.sec.gov/LATEST/search-index', {
    headers: { 'user-agent': ua, accept: 'application/json' },
    query: { q: `"${name}"`, forms: 'D,D/A', dateRange: 'custom', startdt: start, enddt: new Date().toISOString().slice(0, 10) },
  });
  const hits = (d?.hits?.hits ?? []).map((h: any) => ({
    company: h._source?.display_names?.[0], form: h._source?.form ?? h._source?.root_forms?.[0], filed: h._source?.file_date,
    url: h._source?.ciks?.[0] && h._id ? `https://www.sec.gov/Archives/edgar/data/${Number(h._source.ciks[0])}/${String(h._id).split(':')[0].replace(/-/g, '')}/${String(h._id).split(':')[1] ?? ''}` : undefined,
  }));
  hits.sort((a: any, b: any) => String(b.filed).localeCompare(String(a.filed)));
  return { value: hits[0]?.filed ?? null, data: { filings: hits.slice(0, 10), note: 'Form D = exempt US securities offering (most VC rounds). Matches are by name; check the filer.' } };
}

// ---------- Technographics: HTML/header/DNS fingerprints ----------
const FINGERPRINTS: [string, string, RegExp][] = [
  // [name, category, pattern over html+headers]
  ['Google Analytics', 'analytics', /googletagmanager\.com\/gtag|google-analytics\.com\/(analytics|ga)\.js/i],
  ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js/i],
  ['Segment', 'analytics', /cdn\.segment\.com|analytics\.js\/v1/i],
  ['Mixpanel', 'analytics', /cdn\.mxpnl\.com|mixpanel/i],
  ['Amplitude', 'analytics', /cdn\.amplitude\.com|amplitude\.com\/libs/i],
  ['Heap', 'analytics', /heap-\d+\.js|cdn\.heapanalytics\.com/i],
  ['PostHog', 'analytics', /posthog/i],
  ['Hotjar', 'analytics', /static\.hotjar\.com/i],
  ['FullStory', 'analytics', /fullstory\.com\/s\/fs\.js|edge\.fullstory\.com/i],
  ['HubSpot', 'marketing automation', /js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics/i],
  ['Marketo', 'marketing automation', /munchkin\.marketo\.net|mktoForms/i],
  ['Pardot', 'marketing automation', /pi\.pardot\.com|pardot/i],
  ['Salesforce', 'crm', /force\.com|salesforce\.com\/embeddedservice/i],
  ['Intercom', 'chat', /widget\.intercom\.io|intercomcdn/i],
  ['Drift', 'chat', /js\.driftt\.com/i],
  ['Zendesk', 'support', /static\.zdassets\.com|zendesk/i],
  ['Crisp', 'chat', /client\.crisp\.chat/i],
  ['Qualified', 'chat', /js\.qualified\.com/i],
  ['6sense', 'intent', /j\.6sc\.co|6sense/i],
  ['Demandbase', 'intent', /tag\.demandbase\.com/i],
  ['Clearbit Reveal', 'intent', /tag\.clearbitscripts\.com/i],
  ['RB2B', 'intent', /rb2b/i],
  ['LinkedIn Insight', 'ads', /snap\.licdn\.com/i],
  ['Meta Pixel', 'ads', /connect\.facebook\.net\/.*fbevents/i],
  ['Google Ads', 'ads', /googleadservices\.com|gtag\('config', 'AW-/i],
  ['Stripe', 'payments', /js\.stripe\.com/i],
  ['Paddle', 'payments', /cdn\.paddle\.com/i],
  ['Chargebee', 'payments', /js\.chargebee\.com/i],
  ['Optimizely', 'experimentation', /cdn\.optimizely\.com/i],
  ['LaunchDarkly', 'experimentation', /launchdarkly/i],
  ['Webflow', 'cms', /webflow\.(com|js)|data-wf-site/i],
  ['WordPress', 'cms', /wp-content|wp-includes/i],
  ['Framer', 'cms', /framerusercontent\.com|framer\.com\/m\//i],
  ['Contentful', 'cms', /ctfassets\.net/i],
  ['Sanity', 'cms', /cdn\.sanity\.io/i],
  ['Shopify', 'ecommerce', /cdn\.shopify\.com|myshopify\.com/i],
  ['Wix', 'cms', /wixstatic\.com|wix\.com/i],
  ['Squarespace', 'cms', /squarespace\.com|static1\.squarespace/i],
  ['Next.js', 'framework', /__NEXT_DATA__|\/_next\/static/i],
  ['Nuxt', 'framework', /__NUXT__|\/_nuxt\//i],
  ['Gatsby', 'framework', /___gatsby/i],
  ['React', 'framework', /react-dom|data-reactroot/i],
  ['Vercel', 'hosting', /x-vercel-id|server: vercel/i],
  ['Netlify', 'hosting', /x-nf-request-id|server: netlify/i],
  ['Cloudflare', 'cdn', /cf-ray|server: cloudflare/i],
  ['AWS CloudFront', 'cdn', /x-amz-cf-id|cloudfront/i],
  ['Fastly', 'cdn', /x-served-by: cache-|fastly/i],
  ['Akamai', 'cdn', /akamai/i],
  ['Cookiebot', 'consent', /consent\.cookiebot\.com/i],
  ['OneTrust', 'consent', /cdn\.cookielaw\.org|onetrust/i],
  ['Sentry', 'monitoring', /browser\.sentry-cdn\.com|sentry\.io/i],
  ['Datadog RUM', 'monitoring', /datadoghq-browser-agent|dd_rum/i],
  ['Calendly', 'scheduling', /assets\.calendly\.com/i],
  ['Chili Piper', 'scheduling', /chilipiper/i],
  ['Gong', 'sales', /gong\.io/i],
  ['Greenhouse', 'ats', /greenhouse\.io/i],
  ['Lever', 'ats', /lever\.co/i],
  ['Ashby', 'ats', /ashbyhq\.com/i],
];

const TXT_FINGERPRINTS: [string, RegExp][] = [
  ['Google Workspace', /google-site-verification/i], ['Microsoft 365', /^MS=ms/i], ['Atlassian', /atlassian-domain-verification/i],
  ['Stripe', /stripe-verification/i], ['DocuSign', /docusign/i], ['Zoom', /ZOOM_verify/i], ['Slack', /slack-domain-verification/i],
  ['Apple', /apple-domain-verification/i], ['Facebook Business', /facebook-domain-verification/i], ['HubSpot', /hubspot/i],
  ['Salesforce', /salesforce|pardot/i], ['Adobe', /adobe-idp-site-verification|adobe-sign-verification/i], ['Miro', /miro-verification/i],
  ['Notion', /notion/i], ['Figma', /figma/i], ['OpenAI', /openai-domain-verification/i], ['Anthropic', /anthropic-domain-verification/i],
  ['Dropbox', /dropbox-domain-verification/i], ['Zendesk', /zendesk/i], ['Mailchimp/Mandrill', /mandrill|mailchimp/i],
  ['SendGrid', /sendgrid/i], ['Amazon SES', /amazonses/i], ['Mailgun', /mailgun/i], ['Postmark', /pm-bounces|postmark/i], ['Klaviyo', /klaviyo/i],
  ['Okta', /okta/i], ['1Password', /1password/i], ['Webex', /webexdomainverification/i], ['Asana', /asana/i], ['Canva', /canva-site-verification/i],
];

async function techStack(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const [page, txt, mx, ns, cname] = await Promise.all([
    fetchPage(domain, 15_000).catch(() => null),
    dns.resolveTxt(domain).then((r) => r.map((x) => x.join(''))).catch(() => [] as string[]),
    mxProvider(domain),
    dns.resolveNs(domain).catch(() => [] as string[]),
    dns.resolveCname(`www.${domain}`).catch(() => [] as string[]),
  ]);
  const found = new Map<string, string>();
  let engine = 'built-in';
  // Open-source Wappalyzer fingerprints (thousands of technologies), with the built-in list as backup.
  try {
    const fp = await loadFingerprints(ctx.dataDir ?? join(process.cwd(), 'data'));
    for (const d of detect(fp, { url: page?.url ?? `https://${domain}`, html: page?.html ?? '', headers: page?.headers ?? {}, dns: { TXT: txt, MX: mx?.mx ?? [], NS: ns, CNAME: cname } })) {
      found.set(d.version ? `${d.name} ${d.version}` : d.name, d.categories[0] ?? 'other');
    }
    engine = 'wappalyzer (enthec/webappanalyzer)';
  } catch (e: any) {
    ctx.log(`fingerprint download failed (${e.message}); using built-in list`);
  }
  const hay = page ? `${page.html}\n${Object.entries(page.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}` : '';
  const has = (n: string) => [...found.keys()].some((k) => k.toLowerCase().startsWith(n.toLowerCase()));
  for (const [name, cat, re] of FINGERPRINTS) if (!has(name) && re.test(hay)) found.set(name, cat);
  for (const [name, re] of TXT_FINGERPRINTS) if (!has(name) && txt.some((t) => re.test(t))) found.set(name, 'dns-verified saas');
  if (mx && !has(mx.provider)) found.set(mx.provider === 'Other' ? `Mail: ${mx.mx[0]}` : mx.provider, 'email');
  const spf = txt.find((t) => t.startsWith('v=spf1'));
  const tech = [...found.keys()].sort((a, b) => a.localeCompare(b));
  const byCategory: Record<string, string[]> = {};
  for (const [n, c] of found) (byCategory[c] ??= []).push(n);
  return { value: tech, data: { count: tech.length, byCategory, spf, engine, reachable: !!page } };
}

// ---------- Website change ----------
async function websiteChange(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const url = input.target || (input.domain ? `https://${toDomain(input.domain)}` : '');
  if (!url) return null;
  const page = await fetchPage(url);
  const text = page.text.replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const prev = (ctx.prev as any)?.data;
  let added: string[] = [];
  if (prev?.text && prev.hash !== hash) {
    const before = new Set(String(prev.text).split(/(?<=[.!?])\s+/));
    added = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20 && !before.has(s)).slice(0, 20);
  }
  return { value: hash, data: { url: page.url, status: page.status, title: page.title, hash, changed: !!prev?.hash && prev.hash !== hash, added, text: text.slice(0, 20_000) } };
}

// ---------- GitHub activity ----------
async function github(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const org = input.target || toDomain(input.domain).split('.')[0];
  if (!org) return null;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (ctx.settings.has('GITHUB_TOKEN')) headers.authorization = `Bearer ${ctx.settings.get('GITHUB_TOKEN')}`;
  const info = await getJson(`https://api.github.com/users/${org}`, { headers }).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; });
  if (!info) return { value: null, data: { note: `No GitHub account "${org}"` } };
  const repos = await getJson(`https://api.github.com/users/${org}/repos`, { headers, query: { sort: 'pushed', per_page: 10 } });
  const recent = repos.map((r: any) => ({ name: r.name, stars: r.stargazers_count, pushed: r.pushed_at, language: r.language, url: r.html_url, description: r.description }));
  return { value: recent[0]?.pushed ?? null, data: { org: info.login, publicRepos: info.public_repos, followers: info.followers, recent } };
}

// ---------- New subdomains: certificate transparency ----------
async function newSubdomains(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const days = input.days ?? 30;
  const since = Date.now() - days * 86_400_000;
  // Names seen so far and the Cert Spotter cursor carry over from the previous run,
  // so each refresh only fetches certificates issued since the last check.
  const prev = (ctx.prev as any)?.data;
  const seen: Record<string, string> = prev?.domain === domain ? { ...(prev.seen ?? {}) } : {};
  let cursor: string | undefined = prev?.domain === domain ? prev.cursor : undefined;
  const add = (n: string, at: string) => { n = n.toLowerCase(); if (!n.startsWith('*') && n.endsWith(domain) && n !== domain && !(n in seen)) seen[n] = at; };
  let source = 'certspotter';
  let complete = true;
  try {
    const headers: Record<string, string> = {};
    if (ctx.settings.has('CERTSPOTTER_API_KEY')) headers.authorization = `Bearer ${ctx.settings.get('CERTSPOTTER_API_KEY')}`;
    for (let page = 0; ; page++) {
      if (page >= 8) { complete = false; break; } // free tier is ~10 requests/hour; resume next run
      const rows = await getJson<any[]>('https://api.certspotter.com/v1/issuances', { headers, query: { domain, include_subdomains: 'true', expand: 'dns_names', after: cursor } });
      if (!rows?.length) break;
      for (const r of rows) for (const n of r.dns_names ?? []) add(n, r.not_before);
      cursor = rows[rows.length - 1].id;
    }
  } catch (e: any) {
    if (Object.keys(seen).length || !(e instanceof HttpError && e.status === 429)) {
      if (!Object.keys(seen).length) throw e;
      complete = false;
    } else {
      source = 'crt.sh';
      ctx.log('Cert Spotter rate-limited, trying crt.sh');
      const rows = await getJson<any[]>('https://crt.sh/', { query: { q: `%.${domain}`, output: 'json', exclude: 'expired', deduplicate: 'Y' }, timeoutMs: 30_000 });
      for (const r of rows ?? []) for (const n of String(r.name_value).split('\n')) add(n, r.not_before ?? r.entry_timestamp);
    }
  }
  const recent = Object.entries(seen).filter(([, at]) => Date.parse(at) >= since).map(([n]) => n).sort();
  ctx.log(`${source} ${domain}: ${Object.keys(seen).length} names known, ${recent.length} issued in ${days}d${complete ? '' : ' (backfill continues next run)'}`);
  // On the very first (backfilling) run, everything looks "new"; changes after that are real.
  return { value: recent.length ? recent : null, data: { domain, count: recent.length, source, complete, subdomains: recent.slice(0, 100), cursor, seen } };
}

// ---------- Hacker News mentions (Algolia, free) ----------
async function hackerNews(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const q = input.companyName || toDomain(input.domain);
  if (!q) return null;
  const days = input.days ?? 30;
  const since = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const d = await getJson('https://hn.algolia.com/api/v1/search_by_date', { query: { query: `"${q}"`, tags: 'story', numericFilters: `created_at_i>${since}`, hitsPerPage: 30 } });
  const hits = (d.hits ?? []).map((h: any) => ({ title: h.title, url: h.url, points: h.points, comments: h.num_comments, date: h.created_at, hn: `https://news.ycombinator.com/item?id=${h.objectID}` }));
  ctx.log(`HN "${q}": ${hits.length}`);
  return { value: hits[0]?.title ?? null, data: { count: hits.length, top: [...hits].sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 5), stories: hits.slice(0, 15) } };
}

// ---------- GDELT global news (free, 1 request / 5 s) ----------
let gdeltChain: Promise<unknown> = Promise.resolve();
async function gdelt(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const name = input.companyName;
  if (!name) return null;
  const kw = splitKeywords(input.keywords);
  // GDELT rejects quoted phrases shorter than ~5 characters.
  if (name.replace(/\W/g, '').length < 3) throw new Error('GDELT needs a company name of at least 3 letters');
  const base = name.length >= 5 ? `"${name}"` : `${name} ${kw.length ? '' : '(company OR startup OR funding OR CEO)'}`.trim();
  const query = kw.length ? `${base} (${kw.join(' OR ')})` : base;
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        const res = await request('https://api.gdeltproject.org/api/v2/doc/doc', { query: { query, mode: 'artlist', format: 'json', timespan: `${input.days ?? 30}d`, maxrecords: 50, sort: 'datedesc' }, timeoutMs: 30_000 });
        text = await res.text();
      } catch (e) {
        if (attempt < 3) { await sleep(12_000 * (attempt + 1)); continue; } // GDELT drops connections under load
        throw e;
      }
      if (text.startsWith('{')) return JSON.parse(text);
      // GDELT's limiter is stricter than its documented 5 s; back off and retry.
      if (/limit requests/i.test(text) && attempt < 3) { await sleep(12_000 * (attempt + 1)); continue; }
      throw new Error(`GDELT: ${text.slice(0, 120)}`);
    }
  };
  const next = gdeltChain.then(run, run);
  gdeltChain = next.then(() => sleep(5500), () => sleep(5500));
  const d: any = await next;
  const articles = (d.articles ?? []).map((a: any) => ({ title: a.title, url: a.url, source: a.domain, language: a.language, country: a.sourcecountry, date: a.seendate }));
  ctx.log(`GDELT "${query}": ${articles.length}`);
  return { value: articles[0]?.title ?? null, data: { query, count: articles.length, languages: [...new Set(articles.map((a: any) => a.language))], articles: articles.slice(0, 20) } };
}

// ---------- SEC filings for public companies (8-K etc.) ----------
const EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'Material agreement', '1.02': 'Agreement terminated', '1.03': 'Bankruptcy', '2.01': 'Acquisition/disposition completed', '2.02': 'Earnings',
  '2.03': 'New debt', '2.05': 'Restructuring / layoffs', '2.06': 'Impairment', '3.01': 'Delisting notice', '4.01': 'Auditor change', '5.01': 'Change in control',
  '5.02': 'Executive / director change', '5.03': 'Bylaws change', '5.07': 'Shareholder vote', '7.01': 'Reg FD disclosure', '8.01': 'Other events', '9.01': 'Exhibits',
};

let tickerCache: { at: number; rows: { cik: number; ticker: string; title: string }[] } | null = null;

async function secCompany(nameOrTicker: string, ua: string) {
  if (!tickerCache || Date.now() - tickerCache.at > 86_400_000) {
    const d = await getJson('https://www.sec.gov/files/company_tickers.json', { headers: { 'user-agent': ua } });
    tickerCache = { at: Date.now(), rows: Object.values(d).map((r: any) => ({ cik: r.cik_str, ticker: r.ticker, title: r.title })) };
  }
  const q = nameOrTicker.trim().toLowerCase();
  if (/^\d+$/.test(q)) return tickerCache.rows.find((r) => r.cik === Number(q)) ?? { cik: Number(q), ticker: '', title: q };
  const norm = (s: string) => s.toLowerCase().replace(/[.,]/g, '').replace(/\b(inc|corp|corporation|co|ltd|plc|holdings|group|technologies|the)\b/g, '').replace(/\s+/g, ' ').trim();
  return tickerCache.rows.find((r) => r.ticker.toLowerCase() === q)
    ?? tickerCache.rows.find((r) => norm(r.title) === norm(q))
    ?? tickerCache.rows.find((r) => norm(r.title).startsWith(norm(q)));
}

async function secFilings(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const ref = input.target?.trim() || input.companyName;
  if (!ref) return null;
  const ua = ctx.settings.get('SEC_USER_AGENT') || 'kineticsand personal research admin@example.com';
  const co = await secCompany(ref, ua);
  if (!co) return { value: null, data: { note: `"${ref}" is not an SEC-registered public company (put a ticker or CIK in Target)` } };
  const sub = await getJson(`https://data.sec.gov/submissions/CIK${String(co.cik).padStart(10, '0')}.json`, { headers: { 'user-agent': ua } });
  const r = sub.filings?.recent ?? {};
  const forms = (input.keywords?.trim() || '8-K').split(',').map((f) => f.trim().toUpperCase());
  const since = new Date(Date.now() - (input.days ?? 90) * 86_400_000).toISOString().slice(0, 10);
  const filings: any[] = [];
  for (let i = 0; i < (r.form?.length ?? 0); i++) {
    if (r.filingDate[i] < since) break;
    if (!forms.some((f) => r.form[i] === f || r.form[i] === `${f}/A`)) continue;
    const items = String(r.items[i] || '').split(',').filter(Boolean);
    filings.push({
      form: r.form[i], filed: r.filingDate[i], events: items.map((x) => EIGHT_K_ITEMS[x] ?? x).filter((x) => x !== 'Exhibits'),
      url: `https://www.sec.gov/Archives/edgar/data/${co.cik}/${String(r.accessionNumber[i]).replace(/-/g, '')}/${r.primaryDocument[i]}`,
    });
  }
  const latest = filings[0];
  const flags = [...new Set(filings.flatMap((f) => f.events))].filter((e) => /Executive|Acquisition|Restructuring|Material agreement|Change in control|New debt|Bankruptcy|Auditor/.test(e));
  ctx.log(`SEC ${sub.name} (${co.ticker}): ${filings.length} ${forms.join('/')} since ${since}`);
  return { value: latest ? `${latest.filed} ${latest.form}: ${latest.events.join(', ') || 'filing'}` : null, data: { company: sub.name, ticker: co.ticker, cik: co.cik, count: filings.length, highlights: flags, filings: filings.slice(0, 20) } };
}

// ---------- US government contracts (USAspending.gov, free) ----------
async function govContracts(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const name = input.companyName;
  if (!name) return null;
  const days = input.days ?? 365;
  const d = await getJson('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
    method: 'POST',
    json: {
      filters: { recipient_search_text: [name], award_type_codes: ['A', 'B', 'C', 'D'], time_period: [{ start_date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), end_date: new Date().toISOString().slice(0, 10) }] },
      fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'],
      sort: 'Start Date', order: 'desc', limit: 25,
    },
    timeoutMs: 45_000,
  });
  const awards = (d.results ?? []).map((a: any) => ({ id: a['Award ID'], recipient: a['Recipient Name'], amount: a['Award Amount'], agency: a['Awarding Agency'], start: a['Start Date'], description: a.Description, url: a.generated_internal_id ? `https://www.usaspending.gov/award/${a.generated_internal_id}` : undefined }));
  const total = awards.reduce((n: number, a: any) => n + (Number(a.amount) || 0), 0);
  ctx.log(`USAspending "${name}": ${awards.length} awards`);
  return { value: awards[0]?.id ?? null, data: { count: awards.length, totalUsd: Math.round(total), latest: awards[0], awards } };
}

// ---------- UK Companies House filings (free API key) ----------
async function ukFilings(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const key = ctx.settings.get('COMPANIES_HOUSE_API_KEY');
  if (!key) throw new Error('Set COMPANIES_HOUSE_API_KEY (free at developer.company-information.service.gov.uk)');
  const auth = { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
  const base = 'https://api.company-information.service.gov.uk';
  let number = input.target?.trim();
  let company = input.companyName;
  if (!number) {
    const s = await getJson(`${base}/search/companies`, { headers: auth, query: { q: input.companyName, items_per_page: 1 } });
    number = s.items?.[0]?.company_number;
    company = s.items?.[0]?.title ?? company;
  }
  if (!number) return { value: null, data: { note: 'No UK company found' } };
  const f = await getJson(`${base}/company/${number}/filing-history`, { headers: auth, query: { items_per_page: 25 } });
  const filings = (f.items ?? []).map((i: any) => ({ date: i.date, category: i.category, type: i.type, description: String(i.description ?? '').replace(/-/g, ' ') }));
  const latest = filings[0];
  return { value: latest ? `${latest.date} ${latest.category}: ${latest.description}` : null, data: { company, number, officerChanges: filings.filter((x: any) => x.category === 'officers').slice(0, 5), filings } };
}

// ---------- Job change (needs Apollo or PDL) ----------
async function jobChange(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  const person = { email: input.email, linkedinUrl: input.linkedinUrl, fullName: input.fullName };
  let current: { company?: string; domain?: string; title?: string; started?: string; source: string } | null = null;
  if (ctx.settings.has('PDL_API_KEY')) {
    const p = await pdlPerson(person, ctx);
    if (p) current = { company: p.job_company_name, domain: p.job_company_website, title: p.job_title, started: p.job_start_date, source: 'pdl' };
  }
  if (!current && ctx.settings.has('APOLLO_API_KEY')) {
    const p = await apolloPerson(person, ctx);
    if (p) current = { company: p.organization?.name, domain: p.organization?.primary_domain, title: p.title, started: p.employment_history?.find((e: any) => e.current)?.start_date, source: 'apollo' };
  }
  if (!current) return null;
  const known = `${input.companyName ?? ''} ${toDomain(input.domain)}`.toLowerCase();
  const same = !!known.trim() && [current.company, current.domain].some((x) => x && known.includes(String(x).toLowerCase().replace(/^www\./, '')));
  const changed = !!known.trim() && !same;
  return { value: changed, data: { ...current, previouslyKnown: input.companyName || input.domain } };
}

// ---------- Outreach status (this workspace's campaigns) ----------
async function outreachStatus(input: SignalInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.email) return null;
  if (!ctx.outreach || !ctx.workspaceId) throw new Error('Outreach is not available');
  const s = ctx.outreach.leadStatus(ctx.workspaceId, input.email);
  if (!s) return { value: 'not a lead', data: { note: 'No lead with this email yet — add it to a campaign first' } };
  return {
    value: s.status,
    data: {
      leadId: s.lead.id, leadStatus: s.lead.status, sent: s.sent, opens: s.opens, clicks: s.clicks, replies: s.replies,
      lastReply: s.lastReply?.snippet ?? null, lastReplyCategory: s.lastReply?.category ?? null, lastReplyAt: s.lastReply?.at ?? null,
      campaign: s.campaigns[0]?.name ?? null, campaigns: s.campaigns,
    },
  };
}

// ---------- Registry ----------
export const SIGNAL_KINDS: SignalKind[] = [
  { id: 'outreach_status', label: 'Outreach status', description: 'Live campaign state for the row\'s email: queued, contacted, replied, interested, bounced, unsubscribed. Refreshes instantly on sends, opens and replies — pair with a Slack alert on "interested".', inputs: ['email'], requires: [], run: outreachStatus },
  { id: 'hiring', label: 'Hiring (open roles)', description: 'Open jobs from public Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee and Personio boards. Value = matching role count.', inputs: ['domain', 'companyName', 'target', 'keywords'], requires: [], run: hiring },
  { id: 'news', label: 'News (Google News)', description: 'Google News RSS for the company (optionally + keywords such as "raises, acquires, launches"). Value = newest headline, so a new story counts as a change.', inputs: ['companyName', 'domain', 'keywords', 'days'], requires: [], run: news },
  { id: 'gdelt', label: 'Global news (GDELT)', description: 'Worldwide, multilingual news from GDELT. Free but best-effort: strict rate limits, so it is slow on big tables. Value = newest headline.', inputs: ['companyName', 'domain', 'keywords', 'days'], requires: [], run: gdelt },
  { id: 'hacker_news', label: 'Hacker News mentions', description: 'Stories mentioning the company on HN (Algolia API). Value = newest story title.', inputs: ['companyName', 'domain', 'days'], requires: [], run: hackerNews },
  { id: 'funding_sec', label: 'Funding (SEC Form D)', description: 'US private fundraises filed with the SEC. Value = latest filing date. Set SEC_USER_AGENT to "Name email".', inputs: ['companyName', 'days'], requires: [], run: secFormD },
  { id: 'sec_filings', label: 'SEC filings (8-K events)', description: 'Public-company events: exec changes, acquisitions, layoffs, new debt, material deals. Keywords = form types (default 8-K). Value = latest filing summary.', inputs: ['companyName', 'target', 'keywords', 'days'], requires: [], run: secFilings },
  { id: 'gov_contracts', label: 'US government contracts', description: 'Federal contract awards from USAspending.gov. Value = latest award id; total $ in data.', inputs: ['companyName', 'days'], requires: [], run: govContracts },
  { id: 'uk_filings', label: 'UK Companies House filings', description: 'Filing history (accounts, officer changes, charges) for a UK company. Target = company number (optional).', inputs: ['companyName', 'target'], requires: ['COMPANIES_HOUSE_API_KEY'], run: ukFilings },
  { id: 'tech_stack', label: 'Tech stack', description: 'Detects 3,000+ technologies with the open-source Wappalyzer fingerprints (website HTML, scripts, headers, cookies, DNS). Value = list of tools.', inputs: ['domain'], requires: [], run: techStack },
  { id: 'website_change', label: 'Website / page change', description: 'Watches a page (pricing, careers, homepage). Value = content hash; changes trigger dependants.', inputs: ['target', 'domain'], requires: [], run: websiteChange },
  { id: 'github', label: 'GitHub activity', description: 'Public repos for an org. Value = last push time.', inputs: ['target', 'domain'], requires: [], run: github },
  { id: 'new_subdomains', label: 'New subdomains (certificates)', description: 'New hostnames from TLS certificate logs (Cert Spotter, crt.sh fallback) — often precedes launches. Free tier ≈10 lookups/hour, so use on a short list or add a Cert Spotter key. Value = list of new hostnames.', inputs: ['domain', 'days'], requires: [], run: newSubdomains },
  { id: 'job_change', label: 'Job change', description: 'Re-checks where a person works now (PDL or Apollo). Value = true when they have left the company you know.', inputs: ['email', 'linkedinUrl', 'fullName', 'companyName', 'domain'], requires: ['PDL_API_KEY|APOLLO_API_KEY'], run: jobChange },
  { id: 'website_visits', label: 'Website visits', description: 'Visits to your tracked websites (Visitors) by the row\'s company domain or lead email. Value = visits in the last 30 days; data has last visit, pages and intent score.', inputs: ['domain', 'email'], requires: [], run: websiteVisits },
];

export function signalKind(id: string): SignalKind {
  const k = SIGNAL_KINDS.find((x) => x.id === id);
  if (!k) throw new Error(`Unknown signal: ${id}`);
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function splitKeywords(s?: string) {
  return String(s ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
}
