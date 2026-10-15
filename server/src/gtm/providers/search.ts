import { getJson, request } from '../lib/http.ts';
import { decode } from '../lib/html.ts';
import type { Ctx } from './types.ts';

export interface SearchResult { title: string; url: string; snippet: string }

type Engine = 'searxng' | 'serper' | 'brave' | 'tavily' | 'exa' | 'duckduckgo';
const ENGINES: Engine[] = ['searxng', 'serper', 'brave', 'tavily', 'exa', 'duckduckgo'];

/**
 * Web search for the research agent and search-based lookups. Tries the
 * configured engines in order — your own SearXNG first (free, unlimited), then
 * Serper → Brave → Tavily → Exa — moving on when one fails or finds nothing,
 * and ends with DuckDuckGo's HTML endpoint (free but rate-limited, best-effort).
 * SEARCH_ENGINE puts one engine first; the others stay as fallbacks.
 */
export async function webSearch(query: string, ctx: Ctx, count = 8, opts: { emptyIsAnswer?: boolean } = {}): Promise<{ engine: string; results: SearchResult[] }> {
  const s = ctx.settings;
  const configured: Record<Engine, boolean> = {
    searxng: s.has('SEARXNG_URL'), serper: s.has('SERPER_API_KEY'), brave: s.has('BRAVE_API_KEY'),
    tavily: s.has('TAVILY_API_KEY'), exa: s.has('EXA_API_KEY'), duckduckgo: true,
  };
  const preferred = (s.get('SEARCH_ENGINE') ?? '').trim().toLowerCase() as Engine;
  const order = ENGINES.includes(preferred) ? [preferred, ...ENGINES.filter((e) => e !== preferred)] : ENGINES;
  const engines = order.filter((e) => configured[e]);
  let lastError: unknown = null;
  for (const engine of engines) {
    try {
      const results = await throttled(engine, () => searchWith(engine, query, ctx, count));
      // Exact-phrase lookups are often legitimately empty; those callers don't pay for a second engine.
      if (results.length || opts.emptyIsAnswer || engine === engines.at(-1)) return { engine, results };
    } catch (e) {
      lastError = e;
      ctx.log?.(`search: ${engine} failed (${(e as Error).message}); trying the next engine`);
    }
  }
  throw lastError ?? new Error('No search engine returned results');
}

async function searchWith(engine: Engine, query: string, ctx: Ctx, count: number): Promise<SearchResult[]> {
  const s = ctx.settings;
  switch (engine) {
    case 'searxng': {
      // SearXNG needs `json` enabled under search.formats in its settings.yml. Several
      // instances (comma-separated) are tried in order: one on a home connection is
      // rarely blocked, one on a datacenter IP often is.
      const urls = s.get('SEARXNG_URL')!.split(/[\s,]+/).filter(Boolean);
      let lastError: Error | null = null;
      for (const url of urls) {
        try {
          const d = await getJson(`${url.replace(/\/$/, '')}/search`, { query: { q: query, format: 'json', language: 'en' }, headers: { accept: 'application/json' }, timeoutMs: 20_000 });
          // No results because every upstream engine is rate-limited/CAPTCHA'd isn't "nothing found": let the next one answer.
          if (!d.results?.length && d.unresponsive_engines?.length) {
            throw new Error(`SearXNG engines unavailable (${d.unresponsive_engines.map((e: any) => `${e[0]}: ${e[1]}`).join(', ')})`);
          }
          const results = relevant(query, (d.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url, snippet: r.content ?? '' })));
          if (results.length || url === urls.at(-1)) return results.slice(0, count);
        } catch (e) {
          lastError = e as Error;
        }
      }
      throw lastError ?? new Error('SearXNG returned nothing');
    }
    case 'serper': {
      const d = await getJson('https://google.serper.dev/search', { headers: { 'X-API-KEY': s.get('SERPER_API_KEY')! }, json: { q: query, num: count } });
      return (d.organic ?? []).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }));
    }
    case 'brave': {
      const d = await getJson('https://api.search.brave.com/res/v1/web/search', { headers: { 'X-Subscription-Token': s.get('BRAVE_API_KEY')!, accept: 'application/json' }, query: { q: query, count } });
      return (d.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? '') }));
    }
    case 'tavily': {
      const d = await getJson('https://api.tavily.com/search', { headers: { authorization: `Bearer ${s.get('TAVILY_API_KEY')}` }, json: { query, max_results: count } });
      return (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
    }
    case 'exa': {
      const d = await getJson('https://api.exa.ai/search', { headers: { 'x-api-key': s.get('EXA_API_KEY')! }, json: { query, numResults: count, contents: { highlights: true } } });
      return (d.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url, snippet: (r.highlights ?? []).join(' … ') }));
    }
    case 'duckduckgo':
      return duckduckgo(query, count).catch(async (e) => {
        await sleep(4000); // one polite retry: DDG rate-limits bursts
        return duckduckgo(query, count).catch(() => { throw e; });
      });
  }
}

// Free engines block bursts (SearXNG's upstreams start CAPTCHAs, Brave's free plan allows 1 query/s,
// DuckDuckGo rate-limits), so each engine's queries run one at a time with a gap between them.
/**
 * Drops results that share no word with the query: a blocked upstream engine can
 * answer with unrelated pages (spam, other languages) instead of an error.
 */
export function relevant(query: string, results: SearchResult[]): SearchResult[] {
  const words = query.toLowerCase().replace(/\b(site|inurl|intitle):\S+/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (!words.length) return results;
  return results.filter((r) => { const hay = `${r.title} ${r.url} ${r.snippet}`.toLowerCase(); return words.some((w) => hay.includes(w)); });
}

const GAP_MS: Partial<Record<Engine, number>> = { searxng: 1000, brave: 1100, duckduckgo: 1500 };
const chains = new Map<Engine, Promise<unknown>>();
function throttled<T>(engine: Engine, fn: () => Promise<T>): Promise<T> {
  const gap = GAP_MS[engine] ?? 0;
  const prev = chains.get(engine) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(engine, next.then(() => sleep(gap), () => sleep(gap)));
  return next;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function duckduckgo(query: string, count: number): Promise<SearchResult[]> {
  const res = await request('https://html.duckduckgo.com/html/', {
    method: 'POST',
    body: new URLSearchParams({ q: query }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' },
  });
  const html = await res.text();
  if (!res.ok || /anomaly|captcha/i.test(html.slice(0, 5000)) && !html.includes('result__a')) {
    throw new Error('DuckDuckGo blocked the request; add a Serper or Brave key on the Integrations page for reliable search');
  }
  const out: SearchResult[] = [];
  const blocks = html.split(/<div class="result[ _]/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snippet = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    out.push({ title: stripTags(a[2]), url, snippet: stripTags(snippet) });
    if (out.length >= count) break;
  }
  return out;
}

function stripTags(s: string) {
  return decode(s.replace(/<[^>]+>/g, '')).trim();
}
