/** Data access for tables, columns, rows and cells. Values are JSON in SQLite. */
import { randomBytes } from 'node:crypto';
import { nowIso, type Db } from '../../db/db.ts';
import { references, renameRefs } from '../lib/template.ts';

export type ColumnType = 'text' | 'formula' | 'extract' | 'enrich' | 'ai' | 'http' | 'signal' | 'action' | 'lookup' | 'function';
export const RUNNABLE: ColumnType[] = ['formula', 'extract', 'enrich', 'ai', 'http', 'signal', 'action', 'lookup', 'function'];

export interface Column {
  id: number; table_id: number; name: string; type: ColumnType; config: any;
  position: number; width: number | null; auto_run: boolean; run_if: string | null;
}
export interface Cell {
  row_id: number; column_id: number; value: unknown; prev_value?: unknown; changed_at: string | null;
  status: string; error: string | null; meta: any; updated_at: string;
}
export interface TableRec { id: number; workspace_id: number; name: string; webhook_token: string; schedule: any; created_at: string; updated_at: string }

const parse = (s: string | null) => (s == null ? null : JSON.parse(s));

export class Store {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  // ---------- tables ----------
  listTables(workspaceId: number) {
    return this.db.all(`SELECT t.id, t.name, t.updated_at, (SELECT COUNT(*) FROM gtm_rows r WHERE r.table_id = t.id) AS row_count
      FROM gtm_tables t WHERE t.workspace_id = ? ORDER BY t.updated_at DESC`, [workspaceId]);
  }

  /** The table, or a 404 when it belongs to another workspace. */
  tableIn(id: number, workspaceId: number): TableRec {
    const t = this.table(id);
    if (t.workspace_id !== workspaceId) throw Object.assign(new Error('Table not found'), { statusCode: 404 });
    return t;
  }

  table(id: number): TableRec {
    const t = this.db.get('SELECT * FROM gtm_tables WHERE id = ?', [id]);
    if (!t) throw Object.assign(new Error('Table not found'), { statusCode: 404 });
    return { ...t, schedule: parse(t.schedule) ?? {} } as TableRec;
  }

  tableByToken(token: string): TableRec | undefined {
    const t = this.db.get('SELECT id FROM gtm_tables WHERE webhook_token = ?', [token]);
    return t ? this.table(t.id) : undefined;
  }

  createTable(workspaceId: number, name: string): number {
    const now = nowIso();
    return this.db.insert('gtm_tables', { workspace_id: workspaceId, name, webhook_token: randomBytes(12).toString('hex'), schedule: '{}', created_at: now, updated_at: now });
  }

  updateTable(id: number, patch: { name?: string; schedule?: unknown }) {
    const data: Record<string, unknown> = { updated_at: nowIso() };
    if (patch.name != null) data.name = patch.name;
    if (patch.schedule != null) data.schedule = JSON.stringify(patch.schedule);
    this.db.update('gtm_tables', id, data);
  }

  touch(id: number) {
    this.db.run('UPDATE gtm_tables SET updated_at = ? WHERE id = ?', [nowIso(), id]);
  }

  deleteTable(id: number) {
    this.db.run('DELETE FROM gtm_tables WHERE id = ?', [id]);
  }

  // ---------- columns ----------
  columns(tableId: number): Column[] {
    return this.db.all('SELECT * FROM gtm_columns WHERE table_id = ? ORDER BY position', [tableId]).map(colFromRow);
  }

  column(id: number): Column {
    const c = this.db.get('SELECT * FROM gtm_columns WHERE id = ?', [id]);
    if (!c) throw Object.assign(new Error('Column not found'), { statusCode: 404 });
    return colFromRow(c);
  }

  createColumn(tableId: number, c: { name: string; type: ColumnType; config?: unknown; auto_run?: boolean; run_if?: string | null; width?: number; after?: number }): number {
    const name = this.uniqueName(tableId, c.name);
    const max = this.db.get<{ p: number }>('SELECT MAX(position) AS p FROM gtm_columns WHERE table_id = ?', [tableId])?.p ?? 0;
    return this.db.insert('gtm_columns', {
      table_id: tableId, name, type: c.type, config: JSON.stringify(c.config ?? {}),
      position: max + 1, width: c.width ?? null, auto_run: c.auto_run ? 1 : 0, run_if: c.run_if || null,
    });
  }

  updateColumn(id: number, patch: Partial<{ name: string; config: unknown; auto_run: boolean; run_if: string | null; width: number; position: number }>) {
    const col = this.column(id);
    this.db.tx(() => {
      const data: Record<string, unknown> = {};
      if (patch.name != null && patch.name !== col.name) {
        data.name = this.uniqueName(col.table_id, patch.name);
        this.renameReferences(col.table_id, col.name, data.name as string);
      }
      if (patch.config !== undefined) data.config = JSON.stringify(patch.config);
      if (patch.auto_run !== undefined) data.auto_run = patch.auto_run ? 1 : 0;
      if (patch.run_if !== undefined) data.run_if = patch.run_if || null;
      if (patch.width !== undefined) data.width = patch.width;
      if (patch.position !== undefined) data.position = patch.position;
      this.db.update('gtm_columns', id, data);
    });
  }

