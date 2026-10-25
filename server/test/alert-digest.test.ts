import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { silentLogger, type Ctx } from '../src/context.ts';
import { buildDigest, localDayHour, nameTokens, queueAlert, renderDigest, runAlertDigests, toQueued, type QueuedAlert } from '../src/gtm/alertDigest.ts';
import { looksBlocked } from '../src/gtm/providers/signals.ts';
import { Settings } from '../src/gtm/settings.ts';
import { FakeMail } from './helpers.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();
afterEach(() => vi.unstubAllGlobals());

const NOW = new Date('2026-10-24T07:30:00Z');
const sig = (kind: string, name: string, from: unknown, to: unknown) => ({ name, type: 'signal' as const, kind, from, to });
const site = (hash: string, added: string[] = []) => ({ value: hash, data: { hash, added, url: 'https://x' } });
const news = (title: string, latestDate = '2026-10-23T10:00:00Z') => ({ value: title, data: { latestDate, url: 'https://news.example/a' } });
const item = (company: string, domain: string, ...changes: ReturnType<typeof sig>[]): { id: number; item: QueuedAlert } =>
  ({ id: 0, item: { title: `${company} (${domain})`, text: '', company, domain, tableId: 3, rowId: 1, aboutChanges: true, changes } });

/** Shaped like the 23–24 Oct 2026 alerts that went out as "Kinetic: N signal alerts". */
const october = () => [
  item('DNG Greystones', 'dng.ie', sig('hiring', 'Hiring (open roles)', { value: null }, { value: 4, data: { jobs: [{ title: 'Negotiator' }, { title: 'Lettings Administrator' }] } })),
  item('DNG Thornton Properties', 'dngwicklow.ie',
    sig('news', 'News (Google News)', news('Old headline'), news('DNG Thornton wins Branch of the Year - Irish Independent')),
    sig('gdelt', 'Global news (GDELT)', news('Old headline'), news('DNG Thornton wins Branch of the Year - Irish Independent'))),
  item('Dooley Auctioneers', 'dooley.ie', sig('new_subdomains', 'New subdomains (certificates)', { value: null, data: { seen: 1 } }, { value: null, data: { seen: 2 } })),
  item('Dooley Poynton Auctioneers', 'wicklowproperty.com', sig('website_change', 'Website / page change', site('d63c'), site('d63c'))),
  item('Garrett O\'Bric Property Advisors', 'glk.ie', sig('website_change', 'Website / page change', site('2dc9'), site('ecaa', ['Something that looks like a new sentence here.']))),
  item('Katie Chadwick Property Services', 'katiechadwick.ie', sig('website_change', 'Website / page change', site('0caa'), site('ecaa', ['Something that looks like a new sentence here.']))),
  item('Forkin Earls', 'forkin.ie', sig('website_change', 'Website / page change', site('bcc0'), site('97ac', ['Now letting in Arklow and Gorey for the first time.']))),
  item('Forkin Estates', 'forkin.ie', sig('website_change', 'Website / page change', site('a4d3'), site('5623'))),
  item('McDonnell Properties', 'mcdonnellproperties.com', sig('news', 'News (Google News)', news('See inside former Wicklow schoolhouse'), { value: null })),
  item('Fenelon Properties', 'fenelonproperties.ie', sig('news', 'News (Google News)', news('x'), news('SNDY - Agnico, Waratah and Sprott Own Half - Simply Wall Street'))),
  item('Clarke Auctioneers', 'clarkeauctioneers.com', sig('news', 'News (Google News)', news('x'), news('Clarke Auctioneers sells landmark farm', '2026-09-01T00:00:00Z'))),
];

