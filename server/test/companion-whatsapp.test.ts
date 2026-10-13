import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { pairExtension, openSettings, advance } from './companion-helpers.ts';
import { normPhone, detectKind } from '../src/sourcing/normalize.ts';

let env: TestEnv;
afterEach(async () => { await env?.close(); env = undefined as any; });

const MONDAY_10 = new Date('2026-10-12T10:00:00Z');

describe('phone numbers (E.164)', () => {
  it('normalises international and local numbers', () => {
    expect(normPhone('+49 (0)151 2345-678')).toBe('+491512345678');
    expect(normPhone('0049 151 2345678')).toBe('+491512345678');
    expect(normPhone('tel:+1 (415) 555-0100')).toBe('+14155550100');
    expect(normPhone('0151 2345678')).toBe(''); // no country code
    expect(normPhone('0151 2345678', '+49')).toBe('+491512345678');
    expect(normPhone('491512345678')).toBe('+491512345678');
    expect(normPhone('415 555 0100', '1')).toBe('+14155550100');
    expect(normPhone('12345')).toBe('');
    expect(normPhone('call me')).toBe('');
    expect(detectKind('+44 20 7946 0958')).toBe('phone');
    expect(detectKind('acme.com')).toBe('domain');
  });
});

describe('WhatsApp message sender (Companion)', () => {
  it('queues one task per valid number, skips opt-outs, and runs under its own daily limit', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env, { limits: { 'whatsapp.message': { daily: 2 } } });
    const stats = (await env.api('GET', '/api/automations/stats')).body.data;
    expect(stats.limits.find((l: any) => l.action === 'whatsapp.message')).toMatchObject({ daily: 2 });
    const phantoms = (await env.api('GET', '/api/automations/phantoms')).body.data;
    expect(phantoms.find((p: any) => p.id === 'whatsapp.message_sender')).toMatchObject({ site: 'whatsapp', runner: 'extension', action: 'whatsapp.message', sends: true });

    // A table of contacts: valid, local (needs the country code), invalid, opted out by email, by phone, a duplicate, an unselected row.
    const t = (await env.api('POST', '/api/gtm/tables', { name: 'Shops' })).body.id;
    await env.api('POST', `/api/gtm/tables/${t}/rows`, { rows: [
      { Name: 'Ana Silva', Phone: '+49 151 1111111', Shop: 'Ana Bakes' },
      { Name: 'Ben Kurz', Phone: '0151 2222222', Shop: 'Kurz Kaffee' },
      { Name: 'Cara', Phone: 'n/a', Shop: 'C' },
      { Name: 'Dan', Phone: '+49 151 3333333', Email: 'dan@stop.test', Shop: 'D' },
      { Name: 'Eve', Phone: '+49 151 4444444', Shop: 'E' },
      { Name: 'Ana again', Phone: '0049 151 1111111', Shop: 'A2' },
      { Name: 'Not selected', Phone: '+49 151 5555555', Shop: 'X' },
    ] });
    await env.api('POST', '/api/blacklisted-emails', { email: 'dan@stop.test' });
    const dnc = (await env.api('POST', '/api/exclusions', { name: 'Replied STOP' })).body.id;
    expect((await env.api('POST', `/api/exclusions/${dnc}/entries`, { text: '+49 151 4444444' })).body).toMatchObject({ added: 1 });

    const rowIds = env.ctx.gtm!.store.rowIds(t).slice(0, 6);
    const created = await env.api('POST', '/api/automations/jobs', {
      phantom: 'whatsapp.message_sender', name: 'Shops',
      params: { targets: { table_id: t, column: 'Phone', row_ids: rowIds }, message: 'Hi {first_name}, love {Shop}! Reply STOP to opt out.', country_code: '49' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const job = created.body.data;
    expect(job.status).toBe('draft'); // sends: never starts by itself
    const started = (await env.api('POST', `/api/automations/jobs/${job.id}/start`)).body.data;
    expect(started.tasks).toMatchObject({ pending: 2, skipped: 4 });
    const tasks = env.ctx.db.all('SELECT target, status, error FROM companion_tasks WHERE job_id = ? ORDER BY id', [job.id])
      .map((x) => ({ phone: JSON.parse(x.target).phone, status: x.status, error: x.error }));
    expect(tasks).toEqual([
      { phone: '+491511111111', status: 'pending', error: null },
      { phone: '+491512222222', status: 'pending', error: null },
      { phone: 'n/a', status: 'skipped', error: 'invalid_phone' },
      { phone: '+491513333333', status: 'skipped', error: 'opted_out' },
      { phone: '+491514444444', status: 'skipped', error: 'opted_out' },
      { phone: '+491511111111', status: 'skipped', error: 'duplicate' },
    ]);
    // Skipped numbers are visible in the results table with the reason.
    const out = env.ctx.gtm!.store;
    const outCols = out.columns(job.table_id);
    const statusCol = outCols.find((c) => c.name === 'Detail')!;
    const details = out.rowIds(job.table_id).map((id) => out.rowValues(id, outCols)[statusCol.name]);
    expect(details).toContain('Opted out (blacklist, exclusion list or unsubscribed)');

    // Only a browser that offers WhatsApp gets the task; it opens the chat URL with digits only.
    expect((await ext('POST', '/api/companion/poll', { sites: ['linkedin'] })).body.task).toBeNull();
    const t1 = (await ext('POST', '/api/companion/poll', { sites: ['whatsapp'] })).body.task;
    expect(t1).toMatchObject({ kind: 'whatsapp.message_sender', site: 'whatsapp', openUrl: 'https://web.whatsapp.com/send?phone=491511111111', budget: 1 });
    expect(t1.target).toMatchObject({ phone: '+491511111111', name: 'Ana Silva' });
    // The worker renders the message (row columns as variables) before opening the chat.
    const r = await ext('POST', `/api/companion/tasks/${t1.id}/render`, { profile: { fullName: t1.target.name } });
    expect(r.body.text).toBe('Hi Ana, love Ana Bakes! Reply STOP to opt out.');
    await ext('POST', `/api/companion/tasks/${t1.id}/results`, { records: [{ phone: '+491511111111', status: 'sent', sentText: r.body.text, at: MONDAY_10.toISOString() }] });
    await ext('POST', `/api/companion/tasks/${t1.id}/complete`, { status: 'done', result: { sentText: r.body.text }, actions: 1 });

    // Human pace: the next message waits for the pacing gap.
    expect((await ext('POST', '/api/companion/poll', { sites: ['whatsapp'] })).body.reason).toBe('pacing delay between actions');
    advance(env, 60_000);
    const t2 = (await ext('POST', '/api/companion/poll', { sites: ['whatsapp'] })).body.task;
    expect(t2.target.phone).toBe('+491512222222');
    // Not on WhatsApp: the task is skipped (no action counted) with a clear error.
    await ext('POST', `/api/companion/tasks/${t2.id}/complete`, { status: 'skipped', error: 'not_on_whatsapp', result: { reason: 'not_on_whatsapp' }, actions: 0 });
    expect(env.ctx.db.get('SELECT status, error FROM companion_tasks WHERE id = ?', [t2.id])).toEqual({ status: 'skipped', error: 'not_on_whatsapp' });
    const usage = (await env.api('GET', '/api/automations/stats')).body.data.limits.find((l: any) => l.action === 'whatsapp.message');
    expect(usage.used_today).toBe(1);
    const done = (await env.api('GET', `/api/automations/jobs/${job.id}`)).body.data;
    expect(done.status).toBe('completed');
  });

  it('stops at the daily WhatsApp limit (20 by default)', async () => {
    env = await makeEnv({ now: MONDAY_10 });
    const { ext } = await pairExtension(env);
    await openSettings(env);
    expect((await env.api('GET', '/api/automations/settings')).body.data.limits['whatsapp.message']).toMatchObject({ daily: 20 });
    const numbers = Array.from({ length: 21 }, (_, i) => `+44 7700 9${String(i).padStart(5, '0')}`).join('\n');
    const job = (await env.api('POST', '/api/automations/jobs', { phantom: 'whatsapp.message_sender', params: { targets: numbers, message: 'Hello!' }, start: true })).body.data;
    expect(job.tasks.pending).toBe(21);
    for (let i = 0; i < 20; i++) {
      const t = (await ext('POST', '/api/companion/poll', { sites: ['whatsapp'] })).body.task;
      expect(t, `task ${i}`).toBeTruthy();
      await ext('POST', `/api/companion/tasks/${t.id}/complete`, { status: 'done', actions: 1 });
      advance(env, 10_000);
    }
    const capped = (await ext('POST', '/api/companion/poll', { sites: ['whatsapp'] })).body;
    expect(capped.task).toBeNull();
    expect(capped.reason).toMatch(/whatsapp\.message limit reached/);
  });
});
