import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { setSetting } from '../src/settings.ts';
import { encrypt } from '../src/lib/crypto.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

describe('reconnecting a Microsoft mailbox', () => {
  it('starts sign-in for that mailbox, with its address pre-filled', async () => {
    setSetting(env.ctx.db, 'microsoft_client_id', 'cid');
    setSetting(env.ctx.db, 'microsoft_client_secret', 'secret', { secret: true });
    const id = env.ctx.db.insert('sender_emails', { workspace_id: 1, name: 'Sam', email: 'sam@north.example', provider: 'microsoft', auth_type: 'oauth', username: 'sam@north.example', secret_enc: encrypt('rt'), status: 'Disconnected' });
    const r = await env.api('POST', '/api/oauth-sessions/microsoft', { sender_email_id: id });
    expect(r.status).toBe(200);
    const url = new URL(r.body.data.url);
    expect(url.searchParams.get('login_hint')).toBe('sam@north.example');
    expect(url.searchParams.get('client_id')).toBe('cid');
  });

  it('refuses a mailbox from another workspace', async () => {
    setSetting(env.ctx.db, 'microsoft_client_id', 'cid');
    setSetting(env.ctx.db, 'microsoft_client_secret', 'secret', { secret: true });
    const r = await env.api('POST', '/api/oauth-sessions/microsoft', { sender_email_id: 9999 });
    expect(r.status).toBe(404);
  });
});
