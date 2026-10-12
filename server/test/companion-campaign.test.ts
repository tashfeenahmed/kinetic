import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { pairExtension, openSettings, advance } from './companion-helpers.ts';
import { nextStep, applyTaskResult, passesFilters, DEFAULT_CAMPAIGN_SETTINGS, type CampaignSettings, type Lead } from '../src/companion/campaigns.ts';
import { campaignTick } from '../src/companion/campaigns.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-10-12T10:00:00Z');
const at = (d: number) => new Date(T0.getTime() + d * DAY);

const settings: CampaignSettings = {
  ...DEFAULT_CAMPAIGN_SETTINGS,
  visit_first: true,
  messages: [{ template: 'Thanks {first_name}', delay_days: 2 }, { template: 'Follow-up 1', delay_days: 3 }, { template: 'Follow-up 2', delay_days: 0 }],
  withdraw_after_days: 14,
};
const lead = (patch: Partial<Lead> = {}): Lead => ({
  id: 1, campaign_id: 1, profile_url: 'https://www.linkedin.com/in/jane/', public_id: null, member_urn: null, full_name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe',
  title: 'VP Sales', company: 'Acme', location: 'Berlin', headline: null, data: {}, excluded: false, state: 'pending', messages_sent: 0, next_action_at: null,
  visited_at: null, invited_at: null, accepted_at: null, last_message_at: null, replied_at: null, error: null, ...patch,
});

describe('LinkedIn campaign state machine', () => {
  it('visits, then connects, then waits for acceptance', () => {
    expect(nextStep(lead(), settings, T0)).toMatchObject({ kind: 'visit' });
    expect(nextStep(lead(), { ...settings, visit_first: false }, T0)).toMatchObject({ kind: 'connect' });
    const visited = { ...lead(), ...applyTaskResult(lead(), 'visit', 'done', { profile: { title: 'CRO', company: 'Acme' }, connectionDegree: '2nd' }, null, settings, T0) };
    expect(visited).toMatchObject({ state: 'visited', title: 'CRO' });
    expect(nextStep(visited, settings, T0)).toMatchObject({ kind: 'connect' });
    const invited = { ...visited, ...applyTaskResult(visited, 'connect', 'done', { sentText: 'Hi' }, null, settings, T0) };
    expect(invited.state).toBe('invited');
    expect(nextStep(invited, settings, at(5))).toEqual({ kind: null, at: null });
  });

  it('not accepted: expires after withdraw_after_days', () => {
    const invited = lead({ state: 'invited', invited_at: T0.toISOString() });
    expect(nextStep(invited, settings, at(13)).expire).toBeUndefined();
    expect(nextStep(invited, settings, at(15))).toMatchObject({ kind: null, expire: true });
    expect(nextStep(invited, { ...settings, withdraw_after_days: null }, at(60)).expire).toBeUndefined();
  });

  it('accepted: message 1 after its delay from acceptance, follow-ups from the previous message, then done', () => {
    let l = lead({ state: 'accepted', invited_at: T0.toISOString(), accepted_at: at(1).toISOString() });
    let s = nextStep(l, settings, at(1));
    expect(s).toMatchObject({ kind: 'message', messageIndex: 0 });
    expect(s.at!.toISOString()).toBe(at(3).toISOString());
    l = { ...l, ...applyTaskResult(l, 'message', 'done', { sentText: 'Thanks Jane' }, null, settings, at(3)) };
    expect(l).toMatchObject({ state: 'messaged', messages_sent: 1 });
    s = nextStep(l, settings, at(3));
    expect(s.at!.toISOString()).toBe(at(6).toISOString());
    l = { ...l, ...applyTaskResult(l, 'message', 'done', {}, null, settings, at(6)) };
    s = nextStep(l, settings, at(6));
    expect(s).toMatchObject({ kind: 'message', messageIndex: 2 });
    expect(s.at!.toISOString()).toBe(at(6).toISOString()); // 0-day follow-up
    l = { ...l, ...applyTaskResult(l, 'message', 'done', {}, null, settings, at(6)) };
    expect(l).toMatchObject({ state: 'done', messages_sent: 3 });
    expect(nextStep(l, settings, at(30)).kind).toBeNull();
  });

  it('delays are clamped to 0–15 days', () => {
    const l = lead({ state: 'accepted', accepted_at: T0.toISOString() });
    expect(nextStep(l, { ...settings, messages: [{ template: 'x', delay_days: 40 }] }, T0).at!.toISOString()).toBe(at(15).toISOString());
  });

  it('already connected at visit → skips the invite; replied/failed/excluded leads stop', () => {
    const p = applyTaskResult(lead(), 'visit', 'done', { connectionDegree: '1st', profile: {} }, null, settings, T0);
    expect(p).toMatchObject({ state: 'accepted', accepted_at: T0.toISOString() });
    expect(applyTaskResult(lead({ state: 'visited' }), 'connect', 'skipped', { alreadyConnected: true }, null, settings, T0).state).toBe('accepted');
    expect(applyTaskResult(lead(), 'connect', 'failed', null, 'Invite limit', settings, T0)).toMatchObject({ state: 'failed', error: 'Invite limit' });
    for (const state of ['replied', 'failed', 'done', 'not_accepted'] as const) expect(nextStep(lead({ state }), settings, T0).kind).toBeNull();
    expect(nextStep(lead({ excluded: true }), settings, T0).kind).toBeNull();
  });

  it('review filters on title, exclusions, location and company', () => {
    const f = { titles: ['vp', 'head of'], exclude_titles: ['intern'], locations: ['berlin', 'munich'], companies: [] };
    expect(passesFilters({ title: 'VP Sales', headline: null, location: 'Berlin, DE', company: 'Acme' }, f)).toBe(true);
    expect(passesFilters({ title: 'VP Sales Intern', headline: null, location: 'Berlin', company: 'Acme' }, f)).toBe(false);
    expect(passesFilters({ title: 'Engineer', headline: null, location: 'Berlin', company: 'Acme' }, f)).toBe(false);
    expect(passesFilters({ title: 'Head of Growth', headline: null, location: 'Paris', company: 'Acme' }, f)).toBe(false);
  });
});

