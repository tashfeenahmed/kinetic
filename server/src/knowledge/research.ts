/**
 * "Fill from website" as a multi-step research run. Instead of one crawl and one
 * model call, it:
 *   1. crawls the site: home page, then the important pages found in the nav,
 *      footer and sitemap.xml (about, product, pricing, solutions, customers, a few
 *      blog posts, careers, contact…), up to ~20 pages;
 *   2. pulls the key facts out of the pages (name, category, region, customers
 *      and competitors named);
 *   3. researches outside the site with web search: competitors, alternatives,
 *      category leaders, reviews, LinkedIn, press, the customers named;
 *   4. picks the real competitors and reads each one's home page;
 *   5. writes each document separately (company, offers, ICP, personas,
 *      positioning, competitors, proof, tone, objections) from one research brief.
 * Each step is reported live (`onStep`) so the UI can show what it's doing. Token
 * use is capped and the cost is summed. Without an AI key it still crawls and
 * drafts a short Company overview plus a list of the pages it read.
 */
import { EventEmitter } from 'node:events';
import { fetchPage, decode, meta, type Page } from '../gtm/lib/html.ts';
import { webSearch, type SearchResult } from '../gtm/providers/search.ts';
import type { Settings } from '../gtm/settings.ts';
import { aiReady, chat, fnTool, agentModel, type ChatResult } from '../agent/llm.ts';
import type { DraftDoc } from './ai.ts';

/** Caps that keep a run to a minute or two and a few cents on Haiku. */
export const LIMITS = {
  maxPages: 20,
  maxSearches: 10,
  maxCompetitors: 5,
  /** Prompt tokens across the whole run; documents not yet written when it's hit are skipped. */
  maxPromptTokens: 220_000,
  docMaxTokens: 3200,
  briefChars: 40_000,
};

