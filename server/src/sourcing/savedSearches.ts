/**
 * Saved searches ("watchers"): a source + params, a target table and an optional
 * schedule. Each run adds only rows it has never delivered before (dedupe keys are
 * kept per search), skips excluded rows, records history and can alert on new rows.
 */
import type { Ctx as AppCtx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { callHttp, slackPost } from '../gtm/providers/integrations.ts';
import { filterExcluded } from './exclusions.ts';
import { dedupeKey } from './normalize.ts';
import { insertRows, runSource, SOURCES, type SourceId } from './sources.ts';

export type Schedule = 'off' | 'hourly' | 'daily' | 'weekly';
export const SCHEDULES: Schedule[] = ['off', 'hourly', 'daily', 'weekly'];
const EVERY: Record<Exclude<Schedule, 'off'>, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000 };

export interface Alert { kind?: 'slack' | 'webhook'; channel?: string; webhookUrl?: string; url?: string }

export interface SavedSearch {
  id: number; workspace_id: number; name: string; source: SourceId; params: Record<string, any>; max_results: number;
  table_id: number | null; schedule: Schedule; apply_exclusions: boolean; alert: Alert;
  last_run_at: string | null; next_run_at: string | null; created_at: string; updated_at: string;
}

export interface Run {
  id: number; search_id: number; trigger: string; status: 'running' | 'done' | 'error';
  started_at: string; finished_at: string | null; found: number; new_count: number; excluded: number; error: string | null;
}

const fromRow = (r: any): SavedSearch => ({ ...r, params: JSON.parse(r.params || '{}'), alert: JSON.parse(r.alert || '{}'), apply_exclusions: !!r.apply_exclusions });

export function nextRunAt(schedule: Schedule, from: Date): string | null {
  return schedule === 'off' ? null : new Date(from.getTime() + EVERY[schedule]).toISOString();
}

export function searchIn(app: AppCtx, id: number, workspaceId: number): SavedSearch {
  const r = app.db.get('SELECT * FROM saved_searches WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!r) throw Object.assign(new Error('Saved search not found'), { statusCode: 404 });
  return fromRow(r);
}

export function listSearches(app: AppCtx, workspaceId: number) {
  const rows = app.db.all(`SELECT s.*, t.name AS table_name,
      (SELECT COUNT(*) FROM saved_search_seen x WHERE x.search_id = s.id) AS seen_count
    FROM saved_searches s LEFT JOIN gtm_tables t ON t.id = s.table_id WHERE s.workspace_id = ? ORDER BY s.updated_at DESC`, [workspaceId]);
  const last = app.db.all<Run>(`SELECT r.* FROM saved_search_runs r JOIN saved_searches s ON s.id = r.search_id
    WHERE s.workspace_id = ? AND r.id IN (SELECT MAX(id) FROM saved_search_runs GROUP BY search_id)`, [workspaceId]);
  return rows.map((r) => ({ ...fromRow(r), table_name: r.table_name ?? null, seen_count: r.seen_count, source_label: SOURCES[r.source as SourceId]?.label ?? r.source, last_run: last.find((x) => x.search_id === r.id) ?? null }));
}

export function createSearch(app: AppCtx, workspaceId: number, b: { name: string; source: SourceId; params: Record<string, unknown>; max_results: number; table_id?: number | null; schedule: Schedule; apply_exclusions: boolean; alert: Alert }): number {
  if (b.table_id) app.gtm!.store.tableIn(b.table_id, workspaceId);
  const now = nowIso();
  return app.db.insert('saved_searches', {
    workspace_id: workspaceId, name: b.name, source: b.source, params: JSON.stringify(b.params), max_results: b.max_results,
    table_id: b.table_id ?? null, schedule: b.schedule, apply_exclusions: b.apply_exclusions ? 1 : 0, alert: JSON.stringify(b.alert ?? {}),
    next_run_at: nextRunAt(b.schedule, app.now()), created_at: now, updated_at: now,
  });
}

export function updateSearch(app: AppCtx, s: SavedSearch, patch: Partial<{ name: string; params: Record<string, unknown>; max_results: number; table_id: number | null; schedule: Schedule; apply_exclusions: boolean; alert: Alert }>) {
  if (patch.table_id) app.gtm!.store.tableIn(patch.table_id, s.workspace_id);
  const data: Record<string, unknown> = { updated_at: nowIso() };
  if (patch.name != null) data.name = patch.name;
  if (patch.params) data.params = JSON.stringify(patch.params);
  if (patch.max_results != null) data.max_results = patch.max_results;
  if (patch.table_id !== undefined) data.table_id = patch.table_id;
  if (patch.apply_exclusions !== undefined) data.apply_exclusions = patch.apply_exclusions ? 1 : 0;
  if (patch.alert) data.alert = JSON.stringify(patch.alert);
  if (patch.schedule && patch.schedule !== s.schedule) {
    data.schedule = patch.schedule;
    data.next_run_at = nextRunAt(patch.schedule, app.now());
  }
  app.db.update('saved_searches', s.id, data);
}

export function runs(app: AppCtx, searchId: number, limit = 50): Run[] {
  return app.db.all<Run>('SELECT * FROM saved_search_runs WHERE search_id = ? ORDER BY id DESC LIMIT ?', [searchId, limit]);
}

/** Which of these keys this search already delivered. */
function seenKeys(app: AppCtx, searchId: number, keys: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const r of app.db.all<{ key: string }>(`SELECT key FROM saved_search_seen WHERE search_id = ? AND key IN (${chunk.map(() => '?').join(',')})`, [searchId, ...chunk])) out.add(r.key);
  }
  return out;
}

const inFlight = new Set<number>();

