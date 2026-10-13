/**
 * AI reply sorting. Inbox sync stores every reply with the cheap rule-based label and,
 * when AI sorting is on and a key is set, queues it (`replies.ai_status = 'pending'`).
 * The `reply-ai` worker job classifies queued replies through OpenRouter and applies
 * the new label: flags, campaign-lead status, webhooks, auto-unsubscribe and
 * out-of-office pauses. Errors leave the rule label in place. A label the user set by
 * hand (`label_source = 'manual'`) is never changed by the AI.
 */
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { bool } from '../http.ts';
import { sha256 } from '../lib/crypto.ts';
import { htmlToText } from '../lib/html.ts';
import { getJson } from '../gtm/lib/http.ts';
import { DEFAULT_MODEL } from '../gtm/engine/agent.ts';
import { Settings } from '../gtm/settings.ts';
import {
  AUTOMATED_LABELS, CLASSIFY_SYSTEM, classifyPrompt, coarseCategory, INTERESTED_LABELS, parseClassification, parseReturnDate,
  replyText, ruleLabel, type Classification, type ReplyLabel,
} from '../mail/replyLabels.ts';
import { cancelScheduled } from './sequencer.ts';
import { unsubscribeLead } from './inbox.ts';
import { dealFromReply, undoDealFromReply } from './deals.ts';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const inboxAiBody = {
  ai_reply_sorting: bool.optional(),
  ai_reply_model: z.string().trim().max(200).nullable().optional(),
  ai_auto_unsubscribe: bool.optional(),
  ai_pause_on_ooo: bool.optional(),
};

/** The AI part of the master inbox settings, as the API returns it. */
export function inboxAiSettings(ctx: Ctx, w: Row) {
  const ai = aiConfig(ctx);
  return {
    ai_reply_sorting: !!w.ai_reply_sorting,
    ai_reply_model: w.ai_reply_model || null,
    ai_auto_unsubscribe: !!w.ai_auto_unsubscribe,
    ai_pause_on_ooo: !!w.ai_pause_on_ooo,
    ai_configured: ai.configured,
    ai_effective_model: w.ai_reply_model || ai.defaultModel,
  };
}

const settingsOf = (ctx: Ctx) => ctx.gtm?.settings ?? new Settings(ctx.db);

