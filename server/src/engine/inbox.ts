/**
 * Mailbox sync: pulls new messages over IMAP for every connected sender and routes them:
 * warmup traffic -> warmup engine, bounces -> lead bounced, replies -> master inbox + lead
 * status + webhooks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { categorize, parseInbound, type InboundMessage } from '../mail/classify.ts';
import { SPAM_FOLDER_NAMES } from '../mail/providers.ts';
import { cancelScheduled, isAuthError, markDisconnected } from './sequencer.ts';
import { afterReplyStored } from './replyAi.ts';
import { ensureThread } from './threads.ts';
import { handleWarmupMessage, isWarmupMessage } from './warmup.ts';
import { checkBounces } from './health.ts';

export type FolderKind = 'inbox' | 'spam';
const FIRST_SYNC_DAYS = 14;
const MAX_PER_FOLDER = 500;

export async function findFolders(client: ImapFlow): Promise<{ inbox: string; spam: string | null; all: { path: string; specialUse?: string }[] }> {
  const list = await client.list();
  const spam = list.find((f) => f.specialUse === '\\Junk')?.path
    ?? list.find((f) => SPAM_FOLDER_NAMES.some((n) => n.toLowerCase() === f.path.toLowerCase()))?.path
    ?? null;
  return { inbox: 'INBOX', spam, all: list.map((f) => ({ path: f.path, specialUse: f.specialUse })) };
}

/** Syncs one sender mailbox. Returns number of new messages processed. */
export async function syncSender(ctx: Ctx, sender: Row): Promise<number> {
  return (await syncSenderResult(ctx, sender)).processed;
}

export interface SyncResult { processed: number; error: string | null }

/** Syncs in flight, per context and mailbox id: a second caller joins the running pass instead of opening another IMAP session. */
const inFlight = new WeakMap<Ctx, Map<number, Promise<SyncResult>>>();

/** True while a sync pass for this mailbox is running (background job, "Sync now" or "Sync all"). */
export function isSyncing(ctx: Ctx, senderId: number): boolean {
  return !!inFlight.get(ctx)?.has(senderId);
}

/** Like syncSender, but also reports the error (if any). Concurrent calls for the same mailbox share one pass. */
export function syncSenderResult(ctx: Ctx, sender: Row): Promise<SyncResult> {
  let map = inFlight.get(ctx);
  if (!map) inFlight.set(ctx, (map = new Map()));
  const running = map.get(sender.id);
  if (running) return running;
  const p = runSync(ctx, sender).finally(() => map.delete(sender.id));
  map.set(sender.id, p);
  return p;
}

async function runSync(ctx: Ctx, sender: Row): Promise<SyncResult> {
  let processed = 0;
  let error: string | null = null;
  try {
    processed = await ctx.mail.withImap(sender, async (client) => {
      const { inbox, spam } = await findFolders(client);
      let n = 0;
      for (const [folder, kind] of [[inbox, 'inbox'], [spam, 'spam']] as [string | null, FolderKind][]) {
        if (folder) n += await syncFolder(ctx, sender, client, folder, kind);
      }
      return n;
    });
    const update: Row = { last_synced_at: ctx.now().toISOString(), last_error: null };
    if (sender.status === 'Disconnected') {
      update.status = 'Connected';
      emit(ctx, sender.workspace_id, 'EMAIL_ACCOUNT_RECONNECTED', { sender_email_id: sender.id, email: sender.email }, { sender_email_id: sender.id });
    }
    ctx.db.update('sender_emails', sender.id, update);
  } catch (err: any) {
    const msg = String(err?.responseText ?? err?.message ?? err);
    error = msg;
    ctx.log.warn({ sender: sender.email, err: msg }, 'imap sync failed');
    if (isAuthError(err)) markDisconnected(ctx, sender, msg);
    else ctx.db.update('sender_emails', sender.id, { last_error: msg.slice(0, 500) });
  }
  return { processed, error };
}

