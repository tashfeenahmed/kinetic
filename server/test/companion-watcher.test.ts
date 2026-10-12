import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { pairExtension, openSettings, advance } from './companion-helpers.ts';
import { companionTick } from '../src/companion/worker.ts';
import { renderMessage } from '../src/companion/render.ts';

let env: TestEnv;
afterEach(async () => { await env?.close(); env = undefined as any; });

const HOUR = 3_600_000;
const post = (id: string, title: string) => ({ kind: 't3', data: { id, title, author: `user_${id}`, subreddit: 'sales', permalink: `/r/sales/comments/${id}/${title.toLowerCase().replace(/\W+/g, '_')}/`, is_self: true, score: 3, num_comments: 1, created_utc: 1760000000 } });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('watcher mode', () => {
  it('re-runs a server-side Reddit scrape on schedule and adds only new posts, with alerts', async () => {
    let listing = [post('aaa1', 'First'), post('bbb2', 'Second')];
    const calls: { url: string; init: any }[] = [];
    env = await makeEnv({
      now: new Date('2026-10-12T10:00:00Z'),
      fetch: (async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        if (String(url).startsWith('https://www.reddit.com/')) return new Response(JSON.stringify({ kind: 'Listing', data: { after: null, children: listing } }), { status: 200 });
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    });
    const job = (await env.api('POST', '/api/automations/jobs', {
      phantom: 'reddit.subreddit_posts', name: 'r/sales watcher', params: { subreddit: 'r/sales', sort: 'new', limit: 50 },
      schedule: { every: 'daily' }, alerts: { webhook_url: 'https://hooks.example/new' },
    })).body.data;
    expect(job).toMatchObject({ status: 'running', watcher: true, schedule: { every: 'daily' }, runner: 'server' });

    await companionTick(env.ctx);
    await settle();
    let j = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(j.status).toBe('completed');
    expect(j.results_count).toBe(2);
    expect(j.runs[0]).toMatchObject({ results: 2, new_results: 2 });
    const next = Date.parse(j.next_run_at) - env.clock.now.getTime();
    expect(next).toBeGreaterThan(0.89 * 24 * HOUR);
    expect(next).toBeLessThan(1.11 * 24 * HOUR);
    const redditCall = calls.find((c) => c.url.includes('reddit.com'))!;
    expect(redditCall.url).toContain('/r/sales/new.json');
    expect(redditCall.init.headers['user-agent']).toContain('kinetic-companion');
    expect(calls.filter((c) => c.url === 'https://hooks.example/new')).toHaveLength(1);

    // Not due yet: nothing happens.
    advance(env, 12 * HOUR);
    await companionTick(env.ctx);
    expect((await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data.runs).toHaveLength(1);

    // Next day (past the up-to-11% schedule jitter): one old post, one new.
    listing = [post('bbb2', 'Second'), post('ccc3', 'Third')];
    advance(env, 16 * HOUR);
    await companionTick(env.ctx);
    await settle();
    j = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(j.runs).toHaveLength(2);
    expect(j.runs[0]).toMatchObject({ status: 'completed', results: 2, new_results: 1 });
    expect(j.results_count).toBe(3);
    const table = (await env.api('GET', `/api/gtm/tables/${job.table_id}`)).body;
    expect(table.rows).toHaveLength(3);
    const alerts = calls.filter((c) => c.url === 'https://hooks.example/new');
    expect(alerts).toHaveLength(2);
    const payload = JSON.parse(alerts[1]!.init.body);
    expect(payload.new_results).toBe(1);
    expect(payload.records[0].title).toBe('Third');

    // Third run with nothing new: no alert.
    advance(env, 30 * HOUR);
    await companionTick(env.ctx);
    await settle();
    expect(calls.filter((c) => c.url === 'https://hooks.example/new')).toHaveLength(2);
    const events = env.ctx.db.all(`SELECT data FROM events WHERE type = 'COMPANION_JOB_COMPLETED'`);
    expect(events).toHaveLength(3);
  });

  it('post monitor: new engagers only, LINKEDIN_POST_ENGAGER per new engager', async () => {
    env = await makeEnv({ now: new Date('2026-10-12T10:00:00Z') });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const job = (await env.api('POST', '/api/automations/jobs', {
      phantom: 'linkedin.post_monitor', params: { targets: 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/' }, schedule: { every: 'hourly' },
    })).body.data;
    const eng = (name: string, engagement: string) => ({ fullName: name, profileUrl: `https://www.linkedin.com/in/${name.toLowerCase()}/`, engagement, postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/' });

    const runOnce = async (records: any[]) => {
      const t = (await ext('POST', '/api/companion/poll', {})).body.task;
      expect(t.kind).toBe('linkedin.post_monitor');
      const r = (await ext('POST', `/api/companion/tasks/${t.id}/results`, { records })).body;
      await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done' });
      return r;
    };
    expect(await runOnce([eng('Ann', 'reaction'), eng('Bob', 'comment')])).toMatchObject({ accepted: 2, new: 2 });
    // The same engager reacting AND commenting counts as two engagements; repeats are dropped.
    advance(env, 1.2 * HOUR);
    await companionTick(env.ctx);
    expect(await runOnce([eng('Ann', 'reaction'), eng('Bob', 'comment'), eng('Ann', 'comment'), eng('Cy', 'reaction')])).toMatchObject({ accepted: 4, new: 2 });
    expect(env.ctx.db.all(`SELECT * FROM events WHERE type = 'LINKEDIN_POST_ENGAGER'`)).toHaveLength(4);
    const table = (await env.api('GET', `/api/gtm/tables/${job.table_id}`)).body;
    expect(table.rows).toHaveLength(4);
  });

  it('dedupes against an existing table column too', async () => {
    env = await makeEnv({ now: new Date('2026-10-12T10:00:00Z') });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    const tableId = (await env.api('POST', '/api/gtm/tables', { name: 'Prospects', template: 'blank' })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/rows`, { rows: [{ 'LinkedIn URL': 'https://www.linkedin.com/in/known/' }] });
    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.search_export', table_id: tableId, params: { search_url: 'https://www.linkedin.com/search/results/people/?keywords=x', limit: 10 } });
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    const r = (await ext('POST', `/api/companion/tasks/${t.id}/results`, { records: [{ fullName: 'Known', profileUrl: 'https://www.linkedin.com/in/known/' }, { fullName: 'New', profileUrl: 'https://www.linkedin.com/in/new/' }] })).body;
    expect(r).toMatchObject({ accepted: 2, new: 1 });
  });
});

describe('message rendering', () => {
  it('fills variables, spins spintax deterministically, inserts the AI line and trims to the note limit', async () => {
    const settings = { has: () => false, get: () => undefined } as any;
    const profile = { fullName: 'Jane Q. Doe', company: 'Acme', profileUrl: 'https://www.linkedin.com/in/jane/' };
    const a = await renderMessage({ template: '{Hi|Hello} {first_name} — {ai_message} {Your Col}', profile, row: { 'Your Col': 'ps' }, settings, ai: async () => 'loved your pricing post.' });
    expect(a.text).toMatch(/^(Hi|Hello) Jane — loved your pricing post\. ps$/);
    expect(a.aiUsed).toBe(true);
    const b = await renderMessage({ template: '{Hi|Hello} {first_name} — {ai_message} {Your Col}', profile, row: { 'Your Col': 'ps' }, settings, ai: async () => 'loved your pricing post.' });
    expect(b.text).toBe(a.text);
    const blank = await renderMessage({ template: 'Hi {first_name}, saw {title} at {company}.', profile: { fullName: 'Sam' }, settings });
    expect(blank.text).toBe('Hi Sam, saw at.');
    expect(blank.missing).toEqual(['title', 'company']);
    await expect(renderMessage({ template: '{ai_message}', settings })).rejects.toThrow(/OPENROUTER_API_KEY/);
    const long = await renderMessage({ template: 'word '.repeat(100), settings, maxLength: 300 });
    expect(long.text.length).toBeLessThanOrEqual(300);
  });

  it('renders {ai_message} through OpenRouter for the extension', async () => {
    env = await makeEnv({
      now: new Date('2026-10-12T10:00:00Z'),
      fetch: (async (url: any) => {
        if (String(url).includes('openrouter.ai/api/v1/chat/completions')) {
          return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ message: 'your talk on PLG was great.' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        }
        return new Response('{}');
      }) as typeof fetch,
    });
    await env.api('PUT', '/api/gtm/keys', { OPENROUTER_API_KEY: 'sk-or-test' });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    await env.api('POST', '/api/automations/jobs', { phantom: 'linkedin.auto_connect', params: { targets: 'https://www.linkedin.com/in/jane/', note: 'Hi {first_name}, {ai_message}' }, start: true });
    const t = (await ext('POST', '/api/companion/poll', {})).body.task;
    expect(t.params.note).toBe('Hi {first_name}, {ai_message}');
    const r = await ext('POST', `/api/companion/tasks/${t.id}/render`, { template: t.params.note, profile: { fullName: 'Jane Doe', headline: 'VP Growth' } });
    expect(r.body).toEqual({ text: 'Hi Jane, your talk on PLG was great.' });
  });
});