/** The documents the run writes, in display order, with what each must contain. */
export const RESEARCH_DOCS: { key: string; title: string; label: string; spec: string }[] = [
  {
    key: 'company', title: 'Company overview', label: 'company overview',
    spec: `## What they do (2-3 descriptive paragraphs: the product, the outcome for customers, who it is for)
## Key facts — a table | Fact | Detail | with rows: Company, Website, Founded, Headquarters, Team size, Markets/regions, Business model, Pricing model, Funding/ownership (only if found), Notable customers. Write "Not stated" when unknown.
## History (what is known: founding story, milestones, press)
## Business model and pricing model (how they make money, plans, sales motion: self-serve vs sales-led)
## Team and culture (from careers/about pages: roles hiring, values)
## Sources (bullet links to the pages used)`,
  },
  {
    key: 'offers', title: 'Products & offers', label: 'products and offers',
    spec: `One "## <Product or plan>" section per product, plan or service, each with: what it does (a paragraph), **Key features** (bullets), **Who it's for**, **Pricing** (exact if public, else "Not public").
Then "## Plans at a glance" — a table | Plan | Price | Best for | Highlights | when there are plans or tiers.
Then "## Add-ons, integrations and services" if any are mentioned.`,
  },
  {
    key: 'icp', title: 'Ideal customer profile', label: 'ideal customer profile',
    spec: `## Summary (one paragraph: the best-fit customer in plain words)
## Firmographics — a table | Attribute | Ideal | Acceptable | Poor fit | with rows: Industries, Company size (employees), Revenue/stage, Geography, Business model.
## Tech and tools they use (bullets; e.g. software they integrate with)
## Buying triggers (bullets: events that make them likely to buy now)
## Best-fit signals (bullets: things you can see from outside — job posts, tech, locations…)
## Disqualifiers (bullets)
## Example customers — a table | Customer | Industry | Size | Region | Why they fit | from case studies, testimonials and logos (mark size/industry "(inferred)" when you guessed).
## How this was inferred (2-4 bullets: which evidence — case studies, pricing, copy — supports the profile; say plainly what is inferred).`,
  },
  {
    key: 'personas', title: 'Buyer personas', label: 'buyer personas',
    spec: `Start with "## Personas at a glance" — a table | Persona | Typical titles | Role in the deal | Top pain | Messaging angle |.
Then 3 to 5 "## <Persona name>: <Role/title>" sections, each with these bold labels as bullets or short paragraphs:
**Titles:**, **Responsibilities:**, **Goals:**, **Pains:**, **Objections:**, **What they care about:**, **Messaging angle:**, **Example opening line:** (a one-sentence cold email opener in quotes, specific to this company's offer).`,
  },
  {
    key: 'positioning', title: 'Positioning & messaging', label: 'positioning and messaging',
    spec: `## One-liner (one sentence)
## Positioning statement (For <who> who <need>, <product> is a <category> that <benefit>. Unlike <alternative>, it <difference>.)
## Value propositions (3-5 "### <value prop>" with a short explanation and the proof behind it)
## Differentiators (bullets: why customers pick them over alternatives)
## Proof points (bullets with numbers, customers, awards)
## Key phrases they use (bullets quoting their own wording from the site)
## Messaging by persona — a table | Persona | Main message | Proof to use |.`,
  },
  {
    key: 'competitors', title: 'Competitors', label: 'competitors',
    spec: `## Landscape (a paragraph: the category, the kinds of alternatives — direct competitors, adjacent tools, doing nothing/spreadsheets)
## Comparison — a GFM table | Competitor | Website | Positioning | Pricing | Strengths | Weaknesses vs us | with one row per competitor from the research (use "Unknown" when not found).
Then one "### How to win against <Competitor>" section per competitor with 2-4 bullets (where we win, where they win, the talk track).
## Sources (links).`,
  },
  {
    key: 'proof', title: 'Proof & case studies', label: 'proof and case studies',
    spec: `## Headline numbers (bullets of metrics and claims found: customers, results, ratings, awards)
## Case studies — one "### <Customer>" per case study with **Customer:** (industry, size, region), **Problem:**, **Solution:**, **Result:** (numbers), and a link.
## Testimonials (quotes with name/role/company when given, as > quotes)
## Logos and notable customers (bullets)
## Reviews and ratings (from review sites found in search, with links; say when none were found).`,
  },
  {
    key: 'tone', title: 'Tone of voice', label: 'tone of voice',
    spec: `## How they sound (a descriptive paragraph, then 3-5 voice traits as "**Trait** — what it means")
## Do (bullets) and ## Don't (bullets)
## Vocabulary — a table | Use | Avoid | of their words vs. words that would feel off-brand.
## Examples in their voice (3 short examples: a headline, a LinkedIn-style line, a product sentence, rewritten in their voice)
## Email style guidelines (bullets: length, structure, subject lines, greeting, CTA, sign-off) and one "### Example cold email" in their voice (under 100 words).`,
  },
  {
    key: 'objections', title: 'Objection handling', label: 'objection handling',
    spec: `Start with a table | Objection | Who raises it | Short answer | of 6-10 likely objections (price, timing, "we already use <competitor>", switching cost, security, ROI…).
Then one "### \\"<objection>\\"" section per objection with a fuller response (2-4 sentences) and the proof point to use.`,
  },
];

export interface ResearchStep { id: number; label: string; status: 'running' | 'done' | 'failed' | 'skipped'; detail?: string }
export interface ResearchUsage { prompt: number; completion: number; costUsd: number; calls: number }
export interface Competitor { name: string; website: string; why?: string }
export interface ResearchResult {
  docs: DraftDoc[];
  summary: string;
  ai: boolean;
  host: string;
  pages: string[];
  searches: string[];
  competitors: Competitor[];
  usage: ResearchUsage;
  notes: string[];
}

export interface CrawledPage { url: string; path: string; kind: string; title: string; description: string; text: string }

interface Facts {
  company_name?: string; one_liner?: string; category?: string; region?: string; business_model?: string;
  customers_named?: string[]; competitors_named?: string[]; products?: string[];
}

export interface ResearchOpts {
  settings: Settings;
  domain: string;
  /** Called for every step change: a new running step, or one finishing. */
  onStep?: (steps: ResearchStep[]) => void;
  /** Checked between steps; true stops the run. */
  stopped?: () => boolean;
  limits?: Partial<typeof LIMITS>;
}

// ---------- crawling ----------