describe('alert digest', () => {
  it('keeps the real changes from a noisy night and explains them', () => {
    const d = buildDigest(october(), NOW);
    const live = d.groups.flatMap((g) => g.entries.filter((e) => e.tier !== 'noise').map((e) => `${e.tier}: ${g.name} ${e.what}`));
    expect(live).toEqual([
      'top: DNG Greystones is hiring: 4 open roles',
      'top: DNG Thornton Properties in the news: “DNG Thornton wins Branch of the Year - Irish Independent”',
      'minor: Forkin Earls, Forkin Estates updated their website',
    ]);
    expect(d.skippedReasons).toMatchObject({
      'duplicate': 1, // the GDELT copy of the Google News headline
      'nothing really changed': 2, // ∅ → ∅ and d63c → d63c
      'page looked like an error or bot check': 2, // two sites "changed to" the same page
      'website changed with no new text': 1,
      'value went blank': 1, // McDonnell's story aged out
      'news not about this company': 1,
      'old news': 1,
    });
    expect(d.groups.find((g) => g.key === 'dng.ie')!.entries[0].details).toEqual(['Negotiator', 'Lettings Administrator']);
  });

  it('renders a subject that leads with the most useful item', () => {
    const d = buildDigest(october(), NOW);
    const m = renderDigest(d, { publicUrl: 'https://k.test', workspaceName: 'REA' });
    expect(m.subject).toBe('DNG Greystones is hiring: 4 open roles, plus 2 more');
    expect(m.text).toContain('WORTH A LOOK');
    expect(m.text).toContain('Why it matters:');
    expect(m.text).toContain('Forkin Earls (+1 more office) updated their website: “Now letting in Arklow and Gorey for the first time.”');
    expect(m.text).toContain('https://k.test/tables/3');
    expect(m.text).not.toMatch(/∅|→/);
    expect(m.html).toContain('<b>DNG Greystones</b>');
  });

  it('does not count a signal whose value reads the same as a change', () => {
    const db = new Db(':memory:');
    const store = new Store(db);
    const t = store.createTable(workspace(db), 't');
    const col = store.createColumn(t, { name: 'Site', type: 'signal', config: { kind: 'website_change' } });
    const [r] = store.addRows(t, [{}]);
    store.writeCell(r, col, { value: site('d63c'), status: 'done' });
    expect(store.writeCell(r, col, { value: { ...site('d63c'), data: { hash: 'd63c', changed: false } }, status: 'done' })).toBe(true);
    expect(store.recentChanges(r, store.columns(t), '2000-01-01')).toEqual([]);
    store.writeCell(r, col, { value: site('97ac'), status: 'done' });
    expect(store.recentChanges(r, store.columns(t), '2000-01-01')).toMatchObject([{ name: 'Site', kind: 'website_change' }]);
  });

  it('finds the company name in a headline', () => {
    expect(nameTokens('DNG Thornton Properties', 'dng.ie')).toEqual(['dng', 'thornton']);
    expect(nameTokens('REA Forkin (Bray)', 'forkin.ie')).toEqual(['rea', 'forkin']);
  });

  it('picks the company and domain out of the alerted row', () => {
    const q = toQueued(':satellite_antenna: *Benton Real Estate* (benton.ie)\n*GitHub activity*: a → b', { tableId: 1, rowId: 2, row: { Company: 'Benton Real Estate', Website: { value: 'https://www.benton.ie/about' } }, changes: [] });
    expect(q).toMatchObject({ title: 'Benton Real Estate (benton.ie)', company: 'Benton Real Estate', domain: 'benton.ie' });
  });

  it('treats bot walls and error pages as no reading', () => {
    expect(looksBlocked(403, 'Forbidden', 'x'.repeat(500))).toBe(true);
    expect(looksBlocked(200, 'Just a moment...', 'x'.repeat(500))).toBe(true);
    expect(looksBlocked(200, 'Home', 'tiny')).toBe(true);
    expect(looksBlocked(200, 'Forkin Estate Agents', 'Welcome to Forkin. '.repeat(30))).toBe(false);
  });

  it('reads the hour in the workspace time zone', () => {
    expect(localDayHour(new Date('2026-10-24T07:30:00Z'), 'Europe/Dublin')).toEqual({ day: '2026-10-24', hour: 8 });
    expect(localDayHour(new Date('2026-12-24T07:30:00Z'), 'Europe/Dublin')).toEqual({ day: '2026-12-24', hour: 7 });
  });
});

