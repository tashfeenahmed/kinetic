/**
 * Links between tables: lookup columns (find rows in another table), send-to-table
 * actions (write rows into another table, with upsert and list explode), and the
 * staleness tracker that re-runs lookups when the table they read changes.
 *
 * Loops are cut two ways: a lookup only refreshes when a column it reads changes,
 * and each refresh/send carries the chain of tables that caused it, so a change
 * never flows back into a table already on its chain.
 */
import type { Bus, TableEvent } from '../events.ts';
import { renderValue, unwrap } from '../lib/template.ts';
import { cellKeys, matchKey, toList, type MatchMode, MATCH_MODES } from './match.ts';
import type { Engine } from './runner.ts';
import type { Store } from './store.ts';

export interface LinkJob { tableId: number; rowId: number; columnId: number; workspaceId?: number }
interface Outcome { value: unknown; status: 'done' | 'empty' | 'skipped'; error?: string; meta?: Record<string, unknown> }

export interface LookupConfig {
  tableId: number;
  /** Target column to match on; "_id" matches the row id. */
  matchColumn: string;
  /** Template for the value to look for, e.g. "{{Domain}}". */
  value: string;
  mode?: MatchMode;
  /** first: the first row's fields · all: every matching row · count: how many match. */
  return?: 'first' | 'all' | 'count';
  /** Target columns to return (empty = all). */
  fields?: string[];
  limit?: number;
  /** Re-run when the target table changes (default true). */
  autoRefresh?: boolean;
}

export interface SendConfig {
  tableId: number;
  /** Target column name → value template. Missing target columns are created as text. */
  fields: { name: string; value: string }[];
  /** Target column used to find an existing row (upsert); empty = always create. */
  dedupeKey?: string;
  dedupeMode?: MatchMode;
  /** When a row with the same key exists: update it (default) or leave it. */
  onMatch?: 'update' | 'skip';
  /** Template of a list value: one target row per item; templates see {{item}}, {{item.field}}, {{_index}}. */
  explode?: string;
  /** Target column that gets a back-reference to the source row. */
  backRef?: string;
  /** Run the target table's auto-run columns on the new rows (default true). */
  runAuto?: boolean;
}

const DEBOUNCE_MS = 1500;
const CHAIN_TTL_MS = 60_000;
/** Rows written by a send remember where they came from long enough for slow auto-run columns. */
const ROW_CHAIN_TTL_MS = 15 * 60_000;
const MAX_EXPLODE = 1000;

export class Links {
  /** Delay before stale lookups re-run (tests shorten it). */
  debounceMs = DEBOUNCE_MS;
  private engine: Engine;
  private store: Store;
  private bus: Bus;
  private index = new Map<string, { stamp: string; map: Map<string, number[]> }>();
  private pending = new Map<number, { tableId: number; chain: Set<number> }>();
  private timer?: NodeJS.Timeout;
  /** Tables (and rows) whose latest changes came from a refresh or send, with the tables that caused them. */
  private tableChains = new Map<number, { chain: Set<number>; until: number }>();
  private rowChains = new Map<number, { chain: Set<number>; until: number }>();
  private quiet = false;
  private onBus = (e: TableEvent) => { if (!this.quiet && e.type === 'rows') this.changed(e.tableId, '*', false); };

  constructor(engine: Engine, store: Store, bus: Bus) {
    this.engine = engine;
    this.store = store;
    this.bus = bus;
    bus.on('any', this.onBus);
  }

  stop() {
    clearTimeout(this.timer);
    this.pending.clear();
    this.bus.off('any', this.onBus);
  }

  // ---------- lookups ----------

  /** rowIds in `tableId` whose `column` matches `value` (in row order). */
  match(tableId: number, column: string, value: unknown, mode: MatchMode = 'exact'): number[] {
    if (column === '_id') {
      const id = Number(unwrap(value));
      return id && this.store.db.get('SELECT 1 FROM gtm_rows WHERE id = ? AND table_id = ?', [id, tableId]) ? [id] : [];
    }
    const key = matchKey(value, mode);
    if (!key) return [];
    return this.indexFor(tableId, column, mode)?.get(key) ?? [];
  }

