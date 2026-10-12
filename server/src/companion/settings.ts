/**
 * Per-workspace Companion settings: daily/weekly limits per action bucket, working hours,
 * pacing delays and the global pause switch. Usage is counted from companion_actions.
 */
import type { Db } from '../db/db.ts';
import { localDayStart, nextWindow, openWindow, isValidTimezone, type DaysMap } from '../lib/schedule.ts';
import { DEFAULT_LIMITS } from './catalog.ts';
import type { Pacing } from './protocol.ts';

export interface CompanionSettings {
  limits: Record<string, { daily: number; weekly: number | null }>;
  working_hours: { enabled: boolean; timezone: string; start: string; end: string; days: DaysMap };
  delays: { action_min_sec: number; action_max_sec: number; page_min_sec: number; page_max_sec: number };
  max_actions_per_hour: number;
  paused: boolean;
  /** Reading data (scrapes, inbox checks) may run outside working hours; actions never do. */
  scrape_outside_hours: boolean;
}

const WEEKDAYS: DaysMap = { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false };

export function defaultSettings(): CompanionSettings {
  return {
    limits: Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, { daily: v.daily, weekly: v.weekly ?? null }])),
    working_hours: { enabled: true, timezone: 'UTC', start: '08:30', end: '18:30', days: { ...WEEKDAYS } },
    delays: { action_min_sec: 45, action_max_sec: 180, page_min_sec: 3, page_max_sec: 9 },
    max_actions_per_hour: 25,
    paused: false,
    scrape_outside_hours: false,
  };
}

export function loadSettings(db: Db, workspaceId: number): CompanionSettings {
  const row = db.get<{ data: string }>('SELECT data FROM companion_settings WHERE workspace_id = ?', [workspaceId]);
  const saved = row ? JSON.parse(row.data) : {};
  const d = defaultSettings();
  return {
    ...d,
    ...saved,
    limits: { ...d.limits, ...(saved.limits ?? {}) },
    working_hours: { ...d.working_hours, ...(saved.working_hours ?? {}), days: { ...d.working_hours.days, ...(saved.working_hours?.days ?? {}) } },
    delays: { ...d.delays, ...(saved.delays ?? {}) },
  };
}

export function saveSettings(db: Db, workspaceId: number, patch: Partial<CompanionSettings>): CompanionSettings {
  const cur = loadSettings(db, workspaceId);
  const next: CompanionSettings = {
    ...cur,
    ...patch,
    limits: { ...cur.limits, ...(patch.limits ?? {}) },
    working_hours: { ...cur.working_hours, ...(patch.working_hours ?? {}), days: { ...cur.working_hours.days, ...(patch.working_hours?.days ?? {}) } },
    delays: { ...cur.delays, ...(patch.delays ?? {}) },
  };
  if (!isValidTimezone(next.working_hours.timezone)) next.working_hours.timezone = 'UTC';
  if (next.delays.action_max_sec < next.delays.action_min_sec) next.delays.action_max_sec = next.delays.action_min_sec;
  if (next.delays.page_max_sec < next.delays.page_min_sec) next.delays.page_max_sec = next.delays.page_min_sec;
  db.run(`INSERT INTO companion_settings (workspace_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [workspaceId, JSON.stringify(next), new Date().toISOString()]);
  return next;
}

/** Working-hours schedule in the shape lib/schedule.ts understands. */
function schedule(s: CompanionSettings) {
  return { days: s.working_hours.days, start_time: s.working_hours.start, end_time: s.working_hours.end, timezone: s.working_hours.timezone };
}

export function inWorkingHours(s: CompanionSettings, now: Date): boolean {
  if (!s.working_hours.enabled) return true;
  return !!openWindow(schedule(s), now);
}

/** When working hours next open (now if open). */
export function nextWorkingStart(s: CompanionSettings, now: Date): Date | null {
  if (!s.working_hours.enabled) return now;
  return nextWindow(schedule(s), now)?.start ?? null;
}

/** Start of "today" for daily limits, in the working-hours timezone (limits reset at local midnight). */
export function dayStart(s: CompanionSettings, now: Date): Date {
  return localDayStart(s.working_hours.timezone, now);
}

export function nextDayStart(s: CompanionSettings, now: Date): Date {
  return localDayStart(s.working_hours.timezone, new Date(dayStart(s, now).getTime() + 36 * 3_600_000));
}

export interface Usage { action: string; label: string; daily: number; weekly: number | null; used_today: number; used_week: number; remaining: number }

/** Daily count resets at local midnight; weekly is a rolling 7 days (as LinkedIn counts invites). */
export function usage(db: Db, workspaceId: number, s: CompanionSettings, action: string, now: Date): Usage {
  const lim = s.limits[action] ?? { daily: Number.MAX_SAFE_INTEGER, weekly: null };
  const sum = (since: Date) => db.get<{ n: number }>('SELECT COALESCE(SUM(count), 0) n FROM companion_actions WHERE workspace_id = ? AND action = ? AND at >= ?',
    [workspaceId, action, since.toISOString()])!.n;
  const usedToday = sum(dayStart(s, now));
  const usedWeek = sum(new Date(now.getTime() - 7 * 86_400_000));
  const remaining = Math.max(0, Math.min(lim.daily - usedToday, lim.weekly == null ? Number.MAX_SAFE_INTEGER : lim.weekly - usedWeek));
  return { action, label: DEFAULT_LIMITS[action]?.label ?? action, daily: lim.daily, weekly: lim.weekly, used_today: usedToday, used_week: usedWeek, remaining };
}

export function allUsage(db: Db, workspaceId: number, s: CompanionSettings, now: Date): Usage[] {
  return Object.keys(s.limits).map((a) => usage(db, workspaceId, s, a, now));
}

/** Scrape buckets count records read; every other bucket is an action someone can notice. */
export const isScrapeBucket = (action: string | null) => !action || action.endsWith('.scrape');

/** Actions (not scrapes) in the last rolling hour, for the max-actions-per-hour cap. */
export function actionsLastHour(db: Db, workspaceId: number, now: Date): number {
  return db.get<{ n: number }>(`SELECT COALESCE(SUM(count), 0) n FROM companion_actions WHERE workspace_id = ? AND action NOT LIKE '%.scrape' AND at >= ?`,
    [workspaceId, new Date(now.getTime() - 3_600_000).toISOString()])!.n;
}

export function recordAction(db: Db, a: { workspaceId: number; action: string; count: number; deviceId?: number | null; taskId?: number | null; jobId?: number | null; at: Date }) {
  if (a.count <= 0) return;
  db.insert('companion_actions', { workspace_id: a.workspaceId, action: a.action, count: a.count, device_id: a.deviceId ?? null, task_id: a.taskId ?? null, job_id: a.jobId ?? null, at: a.at.toISOString() });
}

export function pacing(s: CompanionSettings): Pacing {
  return {
    actionDelayMs: [s.delays.action_min_sec * 1000, s.delays.action_max_sec * 1000],
    pageDelayMs: [s.delays.page_min_sec * 1000, s.delays.page_max_sec * 1000],
    maxActionsPerHour: s.max_actions_per_hour,
  };
}

/** A random delay in [min, max] seconds — slightly skewed toward the middle like a person. */
export function randomDelaySec(min: number, max: number, rand: () => number = Math.random): number {
  if (max <= min) return min;
  const u = (rand() + rand()) / 2;
  return Math.round(min + u * (max - min));
}
