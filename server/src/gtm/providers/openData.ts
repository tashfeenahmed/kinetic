/** Free, open company datasets: Wikidata and the YC company directory (yc-oss). */
import { getJson, HttpError } from '../lib/http.ts';
import { toDomain } from '../lib/sandbox.ts';
import type { Ctx, EnrichInput, Hit } from './types.ts';

const UA = { 'user-agent': 'kineticsand/0.1 (personal research tool)', accept: 'application/sparql-results+json' };

// ---------- Wikidata ----------
const FIELDS = `
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P1128 ?employees }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P452 ?industry }
  OPTIONAL { ?item wdt:P159 ?hq }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item wdt:P4264 ?linkedin }
  OPTIONAL { ?item wdt:P2088 ?crunchbase }
  OPTIONAL { ?item wdt:P249 ?ticker }
  OPTIONAL { ?item wdt:P2002 ?twitter }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }`;
const SELECT = 'SELECT ?item ?itemLabel ?itemDescription ?website ?employees ?inception ?industryLabel ?hqLabel ?countryLabel ?linkedin ?crunchbase ?ticker ?twitter';

async function sparql(query: string): Promise<any[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const d = await getJson('https://query.wikidata.org/sparql', { headers: UA, query: { query }, timeoutMs: 30_000 });
      return d?.results?.bindings ?? [];
    } catch (e) {
      // The public endpoint 502s/429s under load; retry with backoff.
      if (attempt < 2 && e instanceof HttpError && (e.status >= 500 || e.status === 429)) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      throw e;
    }
  }
}

function shape(rows: any[]) {
  if (!rows.length) return null;
  const v = (r: any, k: string) => r[k]?.value;
  const uniq = (k: string) => [...new Set(rows.map((r) => v(r, k)).filter(Boolean))];
  const r = rows[0];
  const employees = uniq('employees').map(Number).sort((a, b) => b - a)[0];
  return {
    name: v(r, 'itemLabel'), description: v(r, 'itemDescription'), wikidata: v(r, 'item'),
    domain: toDomain(v(r, 'website')), employees, founded: v(r, 'inception')?.slice(0, 4),
    industry: uniq('industryLabel').join(', ') || undefined, hq: uniq('hqLabel')[0], country: uniq('countryLabel')[0],
    linkedin: v(r, 'linkedin') ? `https://www.linkedin.com/company/${v(r, 'linkedin')}` : undefined,
    crunchbase: v(r, 'crunchbase') ? `https://www.crunchbase.com/organization/${v(r, 'crunchbase')}` : undefined,
    twitter: v(r, 'twitter') ? `https://x.com/${v(r, 'twitter')}` : undefined, ticker: uniq('ticker').join(', ') || undefined,
  };
}

export async function wikidataCompany(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  let rows: any[] = [];
  if (domain) {
    const sites = ['https://', 'http://'].flatMap((p) => ['', 'www.'].flatMap((w) => ['', '/'].map((s) => `<${p}${w}${domain}${s}>`)));
    rows = await sparql(`${SELECT} WHERE { VALUES ?site { ${sites.join(' ')} } ?item wdt:P856 ?site . ${FIELDS} } LIMIT 50`);
  }
  if (!rows.length && input.companyName) {
    // Name search, then keep only organisations (instance of a subclass of organization).
    const s = await getJson('https://www.wikidata.org/w/api.php', { headers: UA, query: { action: 'wbsearchentities', search: input.companyName, language: 'en', type: 'item', limit: 12, format: 'json' } });
    const ids = (s.search ?? []).map((x: any) => `wd:${x.id}`).join(' ');
    // Prefer the best-known organisation that has a website (sitelinks ≈ notability).
    if (ids) rows = await sparql(`${SELECT} ?links WHERE { VALUES ?item { ${ids} } ?item wdt:P31/wdt:P279* wd:Q43229 ; wdt:P856 [] ; wikibase:sitelinks ?links . ${FIELDS} } ORDER BY DESC(?links) LIMIT 50`);
    if (rows.length) rows = rows.filter((r) => r.item.value === rows[0].item.value);
  }
  const data = shape(rows);
  ctx.log(`wikidata ${domain || input.companyName}: ${data ? data.name : 'no match'}`);
  return data ? { value: data.name, data } : null;
}

export async function wikidataDomain(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const h = await wikidataCompany({ companyName: input.companyName }, ctx);
  return h?.data?.domain ? { value: h.data.domain, confidence: 'wikidata', data: h.data } : null;
}

export async function wikidataLinkedin(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const h = await wikidataCompany(input, ctx);
  return h?.data?.linkedin ? { value: h.data.linkedin, confidence: 'wikidata', data: h.data } : null;
}

