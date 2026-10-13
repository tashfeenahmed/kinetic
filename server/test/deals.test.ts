import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, openAllDay, type TestEnv } from './helpers.ts';
import { applyLabel } from '../src/engine/replyAi.ts';
import { evaluateAbTests } from '../src/engine/abtest.ts';
import { addLearning, LEARNINGS_TITLE, MAX_LEARNINGS } from '../src/knowledge/learnings.ts';
import { knowledgeContext } from '../src/knowledge/store.ts';

const START = new Date('2026-10-12T14:00:00Z');

let env: TestEnv;
beforeEach(async () => { env = await makeEnv({ now: START }); });
afterEach(() => env.close());

const db = () => env.ctx.db;

async function campaignWithLeads(n = 2) {
  const c = (await env.api('POST', '/api/campaigns', { name: 'Q4 outreach' })).body.data;
  const created = await env.api('POST', '/api/leads/multiple', { leads: Array.from({ length: n }, (_, i) => ({ email: `lead${i}@client${i}.test`, first_name: `Lead${i}`, company: `Company${i}` })) });
  const leadIds = created.body.data.lead_ids as number[];
  await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leadIds });
  return { campaign: c, leadIds };
}

let uid = 0;
function reply(campaign: any, leadId: number) {
  return db().insert('replies', {
    workspace_id: campaign.workspace_id, campaign_id: campaign.id, lead_id: leadId, folder: 'inbox', message_id: `r${++uid}@x`,
    from_email: `lead@x.test`, subject: 'Re: hi', body_text: 'Sounds good', category: 'reply', received_at: env.ctx.now().toISOString(),
  });
}
const dealOf = (leadId: number) => db().get('SELECT * FROM deals WHERE lead_id = ?', [leadId]);
const dealEvents = () => db().all(`SELECT data FROM events WHERE type = 'DEAL_STAGE_CHANGED' ORDER BY id`).map((e) => JSON.parse(e.data));
const learnings = () => db().get('SELECT * FROM knowledge_docs WHERE title = ?', [LEARNINGS_TITLE]);

describe('deal pipeline', () => {
  it('opens deals from interested replies and only moves them forward', async () => {
    const { campaign, leadIds } = await campaignWithLeads();
    const lead = leadIds[0]!;
    applyLabel(env.ctx, reply(campaign, lead), 'objection', { source: 'ai' });
    expect(dealOf(lead)).toBeUndefined();

    applyLabel(env.ctx, reply(campaign, lead), 'interested', { source: 'ai' });
    expect(dealOf(lead)).toMatchObject({ stage: 'interested', campaign_id: campaign.id, meeting_at: null });
    expect(dealEvents()).toEqual([expect.objectContaining({ from_stage: null, to_stage: 'interested', company: 'Company0', source: 'reply' })]);

    applyLabel(env.ctx, reply(campaign, lead), 'meeting_request', { source: 'ai' });
    expect(dealOf(lead)).toMatchObject({ stage: 'meeting' });
    expect(dealOf(lead).meeting_at).toBeTruthy();

    // By hand to proposal; a later "interested" reply never moves it back.
    const d = dealOf(lead);
    expect((await env.api('PATCH', `/api/deals/${d.id}`, { stage: 'proposal', value: 12000, currency: 'EUR' })).body.data).toMatchObject({ stage: 'proposal', value: 12000 });
    applyLabel(env.ctx, reply(campaign, lead), 'interested', { source: 'ai' });
    applyLabel(env.ctx, reply(campaign, lead), 'meeting_request', { source: 'ai' });
    expect(dealOf(lead).stage).toBe('proposal');

    // Won deals are never touched by replies, not even "not interested".
    await env.api('PATCH', `/api/deals/${d.id}`, { stage: 'won' });
    applyLabel(env.ctx, reply(campaign, lead), 'meeting_request', { source: 'ai' });
    applyLabel(env.ctx, reply(campaign, lead), 'not_interested', { source: 'ai' });
    expect(dealOf(lead)).toMatchObject({ stage: 'won', value: 12000 });
    expect(dealEvents().map((e) => e.to_stage)).toEqual(['interested', 'meeting', 'proposal', 'won']);

    // A won deal is a learning.
    expect(learnings().content).toMatch(/2026-10-12 — Won deal with Company0 \(EUR 12,000\) from campaign Q4 outreach\./);

    // The table "Outreach status" shows the deal stage.
    expect(env.ctx.gtm!.outreach.leadStatus(campaign.workspace_id, 'lead0@client0.test')).toMatchObject({ status: 'won', deal: { stage: 'won' } });
  });

  it('respects manual marks and drops an untouched deal when its reply is relabelled', async () => {
    const { campaign, leadIds } = await campaignWithLeads();
    const r1 = reply(campaign, leadIds[0]!);
    expect((await env.api('PATCH', `/api/replies/${r1}/mark-as-interested`, {})).status).toBe(200);
    expect(dealOf(leadIds[0]!)).toMatchObject({ stage: 'interested', reply_id: r1 });
    await env.api('PATCH', `/api/replies/${r1}/mark-as-not-interested`, {});
    expect(dealOf(leadIds[0]!)).toBeUndefined();

    const r2 = reply(campaign, leadIds[1]!);
    applyLabel(env.ctx, r2, 'interested', { source: 'rules' });
    await env.api('PATCH', `/api/deals/${dealOf(leadIds[1]!).id}`, { value: 500 });
    applyLabel(env.ctx, r2, 'not_interested', { source: 'ai' });
    expect(dealOf(leadIds[1]!)).toMatchObject({ stage: 'interested', value: 500 }); // worked on: kept
  });

  it('lists, creates and deletes deals, and counts them in the workspace stats', async () => {
    const { campaign, leadIds } = await campaignWithLeads(3);
    applyLabel(env.ctx, reply(campaign, leadIds[0]!), 'meeting_request', { source: 'ai' });
    applyLabel(env.ctx, reply(campaign, leadIds[1]!), 'interested', { source: 'ai' });
    const created = await env.api('POST', '/api/deals', { lead_id: leadIds[2], stage: 'won', value: 3000 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await env.api('POST', '/api/deals', { lead_id: leadIds[2] })).status).toBe(409);
    await env.api('PATCH', `/api/deals/${dealOf(leadIds[0]!).id}`, { stage: 'won', value: 1000 });
    await env.api('PATCH', `/api/deals/${dealOf(leadIds[1]!).id}`, { stage: 'lost', lost_reason: 'Budget' });

    const won = await env.api('GET', '/api/deals?stage=won');
    expect(won.body.data.map((d: any) => d.lead.company).sort()).toEqual(['Company0', 'Company2']);
    expect((await env.api('GET', `/api/deals?lead_id=${leadIds[1]}`)).body.data[0]).toMatchObject({ stage: 'lost', lost_reason: 'Budget', campaign_name: 'Q4 outreach' });

    const s = (await env.api('GET', '/api/workspaces/v1.1/stats?days=30')).body.data;
    expect(s).toMatchObject({ meetings: 2, won: 2, won_value: 4000, open_deals: 0 });

    expect((await env.api('DELETE', `/api/deals/${created.body.data.id}`)).status).toBe(200);
    expect((await env.api('GET', '/api/deals')).body.data).toHaveLength(2);
  });
});

