/**
 * What a table run would cost, before anything is queued: cells per column, AI tasks,
 * and per paid vendor the worst case (every free step misses, so each waterfall reaches
 * that vendor) against what's left of its monthly credit budget. Shared by the
 * run-estimate route, the agent's approval policy and the table's run confirmation.
 */
import type { Settings } from '../settings.ts';
import { ENRICH_KINDS } from '../providers/catalog.ts';
import { budgetBlock, budgets, planBlock, PROVIDER_INFO, STEP_PROVIDER, usedThisMonth } from '../providers/credits.ts';
import type { Store } from './store.ts';
import { selectCells, type RunSelection } from './runner.ts';

export interface VendorEstimate {
  id: string; label: string;
  /** Price per call as the catalog shows it, e.g. "1 credit" or "~$0.01 when found". */
  cost: string;
  /** Worst-case calls (one per cell that reaches this vendor). */
  calls: number;
  /** Worst-case credits, when the vendor is priced in credits. */
  credits: number | null;
  /** Monthly credit budget (Integrations → Credits), for metered vendors. */
  budget?: number; used?: number; remaining?: number;
  /** The worst case is more than what's left: the waterfall skips this vendor once it runs out. */
  exceeds?: boolean;
}

export interface ColumnEstimate {
  id: number; name: string; type: string; kind?: string;
  cells: number;
  /** One AI task per cell (AI columns, and enrichments that read pages with AI). */
  aiCalls: number;
  vendors: { id: string; label: string; cost: string; calls: number; credits: number | null }[];
}

export interface RunEstimate {
  cells: number;
  aiCalls: number;
  /** Most cells in any one column that can reach a paid vendor (≈ rows that may spend). */
  paidCells: number;
  columns: ColumnEstimate[];
  vendors: VendorEstimate[];
  /** One plain-language paragraph for confirmations and the agent's approval message. */
  summary: string;
}

/** Credits per call from a catalog cost label ("1 credit", "0.5 credit", "1–2 credits"); 0 when free; null when priced in money. */
export function creditsPerCall(cost: string): number | null {
  if (/^free/i.test(cost.trim())) return 0;
  const m = cost.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s+(?:person |company )?credits?\b/i);
  return m ? Number(m[2] ?? m[1]) : null;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function estimateRun(store: Store, settings: Settings, tableId: number, opts: RunSelection = {}): RunEstimate {
  const own = new Set(store.rowIds(tableId));
  const selection = selectCells(store, tableId, { ...opts, rowIds: opts.rowIds?.filter((id) => own.has(id)) });
  const columns: ColumnEstimate[] = [];
  const vendors = new Map<string, VendorEstimate>();
  for (const { col, rowIds } of selection) {
    const cells = rowIds.length;
    const est: ColumnEstimate = { id: col.id, name: col.name, type: col.type, cells, aiCalls: col.type === 'ai' ? cells : 0, vendors: [] };
    if (col.type === 'enrich') {
      const kind = ENRICH_KINDS.find((k) => k.id === col.config?.kind);
      est.kind = kind?.id;
      const order: string[] = col.config?.providers?.length ? col.config.providers : kind?.steps.map((s) => s.id) ?? [];
      for (const id of order) {
        const step = kind?.steps.find((s) => s.id === id);
        if (!step || !cells) continue;
        if (/\bAI\b/.test(step.cost)) est.aiCalls = cells;
        // Steps without their key, or blocked on the vendor's plan, are skipped by the runner.
        if (!step.requires.length || !step.requires.every((k) => settings.has(k))) continue;
        const credits = creditsPerCall(step.cost);
        if (credits === 0) continue;
        const metered = STEP_PROVIDER[id];
        if (metered && planBlock(settings, `${kind!.id}:${id}`, metered)) continue;
        const vendorId = metered ?? id;
        const label = metered ? PROVIDER_INFO[metered].label : step.label;
        est.vendors.push({ id: vendorId, label, cost: step.cost, calls: cells, credits: credits == null ? null : round(credits * cells) });
        const v = vendors.get(vendorId) ?? { id: vendorId, label, cost: step.cost, calls: 0, credits: credits == null ? null : 0 };
        v.calls += cells;
        if (v.credits != null && credits != null) v.credits = round(v.credits + credits * cells);
        vendors.set(vendorId, v);
      }
    }
    columns.push(est);
  }
  const limits = budgets(settings.db);
  for (const v of vendors.values()) {
    const p = STEP_PROVIDER[v.id];
    if (!p) continue;
    v.budget = limits[p];
    v.used = round(usedThisMonth(settings.db, p).credits);
    v.remaining = budgetBlock(settings.db, p) ? 0 : round(Math.max(0, v.budget - v.used));
    v.exceeds = (v.credits ?? 0) > v.remaining;
  }
  const out = {
    cells: columns.reduce((n, c) => n + c.cells, 0),
    aiCalls: columns.reduce((n, c) => n + c.aiCalls, 0),
    paidCells: Math.max(0, ...columns.filter((c) => c.vendors.length).map((c) => c.cells)),
    columns,
    vendors: [...vendors.values()],
  };
  return { ...out, summary: summarize(out) };
}

function summarize(e: Omit<RunEstimate, 'summary'>): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const head = `${n(e.cells)} cell${e.cells === 1 ? '' : 's'} to run${e.aiCalls ? ` (${n(e.aiCalls)} AI task${e.aiCalls === 1 ? '' : 's'})` : ''}.`;
  if (!e.vendors.length) return `${head} Only free sources — no paid credits.`;
  const parts = e.vendors.map((v) => {
    if (v.credits == null) return `${v.label} up to ${n(v.calls)} lookups (${v.cost})`;
    const left = v.remaining == null ? '' : v.exceeds
      ? ` — only ${n(v.remaining)} of ${n(v.budget!)} left this month, so it stops there`
      : ` (${n(v.remaining)} of ${n(v.budget!)} left this month)`;
    return `${v.label} up to ${n(v.credits)} credit${v.credits === 1 ? '' : 's'}${left}`;
  });
  return `${head} Worst case, if every free step finds nothing: ${parts.join('; ')}. Free steps run first, so actual use is usually lower.`;
}
