/**
 * Campaign sequencing.
 *
 * plan()     — for every active campaign whose sending window is open, assigns due
 *              leads to sender mailboxes and books send slots (scheduled_emails),
 *              respecting every daily limit. Slots are spread evenly through the rest
 *              of the window with jitter, and spaced per mailbox across campaigns.
 * dispatch() — sends the slots that are due and advances each lead's progress.
 */
import { DateTime } from 'luxon';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { localDayStart, openWindow, type SendSchedule } from '../lib/schedule.ts';
import { domainOf } from '../lib/dns.ts';
import { chooseVariant, composeCampaignEmail } from './compose.ts';
import { ensureThread } from './threads.ts';
import { bumpVisits, dueAfterSend, resolveNextStep } from './branching.ts';
import { mayEnterStep } from './abtest.ts';

const MIN_GAP_MS = 45_000;
const ACTIVE_SLOT = `('scheduled','sending')`;
const COUNTED_SLOT = `('scheduled','sending','sent')`;

export function campaignSchedule(c: Row): SendSchedule {
  return { days: JSON.parse(c.schedule_days), start_time: c.schedule_start_time, end_time: c.schedule_end_time, timezone: c.schedule_timezone };
}

/** Main steps of a campaign (order -> variants including the main row). */
export function loadSteps(ctx: Ctx, campaignId: number): Map<number, Row[]> {
  const rows = ctx.db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY step_order, id', [campaignId]);
  const byOrder = new Map<number, Row[]>();
  for (const r of rows) {
    const list = byOrder.get(r.step_order) ?? [];
    list.push(r);
    byOrder.set(r.step_order, list);
  }
  return byOrder;
}

function isBlacklisted(ctx: Ctx, workspaceId: number, email: string): boolean {
  return !!ctx.db.get(
    `SELECT 1 FROM blacklisted_emails WHERE workspace_id = ? AND email = ?
     UNION ALL SELECT 1 FROM blacklisted_domains WHERE workspace_id = ? AND domain = ? LIMIT 1`,
    [workspaceId, email, workspaceId, domainOf(email)],
  );
}

export function plan(ctx: Ctx): { planned: number } {
  const now = ctx.now();
  let planned = 0;
  const campaigns = ctx.db.all(`SELECT * FROM campaigns WHERE status = 'active'`);
  for (const c of campaigns) {
    try {
      planned += ctx.db.tx(() => planCampaign(ctx, c, now));
    } catch (err) {
      ctx.log.error({ err, campaign: c.id }, 'planning failed');
    }
  }
  return { planned };
}

