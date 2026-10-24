import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail, makeEnv, openAllDay, type TestEnv } from './helpers.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { evaluateAbTests, normCdf, zTestPValue } from '../src/engine/abtest.ts';
import { resolvePendingProviders } from '../src/engine/emailProvider.ts';

// Monday 2026-10-12, 14:00Z
const START = new Date('2026-10-12T14:00:00Z');
const DAY = 86_400_000;

let env: TestEnv;
let mail: FakeMail;

beforeEach(async () => {
  mail = new FakeMail();
  env = await makeEnv({ mail, now: START });
});
afterEach(() => env.close());

const db = () => env.ctx.db;
const advance = (days: number) => { env.clock.now = new Date(env.clock.now.getTime() + days * DAY); };

async function addSender(email = 'alex@bear.test') {
  const r = await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex Morgan', email, password: 'app-password', provider: 'google', daily_limit: 500 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

interface Setup { steps: any[]; leads?: Record<string, unknown>[]; settings?: Record<string, unknown>; launch?: boolean }
async function setup(o: Setup) {
  const sender = await addSender();
  const c = (await env.api('POST', '/api/campaigns', { name: 'Branching' })).body.data;
  const seq = await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: o.steps });
  expect(seq.status, JSON.stringify(seq.body)).toBe(200);
  await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [sender.id] });
  const leads = o.leads ?? [{ email: 'lead0@client0.test', first_name: 'Lead0' }];
  const created = await env.api('POST', '/api/leads/multiple', { leads });
  const leadIds = created.body.data.lead_ids as number[];
  await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leadIds });
  await env.api('PATCH', `/api/campaigns/${c.id}/update`, { stop_on_reply: false, plain_text: false, open_tracking: true, click_tracking: true, ...o.settings });
  openAllDay(env.ctx, c.id);
  if (o.launch !== false) {
    const l = await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(l.status, JSON.stringify(l.body)).toBe(200);
  }
  return { campaign: c, leadIds, sequence: seq.body.data.steps as any[] };
}

/** Plans, pulls every booked slot to "now" and sends it. */
async function sendDue() {
  const planned = plan(env.ctx).planned;
  db().run(`UPDATE scheduled_emails SET scheduled_at = ? WHERE status = 'scheduled'`, [env.ctx.now().toISOString()]);
  await dispatch(env.ctx, 500);
  return planned;
}

const stepsSent = (leadId: number) => db().all('SELECT step_order FROM sent_emails WHERE lead_id = ? ORDER BY id', [leadId]).map((r) => r.step_order);
const cl = (leadId: number) => db().get('SELECT * FROM campaign_leads WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]);

const plain = (n: number, extra: Record<string, unknown> = {}) => ({ email_subject: `Step ${n}`, email_body: `Body ${n}`, wait_in_days: 2, ...extra });

/** Three steps; step 1 carries the given rules. */
function threeSteps(rules: any[], elseAction?: any) {
  return [plain(1, { branching: { rules, ...(elseAction ? { else: elseAction } : {}) } }), plain(2), plain(3)];
}

describe('A/B winner math', () => {
  it('computes a one-sided two-proportion z-test', () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(zTestPValue(30, 100, 10, 100)).toBeLessThan(0.001);
    expect(zTestPValue(10, 100, 10, 100)).toBeCloseTo(0.5, 6); // tie: no evidence
    expect(zTestPValue(0, 100, 0, 100)).toBe(1); // nothing happened yet
    expect(zTestPValue(5, 0, 1, 10)).toBe(1); // no sends
    expect(zTestPValue(10, 100, 30, 100)).toBeGreaterThan(0.99); // wrong direction
  });
});

