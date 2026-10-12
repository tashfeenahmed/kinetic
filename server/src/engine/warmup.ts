/**
 * Private warmup pool.
 *
 * Every connected mailbox with warmup enabled (across all workspaces) emails the others.
 * Volume ramps up daily to the mailbox's warmup limit. On the receiving side the sync
 * engine hands warmup messages here: we record where they landed, rescue them from spam,
 * mark them read, sometimes reply, and file them away so they never clutter the inbox.
 */
import { DateTime } from 'luxon';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import type { InboundMessage } from '../mail/classify.ts';
import { getSetting } from '../settings.ts';
import { domainOf } from '../lib/dns.ts';
import { newMessageId } from './compose.ts';
import { warmupEmail, warmupReply } from './warmupContent.ts';
import type { Location } from './inbox.ts';
import { quoteText } from './quote.ts';

export const WARMUP_FOLDER = 'Kinetic Warmup';
const RAMP_START = 2;
const RAMP_STEP = 2;

export function warmupTimezone(ctx: Ctx): string {
  return getSetting(ctx.db, 'warmup_timezone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** Warmup sends allowed today for a mailbox, ramping from RAMP_START by RAMP_STEP per day. */
export function rampTarget(sender: Row, now: Date): number {
  const started = sender.warmup_started_at ? Date.parse(sender.warmup_started_at) : now.getTime();
  const days = Math.max(0, Math.floor((now.getTime() - started) / 86_400_000));
  return Math.min(sender.warmup_daily_limit, RAMP_START + RAMP_STEP * days);
}

/** Books today's remaining warmup sends at random times through the warmup window (08:00–20:00). */
export function planWarmup(ctx: Ctx): { planned: number } {
  const { db } = ctx;
  const now = ctx.now();
  const tz = warmupTimezone(ctx);
  const local = DateTime.fromJSDate(now).setZone(tz);
  const dayStart = local.startOf('day');
  const windowStart = dayStart.set({ hour: 8 }).toMillis();
  const windowEnd = dayStart.set({ hour: 20 }).toMillis();
  if (now.getTime() >= windowEnd) return { planned: 0 };

  const pool = db.all(`SELECT * FROM sender_emails WHERE warmup_enabled = 1 AND status = 'Connected'`);
  if (pool.length < 2) return { planned: 0 };

  let planned = 0;
  db.tx(() => {
    for (const sender of pool) {
      const booked = db.get<{ n: number }>(
        `SELECT COUNT(*) n FROM warmup_emails WHERE from_sender_id = ? AND is_reply = 0 AND scheduled_at >= ? AND status != 'cancelled'`,
        [sender.id, dayStart.toUTC().toISO()])?.n ?? 0;
      const need = rampTarget(sender, now) - booked;
      if (need <= 0) continue;

      const from = Math.max(now.getTime(), windowStart);
      const recipients = chooseRecipients(sender, pool, need);
      const times = Array.from({ length: need }, () => from + Math.random() * (windowEnd - from)).sort((a, b) => a - b);
      for (let i = 0; i < need; i++) {
        const to = recipients[i]!;
        const content = warmupEmail(sender.name, to.name);
        db.insert('warmup_emails', {
          from_sender_id: sender.id,
          to_sender_id: to.id,
          message_id: newMessageId(sender.email),
          subject: content.subject,
          body_text: content.text,
          is_reply: 0,
          scheduled_at: new Date(times[i]!).toISOString(),
          status: 'scheduled',
        });
        planned++;
      }
    }
  });
  return { planned };
}

/** Spreads recipients across the pool, preferring other domains and other providers. */
function chooseRecipients(sender: Row, pool: Row[], n: number): Row[] {
  const others = pool.filter((p) => p.id !== sender.id);
  const myDomain = domainOf(sender.email);
  const score = (p: Row) => (domainOf(p.email) !== myDomain ? 2 : 0) + (p.provider !== sender.provider ? 1 : 0) + Math.random();
  const ranked = others.sort((a, b) => score(b) - score(a));
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push(ranked[i % ranked.length]!);
  return out;
}

export async function dispatchWarmup(ctx: Ctx, limit = 50): Promise<{ sent: number; failed: number }> {
  const { db } = ctx;
  const due = db.all(
    `SELECT w.*, f.status AS from_status, f.warmup_enabled AS from_enabled
     FROM warmup_emails w JOIN sender_emails f ON f.id = w.from_sender_id
     WHERE w.status = 'scheduled' AND w.scheduled_at <= ? ORDER BY w.scheduled_at LIMIT ?`,
    [ctx.now().toISOString(), limit]);
  let sent = 0;
  let failed = 0;
  for (const w of due) {
    if (w.from_status !== 'Connected' || !w.from_enabled) {
      db.update('warmup_emails', w.id, { status: 'cancelled' });
      continue;
    }
    const from = db.get('SELECT * FROM sender_emails WHERE id = ?', [w.from_sender_id])!;
    const to = db.get('SELECT * FROM sender_emails WHERE id = ?', [w.to_sender_id]);
    if (!to) {
      db.update('warmup_emails', w.id, { status: 'cancelled' });
      continue;
    }
    const text: string = w.body_text || warmupEmail(from.name, to.name).text;
    const references: string[] = w.is_reply && w.in_reply_to ? [w.in_reply_to] : [];
    try {
      await ctx.mail.send(from, {
        from: { name: from.name, email: from.email },
        to: `"${to.name.replace(/"/g, '')}" <${to.email}>`,
        subject: w.subject,
        text,
        messageId: w.message_id,
        inReplyTo: w.in_reply_to,
        references,
      });
      db.update('warmup_emails', w.id, { status: 'sent', sent_at: ctx.now().toISOString() });
      sent++;
    } catch (err: any) {
      db.update('warmup_emails', w.id, { status: 'failed', error: String(err?.message ?? err).slice(0, 300) });
      failed++;
    }
  }
  return { sent, failed };
}

export function isWarmupMessage(ctx: Ctx, msg: InboundMessage): boolean {
  return !!ctx.db.get('SELECT 1 FROM warmup_emails WHERE message_id = ?', [msg.messageId]);
}

/** Called by the sync engine for every warmup message found in a mailbox. */
export async function handleWarmupMessage(ctx: Ctx, receiver: Row, msg: InboundMessage, loc: Location): Promise<void> {
  const { db } = ctx;
  const w = db.get('SELECT * FROM warmup_emails WHERE message_id = ?', [msg.messageId])!;
  const firstSighting = !w.received_at;

  if (firstSighting) {
    db.update('warmup_emails', w.id, {
      landed_folder: loc.kind,
      received_at: ctx.now().toISOString(),
      rescued: loc.kind === 'spam' ? 1 : 0,
    });
    maybeReply(ctx, receiver, w);
  }

  if (!loc.client) return;
  const client = loc.client;
  try {
    if (loc.kind === 'spam') {
      // Pulling it out of spam is the strongest positive signal a mailbox provider sees.
      await client.messageFlagsAdd(String(loc.uid), ['\\Seen'], { uid: true });
      await client.messageMove(String(loc.uid), 'INBOX', { uid: true });
      return; // the next inbox pass files it away
    }
    const flags = ['\\Seen'];
    if (Math.random() < 0.2) flags.push('\\Flagged');
    await client.messageFlagsAdd(String(loc.uid), flags, { uid: true });
    await ensureFolder(client, WARMUP_FOLDER);
    await client.messageMove(String(loc.uid), WARMUP_FOLDER, { uid: true });
  } catch (err: any) {
    ctx.log.warn({ err: String(err?.message ?? err), sender: receiver.email }, 'warmup mailbox action failed');
  }
}

async function ensureFolder(client: any, path: string) {
  const list = await client.list();
  if (!list.some((f: any) => f.path === path)) {
    try { await client.mailboxCreate(path); } catch { /* exists */ }
  }
}

function maybeReply(ctx: Ctx, receiver: Row, w: Row) {
  if (!receiver.warmup_enabled || receiver.status !== 'Connected') return;
  // Replies go one level deep at most, with a lower rate for replies to replies.
  const rate = (receiver.warmup_reply_rate ?? 35) / 100 * (w.is_reply ? 0.3 : 1);
  if (w.is_reply && w.in_reply_to && ctx.db.get('SELECT 1 FROM warmup_emails WHERE message_id = ? AND is_reply = 1', [w.in_reply_to])) return;
  if (Math.random() >= rate) return;
  const original = ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [w.from_sender_id]);
  if (!original) return;
  const delayMs = (5 + Math.random() * 85) * 60_000;
  ctx.db.insert('warmup_emails', {
    from_sender_id: receiver.id,
    to_sender_id: original.id,
    message_id: newMessageId(receiver.email),
    in_reply_to: w.message_id,
    subject: /^re:/i.test(w.subject) ? w.subject : `Re: ${w.subject}`,
    body_text: warmupReply(receiver.name, original.name) + quoteText(original.name, original.email, w.sent_at ?? w.scheduled_at, w.body_text ?? ''),
    is_reply: 1,
    scheduled_at: new Date(ctx.now().getTime() + delayMs).toISOString(),
    status: 'scheduled',
  });
}

/** Per-mailbox warmup statistics for the last `days` days. */
export function warmupStats(ctx: Ctx, senderId: number, days = 7) {
  const since = new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
  const s = ctx.db.get(
    `SELECT
       (SELECT COUNT(*) FROM warmup_emails WHERE from_sender_id = ? AND status = 'sent' AND sent_at >= ?) AS sent,
       (SELECT COUNT(*) FROM warmup_emails WHERE from_sender_id = ? AND is_reply = 0 AND status = 'sent' AND sent_at >= ?) AS sent_new,
       (SELECT COUNT(*) FROM warmup_emails WHERE from_sender_id = ? AND landed_folder = 'inbox' AND sent_at >= ?) AS landed_inbox,
       (SELECT COUNT(*) FROM warmup_emails WHERE from_sender_id = ? AND landed_folder = 'spam' AND sent_at >= ?) AS landed_spam,
       (SELECT COUNT(*) FROM warmup_emails WHERE to_sender_id = ? AND received_at >= ?) AS received,
       (SELECT COUNT(*) FROM warmup_emails WHERE to_sender_id = ? AND rescued = 1 AND received_at >= ?) AS rescued,
       (SELECT COUNT(*) FROM warmup_emails WHERE from_sender_id = ? AND is_reply = 1 AND status = 'sent' AND sent_at >= ?) AS replies_sent`,
    [senderId, since, senderId, since, senderId, since, senderId, since, senderId, since, senderId, since, senderId, since])!;
  const placed = s.landed_inbox + s.landed_spam;
  return { ...s, health_score: placed ? Math.round((s.landed_inbox / placed) * 100) : null };
}