let env: TestEnv;
afterEach(async () => { await env?.close(); env = undefined as any; });

describe('LinkedIn campaign end to end (fake extension)', () => {
  it('runs visit → connect → acceptance check → message → reply detection, with events and stats', async () => {
    env = await makeEnv({ now: T0 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const c = (await env.api('POST', '/api/linkedin/campaigns', {
      name: 'Founders', settings: { connect_note: '{Hi|Hey} {first_name}, keen to connect.', messages: [{ template: 'Thanks for connecting {first_name}!', delay_days: 1 }, { template: 'Bump', delay_days: 2 }] },
    })).body.data;
    expect(c.status).toBe('draft');
    const add = (await env.api('POST', `/api/linkedin/campaigns/${c.id}/leads`, { profiles: [
      { profile_url: 'https://www.linkedin.com/in/ann/', full_name: 'Ann Lee', title: 'Founder' },
      { profile_url: 'linkedin.com/in/bob', full_name: 'Bob Ray', title: 'CEO' },
      { profile_url: 'carl-intern', full_name: 'Carl Intern', title: 'Intern' },
      { profile_url: 'https://example.com/nope' },
    ] })).body.data;
    expect(add).toEqual({ added: 3, skipped: 1 });
    // Review gate.
    expect((await env.api('POST', `/api/linkedin/campaigns/${c.id}/review`, { filters: { exclude_titles: ['intern'] } })).body.data).toEqual({ included: 2, excluded: 1 });

    // Starting needs explicit confirmation.
    expect((await env.api('POST', `/api/linkedin/campaigns/${c.id}/start`, {})).status).toBe(422);
    expect((await env.api('POST', `/api/linkedin/campaigns/${c.id}/start`, { confirm: true })).body.data.status).toBe('active');

    const poll = async () => (await ext('POST', '/api/companion/poll', {})).body.task;
    const step = async (kind: string, body: any) => {
      const t = await poll();
      expect(t?.kind).toBe(kind);
      await ext('POST', `/api/companion/tasks/${t.id}/complete`, body);
      advance(env, 10_000);
      return t;
    };

    await campaignTick(env.ctx, env.ctx.now());
    // Ann: 2nd degree. Bob: already connected.
    const v1 = await step('linkedin.visit', { status: 'done', result: { connectionDegree: '2nd', profile: { fullName: 'Ann Lee', firstName: 'Ann', title: 'Founder', company: 'Annco' } } });
    expect(v1.target.profileUrl).toBe('https://www.linkedin.com/in/ann/');
    await step('linkedin.visit', { status: 'done', result: { connectionDegree: '1st', profile: { firstName: 'Bob' } } });
    expect(env.ctx.db.all(`SELECT * FROM events WHERE type = 'LINKEDIN_CONNECTION_ACCEPTED'`)).toHaveLength(1);

    // Bob is already connected, so an inbox check is queued (highest priority) alongside Ann's invite.
    await campaignTick(env.ctx, env.ctx.now());
    const drained: string[] = [];
    for (let x = await poll(); x; x = await poll()) {
      drained.push(x.kind);
      if (x.kind === 'linkedin.connect') expect(x.params.text).toMatch(/^(Hi|Hey) Ann, keen to connect\.$/);
      if (x.kind === 'linkedin.check_inbox') await ext('POST', `/api/companion/tasks/${x.id}/results`, { records: [] });
      await ext('POST', `/api/companion/tasks/${x.id}/complete`, { status: 'done', result: {} });
      advance(env, 60_000);
    }
    expect(drained).toEqual(['linkedin.check_inbox', 'linkedin.connect']);

    // Checks repeat every few hours; Ann's invite now shows up as accepted. Bob's first message waits a day.
    advance(env, 3 * 3_600_000);
    await campaignTick(env.ctx, env.ctx.now());
    const check = await poll();
    expect(check.kind).toBe('linkedin.check_connections');
    expect(check.budget).toBeGreaterThan(0);
    await ext('POST', `/api/companion/tasks/${check.id}/results`, { records: [{ fullName: 'Ann Lee', profileUrl: 'https://www.linkedin.com/in/ann', connectedAt: env.ctx.now().toISOString() }] });
    await ext('POST', `/api/companion/tasks/${check.id}/complete`, { status: 'done' });
    const inbox = await poll();
    expect(inbox.kind).toBe('linkedin.check_inbox');
    await ext('POST', `/api/companion/tasks/${inbox.id}/results`, { records: [] });
    await ext('POST', `/api/companion/tasks/${inbox.id}/complete`, { status: 'done' });
    expect(env.ctx.db.all(`SELECT * FROM events WHERE type = 'LINKEDIN_CONNECTION_ACCEPTED'`)).toHaveLength(2);
    expect(await poll()).toBeNull();

    /** Runs every queued task like the extension would; inbox checks return `inbox`. Returns messages sent. */
    const drain = async (inbox: any[] = []) => {
      const sent: { to: string; text: string }[] = [];
      for (let x = await poll(); x; x = await poll()) {
        if (x.kind === 'linkedin.message') sent.push({ to: x.target.profileUrl, text: x.params.text });
        if (x.kind.startsWith('linkedin.check_')) await ext('POST', `/api/companion/tasks/${x.id}/results`, { records: x.kind === 'linkedin.check_inbox' ? inbox : [] });
        await ext('POST', `/api/companion/tasks/${x.id}/complete`, { status: 'done' });
        advance(env, 60_000);
      }
      return sent;
    };

    advance(env, 1.1 * DAY);
    await campaignTick(env.ctx, env.ctx.now());
    const first = await drain();
    expect(first.map((m) => m.text).sort()).toEqual(['Thanks for connecting Ann!', 'Thanks for connecting Bob!']);

    // Ann replies → she stops; Bob gets the follow-up two days after his first message.
    advance(env, 3 * 3_600_000);
    await campaignTick(env.ctx, env.ctx.now());
    expect(await drain([
      { participantUrl: 'https://www.linkedin.com/in/ann/', lastSender: 'them', lastMessageAt: env.ctx.now().toISOString(), lastMessage: 'Sure, let us talk' },
      { participantUrl: 'https://www.linkedin.com/in/bob/', lastSender: 'me', lastMessageAt: env.ctx.now().toISOString() },
    ])).toEqual([]);
    const replies = env.ctx.db.all(`SELECT data FROM events WHERE type = 'LINKEDIN_REPLY_RECEIVED'`);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0].data).message).toBe('Sure, let us talk');

    advance(env, 2 * DAY);
    await campaignTick(env.ctx, env.ctx.now());
    expect(await drain()).toEqual([{ to: 'https://www.linkedin.com/in/bob/', text: 'Bump' }]);

    const stats = (await env.api('GET', `/api/linkedin/campaigns/${c.id}`)).body.data.stats;
    expect(stats).toMatchObject({ total: 3, excluded: 1, visited: 2, invited: 1, accepted: 2, messaged: 2, followups: 1, replied: 1, done: 1, failed: 0 });
    expect(stats.acceptance_rate).toBe(1);
    expect(stats.reply_rate).toBe(0.5);
    const leads = (await env.api('GET', `/api/linkedin/campaigns/${c.id}/leads?excluded=false`)).body;
    expect(leads.data.map((l: any) => l.state).sort()).toEqual(['done', 'replied']);
    const activity = (await env.api('GET', `/api/linkedin/campaigns/${c.id}/activity`)).body.data;
    expect(activity.length).toBeGreaterThan(5);
  });

  it('respects the campaign daily invite cap', async () => {
    env = await makeEnv({ now: T0 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const c = (await env.api('POST', '/api/linkedin/campaigns', { name: 'Cap', settings: { visit_first: false, daily_invites: 2 } })).body.data;
    await env.api('POST', `/api/linkedin/campaigns/${c.id}/leads`, { profiles: ['a', 'b', 'c', 'd'].map((x) => ({ profile_url: `https://www.linkedin.com/in/${x}/` })) });
    await env.api('POST', `/api/linkedin/campaigns/${c.id}/start`, { confirm: true });
    await campaignTick(env.ctx, env.ctx.now());
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND kind = 'linkedin.connect'`, [c.id]).n).toBe(2);
    for (let i = 0; i < 2; i++) {
      const t = (await ext('POST', '/api/companion/poll', {})).body.task;
      await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done' });
      advance(env, 60_000);
    }
    await campaignTick(env.ctx, env.ctx.now());
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND kind = 'linkedin.connect'`, [c.id]).n).toBe(2);
    // Next day two more.
    env.clock.now = new Date('2026-10-13T09:00:00Z');
    await campaignTick(env.ctx, env.ctx.now());
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND kind = 'linkedin.connect'`, [c.id]).n).toBe(4);
  });

  it('creates a campaign from a table', async () => {
    env = await makeEnv({ now: T0 });
    const tableId = (await env.api('POST', '/api/gtm/tables', { name: 'People', template: 'people' })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/rows`, { rows: [
      { 'Full name': 'Dana Fox', Title: 'COO', 'LinkedIn URL': 'https://www.linkedin.com/in/dana-fox' },
      { 'Full name': 'No Url', Title: 'CTO' },
    ] });
    const c = (await env.api('POST', '/api/linkedin/campaigns/from-table', { table_id: tableId, name: 'From table', columns: { profile_url: 'LinkedIn URL', full_name: 'Full name', title: 'Title' } })).body.data;
    expect(c.stats.total).toBe(1);
    const leads = (await env.api('GET', `/api/linkedin/campaigns/${c.id}/leads`)).body.data;
    expect(leads[0]).toMatchObject({ full_name: 'Dana Fox', title: 'COO', state: 'pending' });
  });
});