  /** key → rowIds for one column, rebuilt when the column's cells change. */
  private indexFor(tableId: number, column: string, mode: MatchMode): Map<string, number[]> | undefined {
    const col = this.store.db.get<{ id: number }>('SELECT id FROM gtm_columns WHERE table_id = ? AND name = ?', [tableId, column]);
    if (!col) return undefined;
    const s = this.store.db.get<{ n: number; at: string | null }>('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM gtm_cells WHERE column_id = ?', [col.id])!;
    const stamp = `${s.n}:${s.at}`;
    const k = `${col.id}:${mode}`;
    const hit = this.index.get(k);
    if (hit && hit.stamp === stamp) return hit.map;
    const map = new Map<string, number[]>();
    const cells = this.store.db.all<{ row_id: number; value: string | null }>(`SELECT c.row_id, c.value FROM gtm_cells c JOIN gtm_rows r ON r.id = c.row_id
      WHERE c.column_id = ? AND c.value IS NOT NULL ORDER BY r.position`, [col.id]);
    for (const c of cells) {
      for (const key of new Set(cellKeys(JSON.parse(c.value!), mode))) {
        const list = map.get(key);
        if (list) list.push(c.row_id);
        else map.set(key, [c.row_id]);
      }
    }
    if (this.index.size > 200) this.index.clear();
    this.index.set(k, { stamp, map });
    return map;
  }

  async lookup(cfg: LookupConfig, row: Record<string, unknown>, j: LinkJob, workspaceId: number): Promise<Outcome> {
    const targetId = Number(cfg.tableId);
    if (!targetId || !cfg.matchColumn) return { value: null, status: 'skipped', error: 'Choose a table and a column to match' };
    const target = this.targetTable(targetId, workspaceId);
    const mode: MatchMode = MATCH_MODES.includes(cfg.mode as MatchMode) ? cfg.mode! : 'exact';
    const needle = renderValue(cfg.value ?? '', row);
    if (cfg.matchColumn !== '_id' && !matchKey(needle, mode)) return { value: null, status: 'skipped', error: 'Lookup value is empty' };
    let ids = this.match(targetId, cfg.matchColumn, needle, mode);
    if (targetId === j.tableId) ids = ids.filter((id) => id !== j.rowId); // never match yourself
    const meta = { provider: target.name, tableId: targetId, matched: ids.length, mode };
    const mode_ = cfg.return ?? 'first';
    if (mode_ === 'count') return { value: { value: ids.length, data: { count: ids.length, rowIds: ids } }, status: 'done', meta };
    if (!ids.length) return { value: null, status: 'empty', meta };
    const cols = this.store.columns(targetId);
    const wanted = cfg.fields?.length ? cols.filter((c) => cfg.fields!.includes(c.name)) : cols;
    const record = (id: number) => {
      const vals = this.store.rowValues(id, wanted);
      return { _rowId: id, ...Object.fromEntries(wanted.map((c) => [c.name, unwrap(vals[c.name]) ?? null])) };
    };
    // The first chosen field is the cell's headline (the match column when none are chosen).
    const headlineField = cfg.fields?.length ? cfg.fields.find((f) => wanted.some((c) => c.name === f)) : cfg.matchColumn;
    if (mode_ === 'all') {
      const limit = Math.min(Math.max(Number(cfg.limit) || 100, 1), 1000);
      const rows = ids.slice(0, limit).map(record);
      return {
        value: { value: rows.map((r: any) => r[headlineField!] ?? r._rowId), data: { count: ids.length, rows, rowIds: ids.slice(0, limit), tableId: targetId } },
        status: 'done', meta,
      };
    }
    const first = record(ids[0]) as Record<string, unknown>;
    const headline = (headlineField && first[headlineField]) ?? first._rowId;
    return { value: { value: headline, data: { ...first, rowId: ids[0], tableId: targetId, count: ids.length } }, status: 'done', meta };
  }

  private targetTable(tableId: number, workspaceId: number) {
    const t = this.store.db.get<{ id: number; name: string; workspace_id: number }>('SELECT id, name, workspace_id FROM gtm_tables WHERE id = ?', [tableId]);
    if (!t || t.workspace_id !== workspaceId) throw new Error('Target table not found');
    return t;
  }

  // ---------- staleness ----------