/** Page kinds in priority order, with how many of each to read. */
const KINDS: { kind: string; re: RegExp; max: number }[] = [
  { kind: 'about', re: /^\/(about|about-us|company|who-we-are|our-story|story|team|our-team|mission)(\/|$)/i, max: 2 },
  { kind: 'pricing', re: /^\/(pricing|plans|prices|price)(\/|$)/i, max: 1 },
  { kind: 'product', re: /^\/(product|products|platform|features|feature|how-it-works|tour|services|service|what-we-do|offer)(\/|$)/i, max: 4 },
  { kind: 'customers', re: /^\/(customers?|case-stud(y|ies)|case_studies|success-stories|stories|testimonials|reviews|clients|results)(\/|$)/i, max: 4 },
  { kind: 'solutions', re: /^\/(solutions?|industries|industry|use-cases?|for|who-we-serve|sectors?)(\/|$)/i, max: 3 },
  { kind: 'integrations', re: /^\/(integrations?|partners?|apps|marketplace|ecosystem)(\/|$)/i, max: 1 },
  { kind: 'compare', re: /^\/(compare|vs|alternatives?|why[-a-z]*)(\/|$)/i, max: 2 },
  { kind: 'blog', re: /^\/(blog|news|insights|resources|articles|press|newsroom|updates)(\/|$)/i, max: 3 },
  { kind: 'careers', re: /^\/(careers|jobs|join-us|work-with-us|hiring)(\/|$)/i, max: 1 },
  { kind: 'contact', re: /^\/(contact|contact-us|get-in-touch|locations?|offices?)(\/|$)/i, max: 1 },
];
const SKIP = /\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|css|js|xml|json|ico)$|^\/(wp-|cdn-cgi|login|signin|sign-in|signup|sign-up|register|account|cart|checkout|privacy|terms|legal|cookie|gdpr|imprint|impressum|tag|tags|category|author|feed|search)(\/|$)/i;
/** Locale prefixes other than English duplicate the same pages. */
const LOCALE = /^\/(?!en(\/|$))[a-z]{2}(-[a-z]{2})?(\/|$)/i;

const normHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** Same-site links on a page, without query strings or fragments. */
export function siteLinks(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decode(m[1]).trim(), base);
      if (!/^https?:$/.test(u.protocol) || normHost(u.hostname) !== normHost(base.hostname)) continue;
      u.hash = ''; u.search = '';
      out.add(u.toString().replace(/\/$/, ''));
    } catch { /* bad href */ }
  }
  return [...out];
}

/** URLs listed in sitemap.xml (follows a sitemap index one level, a couple of child sitemaps). */
export async function sitemapUrls(base: URL, timeoutMs = 10_000): Promise<string[]> {
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
  try {
    const root = await fetchPage(new URL('/sitemap.xml', base).toString(), timeoutMs);
    if (root.status >= 400 || !/<(urlset|sitemapindex)/i.test(root.html)) return [];
    if (!/<sitemapindex/i.test(root.html)) return locs(root.html).slice(0, 2000);
    const children = locs(root.html).sort((a, b) => Number(/post|blog/i.test(a)) - Number(/post|blog/i.test(b))).slice(0, 3);
    const out: string[] = [];
    for (const c of children) {
      try { const x = await fetchPage(c, timeoutMs); if (x.status < 400) out.push(...locs(x.html)); } catch { /* skip */ }
    }
    return out.slice(0, 3000);
  } catch {
    return [];
  }
}

