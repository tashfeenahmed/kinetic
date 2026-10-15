import { describe, it, expect, vi, afterEach } from 'vitest';
import { webSearch } from '../src/gtm/providers/search.ts';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { gtmTestSetup } from './gtm-helpers.ts';

gtmTestSetup();

afterEach(() => vi.unstubAllGlobals());

const searx = { results: [{ title: 'Acme', url: 'https://acme.com', content: 'Acme Inc' }] };
const serper = { organic: [{ title: 'Acme (serper)', link: 'https://acme.com', snippet: 'x' }] };

function setup(keys: Record<string, string>) {
  const settings = new Settings(new Db(':memory:'));
  for (const [k, v] of Object.entries(keys)) settings.set(k as any, v);
  const hits: string[] = [];
  return { ctx: { settings, log: () => {} }, hits };
}

describe('web search engine order', () => {
  it('uses SearXNG before paid APIs', async () => {
    const { ctx, hits } = setup({ SEARXNG_URL: 'http://127.0.0.1:8888/', SERPER_API_KEY: 'k' });
    vi.stubGlobal('fetch', async (url: URL | string) => { const u = String(url); hits.push(u); return u.includes('8888') ? Response.json(searx) : Response.json(serper); });
    const r = await webSearch('acme', ctx);
    expect(r.engine).toBe('searxng');
    expect(r.results[0]!.url).toBe('https://acme.com');
    expect(hits.some((h) => h.includes('serper'))).toBe(false);
  });

  it('falls through when SearXNG errors or finds nothing', async () => {
    const { ctx } = setup({ SEARXNG_URL: 'http://127.0.0.1:8888', SERPER_API_KEY: 'k' });
    vi.stubGlobal('fetch', async (url: URL | string) => String(url).includes('8888') ? new Response('down', { status: 502 }) : Response.json(serper));
    expect((await webSearch('acme', ctx)).engine).toBe('serper');
    vi.stubGlobal('fetch', async (url: URL | string) => String(url).includes('8888') ? Response.json({ results: [] }) : Response.json(serper));
    expect((await webSearch('acme', ctx)).engine).toBe('serper');
  });

  it('treats SearXNG with every engine blocked as a failure, even for exact-phrase lookups', async () => {
    const { ctx } = setup({ SEARXNG_URL: 'http://127.0.0.1:8888', BRAVE_API_KEY: 'k' });
    vi.stubGlobal('fetch', async (url: URL | string) => String(url).includes('8888')
      ? Response.json({ results: [], unresponsive_engines: [['brave', 'too many requests'], ['startpage', 'CAPTCHA']] })
      : Response.json({ web: { results: [{ title: 'Acme', url: 'https://acme.com', description: 'x' }] } }));
    const r = await webSearch('"Dana Whitfield" "@acme.ie"', ctx, 8, { emptyIsAnswer: true });
    expect(r.engine).toBe('brave');
  });

  it('honours SEARCH_ENGINE', async () => {
    const { ctx } = setup({ SEARXNG_URL: 'http://127.0.0.1:8888', SERPER_API_KEY: 'k', SEARCH_ENGINE: 'serper' });
    vi.stubGlobal('fetch', async (url: URL | string) => String(url).includes('8888') ? Response.json(searx) : Response.json(serper));
    expect((await webSearch('acme', ctx)).engine).toBe('serper');
  });
});

describe('several SearXNG instances', () => {
  it('tries them in order and skips one that answers with unrelated pages', async () => {
    const { ctx, hits } = setup({ SEARXNG_URL: 'http://home:8891, http://box:8890' });
    const junk = { results: [{ title: 'Remove a drive in Windows', url: 'https://tenforums.com/x', content: 'tutorial' }] };
    vi.stubGlobal('fetch', async (url: URL | string) => { const u = String(url); hits.push(u); return u.includes('home') ? Response.json(junk) : Response.json(searx); });
    const r = await webSearch('acme ltd', ctx);
    expect(r).toMatchObject({ engine: 'searxng', results: [{ url: 'https://acme.com' }] });
    expect(hits.map((h) => new URL(h).host)).toEqual(['home:8891', 'box:8890']);
  });

  it('moves on when the first instance is down', async () => {
    const { ctx } = setup({ SEARXNG_URL: 'http://home:8891,http://box:8890' });
    vi.stubGlobal('fetch', async (url: URL | string) => String(url).includes('home') ? new Response('bad gateway', { status: 502 }) : Response.json(searx));
    expect((await webSearch('acme', ctx)).results[0]!.url).toBe('https://acme.com');
  });
});