export interface RunResult extends Run { table_id: number | null; source_label?: string; new_rows?: Record<string, unknown>[] }

/** Run once: search, drop excluded and already-seen rows, append the rest to the target table. */
export async function runSavedSearch(app: AppCtx, searchId: number, trigger: 'manual' | 'schedule' | 'api' = 'manual'): Promise<RunResult> {
  const row = app.db.get('SELECT * FROM saved_searches WHERE id = ?', [searchId]);
  if (!row) throw Object.assign(new Error('Saved search not found'), { statusCode: 404 });
  const s = fromRow(row);
  if (inFlight.has(s.id)) throw Object.assign(new Error('This search is already running'), { statusCode: 409 });
  inFlight.add(s.id);
  const started = app.now();
  const runId = app.db.insert('saved_search_runs', { search_id: s.id, trigger, status: 'running', started_at: started.toISOString() });
  // Advance the schedule first so a failing search doesn't retry every tick.
  app.db.update('saved_searches', s.id, { last_run_at: started.toISOString(), next_run_at: nextRunAt(s.schedule, started) });
  const { store } = app.gtm!;
  try {
    const result = await runSource(app, s.workspace_id, s.source, s.params, s.max_results, (m) => store.log('info', 'saved-search', `${s.name}: ${m}`));
    const found = result.records.length;
    const filtered = s.apply_exclusions ? filterExcluded(app.db, s.workspace_id, result.records) : { kept: result.records, excluded: 0 };
    const shape = SOURCES[s.source]?.shape ?? 'company';
    // Dedupe within this run, then against everything delivered before.
    const byKey = new Map<string, Record<string, unknown>>();
    for (const r of filtered.kept) { const k = dedupeKey(r, shape); if (!byKey.has(k)) byKey.set(k, r); }
    const seen = seenKeys(app, s.id, [...byKey.keys()]);
    const fresh = [...byKey.entries()].filter(([k]) => !seen.has(k));

    let tableId = s.table_id && app.db.get('SELECT 1 FROM gtm_tables WHERE id = ? AND workspace_id = ?', [s.table_id, s.workspace_id]) ? s.table_id : null;
    if (fresh.length) {
      if (!tableId) {
        tableId = store.createTable(s.workspace_id, s.name.slice(0, 60));
        app.db.update('saved_searches', s.id, { table_id: tableId });
      }
      insertRows(app, tableId, fresh.map(([, r]) => r));
      const now = nowIso();
      app.db.tx(() => { for (const [k] of fresh) app.db.run('INSERT OR IGNORE INTO saved_search_seen (search_id, key, first_seen_at) VALUES (?, ?, ?)', [s.id, k, now]); });
      store.log('info', 'saved-search', `${s.name}: ${fresh.length} new of ${found} found (${filtered.excluded} excluded)`, { tableId });
    }
    app.db.update('saved_search_runs', runId, { status: 'done', finished_at: nowIso(), found, new_count: fresh.length, excluded: filtered.excluded });
    if (fresh.length && s.alert?.kind) await sendAlert(app, s, tableId!, fresh.map(([, r]) => r)).catch((e) => store.log('error', 'saved-search', `${s.name}: alert failed: ${e.message}`, { tableId: tableId! }));
    const run = app.db.get<Run>('SELECT * FROM saved_search_runs WHERE id = ?', [runId])!;
    return { ...run, table_id: tableId, source_label: result.label, new_rows: fresh.slice(0, 20).map(([, r]) => r) };
  } catch (e: any) {
    app.db.update('saved_search_runs', runId, { status: 'error', finished_at: nowIso(), error: String(e.message ?? e).slice(0, 1000) });
    const run = app.db.get<Run>('SELECT * FROM saved_search_runs WHERE id = ?', [runId])!;
    return { ...run, table_id: s.table_id };
  } finally {
    inFlight.delete(s.id);
  }
}

async function sendAlert(app: AppCtx, s: SavedSearch, tableId: number, rows: Record<string, unknown>[]) {
  const url = `${app.config.publicUrl}/tables/${tableId}`;
  const label = (r: Record<string, unknown>) => String(r.Company ?? r['Full name'] ?? r.Name ?? r['Job title'] ?? Object.values(r)[0] ?? '');
  const names = rows.slice(0, 8).map((r) => `• ${label(r)}${r.City ? ` (${r.City})` : r['Company domain'] ? ` (${r['Company domain']})` : ''}`).join('\n');
  const text = `:mag: *${s.name}*: ${rows.length} new result${rows.length === 1 ? '' : 's'}\n${names}${rows.length > 8 ? `\n…and ${rows.length - 8} more` : ''}\n<${url}|Open table>`;
  const settings = app.gtm!.settings;
  if (s.alert.kind === 'slack') await slackPost(settings, { text, channel: s.alert.channel || undefined, webhookUrl: s.alert.webhookUrl || undefined });
  else if (s.alert.kind === 'webhook' && (s.alert.url || s.alert.webhookUrl)) {
    await callHttp({ url: (s.alert.url || s.alert.webhookUrl)!, method: 'POST', body: { event: 'saved_search.new_results', search: { id: s.id, name: s.name, source: s.source }, table: { id: tableId, url }, count: rows.length, rows: rows.slice(0, 100) } });
  }
}

/** Worker job: run every scheduled search whose time has come. */
export async function runDueSearches(app: AppCtx) {
  if (!app.gtm) return;
  const due = app.db.all<{ id: number }>(`SELECT id FROM saved_searches WHERE schedule != 'off' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at LIMIT 5`, [app.now().toISOString()]);
  for (const d of due) await runSavedSearch(app, d.id, 'schedule').catch(() => {});
}