// ---------- YC company directory (github.com/yc-oss/api) ----------
let yc: { at: number; rows: any[]; byDomain: Map<string, any> } | null = null;

export async function ycCompanies(): Promise<any[]> {
  if (!yc || Date.now() - yc.at > 86_400_000) {
    const rows = await getJson<any[]>('https://yc-oss.github.io/api/companies/all.json', { timeoutMs: 60_000 });
    yc = { at: Date.now(), rows, byDomain: new Map(rows.filter((r) => r.website).map((r) => [toDomain(r.website), r])) };
  }
  return yc.rows;
}

function ycShape(c: any) {
  return {
    name: c.name, domain: toDomain(c.website), description: c.one_liner, longDescription: c.long_description, employees: c.team_size,
    industry: c.industries?.join(' → ') ?? c.industry, batch: c.batch, status: c.status, stage: c.stage, hiring: c.isHiring,
    location: c.all_locations, regions: c.regions, tags: c.tags, yc: `https://www.ycombinator.com/companies/${c.slug}`,
  };
}

export async function ycCompany(input: EnrichInput): Promise<Hit | null> {
  await ycCompanies();
  const domain = toDomain(input.domain);
  let c = domain ? yc!.byDomain.get(domain) : undefined;
  if (!c && input.companyName) {
    const n = input.companyName.trim().toLowerCase();
    c = yc!.rows.find((r) => r.name?.toLowerCase() === n);
  }
  return c ? { value: c.name, confidence: 'YC directory', data: ycShape(c) } : null;
}

/** Source: YC companies filtered by tag/industry, batch, region, hiring, status. */
export async function ycSearch(q: { query?: string; batch?: string; region?: string; hiring?: string; status?: string; limit: number }): Promise<Record<string, unknown>[]> {
  const rows = await ycCompanies();
  const has = (v: unknown, needle?: string) => !needle || String(Array.isArray(v) ? v.join(' ') : v ?? '').toLowerCase().includes(needle.toLowerCase());
  const words = (q.query ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  return rows
    .filter((c) => !words.length || words.some((w) => has([c.name, c.one_liner, c.industry, c.subindustry, ...(c.tags ?? [])].join(' '), w)))
    .filter((c) => has(c.batch, q.batch) && has([c.all_locations, ...(c.regions ?? [])].join(' '), q.region) && has(c.status, q.status || undefined))
    .filter((c) => !q.hiring || (q.hiring === 'yes' ? c.isHiring : !c.isHiring))
    .slice(0, q.limit)
    .map((c) => ({ Company: c.name, 'Company domain': toDomain(c.website), Description: c.one_liner, Industry: c.subindustry ?? c.industry, Batch: c.batch, 'Team size': c.team_size, Location: c.all_locations, Hiring: c.isHiring ? 'yes' : 'no', 'YC page': `https://www.ycombinator.com/companies/${c.slug}` }));
}

// ---------- People at a company: public GitHub org members (free) ----------
export async function githubPeople(token: string | undefined, q: { org?: string; domain?: string; limit: number }): Promise<Record<string, unknown>[]> {
  const org = (q.org || toDomain(q.domain ?? '').split('.')[0]).trim();
  if (!org) throw new Error('Give a GitHub org (e.g. vercel) or a company domain');
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const members: any[] = [];
  for (let page = 1; members.length < q.limit && page <= 10; page++) {
    const batch = await getJson<any[]>(`https://api.github.com/orgs/${org}/public_members`, { headers, query: { per_page: 100, page } }).catch((e) => {
      if (e instanceof HttpError && e.status === 403) throw new Error('GitHub rate limit reached (60/hour without a token) — add a free GITHUB_TOKEN in Settings');
      if (e instanceof HttpError && e.status === 404) throw new Error(`No GitHub org "${org}"`);
      throw e;
    });
    members.push(...batch);
    if (batch.length < 100) break;
  }
  // Profile lookups cost one request each (60/hour without a token).
  const out: Record<string, unknown>[] = [];
  for (const m of members.slice(0, q.limit)) {
    const u = await getJson(`https://api.github.com/users/${m.login}`, { headers }).catch(() => null);
    if (!u) continue;
    out.push({ 'Full name': u.name ?? '', 'GitHub': u.html_url, Company: u.company ?? org, 'Company domain': q.domain ?? '', Email: u.email ?? '', Website: u.blog ?? '', 'X / Twitter': u.twitter_username ? `https://x.com/${u.twitter_username}` : '', Location: u.location ?? '', Bio: u.bio ?? '' });
  }
  return out;
}