function planCampaign(ctx: Ctx, c: Row, now: Date): number {
  const { db } = ctx;
  const schedule = campaignSchedule(c);
  const window = openWindow(schedule, now);
  if (!window) return 0;

  const steps = loadSteps(ctx, c.id);
  const maxStep = Math.max(0, ...steps.keys());
  if (maxStep === 0) return 0;

  const dayStart = localDayStart(schedule.timezone, now).toISOString();
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();

  let campaignLeft = c.max_emails_per_day - (db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM scheduled_emails WHERE campaign_id = ? AND status IN ${COUNTED_SLOT} AND scheduled_at >= ? AND scheduled_at < ?`,
    [c.id, dayStart, dayEnd])?.n ?? 0);
  let newLeft = c.max_new_leads_per_day - (db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM scheduled_emails WHERE campaign_id = ? AND step_order = 1 AND status IN ${COUNTED_SLOT} AND scheduled_at >= ? AND scheduled_at < ?`,
    [c.id, dayStart, dayEnd])?.n ?? 0);
  if (campaignLeft <= 0) return 0;

  // Mailboxes attached to this campaign that can send.
  const senders = db.all(
    `SELECT s.* FROM sender_emails s JOIN campaign_sender_emails cs ON cs.sender_email_id = s.id
     WHERE cs.campaign_id = ? AND s.status = 'Connected'`, [c.id]);
  if (!senders.length) return 0;
  const senderLeft = new Map<number, number>();
  const senderNext = new Map<number, number>();
  for (const s of senders) {
    const used = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM scheduled_emails WHERE sender_email_id = ? AND status IN ${COUNTED_SLOT} AND scheduled_at >= ? AND scheduled_at < ?`,
      [s.id, dayStart, dayEnd])?.n ?? 0;
    // Warmup mail from the same mailbox counts against its daily limit, so the two never stack.
    const warm = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM warmup_emails WHERE from_sender_id = ? AND status IN ('scheduled','sent') AND scheduled_at >= ? AND scheduled_at < ?`,
      [s.id, dayStart, dayEnd])?.n ?? 0;
    senderLeft.set(s.id, Math.max(0, s.daily_limit - used - warm));
    senderNext.set(s.id, Math.max(now.getTime(), s.next_send_at ? Date.parse(s.next_send_at) : 0));
  }
  const senderById = new Map(senders.map((s) => [s.id as number, s]));

  // Leads ready for their next step with nothing already booked.
  const followupsFirst = c.sequence_prioritization === 'followups';
  const candidates = db.all(
    `SELECT cl.*, l.email, l.status AS lead_status FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = ? AND cl.status IN ('pending','in_sequence')
       AND (cl.next_due_at IS NULL OR cl.next_due_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM scheduled_emails se WHERE se.campaign_lead_id = cl.id AND se.status IN ${ACTIVE_SLOT})
     ORDER BY CASE WHEN cl.current_step > 0 THEN ${followupsFirst ? 0 : 1} ELSE ${followupsFirst ? 1 : 0} END, cl.id
     LIMIT 5000`,
    [c.id, now.toISOString()]);

  const domainCount = new Map<string, number>();
  const domainCap = c.daily_max_sends_per_receiving_domain;
  let count = 0;

  for (const cl of candidates) {
    if (campaignLeft <= 0) break;

    if (['unsubscribed', 'bounced'].includes(cl.lead_status) || isBlacklisted(ctx, c.workspace_id, cl.email)) {
      db.update('campaign_leads', cl.id, { status: cl.lead_status === 'bounced' ? 'bounced' : cl.lead_status === 'unsubscribed' ? 'unsubscribed' : 'stopped' });
      continue;
    }
    // Branching rules of the last step sent pick the next step (linear: current_step + 1).
    const next = resolveNextStep(ctx, c, cl, steps, now);
    if (next.kind !== 'send') continue;
    const nextOrder = next.order;
    if (nextOrder > maxStep) {
      db.update('campaign_leads', cl.id, { status: 'completed', next_due_at: null });
      continue;
    }
    if (nextOrder === 1 && newLeft <= 0) continue;
    // A/B test on a share of leads: the rest wait here until a winner is picked.
    if (!mayEnterStep(steps.get(nextOrder) ?? [], cl.lead_id, nextOrder)) continue;

    const variant = chooseVariant(steps.get(nextOrder) ?? [], cl.lead_id, nextOrder);
    if (!variant) {
      // Every variant of this step is switched off: skip the step.
      db.update('campaign_leads', cl.id, { current_step: nextOrder, next_step: null });
      continue;
    }

    if (domainCap > 0) {
      const d = domainOf(cl.email);
      if (!domainCount.has(d)) {
        domainCount.set(d, db.get<{ n: number }>(
          `SELECT COUNT(*) n FROM scheduled_emails se JOIN leads l ON l.id = se.lead_id
           WHERE se.campaign_id = ? AND se.status IN ${COUNTED_SLOT} AND se.scheduled_at >= ? AND se.scheduled_at < ? AND l.email LIKE ?`,
          [c.id, dayStart, dayEnd, `%@${d}`])?.n ?? 0);
      }
      if (domainCount.get(d)! >= domainCap) continue;
    }

    // Keep a lead on the same mailbox for the whole sequence (threading + consistency).
    let sender: Row | undefined;
    if (cl.sender_email_id && senderById.has(cl.sender_email_id)) {
      sender = senderById.get(cl.sender_email_id);
      if (!senderLeft.get(sender!.id)) continue;
    } else {
      sender = senders.filter((s) => senderLeft.get(s.id)! > 0).sort((a, b) => senderLeft.get(b.id)! - senderLeft.get(a.id)! || senderNext.get(a.id)! - senderNext.get(b.id)!)[0];
      if (!sender) break;
    }
    if (!sender) continue;

    const at = senderNext.get(sender.id)!;
    if (at >= window.end.getTime()) {
      senderLeft.set(sender.id, 0);
      continue;
    }
    const remainingMs = window.end.getTime() - at;
    const gap = Math.max(MIN_GAP_MS, remainingMs / Math.max(1, senderLeft.get(sender.id)!));
    const jittered = gap * (0.7 + Math.random() * 0.6);
    senderNext.set(sender.id, at + jittered);
    senderLeft.set(sender.id, senderLeft.get(sender.id)! - 1);

    db.insert('scheduled_emails', {
      workspace_id: c.workspace_id,
      campaign_id: c.id,
      campaign_lead_id: cl.id,
      lead_id: cl.lead_id,
      sequence_step_id: variant.id,
      step_order: nextOrder,
      sender_email_id: sender.id,
      scheduled_at: new Date(at).toISOString(),
      status: 'scheduled',
    });
    if (!cl.sender_email_id) db.update('campaign_leads', cl.id, { sender_email_id: sender.id, status: 'in_sequence' });
    else if (cl.status === 'pending') db.update('campaign_leads', cl.id, { status: 'in_sequence' });

    campaignLeft--;
    if (nextOrder === 1) newLeft--;
    if (domainCap > 0) domainCount.set(domainOf(cl.email), domainCount.get(domainOf(cl.email))! + 1);
    count++;
  }

  for (const s of senders) db.update('sender_emails', s.id, { next_send_at: new Date(senderNext.get(s.id)!).toISOString() });
  maybeComplete(ctx, c);
  return count;
}

