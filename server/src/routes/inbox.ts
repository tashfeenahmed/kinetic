import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, bool, canWrite, defineRoutes, HttpError, idParam, notFound, pageQuery, paginate, parse } from '../http.ts';
import { emit } from '../events.ts';
import { newMessageId, referenceChain } from '../engine/compose.ts';
import { ensureThread } from '../engine/threads.ts';
import { isSyncing, storeAttachments, unsubscribeLead } from '../engine/inbox.ts';
import { lastSyncedAt, syncWorkspace } from '../engine/syncAll.ts';
import { cancelScheduled } from '../engine/sequencer.ts';
import { escapeHtml, htmlToText, looksLikeHtml, stripQuoted, textToHtml } from '../lib/html.ts';
import { attachLeads } from './leads.ts';
import { markdownToHtml } from '../lib/markdown.ts';

const attachmentInput = z.object({ filename: z.string().min(1), content_base64: z.string(), content_type: z.string().optional() });
const sendFields = {
  message: z.string().min(1),
  sender_email_id: z.coerce.number().int().optional(),
  content_type: z.enum(['html', 'text']).default('text'),
  to_emails: z.array(z.email()).optional(),
  cc_emails: z.array(z.email()).default([]),
  bcc_emails: z.array(z.email()).default([]),
  attachments: z.array(attachmentInput).max(10).default([]),
};

function decodeAttachments(list: z.infer<typeof attachmentInput>[]) {
  const out = list.map((a) => ({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type }));
  const total = out.reduce((n, a) => n + a.content.length, 0);
  if (total > 15 * 1024 * 1024) throw new HttpError(422, { error: 'validation_error', message: 'Attachments are limited to 15 MB in total.' });
  return out;
}

/** Attachments JSON from a row -> what the API returns (no file paths). */
function attachmentLinks(json: string, base: string) {
  return (JSON.parse(json || '[]') as Row[]).map((a, i) => ({ filename: a.filename, size: a.size, content_type: a.content_type, inline: !!a.inline, url: `${base}/${i}` }));
}

// Types a browser shows safely in a tab: viewed with ?inline=1, everything else always downloads.
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf', 'text/plain']);

