/**
 * Automation jobs: a phantom + inputs + output table + optional schedule. Starting a job
 * creates a run and its tasks; results stream into the job's GTM table, deduped by the
 * phantom's key, so watcher re-runs add only new rows.
 */
import type { Ctx } from '../context.ts';
import { HttpError } from '../http.ts';
import { emit } from '../events.ts';
import { RUNNABLE, type ColumnType } from '../gtm/engine/store.ts';
import { unwrap } from '../gtm/lib/template.ts';
import { slackPost, callHttp } from '../gtm/providers/integrations.ts';
import { phantom as findPhantom, type Phantom } from './catalog.ts';
import { AI_TOKEN, aiReady, draftComment } from './render.ts';
import { normalizeUrl } from './parsers/index.ts';
import type { Rec, Site } from './protocol.ts';

export type JobStatus = 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type Every = 'hourly' | 'daily' | 'weekly';

export interface Job {
  id: number; workspace_id: number; phantom: string; name: string; params: Record<string, any>; status: JobStatus;
  table_id: number | null; column_map: Record<string, string>; dedupe_key: string | null; schedule: { every?: Every };
  watcher: boolean; alerts: { slack?: boolean; slack_channel?: string; webhook_url?: string }; progress: { done?: number; total?: number; message?: string };
  results_count: number; error: string | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string;
}

const j = (s: string | null, d: any = {}) => (s ? JSON.parse(s) : d);

export function loadJob(ctx: Ctx, id: number, workspaceId?: number): Job {
  const r = ctx.db.get('SELECT * FROM companion_jobs WHERE id = ?', [id]);
  if (!r || (workspaceId != null && r.workspace_id !== workspaceId)) throw new HttpError(404, { error: 'not_found', message: 'automation not found' });
  return { ...r, params: j(r.params), column_map: j(r.column_map), schedule: j(r.schedule), watcher: !!r.watcher, alerts: j(r.alerts), progress: j(r.progress) };
}

export function phantomOf(id: string): Phantom {
  const p = findPhantom(id);
  if (!p) throw new HttpError(422, { error: 'validation_error', message: `Unknown phantom "${id}". GET /api/automations/phantoms lists them.`, fields: { phantom: ['unknown phantom'] } });
  return p;
}

// ---- inputs ------------------------------------------------------------------------

export interface Target { url: string; row?: Record<string, unknown> }

/** Checks params against the phantom's field schema, applying defaults. Throws a 422 listing every problem. */
export function validateParams(ctx: Ctx, p: Phantom, input: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  const fields: Record<string, string[]> = {};
  const bad = (k: string, m: string) => (fields[k] ??= []).push(m);
  for (const f of p.fields) {
    let v = input[f.key];
    if (v === undefined || v === null || v === '') v = f.default;
    if (v === undefined || v === null || v === '') {
      if (f.required) bad(f.key, `${f.label} is required`);
      continue;
    }
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) { bad(f.key, 'must be a number'); break; }
        if (f.min != null && n < f.min) bad(f.key, `must be at least ${f.min}`);
        else if (f.max != null && n > f.max) bad(f.key, `must be at most ${f.max}`);
        out[f.key] = Math.round(n);
        break;
      }
      case 'boolean': out[f.key] = v === true || v === 'true' || v === 1 || v === '1'; break;
      case 'select':
        if (f.options && !f.options.some((o) => o.value === v)) bad(f.key, `must be one of ${f.options.map((o) => o.value).join(', ')}`);
        out[f.key] = v;
        break;
      case 'url':
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) bad(f.key, 'must be a full URL starting with https://');
        out[f.key] = String(v).trim();
        break;
      case 'template':
        if (typeof v !== 'string') { bad(f.key, 'must be text'); break; }
        if (AI_TOKEN.test(v) && !aiReady(ctx.gtm!.settings)) bad(f.key, '{ai_message} needs an AI model — set OPENROUTER_API_KEY (or AI_BASE_URL) on the Integrations page');
        if (f.max && v.replace(AI_TOKEN, 'x'.repeat(120)).length > f.max * 1.5) bad(f.key, `is too long (LinkedIn allows ${f.max} characters)`);
        out[f.key] = v;
        break;
      case 'targets': {
        const t = normalizeTargetsInput(v);
        if (!t) bad(f.key, 'give URLs (one per line) or {table_id, column}');
        else out[f.key] = t;
        break;
      }
      default: out[f.key] = typeof v === 'string' ? v.trim() : v;
    }
  }
  if (Object.keys(fields).length) throw new HttpError(422, { error: 'validation_error', message: Object.entries(fields).map(([k, m]) => `${k}: ${m.join(', ')}`).join('; '), fields });
  return out;
}