/** Picks the important pages from a set of same-site URLs: a few per kind, deduped, ordered by priority. */
export function pickPages(urls: string[], base: URL, max: number): { url: string; kind: string }[] {
  const seen = new Set<string>();
  const byKind = new Map<string, string[]>();
  for (const raw of urls) {
    let u: URL;
    try { u = new URL(raw, base); } catch { continue; }
    if (normHost(u.hostname) !== normHost(base.hostname)) continue;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const key = path.toLowerCase();
    if (path === '/' || seen.has(key) || SKIP.test(path) || LOCALE.test(path)) continue;
    seen.add(key);
    const k = KINDS.find((x) => x.re.test(path));
    if (!k) continue;
    byKind.set(k.kind, [...(byKind.get(k.kind) ?? []), `${u.origin}${path}`]);
  }
  const picked: { url: string; kind: string }[] = [];
  for (const k of KINDS) {
    const list = byKind.get(k.kind) ?? [];
    // Section index pages first (/customers), then the shortest sub-pages (/customers/acme).
    const depth = (s: string) => new URL(s).pathname.split('/').filter(Boolean).length;
    let ordered = [...list].sort((a, b) => depth(a) - depth(b) || a.length - b.length);
    if (k.kind === 'blog') {
      // A blog index plus the most recent-looking posts (sitemaps usually list newest last or first; prefer dated slugs).
      const index = ordered.filter((s) => depth(s) === 1).slice(0, 1);
      const posts = list.filter((s) => depth(s) >= 2).sort((a, b) => (b.match(/20\d\d/)?.[0] ?? '').localeCompare(a.match(/20\d\d/)?.[0] ?? '')).slice(0, k.max - index.length);
      ordered = [...index, ...posts];
    }
    for (const url of ordered.slice(0, k.max)) picked.push({ url, kind: k.kind });
  }
  return picked.slice(0, max);
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const pageOf = (p: Page, kind: string, maxText: number): CrawledPage => {
  const u = new URL(p.url);
  return { url: p.url, path: u.pathname || '/', kind, title: p.title, description: meta(p.html, 'description') || meta(p.html, 'og:description'), text: p.text.slice(0, maxText) };
};

// ---------- the run ----------

class Run {
  steps: ResearchStep[] = [];
  usage: ResearchUsage = { prompt: 0, completion: 0, costUsd: 0, calls: 0 };
  notes: string[] = [];
  private o: ResearchOpts;
  readonly limits: typeof LIMITS;
  constructor(o: ResearchOpts, limits: typeof LIMITS) { this.o = o; this.limits = limits; }

  get stopped() { return !!this.o.stopped?.(); }
  check() { if (this.stopped) throw new StoppedError(); }

  step(label: string): ResearchStep {
    const s: ResearchStep = { id: this.steps.length + 1, label, status: 'running' };
    this.steps.push(s);
    this.emit();
    return s;
  }
  end(s: ResearchStep, status: ResearchStep['status'] = 'done', detail?: string) {
    s.status = status;
    if (detail) s.detail = detail;
    this.emit();
  }
  emit() { this.o.onStep?.(this.steps.map((s) => ({ ...s }))); }

  async chat(body: Parameters<typeof chat>[1]): Promise<ChatResult> {
    const r = await chat(this.o.settings, body);
    this.usage.prompt += r.usage.prompt;
    this.usage.completion += r.usage.completion;
    this.usage.costUsd += r.usage.costUsd;
    this.usage.calls++;
    return r;
  }
}

export class StoppedError extends Error { constructor() { super('Stopped'); } }

export async function researchWebsite(o: ResearchOpts): Promise<ResearchResult> {
  const run = new Run(o, { ...LIMITS, ...o.limits });
  const { settings } = o;
  const ai = aiReady(settings);
  const model = agentModel(settings);

  // 1. Home page.
  const start = o.domain.includes('://') ? o.domain.trim() : `https://${o.domain.trim().replace(/^\/+/, '')}`;
  let s = run.step(`Reading ${start.replace(/^https?:\/\//, '').replace(/\/$/, '')}…`);
  let home: Page;
  try { home = await fetchPage(start, 20_000); } catch (e: any) { run.end(s, 'failed', e.message); throw new Error(`${start}: ${e.message}`); }
  if (home.status >= 400) { run.end(s, 'failed', `HTTP ${home.status}`); throw new Error(`${start} returned HTTP ${home.status}`); }
  run.end(s);
  const base = new URL(home.url || start);
  const host = normHost(base.hostname);
  const pages: CrawledPage[] = [pageOf(home, 'home', 9000)];

  // 2. Discover pages from the nav, footer and sitemap.
  run.check();
  s = run.step('Looking for key pages in the menu and sitemap…');
  const fromHome = siteLinks(home.html, base);
  const fromSitemap = await sitemapUrls(base);
  const picks = pickPages([...fromHome, ...fromSitemap], base, run.limits.maxPages - 1);
  run.end(s, 'done', `${picks.length} pages to read (${fromHome.length} links, ${fromSitemap.length} in sitemap)`);

  // 3. Read them (a few at a time).
  const read = await pool(picks, 4, async (p) => {
    if (run.stopped) return null;
    const st = run.step(`Reading ${new URL(p.url).pathname}…`);
    try {
      const page = await fetchPage(p.url, 15_000);
      if (page.status >= 400) { run.end(st, 'failed', `HTTP ${page.status}`); return null; }
      run.end(st);
      return pageOf(page, p.kind, p.kind === 'blog' ? 3500 : 6000);
    } catch (e: any) { run.end(st, 'failed', e.message); return null; }
  });
  run.check();
  // Redirects can land several links on the same page.
  const seenUrls = new Set(pages.map((p) => p.url));
  for (const p of read) if (p && !seenUrls.has(p.url)) { seenUrls.add(p.url); pages.push(p); }

  if (!ai) return noAiResult(run, pages, host);

  // 4. Key facts from the site.
  run.check();
  s = run.step('Pulling out the key facts…');
  const siteText = sitesText(pages, 26_000);
  let facts: Facts = {};
  try {
    const r = await run.chat({
      model, max_tokens: 1500,
      messages: [
        { role: 'system', content: 'You extract facts about a company from its website for go-to-market research. Only state what the pages support; leave fields empty when unknown.' },
        { role: 'user', content: `Website: ${host}\n\n${siteText}\n\nCall facts with what you found.` },
      ],
      tools: [FACTS_TOOL], tool_choice: { type: 'function', function: { name: 'facts' } },
    });
    facts = toolArgs(r, 'facts');
    run.end(s, 'done', facts.company_name ? `${facts.company_name}${facts.category ? ` — ${facts.category}` : ''}` : undefined);
  } catch (e: any) { run.end(s, 'failed', e.message); }
  const name = (facts.company_name || home.title.split(/\s[|–—-]\s/)[0] || host).trim();

  // 5. Web research.
  run.check();
  const searches = searchPlan(name, host, facts).slice(0, run.limits.maxSearches);
  const found: { label: string; query: string; results: SearchResult[] }[] = [];
  let failures = 0;
  for (const q of searches) {
    if (run.stopped) break;
    if (failures >= 2 && !found.length) { run.notes.push('Web search is unavailable, so competitors and reviews come from the website only.'); break; }
    const st = run.step(`${q.label}…`);
    try {
      const r = await webSearch(q.query, { settings, log: () => {} }, 6);
      found.push({ ...q, results: r.results.filter((x) => x.url) });
      run.end(st, 'done', `${r.results.length} results`);
    } catch (e: any) { failures++; run.end(st, 'failed', e.message); }
  }
  run.check();

  // A couple of outside pages about them (reviews, press) when search found some.
  const outside = pickOutside(found, host).slice(0, 2);
  const outsidePages = (await pool(outside, 2, async (url) => {
    if (run.stopped) return null;
    const st = run.step(`Reading ${new URL(url).hostname.replace(/^www\./, '')}…`);
    try {
      const p = await fetchPage(url, 15_000);
      if (p.status >= 400) { run.end(st, 'failed', `HTTP ${p.status}`); return null; }
      run.end(st);
      return pageOf(p, 'outside', 3000);
    } catch (e: any) { run.end(st, 'failed', e.message); return null; }
  })).filter((p): p is CrawledPage => !!p);
  run.check();

  // 6. Competitors: pick, then check each one's site.
  s = run.step('Identifying competitors…');
  let competitors: Competitor[] = [];
  try {
    const r = await run.chat({
      model, max_tokens: 1200,
      messages: [
        { role: 'system', content: 'You identify the real competitors of a company for sales research: companies selling a similar product to similar customers. Exclude review sites, directories, media, the company itself and its customers.' },
        { role: 'user', content: `Company: ${name} (${host})\nWhat they do: ${facts.one_liner ?? ''}\nCategory: ${facts.category ?? ''}\nRegion: ${facts.region ?? ''}\nCompetitors named on their site: ${(facts.competitors_named ?? []).join(', ') || 'none'}\n\nSearch results:\n${searchText(found, 9000)}\n\nCall competitors with up to ${run.limits.maxCompetitors + 1} competitors, most relevant first, with their website domain.` },
      ],
      tools: [COMPETITORS_TOOL], tool_choice: { type: 'function', function: { name: 'competitors' } },
    });
    const list = toolArgs<{ list?: any[] }>(r, 'competitors').list;
    competitors = (Array.isArray(list) ? list : [])
      .map((c) => ({ name: String(c?.name ?? '').trim(), website: String(c?.website ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(), why: c?.why ? String(c.why) : undefined }))
      .filter((c) => c.name && normHost(c.website) !== host)
      .slice(0, run.limits.maxCompetitors);
    run.end(s, 'done', competitors.map((c) => c.name).join(', ') || 'none found');
  } catch (e: any) { run.end(s, 'failed', e.message); }
  run.check();

  const compPages = await pool(competitors, 3, async (c) => {
    if (!c.website || run.stopped) return null;
    const st = run.step(`Checking competitor ${c.name}…`);
    try {
      const p = await fetchPage(`https://${c.website}`, 15_000);
      if (p.status >= 400) { run.end(st, 'failed', `HTTP ${p.status}`); return null; }
      run.end(st);
      return { c, page: pageOf(p, 'competitor', 2500) };
    } catch (e: any) { run.end(st, 'failed', e.message); return null; }
  });
  run.check();

  // 7. Write the documents from one brief.
  const brief = researchBrief({ host, name, facts, pages, outsidePages, found, competitors, compPages: compPages.filter((x): x is { c: Competitor; page: CrawledPage } => !!x) }, run.limits.briefChars);
  const docs = await pool(RESEARCH_DOCS, 3, async (d) => {
    if (run.stopped) return null;
    if (run.usage.prompt >= run.limits.maxPromptTokens) {
      const st = run.step(`Skipped ${d.label} (token budget reached)`);
      run.end(st, 'skipped');
      return null;
    }
    const st = run.step(`Writing ${d.label}…`);
    try {
      const r = await run.chat({ model, max_tokens: run.limits.docMaxTokens, temperature: 0.3, messages: docMessages(d, brief, name, host) });
      const content = cleanMarkdown(r.message.content);
      if (!content) { run.end(st, 'failed', 'empty'); return null; }
      run.end(st, 'done', `${content.length.toLocaleString()} chars`);
      return { key: d.key, title: d.title, content };
    } catch (e: any) { run.end(st, 'failed', e.message); return null; }
  });
  run.check();
  const written = docs.filter((d): d is DraftDoc => !!d);
  if (!written.length) throw new Error('The model did not write any documents. Check the AI key and model on the Integrations page.');
  return {
    docs: written, summary: facts.one_liner ?? '', ai: true, host,
    pages: pages.map((p) => p.url), searches: found.map((f) => f.query), competitors,
    usage: run.usage, notes: run.notes,
  };
}

/** No model: what the crawl alone can say. */
function noAiResult(run: Run, pages: CrawledPage[], host: string): ResearchResult {
  const home = pages[0];
  const name = (home.title.split(/\s[|–—-]\s/)[0] || host).trim();
  const overview = [
    `**Company:** ${name}`, `**Website:** ${host}`, home.description ? `\n${home.description}` : '',
    pages.length > 1 ? `\n## Pages read\n\n| Page | Title | Description |\n| --- | --- | --- |\n${pages.map((p) => `| [${p.path}](${p.url}) | ${cell(p.title)} | ${cell(p.description)} |`).join('\n')}` : '',
  ].join('\n').trim();
  run.notes.push('No AI model is set up, so only a short company overview was drafted from the pages. Add an OpenRouter key (or AI_BASE_URL) on the Integrations page for the full research.');
  return { docs: [{ key: 'company', title: 'Company overview', content: overview }], summary: home.description, ai: false, host, pages: pages.map((p) => p.url), searches: [], competitors: [], usage: run.usage, notes: run.notes };
}

const cell = (s: string) => (s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 160);

const FACTS_TOOL = fnTool('facts', 'Key facts about the company from its website.', {
  company_name: { type: 'string' },
  one_liner: { type: 'string', description: 'What they sell and to whom, one sentence' },
  category: { type: 'string', description: 'The product category in a few words, as a buyer would search for it (e.g. "restaurant POS software")' },
  region: { type: 'string', description: 'Main country/region they sell in, if clear' },
  business_model: { type: 'string', description: 'e.g. B2B SaaS subscription, agency retainer, marketplace' },
  customers_named: { type: 'array', items: { type: 'string' }, description: 'Customer company names in case studies, testimonials or logos (max 8)' },
  competitors_named: { type: 'array', items: { type: 'string' }, description: 'Competitors or alternatives the site names (comparison pages, "vs")' },
  products: { type: 'array', items: { type: 'string' } },
}, ['company_name', 'category']);

const COMPETITORS_TOOL = fnTool('competitors', 'The company\'s competitors.', {
  list: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, website: { type: 'string', description: 'domain, e.g. acme.com' }, why: { type: 'string' } }, required: ['name', 'website'] } },
}, ['list']);

