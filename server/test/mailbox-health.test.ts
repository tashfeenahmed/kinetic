import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, openAllDay, type TestEnv } from './helpers.ts';
import { plan } from '../src/engine/sequencer.ts';
import { processInbound } from '../src/engine/inbox.ts';
import { parseInbound } from '../src/mail/classify.ts';
import { checkBlocklists, interpretAnswer, refreshSenderHealth, setHealthResolver } from '../src/engine/health.ts';

const NOW = new Date('2026-10-12T14:00:00Z');
let env: TestEnv;
let answers: Record<string, string[]>;
let lookups: string[];

beforeEach(async () => {
  answers = {};
  lookups = [];
  setHealthResolver({
    async resolve4(name: string) {
      lookups.push(name);
      const a = answers[name];
      if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return a;
    },
    async resolveMx(d: string) { return [{ exchange: `mx.${d}`, priority: 10 }]; },
    async resolveTxt(name: string) {
      if (name.startsWith('_dmarc.')) return [['v=DMARC1; p=none']];
      if (name.startsWith('google._domainkey.')) return [['v=DKIM1; k=rsa; p=abc']];
      return [['v=spf1 include:_spf.google.com ~all']];
    },
  });
  env = await makeEnv({ now: NOW });
});
afterEach(() => env.close());

async function addSender(email = 'alex@north.test') {
  const r = await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex', email, password: 'pw', provider: 'google', daily_limit: 30 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data.id as number;
}
const sender = (id: number) => env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [id])!;
const autoPausedEvents = () => env.ctx.db.all(`SELECT * FROM events WHERE type = 'SENDER_AUTO_PAUSED'`);

let n = 0;
/** Records campaign sends from a mailbox, `bounced` of them hard-bounced already. */
function sends(senderId: number, count: number, bounced = 0, at = new Date(env.clock.now.getTime() - 3_600_000).toISOString()) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const messageId = `orig${++n}@north.test`;
    env.ctx.db.insert('sent_emails', { workspace_id: 1, kind: 'campaign', sender_email_id: senderId, message_id: messageId, to_email: `lead${n}@client.test`, subject: 'Hi', bounced: i < bounced ? 1 : 0, sent_at: at });
    ids.push(messageId);
  }
  return ids;
}

