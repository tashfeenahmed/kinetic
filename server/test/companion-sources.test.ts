import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { setHttpFetch } from '../src/gtm/lib/http.ts';
import { runServerTask, REDDIT_UA } from '../src/companion/sources.ts';
import { gtmTestSetup } from './gtm-helpers.ts';

gtmTestSetup();
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'companion');
const reddit = JSON.parse(readFileSync(join(DIR, 'reddit.json'), 'utf8'));
const github = JSON.parse(readFileSync(join(DIR, 'github.json'), 'utf8'));

interface Call { url: URL; headers: Record<string, string> }
function mockFetch(route: (u: URL) => unknown | Response): Call[] {
  const calls: Call[] = [];
  setHttpFetch((async (input: any, init: any) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init?.headers ?? {} });
    const out = route(url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return calls;
}

afterEach(() => setHttpFetch((...a) => globalThis.fetch(...a)));

const settings = () => new Settings(new Db(':memory:'));

describe('Reddit (server-side, public JSON)', () => {
  it('pages a subreddit with the after cursor, respects budget and sends a User-Agent', async () => {
    const calls = mockFetch((u) => (u.searchParams.get('after') === 't3_bbb222' ? reddit.listing_page2 : reddit.listing_page1));
    const s = settings();
    const p1 = await runServerTask({ phantom: 'reddit.subreddit_posts', params: { subreddit: 'r/sales', sort: 'top', time: 'month' }, target: {}, cursor: null, budget: 50, settings: s });
    expect(p1.records).toHaveLength(2);
    expect(p1.nextCursor).toBe('t3_bbb222');
    expect(calls[0].url.pathname).toBe('/r/sales/top.json');
    expect(calls[0].url.searchParams.get('t')).toBe('month');
    expect(calls[0].url.searchParams.get('limit')).toBe('50');
    expect(calls[0].headers['user-agent']).toBe(REDDIT_UA);

    const p2 = await runServerTask({ phantom: 'reddit.subreddit_posts', params: { subreddit: 'sales' }, target: {}, cursor: p1.nextCursor, budget: 50, settings: s });
    expect(calls[1].url.searchParams.get('after')).toBe('t3_bbb222');
    expect(calls[1].url.pathname).toBe('/r/sales/new.json');
    expect(p2.records).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();

    const small = await runServerTask({ phantom: 'reddit.subreddit_posts', params: { subreddit: 'sales' }, target: {}, cursor: null, budget: 1, settings: s });
    expect(small.records).toHaveLength(1);
    expect(calls[2].url.searchParams.get('limit')).toBe('1');
  });

  it('search within a subreddit', async () => {
    const calls = mockFetch(() => reddit.listing_page2);
    const r = await runServerTask({ phantom: 'reddit.search', params: { query: 'crm', subreddit: 'sales', sort: 'relevance' }, target: {}, cursor: null, budget: 10, settings: settings() });
    expect(r.records).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/r/sales/search.json');
    expect(calls[0].url.searchParams.get('q')).toBe('crm');
    expect(calls[0].url.searchParams.get('restrict_sr')).toBe('1');
  });

  it('post commenters and user activity', async () => {
    const calls = mockFetch((u) => (u.pathname.startsWith('/comments/') ? reddit.comments : u.pathname.endsWith('/about.json') ? reddit.about : reddit.overview));
    const c = await runServerTask({ phantom: 'reddit.post_commenters', params: {}, target: { url: 'https://www.reddit.com/r/sales/comments/aaa111/which_crm/' }, cursor: null, budget: 100, settings: settings() });
    expect(calls[0].url.pathname).toBe('/comments/aaa111.json');
    expect(c.records.map((x) => x.author)).toEqual(['mock_seller', 'fake_redditor']);
    expect(c.nextCursor).toBeNull();
    const u = await runServerTask({ phantom: 'reddit.user_activity', params: {}, target: { url: 'https://www.reddit.com/user/fake_redditor/' }, cursor: null, budget: 1, settings: settings() });
    expect(calls[1].url.pathname).toBe('/user/fake_redditor/about.json');
    expect(u.records[0]).toMatchObject({ username: 'fake_redditor', commentKarma: 3400 });
  });

  it('turns a 429 into a readable error', async () => {
    mockFetch(() => new Response('too many', { status: 429 }));
    await expect(runServerTask({ phantom: 'reddit.search', params: { query: 'x' }, target: {}, cursor: null, budget: 5, settings: settings() })).rejects.toThrow(/rate limit/);
  });
});

describe('GitHub (server-side)', () => {
  it('stargazers merged with profiles, offset cursor never skips people', async () => {
    const calls = mockFetch((u) => {
      if (u.pathname.endsWith('/stargazers')) return github.stargazers;
      const login = decodeURIComponent(u.pathname.split('/').pop()!);
      return github.users[login] ?? new Response('{}', { status: 404 });
    });
    const s = settings();
    s.set('GITHUB_TOKEN', 'ghp_test');
    const p1 = await runServerTask({ phantom: 'github.stargazers', params: { repo: 'https://github.com/acme/widgets' }, target: {}, cursor: null, budget: 1, settings: s });
    expect(calls[0].url.pathname).toBe('/repos/acme/widgets/stargazers');
    expect(calls[0].headers.accept).toBe('application/vnd.github.star+json');
    expect(calls[0].headers.authorization).toBe('Bearer ghp_test');
    expect(p1.records).toEqual([expect.objectContaining({ login: 'fakedev', name: 'Fake Developer', email: 'fake@dev.example', starredAt: '2024-06-01T10:00:00Z' })]);
    expect(p1.nextCursor).toBe(1);
    const p2 = await runServerTask({ phantom: 'github.stargazers', params: { repo: 'acme/widgets' }, target: {}, cursor: p1.nextCursor, budget: 10, settings: s });
    expect(p2.records.map((r) => r.login)).toEqual(['mock-coder']); // the bot is dropped
    expect(p2.nextCursor).toBeNull();
  });

  it('contributors with contribution counts', async () => {
    mockFetch((u) => (u.pathname.endsWith('/contributors') ? github.contributors : github.users[u.pathname.split('/').pop()!]));
    const r = await runServerTask({ phantom: 'github.contributors', params: { repo: 'acme/widgets' }, target: {}, cursor: null, budget: 100, settings: settings() });
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ login: 'fakedev', contributions: 120, location: 'Berlin' });
  });

  it('rejects a bad repo', async () => {
    await expect(runServerTask({ phantom: 'github.contributors', params: { repo: 'nope' }, target: {}, cursor: null, budget: 5, settings: settings() })).rejects.toThrow(/owner\/repo/);
  });
});
