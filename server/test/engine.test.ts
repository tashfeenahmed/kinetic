import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail, makeEnv, openAllDay, type TestEnv } from './helpers.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { processInbound } from '../src/engine/inbox.ts';
import { parseInbound } from '../src/mail/classify.ts';
import { deliverWebhooks, RETRY_DELAYS_MS } from '../src/engine/webhooks.ts';
import { hmacSha256 } from '../src/lib/crypto.ts';

// Monday 2026-10-12, 10:00 in New York (14:00Z)
const MONDAY_10AM_NY = new Date('2026-10-12T14:00:00Z');

let env: TestEnv;
let mail: FakeMail;
let hooks: { url: string; body: string; headers: Record<string, string> }[];
let hookStatus = 200;

beforeEach(async () => {
  mail = new FakeMail();
  hooks = [];
  hookStatus = 200;
  env = await makeEnv({
    mail,
    now: MONDAY_10AM_NY,
    fetch: (async (url: string, init: any) => {
      hooks.push({ url, body: init.body, headers: init.headers });
      return new Response('ok', { status: hookStatus });
    }) as any,
  });
});
afterEach(() => env.close());

async function addSender(email: string, extra: Record<string, unknown> = {}) {
  const r = await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex Morgan', email, password: 'app-password', provider: 'google', daily_limit: 30, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

async function setupCampaign(opts: { leads?: number; dailyLimit?: number; senders?: number } = {}) {
  const senders = [];
  for (let i = 0; i < (opts.senders ?? 1); i++) senders.push(await addSender(`alex${i}@bear${i}.test`, { daily_limit: opts.dailyLimit ?? 30 }));
  const c = (await env.api('POST', '/api/campaigns', { name: 'Q4 outreach' })).body.data;
  const seq = await env.api('PUT', `/api/campaigns/${c.id}/sequence`, {
    steps: [
      { email_subject: '{Quick|Short} question, {FIRST_NAME}', email_body: 'Hi {FIRST_NAME},\n\nDo you handle growth at {COMPANY}?\n\n{UNSUBSCRIBE_LINK}', variants: [{ email_subject: 'Idea for {COMPANY}', email_body: 'Hey {FIRST_NAME|there}, quick idea for {COMPANY}.' }] },
      { email_subject: '', email_body: 'Just bumping this up, {FIRST_NAME}.', wait_in_days: 2, thread_reply: true },
      { email_subject: 'Last note', email_body: 'Closing the loop.', wait_in_days: 3 },
    ],
  });
  expect(seq.status, JSON.stringify(seq.body)).toBe(200);
  await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: senders.map((s) => s.id) });
  const leads = Array.from({ length: opts.leads ?? 3 }, (_, i) => ({ email: `lead${i}@client${i}.test`, first_name: `Lead${i}`, company: `Company${i}` }));
  const created = await env.api('POST', '/api/leads/multiple', { leads });
  await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: created.body.data.lead_ids });
  return { campaign: c, senders, leadIds: created.body.data.lead_ids as number[] };
}

