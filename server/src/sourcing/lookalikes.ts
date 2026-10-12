/**
 * Lookalikes: companies or people similar to a few seeds.
 *
 * Companies: each seed is profiled from the existing enrichments (YC directory, Apollo/PDL
 * when keyed, Wikidata, the homepage, optionally Wappalyzer tech), the seeds are merged into
 * one profile (keywords, industries, size, places, tech) and candidates come from Apollo/PDL
 * company search when keyed, otherwise the YC directory, Wikidata industry peers and the AI
 * web search. Every candidate gets a 0–100 similarity with a plain-language reason.
 *
 * People: seed titles → seniority, department and title keywords; candidates from Apollo/PDL
 * people search when keyed, otherwise web search for public LinkedIn profiles
 * (`site:linkedin.com/in "<title>" "<company>"`) through the configured search provider.
 */
import { getJson } from '../gtm/lib/http.ts';
import { toDomain } from '../gtm/lib/sandbox.ts';
import { runAgent } from '../gtm/engine/agent.ts';
import { aiCompanySearch } from '../gtm/providers/aiSearch.ts';
import { websiteCompany } from '../gtm/providers/free.ts';
import { apolloCompanySearch, apolloPeopleSearch } from '../gtm/providers/integrations.ts';
import { queryTerms, wikidataCompany, ycCompany, ycSearch } from '../gtm/providers/openData.ts';
import { webSearch } from '../gtm/providers/search.ts';
import { signalKind } from '../gtm/providers/signals.ts';
import { apolloCompany, pdlCompany } from '../gtm/providers/vendors.ts';
import type { Ctx } from '../gtm/providers/types.ts';
import { normCompany, normLinkedin } from './normalize.ts';

const aiReady = (ctx: Ctx) => ctx.settings.has('OPENROUTER_API_KEY') || ctx.settings.has('AI_BASE_URL');

// Words that say little about what a company does.
const GENERIC = new Set(['platform', 'solution', 'solutions', 'software', 'service', 'services', 'help', 'helps', 'team', 'teams', 'build', 'built', 'your', 'our', 'we', 'new', 'modern',
  'way', 'world', 'leading', 'online', 'product', 'products', 'tool', 'tools', 'app', 'apps', 'businesses', 'customer', 'customers', 'people', 'more', 'than', 'from', 'into', 'their',
  'easy', 'simple', 'fast', 'better', 'every', 'one', 'all-in-one', 'powerful', 'free', 'get', 'use', 'using', 'used', 'can', 'it', 'its', 'you', 'out', 'up', 'by', 'as', 'be', 'help', 'inc', 'llc', 'ltd', 'com', 'www']);

export function keywordsOf(text: string): string[] {
  return queryTerms(text).filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t));
}

// ---------- company facts and profile ----------
export interface CompanyFacts {
  domain: string; name: string; description: string; industry: string;
  employees?: number; location: string; tags: string[]; tech: string[]; wikidata?: string;
}

/** What we know about one seed company, from the cheapest sources first. */
export async function companyFacts(domain: string, ctx: Ctx, opts: { tech?: boolean } = {}): Promise<CompanyFacts> {
  const d = toDomain(domain);
  const f: CompanyFacts = { domain: d, name: '', description: '', industry: '', location: '', tags: [], tech: [] };
  const merge = (x: Record<string, any> | undefined | null) => {
    if (!x) return;
    f.name ||= x.name ?? '';
    f.description ||= [x.description, x.longDescription].filter(Boolean).join(' ');
    f.industry ||= x.industry ?? '';
    f.employees ??= Number(x.employees) || undefined;
    f.location ||= (Array.isArray(x.location) ? x.location.join(', ') : x.location) ?? x.hq ?? x.country ?? '';
    if (Array.isArray(x.tags)) f.tags.push(...x.tags.map(String));
    if (Array.isArray(x.tech)) f.tech.push(...x.tech.map(String));
    f.wikidata ??= x.wikidata;
  };
  const safe = async <T>(p: Promise<T>) => p.catch((e) => { ctx.log(`lookalikes ${d}: ${e.message}`); return null; });
  merge((await safe(ycCompany({ domain: d })))?.data);
  if (ctx.settings.has('APOLLO_API_KEY')) merge((await safe(apolloCompany({ domain: d }, ctx)))?.data);
  if (ctx.settings.has('PDL_API_KEY') && (!f.industry || !f.employees)) merge((await safe(pdlCompany({ domain: d }, ctx)))?.data);
  if (!f.industry || !f.employees || !f.wikidata) merge((await safe(wikidataCompany({ domain: d }, ctx)))?.data);
  if (!f.description) merge((await safe(websiteCompany({ domain: d })))?.data);
  if (opts.tech) {
    const t = await safe(signalKind('tech_stack').run({ domain: d }, ctx));
    if (Array.isArray(t?.value)) f.tech = (t!.value as unknown[]).map(String).filter((x) => !/^Mail: /.test(x));
  }
  f.name ||= d;
  return f;
}

