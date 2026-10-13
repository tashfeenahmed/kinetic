import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

describe('mailboxes tagged Warmup stay out of the inbox', () => {
  function seed() {
    const db = env.ctx.db;
    const work = db.insert('sender_emails', { workspace_id: 1, name: 'Sales', email: 'sales@north.example' });
    const warm = db.insert('sender_emails', { workspace_id: 1, name: 'Warm', email: 'warm@south.example' });
    const lead = db.insert('leads', { workspace_id: 1, email: 'buyer@client.example' });
    const at = env.ctx.now().toISOString();
    const reply = (sender: number, n: number) => db.insert('replies', {
      workspace_id: 1, sender_email_id: sender, lead_id: lead, thread_id: db.insert('threads', { workspace_id: 1, sender_email_id: sender, lead_id: lead }), message_id: `r${n}@x`, from_email: 'buyer@client.example', subject: `s${n}`, received_at: at,
    });
    const sent = (sender: number, n: number) => db.insert('sent_emails', {
      workspace_id: 1, kind: 'manual', sender_email_id: sender, lead_id: lead, message_id: `s${n}@x`, to_email: 'buyer@client.example', subject: `s${n}`, sent_at: at,
    });
    return { work, warm, lead, workReply: reply(work, 1), warmReply: reply(warm, 2), workSent: sent(work, 1), warmSent: sent(warm, 2) };
  }

  async function tag(name: string, senderId: number) {
    const t = await env.api('POST', '/api/tags', { name });
    await env.api('POST', '/api/tags/attach-to-sender-emails', { tag_ids: [t.body.data.id], sender_email_ids: [senderId] });
  }

  it('shows every mailbox until one is tagged', async () => {
    seed();
    const list = await env.api('GET', '/api/replies');
    expect(list.body.data).toHaveLength(2);
    expect(list.body.counts.unread_inbox).toBe(2);
  });

  it('hides a warmup mailbox from lists, counts and direct links', async () => {
    const s = seed();
    await tag('Warm-up', s.warm);

    const list = await env.api('GET', '/api/replies');
    expect(list.body.data.map((r: any) => r.id)).toEqual([s.workReply]);
    expect(list.body.counts.unread_inbox).toBe(1);
    expect((await env.api('GET', `/api/replies?sender_email_id=${s.warm}`)).body.data).toHaveLength(0);
    expect((await env.api('GET', `/api/replies/${s.warmReply}`)).status).toBe(404);
    expect((await env.api('GET', `/api/replies/${s.warmReply}/conversation-thread`)).status).toBe(404);

    expect((await env.api('GET', '/api/sent-emails')).body.data.map((r: any) => r.id)).toEqual([s.workSent]);
    expect((await env.api('GET', `/api/sent-emails/${s.warmSent}`)).status).toBe(404);

    expect((await env.api('GET', `/api/leads/${s.lead}/replies`)).body.data.map((r: any) => r.id)).toEqual([s.workReply]);
    expect((await env.api('GET', `/api/leads/${s.lead}/sent-emails`)).body.data.map((r: any) => r.id)).toEqual([s.workSent]);
    expect((await env.api('GET', `/api/sender-emails/${s.warm}/replies`)).body.data).toHaveLength(0);
  });

  it('shows the mail again once the tag is removed', async () => {
    const s = seed();
    await tag('warmup', s.warm);
    expect((await env.api('GET', '/api/replies')).body.data).toHaveLength(1);
    const t = (await env.api('GET', '/api/tags')).body.data.find((x: any) => x.name === 'warmup');
    await env.api('POST', '/api/tags/remove-from-sender-emails', { tag_ids: [t.id], sender_email_ids: [s.warm] });
    expect((await env.api('GET', '/api/replies')).body.data).toHaveLength(2);
  });
});
