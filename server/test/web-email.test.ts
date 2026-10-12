import { describe, it, expect, vi, afterEach } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { gtmTestSetup } from './gtm-helpers.ts';

// SMTP answers per address, set by each test.
const smtp = new Map<string, string>();
vi.mock('../src/gtm/lib/smtp.ts', async (orig) => ({
  ...(await orig<typeof import('../src/gtm/lib/smtp.ts')>()),
  smtpVerify: vi.fn(async (email: string) => ({ verdict: smtp.get(email) ?? 'invalid', reason: 'test', mailProvider: 'Other' })),
}));
const { webSearchEmailFinder, looksLike } = await import('../src/gtm/providers/webEmail.ts');

gtmTestSetup();
afterEach(() => { vi.unstubAllGlobals(); smtp.clear(); });

function ctx() {
  const settings = new Settings(new Db(':memory:'));
  settings.set('SEARXNG_URL', 'http://searx.test');
  return { settings, log: () => {} };
}

/** SearXNG results keyed by a substring of the query; pages keyed by URL. */
function web(results: Record<string, { title: string; url: string; content: string }[]>, pages: Record<string, string>) {
  vi.stubGlobal('fetch', async (url: URL | string) => {
    const u = String(url);
    if (u.startsWith('http://searx.test')) {
      const q = new URL(u).searchParams.get('q') ?? '';
      const key = Object.keys(results).find((k) => q.includes(k));
      return Response.json({ results: key ? results[key] : [] });
    }
    if (pages[u]) return new Response(pages[u], { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  });
}

describe('web search email finder', () => {
  it('returns the person\'s own address found on another site, checked with SMTP', async () => {
    web(
      { '"Peter Greaney" "@western.ie"': [{ title: 'Western EPoS — contact', url: 'https://directory.ie/western', content: 'Managing Director Peter Greaney' }] },
      { 'https://directory.ie/western': '<p>Managing Director: Peter Greaney, <a href="mailto:pgreaney@western.ie">email</a></p><p>info@western.ie</p>' },
    );
    smtp.set('pgreaney@western.ie', 'valid');
    const hit = await webSearchEmailFinder({ fullName: 'Peter Greaney', domain: 'western.ie', companyName: 'Western EPoS' }, ctx());
    expect(hit).toMatchObject({ value: 'pgreaney@western.ie', confidence: 'found on the web · verified (SMTP)' });
    expect(hit!.weak).toBeUndefined();
    expect(hit!.data).toMatchObject({ source: 'https://directory.ie/western', company_emails: ['info@western.ie'] });
  });

  it('learns the company pattern from colleagues\' addresses on the web', async () => {
    web({ '"@acme.ie"': [{ title: 'Acme team', url: 'https://news.ie/acme', content: 'Contact mary.byrne@acme.ie or john.walsh@acme.ie' }] }, {});
    smtp.set('aoife.kelly@acme.ie', 'valid');
    const hit = await webSearchEmailFinder({ fullName: 'Aoife Kelly', domain: 'acme.ie' }, ctx());
    expect(hit).toMatchObject({ value: 'aoife.kelly@acme.ie', data: { pattern: 'first.last' } });
    expect(String(hit!.confidence)).toContain('verified (SMTP)');
  });

  it('skips dead public addresses and keeps other-domain addresses as a weak fallback', async () => {
    web({ '"Peter Greaney" email contact': [{ title: 'Peter Greaney — Galway Tills', url: 'https://galwaytills.ie', content: 'Peter Greaney, owner: peter.greaney@galwaytills.ie' }] }, {});
    const hit = await webSearchEmailFinder({ fullName: 'Peter Greaney', domain: 'western.ie' }, ctx());
    expect(hit).toMatchObject({ value: 'peter.greaney@galwaytills.ie', weak: true });
    expect(hit!.data).toMatchObject({ other_emails: ['peter.greaney@galwaytills.ie'] });
  });

  it('ignores addresses that are someone else\'s', async () => {
    web({ '"@acme.ie"': [{ title: 'Acme', url: 'https://x.ie', content: 'sales@acme.ie peter@gmail.com' }] }, {});
    expect(await webSearchEmailFinder({ fullName: 'Peter Greaney', domain: 'acme.ie' }, ctx())).toBeNull();
    expect(looksLike('pgreaney', 'peter', 'greaney')).toBe(true);
    expect(looksLike('peter.greaney', 'peter', 'greaney')).toBe(true);
    expect(looksLike('sales', 'peter', 'greaney')).toBe(false);
    expect(looksLike('pmurphy', 'peter', 'greaney')).toBe(false);
  });
});