describe('campaign lifecycle', () => {
  it('blocks launch until steps, senders and leads exist', async () => {
    const c = (await env.api('POST', '/api/campaigns', { name: 'Empty' })).body.data;
    const r = await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(r.status).toBe(422);
    expect(r.body.problems).toEqual(['Step 1 has an empty body.', 'Add at least one connected sender email.', 'Add leads to the campaign.']);
  });

  it('plans within the window, sends, personalizes and threads follow-ups', async () => {
    const { campaign, leadIds } = await setupCampaign({ leads: 3 });
    expect((await env.api('POST', `/api/campaigns/${campaign.id}/launch`)).status).toBe(200);

    expect(plan(env.ctx).planned).toBe(3);
    const slots = env.ctx.db.all('SELECT * FROM scheduled_emails ORDER BY scheduled_at');
    expect(slots[0].scheduled_at).toBe(MONDAY_10AM_NY.toISOString()); // first goes right away
    for (let i = 1; i < slots.length; i++) {
      const gap = Date.parse(slots[i].scheduled_at) - Date.parse(slots[i - 1].scheduled_at);
      expect(gap).toBeGreaterThanOrEqual(45_000 * 0.7);
    }
    // Everything inside today's 09:00-17:00 New York window.
    expect(Date.parse(slots.at(-1).scheduled_at)).toBeLessThan(Date.parse('2026-10-12T21:00:00Z'));

    // Planning again does not double-book.
    expect(plan(env.ctx).planned).toBe(0);

    env.clock.now = new Date('2026-10-12T21:00:00Z');
    expect(await dispatch(env.ctx)).toEqual({ sent: 0, failed: 0 }); // window closed and slots stale -> re-plan
    env.clock.now = new Date('2026-10-12T20:59:00Z');
    env.ctx.db.run(`UPDATE scheduled_emails SET status = 'scheduled', error = NULL`);
    const res = await dispatch(env.ctx);
    expect(res).toEqual({ sent: 3, failed: 0 });
    expect(mail.sent).toHaveLength(3);

    const first = mail.sent.find((m) => m.msg.to.includes('lead0@client0.test'))!.msg;
    expect(first.text).toMatch(/^(Hi Lead0,|Hey Lead0, quick idea for Company0\.)/);
    expect(first.subject).toMatch(/^((Quick|Short) question, Lead0|Idea for Company0)$/);
    expect(first.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/bear\.test\/u\/[\w-]+>, <mailto:alex0@bear0\.test\?subject=unsubscribe>$/);
    expect(first.html).toBeUndefined(); // plain text by default
    expect(first.messageId).toMatch(/@bear0\.test$/);

    const cl = env.ctx.db.get('SELECT * FROM campaign_leads WHERE lead_id = ?', [leadIds[0]]);
    expect(cl.current_step).toBe(1);
    expect(cl.status).toBe('in_sequence');
    expect(cl.next_due_at).toBe("2026-10-14T04:00:00.000Z"); // Wednesday 00:00 New York

    // Two days later (Wednesday 10:00 NY) the follow-up goes out as a reply in the same thread.
    env.clock.now = new Date('2026-10-14T14:00:00Z');
    expect(plan(env.ctx).planned).toBe(3);
    env.clock.now = new Date('2026-10-14T20:59:00Z');
    await dispatch(env.ctx);
    const followUp = mail.sent.slice(3).find((m) => m.msg.to.includes('lead0@client0.test'))!.msg;
    expect(followUp.subject).toBe(`Re: ${first.subject}`);
    expect(followUp.inReplyTo).toBe(first.messageId);
    expect(followUp.references).toEqual([first.messageId]);
    expect(followUp.text).toContain('Just bumping this up, Lead0.');
    expect(followUp.text).toContain('wrote:\n> ');

    const stats = await env.api('POST', `/api/campaigns/${campaign.id}/stats`, {});
    expect(stats.body.data.emails_sent).toBe(6);
    expect(stats.body.data.total_leads_contacted).toBe(3);
    expect(stats.body.data.sequence_step_stats.filter((s: any) => s.sent > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('respects mailbox daily limits and new-lead caps', async () => {
    const { campaign } = await setupCampaign({ leads: 10, dailyLimit: 4, senders: 2 });
    await env.api('PATCH', `/api/campaigns/${campaign.id}/update`, { max_new_leads_per_day: 6 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    expect(plan(env.ctx).planned).toBe(6);
    const perSender = env.ctx.db.all('SELECT sender_email_id, COUNT(*) n FROM scheduled_emails GROUP BY sender_email_id');
    expect(perSender.map((r) => r.n).sort()).toEqual([3, 3]); // balanced rotation
    await env.api('PATCH', `/api/campaigns/${campaign.id}/update`, { max_new_leads_per_day: 100 });
    expect(plan(env.ctx).planned).toBe(2); // only 8 sends of capacity today
  });

  it('caps sends per receiving domain', async () => {
    const s = await addSender('alex@bear.test');
    const c = (await env.api('POST', '/api/campaigns', { name: 'Domains' })).body.data;
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Hi', email_body: 'Hello' }] });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [s.id] });
    const leads = await env.api('POST', '/api/leads/multiple', { leads: ['a', 'b', 'c', 'd'].map((x) => ({ email: `${x}@same.test` })) });
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leads.body.data.lead_ids });
    await env.api('PATCH', `/api/campaigns/${c.id}/update`, { daily_max_sends_per_receiving_domain: 2 });
    await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(plan(env.ctx).planned).toBe(2);
  });

  it('skips blacklisted and unsubscribed leads', async () => {
    const { campaign, leadIds } = await setupCampaign({ leads: 3 });
    await env.api('POST', '/api/blacklisted-domains', { domain: 'client1.test' });
    await env.api('PATCH', `/api/leads/${leadIds[2]}/unsubscribe`);
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    expect(plan(env.ctx).planned).toBe(1);
    const statuses = env.ctx.db.all('SELECT lead_id, status FROM campaign_leads ORDER BY lead_id').map((r) => r.status);
    expect(statuses).toEqual(['in_sequence', 'stopped', 'unsubscribed']);
  });

  it('pausing cancels booked slots and resuming re-plans', async () => {
    const { campaign } = await setupCampaign({ leads: 2 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    await env.api('PATCH', `/api/campaigns/${campaign.id}/pause`);
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM scheduled_emails WHERE status = 'scheduled'`).n).toBe(0);
    expect(plan(env.ctx).planned).toBe(0);
    await env.api('PATCH', `/api/campaigns/${campaign.id}/resume`);
    expect(plan(env.ctx).planned).toBe(2);
  });

  it('disconnects a mailbox on authentication errors', async () => {
    const { campaign, senders } = await setupCampaign({ leads: 1 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    mail.failWith = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    expect(await dispatch(env.ctx)).toEqual({ sent: 0, failed: 1 });
    const s = (await env.api('GET', `/api/sender-emails/${senders[0].id}`)).body.data;
    expect(s.status).toBe('Disconnected');
    expect(env.ctx.db.get(`SELECT type FROM events WHERE type = 'EMAIL_ACCOUNT_DISCONNECTED'`)).toBeTruthy();
  });
});

describe('replies, unsubscribes and webhooks', () => {
  it('stops the sequence on an interested reply and fires signed webhooks', async () => {
    const hook = await env.api('POST', '/api/webhook-url', { name: 'CRM', url: 'https://hooks.test/eb', events: ['LEAD_REPLIED', 'LEAD_INTERESTED', 'EMAIL_SENT'] });
    expect(hook.status).toBe(200);
    const { campaign, senders, leadIds } = await setupCampaign({ leads: 2 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    env.clock.now = new Date('2026-10-12T20:00:00Z');
    await dispatch(env.ctx);
    const original = mail.sent.find((m) => m.msg.to.includes('lead0@'))!.msg;

    const reply = [
      `Message-ID: <reply1@client0.test>`, `In-Reply-To: <${original.messageId}>`, `References: <${original.messageId}>`,
      `From: Lead Zero <lead0@client0.test>`, `To: ${senders[0].email}`, `Subject: Re: ${original.subject}`, `Date: Mon, 12 Oct 2026 20:10:00 +0000`, '',
      `Sounds interesting - are you free for a call on Thursday?`, '', `On Mon, Oct 12 Alex wrote:`, `> ${original.text.split('\n')[0]}`,
    ].join('\r\n');
    const sender = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senders[0].id]);
    expect(await processInbound(env.ctx, sender, await parseInbound(reply), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 })).toBe('reply');
    // Duplicate delivery is ignored.
    expect(await processInbound(env.ctx, sender, await parseInbound(reply), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 })).toBe('duplicate');

    const cl = env.ctx.db.get('SELECT * FROM campaign_leads WHERE lead_id = ?', [leadIds[0]]);
    expect(cl.status).toBe('interested');
    const inbox = await env.api('GET', '/api/replies?folder=inbox');
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({ interested: true, category: 'interested', campaign_id: campaign.id, lead_id: leadIds[0] });

    // Follow-up day: only the lead who did not reply gets step 2.
    env.clock.now = new Date('2026-10-14T14:00:00Z');
    expect(plan(env.ctx).planned).toBe(1);

    await deliverWebhooks(env.ctx);
    const types = hooks.map((h) => JSON.parse(h.body).event.type);
    expect(types.filter((t) => t === 'EMAIL_SENT')).toHaveLength(2);
    expect(types).toContain('LEAD_REPLIED');
    expect(types).toContain('LEAD_INTERESTED');
    const interested = hooks.find((h) => JSON.parse(h.body).event.type === 'LEAD_INTERESTED')!;
    const secret = env.ctx.db.get('SELECT secret FROM webhooks').secret;
    expect(interested.headers['x-kinetic-signature']).toBe(`sha256=${hmacSha256(secret, interested.body)}`);
    expect(JSON.parse(interested.body)).toMatchObject({ event: { type: 'LEAD_INTERESTED', name: 'Lead Interested', workspace_id: 1, workspace_name: 'Main Workspace', instance_url: 'http://bear.test' }, data: { lead_email: 'lead0@client0.test', interested: true } });
  });

  it('auto replies do not stop the sequence; bounces do', async () => {
    const { campaign, senders, leadIds } = await setupCampaign({ leads: 2 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    env.clock.now = new Date('2026-10-12T20:00:00Z');
    await dispatch(env.ctx);
    const sender = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senders[0].id]);
    const toLead = (i: number) => mail.sent.find((m) => m.msg.to.includes(`lead${i}@`))!.msg;

    const ooo = [`Message-ID: <ooo@client0.test>`, `In-Reply-To: <${toLead(0).messageId}>`, `From: lead0@client0.test`, `To: ${sender.email}`, `Subject: Automatic reply: ${toLead(0).subject}`, `Auto-Submitted: auto-replied`, '', `I'm out until Monday.`].join('\r\n');
    await processInbound(env.ctx, sender, await parseInbound(ooo), { client: null, folder: 'INBOX', kind: 'inbox', uid: 2 });
    expect(env.ctx.db.get('SELECT status FROM campaign_leads WHERE lead_id = ?', [leadIds[0]]).status).toBe('in_sequence');

    const bounce = [
      'Message-ID: <dsn1@mx.test>', 'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', `To: ${sender.email}`, 'Subject: Delivery Status Notification (Failure)',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="zz"', '', '--zz', 'Content-Type: text/plain', '', 'Address not found', '',
      '--zz', 'Content-Type: message/delivery-status', '', 'Final-Recipient: rfc822; lead1@client1.test', 'Action: failed', 'Status: 5.1.1', '',
      '--zz', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${toLead(1).messageId}>`, '', '--zz--',
    ].join('\r\n');
    expect(await processInbound(env.ctx, sender, await parseInbound(bounce), { client: null, folder: 'INBOX', kind: 'inbox', uid: 3 })).toBe('bounce');
    expect(env.ctx.db.get('SELECT status FROM leads WHERE id = ?', [leadIds[1]]).status).toBe('bounced');
    expect(env.ctx.db.get('SELECT status FROM campaign_leads WHERE lead_id = ?', [leadIds[1]]).status).toBe('bounced');
    expect((await env.api('GET', '/api/replies?folder=bounced')).body.data).toHaveLength(1);

    env.clock.now = new Date('2026-10-14T14:00:00Z');
    expect(plan(env.ctx).planned).toBe(1); // lead0 continues, lead1 bounced
  });

  it('one-click unsubscribe link stops all campaigns for the lead', async () => {
    const { campaign, leadIds } = await setupCampaign({ leads: 1 });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    await dispatch(env.ctx);
    const token = env.ctx.db.get('SELECT tracking_token FROM sent_emails').tracking_token;
    const page = await env.app.inject({ method: 'GET', url: `/u/${token}` });
    expect(page.body).toContain('Stop receiving emails at lead0@client0.test?');
    const res = await env.app.inject({ method: 'POST', url: `/u/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect(env.ctx.db.get('SELECT status FROM leads WHERE id = ?', [leadIds[0]]).status).toBe('unsubscribed');
    expect(env.ctx.db.get('SELECT status FROM campaign_leads').status).toBe('unsubscribed');
  });

  it('counts opens after the scanner window and rejects tampered click links', async () => {
    const { campaign } = await setupCampaign({ leads: 1 });
    await env.api('PATCH', `/api/campaigns/${campaign.id}/update`, { plain_text: false, open_tracking: true, click_tracking: true });
    await env.api('PUT', `/api/campaigns/${campaign.id}/sequence`, { steps: [{ email_subject: 'Hi', email_body: 'See https://acme.test/pricing' }] });
    await env.api('POST', `/api/campaigns/${campaign.id}/launch`);
    plan(env.ctx);
    await dispatch(env.ctx);
    const msg = mail.sent[0]!.msg;
    expect(msg.html).toContain('<img src="http://bear.test/t/o/');
    const click = /href="(http:\/\/bear\.test\/t\/c\/[^"]+)"/.exec(msg.html!)![1]!.replace(/&amp;/g, '&');
    const token = env.ctx.db.get('SELECT tracking_token FROM sent_emails').tracking_token;

    await env.app.inject({ method: 'GET', url: `/t/o/${token}` }); // scanner prefetch, ignored
    expect(env.ctx.db.get('SELECT opens FROM sent_emails').opens).toBe(0);
    env.clock.now = new Date(env.clock.now.getTime() + 60_000);
    await env.app.inject({ method: 'GET', url: `/t/o/${token}` });
    expect(env.ctx.db.get('SELECT opens FROM sent_emails').opens).toBe(1);

    const ok = await env.app.inject({ method: 'GET', url: click.replace('http://bear.test', '') });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('https://acme.test/pricing');
    const bad = await env.app.inject({ method: 'GET', url: click.replace('http://bear.test', '').replace('pricing', 'evil') });
    expect(bad.statusCode).toBe(400);
  });

  it('retries failed webhook deliveries with backoff', async () => {
    await env.api('POST', '/api/webhook-url', { name: 'x', url: 'https://hooks.test/x', events: ['LEAD_UNSUBSCRIBED'] });
    const lead = (await env.api('POST', '/api/leads', { email: 'z@z.test' })).body.data;
    await env.api('PATCH', `/api/leads/${lead.id}/unsubscribe`);
    hookStatus = 500;
    await deliverWebhooks(env.ctx);
    let d = env.ctx.db.get('SELECT * FROM webhook_deliveries');
    expect(d).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(d.next_attempt_at) - env.clock.now.getTime()).toBe(RETRY_DELAYS_MS[0]);
    for (let i = 1; i <= 5; i++) {
      env.clock.now = new Date(Date.parse(env.ctx.db.get('SELECT next_attempt_at FROM webhook_deliveries').next_attempt_at ?? env.clock.now.toISOString()));
      await deliverWebhooks(env.ctx);
    }
    d = env.ctx.db.get('SELECT * FROM webhook_deliveries');
    expect(d).toMatchObject({ status: 'failed', attempts: 6 });
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM webhook_attempts').n).toBe(6);
  });
});

describe('API behaviour', () => {
  it('validates input with field errors', async () => {
    const r = await env.api('POST', '/api/leads', { email: 'not-an-email' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'validation_error', fields: { email: ['is invalid'] } });
  });
  it('rejects requests without a token', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/leads' });
    expect(r.statusCode).toBe(401);
  });
  it('imports CSV with mapping, custom variables and dedupe', async () => {
    const csv = 'Email,First Name,Company,Phone,Ignored\njane@acme.com,Jane,Acme,555,x\nJANE@acme.com,Janet,Acme,556,y\nbad-email,Bob,Nope,1,z\n';
    const r = await env.api('POST', '/api/leads/bulk/csv', { csv, mapping: { email: 'Email', first_name: 'First Name', company: 'Company', Phone: 'Phone' }, new_list_name: 'Import 1' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ created: 1, skipped: 1, invalid: [{ line: 4, email: 'bad-email' }] });
    const lead = (await env.api('GET', '/api/leads?search=jane')).body.data[0];
    expect(lead).toMatchObject({ email: 'jane@acme.com', first_name: 'Jane', custom_variables: [{ name: 'Phone', value: '555' }], lead_list: { name: 'Import 1' } });
    expect((await env.api('GET', '/api/custom-variables')).body.data).toEqual([{ id: 1, name: 'Phone', tag: '{PHONE}' }]);
  });
  it('isolates workspaces', async () => {
    await env.api('POST', '/api/leads', { email: 'a@a.test' });
    const ws = (await env.api('POST', '/api/workspaces', { name: 'Client B' })).body.data;
    await env.api('POST', '/api/workspaces/switch-workspace', { team_id: ws.id });
    expect((await env.api('GET', '/api/leads')).body.meta.total).toBe(0);
    expect((await env.api('GET', '/api/tags')).body.data.map((t: any) => t.name)).toEqual(['Custom', 'Google', 'Microsoft']);
  });
  it('serves an OpenAPI document covering the API', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/openapi.json' });
    const doc = r.json();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(120);
    expect(doc.paths['/api/leads'].post.requestBody.content['application/json'].schema.properties.email).toBeTruthy();
  });
});

describe('sending IP routes', () => {
  it('stores proxy credentials encrypted and masks them in the API', async () => {
    const r = await env.api('POST', '/api/egress-routes', { name: 'IP 1', proxy_url: 'socks5://user:s3cret@10.0.0.5:1080' });
    expect(r.status).toBe(200);
    expect(r.body.data.proxy_url).toBe('socks5://user:****@10.0.0.5:1080');
    const raw = env.ctx.db.get('SELECT proxy_url FROM egress_routes').proxy_url;
    expect(raw.startsWith('enc:')).toBe(true);
    expect(raw).not.toContain('s3cret');
    // Saving the masked value back keeps the real password.
    await env.api('PUT', `/api/egress-routes/${r.body.data.id}`, { name: 'IP 1 renamed', proxy_url: 'socks5://user:****@10.0.0.5:1080' });
    const { openProxy } = await import('../src/routes/senders.ts');
    expect(openProxy(env.ctx.db.get('SELECT proxy_url FROM egress_routes').proxy_url)).toBe('socks5://user:s3cret@10.0.0.5:1080');
  });
});
