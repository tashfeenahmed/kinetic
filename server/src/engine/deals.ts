/**
 * Deal pipeline: one deal per lead, opened by replies. A reply that counts as interested
 * opens a deal at "interested"; a meeting request opens or advances it to "meeting".
 * Replies only ever move a deal forward and never touch a won or lost deal; everything
 * else (proposal, won, lost, value) is set by hand. Every stage change emits
 * DEAL_STAGE_CHANGED (which also refreshes "Outreach status" cells), and a won deal adds
 * a line to the Knowledge Hub's Learnings doc.
 */
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { tryAddLearning } from '../knowledge/learnings.ts';

export const DEAL_STAGES = ['interested', 'meeting', 'proposal', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

const RANK: Record<DealStage, number> = { interested: 0, meeting: 1, proposal: 2, won: 3, lost: 3 };
export const isOpen = (stage: string) => stage !== 'won' && stage !== 'lost';
/** Stages from "meeting" on count as a meeting held or booked. */
const reachedMeeting = (stage: DealStage) => stage !== 'lost' && RANK[stage] >= RANK.meeting;

/** The headline "Outreach status" for a lead with a deal. */
export const DEAL_STATUS: Record<DealStage, string> = {
  interested: 'interested', meeting: 'meeting booked', proposal: 'proposal sent', won: 'won', lost: 'lost',
};

export function dealOfLead(ctx: Ctx, workspaceId: number, leadId: number): Row | undefined {
  return ctx.db.get('SELECT * FROM deals WHERE workspace_id = ? AND lead_id = ?', [workspaceId, leadId]);
}

/** Moves a deal to a stage (any direction) and emits DEAL_STAGE_CHANGED. No-op when unchanged. */
export function setDealStage(ctx: Ctx, deal: Row, stage: DealStage, source: 'reply' | 'manual', extra: Row = {}): Row {
  const { db } = ctx;
  if (deal.stage === stage) return deal;
  const now = ctx.now().toISOString();
  db.update('deals', deal.id, {
    stage, stage_changed_at: now, updated_at: now,
    ...(reachedMeeting(stage) && !deal.meeting_at ? { meeting_at: now } : {}),
    ...(stage !== 'lost' ? { lost_reason: null } : {}),
    ...extra,
  });
  const fresh = db.get('SELECT * FROM deals WHERE id = ?', [deal.id])!;
  changed(ctx, fresh, deal.stage, source);
  return fresh;
}

/** Opens a deal for a lead (or returns the existing one untouched). */
export function openDeal(ctx: Ctx, workspaceId: number, leadId: number, o: { stage?: DealStage; campaignId?: number | null; replyId?: number | null; source: 'reply' | 'manual'; fields?: Row }): { deal: Row; created: boolean } {
  const { db } = ctx;
  const existing = dealOfLead(ctx, workspaceId, leadId);
  if (existing) return { deal: existing, created: false };
  const stage = o.stage ?? 'interested';
  const now = ctx.now().toISOString();
  const id = db.insert('deals', {
    workspace_id: workspaceId, lead_id: leadId, campaign_id: o.campaignId ?? null, reply_id: o.replyId ?? null, stage,
    meeting_at: reachedMeeting(stage) ? now : null, stage_changed_at: now, created_at: now, updated_at: now, ...o.fields,
  });
  const deal = db.get('SELECT * FROM deals WHERE id = ?', [id])!;
  changed(ctx, deal, null, o.source);
  return { deal, created: true };
}

/**
 * Called whenever a reply's label or interested flag is set (rules, AI or by hand).
 * Interested replies open a deal; meeting requests open or advance it to "meeting".
 */
export function dealFromReply(ctx: Ctx, reply: Row) {
  if (!reply.lead_id || !reply.interested) return;
  const target: DealStage = reply.label === 'meeting_request' ? 'meeting' : 'interested';
  const { deal, created } = openDeal(ctx, reply.workspace_id, reply.lead_id, { stage: target, campaignId: reply.campaign_id, replyId: reply.id, source: 'reply' });
  if (!created && isOpen(deal.stage) && RANK[target] > RANK[deal.stage as DealStage]) setDealStage(ctx, deal, target, 'reply');
}

/**
 * A reply that opened a deal is re-labelled as not interested (e.g. the AI corrects the
 * keyword rules): drop the deal if nobody has worked on it yet.
 */
export function undoDealFromReply(ctx: Ctx, reply: Row) {
  if (!reply.lead_id) return;
  ctx.db.run(`DELETE FROM deals WHERE workspace_id = ? AND lead_id = ? AND reply_id = ? AND stage = 'interested' AND value IS NULL AND notes IS NULL`,
    [reply.workspace_id, reply.lead_id, reply.id]);
}

function changed(ctx: Ctx, deal: Row, from: string | null, source: 'reply' | 'manual') {
  const { db } = ctx;
  const lead = db.get('SELECT email, first_name, last_name, company FROM leads WHERE id = ?', [deal.lead_id]);
  const campaign = deal.campaign_id ? db.get('SELECT name FROM campaigns WHERE id = ?', [deal.campaign_id]) : null;
  emit(ctx, deal.workspace_id, 'DEAL_STAGE_CHANGED', {
    deal_id: deal.id, lead_id: deal.lead_id, lead_email: lead?.email ?? null, company: lead?.company ?? null,
    campaign_id: deal.campaign_id, campaign_name: campaign?.name ?? null, from_stage: from, to_stage: deal.stage,
    value: deal.value, currency: deal.currency, lost_reason: deal.lost_reason, source,
  }, { lead_id: deal.lead_id, campaign_id: deal.campaign_id, reply_id: deal.reply_id });
  if (deal.stage === 'won') tryAddLearning(ctx, deal.workspace_id, wonLearning(ctx, deal, lead, campaign));
}

/** "Won deal with Acme (€12,000) from campaign Q4 outreach (step 1, variant B: "Idea for Acme")." */
function wonLearning(ctx: Ctx, deal: Row, lead: Row | undefined, campaign: Row | null): string {
  const who = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.email || `lead #${deal.lead_id}`;
  const value = deal.value != null ? ` (${deal.currency ? `${deal.currency} ` : ''}${Number(deal.value).toLocaleString('en-US')})` : '';
  let from = '';
  if (campaign) {
    // The email the opening reply answered tells which step and variant worked.
    const step = deal.reply_id ? ctx.db.get(
      `SELECT st.id, st.step_order, st.email_subject, st.variant_of_step_id FROM replies r
       JOIN sent_emails se ON se.id = r.sent_email_id JOIN sequence_steps st ON st.id = se.sequence_step_id WHERE r.id = ?`, [deal.reply_id]) : null;
    let detail = '';
    if (step) {
      const main = step.variant_of_step_id ?? step.id;
      const siblings = ctx.db.all('SELECT id FROM sequence_steps WHERE id = ? OR variant_of_step_id = ? ORDER BY variant_of_step_id IS NOT NULL, id', [main, main]);
      const letter = siblings.length > 1 ? `, variant ${String.fromCharCode(65 + siblings.findIndex((s) => s.id === step.id))}` : '';
      detail = ` (step ${step.step_order}${letter}${step.email_subject ? `: "${String(step.email_subject).slice(0, 70)}"` : ''})`;
    }
    from = ` from campaign ${campaign.name}${detail}`;
  }
  return `Won deal with ${who}${value}${from}.`;
}
