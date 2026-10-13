import { afterEach, describe, expect, it } from 'vitest';
import { setHttpFetch } from '../src/gtm/lib/http.ts';
import { hackerNewsSearch, parseHiringPost } from '../src/sourcing/hackerNews.ts';
import { dedupeKey } from '../src/sourcing/normalize.ts';
import { makeEnv } from './helpers.ts';

const SHOW = [
  { objectID: '101', title: 'Show HN: Acme – open-source CRM for small teams', url: 'https://www.acme.dev/', author: 'jane', points: 120, num_comments: 40, created_at: '2026-10-01T10:00:00Z' },
  { objectID: '102', title: 'Show HN: tinycrm (GitHub)', url: 'https://github.com/x/tinycrm', author: 'bob', points: 5, num_comments: 1, created_at: '2026-10-02T10:00:00Z' },
];
const LAUNCH = [
  { objectID: '201', title: 'Launch HN: Ledgerly (YC W26) – CRM for accountants', url: 'https://ledgerly.com', author: 'founder', points: 80, num_comments: 30, created_at: '2026-10-03T10:00:00Z' },
  { objectID: '202', title: 'Ask HN: Launch HN etiquette?', author: 'x', points: 2, created_at: '2026-10-03T10:00:00Z' },
];
const THREAD = { objectID: '900', title: 'Ask HN: Who is hiring? (October 2026)', author: 'whoishiring' };
const HIRING = [
  { objectID: '901', parent_id: 900, author: 'cto1', created_at: '2026-10-01T15:00:00Z', comment_text: 'Globex | Senior Backend Engineer, Product Designer | Remote (US) | <a href="https:&#x2F;&#x2F;globex.io&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;globex.io&#x2F;jobs</a><p>We build CRM pipelines for logistics.' },
  { objectID: '902', parent_id: 901, author: 'reply', created_at: '2026-10-01T16:00:00Z', comment_text: 'Is this open to EU?' },
];
const INTENT = [
  { objectID: '301', author: 'buyer', comment_text: 'We are looking for a CRM that works with Gmail, any ideas?', story_title: 'Ask HN: Best CRM in 2026?', created_at: '2026-10-05T10:00:00Z' },
  { objectID: '302', author: 'chatter', comment_text: 'Our CRM is fine I guess.', story_title: 'Something', created_at: '2026-10-05T11:00:00Z' },
  { objectID: '303', author: 'asker', title: 'Ask HN: Alternatives to Salesforce CRM?', story_text: 'Too expensive.', points: 30, created_at: '2026-10-06T10:00:00Z' },
];

function fake(calls: URL[]) {
  return (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u);
    const tags = u.searchParams.get('tags') ?? '';
    const q = u.searchParams.get('query') ?? '';
    let hits: any[] = [];
    if (tags === 'show_hn') hits = SHOW;
    else if (tags === 'story' && q.startsWith('Launch HN')) hits = LAUNCH;
    else if (tags === 'story,author_whoishiring') hits = [THREAD, { objectID: '899', title: 'Ask HN: Who wants to be hired? (October 2026)' }];
    else if (tags === 'comment,story_900') hits = HIRING;
    else if (tags === '(comment,ask_hn)') hits = INTENT;
    return Response.json({ hits, nbPages: 1 });
  }) as typeof fetch;
}

afterEach(() => setHttpFetch((...a) => globalThis.fetch(...a)));

describe('Hacker News lead source', () => {
  it('launches: Show HN and Launch HN posts with the company domain', async () => {
    const calls: URL[] = [];
    setHttpFetch(fake(calls));
    const rows = await hackerNewsSearch({ mode: 'launches', keywords: 'crm', days: 7 }, 50);
    expect(rows.map((r) => r.Company)).toEqual(['Acme', 'tinycrm', 'Ledgerly']);
    expect(rows[0]).toMatchObject({ 'Company domain': 'acme.dev', Kind: 'Show HN', Points: 120, 'HN URL': 'https://news.ycombinator.com/item?id=101', 'Author URL': 'https://news.ycombinator.com/user?id=jane' });
    expect(rows[1]['Company domain']).toBe(''); // a GitHub repo is not a company site
    expect(rows[2]).toMatchObject({ 'Company domain': 'ledgerly.com', Kind: 'Launch HN' });
    expect(calls[0].hostname).toBe('hn.algolia.com');
    expect(calls[0].searchParams.get('numericFilters')).toMatch(/^created_at_i>\d+$/);
    expect(dedupeKey(rows[0], 'company')).toBe('domain:acme.dev');
    expect(dedupeKey(rows[1], 'company')).toBe('hn:https://news.ycombinator.com/item?id=102');
  });

  it('hiring: top-level posts of the latest "Who is hiring?" thread', async () => {
    setHttpFetch(fake([]));
    const rows = await hackerNewsSearch({ mode: 'hiring', keywords: 'crm' }, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Company: 'Globex', 'Company domain': 'globex.io', Remote: 'yes', Roles: 'Senior Backend Engineer, Product Designer', Location: 'Remote (US)', Thread: THREAD.title });
    expect(parseHiringPost('Initech (YC S20) | NYC or REMOTE | Full-stack Engineer | initech.com').company).toBe('Initech');
  });

  it('intent: only posts with a buying phrase and the keyword', async () => {
    setHttpFetch(fake([]));
    const rows = await hackerNewsSearch({ mode: 'intent', keywords: 'crm' }, 50);
    expect(rows.map((r) => r.Author)).toEqual(['buyer', 'asker']);
    expect(rows[0]).toMatchObject({ Phrase: 'looking for a', Thread: 'Ask HN: Best CRM in 2026?' });
    expect(rows[1].Phrase).toBe('alternatives to');
    await expect(hackerNewsSearch({ mode: 'intent' }, 5)).rejects.toThrow(/keywords/);
  });

  it('imports into a table via the sources API', async () => {
    const calls: URL[] = [];
    const env = await makeEnv({ fetch: fake(calls) });
    try {
      const t = await env.api('POST', '/api/gtm/tables', { name: 'HN' });
      const r = await env.api('POST', `/api/gtm/tables/${t.body.id}/import/source`, { source: 'hacker_news', params: { mode: 'launches', keywords: 'crm' }, limit: 2 });
      expect(r.status).toBe(200);
      expect(r.body.imported).toBe(2);
      const list = await env.api('GET', '/api/sources');
      expect(list.body.sources.find((s: any) => s.id === 'hacker_news')).toMatchObject({ ready: true });
    } finally { await env.close(); }
  });
});
