/**
 * Free email finding (the Hunter approach, done locally):
 *  1. collect real addresses on the domain from the company website, PGP
 *     keyservers and public GitHub commit metadata of the company's org,
 *  2. return a direct hit if the person's own address shows up,
 *  3. otherwise infer the company's pattern (first.last, flast, …) from
 *     name+email samples and test candidates with SMTP verification.
 */
import { getJson, HttpError } from '../lib/http.ts';
import { fetchPage } from '../lib/html.ts';
import { toDomain } from '../lib/sandbox.ts';
import { smtpOptions, smtpVerify } from '../lib/smtp.ts';
import { nameParts, type Ctx, type EnrichInput, type Hit } from './types.ts';

interface Sample { email: string; name?: string; source: string }

const PATTERNS: Record<string, (f: string, l: string) => string> = {
  'first.last': (f, l) => `${f}.${l}`,
  first: (f) => f,
  flast: (f, l) => `${f[0]}${l}`,
  firstlast: (f, l) => `${f}${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  first_last: (f, l) => `${f}_${l}`,
  firstl: (f, l) => `${f}${l[0]}`,
  'last.first': (f, l) => `${l}.${f}`,
  last: (_f, l) => l,
  'first-last': (f, l) => `${f}-${l}`,
};
const DEFAULT_ORDER = ['first.last', 'first', 'flast', 'firstlast', 'f.last', 'first_last', 'firstl'];
const GENERIC = /^(info|hello|hi|contact|support|help|sales|team|press|media|jobs|careers|privacy|legal|security|admin|billing|noreply|no-reply|abuse|marketing|partners|investors|ir|office|mail|webmaster|feedback|dpo|gdpr|compliance)$/;

const cache = new Map<string, { at: number; samples: Sample[] }>();

export async function domainSamples(domain: string, ctx: Ctx): Promise<Sample[]> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.samples;
  const samples: Sample[] = [];
  const add = (email: string, source: string, name?: string) => {
    email = email.toLowerCase();
    if (email.endsWith(`@${domain}`) && !samples.some((s) => s.email === email && (s.name || !name))) samples.push({ email, name, source });
  };

  // Website pages that commonly list people/contacts.
  const re = new RegExp(`[a-z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'gi');
  await Promise.all(['', '/about', '/team', '/contact', '/company', '/imprint', '/impressum', '/press', '/legal'].map(async (path) => {
    const page = await fetchPage(`https://${domain}${path}`, 10_000).catch(() => null);
    if (page && page.status < 400) for (const m of page.html.matchAll(re)) add(m[0], `website${path || '/'}`);
  }));

  // PGP keyserver: uid lines are "Name <email>" — often dozens of real addresses for a domain.
  try {
    const res = await fetch(`https://keyserver.ubuntu.com/pks/lookup?search=${encodeURIComponent(domain)}&op=index&options=mr`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      for (const line of (await res.text()).split('\n')) {
        const m = decodeURIComponent(line).match(/^uid:([^<:]*)<([^>]+)>/);
        if (m) add(m[2], 'pgp keyserver', m[1].trim() || undefined);
      }
    }
  } catch { /* keyserver is best-effort */ }

  // GitHub: commit authors in the org's most recently pushed repos.
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (ctx.settings.has('GITHUB_TOKEN')) headers.authorization = `Bearer ${ctx.settings.get('GITHUB_TOKEN')}`;
  const org = domain.split('.')[0];
  try {
    const repos = await getJson<any[]>(`https://api.github.com/users/${org}/repos`, { headers, query: { sort: 'pushed', per_page: 4 } });
    const ownerSite = toDomain(repos[0]?.owner?.html_url ? (await getJson(`https://api.github.com/users/${org}`, { headers })).blog ?? '' : '');
    // Only trust the org if its profile website is this domain (or it has commits from this domain).
    for (const repo of repos.filter((r) => !r.fork).slice(0, 3)) {
      const commits = await getJson<any[]>(`https://api.github.com/repos/${repo.full_name}/commits`, { headers, query: { per_page: 100 } }).catch(() => []);
      for (const c of commits) {
        for (const who of [c.commit?.author, c.commit?.committer]) if (who?.email) add(who.email, `github:${repo.name}`, who.name);
      }
    }
    if (ownerSite && ownerSite !== domain) ctx.log(`GitHub org "${org}" lists ${ownerSite}; samples filtered to @${domain}`);
  } catch (e) {
    if (!(e instanceof HttpError && (e.status === 404 || e.status === 403))) throw e;
  }
  ctx.log(`free finder ${domain}: ${samples.length} sample addresses`);
  cache.set(domain, { at: Date.now(), samples });
  return samples;
}

/** Which pattern explains the most name+email samples. */
export function inferPattern(samples: Sample[]): { pattern: string; support: number } | null {
  const votes = new Map<string, number>();
  for (const s of samples) {
    if (!s.name) continue;
    const parts = s.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).map((p) => p.replace(/[^a-z]/g, '')).filter(Boolean);
    if (parts.length < 2) continue;
    const f = parts[0], l = parts[parts.length - 1];
    const local = s.email.split('@')[0];
    for (const [name, fn] of Object.entries(PATTERNS)) if (fn(f, l) === local) votes.set(name, (votes.get(name) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { pattern: best[0], support: best[1] } : null;
}

export async function freeEmailFinder(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  const { first, last, full } = nameParts(input);
  if (!domain || !first) return null;
  const f = slug(first), l = slug(last);
  const samples = await domainSamples(domain, ctx);

  // 1. The person's own address already public?
  const own = samples.find((s) => s.name && slug(s.name) === slug(full));
  if (own) return { value: own.email, confidence: `public (${own.source})`, data: { source: own.source, samples: samples.length } };

  // 2. Candidates: inferred pattern first.
  const inferred = inferPattern(samples);
  const order = l ? [...new Set([...(inferred ? [inferred.pattern] : []), ...DEFAULT_ORDER])] : ['first'];
  const candidates = order.map((p) => `${PATTERNS[p](f, l || f)}@${domain}`);
  const data = { pattern: inferred?.pattern ?? null, patternSupport: inferred?.support ?? 0, samples: samples.filter((s) => !GENERIC.test(s.email.split('@')[0])).slice(0, 10), candidates };

  // 3. SMTP check, up to 4 candidates.
  const checks: { email: string; verdict: string }[] = [];
  for (const email of candidates.slice(0, 4)) {
    const r = await smtpVerify(email, smtpOptions(ctx.settings));
    checks.push({ email, verdict: r.verdict });
    if (r.verdict === 'valid') return { value: email, confidence: 'verified (SMTP)', data: { ...data, checks, mailProvider: r.mailProvider } };
    if (r.verdict === 'catch_all' || r.verdict === 'unknown') {
      // Server won't tell us. Keep the best guess but let the waterfall try for something better.
      const conf = inferred ? `${r.verdict === 'catch_all' ? 'catch-all' : 'unverifiable'} · pattern ${inferred.pattern} from ${inferred.support} sample(s)` : `${r.verdict === 'catch_all' ? 'catch-all' : 'unverifiable'} · common pattern guess`;
      return { value: candidates[0], confidence: conf, weak: true, data: { ...data, checks, mailProvider: r.mailProvider } };
    }
  }
  return null; // every candidate rejected
}

function slug(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