/** OpenRouter (or a local OpenAI-compatible server via AI_BASE_URL), like the AI research columns. */
export function aiConfig(ctx: Ctx) {
  const s = settingsOf(ctx);
  const base = (s.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const local = !base.includes('openrouter.ai');
  const key = s.get('OPENROUTER_API_KEY');
  return { base, local, key, configured: local || !!key, defaultModel: s.get('AI_MODEL') || DEFAULT_MODEL };
}

export const modelFor = (ctx: Ctx, ws: Row) => (ws.ai_reply_model as string) || aiConfig(ctx).defaultModel;

/** Is AI sorting active for this workspace (setting on and a key/local model available)? */
export const aiSortingActive = (ctx: Ctx, ws: Row) => !!ws.ai_reply_sorting && aiConfig(ctx).configured;

/** One chat completion; returns the assistant text. */
export async function chat(ctx: Ctx, o: { model: string; system: string; user: string; maxTokens?: number; temperature?: number }): Promise<{ content: string; costUsd: number }> {
  const ai = aiConfig(ctx);
  if (!ai.configured) throw new Error('Set OPENROUTER_API_KEY on the Integrations page, or AI_BASE_URL for a local model');
  const d = await getJson(`${ai.base}/chat/completions`, {
    headers: ai.local ? {} : { authorization: `Bearer ${ai.key}`, 'HTTP-Referer': 'http://localhost/kineticsand', 'X-Title': 'kineticsand' },
    json: {
      model: o.model, temperature: o.temperature ?? 0, max_tokens: o.maxTokens ?? 400,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      ...(ai.local ? {} : { usage: { include: true } }),
    },
    timeoutMs: 60_000,
  });
  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`The model returned no text: ${JSON.stringify(d).slice(0, 200)}`);
  return { content, costUsd: Number(d?.usage?.cost ?? 0) };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Classifies one stored reply (cached by message content + model). Throws when the model fails. */
export async function classifyReply(ctx: Ctx, reply: Row, opts: { model: string; fresh?: boolean }): Promise<Classification> {
  const ours = reply.sent_email_id ? ctx.db.get('SELECT body_text, body_html FROM sent_emails WHERE id = ?', [reply.sent_email_id]) : null;
  const user = classifyPrompt({
    subject: reply.subject ?? '', fromName: reply.from_name ?? '', fromEmail: reply.from_email ?? '',
    body: replyText(reply.body_text ?? '', reply.body_html ?? ''),
    ourLastEmail: ours ? (ours.body_text || htmlToText(ours.body_html || '')) : undefined,
    today: ctx.now().toISOString().slice(0, 10),
  });
  const key = sha256(`${opts.model}\n${user}`);
  if (!opts.fresh) {
    const hit = ctx.db.get<{ result: string }>('SELECT result FROM reply_ai_cache WHERE key = ?', [key]);
    if (hit) return JSON.parse(hit.result);
  }
  const { content } = await chat(ctx, { model: opts.model, system: CLASSIFY_SYSTEM, user, maxTokens: 400 });
  const parsed = parseClassification(content);
  if (!parsed) throw new Error(`Unreadable model answer: ${content.slice(0, 200)}`);
  ctx.db.run('INSERT OR REPLACE INTO reply_ai_cache (key, result, created_at) VALUES (?, ?, ?)', [key, JSON.stringify(parsed), ctx.now().toISOString()]);
  return parsed;
}

/** Whether a stored reply is worth an AI call: human replies, plus auto-replies that read like out-of-office notes. */
function wantsAi(reply: Row, label: ReplyLabel) {
  if (reply.folder === 'bounced' || label === 'bounce' || label === 'other') return false;
  return !reply.automated || label === 'out_of_office';
}

/**
 * Called by inbox sync right after a reply is stored with its rule category. Queues it for
 * the AI, or (no AI) applies the rule-refined label, e.g. out-of-office with a return date.
 */
export function afterReplyStored(ctx: Ctx, replyId: number) {
  const { db } = ctx;
  const reply = db.get('SELECT * FROM replies WHERE id = ?', [replyId]);
  if (!reply) return;
  const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [reply.workspace_id])!;
  const body = replyText(reply.body_text ?? '', reply.body_html ?? '');
  const label = ruleLabel(reply.category, reply.subject ?? '', body);
  if (aiSortingActive(ctx, ws) && wantsAi(reply, label)) {
    db.update('replies', reply.id, { label: reply.category, ai_status: 'pending' });
    dealFromReply(ctx, { ...reply, label: reply.category });
    return;
  }
  db.update('replies', reply.id, { label: reply.category });
  if (label !== reply.category) {
    const ret = label === 'out_of_office' ? parseReturnDate(`${reply.subject}\n${body}`, ctx.now()) : null;
    applyLabel(ctx, reply.id, label, { source: 'rules', details: { return_date: ret } });
  } else {
    dealFromReply(ctx, { ...reply, label: reply.category });
  }
}

export interface ApplyOpts {
  source: 'rules' | 'ai' | 'manual';
  info?: Classification;
  details?: Record<string, unknown>;
  model?: string;
  skipWebhooks?: boolean;
}

/**
 * Sets a reply's label and keeps everything that depends on it consistent: the coarse
 * category, interested/automated flags, the campaign lead's status, webhooks
 * (LEAD_INTERESTED, LEAD_MEETING_REQUEST, LEAD_OUT_OF_OFFICE), auto-unsubscribe and
 * out-of-office pauses. Returns false when an AI label is refused because the user set one.
 */
