/**
 * The task queue the extension polls. A task is handed out only when its job/campaign is
 * active, the site isn't in a safety pause, working hours are open (for actions), the
 * action bucket has daily/weekly room, the hourly cap isn't hit and the randomised gap
 * since the device's last action has passed.
 */
import type { Ctx } from '../context.ts';
import { phantom } from './catalog.ts';
import {
  loadSettings, usage, inWorkingHours, nextWorkingStart, nextDayStart, isScrapeBucket, actionsLastHour,
  recordAction, pacing, randomDelaySec, dayStart, type CompanionSettings,
} from './settings.ts';
import { loadTask, ingestJobRecords, refreshRun, loadJob, type TaskRow } from './jobs.ts';
import { onCampaignTaskComplete, onConnections, onInbox, loadCampaign } from './campaigns.ts';
import { runServerTask } from './sources.ts';
import { sendUrl } from './whatsapp.ts';
import { parse } from './parsers/index.ts';
import { PARSER_IDS, SITE_HOME, type CompleteBody, type PollResponse, type Rec, type ResultsBatch, type ResultsResponse, type SafetyBody, type Site, type TaskPayload, type ParserId } from './protocol.ts';

export interface Device {
  id: number; workspace_id: number; user_id: number; name: string; paused: boolean; accounts: Record<string, boolean>;
  site_pauses: Record<string, string>; next_action_at: string | null; current_task_id: number | null;
}

export function loadDevice(ctx: Ctx, id: number): Device | undefined {
  const d = ctx.db.get('SELECT * FROM companion_devices WHERE id = ?', [id]);
  return d ? { ...d, paused: !!d.paused, accounts: JSON.parse(d.accounts || '{}'), site_pauses: JSON.parse(d.site_pauses || '{}') } : undefined;
}

const LEASE_MS = { action: 10 * 60_000, scrape: 20 * 60_000 };
const MAX_ATTEMPTS = 3;

/** How many records/actions this task may produce in one lease, given limits and its own max. */
function budgetFor(ctx: Ctx, t: TaskRow, s: CompanionSettings, now: Date): number {
  const quota = t.action ? usage(ctx.db, t.workspace_id, s, t.action, now).remaining : Number.MAX_SAFE_INTEGER;
  const p = phantom(t.kind);
  let own = Number.MAX_SAFE_INTEGER;
  if (t.action && !isScrapeBucket(t.action)) {
    // One action per task, except bulk withdrawals and liking a profile's latest posts.
    own = t.kind === 'linkedin.withdraw_invites' ? Math.max(0, Number(t.params.limit ?? 40) - t.results_count)
      : t.kind === 'linkedin.post_liker' ? Number(t.params.posts_per_profile ?? 1) : 1;
    own = Math.min(own, Math.max(0, s.max_actions_per_hour - actionsLastHour(ctx.db, t.workspace_id, now)));
  } else if (t.params.limit != null) own = Math.max(0, Number(t.params.limit) - t.results_count);
  else if (t.params.posts_per_profile != null && p?.id === 'linkedin.profile_activity') own = Number(t.params.posts_per_profile);
  return Math.max(0, Math.min(quota, own, 100_000));
}

function openUrlFor(t: TaskRow): string {
  if (t.site === 'whatsapp') return sendUrl(String(t.target.phone ?? t.target.url ?? ''));
  const u = t.target.url ?? t.target.profileUrl ?? t.target.postUrl ?? t.params.search_url ?? t.params.group_url ?? t.params.event_url;
  if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
  if (t.kind === 'linkedin.connections_export' || t.kind === 'linkedin.check_connections') return 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
  if (t.kind === 'linkedin.inbox_export' || t.kind === 'linkedin.check_inbox') return 'https://www.linkedin.com/messaging/';
  if (t.kind === 'linkedin.withdraw_invites') return 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
  if (t.kind === 'instagram.hashtag_export' && t.params.hashtag) return `https://www.instagram.com/explore/tags/${encodeURIComponent(String(t.params.hashtag).replace(/^#/, ''))}/`;
  if (t.kind === 'x.search_export' && t.params.query) return `https://x.com/search?q=${encodeURIComponent(String(t.params.query))}&f=${t.params.mode === 'Top' ? 'top' : 'live'}`;
  return SITE_HOME[t.site];
}

/**
 * Hands the next eligible task to a device (or explains why not and when to come back).
 * `sites` narrows to sites the browser is logged in to.
 */
