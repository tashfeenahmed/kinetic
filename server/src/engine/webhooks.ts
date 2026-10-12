import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { hmacSha256 } from '../lib/crypto.ts';

/** Delay before retry n (1-based). Five retries spread across ~24 hours. */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 16 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export async function deliverWebhooks(ctx: Ctx, limit = 50): Promise<{ delivered: number; failed: number }> {
  const due = ctx.db.all(
    `SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.id LIMIT ?`,
    [ctx.now().toISOString(), limit]);
  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    (await attempt(ctx, d)) ? delivered++ : failed++;
  }
  return { delivered, failed };
}

/** Sends one delivery attempt and schedules a retry on failure. Returns success. */
export async function attempt(ctx: Ctx, d: Row): Promise<boolean> {
  const started = Date.now();
  let status: number | null = null;
  let body = '';
  let error: string | null = null;
  try {
    const res = await ctx.fetch(d.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Kinetic-Webhooks/1.0',
        'x-kinetic-event': d.event_type,
        'x-kinetic-delivery': String(d.id),
        'x-kinetic-signature': `sha256=${hmacSha256(d.secret, d.payload)}`,
      },
      body: d.payload,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    body = (await res.text()).slice(0, 2000);
  } catch (err: any) {
    error = String(err?.message ?? err);
  }
  const ok = status !== null && status >= 200 && status < 300;
  const attempts = d.attempts + 1;
  ctx.db.tx(() => {
    ctx.db.insert('webhook_attempts', { webhook_delivery_id: d.id, response_status: status, response_body: body, error, duration_ms: Date.now() - started, created_at: ctx.now().toISOString() });
    if (ok) {
      ctx.db.update('webhook_deliveries', d.id, { status: 'succeeded', attempts, next_attempt_at: null });
    } else if (attempts >= MAX_ATTEMPTS) {
      ctx.db.update('webhook_deliveries', d.id, { status: 'failed', attempts, next_attempt_at: null });
    } else {
      ctx.db.update('webhook_deliveries', d.id, { attempts, next_attempt_at: new Date(ctx.now().getTime() + RETRY_DELAYS_MS[attempts - 1]!).toISOString() });
    }
  });
  return ok;
}
