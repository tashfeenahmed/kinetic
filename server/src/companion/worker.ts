/** Background pass for the Companion: watcher schedules, stale leases, server-side scrapers, LinkedIn campaigns. */
import type { Ctx } from '../context.ts';
import { startDueJobs } from './jobs.ts';
import { recoverLeases, runServerTasks } from './queue.ts';
import { campaignTick } from './campaigns.ts';

export async function companionTick(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  startDueJobs(ctx, now);
  recoverLeases(ctx, now);
  await campaignTick(ctx, now);
  await runServerTasks(ctx, now);
}