export interface CompanyProfile {
  seeds: CompanyFacts[];
  keywords: { term: string; weight: number }[];
  industries: string[];
  employees?: { min: number; max: number; median: number };
  locations: string[];
  tech: string[];
  summary?: string;
  /** A one-line description used for search providers. */
  query: string;
}

/** Merge seed facts: keywords shared by more seeds weigh more. */
export function buildProfile(seeds: CompanyFacts[]): CompanyProfile {
  const df = new Map<string, number>();
  for (const s of seeds) {
    for (const t of new Set(keywordsOf([s.description, s.industry, ...s.tags].join(' . ')))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const keywords = [...df.entries()].map(([term, n]) => ({ term, weight: n / Math.max(1, seeds.length) }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)).slice(0, 15);
  const sizes = seeds.map((s) => s.employees).filter((n): n is number => !!n).sort((a, b) => a - b);
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
  const industries = count(seeds.flatMap((s) => s.industry.split(/[,;→/]/).map((x) => x.trim()).filter(Boolean)));
  const locations = count(seeds.flatMap((s) => s.location.split(/[,;]/).map((x) => x.trim()).filter((x) => x && x.length > 1)));
  const tech = count(seeds.flatMap((s) => s.tech)).filter((t, _i, all) => seeds.length === 1 || seeds.filter((s) => s.tech.includes(t)).length >= Math.ceil(seeds.length / 2) || all.length < 10);
  const query = [keywords.slice(0, 5).map((k) => k.term).join(' '), industries[0]].filter(Boolean).join(' · ');
  return {
    seeds, keywords, industries: industries.slice(0, 5), locations: locations.slice(0, 5), tech: tech.slice(0, 20), query,
    employees: sizes.length ? { min: sizes[0], max: sizes[sizes.length - 1], median: sizes[Math.floor(sizes.length / 2)] } : undefined,
  };
}

/** Optional AI pass: a short ICP summary and better keywords from the seed descriptions. */
async function summarise(profile: CompanyProfile, ctx: Ctx) {
  if (!aiReady(ctx)) return;
  try {
    const r = await runAgent({
      prompt: `These are a customer's best accounts:\n${profile.seeds.map((s) => `- ${s.name} (${s.domain}): ${s.description || 'no description'}${s.industry ? ` [${s.industry}]` : ''}${s.employees ? ` ~${s.employees} employees` : ''}`).join('\n')}\n\nDescribe what they have in common so we can find lookalike companies.`,
      outputs: [
        { name: 'summary', type: 'string', description: 'one sentence: what these companies are and who they sell to' },
        { name: 'keywords', type: 'list', description: '4-8 short keywords a directory would tag them with (e.g. "restaurant pos", "payments")' },
      ],
      webSearch: false, fetchPages: false, maxSteps: 2,
    }, ctx);
    if (typeof r.output.summary === 'string') profile.summary = r.output.summary;
    const extra = (r.output.keywords as string[] | null) ?? [];
    for (const k of extra.flatMap((x) => keywordsOf(String(x)))) if (!profile.keywords.some((p) => p.term === k)) profile.keywords.push({ term: k, weight: 0.5 });
  } catch (e: any) {
    ctx.log(`lookalikes summary failed: ${e.message}`);
  }
}

// ---------- scoring ----------
export interface Candidate {
  name: string; domain: string; description?: string; industry?: string; employees?: number;
  location?: string; tags?: string[]; tech?: string[]; linkedin?: string; source: string;
}

/** 0–100 similarity of a candidate company to the profile, with the reasons that drove it. */
export function scoreCompany(p: CompanyProfile, c: Candidate): { score: number; reason: string } {
  const parts: { w: number; s: number }[] = [];
  const why: string[] = [];
  const text = [c.name, c.description, c.industry, ...(c.tags ?? [])].filter(Boolean).join(' . ');
  const terms = new Set(keywordsOf(text));
  const top = p.keywords.slice(0, 10);
  if (top.length) {
    const total = top.reduce((a, k) => a + k.weight, 0);
    const matched = top.filter((k) => terms.has(k.term) || (k.term.includes(' ') && text.toLowerCase().includes(k.term)));
    const f = matched.reduce((a, k) => a + k.weight, 0) / total;
    parts.push({ w: 45, s: Math.min(1, f * 2) });
    if (matched.length) why.push(`keywords: ${matched.slice(0, 4).map((k) => k.term).join(', ')}`);
  }
  if (p.industries.length && c.industry) {
    const ind = c.industry.toLowerCase();
    const hit = p.industries.find((i) => ind.includes(i.toLowerCase()) || i.toLowerCase().includes(ind));
    parts.push({ w: 20, s: hit ? 1 : 0 });
    if (hit) why.push(`industry: ${hit}`);
  }
  if (p.employees && c.employees) {
    const diff = Math.abs(Math.log10(c.employees) - Math.log10(Math.max(1, p.employees.median)));
    const s = Math.max(0, 1 - diff / 1.5);
    parts.push({ w: 15, s });
    if (s >= 0.5) why.push(`similar size (${c.employees} vs ~${p.employees.median})`);
  }
  if (p.locations.length && c.location) {
    const loc = c.location.toLowerCase();
    const hit = p.locations.find((l) => loc.includes(l.toLowerCase()));
    parts.push({ w: 10, s: hit ? 1 : 0 });
    if (hit) why.push(`location: ${hit}`);
  }
  if (p.tech.length && c.tech?.length) {
    const shared = c.tech.filter((t) => p.tech.includes(t));
    parts.push({ w: 10, s: shared.length / Math.min(p.tech.length, c.tech.length) });
    if (shared.length) why.push(`tech: ${shared.slice(0, 3).join(', ')}`);
  }
  const w = parts.reduce((a, x) => a + x.w, 0);
  const score = w ? Math.round((100 * parts.reduce((a, x) => a + x.w * x.s, 0)) / w) : 0;
  return { score, reason: why.join(' · ') || 'weak match' };
}

// ---------- company candidates ----------
async function pdlCompanySearch(p: CompanyProfile, ctx: Ctx, size: number): Promise<Candidate[]> {
  const should = p.keywords.slice(0, 8).map((k) => ({ match: { summary: k.term } }));
  const must: unknown[] = [];
  if (p.industries[0]) should.push({ match: { industry: p.industries[0].toLowerCase() } } as any);
  if (p.employees) must.push({ range: { employee_count: { gte: Math.max(1, Math.floor(p.employees.min / 3)), lte: p.employees.max * 3 } } });
  const d = await getJson('https://api.peopledatalabs.com/v5/company/search', {
    method: 'POST', headers: { 'X-Api-Key': ctx.settings.get('PDL_API_KEY')! },
    json: { query: { bool: { must, should, minimum_should_match: 1 } }, size: Math.min(size, 100), titlecase: true },
  });
  return (d.data ?? []).map((c: any) => ({ name: c.display_name ?? c.name, domain: toDomain(c.website ?? ''), description: c.summary, industry: c.industry, employees: c.employee_count, location: c.location?.name, tags: c.tags, linkedin: c.linkedin_url ? `https://${c.linkedin_url}` : undefined, source: 'People Data Labs' }));
}

async function apolloCandidates(p: CompanyProfile, ctx: Ctx, size: number): Promise<Candidate[]> {
  const employees = p.employees ? `${Math.max(1, Math.floor(p.employees.min / 3))}-${p.employees.max * 3}` : undefined;
  const rows = await apolloCompanySearch(ctx.settings, { keywords: p.keywords.slice(0, 5).map((k) => k.term).join(','), employees, limit: size });
  return rows.map((r) => ({ name: String(r.Company ?? ''), domain: toDomain(String(r['Company domain'] ?? '')), industry: String(r.Industry ?? ''), employees: Number(r.Employees) || undefined, location: String(r.Location ?? ''), linkedin: String(r['LinkedIn URL'] ?? ''), source: 'Apollo' }));
}

async function ycCandidates(p: CompanyProfile, size: number): Promise<Candidate[]> {
  const kws = p.keywords.slice(0, 6).map((k) => k.term);
  if (!kws.length) return [];
  const rows = await ycSearch({ query: kws.join(', '), limit: size });
  return rows.map((r) => ({ name: String(r.Company), domain: String(r['Company domain'] ?? ''), description: String(r.Description ?? ''), industry: String(r.Industry ?? ''), employees: Number(r['Team size']) || undefined, location: String(r.Location ?? ''), source: 'YC directory' }));
}

/** Organisations sharing an industry (P452) with the seeds on Wikidata, best known first. */
async function wikidataPeers(p: CompanyProfile, size: number): Promise<Candidate[]> {
  const ids = p.seeds.map((s) => s.wikidata?.split('/').pop()).filter((x): x is string => !!x && /^Q\d+$/.test(x));
  if (!ids.length) return [];
  const q = `SELECT DISTINCT ?item ?itemLabel ?itemDescription ?website ?employees ?industryLabel ?countryLabel ?links WHERE {
    VALUES ?seed { ${ids.map((i) => `wd:${i}`).join(' ')} } ?seed wdt:P452 ?industry . ?item wdt:P452 ?industry ; wdt:P856 ?website ; wikibase:sitelinks ?links .
    FILTER(?item NOT IN (${ids.map((i) => `wd:${i}`).join(', ')}))
    OPTIONAL { ?item wdt:P1128 ?employees } OPTIONAL { ?item wdt:P17 ?country }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } ORDER BY DESC(?links) LIMIT ${Math.min(size * 2, 200)}`;
  const d = await getJson('https://query.wikidata.org/sparql', { headers: { 'user-agent': 'kineticsand/0.1 (personal research tool)', accept: 'application/sparql-results+json' }, query: { query: q }, timeoutMs: 30_000 });
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const b of d?.results?.bindings ?? []) {
    const domain = toDomain(b.website?.value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({ name: b.itemLabel?.value, domain, description: b.itemDescription?.value, industry: b.industryLabel?.value, employees: Number(b.employees?.value) || undefined, location: b.countryLabel?.value, source: 'Wikidata' });
  }
  return out.slice(0, size);
}

export interface LookalikeResult { profile: CompanyProfile; rows: Record<string, unknown>[]; sources: string[] }

/** Profile seed domains: facts per seed, merged, plus an AI summary when a model is configured. */
export async function companyProfile(seedDomains: string[], ctx: Ctx, opts: { tech?: boolean; useAi?: boolean } = {}): Promise<CompanyProfile> {
  const seeds = [...new Set(seedDomains.map((d) => toDomain(d)).filter(Boolean))].slice(0, 10);
  if (!seeds.length) throw Object.assign(new Error('Give one or more seed company domains, e.g. stripe.com, adyen.com'), { statusCode: 400 });
  const facts: CompanyFacts[] = [];
  for (const d of seeds) facts.push(await companyFacts(d, ctx, { tech: opts.tech ?? seeds.length <= 3 }));
  const profile = buildProfile(facts);
  if (opts.useAi !== false) await summarise(profile, ctx);
  return profile;
}

/** Similar companies to the seed domains, scored and sorted, seeds removed. */
export async function companyLookalikes(seedDomains: string[], ctx: Ctx, opts: { limit?: number; minScore?: number; tech?: boolean; useAi?: boolean } = {}): Promise<LookalikeResult> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const profile = await companyProfile(seedDomains, ctx, opts);
  const facts = profile.seeds;
  const seeds = facts.map((f) => f.domain);

  const pool: Candidate[] = [];
  const used: string[] = [];
  const add = async (name: string, fn: () => Promise<Candidate[]>) => {
    try { const c = await fn(); if (c.length) { pool.push(...c); used.push(name); } } catch (e: any) { ctx.log(`lookalikes ${name}: ${e.message}`); }
  };
  const keyed = ctx.settings.has('APOLLO_API_KEY') || ctx.settings.has('PDL_API_KEY');
  if (ctx.settings.has('APOLLO_API_KEY')) await add('Apollo', () => apolloCandidates(profile, ctx, limit * 2));
  if (ctx.settings.has('PDL_API_KEY')) await add('People Data Labs', () => pdlCompanySearch(profile, ctx, limit * 2));
  await add('YC directory', () => ycCandidates(profile, limit * 3));
  await add('Wikidata', () => wikidataPeers(profile, limit));
  if (opts.useAi !== false && aiReady(ctx) && (!keyed || pool.length < limit)) {
    const names = facts.map((f) => f.name).join(', ');
    await add('AI web search', async () => (await aiCompanySearch(`companies similar to ${names}${profile.summary ? ` — ${profile.summary}` : profile.query ? ` (${profile.query})` : ''}`, ctx, Math.min(limit, 40)))
      .map((r) => ({ name: String(r.Company), domain: String(r['Company domain'] ?? ''), description: String(r.Description ?? ''), source: 'AI web search' })));
  }

  const seedSet = new Set(seeds);
  const seedNames = new Set(facts.map((f) => normCompany(f.name)));
  const best = new Map<string, Candidate & { score: number; reason: string }>();
  for (const c of pool) {
    const key = c.domain || normCompany(c.name);
    if (!key || seedSet.has(c.domain) || seedNames.has(normCompany(c.name))) continue;
    const s = scoreCompany(profile, c);
    const prev = best.get(key);
    // AI picks were chosen as lookalikes by reading the web; give them a floor.
    const score = c.source === 'AI web search' ? Math.max(s.score, 50) : s.score;
    if (!prev || score > prev.score) best.set(key, { ...c, score, reason: s.reason });
  }
  const minScore = opts.minScore ?? 15;
  const rows = [...best.values()].filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit).map((c) => ({
    Company: c.name, 'Company domain': c.domain, Description: c.description ?? '', Industry: c.industry ?? '', Employees: c.employees ?? '',
    Location: c.location ?? '', 'LinkedIn URL': c.linkedin ?? '', Similarity: c.score, 'Similarity reason': c.reason, Source: c.source,
  }));
  return { profile, rows, sources: used };
}