export function applyLabel(ctx: Ctx, replyId: number, label: ReplyLabel, o: ApplyOpts): boolean {
  const { db } = ctx;
  const reply = db.get('SELECT * FROM replies WHERE id = ?', [replyId]);
  if (!reply) return false;
  if (o.source !== 'manual' && reply.label_source === 'manual') return false;
  const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [reply.workspace_id])!;
  const prev: string = reply.label ?? reply.category;

  // A machine-written message can't become a human reply because a model said so.
  if (o.source === 'ai' && reply.automated && !AUTOMATED_LABELS.has(label) && !['referral', 'wrong_person', 'unsubscribe'].includes(label)) label = 'auto_reply';
  if (o.source === 'ai' && reply.folder === 'bounced') label = 'bounce';

  const interested = INTERESTED_LABELS.has(label) && (o.source === 'manual' || !!ws.auto_interested_categorization);
  const automated = AUTOMATED_LABELS.has(label) || (!!reply.automated && o.source !== 'manual' && label !== 'unsubscribe');
  const details = o.info
    ? { objection_type: o.info.objection_type, referral: o.info.referral, return_date: o.info.return_date }
    : o.details ?? (o.source === 'manual' ? null : JSON.parse(reply.ai_details || 'null'));
  const now = ctx.now().toISOString();

  const lead = reply.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', [reply.lead_id]) : null;
  const refs = { reply_id: reply.id, lead_id: reply.lead_id, campaign_id: reply.campaign_id, sender_email_id: reply.sender_email_id };
  const data = (extra: Record<string, unknown> = {}) => ({
    reply_id: reply.id, lead_id: reply.lead_id, lead_email: lead?.email ?? null, from_email: reply.from_email, subject: reply.subject,
    campaign_id: reply.campaign_id, label, source: o.source, summary: o.info?.summary ?? null, ...extra,
  });
  const emitOpts = { skipWebhooks: !!o.skipWebhooks };

  db.tx(() => {
    const update: Row = {
      label, label_source: o.source, category: coarseCategory(label, interested), interested: interested ? 1 : 0, automated: automated ? 1 : 0,
      ai_details: details ? JSON.stringify(details) : null,
    };
    if (o.info) {
      Object.assign(update, {
        ai_confidence: o.info.confidence, ai_summary: o.info.summary || null, ai_next_action: o.info.next_action || null,
        ai_model: o.model ?? null, ai_status: 'done', ai_error: null, ai_classified_at: now,
      });
    } else if (o.source === 'manual') {
      update.ai_status = reply.ai_status === 'pending' || reply.ai_status === 'refresh' ? 'done' : reply.ai_status;
    }
    db.update('replies', reply.id, update);

    const cl = reply.lead_id && reply.campaign_id ? db.get('SELECT * FROM campaign_leads WHERE lead_id = ? AND campaign_id = ?', [reply.lead_id, reply.campaign_id]) : null;

    // Interested flag changes: stop/continue the campaign lead and tell webhooks.
    // Deals: interested replies open one, meeting requests advance it; a reversed label drops an untouched one.
    if (interested) dealFromReply(ctx, { ...reply, label, interested: 1 });
    else if (reply.interested) undoDealFromReply(ctx, reply);

    if (interested && !reply.interested) {
      if (cl && ['pending', 'in_sequence', 'replied', 'completed'].includes(cl.status)) {
        db.update('campaign_leads', cl.id, { status: 'interested', next_due_at: null });
        cancelScheduled(ctx, { campaignLeadId: cl.id }, 'marked interested');
      }
      if (reply.lead_id) emit(ctx, reply.workspace_id, 'LEAD_INTERESTED', { ...data(), interested: true, manual: o.source === 'manual' }, refs, emitOpts);
    } else if (!interested && reply.interested && cl?.status === 'interested') {
      db.update('campaign_leads', cl.id, { status: 'replied' });
    }

    // A "reply" that turns out to be automatic shouldn't have stopped the sequence.
    if (automated && !reply.automated && cl?.status === 'replied' && o.source !== 'manual') {
      const others = db.get(`SELECT COUNT(*) n FROM replies WHERE lead_id = ? AND campaign_id = ? AND automated = 0 AND folder != 'bounced' AND id != ?`, [reply.lead_id, reply.campaign_id, reply.id]).n;
      if (!others) db.update('campaign_leads', cl.id, { status: cl.current_step > 0 ? 'in_sequence' : 'pending' });
    }

    if (label === 'meeting_request' && prev !== 'meeting_request' && reply.lead_id) {
      emit(ctx, reply.workspace_id, 'LEAD_MEETING_REQUEST', data({ next_action: o.info?.next_action ?? null }), refs, emitOpts);
    }

    if (label === 'out_of_office' && prev !== 'out_of_office' && reply.lead_id) {
      const ret = (details as any)?.return_date ?? null;
      let pausedUntil: string | null = null;
      if (ret && ws.ai_pause_on_ooo) pausedUntil = pauseLeadUntil(ctx, reply.lead_id, ret);
      emit(ctx, reply.workspace_id, 'LEAD_OUT_OF_OFFICE', data({ return_date: ret, paused_until: pausedUntil }), refs, emitOpts);
    }

    if (label === 'unsubscribe' && prev !== 'unsubscribe' && lead && (o.source === 'manual' || ws.ai_auto_unsubscribe)) {
      unsubscribeLead(ctx, lead, o.source === 'ai' ? 'ai_reply' : o.source === 'manual' ? 'inbox' : 'reply');
    }
  });
  return true;
}