function toolArgs<T = any>(r: ChatResult, name: string): T {
  const call = r.message.tool_calls?.find((c) => c.function.name === name);
  const raw = call?.function.arguments ?? r.message.content.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
  try { return JSON.parse(raw) as T; } catch { return {} as T; }
}

/** The searches the run makes, most useful first. */
export function searchPlan(name: string, host: string, f: Facts): { label: string; query: string }[] {
  const region = f.region && !/global|worldwide|international/i.test(f.region) ? ` ${f.region}` : '';
  const out = [
    { label: 'Searching competitors', query: `${name} competitors` },
    { label: 'Searching alternatives', query: `${name} alternatives` },
    ...(f.category ? [{ label: `Searching category leaders (${f.category})`, query: `best ${f.category}${region}` }] : []),
    { label: 'Searching reviews', query: `${name} reviews` },
    { label: 'Searching LinkedIn and company info', query: `${name} ${host} linkedin company` },
    { label: 'Searching press and news', query: `"${name}" news` },
    ...(f.customers_named ?? []).slice(0, 3).map((c) => ({ label: `Looking up customer ${c}`, query: `${c} company` })),
  ];
  return out;
}

const OUTSIDE_OK = /g2\.com|capterra|trustpilot|getapp|softwareadvice|trustradius|crunchbase|techcrunch|producthunt/i;
function pickOutside(found: { results: SearchResult[] }[], host: string): string[] {
  const urls: string[] = [];
  for (const f of found) for (const r of f.results) {
    try {
      const h = normHost(new URL(r.url).hostname);
      if (h !== host && OUTSIDE_OK.test(h) && !urls.includes(r.url)) urls.push(r.url);
    } catch { /* bad url */ }
  }
  return urls;
}