/** Targets are stored as {urls:[...]} or {table_id, column}. */
function normalizeTargetsInput(v: unknown): { urls?: string[]; table_id?: number; column?: string } | null {
  const split = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  if (typeof v === 'string') return split(v).length ? { urls: split(v) } : null;
  if (Array.isArray(v)) { const urls = v.map(String).flatMap(split); return urls.length ? { urls } : null; }
  if (v && typeof v === 'object') {
    const o = v as any;
    if (o.table_id && o.column) return { table_id: Number(o.table_id), column: String(o.column) };
    if (o.urls) return normalizeTargetsInput(o.urls);
  }
  return null;
}

/** The concrete target list for a run: URLs as given, or the column values of a table (with each row's other values). */
export function resolveTargets(ctx: Ctx, workspaceId: number, site: Site, spec: { urls?: string[]; table_id?: number; column?: string } | undefined): Target[] {
  if (!spec) return [];
  const out: Target[] = [];
  const seen = new Set<string>();
  const push = (url: string, row?: Record<string, unknown>) => {
    const u = url.trim();
    if (!u) return;
    const k = seenKey(site, u);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(row ? { url: u, row } : { url: u });
  };
  if (spec.urls) for (const u of spec.urls) push(u);
  if (spec.table_id) {
    const { store } = ctx.gtm!;
    store.tableIn(spec.table_id, workspaceId);
    const cols = store.columns(spec.table_id);
    if (!cols.some((c) => c.name === spec.column)) throw new HttpError(422, { error: 'validation_error', message: `Column "${spec.column}" not found in that table` });
    for (const rowId of store.rowIds(spec.table_id)) {
      const raw = store.rowValues(rowId, cols);
      const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, unwrap(v)]));
      const v = row[spec.column!];
      if (v != null && String(v).trim()) push(String(v), row);
    }
  }
  return out.slice(0, 10_000);
}

/** Dedupe identity of a value: canonical URL for links, lower-cased text otherwise. */
export function seenKey(site: Site, v: unknown): string {
  const s = String(unwrap(v) ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    try { return normalizeUrl(site, s).toLowerCase(); } catch { /* fall through */ }
  }
  return s.toLowerCase().replace(/\/+$/, '');
}

// ---- create / start / stop -----------------------------------------------------------

export interface CreateJobInput {
  phantom: string; name?: string; params?: Record<string, unknown>; table_id?: number; table_name?: string;
  column_map?: Record<string, string>; schedule?: { every?: Every | null }; watcher?: boolean;
  alerts?: Job['alerts']; start?: boolean;
}

export function createJob(ctx: Ctx, workspaceId: number, b: CreateJobInput, now: Date): Job {
  const p = phantomOf(b.phantom);
  const params = validateParams(ctx, p, b.params ?? {});
  const { store } = ctx.gtm!;
  const name = (b.name?.trim() || `${p.label} · ${now.toISOString().slice(0, 10)}`).slice(0, 120);
  const columnMap = { ...Object.fromEntries(p.outputs.map((o) => [o.key, o.label])), ...(b.column_map ?? {}) };
  let tableId = b.table_id ?? null;
  if (tableId) store.tableIn(tableId, workspaceId);
  else {
    tableId = store.createTable(workspaceId, (b.table_name?.trim() || name).slice(0, 80));
    const made = new Set<string>();
    for (const o of p.outputs) {
      const col = columnMap[o.key];
      if (col && !made.has(col)) { store.createColumn(tableId, { name: col, type: 'text' }); made.add(col); }
    }
  }
  const every = p.watchable ? b.schedule?.every ?? null : null;
  const iso = now.toISOString();
  const id = ctx.db.insert('companion_jobs', {
    workspace_id: workspaceId, phantom: p.id, name, params: JSON.stringify(params), status: 'draft', table_id: tableId,
    column_map: JSON.stringify(columnMap), dedupe_key: p.dedupeKey, schedule: JSON.stringify(every ? { every } : {}),
    watcher: every || b.watcher ? 1 : 0, alerts: JSON.stringify(b.alerts ?? {}), progress: '{}', created_at: iso, updated_at: iso,
  });
  const start = b.start ?? !p.sends;
  if (start) startRun(ctx, id, now);
  return loadJob(ctx, id);
}

