import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Facebook, Github, Instagram, Linkedin, MessageCircle, Twitter } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { Badge, cx, type Tone } from '../../components/ui.tsx';

// ---- API shapes (see server/src/companion) -------------------------------------------

export type Network = 'linkedin' | 'sales_navigator' | 'instagram' | 'x' | 'facebook' | 'whatsapp' | 'reddit' | 'github';
export type Category = 'data' | 'action' | 'monitor';
export type FieldType = 'text' | 'textarea' | 'url' | 'number' | 'select' | 'boolean' | 'targets' | 'template';

export interface PhantomField {
  key: string; label: string; type: FieldType; required?: boolean; default?: unknown;
  options?: { value: string; label: string }[]; help?: string; placeholder?: string; min?: number; max?: number;
}
export interface Phantom {
  id: string; network: Network; site: string; category: Category; label: string; description: string;
  runner: 'extension' | 'server'; action: string | null; perTarget: boolean; fields: PhantomField[];
  outputs: { key: string; label: string }[]; dedupeKey: string; watchable: boolean; sends?: boolean;
  ready: boolean; needs_extension: boolean;
}
export type JobStatus = 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface Job {
  id: number; phantom: string; phantom_label: string; network: Network; category: Category; runner: 'extension' | 'server';
  name: string; params: Record<string, any>; status: JobStatus; table_id: number | null; table_name: string | null;
  column_map: Record<string, string>; dedupe_key: string | null; schedule: { every?: 'hourly' | 'daily' | 'weekly' };
  watcher: boolean; alerts: { slack?: boolean; slack_channel?: string; webhook_url?: string };
  progress: { done?: number; total?: number; message?: string }; results_count: number; error: string | null;
  next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string;
  tasks: { pending: number; leased: number; done: number; failed: number; skipped: number; cancelled: number };
}
export interface Run { id: number; status: string; results: number; new_results: number; actions: number; error: string | null; started_at: string; finished_at: string | null }
export interface LimitUse { action: string; label: string; daily: number; weekly: number | null; used_today: number; used_week: number }
export interface Device {
  id: number; name: string; version: string | null; online: boolean; paused: boolean; accounts: Record<string, boolean>;
  site_pauses: Record<string, string>; last_error: string | null; last_seen_at: string | null;
  current_task: { id: number; kind: string; job_name: string | null } | null; created_at: string;
}
export interface CompanionStatus {
  kinetic_url: string; extension: { available: boolean; version: string | null; download_url: string };
  devices: Device[]; online: boolean; paused: boolean;
}
export type DaysMap = Record<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday', boolean>;
export interface CompanionSettings {
  limits: Record<string, { daily: number; weekly: number | null }>;
  working_hours: { enabled: boolean; timezone: string; start: string; end: string; days: DaysMap };
  delays: { action_min_sec: number; action_max_sec: number; page_min_sec: number; page_max_sec: number };
  max_actions_per_hour: number; paused: boolean; scrape_outside_hours: boolean;
}

// ---- queries -------------------------------------------------------------------------

export function usePhantoms() {
  return useQuery({
    queryKey: ['automations', 'phantoms'],
    queryFn: () => api.get<{ data: Phantom[]; networks: { id: Network; label: string }[]; limits: Record<string, { label: string; daily: number; weekly?: number }> }>('/api/automations/phantoms'),
    staleTime: 60_000,
  });
}

export function useCompanionStatus() {
  return useQuery({
    queryKey: ['automations', 'status'],
    queryFn: () => api.get<{ data: CompanionStatus }>('/api/companion/status').then((r) => r.data),
    refetchInterval: 15_000,
  });
}

export function useTables() {
  return useQuery({ queryKey: ['gtm-tables'], queryFn: () => api.get<{ id: number; name: string; row_count: number }[]>('/api/gtm/tables') });
}

export function useTableColumns(tableId: number | null | undefined) {
  return useQuery({
    queryKey: ['automations', 'table-columns', tableId],
    enabled: !!tableId,
    queryFn: () => api.get<{ columns: { id: number; name: string; type: string }[] }>(`/api/gtm/tables/${tableId}`).then((r) => r.columns),
  });
}

// ---- presentation --------------------------------------------------------------------

export const NETWORK_LABEL: Record<Network, string> = {
  linkedin: 'LinkedIn', sales_navigator: 'Sales Navigator', instagram: 'Instagram', x: 'X / Twitter', facebook: 'Facebook', whatsapp: 'WhatsApp', reddit: 'Reddit', github: 'GitHub',
};

const NETWORK_STYLE: Record<Network, { bg: string; icon?: typeof Linkedin; mono?: string }> = {
  linkedin: { bg: 'bg-[#0a66c2]', icon: Linkedin },
  sales_navigator: { bg: 'bg-[#0b3b6f]', icon: Linkedin },
  instagram: { bg: 'bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af]', icon: Instagram },
  x: { bg: 'bg-zinc-900', icon: Twitter },
  facebook: { bg: 'bg-[#1877f2]', icon: Facebook },
  whatsapp: { bg: 'bg-[#25d366]', icon: MessageCircle },
  reddit: { bg: 'bg-[#ff4500]', mono: 'r/' },
  github: { bg: 'bg-zinc-800', icon: Github },
};

export function NetworkIcon({ network, size = 28 }: { network: Network; size?: number }) {
  const s = NETWORK_STYLE[network] ?? { bg: 'bg-zinc-400', mono: '?' };
  const Icon = s.icon;
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[7px] text-white', s.bg)} style={{ width: size, height: size }}>
      {Icon ? <Icon style={{ width: size * 0.55, height: size * 0.55 }} strokeWidth={2} /> : <span className="font-bold" style={{ fontSize: size * 0.42 }}>{s.mono}</span>}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  draft: 'gray', queued: 'blue', running: 'blue', paused: 'yellow', completed: 'green', failed: 'red', cancelled: 'gray', active: 'green',
  pending: 'gray', leased: 'blue', done: 'green', skipped: 'gray', approved: 'blue', rejected: 'gray', posted: 'green',
  visited: 'blue', invited: 'purple', accepted: 'green', messaged: 'blue', replied: 'green', not_accepted: 'yellow',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'gray'} dot={status === 'running' || status === 'active'}>{status.replace(/_/g, ' ')}</Badge>;
}

export const CATEGORY_LABEL: Record<Category, string> = { data: 'Data', action: 'Action', monitor: 'Monitor' };
export function CategoryChip({ category }: { category: Category }) {
  const tone: Tone = category === 'action' ? 'orange' : category === 'monitor' ? 'purple' : 'gray';
  return <Badge tone={tone}>{CATEGORY_LABEL[category]}</Badge>;
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[14px] font-semibold text-zinc-900">{children}</h2>
      {actions}
    </div>
  );
}

/** Thin labelled meter: used / limit. */
export function Meter({ label, used, limit, sub }: { label: string; used: number; limit: number | null; sub?: ReactNode }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-zinc-800';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="truncate text-zinc-600">{label}</span>
        <span className="shrink-0 tabular-nums text-zinc-900">{used.toLocaleString()}<span className="text-zinc-400"> / {limit == null ? '∞' : limit.toLocaleString()}</span></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className={cx('h-full rounded-full', color)} style={{ width: `${pct}%` }} /></div>
      {sub && <div className="mt-0.5 text-[11.5px] text-zinc-400">{sub}</div>}
    </div>
  );
}

export const splitLines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