function sendAttachment(req: any, reply: any, json: string) {
  const att = JSON.parse(json || '[]')[Number(req.params.index)];
  if (!att || !existsSync(att.path)) throw notFound('attachment');
  const type = String(att.content_type || 'application/octet-stream').toLowerCase().split(';')[0]!.trim();
  const view = req.query?.inline === '1' && VIEWABLE.has(type);
  const name = String(att.filename || 'attachment').replace(/[\r\n"\\]/g, '');
  reply.header('content-type', view && type === 'text/plain' ? 'text/plain; charset=utf-8' : view ? type : 'application/octet-stream');
  reply.header('content-disposition', `${view ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('x-content-type-options', 'nosniff');
  if (type !== 'application/pdf') reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  reply.header('cache-control', 'private, max-age=3600');
  return reply.send(createReadStream(att.path));
}

export function inboxRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Replies');
  const { db } = ctx;

  const getReply = (ws: number, id: number) => {
    const row = db.get('SELECT * FROM replies WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!row) throw notFound('reply');
    return row;
  };

  const sentJson = (row: Row): Row => ({ ...row, attachments: attachmentLinks(row.attachments, `/api/sent-emails/${row.id}/attachments`) });

  const replyJson = (row: Row): Row => ({
    ...row,
    interested: !!row.interested,
    automated: !!row.automated,
    read: !!row.read,
    label: row.label ?? row.category,
    ai_details: row.ai_details ? JSON.parse(row.ai_details) : null,
    attachments: attachmentLinks(row.attachments, `/api/replies/${row.id}/attachments`),
  });

  const listQ = pageQuery.extend({
    folder: z.enum(['inbox', 'spam', 'bounced', 'all']).default('inbox'),
    status: z.enum(['interested', 'not_interested', 'automated', 'not_automated', 'unread', 'unsubscribe']).optional(),
    sender_email_id: z.coerce.number().int().optional(),
    campaign_id: z.coerce.number().int().optional(),
    lead_id: z.coerce.number().int().optional(),
    search: z.string().optional(),
    label: z.string().optional().describe('Comma-separated reply labels, e.g. meeting_request,more_info'),
  });
  r.get('/api/replies', 'Get all replies (master inbox)', (req) => {
    const a = auth(req);
    const q = parse(listQ, req.query);
    const where = ['r.workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.folder !== 'all') { where.push('r.folder = ?'); params.push(q.folder); }
    if (q.status === 'interested') where.push('r.interested = 1');
    if (q.status === 'not_interested') where.push(`r.category = 'not_interested'`);
    if (q.status === 'automated') where.push('r.automated = 1');
    if (q.status === 'not_automated') where.push('r.automated = 0');
    if (q.status === 'unread') where.push('r.read = 0');
    if (q.status === 'unsubscribe') where.push(`r.category = 'unsubscribe'`);
    if (q.sender_email_id) { where.push('r.sender_email_id = ?'); params.push(q.sender_email_id); }
    if (q.campaign_id) { where.push('r.campaign_id = ?'); params.push(q.campaign_id); }
    if (q.lead_id) { where.push('r.lead_id = ?'); params.push(q.lead_id); }
    const labels = q.label?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
    if (labels.length) { where.push(`COALESCE(r.label, r.category) IN (${labels.map(() => '?').join(',')})`); params.push(...labels); }
    if (q.search) { where.push('(r.from_email LIKE ? OR r.from_name LIKE ? OR r.subject LIKE ? OR r.body_text LIKE ?)'); params.push(...Array(4).fill(`%${q.search}%`)); }
    // One row per conversation: the newest matching message.
    const sql = `SELECT r.*, s.email AS sender_email, c.name AS campaign_name,
        (SELECT COUNT(*) FROM replies r2 WHERE r2.thread_id = r.thread_id) AS thread_count
      FROM replies r LEFT JOIN sender_emails s ON s.id = r.sender_email_id LEFT JOIN campaigns c ON c.id = r.campaign_id
      WHERE ${where.join(' AND ')} AND r.id = (SELECT MAX(r3.id) FROM replies r3 WHERE r3.thread_id IS r.thread_id AND r3.folder = r.folder)
      ORDER BY r.received_at DESC`;
    const result = paginate(ctx, sql, params, q, (row) => ({ ...replyJson(row), preview: stripQuoted(row.body_text || htmlToText(row.body_html)).replace(/\s+/g, ' ').slice(0, 160) }));
    const counts = db.get(`SELECT COALESCE(SUM(CASE WHEN folder = 'inbox' AND read = 0 THEN 1 ELSE 0 END), 0) AS unread_inbox,
        COALESCE(SUM(CASE WHEN folder = 'inbox' AND interested = 1 AND read = 0 THEN 1 ELSE 0 END), 0) AS unread_interested
      FROM replies WHERE workspace_id = ?`, [a.workspaceId]);
    return { ...result, counts };
  }, { query: listQ });

  r.post('/api/replies/sync', 'Sync all connected mailboxes now (fetch new email)', async (req) => {
    const a = auth(req);
    return { data: await syncWorkspace(ctx, a.workspaceId) };
  });

  r.get('/api/replies/sync-status', 'When the inbox mailboxes were last synced', (req) => {
    const a = auth(req);
    const ids = db.all(`SELECT id FROM sender_emails WHERE workspace_id = ? AND status = 'Connected'`, [a.workspaceId]).map((x) => x.id as number);
    return { data: { last_synced_at: lastSyncedAt(ctx, a.workspaceId), mailboxes: ids.length, syncing: ids.some((id) => isSyncing(ctx, id)) } };
  });

  r.get('/api/replies/:id', 'Get reply', (req) => {
    const row = getReply(auth(req).workspaceId, idParam(req));
    return { data: replyJson(row) };
  });

  r.get('/api/replies/:id/conversation-thread', 'Get the full conversation', (req) => {
    const a = auth(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const sent = db.all(`SELECT s.*, 'sent' AS direction, se.name AS from_name, se.email AS from_email FROM sent_emails s LEFT JOIN sender_emails se ON se.id = s.sender_email_id WHERE s.thread_id = ?`, [reply.thread_id]);
    const received = db.all(`SELECT r.*, 'received' AS direction FROM replies r WHERE r.thread_id = ?`, [reply.thread_id]).map(replyJson);
    const messages = [...sent.map((s) => ({ ...s, attachments: attachmentLinks(s.attachments, `/api/sent-emails/${s.id}/attachments`), at: s.sent_at })), ...received.map((m) => ({ ...m, at: m.received_at }))]
      .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
    const lead = reply.lead_id ? db.get('SELECT id, email, first_name, last_name, company, title, status FROM leads WHERE id = ?', [reply.lead_id]) : null;
    const campaign = reply.campaign_id ? db.get('SELECT id, name, status FROM campaigns WHERE id = ?', [reply.campaign_id]) : null;
    const sender = reply.sender_email_id ? db.get('SELECT id, name, email FROM sender_emails WHERE id = ?', [reply.sender_email_id]) : null;
    if (!reply.read) db.run('UPDATE replies SET read = 1 WHERE thread_id = ?', [reply.thread_id]);
    return { data: { reply: replyJson(reply), messages, lead, campaign, sender_email: sender } };
  });

  r.get('/api/replies/:id/attachments/:index', 'Download an attachment (?inline=1 opens images, PDFs and text in the browser)', (req, reply) => {
    const row = getReply(auth(req).workspaceId, idParam(req));
    return sendAttachment(req, reply, row.attachments);
  });

  /** Sends a message from a mailbox, records it, and returns the sent row id. */
  async function sendFromInbox(o: { workspaceId: number; sender: Row; to: string[]; cc: string[]; bcc: string[]; subject: string; bodyHtml: string; bodyText: string; inReplyTo?: string | null; references?: string[]; threadId?: number | null; leadId?: number | null; campaignId?: number | null; kind: 'manual' | 'reply'; attachments: { filename: string; content: Buffer; contentType?: string }[] }) {
    const messageId = newMessageId(o.sender.email);
    try {
      await ctx.mail.send(o.sender, {
        from: { name: o.sender.name, email: o.sender.email },
        to: o.to.join(', '), cc: o.cc.join(', '), bcc: o.bcc.join(', '),
        subject: o.subject, text: o.bodyText, html: o.bodyHtml, messageId, inReplyTo: o.inReplyTo ?? null, references: o.references,
        attachments: o.attachments,
      });
    } catch (e: any) {
      throw new HttpError(422, { error: 'send_failed', message: e.message });
    }
    return db.tx(() => {
      const threadId = ensureThread(ctx, { workspaceId: o.workspaceId, senderId: o.sender.id, leadId: o.leadId ?? null, campaignId: o.campaignId ?? null, subject: o.subject, previousThreadId: o.threadId ?? null });
      const id = db.insert('sent_emails', {
        workspace_id: o.workspaceId, kind: o.kind, campaign_id: o.campaignId ?? null, lead_id: o.leadId ?? null, sender_email_id: o.sender.id,
        thread_id: threadId, message_id: messageId, in_reply_to: o.inReplyTo ?? null, to_email: o.to.join(', '), cc: o.cc.join(', '), bcc: o.bcc.join(', '),
        subject: o.subject, body_html: o.bodyHtml, body_text: o.bodyText, sent_at: ctx.now().toISOString(),
        attachments: JSON.stringify(storeAttachments(ctx, messageId, o.attachments)),
      });
      emit(ctx, o.workspaceId, 'MANUAL_EMAIL_SENT', { sent_email_id: id, sender_email_id: o.sender.id, to: o.to, subject: o.subject, lead_id: o.leadId ?? null }, { sender_email_id: o.sender.id, lead_id: o.leadId ?? null, sent_email_id: id });
      return id;
    });
  }

  const bodyOf = (message: string, contentType: string, signature: string) => {
    const html = contentType === 'html' || looksLikeHtml(message) ? message : markdownToHtml(message);
    const withSig = signature ? `${html}\n${markdownToHtml(signature)}` : html;
    return { html: withSig, text: htmlToText(withSig) };
  };

  const replyBody = z.object({ ...sendFields, reply_all: bool.default(false), inject_previous_email_body: bool.default(true), reply_template_id: z.coerce.number().int().optional() });
  r.post('/api/replies/:id/reply', 'Reply to a message', async (req) => {
    const a = canWrite(req);
    const original = getReply(a.workspaceId, idParam(req));
    const b = parse(replyBody, req.body);
    const sender = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [b.sender_email_id ?? original.sender_email_id, a.workspaceId]);
    if (!sender) throw notFound('email account');
    let message = b.message;
    if (b.reply_template_id) {
      const t = db.get('SELECT body FROM reply_templates WHERE id = ? AND workspace_id = ?', [b.reply_template_id, a.workspaceId]);
      if (t) message = t.body;
    }
    const to = b.to_emails?.length ? b.to_emails : [original.from_email];
    const cc = [...b.cc_emails];
    if (b.reply_all) {
      for (const addr of `${original.to_email}, ${original.cc}`.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)) {
        if (addr !== sender.email.toLowerCase() && !to.includes(addr) && !cc.includes(addr)) cc.push(addr);
      }
    }
    const { html, text } = bodyOf(message, b.content_type, sender.email_signature ?? '');
    let bodyHtml = html;
    let bodyText = text;
    if (b.inject_previous_email_body) {
      const when = new Date(original.received_at).toUTCString().replace(/:\d\d GMT$/, ' GMT');
      const prev = original.body_text || htmlToText(original.body_html);
      bodyText += `\n\nOn ${when}, ${original.from_name || original.from_email} <${original.from_email}> wrote:\n${prev.split('\n').map((l: string) => `> ${l}`).join('\n')}`;
      bodyHtml += `<br><div class="gmail_quote"><div>On ${escapeHtml(when)}, ${escapeHtml(original.from_name || original.from_email)} &lt;${escapeHtml(original.from_email)}&gt; wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${original.body_html || textToHtml(prev)}</blockquote></div>`;
    }
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const id = await sendFromInbox({
      workspaceId: a.workspaceId, sender, to, cc, bcc: b.bcc_emails, subject, bodyHtml, bodyText,
      inReplyTo: original.message_id, references: referenceChain(ctx, original), threadId: original.thread_id,
      leadId: original.lead_id, campaignId: original.campaign_id, kind: 'reply', attachments: decodeAttachments(b.attachments),
    });
    db.run('UPDATE replies SET read = 1 WHERE thread_id = ?', [original.thread_id]);
    return { data: sentJson(db.get('SELECT * FROM sent_emails WHERE id = ?', [id])!) };
  }, { body: replyBody });

  const forwardBody = z.object({ ...sendFields, to_emails: z.array(z.email()).min(1) });
  r.post('/api/replies/:id/forward', 'Forward a message', async (req) => {
    const a = canWrite(req);
    const original = getReply(a.workspaceId, idParam(req));
    const b = parse(forwardBody, req.body);
    const sender = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [b.sender_email_id ?? original.sender_email_id, a.workspaceId]);
    if (!sender) throw notFound('email account');
    const { html, text } = bodyOf(b.message, b.content_type, sender.email_signature ?? '');
    const header = `---------- Forwarded message ---------\nFrom: ${original.from_name} <${original.from_email}>\nDate: ${new Date(original.received_at).toUTCString()}\nSubject: ${original.subject}\nTo: ${original.to_email}`;
    const prev = original.body_text || htmlToText(original.body_html);
    // The original's files go along, as in a normal mail client (inline images are already in its HTML).
    const originalFiles = (JSON.parse(original.attachments || '[]') as Row[]).filter((f) => !f.inline && existsSync(f.path))
      .map((f) => ({ filename: f.filename as string, content: readFileSync(f.path), contentType: f.content_type as string }));
    const files = [...originalFiles, ...decodeAttachments(b.attachments)];
    if (files.reduce((n, f) => n + f.content.length, 0) > 25 * 1024 * 1024) throw new HttpError(422, { error: 'validation_error', message: 'The attachments are over 25 MB together, too big to forward.' });
    const id = await sendFromInbox({
      workspaceId: a.workspaceId, sender, to: b.to_emails, cc: b.cc_emails, bcc: b.bcc_emails,
      subject: /^fwd?:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
      bodyHtml: `${html}<br><br>${textToHtml(header)}<br>${original.body_html || textToHtml(prev)}`,
      bodyText: `${text}\n\n${header}\n\n${prev}`,
      threadId: null, leadId: original.lead_id, campaignId: original.campaign_id, kind: 'manual', attachments: files,
    });
    return { data: sentJson(db.get('SELECT * FROM sent_emails WHERE id = ?', [id])!) };
  }, { body: forwardBody });

  const composeBody = z.object({ ...sendFields, subject: z.string().min(1), sender_email_id: z.coerce.number().int(), to_emails: z.array(z.email()).min(1) });
  r.post('/api/replies/new', 'Compose a new email', async (req) => {
    const a = canWrite(req);
    const b = parse(composeBody, req.body);
    const sender = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [b.sender_email_id, a.workspaceId]);
    if (!sender) throw notFound('email account');
    const { html, text } = bodyOf(b.message, b.content_type, sender.email_signature ?? '');
    const lead = db.get('SELECT id FROM leads WHERE workspace_id = ? AND email = ?', [a.workspaceId, b.to_emails[0]!.toLowerCase()]);
    const id = await sendFromInbox({
      workspaceId: a.workspaceId, sender, to: b.to_emails, cc: b.cc_emails, bcc: b.bcc_emails, subject: b.subject,
      bodyHtml: html, bodyText: text, leadId: lead?.id ?? null, kind: 'manual', attachments: decodeAttachments(b.attachments),
    });
    return { data: sentJson(db.get('SELECT * FROM sent_emails WHERE id = ?', [id])!) };
  }, { body: composeBody });

  // ---- labels ----
  const skipBody = z.object({ skip_webhooks: bool.default(false) });
  const setInterest = (interested: boolean) => (req: any) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const b = parse(skipBody, req.body);
    db.tx(() => {
      db.update('replies', reply.id, { interested: interested ? 1 : 0, category: interested ? 'interested' : 'not_interested', label: interested ? 'interested' : 'not_interested', label_source: 'manual' });
      if (reply.lead_id && reply.campaign_id) {
        db.run(`UPDATE campaign_leads SET status = ? WHERE lead_id = ? AND campaign_id = ? AND status IN ('pending','in_sequence','replied','interested','completed')`,
          [interested ? 'interested' : 'replied', reply.lead_id, reply.campaign_id]);
        if (interested) cancelScheduled(ctx, { campaignId: reply.campaign_id, leadId: reply.lead_id }, 'marked interested');
      }
    });
    if (interested && reply.lead_id) {
      emit(ctx, a.workspaceId, 'LEAD_INTERESTED', { reply_id: reply.id, lead_id: reply.lead_id, campaign_id: reply.campaign_id, from_email: reply.from_email, manual: true }, { reply_id: reply.id, lead_id: reply.lead_id, campaign_id: reply.campaign_id }, { skipWebhooks: b.skip_webhooks });
    }
    return { data: replyJson(getReply(a.workspaceId, reply.id)) };
  };
  r.patch('/api/replies/:id/mark-as-interested', 'Mark as interested', setInterest(true), { body: skipBody });
  r.patch('/api/replies/:id/mark-as-not-interested', 'Mark as not interested', setInterest(false), { body: skipBody });

  const readBody = z.object({ read: bool });
  r.patch('/api/replies/:id/mark-as-read-or-unread', 'Mark as read or unread', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    db.update('replies', reply.id, { read: parse(readBody, req.body).read ? 1 : 0 });
    return { data: replyJson(getReply(a.workspaceId, reply.id)) };
  }, { body: readBody });

  const autoBody = z.object({ automated: bool });
  r.patch('/api/replies/:id/mark-as-automated-or-not-automated', 'Mark as automated or not', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const automated = parse(autoBody, req.body).automated;
    db.update('replies', reply.id, { automated: automated ? 1 : 0, category: automated ? 'auto_reply' : 'reply', label: automated ? 'auto_reply' : 'reply', label_source: 'manual' });
    return { data: replyJson(getReply(a.workspaceId, reply.id)) };
  }, { body: autoBody });

  r.patch('/api/replies/:id/unsubscribe', 'Unsubscribe the contact who replied', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    let lead = reply.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', [reply.lead_id]) : db.get('SELECT * FROM leads WHERE workspace_id = ? AND email = ?', [a.workspaceId, reply.from_email]);
    if (!lead) {
      const id = db.insert('leads', { workspace_id: a.workspaceId, email: reply.from_email, first_name: reply.from_name.split(' ')[0] ?? '' });
      lead = db.get('SELECT * FROM leads WHERE id = ?', [id]);
    }
    unsubscribeLead(ctx, lead!, 'inbox');
    db.update('replies', reply.id, { category: 'unsubscribe', label: 'unsubscribe', label_source: 'manual' });
    return { data: replyJson(getReply(a.workspaceId, reply.id)) };
  });

  r.delete('/api/replies/:id', 'Delete reply', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    db.run('DELETE FROM replies WHERE id = ?', [reply.id]);
    return { data: { success: true } };
  });

  const pushBody = z.object({ campaign_id: z.coerce.number().int(), force_add_reply: bool.default(false) });
  r.post('/api/replies/:id/followup-campaign/push', 'Push lead into a reply follow-up campaign', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const b = parse(pushBody, req.body);
    const campaign = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [b.campaign_id, a.workspaceId]);
    if (!campaign) throw notFound('campaign');
    if (campaign.type !== 'reply_followup' && !b.force_add_reply) throw new HttpError(422, { error: 'validation_error', message: 'Pick a campaign of type "reply follow-up".' });
    let leadId = reply.lead_id;
    if (!leadId) {
      leadId = db.get('SELECT id FROM leads WHERE workspace_id = ? AND email = ?', [a.workspaceId, reply.from_email])?.id
        ?? db.insert('leads', { workspace_id: a.workspaceId, email: reply.from_email, first_name: reply.from_name.split(' ')[0] ?? '' });
      db.update('replies', reply.id, { lead_id: leadId });
    }
    const attached = attachLeads(ctx, a.workspaceId, campaign.id, [leadId], true);
    db.run('UPDATE campaign_leads SET anchor_reply_id = ?, sender_email_id = ?, status = ?, current_step = 0 WHERE campaign_id = ? AND lead_id = ?',
      [reply.id, reply.sender_email_id, 'pending', campaign.id, leadId]);
    if (reply.sender_email_id) db.run('INSERT OR IGNORE INTO campaign_sender_emails (campaign_id, sender_email_id) VALUES (?, ?)', [campaign.id, reply.sender_email_id]);
    return { data: { attached: attached || 1, lead_id: leadId } };
  }, { body: pushBody });

  // ---- sent folder ----
  const sent = defineRoutes(app, 'Sent Emails');
  const sentQ = pageQuery.extend({ kind: z.enum(['all', 'campaign', 'manual', 'reply']).default('all'), sender_email_id: z.coerce.number().int().optional(), search: z.string().optional() });
  sent.get('/api/sent-emails', 'Sent emails', (req) => {
    const a = auth(req);
    const q = parse(sentQ, req.query);
    const where = ['s.workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.kind !== 'all') { where.push('s.kind = ?'); params.push(q.kind); }
    else where.push(`s.kind != 'test'`);
    if (q.sender_email_id) { where.push('s.sender_email_id = ?'); params.push(q.sender_email_id); }
    if (q.search) { where.push('(s.to_email LIKE ? OR s.subject LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
    return paginate(ctx,
      `SELECT s.id, s.kind, s.campaign_id, s.lead_id, s.thread_id, s.to_email, s.subject, s.opens, s.clicks, s.bounced, s.sent_at, s.sender_email_id,
         se.email AS sender_email, c.name AS campaign_name, substr(s.body_text, 1, 200) AS preview,
         (SELECT r.id FROM replies r WHERE r.thread_id = s.thread_id ORDER BY r.id DESC LIMIT 1) AS latest_reply_id
       FROM sent_emails s LEFT JOIN sender_emails se ON se.id = s.sender_email_id LEFT JOIN campaigns c ON c.id = s.campaign_id
       WHERE ${where.join(' AND ')} ORDER BY s.sent_at DESC`, params, q);
  }, { query: sentQ });
  sent.get('/api/sent-emails/:id', 'Sent email details', (req) => {
    const a = auth(req);
    const s = db.get(`SELECT s.*, se.email AS sender_email, se.name AS sender_name FROM sent_emails s LEFT JOIN sender_emails se ON se.id = s.sender_email_id WHERE s.id = ? AND s.workspace_id = ?`, [idParam(req), a.workspaceId]);
    if (!s) throw notFound('email');
    return { data: sentJson(s) };
  });
  sent.get('/api/sent-emails/:id/attachments/:index', 'Download a sent attachment (?inline=1 opens images, PDFs and text in the browser)', (req, reply) => {
    const a = auth(req);
    const s = db.get('SELECT attachments FROM sent_emails WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!s) throw notFound('email');
    return sendAttachment(req, reply, s.attachments);
  });
}
