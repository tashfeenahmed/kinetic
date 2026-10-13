import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { setHttpFetch } from '../src/gtm/lib/http.ts';
import { gtmTestSetup } from './gtm-helpers.ts';

// SMTP answers per address.
const smtp = new Map<string, string>();
vi.mock('../src/gtm/lib/smtp.ts', async (orig) => ({
  ...(await orig<typeof import('../src/gtm/lib/smtp.ts')>()),
  smtpVerify: vi.fn(async (email: string) => ({ verdict: smtp.get(email) ?? 'invalid', reason: 'test', mailProvider: 'Other' })),
}));
const { aiReadContacts } = await import('../src/gtm/providers/people.ts');

gtmTestSetup();
afterEach(() => { smtp.clear(); setHttpFetch((...a) => globalThis.fetch(...a)); vi.unstubAllGlobals(); });

function ctx() {
  const settings = new Settings(new Db(':memory:'));
  settings.set('OPENROUTER_API_KEY', 'or-test');
  settings.set('SEARXNG_URL', 'http://searx.test');
  return { settings, log: () => {} };
}

const PAGES: Record<string, string> = {
  'https://acme.test/': '<html><body><a href="/our-team">Our team</a><a href="/pricing">Pricing</a> Acme makes POS software.</body></html>',
  'https://acme.test/our-team': '<html><body><h2>Ann Boss</h2><p>Founder &amp; CEO — <a href="mailto:ann@acme.test">ann@acme.test</a></p><h2>Sam Ops</h2><p>Operations</p></body></html>',
};

function fakeWeb(aiPeople: string[] | string[][], seenPrompt: { text?: string; calls?: number }) {
  let call = 0;
  const f = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith('http://searx.test')) return Response.json({ results: [] });
    if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
      seenPrompt.text = JSON.parse(init.body).messages[1].content;
      seenPrompt.calls = ++call;
      // A list of lists answers each pass in turn (first pass, retry…).
      const people = Array.isArray(aiPeople[0]) ? (aiPeople as string[][])[Math.min(call - 1, aiPeople.length - 1)] : aiPeople;
      return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'submit', arguments: JSON.stringify({ people }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    const page = PAGES[url] ?? PAGES[url.replace(/\/$/, '')];
    return page ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  setHttpFetch(f);
  vi.stubGlobal('fetch', f);
}

describe('AI read (free first step)', () => {
  it('reads the team page, extracts people and verifies the published email', async () => {
    const seen: { text?: string } = {};
    fakeWeb(['Sam Ops | Operations | - | - | https://acme.test/our-team', 'Ann Boss | Founder & CEO | ann@acme.test | - | https://acme.test/our-team'], seen);
    smtp.set('ann@acme.test', 'valid');
    const hit = await aiReadContacts({ domain: 'acme.test', companyName: 'Acme' }, ctx());
    expect(seen.text).toContain('Emails on page: ann@acme.test'); // the team page link was followed
    expect(hit).toMatchObject({ value: 'ann@acme.test', weak: false, data: { name: 'Ann Boss', title: 'Founder & CEO', email_status: 'verified', email_source: 'published on https://acme.test/our-team', found_by: 'ai_read' } });
    expect((hit!.data as any).people).toHaveLength(2);
  });

  it('asks again when the first pass finds nobody', async () => {
    const seen: { text?: string; calls?: number } = {};
    fakeWeb([[], ['Ann Boss | Founder & CEO | ann@acme.test | - | https://acme.test/our-team']], seen);
    smtp.set('ann@acme.test', 'valid');
    const hit = await aiReadContacts({ domain: 'acme.test', companyName: 'Acme' }, ctx());
    expect(seen.calls).toBe(2);
    expect(seen.text).toContain('A first pass found nobody');
    expect(hit).toMatchObject({ value: 'ann@acme.test', weak: false });
  });

  it('is skipped without an AI key, and is weak when it finds people but no email', async () => {
    const noAi = { settings: new Settings(new Db(':memory:')), log: () => {} };
    expect(await aiReadContacts({ domain: 'acme.test' }, noAi)).toBeNull();
    fakeWeb(['Sam Ops | Operations | - | - | https://acme.test/our-team'], {});
    const hit = await aiReadContacts({ domain: 'acme.test', title: 'operations' }, ctx()); // every pattern guess rejected by SMTP
    expect(hit).toMatchObject({ value: 'Sam Ops', weak: true });
  });
});
