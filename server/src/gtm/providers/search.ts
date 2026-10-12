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
export async function webSearch(query: string, ctx: Ctx, count = 8): Promise<{ engine: string; results: SearchResult[] }> {
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
      const results = await searchWith(engine, query, ctx, count);
      if (results.length || engine === engines.at(-1)) return { engine, results };
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
      // SearXNG needs `json` enabled under search.formats in its settings.yml.
      const d = await getJson(`${s.get('SEARXNG_URL')!.replace(/\/$/, '')}/search`, { query: { q: query, format: 'json', language: 'en' }, headers: { accept: 'application/json' } });
      return (d.results ?? []).slice(0, count).map((r: any) => ({ title: r.title ?? '', url: r.url, snippet: r.content ?? '' }));
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
      return throttled(() => duckduckgo(query, count).catch(async (e) => {
        await sleep(4000); // one polite retry: DDG rate-limits bursts
        return duckduckgo(query, count).catch(() => { throw e; });
      }));
  }
}

// DuckDuckGo blocks bursts, so free searches run one at a time, ~1.5s apart.
let ddgChain: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = ddgChain.then(fn, fn);
  ddgChain = next.then(() => sleep(1500), () => sleep(1500));
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
