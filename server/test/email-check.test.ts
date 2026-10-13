import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMail, makeEnv, type TestEnv } from './helpers.ts';
import { checkEmail } from '../src/lib/emailCheck.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';

// Lets a test make composing throw for one lead.
const fault = vi.hoisted(() => ({ email: '' }));
vi.mock('../src/engine/compose.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/engine/compose.ts')>();
  return {
    ...mod,
    composeCampaignEmail: (ctx: any, input: any) => {
      if (input.lead.email === fault.email) throw new Error('boom');
      return mod.composeCampaignEmail(ctx, input);
    },
  };
});

const codes = (r: { code: string }[]) => r.map((i) => i.code);

describe('checkEmail', () => {
  it('passes a clean email', () => {
    expect(checkEmail({ subject: 'Idea for Acme', body: 'Hi Sam,\n\nDo you handle growth at Acme?\n\nAlex' })).toEqual({ errors: [], warnings: [] });
  });

  it('blocks leftover placeholders, broken spintax and empty parts', () => {
    expect(codes(checkEmail({ subject: 'Hi {FIRSTNAME}', body: 'Hello' }).errors)).toEqual(['leftover_variable']);
    expect(codes(checkEmail({ subject: 'Hi', body: 'Hello {{first_name}}' }).errors)).toEqual(['leftover_variable']);
    expect(codes(checkEmail({ subject: 'Hi', body: '{Hi|Hello there' }).errors)).toEqual(['broken_spintax']);
    expect(codes(checkEmail({ subject: ' ', body: '' }).errors)).toEqual(['empty_body', 'empty_subject']);
    // Thread replies reuse the earlier subject.
    expect(checkEmail({ subject: '', body: 'Bumping this', threaded: true }).errors).toEqual([]);
  });

  it('warns about spammy wording, length, links and formatting', () => {
    const r = checkEmail({
      subject: 'QUICK QUESTION FOR YOU!',
      body: `I hope this email finds you well. Our game-changer is guaranteed. See https://bit.ly/x https://a.test https://b.test <img src="x"> ${'word '.repeat(150)}`,
      firstStep: true,
    });
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual(expect.arrayContaining(['flagged_phrase', 'caps_subject', 'exclamation', 'long_body', 'many_links', 'link_shortener', 'images']));
    expect(r.warnings.find((w) => w.excerpt === 'QUICK QUESTION')).toBeTruthy();
    expect(codes(checkEmail({ subject: 'x'.repeat(61), body: 'ok' }).warnings)).toEqual(['long_subject']);
  });
});

describe('pre-send check in the sequencer and at launch', () => {
  let env: TestEnv;
  let mail: FakeMail;
  const NOW = new Date('2026-10-12T14:00:00Z');
  beforeEach(async () => {
    fault.email = '';
    mail = new FakeMail();
    env = await makeEnv({ mail, now: NOW });
  });
  afterEach(() => env.close());

  async function setup(body: string) {
    const s = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex Morgan', email: 'alex@bear.test', password: 'pw', provider: 'google', daily_limit: 30 })).body.data;
    const c = (await env.api('POST', '/api/campaigns', { name: 'Check' })).body.data;
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Idea for {COMPANY}', email_body: body }] });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [s.id] });
    const leads = await env.api('POST', '/api/leads/multiple', { leads: [
      { email: 'a@one.test', company: 'One', custom_variables: [{ name: 'pain', value: 'churn' }] },
      { email: 'b@two.test', company: 'Two' },
    ] });
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leads.body.data.lead_ids });
    return c;
  }
  const dueNow = () => env.ctx.db.run(`UPDATE scheduled_emails SET scheduled_at = ?`, [NOW.toISOString()]);
  const slotFor = (email: string) => env.ctx.db.get(`SELECT se.* FROM scheduled_emails se JOIN leads l ON l.id = se.lead_id WHERE l.email = ?`, [email]);

  it('holds back one broken email and still sends the rest of the batch', async () => {
    const c = await setup('Is {PAIN} a problem?');
    expect((await env.api('POST', `/api/campaigns/${c.id}/launch`)).status).toBe(200);
    expect(plan(env.ctx).planned).toBe(2);
    dueNow();
    // The second lead has no PAIN value and no fallback.
    expect(await dispatch(env.ctx)).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent.map((m) => m.msg.to)).toEqual(['a@one.test']);
    const held = slotFor('b@two.test');
    expect(held.status).toBe('cancelled');
    expect(held.error).toMatch(/^pre-send check: A variable was not filled in: \{PAIN\}/);
    // Backed off, so the next plan does not hot-loop on it.
    expect(plan(env.ctx).planned).toBe(0);
  });

  it('a compose failure cancels only that slot', async () => {
    const c = await setup('Hello');
    await env.api('POST', `/api/campaigns/${c.id}/launch`);
    plan(env.ctx);
    dueNow();
    fault.email = 'a@one.test';
    expect(await dispatch(env.ctx)).toEqual({ sent: 1, failed: 0 });
    expect(mail.sent.map((m) => m.msg.to)).toEqual(['b@two.test']);
    expect(slotFor('a@one.test')).toMatchObject({ status: 'cancelled', error: 'could not build the email: boom' });
  });

  it('launch blocks unknown variables and launch-check lists warnings', async () => {
    const c = await setup('Is {PAINN} a problem? {Hi|Hello}, I hope this email finds you well.');
    const r = await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(r.status).toBe(422);
    expect(r.body.problems).toContain('Step 1: A variable was not filled in: {PAINN}');
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Idea', email_body: 'Is {PAIN|it} a problem? I hope this email finds you well.' }] });
    const chk = (await env.api('GET', `/api/campaigns/${c.id}/launch-check`)).body.data;
    expect(chk.problems).toEqual([]);
    expect(chk.warnings).toContain('Step 1: "I hope this email finds you well" can read as spammy or machine-written.');
  });

  it('preview returns the check', async () => {
    const c = await setup('Hello');
    const r = (await env.api('POST', `/api/campaigns/${c.id}/preview`, { email_subject: 'Hi', email_body: 'Act now! {Hi|Hello' })).body.data;
    expect(codes(r.errors)).toEqual(['broken_spintax']);
    expect(codes(r.warnings)).toContain('flagged_phrase');
  });
});
