import { describe, it, expect, vi, afterEach } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Settings } from '../src/gtm/settings.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { OutreachBridge } from '../src/gtm/outreach.ts';
import { pageContacts } from '../src/gtm/lib/html.ts';
import { linkedinHeadline, signalKind } from '../src/gtm/providers/signals.ts';
import { silentLogger, type Ctx } from '../src/context.ts';
import { FakeMail } from './helpers.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();
afterEach(() => vi.unstubAllGlobals());

describe('page contact data', () => {
  it('reads the full number from JSON-LD when the visible text masks it', () => {
    const html = `<div class="hiddenPhone"> Call: 01 211... </div>
      <script type="application/ld+json">{"@type":"RealEstateAgent","name":"Benton","telephone":"01 2118450 / 045-916007","email":"info@benton.ie","url":"https://benton.ie"}</script>
      <a href="tel:+35312118450">call</a> <a href="mailto:Sales@Benton.ie?subject=hi">mail</a>`;
    const c = pageContacts(html);
    expect(c.phones).toEqual(['01 2118450 / 045-916007', '+35312118450']);
    expect(c.emails).toEqual(['info@benton.ie', 'sales@benton.ie']);
    expect(c.websites).toEqual(['https://benton.ie']);
    expect(pageContacts('<script type="application/ld+json">{not json</script>').phones).toEqual([]);
  });
});

describe('job change', () => {
  it('parses LinkedIn result titles only for the right person', () => {
    expect(linkedinHeadline('Jane Doe - Head of Sales - Acme Ltd | LinkedIn', 'Jane Doe')).toEqual({ title: 'Head of Sales', company: 'Acme Ltd' });
    expect(linkedinHeadline('Jane Doe – Acme | LinkedIn', 'jane doe')).toEqual({ company: 'Acme' });
    expect(linkedinHeadline('John Smith - CEO - Acme | LinkedIn', 'Jane Doe')).toBeNull();
  });

  it('leaves company rows empty instead of calling paid lookups', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const db = new Db(':memory:');
    const settings = new Settings(db);
    settings.set('APOLLO_API_KEY', 'k');
    const hit = await signalKind('job_change').run({ companyName: 'Acme', domain: 'acme.com' }, { settings, log: () => {} });
    expect(hit).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('alert fallbacks', () => {
  function setup() {
    const db = new Db(':memory:');
    const mail = new FakeMail();
    const ctx = { db, mail, log: silentLogger, now: () => new Date('2026-10-15T09:00:00Z'), fetch, config: {} } as unknown as Ctx;
    const ws = workspace(db);
    const uid = db.insert('users', { name: 'Owner', email: 'owner@acme.test', password_hash: 'x' });
    db.insert('workspace_members', { workspace_id: ws, user_id: uid, role: 'admin' });
    db.insert('sender_emails', { workspace_id: ws, name: 'Sales', email: 'sales@acme.test' });
    const store = new Store(db);
    const settings = new Settings(db);
    const outreach = new OutreachBridge(ctx);
    const engine = new Engine(store, settings, new Bus(), undefined, outreach);
    const t = store.createTable(ws, 't');
    store.createColumn(t, { name: 'Company', type: 'text' });
    const alert = store.createColumn(t, { name: 'Signal alert', type: 'action', config: { kind: 'slack', text: ':satellite_antenna: *{{Company}}* changed' } });
    const [r] = store.addRows(t, [{ Company: 'Acme' }]);
    const settle = async () => { for (let i = 0; i < 200 && (engine.stats(t).pending || engine.stats(t).running); i++) await new Promise((res) => setTimeout(res, 5)); };
    return { ws, mail, store, settings, outreach, engine, t, r, alert, settle };
  }

  it('emails the admins one digest when neither Slack nor ntfy is set up', async () => {
    const s = setup();
    s.engine.run(s.t, { force: true });
    await s.settle();
    expect(s.store.cell(s.r, s.alert)).toMatchObject({ status: 'done' });
    expect((s.store.cell(s.r, s.alert)?.value as any).value).toBe('emailed');
    s.outreach.emailAlert(s.ws, 'second change');
    (s.outreach as any).flushAlerts(s.ws);
    await new Promise((res) => setTimeout(res, 0));
    expect(s.mail.sent).toHaveLength(1);
    expect(s.mail.sent[0].msg).toMatchObject({ to: 'owner@acme.test', subject: 'Kinetic: 2 signal alerts', from: { email: 'sales@acme.test' } });
    expect(s.mail.sent[0].msg.text).toContain('Acme changed');
    expect(s.mail.sent[0].msg.text).not.toContain(':satellite_antenna:');
    s.engine.stop();
  });

  it('uses ntfy before email, and falls back to it when Slack fails', async () => {
    const calls: { url: string; body: string; title?: string }[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? ''), title: new Headers(init?.headers).get('title') ?? undefined });
      return String(url).includes('hooks.slack') ? new Response('no_service', { status: 404 }) : new Response('ok');
    });
    const s = setup();
    s.settings.set('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/x');
    s.settings.set('NTFY_TOPIC', 'acme-alerts-123');
    s.engine.run(s.t, { force: true });
    await s.settle();
    const cell = s.store.cell(s.r, s.alert)?.value as any;
    expect(cell.value).toBe('sent');
    expect(cell.data).toMatchObject({ via: 'ntfy', slackError: expect.stringContaining('404') });
    expect(calls.at(-1)).toMatchObject({ url: 'https://ntfy.sh/acme-alerts-123', body: 'Acme changed' });
    expect(s.mail.sent).toHaveLength(0);
    s.engine.stop();
  });
});