async function syncFolder(ctx: Ctx, sender: Row, client: ImapFlow, folder: string, kind: FolderKind): Promise<number> {
  const { db } = ctx;
  const lock = await client.getMailboxLock(folder);
  let processed = 0;
  try {
    const mb = client.mailbox as any;
    const validity = String(mb.uidValidity);
    const cursor = db.get('SELECT * FROM imap_cursors WHERE sender_email_id = ? AND folder = ?', [sender.id, folder]);

    let uids: number[];
    if (!cursor || cursor.uid_validity !== validity) {
      // First sync (or the server reset UIDs): look back a couple of weeks only.
      const since = new Date(ctx.now().getTime() - FIRST_SYNC_DAYS * 86_400_000);
      uids = ((await client.search({ since }, { uid: true })) || []) as number[];
      db.run(`INSERT INTO imap_cursors (sender_email_id, folder, uid_validity, last_uid) VALUES (?, ?, ?, 0)
              ON CONFLICT(sender_email_id, folder) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = 0`, [sender.id, folder, validity]);
    } else {
      const next = cursor.last_uid + 1;
      if (mb.uidNext && next >= mb.uidNext) return 0;
      uids = ((await client.search({ uid: `${next}:*` }, { uid: true })) || []) as number[];
      uids = uids.filter((u) => u > cursor.last_uid);
    }
    uids.sort((a, b) => a - b);
    uids = uids.slice(0, MAX_PER_FOLDER);
    if (!uids.length) return 0;

    // Download first: moving messages inside the fetch loop would deadlock the connection.
    const messages: { uid: number; parsed: InboundMessage }[] = [];
    for await (const m of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
      if (!m.source) continue;
      messages.push({ uid: m.uid, parsed: await parseInbound(m.source) });
    }

    let lastUid = cursor?.uid_validity === validity ? cursor.last_uid : 0;
    for (const { uid, parsed } of messages) {
      try {
        await processInbound(ctx, sender, parsed, { client, folder, kind, uid });
      } catch (err) {
        ctx.log.error({ err, uid, sender: sender.email }, 'failed to process message');
      }
      lastUid = Math.max(lastUid, uid);
      processed++;
    }
    db.run('UPDATE imap_cursors SET last_uid = ? WHERE sender_email_id = ? AND folder = ?', [lastUid, sender.id, folder]);
  } finally {
    lock.release();
  }
  return processed;
}

export interface Location {
  client: ImapFlow | null;
  folder: string;
  kind: FolderKind;
  uid: number;
}