function dsn(to: string, originalId: string, recipient: string) {
  return [
    `Message-ID: <dsn${++n}@mx.test>`, 'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', `To: ${to}`, 'Subject: Delivery Status Notification (Failure)',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="zz"', '', '--zz', 'Content-Type: text/plain', '', 'Address not found', '',
    '--zz', 'Content-Type: message/delivery-status', '', `Final-Recipient: rfc822; ${recipient}`, 'Action: failed', 'Status: 5.1.1', '',
    '--zz', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${originalId}>`, '', '--zz--',
  ].join('\r\n');
}

describe('blocklist answers', () => {
  it('treats refused-query codes as unknown, not listed', () => {
    expect(interpretAnswer(['127.0.1.2'])).toEqual({ status: 'listed', code: '127.0.1.2' });
    expect(interpretAnswer(['127.255.255.254']).status).toBe('unknown'); // Spamhaus: public resolver refused
    expect(interpretAnswer(['127.0.0.1']).status).toBe('unknown'); // URIBL/SURBL: query refused
    expect(interpretAnswer(['92.242.132.24']).status).toBe('unknown'); // NXDOMAIN rewritten by an ISP resolver
  });

  it('does not pause or penalise a mailbox when the lists refuse the query', async () => {
    const id = await addSender();
    answers['north.test.dbl.spamhaus.org'] = ['127.255.255.254'];
    answers['north.test.multi.uribl.com'] = ['127.0.0.1'];
    const r = await refreshSenderHealth(env.ctx, sender(id));
    expect(r).toMatchObject({ score: 100, reasons: [], paused: false });
    const bl = await checkBlocklists(env.ctx, 'north.test');
    expect(bl.listed).toEqual([]);
    expect(bl.results.map((x) => x.status)).toEqual(['unknown', 'clean', 'unknown']);
  });
});

describe('auto-pause', () => {
  beforeEach(async () => {
    await env.api('PATCH', '/api/workspaces/v1.1/master-inbox-settings', { auto_pause_senders: true });
  });

  it('pauses a mailbox whose domain is listed, cancels its slots and alerts', async () => {
    const id = await addSender();
    const c = (await env.api('POST', '/api/campaigns', { name: 'Q4' })).body.data;
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Hi', email_body: 'Hello {FIRST_NAME}' }] });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [id] });
    const leads = await env.api('POST', '/api/leads/multiple', { leads: [{ email: 'a@client.test' }, { email: 'b@client.test' }] });
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leads.body.data.lead_ids });
    openAllDay(env.ctx, c.id);
    await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(plan(env.ctx).planned).toBe(2);

    answers['north.test.dbl.spamhaus.org'] = ['127.0.1.2'];
    const r = await refreshSenderHealth(env.ctx, sender(id));
    expect(r.paused).toBe(true);
    expect(r.score).toBe(50);
    expect(r.reasons).toEqual(['north.test is on a blocklist (dbl.spamhaus.org)']);
    expect(sender(id)).toMatchObject({ status: 'Paused', paused_reason: 'north.test is on a blocklist (dbl.spamhaus.org)' });
    expect(env.ctx.db.all(`SELECT status, error FROM scheduled_emails WHERE sender_email_id = ?`, [id])).toEqual([
      { status: 'cancelled', error: 'sender paused' }, { status: 'cancelled', error: 'sender paused' },
    ]);
    expect(JSON.parse(autoPausedEvents()[0].data)).toMatchObject({ sender_email_id: id, reason: expect.stringContaining('blocklist') });

    const json = (await env.api('GET', `/api/sender-emails/${id}`)).body.data;
    expect(json).toMatchObject({ health_score: 50, health_reasons: ['north.test is on a blocklist (dbl.spamhaus.org)'], paused_reason: expect.any(String) });

    // The user resumes anyway: the same listing does not pause it again, and the DNS answer is cached.
    await env.api('PATCH', `/api/sender-emails/${id}/resume`);
    expect(sender(id)).toMatchObject({ status: 'Connected', paused_reason: null });
    const before = lookups.length;
    expect((await refreshSenderHealth(env.ctx, sender(id))).paused).toBe(false);
    expect(lookups.length).toBe(before);
    expect(sender(id).status).toBe('Connected');
  });

  it('checks a pinned sending IP but only lowers the score', async () => {
    const id = await addSender();
    const route = env.ctx.db.insert('egress_routes', { name: 'VPS', local_address: '203.0.113.5' });
    env.ctx.db.update('sender_emails', id, { egress_route_id: route });
    answers['5.113.0.203.zen.spamhaus.org'] = ['127.0.0.2'];
    const r = await refreshSenderHealth(env.ctx, sender(id));
    expect(r).toMatchObject({ score: 70, paused: false, reasons: ['Sending IP 203.0.113.5 is on a blocklist (zen.spamhaus.org)'] });
  });

  it('pauses on a bounce spike from the inbox sync, then not again for the same bounces after a resume', async () => {
    const id = await addSender();
    const ids = sends(id, 10, 2);
    const s = sender(id);
    expect(await processInbound(env.ctx, s, await parseInbound(dsn(s.email, ids[2]!, 'lead3@client.test')), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 })).toBe('bounce');
    expect(sender(id)).toMatchObject({ status: 'Paused', paused_reason: '3 emails bounced in the last 24 hours (30% of 10)' });
    expect(autoPausedEvents()).toHaveLength(1);

    env.clock.now = new Date(NOW.getTime() + 60_000);
    await env.api('PATCH', `/api/sender-emails/${id}/resume`);
    expect((await refreshSenderHealth(env.ctx, sender(id))).paused).toBe(false);
    expect(sender(id).status).toBe('Connected');

    // New sends after the resume that bounce badly pause it again.
    env.clock.now = new Date(NOW.getTime() + 3 * 3_600_000);
    sends(id, 30, 1);
    expect((await refreshSenderHealth(env.ctx, sender(id))).paused).toBe(false); // 1 of 30: under both thresholds
    sends(id, 10, 1);
    expect((await refreshSenderHealth(env.ctx, sender(id))).paused).toBe(true); // 2 of 40 in 7 days = 5%
    expect(sender(id).paused_reason).toBe('5% of emails bounced in the last 7 days (2 of 40)');
    expect(autoPausedEvents()).toHaveLength(2);
  });

  it('respects the workspace switch', async () => {
    const id = await addSender();
    await env.api('PATCH', '/api/workspaces/v1.1/master-inbox-settings', { auto_pause_senders: false });
    answers['north.test.multi.surbl.org'] = ['127.0.0.8'];
    const r = await refreshSenderHealth(env.ctx, sender(id));
    expect(r).toMatchObject({ paused: false, score: 50 });
    expect(sender(id).status).toBe('Connected');
  });
});

describe('health warnings (auto-pause off, the default)', () => {
  const warningEvents = () => env.ctx.db.all(`SELECT * FROM events WHERE type = 'SENDER_HEALTH_WARNING'`);

  it('new workspaces warn instead of pausing', async () => {
    expect((await env.api('GET', '/api/workspaces/v1.1/master-inbox-settings')).body.data.auto_pause_senders).toBeFalsy();
  });

  it('keeps a bouncing mailbox sending, warns once, and clears the warning when bounces settle', async () => {
    const id = await addSender();
    const ids = sends(id, 10, 2);
    const s = sender(id);
    await processInbound(env.ctx, s, await parseInbound(dsn(s.email, ids[2]!, 'lead3@client.test')), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 });
    expect(sender(id)).toMatchObject({ status: 'Connected', paused_reason: null, health_warning: '3 emails bounced in the last 24 hours (30% of 10)' });
    expect(autoPausedEvents()).toHaveLength(0);
    expect(warningEvents()).toHaveLength(1);

    // Still firing on the hourly check: the text refreshes, no second event.
    sends(id, 2);
    expect((await refreshSenderHealth(env.ctx, sender(id))).paused).toBe(false);
    expect(sender(id).health_warning).toBe('3 emails bounced in the last 24 hours (25% of 12)');
    expect(warningEvents()).toHaveLength(1);
    expect((await env.api('GET', `/api/sender-emails/${id}`)).body.data.health_warning).toBe('3 emails bounced in the last 24 hours (25% of 12)');

    // A week later the bounces are out of both windows.
    env.clock.now = new Date(NOW.getTime() + 8 * 86_400_000);
    await refreshSenderHealth(env.ctx, sender(id));
    expect(sender(id).health_warning).toBeNull();
  });
});

describe('mailboxes that cannot send', () => {
  let k = 0;
  const warm = (from: number, to: number, status: 'failed' | 'sent', at: Date, error: string | null = null) =>
    env.ctx.db.insert('warmup_emails', { from_sender_id: from, to_sender_id: to, message_id: `w${++k}@x.test`, subject: 'hi', scheduled_at: at.toISOString(), status, error, sent_at: status === 'sent' ? at.toISOString() : null });

  it('warns (without pausing) when every send times out, and clears once mail goes out again', async () => {
    await env.api('PATCH', '/api/workspaces/v1.1/master-inbox-settings', { auto_pause_senders: true });
    const id = await addSender();
    const other = await addSender('sam@north.test');
    env.ctx.db.update('sender_emails', id, { smtp_server: 'smtp.gmail.com', smtp_port: 465 });
    for (let i = 3; i >= 1; i--) warm(id, other, 'failed', new Date(NOW.getTime() - i * 3_600_000), 'Connection timeout');

    const r = await refreshSenderHealth(env.ctx, sender(id));
    expect(r.paused).toBe(false);
    expect(r.score).toBe(60);
    expect(sender(id)).toMatchObject({ status: 'Connected', paused_reason: null });
    expect(sender(id).health_warning).toMatch(/^Sending is failing — 3 emails failed in the last 24 hours and none went out since: the mail server \(smtp\.gmail\.com:465\) can't be reached/);
    expect(env.ctx.db.all(`SELECT * FROM events WHERE type = 'SENDER_HEALTH_WARNING'`)).toHaveLength(1);

    warm(id, other, 'sent', new Date(NOW.getTime() - 60_000));
    expect((await refreshSenderHealth(env.ctx, sender(id))).score).toBe(100);
    expect(sender(id).health_warning).toBeNull();
  });

  it('ignores a couple of failures, or failures followed by a successful send', async () => {
    const id = await addSender();
    const other = await addSender('sam@north.test');
    warm(id, other, 'failed', new Date(NOW.getTime() - 7_200_000), 'Connection timeout');
    warm(id, other, 'failed', new Date(NOW.getTime() - 3_600_000), 'Connection timeout');
    expect((await refreshSenderHealth(env.ctx, sender(id))).score).toBe(100);
    warm(id, other, 'failed', new Date(NOW.getTime() - 1_800_000), '421 try again later');
    warm(id, other, 'sent', new Date(NOW.getTime() - 60_000));
    expect((await refreshSenderHealth(env.ctx, sender(id))).score).toBe(100);
    expect(sender(id).health_warning).toBeNull();
  });
});
