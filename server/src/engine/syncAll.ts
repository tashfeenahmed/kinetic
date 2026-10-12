/**
 * "Fetch new email" for the master inbox: syncs every connected mailbox of a workspace now,
 * a few at a time, each under a timeout so one stuck IMAP server can't hang the request.
 * Shares in-flight passes with the background sync job (see syncSenderResult).
 */
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { syncSenderResult } from './inbox.ts';

export interface MailboxSyncResult {
  sender_email_id: number;
  email: string;
  name: string | null;
  status: 'synced' | 'error' | 'timeout';
  processed: number;
  new_messages: number;
  error: string | null;
}

export interface WorkspaceSyncResult {
  mailboxes: MailboxSyncResult[];
  totals: { mailboxes: number; synced: number; new_messages: number; errors: number };
  last_synced_at: string | null;
}

const TIMEOUT = Symbol('timeout');

export async function syncWorkspace(ctx: Ctx, workspaceId: number, opts: { concurrency?: number; timeoutMs?: number } = {}): Promise<WorkspaceSyncResult> {
  const { db } = ctx;
  const concurrency = opts.concurrency ?? 3;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const senders = db.all(`SELECT * FROM sender_emails WHERE workspace_id = ? AND status = 'Connected' ORDER BY id`, [workspaceId]);
  const maxReplyId = (db.get('SELECT COALESCE(MAX(id), 0) AS n FROM replies WHERE workspace_id = ?', [workspaceId])?.n ?? 0) as number;

  const syncOne = async (s: Row): Promise<MailboxSyncResult> => {
    const base = { sender_email_id: s.id as number, email: s.email as string, name: (s.name as string) ?? null };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); });
    try {
      // A timed-out pass keeps running in the background; the next call joins it rather than starting another.
      const r = await Promise.race([syncSenderResult(ctx, s), timeout]);
      if (r === TIMEOUT) return { ...base, status: 'timeout', processed: 0, new_messages: 0, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` };
      return { ...base, status: r.error ? 'error' : 'synced', processed: r.processed, new_messages: 0, error: r.error };
    } finally {
      clearTimeout(timer);
    }
  };

  const results: MailboxSyncResult[] = new Array(senders.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, senders.length) }, async () => {
    while (next < senders.length) {
      const i = next++;
      results[i] = await syncOne(senders[i]!);
    }
  }));

  // "New" = inbox messages (replies rows) stored during this call, not warmup or skipped traffic.
  const counts = new Map<number, number>();
  for (const row of db.all('SELECT sender_email_id, COUNT(*) AS n FROM replies WHERE workspace_id = ? AND id > ? GROUP BY sender_email_id', [workspaceId, maxReplyId])) {
    counts.set(row.sender_email_id, row.n);
  }
  for (const r of results) r.new_messages = counts.get(r.sender_email_id) ?? 0;

  return {
    mailboxes: results,
    totals: {
      mailboxes: results.length,
      synced: results.filter((r) => r.status === 'synced').length,
      new_messages: results.reduce((n, r) => n + r.new_messages, 0),
      errors: results.filter((r) => r.status !== 'synced').length,
    },
    last_synced_at: lastSyncedAt(ctx, workspaceId),
  };
}

/** Most recent last_synced_at across the workspace's non-paused mailboxes. */
export function lastSyncedAt(ctx: Ctx, workspaceId: number): string | null {
  return (ctx.db.get(`SELECT MAX(last_synced_at) AS t FROM sender_emails WHERE workspace_id = ? AND status != 'Paused'`, [workspaceId])?.t as string) ?? null;
}