  /**
   * Cells of `tableId` changed (column names, or '*' for added/removed rows).
   * Lookups elsewhere that read those columns go stale and re-run after a short debounce.
   * `fromEngine` marks changes produced by computed cells, which inherit the table's chain.
   */
  changed(tableId: number, names: string[] | '*', fromEngine: boolean) {
    const chain = new Set(fromEngine ? this.chainOf(this.tableChains, tableId) : []);
    const deps = this.store.db.all<{ id: number; table_id: number; name: string; config: string }>(
      `SELECT id, table_id, name, config FROM gtm_columns WHERE type = 'lookup' AND CAST(json_extract(config, '$.tableId') AS INTEGER) = ?`, [tableId]);
    for (const d of deps) {
      const cfg = JSON.parse(d.config || '{}') as LookupConfig;
      if (cfg.autoRefresh === false || chain.has(d.table_id)) continue;
      if (names !== '*') {
        const relevant = names.filter((n) => !(d.table_id === tableId && n === d.name));
        const reads = cfg.fields?.length && cfg.return !== 'count' ? [cfg.matchColumn, ...cfg.fields] : null;
        if (!relevant.length || (reads && !relevant.some((n) => reads.includes(n)))) continue;
        if (cfg.return === 'count' && !relevant.includes(cfg.matchColumn)) continue;
      }
      const p = this.pending.get(d.id);
      const next = new Set([...(p?.chain ?? []), ...chain, tableId]);
      this.pending.set(d.id, { tableId: d.table_id, chain: next });
      this.store.db.run(`UPDATE gtm_cells SET status = 'stale' WHERE column_id = ? AND status IN ('done', 'empty')`, [d.id]);
    }
    if (this.pending.size) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
      this.timer.unref?.();
    }
  }

  /** Re-run every stale lookup column. */
  flush() {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [columnId, { tableId, chain }] of batch) {
      let col;
      try { col = this.store.column(columnId); } catch { continue; }
      this.setChain(this.tableChains, tableId, chain);
      const rowIds = col.auto_run ? undefined
        : this.store.db.all<{ row_id: number }>(`SELECT row_id FROM gtm_cells WHERE column_id = ? AND status != 'idle'`, [columnId]).map((r) => r.row_id);
      if (rowIds && !rowIds.length) continue;
      this.engine.run(tableId, { columnIds: [columnId], rowIds, force: true });
    }
  }

  private chainOf(m: Map<number, { chain: Set<number>; until: number }>, id: number): Set<number> {
    const c = m.get(id);
    if (!c) return new Set();
    if (c.until < Date.now()) { m.delete(id); return new Set(); }
    return c.chain;
  }

  private setChain(m: Map<number, { chain: Set<number>; until: number }>, id: number, chain: Set<number>, ttl = CHAIN_TTL_MS) {
    const prev = this.chainOf(m, id);
    m.set(id, { chain: new Set([...prev, ...chain]), until: Date.now() + ttl });
    if (m.size > 5000) for (const [k, v] of m) if (v.until < Date.now()) m.delete(k);
  }

  // ---------- send to table ----------

  /** Send one source row (or one row per exploded item) into another table. */
  async send(cfg: SendConfig, row: Record<string, unknown>, j: LinkJob, workspaceId: number): Promise<Outcome> {
    const targetId = Number(cfg.tableId);
    if (!targetId) return { value: null, status: 'skipped', error: 'Choose a target table' };
    const target = this.targetTable(targetId, workspaceId);
    // Rows that were themselves written by a send carry its chain: never send back along it.
    const chain = new Set(this.chainOf(this.rowChains, j.rowId));
    if (chain.has(targetId)) return { value: null, status: 'skipped', error: `Loop prevented: this row came from "${target.name}"` };

    let items: unknown[] = [undefined];
    if (cfg.explode?.trim()) {
      items = toList(renderValue(cfg.explode, row));
      if (!items.length) return { value: null, status: 'empty', error: 'The list to explode is empty', meta: { provider: target.name } };
      items = items.slice(0, MAX_EXPLODE);
    }
    const backRef = cfg.backRef?.trim() ? { value: sourceLabel(this.store, j.tableId, j.rowId, row), tableId: j.tableId, rowId: j.rowId } : undefined;
    const records = items.map((item, i) => {
      const scope = item === undefined ? row : { ...row, item, _index: i };
      const rec: Record<string, unknown> = {};
      for (const f of cfg.fields ?? []) {
        if (!f.name?.trim()) continue;
        let v = renderValue(f.value ?? '', scope);
        v = unwrap(v);
        if (v == null || v === '') continue;
        rec[f.name.trim()] = v;
      }
      if (backRef) rec[cfg.backRef!.trim()] = backRef;
      return rec;
    }).filter((r) => Object.keys(r).length);
    if (!records.length) return { value: null, status: 'empty', error: 'No mapped field has a value', meta: { provider: target.name } };

    const r = this.writeRows(targetId, records, cfg, new Set([...chain, j.tableId]));
    const parts = [r.created.length && `${r.created.length} created`, r.updated.length && `${r.updated.length} updated`, r.skipped.length && `${r.skipped.length} unchanged`].filter(Boolean);
    return {
      value: { value: `${parts.join(', ')} in ${target.name}`, data: { tableId: targetId, table: target.name, rowIds: r.rowIds, created: r.created, updated: r.updated, skipped: r.skipped } },
      status: 'done',
      meta: { provider: 'send_to_table', tableId: targetId, rowIds: r.rowIds, sentAt: new Date().toISOString() },
    };
  }

  /** Upsert records into a table; returns the touched row ids. */
  writeRows(tableId: number, records: Record<string, unknown>[], cfg: Pick<SendConfig, 'dedupeKey' | 'dedupeMode' | 'onMatch' | 'runAuto'>, chain: Set<number>) {
    const mode: MatchMode = MATCH_MODES.includes(cfg.dedupeMode as MatchMode) ? cfg.dedupeMode! : 'case_insensitive';
    const key = cfg.dedupeKey?.trim();
    const created: number[] = [], updated: number[] = [], skipped: number[] = [], rowIds: number[] = [];
    const changedByRow = new Map<number, string[]>();
    this.store.db.tx(() => {
      // Missing target columns become text columns.
      const known = new Set(this.store.columns(tableId).map((c) => c.name));
      for (const rec of records) for (const k of Object.keys(rec)) if (!known.has(k)) { this.store.createColumn(tableId, { name: k, type: 'text' }); known.add(k); }
      const cols = new Map(this.store.columns(tableId).map((c) => [c.name, c]));
      const seen = new Map<string, number>(); // keys created in this batch
      for (const rec of records) {
        const k = key ? matchKey(rec[key], mode) : '';
        const existing = k ? (seen.get(k) ?? this.match(tableId, key!, rec[key!], mode)[0]) : undefined;
        if (existing) {
          rowIds.push(existing);
          if (k) seen.set(k, existing);
          if (cfg.onMatch === 'skip') { skipped.push(existing); continue; }
          const names: string[] = [];
          for (const [name, v] of Object.entries(rec)) {
            const col = cols.get(name);
            if (!col || col.type !== 'text') continue;
            if (this.store.writeCell(existing, col.id, { value: v, status: 'done' })) names.push(name);
          }
          if (names.length) { updated.push(existing); changedByRow.set(existing, names); } else skipped.push(existing);
          continue;
        }
        const [id] = this.store.addRows(tableId, [rec], false);
        created.push(id);
        rowIds.push(id);
        if (k) seen.set(k, id);
      }
    });
    for (const id of rowIds) this.setChain(this.rowChains, id, chain, ROW_CHAIN_TTL_MS);
    this.setChain(this.tableChains, tableId, chain);
    this.quiet = true;
    try {
      this.bus.publish({ type: 'rows', tableId });
      this.bus.publish({ type: 'columns', tableId });
    } finally { this.quiet = false; }
    if (created.length && cfg.runAuto !== false) {
      const auto = this.store.columns(tableId).filter((c) => c.auto_run && c.type !== 'text').map((c) => c.id);
      if (auto.length) this.engine.run(tableId, { columnIds: auto, rowIds: created });
    }
    for (const [id, names] of changedByRow) this.engine.inputsChanged(tableId, id, names, true);
    if (created.length) this.changed(tableId, '*', true);
    return { created, updated, skipped, rowIds };
  }
}

/** A short label for a row: its first non-empty text cell. */
function sourceLabel(store: Store, tableId: number, rowId: number, row: Record<string, unknown>): string {
  for (const c of store.columns(tableId)) {
    if (c.type !== 'text') continue;
    const v = unwrap(row[c.name]);
    if (v != null && v !== '') return String(v);
  }
  return `Row ${rowId}`;
}
