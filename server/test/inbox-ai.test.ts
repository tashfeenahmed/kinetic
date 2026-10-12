import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Db } from '../src/db/db.ts';
import { buildApp } from '../src/app.ts';
import { setEncryptionKey } from '../src/lib/crypto.ts';
import { silentLogger, type Ctx } from '../src/context.ts';
import type { Config } from '../src/config.ts';
import { FakeMail, makeEnv, type TestEnv } from './helpers.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { processInbound } from '../src/engine/inbox.ts';
import { parseInbound } from '../src/mail/classify.ts';
import { classifyPending } from '../src/engine/replyAi.ts';
import { parseClassification, parseReturnDate, repairJson, ruleLabel } from '../src/mail/replyLabels.ts';

const MONDAY_10AM_NY = new Date('2026-10-12T14:00:00Z');

let env: TestEnv;
let mail: FakeMail;
/** Queue of model answers (strings) or errors; every OpenRouter call takes the next one. */
let answers: (string | Error)[];
let aiCalls: { url: string; body: any }[];
let other: { url: string; body: string }[];

beforeEach(async () => {
  mail = new FakeMail();
  answers = [];
  aiCalls = [];
  other = [];
  env = await makeEnv({
    mail,
    now: MONDAY_10AM_NY,
    fetch: (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/chat/completions')) {
        aiCalls.push({ url: u, body: JSON.parse(init.body) });
        const next = answers.shift() ?? new Error('no answer queued');
        if (next instanceof Error) return new Response(JSON.stringify({ error: { message: next.message } }), { status: 500 });
        return new Response(JSON.stringify({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200 });
      }
      other.push({ url: u, body: init?.body });
      return new Response('ok', { status: 200 });
    }) as any,
  });
  env.ctx.gtm!.settings.set('OPENROUTER_API_KEY', 'sk-or-test');
});
afterEach(() => env.close());

const ai = (o: Record<string, unknown>) => JSON.stringify({ confidence: 0.9, summary: 'Summary.', next_action: 'Do the thing.', objection_type: null, referral: null, return_date: null, ...o });

async function setup(leads = 2) {
  const sender = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex Morgan', email: 'alex@bear0.test', password: 'pw', provider: 'google', daily_limit: 30 })).body.data;
  const c = (await env.api('POST', '/api/campaigns', { name: 'Q4 outreach' })).body.data;
  await env.api('PUT', `/api/campaigns/${c.id}/sequence`, {
    steps: [
      { email_subject: 'Quick question, {FIRST_NAME}', email_body: 'Hi {FIRST_NAME}, do you handle growth at {COMPANY}?' },
      { email_subject: '', email_body: 'Bumping this, {FIRST_NAME}.', wait_in_days: 2, thread_reply: true },
      { email_subject: 'Last note', email_body: 'Closing the loop.', wait_in_days: 3 },
    ],
  });
  await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [sender.id] });
  const created = await env.api('POST', '/api/leads/multiple', { leads: Array.from({ length: leads }, (_, i) => ({ email: `lead${i}@client${i}.test`, first_name: `Lead${i}`, company: `Company${i}` })) });
  const leadIds = created.body.data.lead_ids as number[];
  await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leadIds });
  await env.api('POST', `/api/campaigns/${c.id}/launch`);
  plan(env.ctx);
  env.clock.now = new Date('2026-10-12T20:00:00Z');
  await dispatch(env.ctx);
  const row = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [sender.id]);
  return { campaign: c, sender: row, leadIds };
}

