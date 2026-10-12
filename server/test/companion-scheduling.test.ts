import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { pairExtension, openSettings, advance } from './companion-helpers.ts';
import { recordAction, loadSettings, usage, randomDelaySec } from '../src/companion/settings.ts';

let env: TestEnv;
afterEach(async () => { await env?.close(); env = undefined as any; });

const MONDAY_10 = new Date('2026-10-12T10:00:00Z');
const MIN = 60_000;
const profiles = (n: number) => Array.from({ length: n }, (_, i) => `https://www.linkedin.com/in/person-${i + 1}/`).join('\n');

describe('companion job scheduling', () => {
  it('enforces daily limits, pacing gaps and resets at local midnight', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env, { limits: { 'linkedin.visit': { daily: 2 } }, delays: { action_min_sec: 60, action_max_sec: 120, page_min_sec: 1, page_max_sec: 2 } });
    const job = (await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.profile_visitor', params: { targets: profiles(3) }, start: true })).body.data;
    expect(job.status).toBe('running');
    expect(job.tasks.pending).toBe(3);

    const poll = async () => (await ext('POST', '/api/companion/poll', { sites: ['linkedin'] })).body;
    const t1 = await poll();
    expect(t1.task).toMatchObject({ kind: 'linkedin.profile_visitor', site: 'linkedin', openUrl: 'https://www.linkedin.com/in/person-1/', budget: 1 });
    expect(t1.task.pacing.actionDelayMs).toEqual([60_000, 120_000]);
    expect((await ext('POST', `/api/companion/tasks/${t1.task.id}/complete`, { status: 'done' })).status).toBe(200);

    // A random 60–120 s gap must pass before the next action.
    const wait = await poll();
    expect(wait.task).toBeNull();
    expect(wait.reason).toBe('pacing delay between actions');
    expect(wait.waitSeconds).toBeGreaterThanOrEqual(15);
    expect(wait.waitSeconds).toBeLessThanOrEqual(120);
    advance(env, 3 * MIN);

    const t2 = await poll();
    expect(t2.task.target.url).toBe('https://www.linkedin.com/in/person-2/');
    await ext('POST', `/api/companion/tasks/${t2.task.id}/complete`, { status: 'done' });
    advance(env, 3 * MIN);

    // Daily limit (2) reached: told to come back after midnight.
    const capped = await poll();
    expect(capped.task).toBeNull();
    expect(capped.reason).toMatch(/limit reached/);
    expect(capped.waitSeconds).toBe(900); // capped at 15 min; polling continues

    const stats = (await env.api('GET', '/api/automations/stats')).body.data;
    expect(stats.limits.find((l: any) => l.action === 'linkedin.visit')).toMatchObject({ daily: 2, used_today: 2 });

    // Next day (UTC midnight is the working-hours timezone) the count resets.
    env.clock.now = new Date('2026-10-13T00:05:00Z');
    const t3 = await poll();
    expect(t3.task.target.url).toBe('https://www.linkedin.com/in/person-3/');
    await ext('POST', `/api/companion/tasks/${t3.task.id}/complete`, { status: 'done' });
    const done = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(done.status).toBe('completed');
    expect(done.runs[0]).toMatchObject({ status: 'completed', actions: 3 });
  });

  it('resets daily limits at midnight in the configured timezone', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const s = loadSettings(env.ctx.db, 1);
    s.working_hours.timezone = 'America/New_York';
    const ws = 1;
    // 03:30 UTC Tuesday = 23:30 Monday in New York: still "today" there.
    recordAction(env.ctx.db, { workspaceId: ws, action: 'linkedin.connect', count: 5, at: new Date('2026-10-13T03:30:00Z') });
    expect(usage(env.ctx.db, ws, s, 'linkedin.connect', new Date('2026-10-13T03:45:00Z')).used_today).toBe(5);
    // 04:10 UTC = 00:10 Tuesday in New York (EDT): a new day.
    expect(usage(env.ctx.db, ws, s, 'linkedin.connect', new Date('2026-10-13T04:10:00Z')).used_today).toBe(0);
    expect(usage(env.ctx.db, ws, s, 'linkedin.connect', new Date('2026-10-13T04:10:00Z')).used_week).toBe(5);
  });

  it('enforces the rolling weekly invite limit', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    for (let d = 1; d <= 5; d++) recordAction(env.ctx.db, { workspaceId: 1, action: 'linkedin.connect', count: 20, at: new Date(MONDAY_10.getTime() - d * 86_400_000) });
    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.auto_connect', params: { targets: profiles(1), note: 'Hi {first_name}' }, start: true });
    const r = (await ext('POST', '/api/companion/poll', {})).body;
    expect(r.task).toBeNull();
    expect(r.reason).toMatch(/linkedin\.connect limit reached/);
    // Eight days later the oldest invites roll out of the window.
    env.clock.now = new Date(MONDAY_10.getTime() + 3 * 86_400_000);
    expect((await ext('POST', '/api/companion/poll', {})).body.task?.kind).toBe('linkedin.auto_connect');
  });

  it('respects working hours for actions; reads may run outside them when allowed', async () => {
    const saturday = new Date('2026-10-17T10:00:00Z');
    env = await makeEnv({ now: saturday });
    const { ext } = await pairExtension(env);
    await env.api('PUT', '/api/automations/settings', { working_hours: { enabled: true, timezone: 'UTC', start: '09:00', end: '17:00' } });
    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.profile_visitor', params: { targets: profiles(1) }, start: true });
    const r = (await ext('POST', '/api/companion/poll', {})).body;
    expect(r).toMatchObject({ task: null, reason: 'outside working hours', waitSeconds: 900 });

    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.search_export', params: { search_url: 'https://www.linkedin.com/search/results/people/?keywords=cfo', limit: 10 } });
    expect((await ext('POST', '/api/companion/poll', {})).body.task).toBeNull();
    await env.api('PUT', '/api/automations/settings', { scrape_outside_hours: true });
    expect((await ext('POST', '/api/companion/poll', {})).body.task?.kind).toBe('linkedin.search_export');

    // Monday 09:30 the action is handed out.
    env.clock.now = new Date('2026-10-19T09:30:00Z');
    expect((await ext('POST', '/api/companion/poll', {})).body.task?.kind).toBe('linkedin.profile_visitor');
  });

  it('budgets scrapes by the daily limit and resumes from the cursor the next day', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env, { limits: { 'linkedin.scrape': { daily: 30 } } });
    const job = (await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.search_export', params: { search_url: 'https://www.linkedin.com/search/results/people/?keywords=cto', limit: 50 } })).body.data;
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(t.budget).toBe(30);
    expect(t.openUrl).toContain('/search/results/people/');
    const records = Array.from({ length: 30 }, (_, i) => ({ fullName: `Person ${i}`, profileUrl: `https://www.linkedin.com/in/p${i}/` }));
    const res = (await ext('POST', `/api/companion/tasks/${t.id}/results`, { records, cursor: { start: 30 } })).body;
    expect(res).toMatchObject({ accepted: 30, new: 30, budgetLeft: 0, stop: true });
    await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done', more: true, cursor: { start: 30 } });
    expect((await ext('POST', '/api/companion/poll', {})).body.task).toBeNull();

    env.clock.now = new Date('2026-10-13T08:00:00Z');
    const again = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(again).toMatchObject({ id: t.id, cursor: { start: 30 }, budget: 20 });
    const table = (await env.api('GET', `/api/gtm/tables/${job.table_id}`)).body;
    expect(table.rows).toHaveLength(30);
    expect(table.columns.map((c: any) => c.name)).toContain('LinkedIn URL');
  });

  it('pauses, resumes and cancels jobs; expired leases go back to the queue', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const job = (await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.profile_scraper', params: { targets: profiles(2) } })).body.data;
    await env.api('POST', `/api/automations/jobs/${job.id}/pause`);
    expect((await ext('POST', '/api/companion/poll', {})).body.task).toBeNull();
    await env.api('POST', `/api/automations/jobs/${job.id}/resume`);
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(t.kind).toBe('linkedin.profile_scraper');

    // Paused mid-task: the next report tells the extension to stop.
    await env.api('POST', `/api/automations/jobs/${job.id}/pause`);
    expect((await ext('POST', `/api/companion/tasks/${t.id}/progress`, { message: 'reading' })).body).toMatchObject({ stop: true });
    await env.api('POST', `/api/automations/jobs/${job.id}/resume`);

    // The browser vanishes: after the lease expires the task is handed out again.
    advance(env, 25 * MIN);
    const again = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(again.id).toBe(t.id);

    const cancelled = (await env.api('POST', `/api/automations/jobs/${job.id}/cancel`)).body.data;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks.cancelled).toBe(2);
    expect((await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done' })).status).toBe(409);
  });

  it('safety stops pause the site for this browser and requeue the task', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext, deviceId } = await pairExtension(env);
    await openSettings(env);
    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.profile_scraper', params: { targets: profiles(1) } });
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    const stop = (await ext('POST', `/api/companion/tasks/${t.id}/error`, { kind: 'challenge', url: 'https://www.linkedin.com/checkpoint/challenge/' })).body;
    expect(Date.parse(stop.paused_until) - MONDAY_10.getTime()).toBe(24 * 3_600_000);
    const r = (await ext('POST', '/api/companion/poll', {})).body;
    expect(r.task).toBeNull();
    const dev = (await env.api('GET', '/api/companion/status')).body.data.devices[0];
    expect(dev.site_pauses.linkedin).toBe(stop.paused_until);
    expect(dev.last_error).toContain('challenge');
    // The user clears the pause after solving the challenge.
    await env.api('PATCH', `/api/companion/devices/${deviceId}`, { clear_site_pause: 'linkedin' });
    expect((await ext('POST', '/api/companion/poll', {})).body.task?.id).toBe(t.id);
  });

  it('validates phantom inputs against the schema', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const r = await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.search_export', params: { search_url: 'not a url', limit: 99999 } });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.fields)).toEqual(['search_url', 'limit']);
    const ai = await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.auto_connect', params: { targets: profiles(1), note: 'Hi {first_name}, {ai_message}' } });
    expect(ai.status).toBe(422);
    expect(ai.body.message).toMatch(/OPENROUTER_API_KEY/);
    // Action phantoms start as drafts until explicitly started.
    const draft = (await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.auto_connect', params: { targets: profiles(1), note: '{Hi|Hello} {first_name}' } })).body.data;
    expect(draft.status).toBe('draft');
    expect((await env.api('POST', `/api/automations/jobs/${draft.id}/start`)).body.data.status).toBe('running');
  });

  it('AI post responder: drafts wait for approval; only approved comments are posted', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const job = (await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.ai_post_responder', params: { targets: 'https://www.linkedin.com/in/author/', instructions: 'Be specific' }, start: true })).body.data;
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(t.kind).toBe('linkedin.ai_post_responder');
    const posts = [1, 2].map((i) => ({ postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:700000000000000000${i}/`, authorName: 'Author', text: `Post ${i}` }));
    await ext('POST', `/api/companion/tasks/${t.id}/results`, { records: posts });
    await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done' });

    // No AI key: drafts are empty with a note, and the run waits for decisions.
    const approvals = (await env.api('GET', '/api/automations/approvals?status=pending')).body.data;
    expect(approvals).toHaveLength(2);
    expect(approvals[0].context).toMatch(/AI not configured/);
    let j = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(j.status).toBe('running');
    expect(j.progress.message).toMatch(/2 comments waiting/);
    expect((await ext('POST', '/api/companion/poll', {})).body.task).toBeNull();

    expect((await env.api('POST', `/api/automations/approvals/${approvals[0].id}/approve`, {})).status).toBe(422);
    await env.api('POST', `/api/automations/approvals/${approvals[0].id}/approve`, { text: 'Great breakdown of pricing tiers.' });
    await env.api('POST', `/api/automations/approvals/${approvals[1].id}/reject`);
    const c = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(c).toMatchObject({ kind: 'linkedin.comment', params: { text: 'Great breakdown of pricing tiers.' }, budget: 1 });
    await ext('POST', `/api/companion/tasks/${c.id}/complete`, { status: 'done' });
    expect((await env.api('GET', '/api/automations/approvals')).body.data.map((a: any) => a.status).sort()).toEqual(['posted', 'rejected']);
    j = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(j.status).toBe('completed');
    expect((await env.api('GET', '/api/automations/stats')).body.data.limits.find((l: any) => l.action === 'linkedin.comment').used_today).toBe(1);
  });

  it('randomised delays stay within bounds', () => {
    for (let i = 0; i < 200; i++) {
      const d = randomDelaySec(45, 180);
      expect(d).toBeGreaterThanOrEqual(45);
      expect(d).toBeLessThanOrEqual(180);
    }
    expect(randomDelaySec(10, 10)).toBe(10);
  });
});