/** Marks a campaign completed once no lead has work left. */
function maybeComplete(ctx: Ctx, c: Row) {
  const open = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','in_sequence')`, [c.id])?.n ?? 0;
  const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ?', [c.id])?.n ?? 0;
  if (total > 0 && open === 0) {
    ctx.db.update('campaigns', c.id, { status: 'completed', updated_at: ctx.now().toISOString() });
    emit(ctx, c.workspace_id, 'CAMPAIGN_COMPLETED', { campaign_id: c.id, campaign_name: c.name }, { campaign_id: c.id });
  }
}

/** Sends due slots. Returns how many were sent / failed. */
export async function dispatch(ctx: Ctx, limit = 50): Promise<{ sent: number; failed: number }> {
  const now = ctx.now();
  const due = ctx.db.all(
    `SELECT * FROM scheduled_emails WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?`,
    [now.toISOString(), limit]);
  let sent = 0;
  let failed = 0;
  for (const slot of due) {
    const claimed = ctx.db.run(`UPDATE scheduled_emails SET status = 'sending' WHERE id = ? AND status = 'scheduled'`, [slot.id]).changes;
    if (!claimed) continue;
    const r = await sendSlot(ctx, slot);
    if (r === 'sent') sent++;
    else if (r === 'failed') failed++;
  }
  return { sent, failed };
}

async function sendSlot(ctx: Ctx, slot: Row): Promise<'sent' | 'failed' | 'cancelled'> {
  const { db } = ctx;
  const cancel = (reason: string) => {
    db.update('scheduled_emails', slot.id, { status: 'cancelled', error: reason });
    return 'cancelled' as const;
  };

  const campaign = db.get('SELECT * FROM campaigns WHERE id = ?', [slot.campaign_id]);
  const cl = db.get('SELECT * FROM campaign_leads WHERE id = ?', [slot.campaign_lead_id]);
  const lead = db.get('SELECT * FROM leads WHERE id = ?', [slot.lead_id]);
  const step = db.get('SELECT * FROM sequence_steps WHERE id = ?', [slot.sequence_step_id]);
  const sender = db.get('SELECT * FROM sender_emails WHERE id = ?', [slot.sender_email_id]);
  if (!campaign || !cl || !lead || !step || !sender) return cancel('missing data');
  if (campaign.status !== 'active') return cancel(`campaign ${campaign.status}`);
  if (!['pending', 'in_sequence'].includes(cl.status)) return cancel(`lead ${cl.status}`);
  if (['unsubscribed', 'bounced'].includes(lead.status) || isBlacklisted(ctx, campaign.workspace_id, lead.email)) return cancel('lead not sendable');
  if (sender.status !== 'Connected') return cancel('sender not connected');
  if ((cl.next_step ?? cl.current_step + 1) !== slot.step_order) return cancel('step already sent');

  // A slot that slipped well past its window (e.g. the app was stopped) is re-planned instead.
  const late = ctx.now().getTime() - Date.parse(slot.scheduled_at);
  if (late > 30 * 60_000 && !openWindow(campaignSchedule(campaign), ctx.now())) return cancel('missed sending window');

  let previous: Row | null = cl.current_step > 0
    ? db.get('SELECT * FROM sent_emails WHERE campaign_lead_id = ? ORDER BY id DESC LIMIT 1', [cl.id]) ?? null
    : null;
  // Reply follow-up campaigns continue the conversation the lead started.
  let forceThread = false;
  if (campaign.type === 'reply_followup' && cl.anchor_reply_id) {
    const anchor = db.get('SELECT * FROM replies WHERE id = ?', [cl.anchor_reply_id]);
    if (anchor && (!previous || Date.parse(anchor.received_at) > Date.parse(previous.sent_at))) {
      previous = { ...anchor, sent_at: anchor.received_at };
    }
    forceThread = !!previous;
  }

  const { message, trackingToken } = composeCampaignEmail(ctx, { campaign, step, lead, sender, previous, forceThread });
  try {
    const res = await ctx.mail.send(sender, message);
    if (res.rejected.length && !res.accepted.length) throw new Error(`rejected: ${res.response}`);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    db.tx(() => {
      db.update('scheduled_emails', slot.id, { status: 'failed', error: msg.slice(0, 500) });
      // Back off this lead for 30 minutes so a broken mailbox does not hot-loop.
      db.update('campaign_leads', cl.id, { next_due_at: new Date(ctx.now().getTime() + 30 * 60_000).toISOString() });
      if (isAuthError(err)) markDisconnected(ctx, sender, msg);
    });
    ctx.log.warn({ slot: slot.id, err: msg }, 'send failed');
    return 'failed';
  }

  const sentAt = ctx.now().toISOString();
  db.tx(() => {
    const threadId = ensureThread(ctx, { workspaceId: campaign.workspace_id, senderId: sender.id, leadId: lead.id, campaignId: campaign.id, subject: message.subject, previousThreadId: previous?.thread_id ?? null });
    const sentId = db.insert('sent_emails', {
      workspace_id: campaign.workspace_id,
      kind: 'campaign',
      campaign_id: campaign.id,
      campaign_lead_id: cl.id,
      lead_id: lead.id,
      sequence_step_id: step.id,
      step_order: slot.step_order,
      sender_email_id: sender.id,
      thread_id: threadId,
      message_id: message.messageId,
      in_reply_to: message.inReplyTo ?? null,
      to_email: lead.email,
      subject: message.subject,
      body_html: message.html ?? '',
      body_text: message.text,
      tracking_token: trackingToken,
      sent_at: sentAt,
    });
    db.update('scheduled_emails', slot.id, { status: 'sent' });

    const steps = loadSteps(ctx, campaign.id);
    // Next step's wait (or, for a last step with rules, when to check them).
    const due = dueAfterSend(steps, slot.step_order);
    db.update('campaign_leads', cl.id, {
      current_step: slot.step_order,
      next_step: null,
      seq_state: bumpVisits(cl, slot.step_order),
      last_sent_at: sentAt,
      status: due ? 'in_sequence' : 'completed',
      next_due_at: due ? followUpDue(campaign, sentAt, due.wait) : null,
    });

    const data = { scheduled_email_id: slot.id, sent_email_id: sentId, campaign_id: campaign.id, campaign_name: campaign.name, lead_id: lead.id, lead_email: lead.email, sender_email_id: sender.id, sender_email: sender.email, sequence_step_id: step.id, step_order: slot.step_order, subject: message.subject };
    const refs = { campaign_id: campaign.id, lead_id: lead.id, sender_email_id: sender.id, sent_email_id: sentId };
    emit(ctx, campaign.workspace_id, 'EMAIL_SENT', data, refs);
    if (slot.step_order === 1 && cl.current_step === 0) emit(ctx, campaign.workspace_id, 'LEAD_FIRST_CONTACTED', data, refs);
  });
  return 'sent';
}