let uid = 0;
async function receive(sender: any, lead: number, body: string, headers: Record<string, string> = {}) {
  const original = mail.sent.find((m) => m.msg.to.includes(`lead${lead}@`))!.msg;
  const id = `r${++uid}@client${lead}.test`;
  const raw = Object.entries({
    'Message-ID': `<${id}>`, 'In-Reply-To': `<${original.messageId}>`, References: `<${original.messageId}>`,
    From: `Lead ${lead} <lead${lead}@client${lead}.test>`, To: sender.email, Subject: `Re: ${original.subject}`, Date: 'Mon, 12 Oct 2026 20:10:00 +0000', ...headers,
  }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + `\r\n\r\n${body}`;
  await processInbound(env.ctx, sender, await parseInbound(raw), { client: null, folder: 'INBOX', kind: 'inbox', uid });
  return env.ctx.db.get('SELECT * FROM replies WHERE message_id = ?', [id]);
}

const replyRow = (id: number) => env.ctx.db.get('SELECT * FROM replies WHERE id = ?', [id]);
const clOf = (leadId: number) => env.ctx.db.get('SELECT * FROM campaign_leads WHERE lead_id = ?', [leadId]);

describe('AI classifier parsing', () => {
  it('reads clean JSON, fenced JSON and repairs sloppy JSON', () => {
    expect(parseClassification(ai({ category: 'meeting_request' }))!.label).toBe('meeting_request');
    expect(parseClassification('Sure!\n```json\n{"category": "objection", "objection_type": "price", "confidence": 0.8, "summary": "Too pricey",}\n```')).toMatchObject({ label: 'objection', objection_type: 'price', confidence: 0.8 });
    expect(repairJson("{category: 'referral', referral: {name: 'Jane', email: 'jane@acme.com'}}")).toMatchObject({ category: 'referral' });
    expect(parseClassification("{category: 'referral', referral: {name: 'Jane', email: 'JANE@acme.com'}}")!.referral).toEqual({ name: 'Jane', email: 'jane@acme.com' });
    expect(parseClassification('{"category": "ooo", "return_date": "2026-10-20"')).toMatchObject({ label: 'out_of_office', return_date: '2026-10-20' }); // truncated + synonym
    expect(parseClassification('category: question')!.label).toBe('more_info');
    expect(parseClassification('I think this person is happy')).toBeNull();
    expect(parseClassification(ai({ category: 'interested', confidence: 87 }))!.confidence).toBe(0.87);
  });

  it('finds explicit return dates and refines out-of-office auto replies', () => {
    const now = new Date('2026-10-12T14:00:00Z');
    expect(parseReturnDate('I am out of the office until October 20th and will reply then.', now)).toBe('2026-10-20');
    expect(parseReturnDate('Back on 3 Nov 2026', now)).toBe('2026-11-03');
    expect(parseReturnDate('Returning 2026-10-26', now)).toBe('2026-10-26');
    expect(parseReturnDate('Away until 15/01/2027', now)).toBe('2027-01-15');
    expect(parseReturnDate('Back January 5', now)).toBe('2027-01-05'); // next year
    expect(parseReturnDate("I'm out until Monday.", now)).toBeNull();
    expect(ruleLabel('auto_reply', 'Automatic reply: hi', "I'm out of office until Monday")).toBe('out_of_office');
    expect(ruleLabel('auto_reply', 'Ticket #123 received', 'We got your request')).toBe('auto_reply');
  });
});

describe('AI reply sorting', () => {
  it('stores the rule label first, then the background queue updates it via the AI', async () => {
    const { campaign, sender, leadIds } = await setup();
    const hook = await env.api('POST', '/api/webhook-url', { name: 'CRM', url: 'https://hooks.test/x', events: ['LEAD_MEETING_REQUEST', 'LEAD_INTERESTED'] });
    expect(hook.status).toBe(200);
    const r = await receive(sender, 0, 'Could you send a few times for a call next week? Also curious about pricing.\n\nOn Mon Alex wrote:\n> Interested?');
    // Rules say "interested" (call/pricing keywords) and the reply waits for the AI.
    expect(r).toMatchObject({ category: 'interested', label: 'interested', label_source: 'rules', ai_status: 'pending' });
    expect(aiCalls).toHaveLength(0); // never blocks the sync

    answers.push(ai({ category: 'meeting_request', confidence: 0.93, summary: 'Wants a call next week and pricing.', next_action: 'Send three slots and the pricing page.' }));
    expect(await classifyPending(env.ctx)).toMatchObject({ classified: 1, failed: 0 });
    const after = replyRow(r.id);
    expect(after).toMatchObject({ label: 'meeting_request', label_source: 'ai', category: 'interested', interested: 1, ai_status: 'done', ai_confidence: 0.93, ai_summary: 'Wants a call next week and pricing.' });
    expect(after.ai_model).toBe(aiCalls[0]!.body.model);
    expect(clOf(leadIds[0]!).status).toBe('interested');

    // Prompt: quoted text stripped, body truncated, our email included as context.
    const prompt = aiCalls[0]!.body.messages[1].content as string;
    expect(prompt).toContain('Could you send a few times');
    expect(prompt).not.toContain('> Interested?');
    expect(prompt).toContain('Our previous email');

    const types = env.ctx.db.all(`SELECT type FROM events WHERE reply_id = ?`, [r.id]).map((e) => e.type);
    expect(types).toContain('LEAD_MEETING_REQUEST');
    expect(types.filter((t) => t === 'LEAD_INTERESTED')).toHaveLength(1); // rules already fired it; no duplicate
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM webhook_deliveries WHERE event_type = 'LEAD_MEETING_REQUEST'`).n).toBe(1);

    // The inbox filter and JSON expose the new label.
    const list = await env.api('GET', `/api/replies?folder=inbox&label=meeting_request&campaign_id=${campaign.id}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ label: 'meeting_request', ai_summary: 'Wants a call next week and pricing.' });
  });

  it('caches by message, falls back to rules on errors and without a key', async () => {
    const { sender } = await setup(2);
    const a = await receive(sender, 0, 'Who is this?');
    answers.push('total garbage');
    await classifyPending(env.ctx);
    expect(replyRow(a.id)).toMatchObject({ label: 'reply', label_source: 'rules', ai_status: 'failed' });
    expect(replyRow(a.id).ai_error).toMatch(/Unreadable/);

    answers.push(new Error('upstream down'));
    await env.api('POST', '/api/replies/reclassify', { reply_ids: [a.id] });
    await classifyPending(env.ctx);
    expect(replyRow(a.id)).toMatchObject({ label: 'reply', ai_status: 'failed' });

    answers.push(ai({ category: 'more_info', summary: 'Asks who we are.' }));
    expect((await env.api('POST', `/api/replies/${a.id}/classify`)).body.data).toMatchObject({ label: 'more_info', ai_summary: 'Asks who we are.' });
    const calls = aiCalls.length;
    // Same text, same model: served from the cache.
    expect((await env.api('POST', `/api/replies/${a.id}/classify`)).status).toBe(200);
    expect(aiCalls.length).toBe(calls);

    // No key: nothing is queued, rules stand.
    env.ctx.gtm!.settings.set('OPENROUTER_API_KEY', null);
    const prevEnv = process.env.OPENROUTER_API_KEY; const prevBase = process.env.AI_BASE_URL;
    delete process.env.OPENROUTER_API_KEY; delete process.env.AI_BASE_URL;
    try {
      const b = await receive(sender, 1, 'Not interested, thanks.');
      expect(b).toMatchObject({ category: 'not_interested', label: 'not_interested', ai_status: null });
      expect((await env.api('POST', `/api/replies/${b.id}/draft-reply`)).status).toBe(422);
    } finally {
      if (prevEnv) process.env.OPENROUTER_API_KEY = prevEnv;
      if (prevBase) process.env.AI_BASE_URL = prevBase;
    }
  });

  it('never overrides a manual label', async () => {
    const { sender } = await setup();
    const r = await receive(sender, 0, 'Hmm, maybe. What does it cost?');
    const set = await env.api('PATCH', `/api/replies/${r.id}/label`, { label: 'objection' });
    expect(set.body.data).toMatchObject({ label: 'objection', label_source: 'manual' });
    answers.push(ai({ category: 'interested' }));
    await classifyPending(env.ctx);
    expect(replyRow(r.id)).toMatchObject({ label: 'objection', label_source: 'manual' });
    expect(aiCalls).toHaveLength(0);

    // Re-classify skips it too; the old mark-as endpoints also count as manual.
    const q = await env.api('POST', '/api/replies/reclassify', { from: '2026-10-01', to: '2026-10-31' });
    expect(q.body.data).toEqual({ queued: 0, skipped_manual: 1 });
    expect((await env.api('POST', `/api/replies/${r.id}/classify`)).body.data.manual_override).toBe(true);
    await env.api('PATCH', `/api/replies/${r.id}/mark-as-interested`);
    expect(replyRow(r.id)).toMatchObject({ label: 'interested', label_source: 'manual', interested: 1 });
  });

  it('an out-of-office reply pauses the lead until the return date', async () => {
    const { sender, leadIds } = await setup(2);
    const r = await receive(sender, 0, "I'm away with limited access to email. Back Tuesday the 20th.", { Subject: 'Automatic reply: Quick question', 'Auto-Submitted': 'auto-replied' });
    expect(r).toMatchObject({ automated: 1, ai_status: 'pending', label: 'auto_reply' });
    answers.push(ai({ category: 'out_of_office', return_date: '2026-10-20', summary: 'Away until Oct 20.' }));
    await classifyPending(env.ctx);
    expect(replyRow(r.id)).toMatchObject({ label: 'out_of_office', category: 'auto_reply', automated: 1 });
    const cl = clOf(leadIds[0]!);
    expect(cl.status).toBe('in_sequence');
    expect(cl.next_due_at).toBe('2026-10-20T08:00:00.000Z');
    const ev = env.ctx.db.get(`SELECT data FROM events WHERE type = 'LEAD_OUT_OF_OFFICE'`);
    expect(JSON.parse(ev.data)).toMatchObject({ return_date: '2026-10-20', paused_until: '2026-10-20T08:00:00.000Z' });

    // Follow-up day: only lead1 gets step 2; lead0 resumes after the 20th.
    env.clock.now = new Date('2026-10-14T14:00:00Z');
    expect(plan(env.ctx).planned).toBe(1);
    env.clock.now = new Date('2026-10-20T14:00:00Z');
    expect(plan(env.ctx).planned).toBe(1);
    expect(env.ctx.db.get(`SELECT lead_id FROM scheduled_emails WHERE status = 'scheduled' ORDER BY id DESC LIMIT 1`).lead_id).toBe(leadIds[0]);
  });

  it('rules alone pause on an explicit return date when no AI is configured', async () => {
    env.ctx.db.run('UPDATE workspaces SET ai_reply_sorting = 0');
    const { sender, leadIds } = await setup(1);
    const r = await receive(sender, 0, 'I am out of the office until October 22 2026.', { Subject: 'Out of Office: Quick question' });
    expect(r).toMatchObject({ label: 'out_of_office', label_source: 'rules', ai_status: null });
    expect(clOf(leadIds[0]!).next_due_at).toBe('2026-10-22T08:00:00.000Z');
  });

  it('unsubscribe intent unsubscribes the lead (and respects the setting)', async () => {
    const { sender, leadIds } = await setup(2);
    // "Please stop" isn't caught by the keyword rules; the AI sees the intent.
    const r = await receive(sender, 0, 'Please never write to me again.');
    expect(r.category).toBe('reply');
    answers.push(ai({ category: 'unsubscribe' }));
    await classifyPending(env.ctx);
    expect(replyRow(r.id)).toMatchObject({ label: 'unsubscribe', category: 'unsubscribe' });
    expect(env.ctx.db.get('SELECT status FROM leads WHERE id = ?', [leadIds[0]]).status).toBe('unsubscribed');
    expect(clOf(leadIds[0]!).status).toBe('unsubscribed');

    // Setting off: labelled, but the lead stays.
    await env.api('PATCH', '/api/workspaces/v1.1/master-inbox-settings', { ai_auto_unsubscribe: false });
    const r2 = await receive(sender, 1, 'Please never write to me again!');
    answers.push(ai({ category: 'unsubscribe' }));
    await classifyPending(env.ctx);
    expect(replyRow(r2.id).label).toBe('unsubscribe');
    expect(env.ctx.db.get('SELECT status FROM leads WHERE id = ?', [leadIds[1]]).status).not.toBe('unsubscribed');
  });

  it('exposes settings and drafts replies with Knowledge Hub context when available', async () => {
    const s = await env.api('PATCH', '/api/workspaces/v1.1/master-inbox-settings', { ai_reply_model: 'google/gemini-3.8-flash', ai_pause_on_ooo: false });
    expect(s.body.data).toMatchObject({ ai_reply_sorting: true, ai_reply_model: 'google/gemini-3.8-flash', ai_auto_unsubscribe: true, ai_pause_on_ooo: false, ai_configured: true });
    expect((await env.api('GET', '/api/replies/ai-status')).body.data).toMatchObject({ active: true, model: 'google/gemini-3.8-flash' });

    const { sender } = await setup(1);
    const r = await receive(sender, 0, 'How does this work with HubSpot?');
    // The Knowledge Hub is empty, so no context is added.
    answers.push('Hi Lead0,\n\nYes — it syncs both ways with HubSpot. Want a quick walkthrough Thursday?');
    const d = await env.api('POST', `/api/replies/${r.id}/draft-reply`, { instructions: 'Keep it short' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.data).toMatchObject({ knowledge_used: false, model: 'google/gemini-3.8-flash' });
    expect(d.body.data.draft).toContain('HubSpot');
    const prompt = aiCalls.at(-1)!.body.messages[1].content as string;
    expect(prompt).toContain('How does this work with HubSpot?');
    expect(prompt).toContain('Campaign: Q4 outreach');
    expect(prompt).toContain('Keep it short');
  });
});