export function updateJob(ctx: Ctx, job: Job, b: Partial<Pick<CreateJobInput, 'name' | 'params' | 'schedule' | 'watcher' | 'alerts' | 'column_map'>>, now: Date): Job {
  const p = phantomOf(job.phantom);
  const data: Record<string, unknown> = { updated_at: now.toISOString() };
  if (b.name) data.name = b.name.trim().slice(0, 120);
  if (b.params) {
    if (job.status === 'running') throw new HttpError(409, { error: 'conflict', message: 'Pause or cancel the automation before changing its inputs.' });
    data.params = JSON.stringify(validateParams(ctx, p, { ...job.params, ...b.params }));
  }
  if (b.schedule !== undefined) {
    const every = p.watchable ? b.schedule?.every ?? null : null;
    data.schedule = JSON.stringify(every ? { every } : {});
    data.watcher = every ? 1 : 0;
    data.next_run_at = every && ['completed', 'failed'].includes(job.status) ? nextRunAt(every, now).toISOString() : every ? job.next_run_at : null;
  }
  if (b.watcher !== undefined && b.schedule === undefined) data.watcher = b.watcher ? 1 : 0;
  if (b.alerts) data.alerts = JSON.stringify(b.alerts);
  if (b.column_map) data.column_map = JSON.stringify({ ...job.column_map, ...b.column_map });
  ctx.db.update('companion_jobs', job.id, data);
  return loadJob(ctx, job.id);
}

/** Next scheduled run, with ±10% jitter so watchers don't fire on the dot. */
export function nextRunAt(every: Every, from: Date, rand: () => number = Math.random): Date {
  const base = every === 'hourly' ? 3_600_000 : every === 'daily' ? 86_400_000 : 7 * 86_400_000;
  return new Date(from.getTime() + base * (0.9 + rand() * 0.2));
}

