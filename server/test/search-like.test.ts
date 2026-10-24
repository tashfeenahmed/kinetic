import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { LIKE_ESCAPE, contains } from '../src/lib/like.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

describe('LIKE escaping helper', () => {
  it('escapes the wildcards and the escape character', () => {
    expect(contains('a_b')).toBe('%a\\_b%');
    expect(contains('100%')).toBe('%100\\%%');
    expect(contains('back\\slash')).toBe('%back\\\\slash%');
    expect(contains('plain')).toBe('%plain%');
  });
});

/** Every search box builds `LIKE ? ESCAPE '\'` from user text: a `%` or `_`
 *  typed into the box must match itself, not act as a wildcard. */
describe('search boxes treat % and _ as characters', async () => {
  it('leads: a search for "a_b" does not match "axb"', async () => {
    await env.api('POST', '/api/leads', { email: 'a_b@x.test' });
    await env.api('POST', '/api/leads', { email: 'axb@x.test' });
    await env.api('POST', '/api/leads', { email: 'sale-100%@x.test' });
    await env.api('POST', '/api/leads', { email: 'sale-100-x@x.test' });

    const underscore = await env.api('GET', '/api/leads?search=a_b');
    expect(underscore.status).toBe(200);
    expect(underscore.body.data.map((l: any) => l.email)).toEqual(['a_b@x.test']);

    const percent = await env.api('GET', '/api/leads?search=100%25');
    expect(percent.status).toBe(200);
    expect(percent.body.data.map((l: any) => l.email)).toEqual(['sale-100%@x.test']);

    // A lone "%" is no longer a match-everything query.
    const alone = await env.api('GET', '/api/leads?search=%25');
    expect(alone.body.data).toHaveLength(1);
  });

  it('campaigns: a search for "50% off" only matches the name carrying it', async () => {
    const mk = async (name: string) => {
      const r = await env.api('POST', '/api/campaigns', { name, sender_email_ids: [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await mk('Spring 50% off');
    await mk('Spring 50 pct');

    const hit = await env.api('GET', '/api/campaigns?search=50%25%20off');
    expect(hit.status).toBe(200);
    expect(hit.body.data.map((c: any) => c.name)).toEqual(['Spring 50% off']);

    const none = await env.api('GET', '/api/campaigns?search=50%25');
    expect(none.body.data).toHaveLength(1);
  });

  it('blacklist search: "a_b" does not match "axb@example.com"', async () => {
    await env.api('POST', '/api/blacklisted-emails', { email: 'a_b@example.com' });
    await env.api('POST', '/api/blacklisted-emails', { email: 'axb@example.com' });
    const r = await env.api('GET', '/api/blacklisted-emails?search=a_b');
    expect(r.status).toBe(200);
    expect(r.body.data.map((e: any) => e.email)).toEqual(['a_b@example.com']);
  });

  it('senders: "a_b" does not match "axb"', async () => {
    // Sender rows are inserted directly; connecting a mailbox needs SMTP.
    const ws = env.ctx.db.get('SELECT id FROM workspaces ORDER BY id LIMIT 1')!;
    for (const email of ['a_b@send.test', 'axb@send.test'])
      env.ctx.db.insert('sender_emails', { workspace_id: ws.id, email, name: email, status: 'Disconnected' });
    const r = await env.api('GET', '/api/sender-emails?search=a_b');
    expect(r.status).toBe(200);
    expect(r.body.data.map((s: any) => s.email)).toEqual(['a_b@send.test']);
  });
});