/**
 * Holds a lead's active campaigns until a date: pushes `next_due_at` (the sequencer only
 * plans leads whose next_due_at has passed) and cancels already booked slots, which are
 * re-planned after the date. Returns the pause end (ISO), or null when nothing was paused.
 */
export function pauseLeadUntil(ctx: Ctx, leadId: number, date: string): string | null {
  const until = new Date(/T/.test(date) ? date : `${date}T08:00:00Z`);
  const now = ctx.now().getTime();
  if (Number.isNaN(until.getTime()) || until.getTime() <= now || until.getTime() - now > 180 * 86_400_000) return null;
  const iso = until.toISOString();
  const n = ctx.db.run(
    `UPDATE campaign_leads SET next_due_at = CASE WHEN next_due_at IS NOT NULL AND next_due_at > ? THEN next_due_at ELSE ? END
     WHERE lead_id = ? AND status IN ('pending','in_sequence')`, [iso, iso, leadId]).changes;
  if (!n) return null;
  cancelScheduled(ctx, { leadId }, `out of office until ${date.slice(0, 10)}`);
  return iso;
}

const CONCURRENCY = 4;

/** Worker job: classifies queued replies. Returns how many were processed. */
export async function classifyPending(ctx: Ctx, limit = 24): Promise<{ classified: number; failed: number; skipped: number }> {
  const { db } = ctx;
  const out = { classified: 0, failed: 0, skipped: 0 };
  const rows = db.all(`SELECT * FROM replies WHERE ai_status IN ('pending','refresh') ORDER BY id LIMIT ?`, [limit]);
  const wsCache = new Map<number, Row>();
  const one = async (reply: Row) => {
    const ws = wsCache.get(reply.workspace_id) ?? db.get('SELECT * FROM workspaces WHERE id = ?', [reply.workspace_id])!;
    wsCache.set(reply.workspace_id, ws);
    if (reply.label_source === 'manual' || !aiSortingActive(ctx, ws)) {
      db.update('replies', reply.id, { ai_status: null });
      out.skipped++;
      return;
    }
    const model = modelFor(ctx, ws);
    try {
      const info = await classifyReply(ctx, reply, { model, fresh: reply.ai_status === 'refresh' });
      // The user may have relabelled it while the model was thinking.
      if (!applyLabel(ctx, reply.id, info.label, { source: 'ai', info, model })) db.update('replies', reply.id, { ai_status: 'done' });
      out.classified++;
    } catch (e: any) {
      ctx.log.warn({ err: e?.message, reply: reply.id }, 'AI reply classification failed; keeping the rule label');
      db.update('replies', reply.id, { ai_status: 'failed', ai_error: String(e?.message ?? e).slice(0, 500) });
      out.failed++;
    }
  };
  for (let i = 0; i < rows.length; i += CONCURRENCY) await Promise.all(rows.slice(i, i + CONCURRENCY).map(one));
  return out;
}