function activeRun(ctx: Ctx, jobId: number) {
  return ctx.db.get<{ id: number }>(`SELECT id FROM companion_runs WHERE job_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, [jobId]);
}

/** Starts a run: one task per target (or one paged task). Returns the run id. */
export function startRun(ctx: Ctx, jobId: number, now: Date): number {
  const job = loadJob(ctx, jobId);
  const existing = activeRun(ctx, jobId);
  if (existing) return existing.id;
  const p = phantomOf(job.phantom);
  const iso = now.toISOString();
  return ctx.db.tx(() => {
    const runId = ctx.db.insert('companion_runs', { job_id: jobId, workspace_id: job.workspace_id, status: 'running', started_at: iso });
    const { targets: spec, ...params } = job.params;
    const targets: (Target | null)[] = p.perTarget ? resolveTargets(ctx, job.workspace_id, p.site, spec) : [null];
    const action = p.id === 'linkedin.ai_post_responder' ? 'linkedin.scrape' : p.action;
    // Tasks are leased in id order, so targets run in list order.
    for (const t of targets) {
      ctx.db.insert('companion_tasks', {
        workspace_id: job.workspace_id, job_id: jobId, run_id: runId, kind: p.id, site: p.site, runner: p.runner, action,
        target: JSON.stringify(t ?? {}), params: JSON.stringify(params), status: 'pending', created_at: iso, updated_at: iso,
      });
    }
    ctx.db.update('companion_jobs', jobId, {
      status: 'running', last_run_at: iso, next_run_at: null, error: null, updated_at: iso,
      progress: JSON.stringify({ done: 0, total: targets.length, message: targets.length ? 'Waiting for the extension' : 'No targets' }),
    });
    if (!targets.length) finishRun(ctx, runId, now, 'No targets to process');
    return runId;
  });
}

export function pauseJob(ctx: Ctx, job: Job, now: Date): Job {
  if (!['running', 'queued'].includes(job.status)) throw new HttpError(409, { error: 'conflict', message: `A ${job.status} automation can't be paused.` });
  ctx.db.update('companion_jobs', job.id, { status: 'paused', updated_at: now.toISOString() });
  // Leased tasks finish their current step; nothing new is handed out.
  return loadJob(ctx, job.id);
}

export function resumeJob(ctx: Ctx, job: Job, now: Date): Job {
  if (job.status !== 'paused') throw new HttpError(409, { error: 'conflict', message: 'Only paused automations can be resumed.' });
  const run = activeRun(ctx, job.id);
  if (run) ctx.db.update('companion_jobs', job.id, { status: 'running', updated_at: now.toISOString() });
  else startRun(ctx, job.id, now);
  return loadJob(ctx, job.id);
}

export function cancelJob(ctx: Ctx, job: Job, now: Date): Job {
  const iso = now.toISOString();
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE companion_tasks SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('pending', 'leased')`, [iso, job.id]);
    ctx.db.run(`UPDATE companion_runs SET status = 'cancelled', finished_at = ? WHERE job_id = ? AND status = 'running'`, [iso, job.id]);
    ctx.db.update('companion_jobs', job.id, { status: 'cancelled', next_run_at: null, updated_at: iso });
  });
  return loadJob(ctx, job.id);
}

// ---- results -------------------------------------------------------------------------

export interface TaskRow {
  id: number; workspace_id: number; job_id: number | null; run_id: number | null; campaign_id: number | null; campaign_lead_id: number | null;
  kind: string; site: Site; runner: string; action: string | null; target: Rec; params: Rec; cursor: unknown; status: string; priority: number;
  attempts: number; not_before: string | null; device_id: number | null; lease_expires_at: string | null; results_count: number; result: Rec | null; error: string | null;
}

export function loadTask(ctx: Ctx, id: number): TaskRow | undefined {
  const t = ctx.db.get('SELECT * FROM companion_tasks WHERE id = ?', [id]);
  if (!t) return undefined;
  return { ...t, target: j(t.target), params: j(t.params), cursor: j(t.cursor, null), result: j(t.result, null) };
}

const cellValue = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : v);

/**
 * Writes a batch of records for a job task into its table. Records already delivered for this
 * job (watcher re-runs) or already in the table's dedupe column are skipped.
 */
export async function ingestJobRecords(ctx: Ctx, task: TaskRow, records: Rec[], now: Date): Promise<{ accepted: number; fresh: Rec[] }> {
  if (!task.job_id || !records.length) return { accepted: records.length, fresh: [] };
  const job = loadJob(ctx, task.job_id);
  const p = phantomOf(job.phantom);
  const { store, engine, bus } = ctx.gtm!;
  const iso = now.toISOString();
  const key = job.dedupe_key ?? p.dedupeKey;
  const tableId = job.table_id && ctx.db.get('SELECT 1 FROM gtm_tables WHERE id = ?', [job.table_id]) ? job.table_id : null;
  const dedupeCol = tableId ? store.columns(tableId).find((c) => c.name === job.column_map[key]) : undefined;

  const fresh: Rec[] = [];
  ctx.db.tx(() => {
    for (const rec of records) {
      if (key === 'engagerKey' && !rec.engagerKey) rec.engagerKey = [rec.postUrl, rec.profileUrl, rec.engagement].join('|');
      const raw = rec[key];
      // Composite keys (post|person|engagement) are normalised part by part.
      const k = raw == null || raw === '' ? `#${JSON.stringify(rec)}` : String(raw).split('|').map((part) => seenKey(task.site, part)).join('|');
      const isNew = ctx.db.run('INSERT OR IGNORE INTO companion_seen (job_id, key, first_seen_at) VALUES (?, ?, ?)', [job.id, k, iso]).changes > 0;
      if (!isNew) continue;
      if (dedupeCol && raw != null && ctx.db.get('SELECT 1 FROM gtm_cells WHERE column_id = ? AND value = ?', [dedupeCol.id, JSON.stringify(cellValue(raw))])) continue;
      fresh.push(rec);
    }
  });

  if (fresh.length && tableId) {
    const rows = fresh.map((rec) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        const col = job.column_map[k];
        if (col && v != null && v !== '') row[col] = cellValue(v);
      }
      return row;
    });
    const ids = store.addRows(tableId, rows);
    bus.publish({ type: 'rows', tableId });
    bus.publish({ type: 'columns', tableId });
    const auto = store.columns(tableId).filter((c) => c.auto_run && RUNNABLE.includes(c.type as ColumnType)).map((c) => c.id);
    if (auto.length && ids.length) engine.run(tableId, { columnIds: auto, rowIds: ids });
  }

  ctx.db.run('UPDATE companion_jobs SET results_count = results_count + ?, updated_at = ? WHERE id = ?', [fresh.length, iso, job.id]);
  if (task.run_id) {
    const run = ctx.db.get<{ sample: string | null }>('SELECT sample FROM companion_runs WHERE id = ?', [task.run_id]);
    const sample = [...j(run?.sample ?? null, []), ...fresh].slice(0, 50);
    ctx.db.run('UPDATE companion_runs SET results = results + ?, new_results = new_results + ?, sample = ? WHERE id = ?', [records.length, fresh.length, JSON.stringify(sample), task.run_id]);
  }

  if (p.id === 'linkedin.post_monitor') {
    for (const rec of fresh.slice(0, 200)) {
      emit(ctx, job.workspace_id, 'LINKEDIN_POST_ENGAGER', { automation: { id: job.id, name: job.name }, post_url: rec.postUrl ?? null, engager: rec, table_id: tableId });
    }
  }
  if (p.id === 'linkedin.ai_post_responder') await draftApprovals(ctx, job, fresh, now);
  return { accepted: records.length, fresh };
}