  deleteColumn(id: number) {
    this.db.run('DELETE FROM gtm_columns WHERE id = ?', [id]);
  }

  private uniqueName(tableId: number, wanted: string): string {
    const base = wanted.trim() || 'Column';
    const taken = new Set(this.db.all<{ name: string }>('SELECT name FROM gtm_columns WHERE table_id = ?', [tableId]).map((r) => r.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  /** After a rename, rewrite {{Old}} tokens and row["Old"] references in every column. */
  private renameReferences(tableId: number, from: string, to: string) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowRef = new RegExp(`(row|raw)\\[(["'])${esc}\\2\\]`, 'g');
    const rewrite = (v: unknown): unknown => {
      if (typeof v === 'string') return renameRefs(v, from, to).replace(rowRef, (_, r, q) => `${r}[${q}${to}${q}]`);
      if (Array.isArray(v)) return v.map(rewrite);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'source' && x === from ? to : rewrite(x)]));
      return v;
    };
    for (const c of this.columns(tableId)) {
      this.db.run('UPDATE gtm_columns SET config = ?, run_if = ? WHERE id = ?', [JSON.stringify(rewrite(c.config)), c.run_if ? (rewrite(c.run_if) as string) : null, c.id]);
    }
  }

  /** Names of columns this column reads (template tokens, row["X"], extract source). */
  dependencies(col: Column, names: string[]): string[] {
    const out = new Set<string>();
    const scan = (v: unknown) => {
      if (typeof v === 'string') {
        for (const n of references(v, names)) out.add(n);
        for (const m of v.matchAll(/(?:row|raw)\[(["'])(.+?)\1\]/g)) if (names.includes(m[2])) out.add(m[2]);
        for (const m of v.matchAll(/(?:row|raw)\.([A-Za-z_$][\w$]*)/g)) if (names.includes(m[1])) out.add(m[1]);
        for (const m of v.matchAll(/changed\((["'])(.+?)\1\)/g)) if (names.includes(m[2])) out.add(m[2]);
      } else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(col.config);
    if (col.run_if) scan(col.run_if);
    if (col.type === 'extract' && col.config.source) out.add(col.config.source);
    out.delete(col.name);
    return [...out];
  }

  // ---------- rows & cells ----------
  rowIds(tableId: number): number[] {
    return this.db.all<{ id: number }>('SELECT id FROM gtm_rows WHERE table_id = ? ORDER BY position', [tableId]).map((r) => r.id);
  }

  rowTable(rowId: number): number {
    const r = this.db.get<{ table_id: number }>('SELECT table_id FROM gtm_rows WHERE id = ?', [rowId]);
    if (!r) throw Object.assign(new Error('Row not found'), { statusCode: 404 });
    return r.table_id;
  }

  /** Full grid payload for the UI. */
  grid(tableId: number) {
    const rows = this.db.all<{ id: number }>('SELECT id FROM gtm_rows WHERE table_id = ? ORDER BY position', [tableId]);
    const cells = this.db.all(`SELECT c.row_id, c.column_id, c.value, c.status, c.error, c.changed_at, c.meta FROM gtm_cells c
      JOIN gtm_rows r ON r.id = c.row_id WHERE r.table_id = ?`, [tableId]);
    const byRow = new Map<number, Record<number, unknown>>();
    for (const c of cells) {
      let m = byRow.get(c.row_id);
      if (!m) byRow.set(c.row_id, (m = {}));
      m[c.column_id] = { value: parse(c.value), status: c.status, error: c.error, changed_at: c.changed_at, provider: parse(c.meta)?.provider };
    }
    return rows.map((r) => ({ id: r.id, cells: byRow.get(r.id) ?? {} }));
  }

  addRows(tableId: number, records: Record<string, unknown>[], createMissingColumns = true): number[] {
    return this.db.tx(() => {
      let cols = this.columns(tableId);
      if (createMissingColumns) {
        const known = new Set(cols.map((c) => c.name));
        for (const rec of records) for (const k of Object.keys(rec)) {
          if (!known.has(k) && k.trim()) { this.createColumn(tableId, { name: k, type: 'text' }); known.add(k); }
        }
        cols = this.columns(tableId);
      }
      const byName = new Map(cols.map((c) => [c.name, c]));
      let pos = this.db.get<{ p: number }>('SELECT MAX(position) AS p FROM gtm_rows WHERE table_id = ?', [tableId])?.p ?? 0;
      const now = nowIso();
      const ids: number[] = [];
      for (const rec of records) {
        const id = this.db.insert('gtm_rows', { table_id: tableId, position: ++pos, created_at: now });
        ids.push(id);
        for (const [k, v] of Object.entries(rec)) {
          const col = byName.get(k);
          if (!col || v == null || v === '') continue;
          this.db.insert('gtm_cells', { row_id: id, column_id: col.id, value: JSON.stringify(v), status: 'done', updated_at: now });
        }
      }
      this.touch(tableId);
      return ids;
    });
  }

  deleteRows(ids: number[]) {
    this.db.tx(() => { for (const id of ids) this.db.run('DELETE FROM gtm_rows WHERE id = ?', [id]); });
  }

  cell(rowId: number, columnId: number): Cell | undefined {
    const c = this.db.get('SELECT * FROM gtm_cells WHERE row_id = ? AND column_id = ?', [rowId, columnId]);
    return c ? { ...c, value: parse(c.value), prev_value: parse(c.prev_value), meta: parse(c.meta) } as Cell : undefined;
  }

  /** name → value for every cell in the row (values as stored, wrappers intact). */
  rowValues(rowId: number, cols: Column[]): Record<string, unknown> {
    const cells = this.db.all('SELECT column_id, value FROM gtm_cells WHERE row_id = ?', [rowId]);
    const byId = new Map(cells.map((c) => [c.column_id, parse(c.value)]));
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c.name] = byId.get(c.id) ?? null;
    return out;
  }

  /** Cells in a row whose value changed from a previous value after `since` (ISO time). */
  recentChanges(rowId: number, cols: Column[], since: string): { name: string; from: unknown; to: unknown }[] {
    const rows = this.db.all('SELECT column_id, value, prev_value FROM gtm_cells WHERE row_id = ? AND prev_value IS NOT NULL AND changed_at > ?', [rowId, since]);
    const byId = new Map(cols.map((c) => [c.id, c.name]));
    return rows.filter((r) => byId.has(r.column_id)).map((r) => ({ name: byId.get(r.column_id)!, from: parse(r.prev_value), to: parse(r.value) }));
  }

  /**
   * Write a cell result. Returns whether the value changed; on change the old value is
   * kept in prev_value and changed_at is stamped so signals can be diffed.
   */
  writeCell(rowId: number, columnId: number, patch: { value?: unknown; status: string; error?: string | null; meta?: unknown }): boolean {
    const now = nowIso();
    const existing = this.db.get('SELECT value FROM gtm_cells WHERE row_id = ? AND column_id = ?', [rowId, columnId]);
    if (!existing) {
      this.db.insert('gtm_cells', {
        row_id: rowId, column_id: columnId, value: patch.value === undefined ? null : JSON.stringify(patch.value),
        status: patch.status, error: patch.error ?? null, meta: patch.meta === undefined ? null : JSON.stringify(patch.meta), updated_at: now,
      });
      return patch.value != null;
    }
    const sets: string[] = ['status = ?', 'error = ?', 'updated_at = ?'];
    const params: unknown[] = [patch.status, patch.error ?? null, now];
    let changed = false;
    if (patch.value !== undefined) {
      const next = JSON.stringify(patch.value);
      if (next !== existing.value) {
        changed = true;
        // changed_at marks a change from a previous value, not the first fill.
        sets.push('prev_value = value', 'value = ?', 'changed_at = CASE WHEN value IS NULL THEN changed_at ELSE ? END');
        params.push(next, now);
      }
    }
    if (patch.meta !== undefined) { sets.push('meta = ?'); params.push(JSON.stringify(patch.meta)); }
    this.db.run(`UPDATE gtm_cells SET ${sets.join(', ')} WHERE row_id = ? AND column_id = ?`, [...params as any, rowId, columnId]);
    return changed;
  }

  setStatus(rowId: number, columnId: number, status: string) {
    const r = this.db.run('UPDATE gtm_cells SET status = ?, error = NULL, updated_at = ? WHERE row_id = ? AND column_id = ?', [status, nowIso(), rowId, columnId]);
    if (!r.changes) this.db.insert('gtm_cells', { row_id: rowId, column_id: columnId, status, updated_at: nowIso() });
  }

  log(level: string, source: string, message: string, ref: { tableId?: number; rowId?: number; columnId?: number } = {}) {
    this.db.insert('gtm_logs', { at: nowIso(), level, source, message: message.slice(0, 2000), table_id: ref.tableId ?? null, row_id: ref.rowId ?? null, column_id: ref.columnId ?? null });
  }

  logs(limit = 200, tableId?: number, workspaceId?: number) {
    if (tableId) return this.db.all('SELECT * FROM gtm_logs WHERE table_id = ? ORDER BY id DESC LIMIT ?', [tableId, limit]);
    return this.db.all(`SELECT l.* FROM gtm_logs l JOIN gtm_tables t ON t.id = l.table_id WHERE t.workspace_id = ? ORDER BY l.id DESC LIMIT ?`, [workspaceId ?? 0, limit]);
  }
}

function colFromRow(c: any): Column {
  return { ...c, config: parse(c.config) ?? {}, auto_run: !!c.auto_run };
}
