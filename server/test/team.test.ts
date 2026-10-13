import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

/** A browser: keeps the session cookie between requests. */
function browser() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown) => {
    const res = await env.app.inject({ method: method as any, url, headers: cookie ? { cookie } : {}, payload: body as any });
    const set = res.headers['set-cookie'];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
    return { status: res.statusCode, body: res.json(), cookie: set };
  };
}

async function signIn(email: string, password: string) {
  const b = browser();
  const r = await b('POST', '/api/auth/login', { email, password });
  return { b, r };
}

describe('team onboarding', () => {
  // makeEnv already ran first-run setup: admin@bear.test / password123 is the admin.
  it('only the first account comes from setup, and it is the admin', async () => {
    expect((await browser()('GET', '/api/auth/status')).body.data.needs_setup).toBe(false);
    const again = await browser()('POST', '/api/auth/setup', { name: 'X', email: 'x@acme.test', password: 'password123' });
    expect(again.status).toBe(409);
    const { r } = await signIn('admin@bear.test', 'password123');
    expect(r.body.data.role).toBe('admin');
  });

  it('admins add admins, editors and viewers who sign in, choose a password and get their role', async () => {
    const { b: owner } = await signIn('admin@bear.test', 'password123');
    for (const role of ['admin', 'editor', 'viewer']) {
      const r = await owner('POST', '/api/workspaces/v1.1/users', { name: `${role} person`, email: ` ${role.toUpperCase()}@Acme.test `, password: 'temp-pass-1', role });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data).toMatchObject({ email: `${role}@acme.test`, role, temporary_password_set: true });
    }
    const members = (await owner('GET', '/api/workspaces/1')).body.data.members;
    expect(members.find((m: any) => m.email === 'viewer@acme.test').pending).toBe(true);

    // Email in any case, with stray spaces.
    const { b: admin, r } = await signIn(' Admin@ACME.test', 'temp-pass-1');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ role: 'admin', must_change_password: true });
    // First password choice doesn't ask for the temporary one again; it can't be reused.
    expect((await admin('PUT', '/api/users/password', { password: 'temp-pass-1', password_confirmation: 'temp-pass-1' })).status).toBe(422);
    expect((await admin('PUT', '/api/users/password', { password: 'my-own-pass', password_confirmation: 'my-own-pass' })).status).toBe(200);
    expect((await admin('GET', '/api/users')).body.data.must_change_password).toBe(false);
    expect((await signIn('admin@acme.test', 'temp-pass-1')).r.status).toBe(422);
    expect((await signIn('admin@acme.test', 'my-own-pass')).r.status).toBe(200);

    // A second admin can add people too; editors and viewers can't.
    expect((await admin('POST', '/api/workspaces/v1.1/users', { name: 'Two', email: 'two@acme.test', password: 'temp-pass-1' })).status).toBe(200);
    const { b: editor } = await signIn('editor@acme.test', 'temp-pass-1');
    expect((await editor('POST', '/api/workspaces/v1.1/users', { name: 'X', email: 'x@acme.test', password: 'temp-pass-1' })).status).toBe(403);
    expect((await editor('POST', '/api/campaigns', { name: 'Editors can work' })).status).toBe(200);
    const { b: viewer } = await signIn('viewer@acme.test', 'temp-pass-1');
    expect((await viewer('POST', '/api/campaigns', { name: 'nope' })).status).toBe(403);
    expect((await viewer('POST', '/api/workspaces', { name: 'nope' })).status).toBe(403);
    expect((await viewer('GET', '/api/campaigns')).status).toBe(200);
  });

  it('admins reset a password; removed people can no longer sign in', async () => {
    const { b: owner } = await signIn('admin@bear.test', 'password123');
    const added = (await owner('POST', '/api/workspaces/v1.1/users', { name: 'Ed', email: 'ed@acme.test', password: 'temp-pass-1', role: 'editor' })).body.data;
    const { b: ed } = await signIn('ed@acme.test', 'temp-pass-1');
    await ed('PUT', '/api/users/password', { password: 'eds-password', password_confirmation: 'eds-password' });

    expect((await owner('PUT', `/api/workspaces/members/${added.id}/password`, { password: 'reset-pass-2' })).status).toBe(200);
    expect((await ed('GET', '/api/users')).status).toBe(401); // signed out everywhere
    const again = await signIn('ed@acme.test', 'reset-pass-2');
    expect(again.r.body.data.must_change_password).toBe(true);

    expect((await owner('POST', '/api/workspaces/v1.1/users', { name: 'Ed', email: 'ed@acme.test', password: 'temp-pass-1' })).status).toBe(422); // already a member
    expect((await owner('DELETE', `/api/workspaces/members/${added.id}`)).status).toBe(200);
    expect((await again.b('GET', '/api/users')).status).toBe(401);
    const blocked = await signIn('ed@acme.test', 'reset-pass-2');
    expect(blocked.r.status).toBe(403);
    expect(blocked.r.body.error).toBe('no_workspace');
    expect(blocked.r.cookie).toBeUndefined();

    // Added back later: the new temporary password applies.
    const back = await owner('POST', '/api/workspaces/v1.1/users', { name: 'Ed', email: 'ed@acme.test', password: 'welcome-back', role: 'viewer' });
    expect(back.body.data).toMatchObject({ existing_account: false, temporary_password_set: true });
    expect((await signIn('ed@acme.test', 'welcome-back')).r.body.data.role).toBe('viewer');
  });

  it("someone already in another workspace keeps their own password when added", async () => {
    const { b: owner } = await signIn('admin@bear.test', 'password123');
    await owner('POST', '/api/workspaces/v1.1/users', { name: 'Sam', email: 'sam@acme.test', password: 'sams-pass-1', role: 'admin' });
    const { b: sam } = await signIn('sam@acme.test', 'sams-pass-1');
    const ws2 = (await sam('POST', '/api/workspaces', { name: 'Second' })).body.data;
    await sam('POST', '/api/workspaces/switch-workspace', { team_id: ws2.id });
    const r = await sam('POST', '/api/workspaces/v1.1/users', { name: 'Owner', email: 'admin@bear.test', password: 'ignored-pass', role: 'editor' });
    expect(r.body.data).toMatchObject({ existing_account: true, temporary_password_set: false, name: 'Test Admin' });
    expect((await signIn('admin@bear.test', 'password123')).r.status).toBe(200);
  });
});