// ---------- people ----------
export interface PersonSeed { title?: string; company?: string; domain?: string; seniority?: string; department?: string; name?: string }

const SENIORITY: [string, RegExp][] = [
  ['founder', /\b(founder|co-?founder|owner)\b/i],
  ['c_suite', /\b(ceo|cto|cfo|coo|cmo|cro|cio|ciso|cpo|chief)\b/i],
  ['vp', /\b(vp|vice president|svp|evp)\b/i],
  ['head', /\bhead of\b/i],
  ['director', /\bdirector\b/i],
  ['manager', /\b(manager|lead|team lead)\b/i],
  ['senior', /\b(senior|sr\.?|principal|staff)\b/i],
];
const DEPARTMENT: [string, RegExp][] = [
  ['engineering', /\b(engineer|engineering|developer|cto|devops|software|platform|infrastructure|sre)\b/i],
  ['sales', /\b(sales|account executive|ae|sdr|bdr|business development|cro|revenue)\b/i],
  ['marketing', /\b(marketing|growth|brand|demand gen|content|cmo|seo)\b/i],
  ['product', /\b(product|cpo|ux|design)\b/i],
  ['operations', /\b(operations|ops|coo|supply chain|logistics)\b/i],
  ['finance', /\b(finance|cfo|accounting|controller|fp&a)\b/i],
  ['people', /\b(hr|people|talent|recruit|human resources)\b/i],
  ['customer', /\b(customer success|support|cs|account manager)\b/i],
  ['data', /\b(data|analytics|machine learning|ml|ai)\b/i],
  ['legal', /\b(legal|counsel|compliance)\b/i],
  ['executive', /\b(ceo|founder|president|managing director|general manager)\b/i],
];
export const seniorityOf = (title: string) => SENIORITY.find(([, re]) => re.test(title))?.[0] ?? 'entry';
export const departmentOf = (title: string) => DEPARTMENT.find(([, re]) => re.test(title))?.[0] ?? '';

