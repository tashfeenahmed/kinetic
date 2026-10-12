import { describe, it, expect, afterEach } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { makeEnv, type TestEnv } from './helpers.ts';
import { pairExtension } from './companion-helpers.ts';
import { zip } from '../src/companion/zip.ts';

let env: TestEnv;
afterEach(async () => { await env?.close(); env = undefined as any; });

describe('companion pairing and extension auth', () => {
  it('pairs with a one-time code and authenticates the extension by its token', async () => {
    env = await makeEnv();
    const bad = await env.app.inject({ method: 'POST', url: '/api/companion/pair', payload: { code: 'ZZZZ-ZZZZ' } });
    expect(bad.statusCode).toBe(422);

    const code = (await env.api('POST', '/api/companion/pairing-code')).body.data.code as string;
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const ok = await env.app.inject({ method: 'POST', url: '/api/companion/pair', payload: { code: code.toLowerCase(), name: 'Work laptop' } });
    expect(ok.statusCode).toBe(200);
    const { token, device_id, kinetic_url } = ok.json();
    expect(token).toMatch(/^kc_/);
    expect(kinetic_url).toBe('http://bear.test');

    // Codes are single-use.
    const again = await env.app.inject({ method: 'POST', url: '/api/companion/pair', payload: { code } });
    expect(again.statusCode).toBe(422);

    const hb = await env.app.inject({ method: 'POST', url: '/api/companion/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: { version: '0.1.0', accounts: { linkedin: true } } });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().limits.find((l: any) => l.action === 'linkedin.connect')).toMatchObject({ daily: 20, weekly: 100, used_today: 0 });
    expect(hb.headers['access-control-allow-origin']).toBe('*');

    const status = (await env.api('GET', '/api/companion/status')).body.data;
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]).toMatchObject({ id: device_id, name: 'Work laptop', online: true, accounts: { linkedin: true } });

    // The paired token is an ordinary workspace-pinned API token, listed with the others.
    const tokens = (await env.api('GET', '/api/api-tokens')).body.data;
    expect(tokens.some((t: any) => t.name === 'Kinetic Companion · Work laptop')).toBe(true);

    // Unpairing revokes it.
    expect((await env.api('DELETE', `/api/companion/devices/${device_id}`)).status).toBe(200);
    const after = await env.app.inject({ method: 'POST', url: '/api/companion/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(after.statusCode).toBe(401);
  });

  it('rejects unauthenticated and cookie-session callers on extension endpoints; preflight is open', async () => {
    env = await makeEnv();
    const none = await env.app.inject({ method: 'POST', url: '/api/companion/poll', payload: {} });
    expect(none.statusCode).toBe(401);

    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@bear.test', password: 'password123' } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const viaCookie = await env.app.inject({ method: 'POST', url: '/api/companion/poll', headers: { cookie }, payload: {} });
    expect(viaCookie.statusCode).toBe(403);

    const pre = await env.app.inject({ method: 'OPTIONS', url: '/api/companion/poll' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('auto-registers a browser that uses an existing API token, and unpairs itself', async () => {
    env = await makeEnv();
    const tok = (await env.api('POST', '/api/api-tokens', { name: 'my token' })).body.data.plain_text_token;
    const call = (url: string, body: unknown = {}) => env.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${tok}` }, payload: body as any });
    expect((await call('/api/companion/poll')).json()).toMatchObject({ task: null, reason: 'No tasks queued' });
    const me = await env.app.inject({ method: 'GET', url: '/api/companion/me', headers: { authorization: `Bearer ${tok}` } });
    expect(me.json().device.name).toBe('my token');
    expect((await call('/api/companion/unpair')).statusCode).toBe(200);
    expect((await call('/api/companion/poll')).statusCode).toBe(401);
  });

  it('pausing a browser stops it from getting tasks', async () => {
    env = await makeEnv();
    const { ext, deviceId } = await pairExtension(env);
    await env.api('PATCH', `/api/companion/devices/${deviceId}`, { paused: true });
    expect((await ext('POST', '/api/companion/poll', {})).body).toMatchObject({ task: null, reason: 'This browser is paused' });
    await env.api('POST', '/api/companion/pause-all', { paused: true });
    await env.api('PATCH', `/api/companion/devices/${deviceId}`, { paused: false });
    expect((await ext('POST', '/api/companion/poll', {})).body).toMatchObject({ task: null, pausedAll: true });
  });

  it('serves the extension zip only when built; the zip writer produces valid archives', async () => {
    env = await makeEnv();
    const res = await env.app.inject({ method: 'GET', url: '/companion/extension.zip' });
    expect([200, 404]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(res.rawPayload.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);

    const buf = zip([{ name: 'a/hello.txt', data: Buffer.from('hello hello hello') }, { name: 'kinetic.json', data: Buffer.from('{"url":"x"}') }]);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = buf.readUInt16LE(26);
    const size = buf.readUInt32LE(18);
    expect(buf.subarray(30, 30 + nameLen).toString()).toBe('a/hello.txt');
    expect(inflateRawSync(buf.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toBe('hello hello hello');
    const end = buf.subarray(buf.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(2);
  });
});