describe('Knowledge Hub context', () => {
  it('is included in the draft prompt when the hub has content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetic-test-'));
    const key = randomBytes(32);
    setEncryptionKey(key);
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, dbPath: join(dir, 'test.db'), publicUrl: 'http://bear.test', appKey: key, workers: false, logLevel: 'silent', tickScale: 1 };
    const db = new Db(config.dbPath);
    const calls: any[] = [];
    const ctx: Ctx = {
      db, config, log: silentLogger, mail: new FakeMail(), now: () => MONDAY_10AM_NY,
      fetch: (async (url: any, init: any) => {
        if (String(url).endsWith('/chat/completions')) {
          calls.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ choices: [{ message: { content: 'Draft.' } }] }), { status: 200 });
        }
        return new Response('ok');
      }) as any,
    };
    const app = await buildApp(ctx);
    try {
      const setupRes = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { name: 'A', email: 'a@bear.test', password: 'password123' } });
      const cookie = String(setupRes.headers['set-cookie']).split(';')[0]!;
      ctx.gtm!.settings.set('OPENROUTER_API_KEY', 'sk-or-test');
      const put = await app.inject({ method: 'POST', url: '/api/knowledge/docs', headers: { cookie }, payload: { title: 'Positioning', content: 'Fact: we integrate with HubSpot both ways.' } });
      expect(put.statusCode, put.body).toBe(200);
      const ws = db.get('SELECT id FROM workspaces');
      const id = db.insert('replies', { workspace_id: ws.id, message_id: 'k1@x', from_email: 'x@y.test', subject: 'HubSpot?', body_text: 'Does it work with HubSpot?', received_at: MONDAY_10AM_NY.toISOString() });
      const d = await app.inject({ method: 'POST', url: `/api/replies/${id}/draft-reply`, headers: { cookie }, payload: {} });
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json().data).toMatchObject({ draft: 'Draft.', knowledge_used: true });
      expect(calls.at(-1).messages[1].content).toContain('we integrate with HubSpot both ways');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
