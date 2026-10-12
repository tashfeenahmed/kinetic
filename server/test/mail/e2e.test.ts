/**
 * End-to-end test against a real SMTP/IMAP server (GreenMail).
 * Start it first:  npm run mail:up   (from the repo root)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { makeEnv, openAllDay, type TestEnv } from '../helpers.ts';
import { RealMailGateway } from '../../src/mail/gateway.ts';
import { dispatch, plan } from '../../src/engine/sequencer.ts';
import { syncSender } from '../../src/engine/inbox.ts';
import { dispatchWarmup, planWarmup, WARMUP_FOLDER } from '../../src/engine/warmup.ts';
import { checkPlacementTests } from '../../src/engine/placement.ts';
import { setSetting } from '../../src/settings.ts';

const HOST = '127.0.0.1';
const SMTP_PORT = 3025;
const IMAP_PORT = 3143;
const run = Math.random().toString(36).slice(2, 8); // GreenMail keeps mail between runs; isolate by address
const addr = (local: string, domain: string) => `${local}.${run}@${domain}`;

const reachable = await new Promise<boolean>((resolve) => {
  const s = net.connect(IMAP_PORT, HOST, () => { s.end(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function imap<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: false, auth: { user, pass: 'x' }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout(); }
}

async function fetchAll(user: string, folder = 'INBOX') {
  return imap(user, async (c) => {
    const exists = (await c.list()).some((f) => f.path === folder);
    if (!exists) return [];
    const lock = await c.getMailboxLock(folder);
    try {
      const out = [];
      if (!(c.mailbox as any).exists) return [];
      for await (const m of c.fetch('1:*', { source: true, uid: true })) out.push({ uid: m.uid, parsed: await simpleParser(m.source!) });
      return out;
    } finally { lock.release(); }
  });
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    v = await fn();
  }
  return v;
}

const smtp = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });

describe.skipIf(!reachable)('real mail end-to-end (GreenMail)', () => {
  let env: TestEnv;
  const senders: any[] = [];
  const leadEmails = [addr('jane', 'acme.test'), addr('omar', 'globex.test')];

  beforeAll(async () => {
    env = await makeEnv({ mail: (db) => new RealMailGateway(db) });
    for (const [i, domain] of ['alpha.test', 'bravo.test', 'charlie.test'].entries()) {
      const r = await env.api('POST', '/api/sender-emails/imap-smtp', {
        name: ['Alex Morgan', 'Sam Lee', 'Kim Park'][i], email: addr('sales', domain), password: 'x',
        imap_server: HOST, imap_port: IMAP_PORT, imap_secure: false, smtp_server: HOST, smtp_port: SMTP_PORT, smtp_secure: false,
        email_signature: `${['Alex', 'Sam', 'Kim'][i]} | Bear Co`,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200); // verified over real SMTP + IMAP
      senders.push(r.body.data);
    }
  });
  afterAll(async () => { await env?.close(); });

  it('rejects an account whose servers cannot be reached', async () => {
    const r = await env.api('POST', '/api/sender-emails/imap-smtp', {
      name: 'Bad', email: addr('bad', 'alpha.test'), password: 'x',
      imap_server: HOST, imap_port: 3999, imap_secure: false, smtp_server: HOST, smtp_port: SMTP_PORT, smtp_secure: false,
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/IMAP/);
  });

  let campaignId: number;
  let firstToJane: any;

  it('sends a personalized first step over SMTP', async () => {
    const c = (await env.api('POST', '/api/campaigns', { name: 'E2E' })).body.data;
    campaignId = c.id;
    openAllDay(env.ctx, c.id);
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, {
      steps: [
        { email_subject: 'Question for {COMPANY}', email_body: 'Hi {FIRST_NAME},\n\nAre you the right person for outbound at {COMPANY}?' },
        { email_subject: '', email_body: 'Following up on this, {FIRST_NAME}.', wait_in_days: 0, thread_reply: true },
      ],
    });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [senders[0].id] });
    const leads = await env.api('POST', '/api/leads/multiple', { leads: [
      { email: leadEmails[0], first_name: 'Jane', company: 'Acme' },
      { email: leadEmails[1], first_name: 'Omar', company: 'Globex' },
    ] });
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leads.body.data.lead_ids });
    expect((await env.api('POST', `/api/campaigns/${c.id}/launch`)).status).toBe(200);

    expect(plan(env.ctx).planned).toBe(2);
    env.ctx.db.run(`UPDATE scheduled_emails SET scheduled_at = ?`, [env.ctx.now().toISOString()]);
    expect(await dispatch(env.ctx)).toEqual({ sent: 2, failed: 0 });

    const inbox = await waitFor(() => fetchAll(leadEmails[0]!), (m) => m.length === 1);
    firstToJane = inbox[0]!.parsed;
    expect(firstToJane.subject).toBe('Question for Acme');
    expect(firstToJane.text).toContain('Hi Jane,');
    expect(firstToJane.text).toContain('outbound at Acme?');
    expect(firstToJane.text).toContain('Alex | Bear Co');
    expect(firstToJane.from.value[0]).toEqual({ address: senders[0].email, name: 'Alex Morgan' });
    expect(firstToJane.headerLines.find((h: any) => h.key === 'list-unsubscribe')?.line).toMatch(/List-Unsubscribe: <http:\/\/bear\.test\/u\/[\w-]+>/);
    expect(firstToJane.headerLines.find((h: any) => h.key === 'list-unsubscribe-post')?.line).toBe('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(firstToJane.messageId).toMatch(/@alpha\.test>$/);
  });

  it('syncs a real reply over IMAP, marks interest and threads the follow-up for the other lead', async () => {
    await smtp.sendMail({
      from: { name: 'Jane Doe', address: leadEmails[0]! }, to: senders[0].email,
      subject: `Re: ${firstToJane.subject}`, inReplyTo: firstToJane.messageId, references: [firstToJane.messageId],
      text: `Yes - happy to chat. Does Thursday work?\n\nOn Mon, Alex wrote:\n> Hi Jane,`,
    });
    const sender = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senders[0].id]);
    await waitFor(async () => { await syncSender(env.ctx, sender); return env.ctx.db.get('SELECT COUNT(*) n FROM replies').n; }, (n) => n === 1);

    const reply = env.ctx.db.get('SELECT * FROM replies');
    expect(reply).toMatchObject({ from_email: leadEmails[0], interested: 1, category: 'interested', campaign_id: campaignId, folder: 'inbox' });
    expect(env.ctx.db.get('SELECT cl.status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.email = ?', [leadEmails[0]]).status).toBe('interested');

    // A second sync must not duplicate (IMAP cursor).
    await syncSender(env.ctx, sender);
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM replies').n).toBe(1);

    // Follow-up step only goes to Omar, threaded under the first email.
    expect(plan(env.ctx).planned).toBe(1);
    env.ctx.db.run(`UPDATE scheduled_emails SET scheduled_at = ? WHERE status = 'scheduled'`, [env.ctx.now().toISOString()]);
    expect(await dispatch(env.ctx)).toEqual({ sent: 1, failed: 0 });
    const omar = await waitFor(() => fetchAll(leadEmails[1]!), (m) => m.length === 2);
    const [step1, step2] = omar.map((m) => m.parsed).sort((a, b) => (a.subject!.length - b.subject!.length));
    expect(step2!.subject).toBe(`Re: ${step1!.subject}`);
    expect(step2!.inReplyTo).toBe(step1!.messageId);
    expect(step2!.text).toContain('Following up on this, Omar.');
    expect(step2!.text).toContain('> Hi Omar,');
  });

  it('replies from the master inbox in the same thread', async () => {
    env.clock.now = new Date();
    const reply = env.ctx.db.get('SELECT * FROM replies');
    const r = await env.api('POST', `/api/replies/${reply.id}/reply`, { message: 'Thursday 2pm works. Sending an invite.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const jane = await waitFor(() => fetchAll(leadEmails[0]!), (m) => m.length === 2);
    const answer = jane.map((m) => m.parsed).find((m) => m.subject === `Re: ${firstToJane.subject}`)!;
    expect(answer.inReplyTo).toBe(`<${reply.message_id}>`);
    expect(answer.text).toContain('Thursday 2pm works.');
    expect(answer.text).toContain('> Yes - happy to chat.');
    const thread = await env.api('GET', `/api/replies/${reply.id}/conversation-thread`);
    expect(thread.body.data.messages.map((m: any) => m.direction)).toEqual(['sent', 'received', 'sent']);
  });

  it('detects a real bounce notification and stops the lead', async () => {
    const omarSent = env.ctx.db.get(`SELECT * FROM sent_emails WHERE to_email = ? ORDER BY id LIMIT 1`, [leadEmails[1]]);
    const boundary = 'b0und';
    await smtp.sendMail({
      envelope: { from: 'mailer-daemon@globex.test', to: senders[0].email },
      raw: [
        `From: Mail Delivery Subsystem <mailer-daemon@globex.test>`, `To: ${senders[0].email}`, `Subject: Undelivered Mail Returned to Sender`,
        `Message-ID: <dsn-${run}@globex.test>`, `MIME-Version: 1.0`, `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain', '', `Delivery to ${leadEmails[1]} failed permanently.`, '',
        `--${boundary}`, 'Content-Type: message/delivery-status', '', `Final-Recipient: rfc822; ${leadEmails[1]}`, 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 No such user', '',
        `--${boundary}`, 'Content-Type: text/rfc822-headers', '', `Message-ID: <${omarSent.message_id}>`, '', `--${boundary}--`, '',
      ].join('\r\n'),
    });
    const sender = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senders[0].id]);
    await waitFor(async () => { await syncSender(env.ctx, sender); return env.ctx.db.get(`SELECT status FROM leads WHERE email = ?`, [leadEmails[1]]).status; }, (s) => s === 'bounced');
    expect(env.ctx.db.get(`SELECT bounced FROM sent_emails WHERE id = ?`, [omarSent.id]).bounced).toBe(1);
    expect((await env.api('GET', '/api/replies?folder=bounced')).body.data[0].from_email).toBe('mailer-daemon@globex.test');
  });

  it('runs the warmup pool: sends, rescues from spam, replies and files messages away', async () => {
    setSetting(env.ctx.db, 'warmup_timezone', 'UTC');
    await env.api('PATCH', '/api/warmup/sender-emails/enable', { sender_email_ids: senders.map((s) => s.id) });
    await env.api('PATCH', '/api/warmup/sender-emails/update-daily-warmup-limits', { sender_email_ids: senders.map((s) => s.id), daily_limit: 2, daily_reply_limit: 100 });
    // Pin the clock inside the 08:00–20:00 warmup window.
    const today = new Date(); today.setUTCHours(9, 0, 0, 0);
    env.clock.now = today;
    expect(planWarmup(env.ctx).planned).toBe(6); // ramp starts at 2/day per mailbox
    env.ctx.db.run(`UPDATE warmup_emails SET scheduled_at = ?`, [today.toISOString()]);
    expect(await dispatchWarmup(env.ctx)).toEqual({ sent: 6, failed: 0 });

    // Simulate a provider spam-filtering one message: move it into Junk on the recipient side.
    const victim = env.ctx.db.get(`SELECT w.*, s.email AS to_email FROM warmup_emails w JOIN sender_emails s ON s.id = w.to_sender_id ORDER BY w.id LIMIT 1`);
    await imap(victim.to_email, async (c) => {
      await waitFor(async () => ((await c.status('INBOX', { messages: true })) as any).messages ?? 0, (n: number) => n > 0);
      try { await c.mailboxCreate('Junk'); } catch { /* exists */ }
      const lock = await c.getMailboxLock('INBOX');
      try {
        const uids = await c.search({ header: { 'message-id': victim.message_id } }, { uid: true });
        expect(uids).toHaveLength(1);
        await c.messageMove(uids as number[], 'Junk', { uid: true });
      } finally { lock.release(); }
    });

    const syncAll = async () => { for (const s of senders) await syncSender(env.ctx, env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [s.id])!); };
    await waitFor(async () => { await syncAll(); return env.ctx.db.get(`SELECT COUNT(*) n FROM warmup_emails WHERE is_reply = 0 AND received_at IS NOT NULL`).n; }, (n) => n === 6);

    const v = env.ctx.db.get('SELECT * FROM warmup_emails WHERE id = ?', [victim.id]);
    expect(v).toMatchObject({ landed_folder: 'spam', rescued: 1 });
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM warmup_emails WHERE is_reply = 0 AND landed_folder = 'inbox'`).n).toBe(5);

    // The rescued message is back in the inbox; the next pass files it into the warmup folder.
    await syncAll();
    for (const s of senders) {
      const inbox = (await fetchAll(s.email)).filter((m) => env.ctx.db.get('SELECT 1 FROM warmup_emails WHERE message_id = ?', [m.parsed.messageId!.replace(/[<>]/g, '')]));
      expect(inbox, `warmup mail left in ${s.email} inbox`).toHaveLength(0);
      expect((await fetchAll(s.email, 'Junk')).length).toBe(0);
    }
    const filed = (await Promise.all(senders.map((s) => fetchAll(s.email, WARMUP_FOLDER)))).flat();
    expect(filed.length).toBe(6);
    for (const m of filed) expect(m.parsed.text!.length).toBeGreaterThan(40);

    // Reply rate 100% => every original gets a threaded reply scheduled.
    const replies = env.ctx.db.all('SELECT * FROM warmup_emails WHERE is_reply = 1');
    expect(replies).toHaveLength(6);
    expect(replies[0].subject).toMatch(/^Re: /);
    expect(replies[0].body_text).toMatch(/wrote:\n> /);

    // Warmup traffic never reaches the master inbox.
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM replies WHERE folder = 'inbox'`).n).toBe(1);
    const stats = (await env.api('GET', '/api/warmup/sender-emails')).body.data;
    expect(stats.reduce((n: number, s: any) => n + s.stats.landed_inbox + s.stats.landed_spam, 0)).toBe(6);
  });

  it('runs an inbox placement test against a seed inbox', async () => {
    const seedEmail = addr('seed', 'gmail-seed.test');
    const seed = await env.api('POST', '/api/seed-accounts', { provider: 'gmail', email: seedEmail, imap_server: HOST, imap_port: IMAP_PORT, imap_secure: false, password: 'x' });
    expect(seed.status, JSON.stringify(seed.body)).toBe(200);
    const t = await env.api('POST', '/api/placement-tests', { campaign_id: campaignId, sender_email_ids: [senders[1].id, senders[2].id] });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const result = await waitFor(async () => {
      await checkPlacementTests(env.ctx);
      return (await env.api('GET', `/api/placement-tests/${t.body.data.id}`)).body.data;
    }, (d) => d.status === 'completed');
    expect(result.summary).toMatchObject({ total: 2, inbox: 2, spam: 0, inbox_rate: 100 });
    expect(result.summary.by_provider.gmail.inbox).toBe(2);
  });
});