describe('A/B testing with auto-winner', () => {
  async function abCampaign(cfg: Record<string, unknown>, leads = 1) {
    const s = await setup({
      steps: [{ ...plain(1), variants: [{ email_subject: 'B subject', email_body: 'B body' }], ab_test: { enabled: true, min_sends_per_variant: 100, reply_wait_days: 3, ...cfg } }, plain(2)],
      leads: Array.from({ length: leads }, (_, i) => ({ email: `l${i}@co${i}.test` })),
    });
    const a = s.sequence[0].id as number;
    const b = s.sequence[0].variants[0].id as number;
    return { ...s, a, b };
  }
  let n = 0;
  function fakeSends(campaign: any, stepId: number, sends: number, replies: number, at = env.ctx.now()) {
    for (let i = 0; i < sends; i++) {
      const id = db().insert('sent_emails', { workspace_id: campaign.workspace_id, kind: 'campaign', campaign_id: campaign.id, sequence_step_id: stepId, step_order: 1, message_id: `fake-${n++}@x`, to_email: 'x@y.test', subject: 's', sent_at: at.toISOString() });
      if (i < replies) db().insert('replies', { workspace_id: campaign.workspace_id, campaign_id: campaign.id, sent_email_id: id, message_id: `reply-${n++}@x`, from_email: 'x@y.test', received_at: at.toISOString() });
    }
  }

  it('waits for enough sends and for the reply window, then deactivates the loser', async () => {
    const { campaign, a, b } = await abCampaign({});
    fakeSends(campaign, a, 60, 2);
    fakeSends(campaign, b, 60, 20);
    expect(evaluateAbTests(env.ctx).decided).toBe(0); // too few sends
    let t = (await env.api('GET', `/api/campaigns/${campaign.id}/ab-tests`)).body.data[0];
    expect(t.status).toBe('running');
    expect(t.reason).toMatch(/Waiting for 100 sends/);

    fakeSends(campaign, a, 60, 3);
    fakeSends(campaign, b, 60, 15);
    expect(evaluateAbTests(env.ctx).decided).toBe(0); // enough sends, but replies had no time to arrive
    advance(3);
    expect(evaluateAbTests(env.ctx).decided).toBe(1);

    t = (await env.api('GET', `/api/campaigns/${campaign.id}/ab-tests`)).body.data[0];
    expect(t.status).toBe('decided');
    expect(t.winner_step_id).toBe(b);
    expect(t.decision.decided_by).toBe('auto');
    expect(t.decision.p_value).toBeLessThan(0.05);
    expect(t.decision.deactivated_ids).toEqual([a]);
    const vb = t.variants.find((v: any) => v.id === b);
    expect(vb).toMatchObject({ letter: 'B', sent: 120, replies: 35, reply_rate: 29.17, is_winner: true });
    expect(vb.confidence).toBeGreaterThan(0.95);
    expect(db().get('SELECT active FROM sequence_steps WHERE id = ?', [a]).active).toBe(0);
    const ev = db().get(`SELECT * FROM events WHERE type = 'AB_TEST_WINNER'`);
    expect(JSON.parse(ev.data)).toMatchObject({ winner_step_id: b, winner_variant: 'B', decided_by: 'auto' });
  });

  it('does not decide a tie or an insignificant difference', async () => {
    const { campaign, a, b } = await abCampaign({});
    fakeSends(campaign, a, 150, 10, new Date(START.getTime() - 5 * DAY));
    fakeSends(campaign, b, 150, 10, new Date(START.getTime() - 5 * DAY));
    expect(evaluateAbTests(env.ctx).decided).toBe(0);
    expect((await env.api('GET', `/api/campaigns/${campaign.id}/ab-tests`)).body.data[0].reason).toMatch(/tied/);
    fakeSends(campaign, b, 1, 1, new Date(START.getTime() - 5 * DAY));
    expect(evaluateAbTests(env.ctx).decided).toBe(0);
    expect((await env.api('GET', `/api/campaigns/${campaign.id}/ab-tests`)).body.data[0].reason).toMatch(/Not significant/);
  });

  it('sends the winner to the remaining leads; manual pick and reset', async () => {
    const { campaign, a, b } = await abCampaign({ enabled: false }, 6);
    const pick = await env.api('POST', `/api/campaigns/${campaign.id}/ab-tests/${a}/pick-winner`, { variant_id: b });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    expect(pick.body.data).toMatchObject({ status: 'decided', winner_step_id: b });
    expect(pick.body.data.decision.decided_by).toBe('manual');
    await sendDue();
    const used = db().all('SELECT DISTINCT sequence_step_id FROM sent_emails').map((r) => r.sequence_step_id);
    expect(used).toEqual([b]);
    expect(mail.sent.every((m) => m.msg.subject === 'B subject')).toBe(true);

    const reset = await env.api('POST', `/api/campaigns/${campaign.id}/ab-tests/${b}/reset`);
    expect(reset.body.data.status).toBe('manual');
    expect(db().get('SELECT active FROM sequence_steps WHERE id = ?', [a]).active).toBe(1);
    expect(db().get('SELECT reset_at FROM ab_test_decisions').reset_at).toBeTruthy();
  });

  it('cancels booked slots of losing variants so they are re-planned with the winner', async () => {
    const { campaign, a, b } = await abCampaign({ enabled: false }, 10);
    plan(env.ctx);
    expect(db().get(`SELECT COUNT(*) n FROM scheduled_emails WHERE sequence_step_id = ? AND status = 'scheduled'`, [a]).n).toBeGreaterThan(0);
    await env.api('POST', `/api/campaigns/${campaign.id}/ab-tests/${a}/pick-winner`, { variant_id: b });
    expect(db().get(`SELECT COUNT(*) n FROM scheduled_emails WHERE sequence_step_id = ? AND status = 'scheduled'`, [a]).n).toBe(0);
    plan(env.ctx);
    expect(db().all(`SELECT DISTINCT sequence_step_id s FROM scheduled_emails WHERE status = 'scheduled'`).map((r) => r.s)).toEqual([b]);
  });

  it('percent pool: tests on a share of leads, holds the rest, then gives them the winner', async () => {
    const { campaign, leadIds, b } = await abCampaign({ pool: 'percent', test_percent: 30, min_sends_per_variant: 1000, reply_wait_days: 1 }, 40);
    await sendDue();
    const contacted = db().get('SELECT COUNT(*) n FROM sent_emails').n;
    expect(contacted).toBeGreaterThan(3);
    expect(contacted).toBeLessThan(25); // only the test pool
    // Variant B gets every reply.
    for (const s of db().all('SELECT * FROM sent_emails WHERE sequence_step_id = ?', [b])) {
      db().insert('replies', { workspace_id: campaign.workspace_id, campaign_id: campaign.id, lead_id: s.lead_id, sent_email_id: s.id, message_id: `r${s.id}@x`, from_email: s.to_email, received_at: env.ctx.now().toISOString() });
    }
    expect(evaluateAbTests(env.ctx).decided).toBe(0); // reply wait not over
    advance(1);
    expect(evaluateAbTests(env.ctx).decided).toBe(1); // pool exhausted: leader picked
    const t = (await env.api('GET', `/api/campaigns/${campaign.id}/ab-tests`)).body.data[0];
    expect(t.winner_step_id).toBe(b);
    expect(t.decision.note).toMatch(/Test pool finished/);
    // The held leads now start with the winner.
    db().run(`UPDATE campaign_leads SET next_due_at = NULL WHERE current_step = 0`);
    db().run(`UPDATE campaigns SET max_new_leads_per_day = 1000`);
    advance(1);
    await sendDue();
    const fresh = db().all('SELECT sequence_step_id FROM sent_emails WHERE step_order = 1 AND sent_at >= ?', [env.ctx.now().toISOString()]);
    expect(fresh.length).toBe(40 - contacted);
    expect(new Set(fresh.map((r) => r.sequence_step_id))).toEqual(new Set([b]));
    expect(leadIds.length).toBe(40);
  });

  it('rejects open-rate tests without open tracking', async () => {
    const { campaign, a } = await abCampaign({});
    await env.api('PATCH', `/api/campaigns/${campaign.id}/update`, { open_tracking: false });
    const r = await env.api('PUT', `/api/campaigns/${campaign.id}/ab-tests/${a}`, { metric: 'open_rate' });
    expect(r.status).toBe(422);
    const ok = await env.api('PUT', `/api/campaigns/${campaign.id}/ab-tests/${a}`, { metric: 'interested_rate', min_sends_per_variant: 50 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.config).toMatchObject({ metric: 'interested_rate', min_sends_per_variant: 50, enabled: true, reply_wait_days: 3 });
  });
});

describe('conditional sequences', () => {
  it('a linear sequence runs unchanged and records no branch events', async () => {
    const { leadIds } = await setup({ steps: [plain(1), plain(2), plain(3)] });
    await sendDue();
    expect(cl(leadIds[0]!).next_due_at).toBe('2026-10-14T00:00:00.000Z');
    advance(2); await sendDue();
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 2, 3]);
    expect(cl(leadIds[0]!).status).toBe('completed');
    expect(db().get('SELECT COUNT(*) n FROM sequence_path_events').n).toBe(0);
  });

  it('routes on opened / not opened', async () => {
    const { leadIds } = await setup({
      steps: threeSteps([{ when: [{ type: 'opened', negate: true }], then: { type: 'jump', step: 3 } }]),
      leads: [{ email: 'a@a.test' }, { email: 'b@b.test' }],
    });
    await sendDue();
    db().run(`UPDATE sent_emails SET opens = 1, first_opened_at = ? WHERE lead_id = ?`, [env.ctx.now().toISOString(), leadIds[1]]);
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]); // not opened -> step 3
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2]); // opened -> continue
    const path = (await env.api('GET', `/api/campaigns/${cl(leadIds[0]!).campaign_id}/leads/${leadIds[0]}/path`)).body.data;
    const branch = path.timeline.find((e: any) => e.type === 'branch');
    expect(branch).toMatchObject({ from_step: 1, rule_index: 0, target_step: 3, reason: 'not opened the previous email', description: 'go to step 3' });
    expect(path.timeline.map((e: any) => e.type)).toEqual(['sent', 'branch', 'sent']);
  });

  it('routes on clicks, optionally of a specific link', async () => {
    const { leadIds } = await setup({
      steps: threeSteps([{ when: [{ type: 'clicked', url: 'pricing' }], then: { type: 'jump', step: 3 } }]),
      leads: [{ email: 'a@a.test' }, { email: 'b@b.test' }],
    });
    await sendDue();
    for (const [i, url] of [[0, 'https://acme.test/pricing'], [1, 'https://acme.test/blog']] as const) {
      const s = db().get('SELECT * FROM sent_emails WHERE lead_id = ?', [leadIds[i]]);
      db().run('UPDATE sent_emails SET clicks = 1 WHERE id = ?', [s.id]);
      db().insert('events', { workspace_id: s.workspace_id, type: 'LINK_CLICKED', sent_email_id: s.id, data: JSON.stringify({ url }) });
    }
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2]);
  });

  it('routes on replies and reply category', async () => {
    const { campaign, leadIds } = await setup({
      steps: threeSteps([
        { when: [{ type: 'reply_category', value: 'not_interested' }], then: { type: 'end' } },
        { when: [{ type: 'replied' }], then: { type: 'jump', step: 3 } },
      ]),
      leads: [{ email: 'a@a.test' }, { email: 'b@b.test' }, { email: 'c@c.test' }],
    });
    await sendDue();
    const reply = (leadId: number, category: string) => {
      const s = db().get('SELECT * FROM sent_emails WHERE lead_id = ?', [leadId]);
      db().insert('replies', { workspace_id: s.workspace_id, campaign_id: campaign.id, lead_id: leadId, sent_email_id: s.id, message_id: `r${leadId}@x`, from_email: s.to_email, category, received_at: env.ctx.now().toISOString() });
    };
    reply(leadIds[0]!, 'not_interested');
    reply(leadIds[1]!, 'reply');
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1]);
    expect(cl(leadIds[0]!).status).toBe('completed');
    expect(stepsSent(leadIds[1]!)).toEqual([1, 3]);
    expect(stepsSent(leadIds[2]!)).toEqual([1, 2]);
  });

  it('routes on lead fields and custom variables', async () => {
    const { leadIds } = await setup({
      steps: threeSteps([
        { when: [{ type: 'lead_field', field: 'title', op: 'contains', value: 'ceo' }], then: { type: 'jump', step: 3 } },
        { when: [{ type: 'lead_field', field: 'Employees', op: 'gt', value: 500 }, { type: 'lead_field', field: 'company', op: 'not_empty' }], then: { type: 'end' } },
      ]),
      leads: [
        { email: 'a@a.test', title: 'Founder & CEO' },
        { email: 'b@b.test', title: 'VP Sales', company: 'Big', custom_variables: [{ name: 'employees', value: '2,000' }] },
        { email: 'c@c.test', title: 'VP Sales', company: 'Small', custom_variables: [{ name: 'employees', value: '40' }] },
      ],
    });
    await sendDue();
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(stepsSent(leadIds[1]!)).toEqual([1]);
    expect(stepsSent(leadIds[2]!)).toEqual([1, 2]);
  });

  it('routes on the recipient email provider from MX (cached)', async () => {
    const { leadIds } = await setup({
      steps: threeSteps([{ when: [{ type: 'email_provider', value: 'microsoft' }], then: { type: 'jump', step: 3 } }]),
      leads: [{ email: 'a@msft-shop.test' }, { email: 'b@gmail.com' }],
    });
    await sendDue();
    advance(2);
    await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1]); // held until the MX lookup is done
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2]); // gmail.com is known without a lookup
    const lookups: string[] = [];
    await resolvePendingProviders(env.ctx, { resolveMx: async (d: string) => { lookups.push(d); return [{ exchange: 'msft-shop-test.mail.protection.outlook.com', priority: 0 }]; } });
    expect(lookups).toEqual(['msft-shop.test']);
    await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(db().get(`SELECT provider FROM email_provider_cache WHERE domain = 'msft-shop.test'`).provider).toBe('microsoft');
  });

  it('routes on tags, day of week and time since the previous email', async () => {
    const { leadIds } = await setup({
      steps: [
        plain(1, { branching: { rules: [{ when: [{ type: 'has_tag', tag: 'VIP' }], then: { type: 'jump', step: 3 } }] } }),
        plain(2, { branching: { rules: [{ when: [{ type: 'day_of_week', days: ['saturday', 'sunday'] }], then: { type: 'wait', days: 2 } }] } }),
        plain(3, { wait_in_days: 3, branching: { rules: [{ when: [{ type: 'time_since_previous', op: 'gt', days: 10 }], then: { type: 'jump', step: 1 } }, { when: [{ type: 'time_since_previous', op: 'lt', days: 10 }], then: { type: 'end' } }] } }),
        plain(4),
      ],
      leads: [{ email: 'a@a.test' }, { email: 'b@b.test' }],
    });
    const tag = (await env.api('POST', '/api/tags', { name: 'VIP' })).body.data;
    await env.api('POST', '/api/tags/attach-to-leads', { tag_ids: [tag.id], lead_ids: [leadIds[0]] });
    await sendDue(); // Monday
    advance(2); await sendDue(); // Wednesday
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2]);
    // b: step 2 rules are checked when step 3 is due (Saturday) -> wait 2 more days.
    advance(3); await sendDue();
    // a: step 3 went out Wednesday; checked Friday+ (3 days later, < 10) -> end.
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(cl(leadIds[0]!).status).toBe('completed');
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2]);
    expect(cl(leadIds[1]!).next_due_at).toBe(new Date(env.ctx.now().getTime() + 2 * DAY).toISOString());
    advance(2); await sendDue(); // Monday: no re-check, step 3 goes out
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2, 3]);
    // b: step 3 sent Monday; checked more than 10 days later -> back to step 1.
    advance(12); await sendDue();
    expect(stepsSent(leadIds[1]!)).toEqual([1, 2, 3, 1]);
  });

  it('applies skip, end, move and add-tag actions', async () => {
    const other = (await env.api('POST', '/api/campaigns', { name: 'Nurture' })).body.data;
    const { leadIds } = await setup({
      steps: threeSteps([
        { when: [{ type: 'lead_field', field: 'company', op: 'equals', value: 'Skip' }], then: { type: 'skip' } },
        { when: [{ type: 'lead_field', field: 'company', op: 'equals', value: 'End' }], then: { type: 'end' } },
        { when: [{ type: 'lead_field', field: 'company', op: 'equals', value: 'Move' }], then: { type: 'move', campaign_id: other.id } },
        { when: [{ type: 'lead_field', field: 'company', op: 'equals', value: 'Tag' }], then: { type: 'add_tag', tag: 'Hot' } },
      ]),
      leads: ['Skip', 'End', 'Move', 'Tag'].map((company, i) => ({ email: `x${i}@x${i}.test`, company })),
    });
    await sendDue();
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    expect(stepsSent(leadIds[1]!)).toEqual([1]);
    expect(stepsSent(leadIds[2]!)).toEqual([1]);
    expect(db().get('SELECT status FROM campaign_leads WHERE lead_id = ? AND campaign_id = ?', [leadIds[2], other.id]).status).toBe('pending');
    expect(stepsSent(leadIds[3]!)).toEqual([1, 2]);
    const lead = (await env.api('GET', `/api/leads/${leadIds[3]}`)).body.data;
    expect(lead.tags.map((t: any) => t.name)).toEqual(['Hot']);
  });

  it('else action applies when no rule matches', async () => {
    const { leadIds } = await setup({ steps: threeSteps([{ when: [{ type: 'replied' }], then: { type: 'continue' } }], { type: 'jump', step: 3 }) });
    await sendDue();
    advance(2); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 3]);
    const path = db().get('SELECT * FROM sequence_path_events');
    expect(path).toMatchObject({ rule_index: null, reason: 'no rule matched', target_step: 3 });
  });

  it('guards against infinite loops', async () => {
    const { leadIds } = await setup({
      steps: [plain(1), plain(2, { branching: { rules: [], else: { type: 'jump', step: 2 }, check_after_days: 1, max_visits: 3 } })],
    });
    await sendDue();
    for (let i = 0; i < 6; i++) { advance(2); await sendDue(); }
    expect(stepsSent(leadIds[0]!)).toEqual([1, 2, 2, 2]);
    expect(cl(leadIds[0]!).status).toBe('completed');
    const last = db().get('SELECT * FROM sequence_path_events ORDER BY id DESC LIMIT 1');
    expect(last.reason).toMatch(/loop guard: step 2 already sent 3 time/);
  });

  it('last step rules are checked after check_after_days', async () => {
    const { leadIds } = await setup({
      steps: [plain(1), plain(2, { branching: { rules: [{ when: [{ type: 'opened', negate: true }], then: { type: 'jump', step: 1 } }], check_after_days: 4 } })],
      leads: [{ email: 'a@a.test' }],
    });
    await sendDue();
    db().run(`UPDATE sent_emails SET first_opened_at = ?`, [env.ctx.now().toISOString()]);
    advance(2); await sendDue();
    expect(cl(leadIds[0]!).status).toBe('in_sequence');
    advance(4); await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1, 2, 1]);
    expect(db().get(`SELECT COUNT(*) n FROM events WHERE type = 'LEAD_FIRST_CONTACTED'`).n).toBe(1);
  });

  it('validates branches in the launch check', async () => {
    const other = (await env.api('POST', '/api/campaigns', { name: 'Other' })).body.data;
    const { campaign } = await setup({
      steps: [plain(1, { branching: { rules: [{ when: [{ type: 'replied' }], then: { type: 'jump', step: 7 } }], else: { type: 'jump', step: 3 } } }), plain(2), plain(3)],
      launch: false,
    });
    let chk = (await env.api('GET', `/api/campaigns/${campaign.id}/launch-check`)).body.data;
    expect(chk.problems).toEqual(['Step 1 has a rule that goes to step 7, which does not exist.']);
    expect(chk.warnings).toContain('Step 2 is unreachable: no branch leads to it.');
    expect((await env.api('POST', `/api/campaigns/${campaign.id}/launch`)).status).toBe(422);

    const fix = await env.api('PUT', `/api/campaigns/${campaign.id}/sequence/steps/1/branching`, { rules: [{ when: [{ type: 'replied' }], then: { type: 'move', campaign_id: other.id } }] });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    chk = (await env.api('GET', `/api/campaigns/${campaign.id}/launch-check`)).body.data;
    expect(chk.problems).toEqual([]);
    expect(chk.warnings).toEqual([]);
    const bad = await env.api('PUT', `/api/campaigns/${campaign.id}/sequence/steps/1/branching`, { rules: [{ when: [{ type: 'nope' }], then: { type: 'end' } }] });
    expect(bad.status).toBe(422);
  });

  it('keeps the v1.1 API working and extends it with branching', async () => {
    const c = (await env.api('POST', '/api/campaigns', { name: 'v1.1' })).body.data;
    const legacy = await env.api('POST', `/api/campaigns/v1.1/${c.id}/sequence-steps`, {
      title: 'Legacy', sequence_steps: [
        { email_subject: 'Hi', email_body: 'One', wait_in_days: 1, order: 1 },
        { email_subject: 'Hi B', email_body: 'One B', wait_in_days: 1, variant: true, variant_from_step: 1 },
        { email_subject: '', email_body: 'Two', wait_in_days: 3, order: 2, thread_reply: true },
      ],
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.sequence_steps.map((s: any) => [s.order, s.variant])).toEqual([[1, false], [1, true], [2, false]]);
    expect(legacy.body.data.sequence_steps[0].branching).toBeNull();

    const withRules = await env.api('POST', `/api/campaigns/v1.1/${c.id}/sequence-steps`, {
      title: 'Branching', sequence_steps: [
        { email_subject: 'Hi', email_body: 'One', wait_in_days: 1, order: 1, branching: { rules: [{ when: [{ type: 'opened', negate: true }], then: { type: 'end' } }] }, ab_test: { enabled: true } },
        { email_subject: '', email_body: 'Two', wait_in_days: 3, order: 2 },
      ],
    });
    expect(withRules.status, JSON.stringify(withRules.body)).toBe(200);
    const view = (await env.api('GET', `/api/campaigns/v1.1/${c.id}/sequence-steps`)).body.data.sequence_steps;
    expect(view[0].branching.rules[0].then).toEqual({ type: 'end' });
    expect(view[0].ab_test).toMatchObject({ enabled: true, metric: 'reply_rate', min_sends_per_variant: 100 });
    const seq = (await env.api('GET', `/api/campaigns/${c.id}/sequence`)).body.data.steps;
    expect(seq[0].branching.else).toEqual({ type: 'continue' });

    // Saving without the new fields keeps them.
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: seq.map(({ branching: _b, ab_test: _a, ...s }: any) => s) });
    const again = (await env.api('GET', `/api/campaigns/${c.id}/sequence`)).body.data.steps;
    expect(again[0].branching.rules).toHaveLength(1);
    expect(again[0].ab_test.enabled).toBe(true);
  });
});

