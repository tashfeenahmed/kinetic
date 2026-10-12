import type { Ctx } from '../context.ts';

/** Returns the conversation thread for a message, creating one when needed. */
export function ensureThread(ctx: Ctx, o: { workspaceId: number; senderId: number | null; leadId: number | null; campaignId: number | null; subject: string; previousThreadId?: number | null }): number {
  const now = ctx.now().toISOString();
  if (o.previousThreadId) {
    ctx.db.run('UPDATE threads SET last_message_at = ? WHERE id = ?', [now, o.previousThreadId]);
    return o.previousThreadId;
  }
  return ctx.db.insert('threads', {
    workspace_id: o.workspaceId,
    sender_email_id: o.senderId,
    lead_id: o.leadId,
    campaign_id: o.campaignId,
    subject: o.subject.replace(/^(re|fwd?):\s*/i, ''),
    last_message_at: now,
  });
}