describe('company domain search', () => {
  const run = async (urls: string[]) => {
    const { searchDomain } = await import('../src/gtm/providers/free.ts');
    vi.stubGlobal('fetch', async () => Response.json({ results: urls.map((url) => ({ title: 'Mitchell Quinn Auctioneers', url, content: 'Mitchell Quinn Auctioneers Greystones' })) }));
    const settings = new Settings(new Db(':memory:'));
    settings.set('SEARXNG_URL', 'http://searx:8888');
    return searchDomain({ companyName: 'Mitchell Quinn Auctioneers', context: 'Greystones' }, { settings, log: () => {} });
  };

  it('takes only a domain that carries the name, preferring the full name', async () => {
    expect(await run(['https://www.irishtimes.com/a', 'https://quinnproperty.ie/', 'https://mitchellquinn.ie/'])).toMatchObject({ value: 'mitchellquinn.ie', confidence: 'search match' });
    expect(await run(['https://www.irishtimes.com/a', 'https://archive.org/x'])).toBeNull();
    expect(await run(['https://quinnproperty.ie/'])).toMatchObject({ value: 'quinnproperty.ie', weak: true, confidence: 'partial name match' });
  });
});

describe('GDELT', () => {
  it('answers from Google News at once when GDELT refuses, then skips GDELT for a while', async () => {
    const { resetGdeltPause } = await import('../src/gtm/providers/signals.ts');
    resetGdeltPause();
    const hits: string[] = [];
    vi.stubGlobal('fetch', async (url: any) => {
      const u = String(url); hits.push(new URL(u).host);
      if (u.includes('gdeltproject')) return new Response('Please limit requests to one every 5 seconds', { status: 429 });
      return new Response('<rss><item><title>Acme opens Bray office</title><link>https://news.example/a</link><pubDate>Wed, 14 Oct 2026 09:00:00 GMT</pubDate></item></rss>');
    });
    const settings = new Settings(new Db(':memory:'));
    const ctx = { settings, log: () => {} };
    const first = await signalKind('gdelt').run({ companyName: 'Acme Estates' }, ctx);
    expect(first).toMatchObject({ value: 'Acme opens Bray office', data: { source: 'google_news' } });
    const second = await signalKind('gdelt').run({ companyName: 'Other Estates' }, ctx);
    expect(second?.data?.source).toBe('google_news');
    expect(hits.filter((h) => h.includes('gdelt'))).toHaveLength(1);
    resetGdeltPause();
  });
});

describe('masked values', () => {
  it('flags phones and emails a page showed only partly when rows are added', async () => {
    const { makeEnv } = await import('./helpers.ts');
    const { looksMasked } = await import('../src/gtm/routes.ts');
    expect(['01 286...', '040 46…', 'j***@acme.com', '087 XXX XXXX'].every(looksMasked)).toBe(true);
    expect(['01 286 7625', 'Coming soon...', 'info@acme.com', 'Read more...'].some(looksMasked)).toBe(false);
    const env = await makeEnv();
    try {
      const t = (await env.api('POST', '/api/gtm/tables', { name: 'Agents' })).body;
      const r = await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows: [{ Company: 'Benton', Phone: '01 211...' }, { Company: 'DNG', Phone: '01 286 7625' }] });
      expect(r.body.ids).toHaveLength(2);
      expect(r.body.masked).toEqual([{ row: 0, column: 'Phone', value: '01 211...' }]);
      expect(r.body.warnings[0]).toContain('masked or cut off');
      const clean = await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows: [{ Company: 'Forkin', Phone: '040 461 933' }] });
      expect(clean.body).toEqual({ ids: [expect.any(Number)] });
    } finally { await env.close(); }
  });
});

describe('rows listing', () => {
  it('pages rows by column name and finds them by text', async () => {
    const { makeEnv } = await import('./helpers.ts');
    const env = await makeEnv();
    try {
      const t = (await env.api('POST', '/api/gtm/tables', { name: 'Agents' })).body;
      await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows: [{ Company: 'Benton', Town: 'Bray' }, { Company: 'Forkin', Town: 'Wicklow' }, { Company: 'DNG Bray', Town: 'Bray' }] });
      const all = await env.api('GET', `/api/gtm/tables/${t.id}/rows?limit=2`);
      expect(all.body).toMatchObject({ total: 3, offset: 0 });
      expect(all.body.rows[0].values).toMatchObject({ Company: 'Benton', Town: 'Bray' });
      expect(all.body.rows).toHaveLength(2);
      const bray = await env.api('GET', `/api/gtm/tables/${t.id}/rows?q=bray&columns=Company`);
      expect(bray.body.total).toBe(2);
      expect(bray.body.rows.map((r: any) => r.values)).toEqual([{ Company: 'Benton' }, { Company: 'DNG Bray' }]);
    } finally { await env.close(); }
  });
});

describe('maps search', () => {
  it('maps sports to OpenStreetMap club tags and refuses a Google search without a key clearly', async () => {
    const { overpassQuery, mapsSearch } = await import('../src/sourcing/maps.ts');
    const q = overpassQuery('football academy', { south: 53.3, west: -6.35, north: 53.4, east: -6.2 }, 50);
    expect(q).toContain('nwr["club"="sport"]["sport"="soccer"]["name"]');
    const settings = new Settings(new Db(':memory:'));
    await expect(mapsSearch({ query: 'cafe', location: 'Dublin', provider: 'google' } as any, { settings })).rejects.toMatchObject({ statusCode: 400 });
  });
});