describe('learnings in the Knowledge Hub', () => {
  it('keeps the newest lines first, capped, below the intro, pinned in the prompt context', () => {
    const ws = db().get('SELECT id FROM workspaces LIMIT 1').id;
    for (let i = 1; i <= MAX_LEARNINGS + 5; i++) addLearning(env.ctx, ws, `Learning ${i}`);
    const doc = learnings();
    expect(doc.pinned).toBe(1);
    const lines = doc.content.split('\n').filter((l: string) => l.startsWith('- '));
    expect(lines).toHaveLength(MAX_LEARNINGS);
    expect(lines[0]).toBe(`- 2026-10-12 — Learning ${MAX_LEARNINGS + 5}`);
    expect(doc.content.startsWith('What has worked')).toBe(true);
    expect(knowledgeContext(env.ctx, ws)).toContain(`Learning ${MAX_LEARNINGS + 5}`);
  });

  it('records an A/B test winner as a learning', async () => {
    const sender = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex', email: 'alex@bear.test', password: 'pw', provider: 'google', daily_limit: 500 })).body.data;
    const c = (await env.api('POST', '/api/campaigns', { name: 'Q4 outreach' })).body.data;
    const seq = await env.api('PUT', `/api/campaigns/${c.id}/sequence`, {
      steps: [{ email_subject: 'Quick question', email_body: 'A body', variants: [{ email_subject: 'Idea for {COMPANY}', email_body: 'B body' }], ab_test: { enabled: true, min_sends_per_variant: 100, reply_wait_days: 3 } }],
    });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [sender.id] });
    const lead = (await env.api('POST', '/api/leads/multiple', { leads: [{ email: 'l@co.test' }] })).body.data.lead_ids;
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: lead });
    openAllDay(env.ctx, c.id);
    expect((await env.api('POST', `/api/campaigns/${c.id}/launch`)).status).toBe(200);
    const a = seq.body.data.steps[0].id;
    const b = seq.body.data.steps[0].variants[0].id;
    let n = 0;
    const sends = (stepId: number, count: number, replies: number) => {
      for (let i = 0; i < count; i++) {
        const id = db().insert('sent_emails', { workspace_id: c.workspace_id, kind: 'campaign', campaign_id: c.id, sequence_step_id: stepId, step_order: 1, message_id: `f${n++}@x`, to_email: 'x@y.test', subject: 's', sent_at: env.ctx.now().toISOString() });
        if (i < replies) db().insert('replies', { workspace_id: c.workspace_id, campaign_id: c.id, sent_email_id: id, message_id: `fr${n++}@x`, from_email: 'x@y.test', received_at: env.ctx.now().toISOString() });
      }
    };
    sends(a, 120, 5);
    sends(b, 120, 35);
    env.clock.now = new Date(START.getTime() + 4 * 86_400_000);
    expect(evaluateAbTests(env.ctx).decided).toBe(1);
    expect(learnings().content).toMatch(/2026-10-16 — Campaign Q4 outreach step 1: subject "Idea for \{COMPANY\}" beat "Quick question" on reply rate \(29\.17% vs 4\.17%, n=240, \d+% confidence\)\./);
  });
});