describe('crash recovery', () => {
  it('reclaims slots stuck in sending and re-plans the lead', async () => {
    const { campaign, leadIds } = await setup({ steps: threeSteps([]) });
    expect(plan(env.ctx).planned).toBe(1);
    // Simulate a crash mid-send: the slot was claimed but never finished.
    db().run(`UPDATE scheduled_emails SET status = 'sending' WHERE campaign_id = ?`, [campaign.id]);
    db().run(`UPDATE campaign_leads SET status = 'in_sequence', current_step = 0 WHERE campaign_id = ?`, [campaign.id]);

    // While fresh, dispatch leaves it alone (a send in flight must not be double-sent).
    await dispatch(env.ctx, 500);
    expect(db().get<{ n: number }>(`SELECT COUNT(*) n FROM scheduled_emails WHERE status = 'sending'`)!.n).toBe(1);
    expect(stepsSent(leadIds[0]!)).toEqual([]);

    // Past the grace window the next dispatch fails the orphan...
    env.clock.now = new Date(env.clock.now.getTime() + 11 * 60_000);
    await dispatch(env.ctx, 500);
    expect(db().get<{ n: number }>(`SELECT COUNT(*) n FROM scheduled_emails WHERE status = 'sending'`)!.n).toBe(0);

    // ...and the lead re-plans and goes out.
    await sendDue();
    expect(stepsSent(leadIds[0]!)).toEqual([1]);
  });

  it('a stuck slot does not keep the lead blocked across daily caps', async () => {
    const { campaign } = await setup({ steps: threeSteps([]), settings: { max_emails_per_day: 1 } });
    expect(plan(env.ctx).planned).toBe(1);
    db().run(`UPDATE scheduled_emails SET status = 'sending' WHERE campaign_id = ?`, [campaign.id]);
    env.clock.now = new Date(env.clock.now.getTime() + 11 * 60_000);
    // Cap counts 'sending' too; without the reclaim, plan() would see campaignLeft = 0 forever.
    expect(plan(env.ctx).planned).toBe(0);
    await dispatch(env.ctx, 500); // reclaims (failed)
    env.clock.now = new Date(env.clock.now.getTime() + 1000);
    expect(plan(env.ctx).planned).toBe(1); // cap free again
  });
});