const titleTokens = (t: string) => new Set(String(t).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !['of', 'and', 'the', 'at', 'for', 'in'].includes(w)));

export interface PeopleProfile { titles: string[]; seniorities: string[]; departments: string[] }

export function buildPeopleProfile(seeds: PersonSeed[]): PeopleProfile {
  const titles = [...new Set(seeds.map((s) => String(s.title ?? '').trim()).filter(Boolean))];
  return {
    titles,
    seniorities: [...new Set(seeds.map((s) => s.seniority || (s.title ? seniorityOf(s.title) : '')).filter(Boolean))],
    departments: [...new Set(seeds.map((s) => s.department || (s.title ? departmentOf(s.title) : '')).filter(Boolean))],
  };
}

export function scorePerson(p: PeopleProfile, title: string): { score: number; reason: string } {
  if (!title) return { score: 20, reason: 'no title' };
  const t = titleTokens(title);
  let bestSim = 0;
  let bestTitle = '';
  for (const s of p.titles) {
    const st = titleTokens(s);
    const inter = [...t].filter((x) => st.has(x)).length;
    const sim = inter / Math.max(1, new Set([...t, ...st]).size);
    if (sim > bestSim) { bestSim = sim; bestTitle = s; }
  }
  const sen = seniorityOf(title);
  const dep = departmentOf(title);
  const senOk = p.seniorities.includes(sen);
  const depOk = !!dep && p.departments.includes(dep);
  const score = Math.round(100 * (0.5 * Math.min(1, bestSim * 1.5) + 0.25 * (senOk ? 1 : 0) + 0.25 * (p.departments.length ? (depOk ? 1 : 0) : 0.5)));
  const why = [bestSim > 0 ? `title like "${bestTitle}"` : '', senOk ? `seniority: ${sen.replace('_', '-')}` : '', depOk ? `department: ${dep}` : ''].filter(Boolean);
  return { score, reason: why.join(' · ') || 'weak match' };
}

