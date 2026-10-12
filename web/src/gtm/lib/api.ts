export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('kinetic:unauthorized'));
    throw new Error(data?.message ?? data?.error ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export type ColumnType = 'text' | 'formula' | 'extract' | 'enrich' | 'ai' | 'http' | 'signal' | 'action' | 'lookup' | 'function';

export interface Column {
  id: number; table_id: number; name: string; type: ColumnType; config: any;
  position: number; width: number | null; auto_run: boolean; run_if: string | null;
}
export interface CellView { value: any; status: string; error: string | null; changed_at: string | null; provider?: string }
export interface RowView { id: number; cells: Record<number, CellView> }
export interface TableView {
  table: { id: number; name: string; webhookUrl: string; schedule: any };
  columns: Column[];
  rows: RowView[];
  queue: { pending: number; running: number };
}

export interface Catalog {
  enrich: { id: string; label: string; description: string; inputs: string[]; needs: string[][]; steps: { id: string; label: string; cost: string; requires: string[]; ready: boolean }[] }[];
  /** `missing` lists connections (Integrations page) the item needs before it can be added. */
  signals: { id: string; label: string; description: string; inputs: string[]; requires: string[]; missing?: string[] }[];
  actions: { id: string; label: string; ready: boolean; missing?: string[] }[];
  models: { id: string; label: string; free?: boolean }[];
  defaultModel: string;
  aiReady: boolean;
}

/** Headline value for display/export. */
export function headline(v: any): any {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

export function display(v: any): string {
  const h = headline(v);
  if (h == null) return '';
  if (Array.isArray(h)) return h.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof h === 'object') return Object.entries(h).filter(([, x]) => x != null).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · ');
  return String(h);
}

export const TYPE_META: Record<ColumnType, { icon: string; label: string; hint: string }> = {
  text: { icon: 'type', label: 'Text', hint: 'Input data you type, paste or import' },
  formula: { icon: 'fn', label: 'Formula', hint: 'JavaScript over the row' },
  extract: { icon: 'extract', label: 'Extract field', hint: 'Pull one field out of a result' },
  enrich: { icon: 'database', label: 'Enrichment', hint: 'Waterfall across data providers' },
  ai: { icon: 'brain', label: 'AI research', hint: 'Agent with web search' },
  http: { icon: 'code', label: 'HTTP API', hint: 'Call any API' },
  signal: { icon: 'radar', label: 'Signal', hint: 'Hiring, news, funding, tech…' },
  action: { icon: 'send', label: 'Action', hint: 'Slack, webhook, HubSpot, Salesforce' },
  lookup: { icon: 'lookup', label: 'Lookup', hint: 'Find matching rows in another table' },
  function: { icon: 'blocks', label: 'Function', hint: 'A saved, reusable enrichment recipe' },
};

export type MatchMode = 'exact' | 'case_insensitive' | 'domain' | 'email' | 'company';
export const MATCH_MODES: { id: MatchMode; label: string }[] = [
  { id: 'exact', label: 'Exact' },
  { id: 'case_insensitive', label: 'Case-insensitive' },
  { id: 'domain', label: 'Domain (URLs, emails → domain)' },
  { id: 'email', label: 'Email (ignores case, +tags)' },
  { id: 'company', label: 'Company name (ignores Inc, LLC, GmbH…)' },
];

export type StepType = 'formula' | 'extract' | 'enrich' | 'ai' | 'http' | 'lookup';
export const STEP_TYPES: StepType[] = ['enrich', 'ai', 'http', 'formula', 'extract', 'lookup'];
export interface FnStep { name: string; type: StepType; config: any; run_if?: string | null }
export interface FnDefinition {
  inputs: { name: string; description?: string; required?: boolean }[];
  steps: FnStep[];
  outputs: { name: string; value: string; description?: string }[];
}
export interface FnUsage { column_id: number; column: string; table_id: number; table: string; version: number | null }
export interface FnStats {
  days: number; rowsProcessed: number; errorRate: number; emptyRate: number; avgMs: number;
  fillRate: Record<string, number>; byVersion: Record<number, number>; lastRunAt: string | null; tables: FnUsage[];
}
export interface FnRec {
  id: number; name: string; description: string; tags: string[]; version: number; definition: FnDefinition;
  created_at: string; updated_at: string; usage: { columns: number; tables: number; outdated: number };
}
export interface FnDetail extends FnRec { versions: { version: number; created_at: string }[]; columns: FnUsage[]; stats: FnStats }
export interface FnTestResult {
  rowId?: number; inputs: Record<string, unknown>; outputs: Record<string, unknown>; status: string; ms: number; error?: string;
  steps: { name: string; type: string; status: string; ms: number; error?: string; value?: unknown; provider?: unknown }[];
}