export function leaseTask(ctx: Ctx, device: Device, now: Date, opts: { sites?: Site[] } = {}): PollResponse {
  const s = loadSettings(ctx.db, device.workspace_id);
  if (s.paused) return { task: null, waitSeconds: 300, reason: 'All automations are paused', pausedAll: true };
  if (device.paused) return { task: null, waitSeconds: 300, reason: 'This browser is paused' };
  recoverLeases(ctx, now);

  const iso = now.toISOString();
  const candidates = ctx.db.all(`SELECT t.id FROM companion_tasks t
      LEFT JOIN companion_jobs j ON j.id = t.job_id
      LEFT JOIN li_campaigns c ON c.id = t.campaign_id
    WHERE t.workspace_id = ? AND t.status = 'pending' AND t.runner = 'extension' AND (t.not_before IS NULL OR t.not_before <= ?)
      AND ((t.job_id IS NOT NULL AND j.status IN ('running', 'queued')) OR (t.campaign_id IS NOT NULL AND c.status = 'active'))
    ORDER BY t.priority DESC, t.id LIMIT 300`, [device.workspace_id, iso]);

  const hours = inWorkingHours(s, now);
  const hourCapHit = actionsLastHour(ctx.db, device.workspace_id, now) >= s.max_actions_per_hour;
  const coolingUntil = device.next_action_at && Date.parse(device.next_action_at) > now.getTime() ? new Date(device.next_action_at) : null;
  const reasons = new Map<string, Date | null>();
  const skip = (why: string, until: Date | null) => { if (!reasons.has(why)) reasons.set(why, until); };
  const remaining = new Map<string, number>();

  for (const { id } of candidates) {
    const t = loadTask(ctx, id)!;
    const pausedUntil = device.site_pauses[t.site];
    if (pausedUntil && Date.parse(pausedUntil) > now.getTime()) { skip(`${t.site} is paused after a safety stop`, new Date(pausedUntil)); continue; }
    if (opts.sites && !opts.sites.includes(t.site)) { skip(`not logged in to ${t.site} in this browser`, null); continue; }
    const isAction = !!t.action && !isScrapeBucket(t.action);
    if (!hours && (isAction || !s.scrape_outside_hours)) { skip('outside working hours', nextWorkingStart(s, now)); continue; }
    if (t.action) {
      if (!remaining.has(t.action)) remaining.set(t.action, usage(ctx.db, device.workspace_id, s, t.action, now).remaining);
      if (remaining.get(t.action)! <= 0) { skip(`${s.limits[t.action] ? t.action : 'limit'} limit reached for today`, nextDayStart(s, now)); continue; }
    }
    if (isAction && hourCapHit) { skip('hourly action cap reached', new Date(now.getTime() + 10 * 60_000)); continue; }
    if (isAction && coolingUntil) { skip('pacing delay between actions', coolingUntil); continue; }
    if (t.campaign_id && isAction && !campaignCapOk(ctx, t, s, now)) { skip('campaign daily cap reached', nextDayStart(s, now)); continue; }

    const budget = budgetFor(ctx, t, s, now);
    if (budget <= 0 && t.action) { skip('limit reached', nextDayStart(s, now)); continue; }

    ctx.db.run(`UPDATE companion_tasks SET status = 'leased', device_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      [device.id, new Date(now.getTime() + (isAction ? LEASE_MS.action : LEASE_MS.scrape)).toISOString(), iso, t.id]);
    ctx.db.update('companion_devices', device.id, { current_task_id: t.id });
    if (t.job_id) {
      const job = loadJob(ctx, t.job_id);
      ctx.db.update('companion_jobs', t.job_id, { status: 'running', progress: JSON.stringify({ ...job.progress, message: `Running in ${device.name}` }) });
    }
    const payload: TaskPayload = {
      id: t.id, kind: t.kind, site: t.site, openUrl: openUrlFor(t), target: t.target, params: t.params, cursor: t.cursor,
      budget: t.action ? budget : Math.min(budget, 100_000), pacing: pacing(s), jobId: t.job_id, campaignId: t.campaign_id,
    };
    return { task: payload, waitSeconds: 0 };
  }

  // Nothing eligible: report the most relevant reason and when to poll again.
  const nextNotBefore = ctx.db.get<{ at: string | null }>(`SELECT MIN(not_before) at FROM companion_tasks WHERE workspace_id = ? AND status = 'pending' AND runner = 'extension' AND not_before > ?`, [device.workspace_id, iso])?.at;
  const first = [...reasons.entries()][0];
  const wakeAt = [first?.[1] ?? null, nextNotBefore ? new Date(nextNotBefore) : null].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  const wait = wakeAt ? Math.ceil((wakeAt.getTime() - now.getTime()) / 1000) : candidates.length ? 300 : 60;
  return { task: null, waitSeconds: Math.max(15, Math.min(wait, 900)), reason: first?.[0] ?? (candidates.length ? undefined : 'No tasks queued') };
}

function campaignCapOk(ctx: Ctx, t: TaskRow, s: CompanionSettings, now: Date): boolean {
  const c = loadCampaign(ctx, t.campaign_id!);
  const cap = t.kind === 'linkedin.connect' ? c.settings.daily_invites : t.kind === 'linkedin.message' ? c.settings.daily_messages : Infinity;
  if (!Number.isFinite(cap)) return true;
  const used = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND kind = ? AND (status = 'leased' OR (status = 'done' AND updated_at >= ?))`,
    [c.id, t.kind, dayStart(s, now).toISOString()])!.n;
  return used < cap;
}

/** Leases that outlived their deadline go back to the queue (or fail after MAX_ATTEMPTS). */
export function recoverLeases(ctx: Ctx, now: Date): number {
  const iso = now.toISOString();
  const expired = ctx.db.all<{ id: number; attempts: number; run_id: number | null; device_id: number | null }>(`SELECT id, attempts, run_id, device_id FROM companion_tasks WHERE status = 'leased' AND lease_expires_at < ?`, [iso]);
  for (const t of expired) {
    if (t.attempts >= MAX_ATTEMPTS) ctx.db.run(`UPDATE companion_tasks SET status = 'failed', error = 'The extension stopped responding (3 attempts)', updated_at = ? WHERE id = ?`, [iso, t.id]);
    else ctx.db.run(`UPDATE companion_tasks SET status = 'pending', device_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [iso, t.id]);
    if (t.device_id) ctx.db.run('UPDATE companion_devices SET current_task_id = NULL WHERE id = ? AND current_task_id = ?', [t.device_id, t.id]);
    if (t.run_id) refreshRun(ctx, t.run_id, now);
  }
  return expired.length;
}

/** The task as leased by this device, or a 404/409 the extension understands. */
export function leasedTask(ctx: Ctx, taskId: number, device: Device): TaskRow {
  const t = loadTask(ctx, taskId);
  if (!t || t.workspace_id !== device.workspace_id) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  if (t.status !== 'leased' || t.device_id !== device.id) throw Object.assign(new Error(`Task is ${t.status}${t.device_id && t.device_id !== device.id ? ' on another browser' : ''}`), { statusCode: 409 });
  return t;
}

/** Whether the task's job/campaign was paused or cancelled meanwhile (the extension should stop). */
function stopSignal(ctx: Ctx, t: TaskRow): string | null {
  const s = loadSettings(ctx.db, t.workspace_id);
  if (s.paused) return 'All automations were paused';
  if (t.job_id) {
    const st = ctx.db.get<{ status: string }>('SELECT status FROM companion_jobs WHERE id = ?', [t.job_id])?.status;
    if (st && !['running', 'queued'].includes(st)) return `The automation is ${st}`;
  }
  if (t.campaign_id) {
    const st = ctx.db.get<{ status: string }>('SELECT status FROM li_campaigns WHERE id = ?', [t.campaign_id])?.status;
    if (st !== 'active') return `The campaign is ${st}`;
  }
  return null;
}

export function progressTask(ctx: Ctx, t: TaskRow, body: { message?: string; done?: number; total?: number; cursor?: unknown }, now: Date) {
  const data: Record<string, unknown> = { lease_expires_at: new Date(now.getTime() + LEASE_MS.scrape).toISOString(), updated_at: now.toISOString() };
  if (body.cursor !== undefined) data.cursor = JSON.stringify(body.cursor);
  ctx.db.update('companion_tasks', t.id, data);
  if (t.job_id && body.message) {
    const job = loadJob(ctx, t.job_id);
    ctx.db.update('companion_jobs', t.job_id, { progress: JSON.stringify({ ...job.progress, message: body.message.slice(0, 200) }) });
  }
  const stop = stopSignal(ctx, t);
  return stop ? { ok: true, stop: true, reason: stop } : { ok: true };
}

/** A batch of results: parse captures, count scrape usage, write to the job table or campaign. */
export async function resultsTask(ctx: Ctx, t: TaskRow, device: Device, batch: ResultsBatch, now: Date): Promise<ResultsResponse> {
  const records: Rec[] = [...(batch.records ?? [])];
  for (const c of batch.captures ?? []) {
    if (!(PARSER_IDS as readonly string[]).includes(c.parser)) continue;
    try { records.push(...parse(c.parser as ParserId, c.data, { url: c.url }).records); } catch { /* unparseable capture */ }
  }
  const s = loadSettings(ctx.db, t.workspace_id);
  const p = phantom(t.kind);
  // Scrape buckets are spent per record read; action phantoms report actions on complete.
  const counted = t.action && isScrapeBucket(t.action) && p?.category !== 'action' ? records.length : 0;
  recordAction(ctx.db, { workspaceId: t.workspace_id, action: t.action ?? 'none', count: counted, deviceId: device.id, taskId: t.id, jobId: t.job_id, at: now });
  const upd: Record<string, unknown> = { results_count: t.results_count + records.length, lease_expires_at: new Date(now.getTime() + LEASE_MS.scrape).toISOString(), updated_at: now.toISOString() };
  if (batch.cursor !== undefined) upd.cursor = JSON.stringify(batch.cursor);
  ctx.db.update('companion_tasks', t.id, upd);

  let fresh = 0;
  if (t.campaign_id && t.kind === 'linkedin.check_connections') fresh = onConnections(ctx, t.campaign_id, records, now);
  else if (t.campaign_id && t.kind === 'linkedin.check_inbox') fresh = onInbox(ctx, t.campaign_id, records, now);
  else if (t.job_id) fresh = (await ingestJobRecords(ctx, t, records, now)).fresh.length;

  const after = { ...t, results_count: t.results_count + records.length };
  const budgetLeft = t.action && isScrapeBucket(t.action) ? budgetFor(ctx, after, s, now) : Number.MAX_SAFE_INTEGER;
  const stop = stopSignal(ctx, t);
  const res: ResultsResponse = { accepted: records.length, new: fresh, budgetLeft: Math.min(budgetLeft, 1_000_000) };
  if (stop) Object.assign(res, { stop: true, reason: stop });
  else if (budgetLeft <= 0) Object.assign(res, { stop: true, reason: 'Limit reached' });
  return res;
}

export function completeTask(ctx: Ctx, t: TaskRow, device: Device, body: CompleteBody, now: Date) {
  const iso = now.toISOString();
  const s = loadSettings(ctx.db, t.workspace_id);
  const isAction = !!t.action && !isScrapeBucket(t.action);
  const actions = isAction ? Math.max(0, body.actions ?? (body.status === 'done' ? 1 : 0)) : 0;
  recordAction(ctx.db, { workspaceId: t.workspace_id, action: t.action ?? 'none', count: actions, deviceId: device.id, taskId: t.id, jobId: t.job_id, at: now });

  if (body.more && body.status === 'done') {
    // Paged scrape stopped at its budget: continue later from the cursor (tomorrow if today's limit is spent).
    const left = budgetFor(ctx, loadTask(ctx, t.id)!, s, now);
    const own = t.params.limit != null ? Number(t.params.limit) - (loadTask(ctx, t.id)!.results_count) : 1;
    if (own <= 0) {
      ctx.db.run(`UPDATE companion_tasks SET status = 'done', cursor = ?, result = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [JSON.stringify(body.cursor ?? null), JSON.stringify(body.result ?? null), iso, t.id]);
    } else {
      const notBefore = left > 0 ? new Date(now.getTime() + randomDelaySec(s.delays.page_min_sec, s.delays.page_max_sec) * 1000) : nextDayStart(s, now);
      ctx.db.run(`UPDATE companion_tasks SET status = 'pending', attempts = 0, cursor = ?, not_before = ?, device_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [JSON.stringify(body.cursor ?? t.cursor ?? null), notBefore.toISOString(), iso, t.id]);
    }
  } else if (body.status === 'failed' && !isAction && t.attempts < MAX_ATTEMPTS) {
    // Reads are safe to retry; actions never are (could double-send).
    ctx.db.run(`UPDATE companion_tasks SET status = 'pending', error = ?, not_before = ?, device_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [body.error ?? 'failed', new Date(now.getTime() + 10 * 60_000).toISOString(), iso, t.id]);
  } else {
    ctx.db.run(`UPDATE companion_tasks SET status = ?, result = ?, error = ?, cursor = COALESCE(?, cursor), lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [body.status, JSON.stringify(body.result ?? null), body.error ?? null, body.cursor === undefined ? null : JSON.stringify(body.cursor), iso, t.id]);
    if (t.campaign_id) onCampaignTaskComplete(ctx, t, body.status, body.result ?? null, body.error ?? null, now);
    if (t.kind === 'linkedin.comment') {
      ctx.db.run(`UPDATE companion_approvals SET status = ? WHERE task_id = ?`, [body.status === 'done' ? 'posted' : 'failed', t.id]);
    }
  }
  ctx.db.run('UPDATE companion_devices SET current_task_id = NULL, next_action_at = ? WHERE id = ?', [
    actions > 0 ? new Date(now.getTime() + randomDelaySec(s.delays.action_min_sec, s.delays.action_max_sec) * 1000).toISOString() : device.next_action_at, device.id,
  ]);
  if (t.run_id) refreshRun(ctx, t.run_id, now);
  return { ok: true };
}

/** Safety stop (rate limit, challenge, logged out): pause the site for this browser and hand the task back. */
export function safetyStop(ctx: Ctx, t: TaskRow | null, device: Device, body: SafetyBody, now: Date) {
  const hours = body.kind === 'challenge' || body.kind === 'restricted' ? 24 : body.kind === 'rate_limited' ? 6 : body.kind === 'logged_out' ? 1 : 0.5;
  const until = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const site = t?.site ?? 'linkedin';
  const pauses = { ...device.site_pauses, [site]: until };
  ctx.db.update('companion_devices', device.id, {
    site_pauses: JSON.stringify(pauses), current_task_id: null,
    last_error: `${site}: ${body.kind}${body.message ? ` — ${body.message}` : ''}`.slice(0, 500),
  });
  if (t && t.status === 'leased') {
    ctx.db.run(`UPDATE companion_tasks SET status = 'pending', attempts = MAX(attempts - 1, 0), device_id = NULL, lease_expires_at = NULL, not_before = ?, error = ?, updated_at = ? WHERE id = ?`,
      [until, `Paused: ${body.kind}`, now.toISOString(), t.id]);
    if (t.job_id) {
      const job = loadJob(ctx, t.job_id);
      ctx.db.update('companion_jobs', t.job_id, { progress: JSON.stringify({ ...job.progress, message: `Safety stop on ${site} (${body.kind}) — paused until ${until.slice(0, 16).replace('T', ' ')} UTC` }) });
    }
  }
  ctx.log.warn({ device: device.id, site, kind: body.kind, url: body.url }, 'companion safety stop');
  return { paused_until: until };
}

/** Runs pending server-side tasks (Reddit, GitHub) — no extension needed. */
export async function runServerTasks(ctx: Ctx, now: Date, max = 5): Promise<number> {
  const due = ctx.db.all<{ id: number }>(`SELECT t.id FROM companion_tasks t JOIN companion_jobs j ON j.id = t.job_id
    WHERE t.status = 'pending' AND t.runner = 'server' AND (t.not_before IS NULL OR t.not_before <= ?) AND j.status IN ('running', 'queued')
    ORDER BY t.priority DESC, t.id LIMIT ?`, [now.toISOString(), max]);
  for (const { id } of due) {
    const t = loadTask(ctx, id)!;
    ctx.db.run(`UPDATE companion_tasks SET status = 'leased', attempts = attempts + 1, lease_expires_at = ?, updated_at = ? WHERE id = ?`, [new Date(now.getTime() + LEASE_MS.scrape).toISOString(), now.toISOString(), id]);
    try {
      const limit = Number(t.params.limit ?? 100);
      const out = await runServerTask({ phantom: t.kind, params: t.params, target: t.target, cursor: t.cursor, budget: Math.max(0, limit - t.results_count), settings: ctx.gtm!.settings });
      const records = out.records.slice(0, Math.max(0, limit - t.results_count));
      if (records.length) await ingestJobRecords(ctx, t, records, now);
      const count = t.results_count + records.length;
      const more = out.nextCursor != null && count < limit && records.length > 0;
      ctx.db.run(`UPDATE companion_tasks SET status = ?, cursor = ?, results_count = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [more ? 'pending' : 'done', JSON.stringify(out.nextCursor ?? null), count, now.toISOString(), id]);
    } catch (e: any) {
      const retry = t.attempts + 1 < MAX_ATTEMPTS;
      ctx.db.run(`UPDATE companion_tasks SET status = ?, error = ?, not_before = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        [retry ? 'pending' : 'failed', String(e.message ?? e).slice(0, 500), new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString(), id]);
    }
    if (t.run_id) refreshRun(ctx, t.run_id, now);
  }
  return due.length;
}