/** "Jane Doe - VP Sales - Acme | LinkedIn" → parts. */
export function parseLinkedinResult(title: string, snippet = ''): { name: string; title: string; company: string } {
  const clean = title.replace(/\s*[|·]\s*LinkedIn.*$/i, '').replace(/\s*-\s*LinkedIn.*$/i, '').trim();
  const parts = clean.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  let role = parts[1] ?? '';
  let company = parts[2] ?? '';
  const at = role.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at && !company) { role = at[1]; company = at[2]; }
  if (!role) role = snippet.match(/^([^.·]{3,80}?)\s+(?:at|@)\s+/i)?.[1] ?? '';
  return { name: parts[0] ?? '', title: role, company };
}

async function pdlPeopleSearch(p: PeopleProfile, targets: string[], ctx: Ctx, size: number) {
  const must: unknown[] = [];
  if (targets.length) must.push({ terms: { job_company_website: targets } });
  const should = p.titles.slice(0, 5).map((t) => ({ match_phrase: { job_title: t.toLowerCase() } }));
  const d = await getJson('https://api.peopledatalabs.com/v5/person/search', {
    method: 'POST', headers: { 'X-Api-Key': ctx.settings.get('PDL_API_KEY')! },
    json: { query: { bool: { must, should, minimum_should_match: should.length ? 1 : 0 } }, size: Math.min(size, 100), titlecase: true },
  });
  return (d.data ?? []).map((x: any) => ({ 'Full name': x.full_name, Title: x.job_title, Company: x.job_company_name, 'Company domain': toDomain(x.job_company_website ?? ''), 'LinkedIn URL': x.linkedin_url ? `https://${String(x.linkedin_url).replace(/^https?:\/\//, '')}` : '', Location: x.location_name ?? '', Source: 'People Data Labs' }));
}