/** AI Post Responder: one approval per new post. Nothing is posted until a person approves it. */
async function draftApprovals(ctx: Ctx, job: Job, posts: Rec[], now: Date) {
  for (const post of posts) {
    if (!post.postUrl) continue;
    let draft = '';
    let context = String(post.text ?? '');
    try {
      draft = await draftComment(ctx.gtm!.settings, { text: context, authorName: String(post.authorName ?? '') }, String(job.params.instructions ?? ''));
    } catch (e: any) {
      context = `${context}\n\n(${e.message})`.trim();
    }
    ctx.db.insert('companion_approvals', {
      workspace_id: job.workspace_id, job_id: job.id, kind: 'linkedin.comment',
      target: JSON.stringify({ postUrl: post.postUrl, postUrn: post.postUrn ?? null, authorName: post.authorName ?? null, authorUrl: post.authorUrl ?? null }),
      context: context.slice(0, 5000), draft, status: 'pending', created_at: now.toISOString(),
    });
  }
}

// ---- run completion, schedule, alerts -----------------------------------------------

/** Updates job progress and closes the run once none of its tasks are pending or leased. */
export function refreshRun(ctx: Ctx, runId: number, now: Date) {
  const run = ctx.db.get('SELECT * FROM companion_runs WHERE id = ?', [runId]);
  if (!run || run.status !== 'running') return;
  const counts = taskCounts(ctx, `run_id = ?`, [runId]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const finished = counts.done + counts.failed + counts.skipped + counts.cancelled;
  const job = loadJob(ctx, run.job_id);
  ctx.db.update('companion_jobs', job.id, { progress: JSON.stringify({ ...job.progress, done: finished, total }), updated_at: now.toISOString() });
  if (counts.pending + counts.leased > 0) return;
  // Approved AI comments may still be waiting for a person; the run stays open until they're decided.
  const waiting = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM companion_approvals WHERE job_id = ? AND status = 'pending'`, [job.id])!.n;
  if (waiting && job.phantom === 'linkedin.ai_post_responder') {
    ctx.db.update('companion_jobs', job.id, { progress: JSON.stringify({ done: finished, total, message: `${waiting} comment${waiting === 1 ? '' : 's'} waiting for your approval` }) });
    return;
  }
  const allFailed = total > 0 && counts.failed === total;
  const err = allFailed ? ctx.db.get<{ error: string }>(`SELECT error FROM companion_tasks WHERE run_id = ? AND error IS NOT NULL ORDER BY id DESC LIMIT 1`, [runId])?.error ?? 'All tasks failed' : null;
  finishRun(ctx, runId, now, err);
}

export function finishRun(ctx: Ctx, runId: number, now: Date, error: string | null = null) {
  const run = ctx.db.get('SELECT * FROM companion_runs WHERE id = ?', [runId]);
  if (!run || run.status !== 'running') return;
  const job = loadJob(ctx, run.job_id);
  const iso = now.toISOString();
  const status = error ? 'failed' : 'completed';
  const actions = ctx.db.get<{ n: number }>(`SELECT COALESCE(SUM(a.count), 0) n FROM companion_actions a JOIN companion_tasks t ON t.id = a.task_id WHERE t.run_id = ?`, [runId])!.n;
  ctx.db.run('UPDATE companion_runs SET status = ?, error = ?, actions = ?, finished_at = ? WHERE id = ?', [status, error, actions, iso, runId]);
  const every = job.schedule.every;
  ctx.db.update('companion_jobs', job.id, {
    status: job.status === 'cancelled' ? 'cancelled' : status, error, updated_at: iso,
    next_run_at: every && job.status !== 'cancelled' ? nextRunAt(every, now).toISOString() : null,
    progress: JSON.stringify({ ...job.progress, message: error ?? `${run.new_results} new result${run.new_results === 1 ? '' : 's'}` }),
  });
  emit(ctx, job.workspace_id, 'COMPANION_JOB_COMPLETED', {
    automation: { id: job.id, name: job.name, phantom: job.phantom }, run: { id: runId, status, results: run.results, new_results: run.new_results, error },
    table_id: job.table_id,
  });
  if (run.new_results > 0 && (job.alerts.slack || job.alerts.webhook_url)) void sendAlerts(ctx, job, run.new_results, j(run.sample, []));
}

async function sendAlerts(ctx: Ctx, job: Job, count: number, sample: Rec[]) {
  const settings = ctx.gtm!.settings;
  const p = phantomOf(job.phantom);
  const label = (r: Rec) => String(r.fullName ?? r.name ?? r.username ?? r.title ?? r.authorName ?? r.login ?? r.postUrl ?? r.profileUrl ?? '').slice(0, 120);
  const link = (r: Rec) => String(r.profileUrl ?? r.postUrl ?? r.tweetUrl ?? r.githubUrl ?? r.permalink ?? '');
  const lines = sample.slice(0, 8).map((r) => `• ${label(r)}${link(r) ? ` — ${link(r)}` : ''}`);
  const text = `:robot_face: *${job.name}* (${p.label}) found ${count} new result${count === 1 ? '' : 's'}\n${lines.join('\n')}${count > lines.length ? `\n…and ${count - lines.length} more` : ''}\n${ctx.config.publicUrl}/tables/${job.table_id}`;
  try {
    if (job.alerts.slack) await slackPost(settings, { text, channel: job.alerts.slack_channel || undefined });
  } catch (e: any) { ctx.log.warn({ err: e.message, job: job.id }, 'automation slack alert failed'); }
  try {
    if (job.alerts.webhook_url) await callHttp({ url: job.alerts.webhook_url, method: 'POST', body: { automation: { id: job.id, name: job.name, phantom: job.phantom }, new_results: count, records: sample, table_url: `${ctx.config.publicUrl}/tables/${job.table_id}` } });
  } catch (e: any) { ctx.log.warn({ err: e.message, job: job.id }, 'automation webhook alert failed'); }
}

/** Starts scheduled watcher runs that are due. */
export function startDueJobs(ctx: Ctx, now: Date): number {
  const due = ctx.db.all<{ id: number }>(`SELECT id FROM companion_jobs WHERE next_run_at IS NOT NULL AND next_run_at <= ? AND status IN ('completed', 'failed')`, [now.toISOString()]);
  for (const d of due) startRun(ctx, d.id, now);
  return due.length;
}

// ---- JSON ------------------------------------------------------------------------------

export function taskCounts(ctx: Ctx, where: string, params: any[]) {
  const counts = { pending: 0, leased: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 } as Record<string, number>;
  for (const r of ctx.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM companion_tasks WHERE ${where} GROUP BY status`, params)) counts[r.status] = r.n;
  return counts as { pending: number; leased: number; done: number; failed: number; skipped: number; cancelled: number };
}

export function jobJson(ctx: Ctx, job: Job) {
  const p = findPhantom(job.phantom);
  const run = ctx.db.get<{ id: number }>('SELECT id FROM companion_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1', [job.id]);
  const table = job.table_id ? ctx.db.get<{ name: string }>('SELECT name FROM gtm_tables WHERE id = ?', [job.table_id]) : undefined;
  return {
    ...job,
    phantom_label: p?.label ?? job.phantom, network: p?.network ?? null, category: p?.category ?? null, runner: p?.runner ?? null,
    table_name: table?.name ?? null, table_id: table ? job.table_id : null,
    tasks: run ? taskCounts(ctx, 'run_id = ?', [run.id]) : taskCounts(ctx, '0', []),
  };
}

export function runJson(r: any) {
  return { id: r.id, status: r.status, results: r.results, new_results: r.new_results, actions: r.actions, error: r.error, started_at: r.started_at, finished_at: r.finished_at };
}
