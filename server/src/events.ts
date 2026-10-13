import type { Ctx } from './context.ts';

/** Webhook event catalogue. Names mirror the EmailBison webhook types. */
export const EVENT_TYPES = {
  EMAIL_SENT: 'Email Sent',
  LEAD_FIRST_CONTACTED: 'Lead First Contacted',
  LEAD_REPLIED: 'Lead Replied',
  LEAD_INTERESTED: 'Lead Interested',
  LEAD_UNSUBSCRIBED: 'Lead Unsubscribed',
  EMAIL_OPENED: 'Email Opened',
  LINK_CLICKED: 'Link Clicked',
  EMAIL_BOUNCED: 'Email Bounced',
  UNTRACKED_REPLY_RECEIVED: 'Untracked Reply Received',
  MANUAL_EMAIL_SENT: 'Manual Email Sent',
  EMAIL_ACCOUNT_ADDED: 'Email Account Added',
  EMAIL_ACCOUNT_DISCONNECTED: 'Email Account Disconnected',
  EMAIL_ACCOUNT_RECONNECTED: 'Email Account Reconnected',
  TAG_ATTACHED: 'Tag Attached',
  TAG_REMOVED: 'Tag Removed',
  CAMPAIGN_COMPLETED: 'Campaign Completed',
  SIGNAL_CHANGED: 'Signal Changed',
  WEBSITE_VISIT: 'Website Visit',
  HIGH_INTENT_VISIT: 'High Intent Visit',
  AB_TEST_WINNER: 'A/B Test Winner Picked',
  LEAD_MEETING_REQUEST: 'Lead Meeting Request',
  LEAD_OUT_OF_OFFICE: 'Lead Out Of Office',
  LINKEDIN_CONNECTION_ACCEPTED: 'LinkedIn Connection Accepted',
  LINKEDIN_REPLY_RECEIVED: 'LinkedIn Reply Received',
  LINKEDIN_POST_ENGAGER: 'LinkedIn Post Engager',
  COMPANION_JOB_COMPLETED: 'Companion Job Completed',
  DEAL_STAGE_CHANGED: 'Deal Stage Changed',
} as const;

export type EventType = keyof typeof EVENT_TYPES;

type Listener = (ctx: Ctx, workspaceId: number, type: EventType, data: Record<string, unknown>, refs: EventRefs) => void;
const listeners = new Set<Listener>();

/** In-process subscribers to every emitted event (GTM tables use this to refresh outreach status). */
export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface EventRefs {
  campaign_id?: number | null;
  lead_id?: number | null;
  sender_email_id?: number | null;
  sent_email_id?: number | null;
  reply_id?: number | null;
}

/**
 * Records an event and queues a delivery for every webhook subscribed to it.
 * Delivery happens in the webhook engine so callers never wait on HTTP.
 */
export function emit(ctx: Ctx, workspaceId: number, type: EventType, data: Record<string, unknown>, refs: EventRefs = {}, opts: { skipWebhooks?: boolean } = {}) {
  const { db } = ctx;
  const now = ctx.now().toISOString();
  db.insert('events', {
    workspace_id: workspaceId,
    type,
    campaign_id: refs.campaign_id ?? null,
    lead_id: refs.lead_id ?? null,
    sender_email_id: refs.sender_email_id ?? null,
    sent_email_id: refs.sent_email_id ?? null,
    reply_id: refs.reply_id ?? null,
    data: JSON.stringify(data),
    created_at: now,
  });
  for (const fn of listeners) {
    try { fn(ctx, workspaceId, type, data, refs); } catch (e) { ctx.log?.warn?.({ err: e }, 'event listener failed'); }
  }
  if (opts.skipWebhooks) return;

  const hooks = db.all<{ id: number; events: string }>('SELECT id, events FROM webhooks WHERE workspace_id = ?', [workspaceId]);
  if (!hooks.length) return;
  const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
  const payload = JSON.stringify(webhookPayload(ctx, workspaceId, ws?.name ?? '', type, data));
  for (const hook of hooks) {
    const events: string[] = JSON.parse(hook.events);
    if (!events.includes(type)) continue;
    db.insert('webhook_deliveries', { webhook_id: hook.id, event_type: type, payload, status: 'pending', attempts: 0, next_attempt_at: now, created_at: now });
  }
}

export function webhookPayload(ctx: Ctx, workspaceId: number, workspaceName: string, type: EventType, data: Record<string, unknown>) {
  return {
    event: { type, name: EVENT_TYPES[type], instance_url: ctx.config.publicUrl, workspace_id: workspaceId, workspace_name: workspaceName },
    data,
  };
}
