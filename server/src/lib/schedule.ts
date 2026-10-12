import { DateTime } from 'luxon';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type DaysMap = Record<Weekday, boolean>;

export interface SendSchedule {
  days: DaysMap;
  start_time: string; // HH:mm local
  end_time: string;   // HH:mm local
  timezone: string;   // IANA
}

export interface Window {
  start: Date;
  end: Date;
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

function parseHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** The sending window on the local calendar day containing `at`, or null if that day is off. */
export function windowOnDay(s: SendSchedule, at: Date): Window | null {
  const local = DateTime.fromJSDate(at).setZone(s.timezone);
  const day = WEEKDAYS[local.weekday - 1]!;
  if (!s.days[day]) return null;
  const start = local.set({ ...parseHm(s.start_time), second: 0, millisecond: 0 });
  let end = local.set({ ...parseHm(s.end_time), second: 0, millisecond: 0 });
  if (end <= start) end = end.plus({ days: 1 }); // overnight windows, e.g. 22:00-02:00
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** The window that is open at `at`, or null. */
export function openWindow(s: SendSchedule, at: Date): Window | null {
  for (const offset of [0, -1]) {
    const day = new Date(at.getTime() + offset * 86_400_000);
    const w = windowOnDay(s, day);
    if (w && at >= w.start && at < w.end) return w;
  }
  return null;
}

/** The current open window, or the next one that starts after `at` (searches two weeks ahead). */
export function nextWindow(s: SendSchedule, at: Date): Window | null {
  const open = openWindow(s, at);
  if (open) return open;
  for (let i = 0; i < 15; i++) {
    const day = DateTime.fromJSDate(at).setZone(s.timezone).plus({ days: i }).toJSDate();
    const w = windowOnDay(s, day);
    if (w && w.start > at) return w;
  }
  return null;
}

/** Start of the local day (in the schedule's timezone) containing `at`, as UTC. */
export function localDayStart(tz: string, at: Date): Date {
  return DateTime.fromJSDate(at).setZone(tz).startOf('day').toJSDate();
}

export function timezones(): string[] {
  return Intl.supportedValuesOf('timeZone');
}