describe('sending the digest', () => {
  function setup(now: string) {
    const db = new Db(':memory:');
    new Store(db);
    const mail = new FakeMail();
    let t = new Date(now);
    const ctx = { db, mail, log: silentLogger, now: () => t, config: { publicUrl: 'https://k.test' } } as unknown as Ctx;
    const ws = workspace(db);
    const uid = db.insert('users', { name: 'Owner', email: 'owner@acme.test', password_hash: 'x' });
    db.insert('workspace_members', { workspace_id: ws, user_id: uid, role: 'admin' });
    const cold = db.insert('sender_emails', { workspace_id: ws, name: 'Nathan', email: 'nathan@acme.test', status: 'Connected' });
    db.insert('sender_emails', { workspace_id: ws, name: 'Ops', email: 'ops@acme.test', status: 'Connected' });
    const camp = db.insert('campaigns', { workspace_id: ws, name: 'Wicklow', status: 'active', schedule_timezone: 'Europe/Dublin' });
    db.insert('campaign_sender_emails', { campaign_id: camp, sender_email_id: cold });
    const queue = (q: { item: QueuedAlert }) => db.insert('alert_digest_items', { workspace_id: ws, item: JSON.stringify(q.item), created_at: t.toISOString() });
    return { db, mail, ctx, ws, queue, at: (s: string) => { t = new Date(s); } };
  }

  it('sends once a day after 08:00 local, from a mailbox no campaign is using', async () => {
    const s = setup('2026-10-24T06:30:00Z'); // 07:30 in Dublin
    for (const i of october()) s.queue(i);
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.mail.sent).toHaveLength(0);
    s.at('2026-10-24T07:05:00Z'); // 08:05
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.mail.sent).toHaveLength(1);
    expect(s.mail.sent[0].msg).toMatchObject({ to: 'owner@acme.test', from: { name: 'Kinetic', email: 'ops@acme.test' }, subject: 'DNG Greystones is hiring: 4 open roles, plus 2 more' });
    expect(s.db.get('SELECT status, worth_a_look, also_changed, skipped FROM alert_digest_runs')).toEqual({ status: 'sent', worth_a_look: 2, also_changed: 1, skipped: 9 });
    // Later alerts that day wait for tomorrow's digest.
    s.queue(october()[0]);
    s.at('2026-10-24T15:00:00Z');
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.mail.sent).toHaveLength(1);
  });

  it('uses the time zone set under Integrations over the campaigns\' one', async () => {
    const s = setup('2026-10-24T11:30:00Z'); // 07:30 in New York, 20:30 in Tokyo
    s.db.run(`UPDATE campaigns SET schedule_timezone = 'Asia/Tokyo'`);
    new Settings(s.db).set('ALERT_DIGEST_TIMEZONE', 'America/New_York');
    s.queue(october()[0]);
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.db.get('SELECT COUNT(*) n FROM alert_digest_runs')).toEqual({ n: 0 });
    s.at('2026-10-24T12:30:00Z'); // 08:30 in New York
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.db.get('SELECT day, status FROM alert_digest_runs')).toEqual({ day: '2026-10-24', status: 'sent' });
  });

  it('stays quiet on a day with nothing worth a look', async () => {
    const s = setup('2026-10-24T08:00:00Z');
    for (const i of october().slice(2, 6)) s.queue(i);
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.mail.sent).toHaveLength(0);
    expect(s.db.get('SELECT status FROM alert_digest_runs')).toEqual({ status: 'quiet' });
    expect(s.db.get('SELECT COUNT(*) n FROM alert_digest_items WHERE digest_day IS NULL')).toEqual({ n: 0 });
  });

  it('lets the model re-rank and explain when an AI key is set', async () => {
    const s = setup('2026-10-24T08:00:00Z');
    new Settings(s.db).set('OPENROUTER_API_KEY', 'k');
    for (const i of october()) s.queue(i);
    const asked: any[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init: any) => {
      const body = JSON.parse(init.body);
      const list = JSON.parse(body.messages[1].content) as { id: number; change: string }[];
      asked.push(list);
      const answer = list.map((x) => (x.change.startsWith('is hiring') ? { id: x.id, tier: 'top', why: 'Two new front-office hires: they are growing in Greystones.' } : { id: x.id, tier: 'minor' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { headers: { 'content-type': 'application/json' } });
    });
    await runAlertDigests(s.ctx);
    expect(asked[0]).toHaveLength(3); // only what survived the rules goes to the model
    const m = s.mail.sent[0].msg;
    expect(m.subject).toBe('DNG Greystones is hiring: 4 open roles, plus 2 more');
    expect(m.text).toContain('Why it matters: Two new front-office hires: they are growing in Greystones.');
    expect(m.text).toMatch(/ALSO CHANGED[\s\S]*DNG Thornton Properties in the news/);
  });

  it('always sends alerts that are not change reports', async () => {
    const s = setup('2026-10-24T08:00:00Z');
    queueAlert(s.ctx, s.ws, 'New hot lead: Jo at Acme', { tableId: 1, rowId: 1, row: { Company: 'Acme' }, changes: [], aboutChanges: false });
    await runAlertDigests(s.ctx, { useAi: false });
    expect(s.mail.sent[0].msg.subject).toBe('New hot lead: Jo at Acme');
  });
});
