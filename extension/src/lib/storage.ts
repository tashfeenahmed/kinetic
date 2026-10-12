/** Typed wrappers over chrome.storage. Pairing lives in `local`; the running task in `session`. */
import type { Site } from '../../../server/src/companion/protocol.ts';

export interface LimitRow { action: string; label: string; daily: number; weekly: number | null; used_today: number; used_week: number }

export interface Pairing {
  serverUrl: string;
  token: string;
  deviceId?: number;
  workspaceName?: string;
}

export interface HeartbeatState {
  at: string;
  pausedAll: boolean;
  devicePaused: boolean;
  sitePauses: Partial<Record<Site, string>>;
  limits: LimitRow[];
  error?: string;
}

export interface CurrentTask { id: number; kind: string; site: Site; tabId: number; startedAt: number; label?: string; message?: string; done?: number; total?: number }

export interface LocalState {
  pairing?: Pairing;
  /** Paused from the popup (this browser only). */
  paused?: boolean;
  /** Safety stops this browser hit: site → paused until (ISO). */
  sitePauses?: Partial<Record<Site, string>>;
  heartbeat?: HeartbeatState;
  /** Sites this browser is (as far as we know) logged in to; reported in heartbeats. */
  accounts?: Partial<Record<Site, boolean>>;
  /** Tab used per site, so we reuse it instead of opening new ones. */
  tabs?: Partial<Record<Site, number>>;
  /** Timestamps (ms) of actions performed, for the rolling hourly cap. */
  actionLog?: number[];
  lastTask?: { id: number; kind: string; status: string; at: string; error?: string };
}

export async function getLocal(): Promise<LocalState> {
  return (await chrome.storage.local.get(null)) as LocalState;
}

export async function setLocal(patch: Partial<LocalState>): Promise<void> {
  await chrome.storage.local.set(patch as Record<string, unknown>);
}

export async function clearPairing(): Promise<void> {
  await chrome.storage.local.remove(['pairing', 'heartbeat']);
}

export async function getCurrent(): Promise<CurrentTask | null> {
  const s = await chrome.storage.session.get('current');
  return (s.current as CurrentTask | undefined) ?? null;
}

export async function setCurrent(t: CurrentTask | null): Promise<void> {
  if (t) await chrome.storage.session.set({ current: t });
  else await chrome.storage.session.remove('current');
}

/** Sites paused locally (safety stops) or by the server, still in the future. */
export function activeSitePauses(s: LocalState, now = Date.now()): Site[] {
  const merged = { ...(s.heartbeat?.sitePauses ?? {}), ...(s.sitePauses ?? {}) } as Record<string, string>;
  return Object.entries(merged).filter(([, until]) => until && Date.parse(until) > now).map(([site]) => site as Site);
}