/** People similar to the seeds, at the target companies or across the market. */
export async function peopleLookalikes(seeds: PersonSeed[], ctx: Ctx, opts: { companies?: string[]; location?: string; limit?: number; minScore?: number; maxQueries?: number } = {}) {
  const profile = buildPeopleProfile(seeds);
  if (!profile.titles.length) throw Object.assign(new Error('Seed people need a title (e.g. "VP Sales")'), { statusCode: 400 });
  const limit = Math.min(opts.limit ?? 50, 500);
  const targets = (opts.companies ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 50);
  const targetDomains = targets.map((t) => (t.includes('.') ? toDomain(t) : '')).filter(Boolean);
  let raw: Record<string, unknown>[] = [];
  const used: string[] = [];
  if (ctx.settings.has('APOLLO_API_KEY')) {
    try {
      raw = await apolloPeopleSearch(ctx.settings, { titles: profile.titles.join(','), domains: targetDomains.join(',') || undefined, locations: opts.location, limit: limit * 2 });
      raw.forEach((r) => (r.Source = 'Apollo'));
      used.push('Apollo');
    } catch (e: any) { ctx.log(`people lookalikes apollo: ${e.message}`); }
  }
  if (!raw.length && ctx.settings.has('PDL_API_KEY')) {
    try { raw = await pdlPeopleSearch(profile, targetDomains, ctx, limit * 2); used.push('People Data Labs'); } catch (e: any) { ctx.log(`people lookalikes pdl: ${e.message}`); }
  }
  if (!raw.length) {
    // Free: public LinkedIn profiles through the configured web search (Serper/Brave/…/DuckDuckGo).
    const companies = targets.length ? targets : [''];
    const queries: { q: string; company: string; domain: string }[] = [];
    for (const c of companies) for (const t of profile.titles.slice(0, 3)) {
      const domain = c.includes('.') ? toDomain(c) : '';
      const company = domain ? domain.split('.')[0] : c;
      queries.push({ q: `site:linkedin.com/in "${t}"${company ? ` "${company}"` : ''}${opts.location ? ` "${opts.location}"` : ''}`, company, domain });
    }
    for (const { q, company, domain } of queries.slice(0, opts.maxQueries ?? 12)) {
      const r = await webSearch(q, ctx, 10).catch((e) => { ctx.log(`people lookalikes search: ${e.message}`); return null; });
      if (!r) continue;
      if (!used.includes(`web search (${r.engine})`)) used.push(`web search (${r.engine})`);
      for (const hit of r.results) {
        const li = normLinkedin(hit.url);
        if (!li.startsWith('linkedin.com/in/')) continue;
        const parsed = parseLinkedinResult(hit.title, hit.snippet);
        raw.push({ 'Full name': parsed.name, Title: parsed.title, Company: parsed.company || company, 'Company domain': domain, 'LinkedIn URL': `https://www.${li}`, Location: '', Source: 'LinkedIn via web search' });
      }
      if (raw.length >= limit * 2) break;
    }
  }
  const seen = new Set<string>();
  const minScore = opts.minScore ?? 25;
  const rows = raw.map((r): Record<string, unknown> => {
    const s = scorePerson(profile, String(r.Title ?? ''));
    return { ...r, Similarity: s.score, 'Similarity reason': s.reason };
  }).filter((r) => {
    const key = normLinkedin(r['LinkedIn URL']) || `${String(r['Full name']).toLowerCase()}|${String(r.Company).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (r.Similarity as number) >= minScore;
  }).sort((a, b) => (b.Similarity as number) - (a.Similarity as number)).slice(0, limit);
  return { profile, rows, sources: used };
}