/** "Wait N days" means N calendar days in the campaign's timezone, from the start of that day. */
export function followUpDue(campaign: Row, sentAt: string, waitDays: number): string {
  const tz = campaign.schedule_timezone;
  const day = DateTime.fromISO(sentAt).setZone(tz).startOf('day').plus({ days: waitDays });
  return day.toUTC().toISO()!;
}

export function isAuthError(err: any): boolean {
  const s = `${err?.code ?? ''} ${err?.responseCode ?? ''} ${err?.message ?? ''} ${err?.responseText ?? ''}`;
  // Outlook's IMAP answers a refused XOAUTH2 login with a bare "Login failed."
  return !!err?.authenticationFailed || /EAUTH|\b535\b|\b534\b|AUTHENTICATIONFAILED|Invalid credentials|authentication failed|invalid_grant|Username and Password not accepted|Login failed/i.test(s);
}

export function markDisconnected(ctx: Ctx, sender: Row, error: string) {
  if (sender.status === 'Disconnected') return;
  ctx.db.update('sender_emails', sender.id, { status: 'Disconnected', last_error: error.slice(0, 500), updated_at: ctx.now().toISOString() });
  emit(ctx, sender.workspace_id, 'EMAIL_ACCOUNT_DISCONNECTED', { sender_email_id: sender.id, email: sender.email, error }, { sender_email_id: sender.id });
}

/** Cancels booked slots, e.g. when a campaign is paused or a lead replies. */
export function cancelScheduled(ctx: Ctx, where: { campaignId?: number; leadId?: number; campaignLeadId?: number }, reason: string) {
  const clauses: string[] = [`status = 'scheduled'`];
  const params: (number | string)[] = [];
  if (where.campaignId) { clauses.push('campaign_id = ?'); params.push(where.campaignId); }
  if (where.leadId) { clauses.push('lead_id = ?'); params.push(where.leadId); }
  if (where.campaignLeadId) { clauses.push('campaign_lead_id = ?'); params.push(where.campaignLeadId); }
  ctx.db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = ? WHERE ${clauses.join(' AND ')}`, [reason, ...params]);
}
