/**
 * Background loops. Each job runs on its own interval and never overlaps itself.
 */
import type { Ctx } from '../context.ts';
import { dispatch, plan } from './sequencer.ts';
import { syncSender } from './inbox.ts';
import { dispatchWarmup, planWarmup } from './warmup.ts';
import { deliverWebhooks } from './webhooks.ts';
import { checkPlacementTests } from './placement.ts';
import { visitorsJob } from '../visitors/service.ts';
import { sequenceJobs } from './sequenceJobs.ts';
import { runDueSearches } from '../sourcing/savedSearches.ts';
import { classifyPending } from './replyAi.ts';
import { refreshEmailProviders } from './emailProviders.ts';
import { companionTick } from '../companion/worker.ts';
import { ukStreamJob } from '../sourcing/funding/uk.ts';

interface Job {
  name: string;
  everyMs: number;
  run: (ctx: Ctx) => Promise<unknown> | unknown;
}

const SYNC_CONCURRENCY = 4;

/** Syncs mailboxes that have not been synced for `staleMs`, a few at a time. */
async function syncDue(ctx: Ctx, staleMs: number) {
  const cutoff = new Date(ctx.now().getTime() - staleMs).toISOString();
  const due = ctx.db.all(
    `SELECT * FROM sender_emails WHERE status != 'Paused' AND (last_synced_at IS NULL OR last_synced_at < ?) ORDER BY last_synced_at LIMIT 20`,
    [cutoff]);
  for (let i = 0; i < due.length; i += SYNC_CONCURRENCY) {
    await Promise.all(due.slice(i, i + SYNC_CONCURRENCY).map((s) => syncSender(ctx, s)));
  }
}

export function jobs(ctx: Ctx): Job[] {
  const k = ctx.config.tickScale;
  return [
    { name: 'plan', everyMs: 60_000 * k, run: plan },
    { name: 'dispatch', everyMs: 10_000 * k, run: (c) => dispatch(c) },
    { name: 'sync', everyMs: 30_000 * k, run: (c) => syncDue(c, 120_000 * k) },
    { name: 'warmup-plan', everyMs: 5 * 60_000 * k, run: planWarmup },
    { name: 'warmup-send', everyMs: 20_000 * k, run: (c) => dispatchWarmup(c) },
    { name: 'webhooks', everyMs: 15_000 * k, run: (c) => deliverWebhooks(c) },
    { name: 'placement', everyMs: 60_000 * k, run: checkPlacementTests },
    { name: 'visitors', everyMs: 60_000 * k, run: visitorsJob },
    ...sequenceJobs(k),
    { name: 'saved-searches', everyMs: 60_000 * k, run: runDueSearches },
    { name: 'reply-ai', everyMs: 15_000 * k, run: (c) => classifyPending(c) },
    { name: 'email-providers', everyMs: 5 * 60_000 * k, run: (c) => refreshEmailProviders(c) },
    { name: 'companion', everyMs: 30_000 * k, run: companionTick },
    { name: 'funding-uk-stream', everyMs: 10 * 60_000 * k, run: ukStreamJob },
  ];
}

export class Worker {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();
  private stopped = false;
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  start() {
    for (const job of jobs(this.ctx)) {
      const tick = async () => {
        if (this.stopped || this.running.has(job.name)) return;
        this.running.add(job.name);
        try {
          await job.run(this.ctx);
        } catch (err) {
          this.ctx.log.error({ err, job: job.name }, 'job failed');
        } finally {
          this.running.delete(job.name);
        }
      };
      this.timers.push(setInterval(tick, job.everyMs));
      setTimeout(tick, 1000);
    }
    this.ctx.log.info({}, 'background worker started');
  }

  /** Runs one sync pass for a mailbox immediately (used by "Sync now"). */
  async syncNow(senderId: number) {
    const sender = this.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senderId]);
    if (sender) await syncSender(this.ctx, sender);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
