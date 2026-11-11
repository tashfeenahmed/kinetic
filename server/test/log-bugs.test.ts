import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { renderInputs } from '../src/gtm/engine/runner.ts';
import { renderValue } from '../src/gtm/lib/template.ts';
import { invalidBody } from '../src/agent/tools.ts';
import { isAmbiguousAuthError, noteAuthFailure } from '../src/engine/sequencer.ts';

describe('column inputs that are not templates', () => {
  it('passes numbers and booleans through instead of crashing', () => {
    const row = { 'Company domain': 'acme.io', Company: 'Acme' };
    expect(renderInputs({ domain: '{{Company domain}}', days: 180 as any, strict: false as any, empty: '' }, row))
      .toEqual({ domain: 'acme.io', days: '180', strict: 'false' });
    expect(renderValue(180 as any, row)).toBe(180);
  });
});

describe('API calls and approvals', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await makeEnv(); });
  afterEach(() => env.close());

  it('deletes table rows given ids or rowIds', async () => {
    const t = (await env.api('POST', '/api/gtm/tables', { name: 'Companies', template: 'companies' })).body.id;
    await env.api('POST', `/api/gtm/tables/${t}/rows`, { rows: [{ Company: 'A' }, { Company: 'B' }, { Company: 'C' }] });
    const rows = (await env.api('GET', `/api/gtm/tables/${t}/rows`)).body.rows as { id: number }[];
    expect((await env.api('DELETE', `/api/gtm/tables/${t}/rows`, { rowIds: [rows[0]!.id] })).status).toBe(200);
    expect((await env.api('DELETE', `/api/gtm/tables/${t}/rows`, { ids: [rows[1]!.id] })).status).toBe(200);
    expect((await env.api('GET', `/api/gtm/tables/${t}/rows`)).body.total).toBe(1);
  });

  it('rejects a bad body before asking for approval, using the most literal route', () => {
    expect(invalidBody('DELETE', '/api/gtm/tables/12/rows', { rowIds: [1, 2] })).toBeNull();
    expect(invalidBody('DELETE', '/api/gtm/tables/12/rows', { nope: [1] })).toMatch(/^ids: /);
    expect(invalidBody('DELETE', '/api/no-such-route/1', { anything: 1 })).toBeNull();
  });
});

describe('ambiguous login refusals', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await makeEnv({ now: new Date('2026-11-01T10:00:00Z') }); });
  afterEach(() => env.close());

  it('only disconnects on a repeated bare "Login failed.", but at once on a definite refusal', async () => {
    expect(isAmbiguousAuthError(new Error('Login failed.'))).toBe(true);
    expect(isAmbiguousAuthError(new Error('OAuth token error (400): AADSTS50076 Login failed'))).toBe(false);
    const id = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'N', email: 'n@north.test', password: 'pw', provider: 'microsoft', daily_limit: 30 })).body.data.id;
    const row = () => env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [id])!;

    expect(noteAuthFailure(env.ctx, row(), new Error('Login failed.'), 'Login failed.')).toBe(false);
    expect(row().status).toBe('Connected');
    env.clock.now = new Date('2026-11-01T13:00:00Z'); // outside the 2h grace: still just noted
    expect(noteAuthFailure(env.ctx, row(), new Error('Login failed.'), 'Login failed.')).toBe(false);
    env.clock.now = new Date('2026-11-01T13:05:00Z'); // again within the grace: disconnected
    expect(noteAuthFailure(env.ctx, row(), new Error('Login failed.'), 'Login failed.')).toBe(true);
    expect(row().status).toBe('Disconnected');

    env.ctx.db.update('sender_emails', id, { status: 'Connected', auth_failed_at: null });
    const definite = Object.assign(new Error('Invalid login: 535 5.7.3 Authentication unsuccessful'), { responseCode: 535 });
    expect(noteAuthFailure(env.ctx, row(), definite, definite.message)).toBe(true);
    expect(row().status).toBe('Disconnected');
  });
});