/** Routes one inbound message. Exported for tests (client may be null). */
export async function processInbound(ctx: Ctx, sender: Row, msg: InboundMessage, loc: Location): Promise<'warmup' | 'own' | 'bounce' | 'reply' | 'untracked' | 'skipped' | 'duplicate'> {
  const { db } = ctx;

  if (isWarmupMessage(ctx, msg)) {
    await handleWarmupMessage(ctx, sender, msg, loc);
    return 'warmup';
  }
  if (msg.fromEmail === String(sender.email).toLowerCase()) return 'own';
  if (db.get('SELECT 1 FROM replies WHERE sender_email_id = ? AND message_id = ?', [sender.id, msg.messageId])) return 'duplicate';

  const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [sender.workspace_id])!;

  if (msg.bounce) {
    handleBounce(ctx, sender, msg);
    if (msg.bounce.permanent) checkBounces(ctx, sender.id);
    return 'bounce';
  }

  const original = findOriginal(ctx, sender, msg);
  if (!original && !ws.sync_all_emails) return 'skipped';

  const ignore = db.all<{ phrase: string }>('SELECT phrase FROM ignore_phrases WHERE workspace_id = ?', [sender.workspace_id]).map((r) => r.phrase);
  const cls = categorize(msg, ignore);
  const interested = ws.auto_interested_categorization ? cls.interested : false;
  const leadId: number | null = original?.lead_id ?? db.get('SELECT id FROM leads WHERE workspace_id = ? AND email = ?', [sender.workspace_id, msg.fromEmail])?.id ?? null;

  const replyId = db.tx(() => {
    const threadId = ensureThread(ctx, {
      workspaceId: sender.workspace_id, senderId: sender.id, leadId, campaignId: original?.campaign_id ?? null,
      subject: msg.subject, previousThreadId: original?.thread_id ?? null,
    });
    const id = db.insert('replies', {
      workspace_id: sender.workspace_id,
      sender_email_id: sender.id,
      campaign_id: original?.campaign_id ?? null,
      lead_id: leadId,
      sent_email_id: original?.id ?? null,
      thread_id: threadId,
      folder: loc.kind,
      message_id: msg.messageId,
      in_reply_to: msg.inReplyTo,
      from_name: msg.fromName,
      from_email: msg.fromEmail,
      to_email: msg.to,
      cc: msg.cc,
      subject: msg.subject,
      body_text: msg.text,
      body_html: msg.html,
      attachments: JSON.stringify(saveAttachments(ctx, msg)),
      interested: interested ? 1 : 0,
      automated: cls.automated ? 1 : 0,
      category: cls.category === 'interested' && !interested ? 'reply' : cls.category,
      received_at: msg.date.toISOString(),
    });
    return id;
  });
  afterReplyStored(ctx, replyId);

  const lead = leadId ? db.get('SELECT * FROM leads WHERE id = ?', [leadId]) : null;
  const data = {
    reply_id: replyId, from_email: msg.fromEmail, from_name: msg.fromName, subject: msg.subject,
    text_body: msg.text.slice(0, 5000), category: cls.category, interested, automated: cls.automated,
    sender_email_id: sender.id, sender_email: sender.email, campaign_id: original?.campaign_id ?? null,
    lead_id: leadId, lead_email: lead?.email ?? null, received_at: msg.date.toISOString(),
  };
  const refs = { campaign_id: original?.campaign_id ?? null, lead_id: leadId, sender_email_id: sender.id, reply_id: replyId };

  if (!original) {
    if (!cls.automated) emit(ctx, sender.workspace_id, 'UNTRACKED_REPLY_RECEIVED', data, refs);
    return 'untracked';
  }

  if (!cls.automated && lead) {
    db.tx(() => {
      const cl = original.campaign_lead_id ? db.get('SELECT * FROM campaign_leads WHERE id = ?', [original.campaign_lead_id]) : null;
      const campaign = original.campaign_id ? db.get('SELECT * FROM campaigns WHERE id = ?', [original.campaign_id]) : null;
      if (cl && campaign && ['pending', 'in_sequence', 'completed', 'replied'].includes(cl.status)) {
        const status = interested ? 'interested' : 'replied';
        if (campaign.stop_on_reply || interested) {
          db.update('campaign_leads', cl.id, { status, next_due_at: null });
          cancelScheduled(ctx, { campaignLeadId: cl.id }, 'lead replied');
        } else if (interested) {
          db.update('campaign_leads', cl.id, { status });
        }
      }
      if (cls.category === 'unsubscribe') unsubscribeLead(ctx, lead, 'reply');
    });
    emit(ctx, sender.workspace_id, 'LEAD_REPLIED', data, refs);
    if (interested) emit(ctx, sender.workspace_id, 'LEAD_INTERESTED', data, refs);
  }
  return 'reply';
}

/** Finds the message we sent that this one answers. */
function findOriginal(ctx: Ctx, sender: Row, msg: InboundMessage): Row | null {
  const ids = [msg.inReplyTo, ...msg.references.slice().reverse()].filter(Boolean) as string[];
  for (const id of ids) {
    const s = ctx.db.get('SELECT * FROM sent_emails WHERE message_id = ? AND workspace_id = ?', [id, sender.workspace_id]);
    if (s) return s;
    // A reply to a reply we received earlier belongs to the same conversation.
    const r = ctx.db.get('SELECT * FROM replies WHERE message_id = ? AND workspace_id = ?', [id, sender.workspace_id]);
    if (r?.sent_email_id) return ctx.db.get('SELECT * FROM sent_emails WHERE id = ?', [r.sent_email_id]) ?? null;
  }
  // Fallback: the lead wrote back without threading headers.
  return ctx.db.get(
    `SELECT * FROM sent_emails WHERE sender_email_id = ? AND lower(to_email) = ? AND kind = 'campaign' ORDER BY id DESC LIMIT 1`,
    [sender.id, msg.fromEmail]) ?? null;
}