function sitesText(pages: CrawledPage[], max: number): string {
  // Each page gets a fair share so one long page can't crowd out the rest.
  const share = Math.max(1200, Math.floor(max / Math.max(1, pages.length)));
  return pages.map((p) => `## [${p.kind}] ${p.path} — ${p.title}\nURL: ${p.url}\n${p.description ? `Description: ${p.description}\n` : ''}${p.text.slice(0, p.kind === 'home' ? share * 2 : share)}`).join('\n\n').slice(0, max);
}

function searchText(found: { query: string; results: SearchResult[] }[], max: number): string {
  return found.map((f) => `### Search: ${f.query}\n${f.results.map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`).join('\n\n').slice(0, max);
}

/** Everything the writers see, in labelled sections, capped. */
export function researchBrief(x: {
  host: string; name: string; facts: Facts; pages: CrawledPage[]; outsidePages: CrawledPage[];
  found: { query: string; results: SearchResult[] }[]; competitors: Competitor[]; compPages: { c: Competitor; page: CrawledPage }[];
}, max: number): string {
  const f = x.facts;
  const facts = [
    `Company: ${x.name}`, `Website: ${x.host}`, f.one_liner && `What they do: ${f.one_liner}`, f.category && `Category: ${f.category}`,
    f.region && `Region: ${f.region}`, f.business_model && `Business model: ${f.business_model}`,
    f.products?.length && `Products: ${f.products.join(', ')}`, f.customers_named?.length && `Customers named: ${f.customers_named.join(', ')}`,
    f.competitors_named?.length && `Competitors named on their site: ${f.competitors_named.join(', ')}`,
  ].filter(Boolean).join('\n');
  const comps = x.competitors.map((c) => {
    const p = x.compPages.find((y) => y.c === c)?.page;
    return `### ${c.name} (${c.website})\n${c.why ? `Why: ${c.why}\n` : ''}${p ? `Title: ${p.title}\n${p.description ? `Description: ${p.description}\n` : ''}${p.text.slice(0, 1500)}` : '(site not read)'}`;
  }).join('\n\n');
  const outside = x.outsidePages.map((p) => `### ${p.title} (${p.url})\n${p.text.slice(0, 2000)}`).join('\n\n');
  const budget = { site: Math.floor(max * 0.55), search: Math.floor(max * 0.15), comps: Math.floor(max * 0.18), outside: Math.floor(max * 0.08) };
  return [
    `# Key facts\n${facts}`,
    `# Their website (${x.pages.length} pages)\n${sitesText(x.pages, budget.site)}`,
    x.found.length ? `# Web search results\n${searchText(x.found, budget.search)}` : '# Web search results\n(none: web search was unavailable)',
    comps ? `# Competitors checked\n${comps.slice(0, budget.comps)}` : '',
    outside ? `# Outside pages (reviews, press)\n${outside.slice(0, budget.outside)}` : '',
  ].filter(Boolean).join('\n\n').slice(0, max);
}

