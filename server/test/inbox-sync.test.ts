import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail, makeEnv, type TestEnv } from './helpers.ts';
import { syncSender } from '../src/engine/inbox.ts';
import { syncWorkspace } from '../src/engine/syncAll.ts';
import type { Row } from '../src/db/db.ts';

const NOW = new Date('2026-10-12T14:00:00Z');

/** FakeMail with a tiny in-memory IMAP server per mailbox (INBOX only). */
class ImapFakeMail extends FakeMail {
  boxes = new Map<string, { uid: number; source: Buffer }[]>();
  failing = new Set<string>();
  hanging = new Set<string>();
  sessions = 0;

  deliver(to: string, from: string, subject: string, body: string) {
    const box = this.boxes.get(to) ?? [];
    const uid = box.length + 1;
    const raw = [`Message-ID: <m${uid}.${to}>`, `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: Mon, 12 Oct 2026 13:00:00 +0000`, '', body].join('\r\n');
    box.push({ uid, source: Buffer.from(raw) });
    this.boxes.set(to, box);
  }

  // FakeMail declares withImap without parameters, hence the rest args.
  override async withImap<T>(...args: any[]): Promise<T> {
    const [sender, fn] = args as [Row, (client: any) => Promise<T>];
    this.sessions++;
    if (this.failing.has(sender.email)) throw new Error('Connection refused by imap.broken.test');
    if (this.hanging.has(sender.email)) await new Promise((r) => setTimeout(r, 500));
    const box = this.boxes.get(sender.email) ?? [];
    const client = {
      mailbox: { uidValidity: 1, uidNext: box.length + 1 },
      list: async () => [{ path: 'INBOX' }],
      getMailboxLock: async () => ({ release() {} }),
      search: async (q: any) => {
        if (q.uid) { const from = Number(String(q.uid).split(':')[0]); return box.filter((m) => m.uid >= from).map((m) => m.uid); }
        return box.map((m) => m.uid);
      },
      fetch: async function* (uids: number[]) { for (const m of box) if (uids.includes(m.uid)) yield m; },
    };
    return fn(client);
  }
}

let env: TestEnv;
let mail: ImapFakeMail;

beforeEach(async () => {
  mail = new ImapFakeMail();
  env = await makeEnv({ mail, now: NOW });
});
afterEach(() => env.close());

async function addSender(email: string) {
  const r = await env.api('POST', '/api/sender-emails/imap-smtp', { name: `Box ${email}`, email, password: 'app-password', provider: 'google' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

describe('POST /api/replies/sync', () => {
  it('fetches new mail from every connected mailbox and reports totals', async () => {
    await addSender('a@one.test');
    await addSender('b@two.test');
    const paused = await addSender('c@three.test');
    await env.api('PATCH', `/api/sender-emails/${paused.id}/pause`);
    mail.deliver('a@one.test', 'Pat <pat@client.test>', 'Hello', 'Hi there');
    mail.deliver('a@one.test', 'Sam <sam@client.test>', 'Question', 'Pricing?');
    mail.deliver('b@two.test', 'Kim <kim@client.test>', 'Hey', 'Ping');
    mail.deliver('c@three.test', 'Lee <lee@client.test>', 'Paused', 'Not synced');

    const before = await env.api('GET', '/api/replies?folder=inbox');
    expect(before.body.data).toHaveLength(0);

    const r = await env.api('POST', '/api/replies/sync', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.totals).toEqual({ mailboxes: 2, synced: 2, new_messages: 3, errors: 0 });
    expect(r.body.data.mailboxes.map((m: any) => [m.email, m.status, m.new_messages])).toEqual([['a@one.test', 'synced', 2], ['b@two.test', 'synced', 1]]);
    expect(r.body.data.last_synced_at).toBe(NOW.toISOString());

    const after = await env.api('GET', '/api/replies?folder=inbox');
    expect(after.body.data.map((x: any) => x.from_email).sort()).toEqual(['kim@client.test', 'pat@client.test', 'sam@client.test']);

    // Second call: nothing new.
    mail.deliver('b@two.test', 'Kim <kim@client.test>', 'Again', 'Follow-up');
    const again = await env.api('POST', '/api/replies/sync', {});
    expect(again.body.data.totals.new_messages).toBe(1);
    const third = await env.api('POST', '/api/replies/sync', {});
    expect(third.body.data.totals).toMatchObject({ new_messages: 0, errors: 0 });

    const status = await env.api('GET', '/api/replies/sync-status');
    expect(status.body.data).toEqual({ last_synced_at: NOW.toISOString(), mailboxes: 2, syncing: false });
  });

  it('reports a failing mailbox without failing the others', async () => {
    await addSender('good@one.test');
    await addSender('bad@broken.test');
    mail.failing.add('bad@broken.test');
    mail.deliver('good@one.test', 'Pat <pat@client.test>', 'Hello', 'Hi');

    const r = await env.api('POST', '/api/replies/sync', {});
    expect(r.status).toBe(200);
    expect(r.body.data.totals).toEqual({ mailboxes: 2, synced: 1, new_messages: 1, errors: 1 });
    const bad = r.body.data.mailboxes.find((m: any) => m.email === 'bad@broken.test');
    expect(bad).toMatchObject({ status: 'error', name: 'Box bad@broken.test', new_messages: 0 });
    expect(bad.error).toContain('Connection refused');
  });

  it('times out a stuck mailbox and shares an in-flight pass with the background sync', async () => {
    const s = await addSender('slow@one.test');
    await addSender('fast@two.test');
    mail.hanging.add('slow@one.test');
    mail.deliver('slow@one.test', 'Pat <pat@client.test>', 'Hello', 'Hi');

    // Background job already syncing the slow mailbox: the manual sync joins it (one IMAP session).
    const row = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [s.id])!;
    const bg = syncSender(env.ctx, row);
    const res = await syncWorkspace(env.ctx, row.workspace_id, { timeoutMs: 50 });
    expect(res.mailboxes.find((m) => m.email === 'slow@one.test')?.status).toBe('timeout');
    expect(res.mailboxes.find((m) => m.email === 'fast@two.test')?.status).toBe('synced');
    expect(await bg).toBe(1);
    expect(mail.sessions).toBe(2);
  });
});