function handleBounce(ctx: Ctx, sender: Row, msg: InboundMessage) {
  const { db } = ctx;
  const b = msg.bounce!;
  const original = (b.originalMessageId && db.get('SELECT * FROM sent_emails WHERE message_id = ?', [b.originalMessageId]))
    || (b.recipient && db.get('SELECT * FROM sent_emails WHERE sender_email_id = ? AND lower(to_email) = ? ORDER BY id DESC LIMIT 1', [sender.id, b.recipient]))
    || null;

  db.tx(() => {
    const threadId = ensureThread(ctx, { workspaceId: sender.workspace_id, senderId: sender.id, leadId: original?.lead_id ?? null, campaignId: original?.campaign_id ?? null, subject: msg.subject, previousThreadId: original?.thread_id ?? null });
    const replyId = db.insert('replies', {
      workspace_id: sender.workspace_id, sender_email_id: sender.id, campaign_id: original?.campaign_id ?? null,
      lead_id: original?.lead_id ?? null, sent_email_id: original?.id ?? null, thread_id: threadId, folder: 'bounced',
      message_id: msg.messageId, in_reply_to: msg.inReplyTo, from_name: msg.fromName, from_email: msg.fromEmail,
      to_email: msg.to, subject: msg.subject, body_text: msg.text, body_html: msg.html, automated: 1, category: 'bounce',
      received_at: msg.date.toISOString(),
    });
    if (!original || !b.permanent) return;
    db.update('sent_emails', original.id, { bounced: 1 });
    if (original.lead_id) {
      db.run(`UPDATE leads SET status = 'bounced', updated_at = ? WHERE id = ?`, [ctx.now().toISOString(), original.lead_id]);
      db.run(`UPDATE campaign_leads SET status = 'bounced', next_due_at = NULL WHERE lead_id = ? AND status IN ('pending','in_sequence')`, [original.lead_id]);
      cancelScheduled(ctx, { leadId: original.lead_id }, 'bounced');
    }
    emit(ctx, sender.workspace_id, 'EMAIL_BOUNCED', {
      sent_email_id: original.id, lead_id: original.lead_id, lead_email: original.to_email, campaign_id: original.campaign_id,
      sender_email_id: sender.id, sender_email: sender.email, diagnostic: b.diagnostic, reply_id: replyId,
    }, { campaign_id: original.campaign_id, lead_id: original.lead_id, sender_email_id: sender.id, sent_email_id: original.id, reply_id: replyId });
  });
}

/** Marks a lead unsubscribed everywhere in its workspace and stops all future sends. */
export function unsubscribeLead(ctx: Ctx, lead: Row, source: string) {
  const { db } = ctx;
  // Permanent suppression: the address stays blocked even if the lead is deleted or re-imported.
  suppress(ctx, lead.workspace_id, lead.email, 'unsubscribed', source);
  if (lead.status === 'unsubscribed') return;
  db.tx(() => {
    db.run(`UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ?`, [ctx.now().toISOString(), lead.id]);
    db.run(`UPDATE campaign_leads SET status = 'unsubscribed', next_due_at = NULL WHERE lead_id = ? AND status IN ('pending','in_sequence','completed','replied')`, [lead.id]);
    cancelScheduled(ctx, { leadId: lead.id }, 'unsubscribed');
    emit(ctx, lead.workspace_id, 'LEAD_UNSUBSCRIBED', { lead_id: lead.id, lead_email: lead.email, source }, { lead_id: lead.id });
  });
}

function saveAttachments(ctx: Ctx, msg: InboundMessage) {
  return storeAttachments(ctx, msg.messageId, msg.attachments.slice(0, 20));
}

/** Writes message attachments under data/attachments/<message id>/ and returns what to keep in the row's attachments JSON. */
export function storeAttachments(ctx: Ctx, messageId: string, list: { filename: string; content: Buffer; contentType?: string; inline?: boolean }[]) {
  if (!list.length) return [];
  const dir = join(ctx.config.dataDir, 'attachments', messageId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120));
  mkdirSync(dir, { recursive: true });
  return list.map((a, i) => {
    const safe = `${i}-${a.filename.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 100)}`;
    writeFileSync(join(dir, safe), a.content);
    return { filename: a.filename, size: a.content.length, content_type: a.contentType || 'application/octet-stream', path: join(dir, safe), ...(a.inline ? { inline: true } : {}) };
  });
}

/** Add an address to the workspace's permanent do-not-email list (keeps the first reason). */
export function suppress(ctx: Ctx, workspaceId: number, email: string, reason: string, source: string) {
  ctx.db.run(`INSERT INTO blacklisted_emails (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, email) DO UPDATE SET reason = CASE WHEN blacklisted_emails.reason = 'manual' AND excluded.reason != 'manual' THEN excluded.reason ELSE blacklisted_emails.reason END,
      source = CASE WHEN blacklisted_emails.source = '' THEN excluded.source ELSE blacklisted_emails.source END`,
  [workspaceId, String(email).trim().toLowerCase(), reason, source, ctx.now().toISOString()]);
}