function docMessages(d: (typeof RESEARCH_DOCS)[number], brief: string, name: string, host: string) {
  return [
    {
      role: 'system',
      content: `You are a senior B2B go-to-market strategist writing a knowledge base that a sales team and an AI SDR will use for outbound. You write one document at a time in GitHub-flavoured markdown:
- "##" and "###" headings (never a "#" title: the document already has one), bullet lists, **bold** labels, and GFM tables (| a | b | with a | --- | separator row) wherever the spec asks for one or a comparison helps.
- Be specific and descriptive: use the company's real products, customers, numbers and wording from the research. Aim for 500-1200 words.
- Be honest: state facts the research supports; when you infer (ICP, personas, objections), say so with "(inferred)" or a short note. Never invent statistics, customers or quotes.
- Output only the document markdown, no preamble.`,
    },
    {
      role: 'user',
      content: `RESEARCH on ${name} (${host}):\n\n${brief}\n\n---\nDOCUMENT: ${d.title}\nWrite the "${d.title}" document for ${name}. Structure:\n${d.spec}`,
    },
  ];
}

/** Model markdown -> stored markdown: no code fence around it, no leading "# Title", tidy blank lines. */
export function cleanMarkdown(s: string): string {
  let md = (s ?? '').trim();
  const fence = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) md = fence[1].trim();
  md = md.replace(/^#\s+[^\n]*\n+/, '');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- background runs (the UI watches them live) ----------

export interface ResearchRunState {
  id: number; workspaceId: number; domain: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  steps: ResearchStep[];
  result: ResearchResult | null;
  error: string | null;
  started_at: string; finished_at: string | null;
}

const KEEP_MS = 3 * 60 * 60 * 1000;

/** In-memory registry of research runs (they don't survive a restart; the docs are created on review). */
export class ResearchService {
  readonly bus = new EventEmitter();
  private runs = new Map<number, ResearchRunState & { stop: boolean; done: Promise<void> }>();
  private nextId = 1;
  private settings: () => Settings;
  private now: () => Date;
  constructor(settings: () => Settings, now: () => Date = () => new Date()) { this.settings = settings; this.now = now; this.bus.setMaxListeners(100); }

  start(workspaceId: number, domain: string, limits?: Partial<typeof LIMITS>): ResearchRunState {
    this.prune();
    const id = this.nextId++;
    const state = { id, workspaceId, domain, status: 'running' as const, steps: [], result: null, error: null, started_at: this.now().toISOString(), finished_at: null, stop: false, done: Promise.resolve() } as ResearchRunState & { stop: boolean; done: Promise<void> };
    this.runs.set(id, state);
    state.done = researchWebsite({
      settings: this.settings(), domain, limits,
      stopped: () => state.stop,
      onStep: (steps) => { state.steps = steps; this.publish(state); },
    }).then((result) => {
      if (state.stop) return;
      state.result = result;
      state.status = 'done';
    }).catch((e: any) => {
      if (state.stop || e instanceof StoppedError) { state.status = 'stopped'; return; }
      state.status = 'failed';
      state.error = String(e?.message ?? e);
    }).finally(() => {
      state.finished_at = this.now().toISOString();
      this.publish(state);
    });
    return this.json(state);
  }

  get(workspaceId: number, id: number): ResearchRunState | undefined {
    const r = this.runs.get(id);
    return r && r.workspaceId === workspaceId ? this.json(r) : undefined;
  }

  /** Resolves when the run has finished. */
  async wait(id: number) { await this.runs.get(id)?.done; }

  stop(workspaceId: number, id: number): boolean {
    const r = this.runs.get(id);
    if (!r || r.workspaceId !== workspaceId || r.status !== 'running') return false;
    r.stop = true;
    r.status = 'stopped';
    this.publish(r);
    return true;
  }

  shutdown() { for (const r of this.runs.values()) r.stop = true; }

  private publish(r: ResearchRunState) { this.bus.emit(`run:${r.id}`, this.json(r)); }
  private json(r: ResearchRunState): ResearchRunState {
    const { id, workspaceId, domain, status, steps, result, error, started_at, finished_at } = r;
    return { id, workspaceId, domain, status, steps, result, error, started_at, finished_at };
  }
  private prune() {
    const cutoff = this.now().getTime() - KEEP_MS;
    for (const [id, r] of this.runs) if (r.status !== 'running' && new Date(r.finished_at ?? r.started_at).getTime() < cutoff) this.runs.delete(id);
  }
}