// ---------------------------------------------------------------------------
// Draft a reply
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = `You write short, human replies for a salesperson answering a prospect in an email thread.
Rules: plain text only, no subject line, no placeholders like [Name] (use what you know or leave it out), no signature (it is added automatically).
Match the thread's language and tone. Keep it under 120 words unless the prospect asked detailed questions. Answer their questions directly using only the facts given;
if a fact is missing, say you will follow up rather than inventing it. When they want a meeting, propose a concrete next step.`;

export interface DraftContext {
  instructions?: string;
  knowledge?: string | null;
}

/** Builds the prompt from the thread, the lead, the campaign and optional knowledge, and asks the model for a draft. */
export async function draftReply(ctx: Ctx, reply: Row, o: DraftContext): Promise<{ draft: string; model: string }> {
  const { db } = ctx;
  const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [reply.workspace_id])!;
  const model = modelFor(ctx, ws);
  const sent = reply.thread_id ? db.all(`SELECT 'us' AS who, body_text, body_html, sent_at AS at FROM sent_emails WHERE thread_id = ?`, [reply.thread_id]) : [];
  const got = reply.thread_id ? db.all(`SELECT 'them' AS who, body_text, body_html, received_at AS at FROM replies WHERE thread_id = ? AND folder != 'bounced'`, [reply.thread_id]) : [reply];
  const thread = [...sent, ...got].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-8)
    .map((m) => `${m.who === 'us' ? 'US' : 'PROSPECT'} (${String(m.at).slice(0, 10)}):\n${replyText(m.body_text ?? '', m.body_html ?? '').slice(0, 1500)}`);
  const lead = reply.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', [reply.lead_id]) : null;
  const campaign = reply.campaign_id ? db.get('SELECT name FROM campaigns WHERE id = ?', [reply.campaign_id]) : null;
  const sender = reply.sender_email_id ? db.get('SELECT name, email FROM sender_emails WHERE id = ?', [reply.sender_email_id]) : null;
  const vars = lead ? Object.entries(JSON.parse(lead.custom_variables || '{}')).slice(0, 15).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('; ') : '';
  const user = [
    sender ? `You are writing as ${sender.name} <${sender.email}>.` : '',
    lead ? `Prospect: ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || reply.from_name || reply.from_email}, ${[lead.title, lead.company].filter(Boolean).join(' at ')}${vars ? `\nKnown details: ${vars}` : ''}` : `Prospect: ${reply.from_name || ''} <${reply.from_email}>`,
    campaign ? `Campaign: ${campaign.name}` : '',
    reply.label && reply.label !== 'reply' ? `Reply category: ${reply.label}${reply.ai_summary ? ` — ${reply.ai_summary}` : ''}${reply.ai_next_action ? `\nSuggested next action: ${reply.ai_next_action}` : ''}` : '',
    o.knowledge ? `Facts about our company and offer (use only if relevant):\n"""${o.knowledge.slice(0, 4000)}"""` : '',
    `Thread (oldest first):\n${thread.join('\n\n')}`,
    o.instructions ? `Extra instructions from the salesperson: ${o.instructions.slice(0, 1000)}` : '',
    'Write the reply to the last PROSPECT message now.',
  ].filter(Boolean).join('\n\n');
  const { content } = await chat(ctx, { model, system: DRAFT_SYSTEM, user, maxTokens: 600, temperature: 0.4 });
  return { draft: content.replace(/^```\w*\n?|```$/g, '').replace(/^subject:.*\n+/i, '').trim(), model };
}
