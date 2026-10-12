/**
 * Functions: reusable enrichment recipes. A function has named inputs, ordered steps
 * (each step is a column config of an existing type that reads inputs and earlier
 * steps by name) and named outputs. A `function` column maps table columns to the
 * inputs and runs the steps per row inside the engine. Every edit to the definition
 * is a new version; columns stay on the version they were set up with until upgraded.
 */
import { nowIso } from '../../db/db.ts';
import { references, renameRefs, renderValue, stringify, unwrap } from '../lib/template.ts';
import type { Engine } from './runner.ts';
import type { Column, ColumnType, Store } from './store.ts';

export const STEP_TYPES = ['formula', 'extract', 'enrich', 'ai', 'http', 'lookup'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export interface FnInput { name: string; description?: string; required?: boolean }
export interface FnStep { name: string; type: StepType; config: any; run_if?: string | null }
export interface FnOutput { name: string; value: string; description?: string }
export interface FnDefinition { inputs: FnInput[]; steps: FnStep[]; outputs: FnOutput[] }

export interface FnRecord {
  id: number; workspace_id: number; name: string; description: string; tags: string[];
  version: number; definition: FnDefinition; created_at: string; updated_at: string;
}

export interface StepResult { name: string; type: string; status: string; ms: number; error?: string; value?: unknown; provider?: unknown; attempts?: unknown }
export interface FnResult { outputs: Record<string, unknown>; steps: StepResult[]; status: 'done' | 'empty' | 'error'; ms: number; error?: string }

interface Job { tableId: number; rowId: number; columnId: number; workspaceId: number }
interface Outcome { value: unknown; status: 'done' | 'empty' | 'skipped'; error?: string; meta?: Record<string, unknown> }

const notFound = () => Object.assign(new Error('Function not found'), { statusCode: 404 });
const bad = (m: string) => Object.assign(new Error(m), { statusCode: 400 });

export class Functions {
  private engine: Engine;
  private store: Store;
  private inserts = 0;

  constructor(engine: Engine, store: Store) {
    this.engine = engine;
    this.store = store;
  }

  private get db() { return this.store.db; }

  // ---------- CRUD & versions ----------

  list(workspaceId: number): FnRecord[] {
    return this.db.all('SELECT * FROM gtm_functions WHERE workspace_id = ? ORDER BY updated_at DESC', [workspaceId]).map(fromRow);
  }

  get(id: number, workspaceId: number): FnRecord {
    const r = this.db.get('SELECT * FROM gtm_functions WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!r) throw notFound();
    return fromRow(r);
  }

  /** The definition at a version (the current one when omitted or unknown). */
  definition(fn: FnRecord, version?: number): FnDefinition {
    if (!version || version === fn.version) return fn.definition;
    const v = this.db.get<{ definition: string }>('SELECT definition FROM gtm_function_versions WHERE function_id = ? AND version = ?', [fn.id, version]);
    return v ? normalize(JSON.parse(v.definition)) : fn.definition;
  }

  versions(id: number) {
    return this.db.all<{ version: number; created_at: string }>('SELECT version, created_at FROM gtm_function_versions WHERE function_id = ? ORDER BY version DESC', [id]);
  }

  create(workspaceId: number, f: { name: string; description?: string; tags?: string[]; definition: FnDefinition }): number {
    const def = validate(f.definition);
    const now = nowIso();
    return this.db.tx(() => {
      const id = this.db.insert('gtm_functions', {
        workspace_id: workspaceId, name: f.name.trim(), description: f.description ?? '', tags: JSON.stringify(cleanTags(f.tags)),
        version: 1, definition: JSON.stringify(def), created_at: now, updated_at: now,
      });
      this.db.insert('gtm_function_versions', { function_id: id, version: 1, definition: JSON.stringify(def), created_at: now });
      return id;
    });
  }

  /** Name, description and tags change in place; a changed definition bumps the version. */
  update(id: number, workspaceId: number, patch: { name?: string; description?: string; tags?: string[]; definition?: FnDefinition }) {
    const fn = this.get(id, workspaceId);
    const now = nowIso();
    const data: Record<string, unknown> = { updated_at: now };
    if (patch.name?.trim()) data.name = patch.name.trim();
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.tags) data.tags = JSON.stringify(cleanTags(patch.tags));
    let version = fn.version;
    if (patch.definition) {
      const def = validate(patch.definition);
      if (JSON.stringify(def) !== JSON.stringify(fn.definition)) {
        version = fn.version + 1;
        data.version = version;
        data.definition = JSON.stringify(def);
        this.db.insert('gtm_function_versions', { function_id: id, version, definition: data.definition, created_at: now });
      }
    }
    this.db.update('gtm_functions', id, data);
    return { version, bumped: version !== fn.version };
  }

  remove(id: number, workspaceId: number) {
    this.get(id, workspaceId);
    this.db.run('DELETE FROM gtm_functions WHERE id = ?', [id]);
  }

  /** Function columns that use this function, with the version each is on. */
  usage(id: number, workspaceId: number) {
    return this.db.all<{ column_id: number; column: string; table_id: number; table: string; version: number | null }>(
      `SELECT c.id AS column_id, c.name AS column, t.id AS table_id, t.name AS "table", CAST(json_extract(c.config, '$.version') AS INTEGER) AS version
       FROM gtm_columns c JOIN gtm_tables t ON t.id = c.table_id
       WHERE c.type = 'function' AND t.workspace_id = ? AND CAST(json_extract(c.config, '$.functionId') AS INTEGER) = ? ORDER BY t.name, c.name`, [workspaceId, id]);
  }

  /** Move columns (all, or the given ones) to the current version. */
  upgradeColumns(id: number, workspaceId: number, columnIds?: number[]): number[] {
    const fn = this.get(id, workspaceId);
    const moved: number[] = [];
    for (const u of this.usage(id, workspaceId)) {
      if (columnIds && !columnIds.includes(u.column_id)) continue;
      if (u.version === fn.version) continue;
      const col = this.store.column(u.column_id);
      this.store.updateColumn(col.id, { config: { ...col.config, version: fn.version } });
      moved.push(col.id);
    }
    return moved;
  }

  // ---------- running ----------

  /** Run a definition's steps on one set of inputs. Steps read inputs and earlier steps by name. */
  async execute(def: FnDefinition, inputs: Record<string, unknown>, j: Job): Promise<FnResult> {
    const started = Date.now();
    const scope: Record<string, unknown> = { ...inputs };
    const steps: StepResult[] = [];
    let errors = 0;
    for (const [i, step] of def.steps.entries()) {
      const col: Column = { id: -(i + 1), table_id: j.tableId, name: step.name, type: step.type as ColumnType, config: step.config ?? {}, position: i, width: null, auto_run: false, run_if: step.run_if ?? null };
      const t = Date.now();
      try {
        const out = await this.engine.compute(col, scope, { ...j, type: step.type });
        scope[step.name] = out.status === 'skipped' ? null : out.value ?? null;
        steps.push({ name: step.name, type: step.type, status: out.status, ms: Date.now() - t, error: out.error, value: preview(out.value), provider: out.meta?.provider, attempts: out.meta?.attempts });
      } catch (e: any) {
        errors++;
        scope[step.name] = null;
        steps.push({ name: step.name, type: step.type, status: 'error', ms: Date.now() - t, error: String(e?.message ?? e).slice(0, 500) });
      }
    }
    const outputs: Record<string, unknown> = {};
    for (const o of def.outputs) {
      const v = unwrap(renderValue(o.value ?? '', scope));
      outputs[o.name] = v === '' || v === undefined ? null : v;
    }
    const filled = Object.values(outputs).some((v) => v != null);
    const firstError = steps.find((s) => s.status === 'error')?.error;
    return {
      outputs, steps, ms: Date.now() - started,
      status: filled ? 'done' : errors ? 'error' : 'empty',
      error: !filled && firstError ? firstError : undefined,
    };
  }

  /** Inputs for one row from the column's mapping. A bare {{Column}} passes the full cell (enrichment data intact). */
  inputsFor(def: FnDefinition, mapping: Record<string, string> | undefined, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const inp of def.inputs) {
      const tpl = (mapping?.[inp.name] ?? '').trim();
      const whole = tpl.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
      let v: unknown = whole && whole[1] in row ? row[whole[1]] : tpl ? renderValue(tpl, row) : null;
      if (v === '' || v === undefined) v = null;
      out[inp.name] = v;
    }
    return out;
  }

  /** The `function` column type. */
  async runColumn(cfg: any, row: Record<string, unknown>, j: Job): Promise<Outcome> {
    const fnId = Number(cfg.functionId);
    if (!fnId) return { value: null, status: 'skipped', error: 'Choose a function' };
    const fn = this.get(fnId, j.workspaceId);
    const version = Number(cfg.version) || fn.version;
    const def = this.definition(fn, version);
    const inputs = this.inputsFor(def, cfg.inputs, row);
    const missing = def.inputs.filter((i) => i.required && unwrap(inputs[i.name]) == null).map((i) => i.name);
    if (missing.length) return { value: null, status: 'skipped', error: `Missing input: ${missing.join(', ')}` };
    if (def.inputs.length && def.inputs.every((i) => unwrap(inputs[i.name]) == null)) return { value: null, status: 'skipped', error: 'All inputs are empty' };
    const r = await this.execute(def, inputs, j);
    this.record(fn, version, j, r);
    if (r.status === 'error') throw new Error(r.error ?? 'Function failed');
    const keys = Object.keys(r.outputs);
    const meta = { provider: `${fn.name} v${version}`, functionId: fn.id, version, functionSteps: r.steps };
    if (r.status === 'empty') return { value: null, status: 'empty', meta };
    return { value: { value: keys.length === 1 ? r.outputs[keys[0]] : r.outputs, data: r.outputs }, status: 'done', meta };
  }

  /** Sandbox: run on sample inputs, or N rows of a table, without writing anything. */
  async test(workspaceId: number, def: FnDefinition, opts: { inputs?: Record<string, unknown>[]; tableId?: number; rowIds?: number[]; limit?: number; mapping?: Record<string, string> }) {
    def = validate(def);
    const samples: { rowId?: number; inputs: Record<string, unknown> }[] = [];
    if (opts.tableId) {
      const t = this.store.tableIn(opts.tableId, workspaceId);
      const cols = this.store.columns(t.id);
      const own = this.store.rowIds(t.id);
      const ids = (opts.rowIds?.length ? opts.rowIds.filter((id) => own.includes(id)) : own).slice(0, Math.min(opts.limit ?? 5, 25));
      for (const rowId of ids) samples.push({ rowId, inputs: this.inputsFor(def, opts.mapping, this.store.rowValues(rowId, cols)) });
    }
    for (const inputs of opts.inputs ?? []) samples.push({ inputs: Object.fromEntries(def.inputs.map((i) => [i.name, inputs[i.name] ?? null])) });
    const results = [];
    for (const s of samples.slice(0, 25)) {
      const r = await this.execute(def, s.inputs, { tableId: opts.tableId ?? 0, rowId: s.rowId ?? 0, columnId: 0, workspaceId });
      results.push({ rowId: s.rowId, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, unwrap(v)])), ...r });
    }
    return { results };
  }

  // ---------- observability ----------

  private record(fn: FnRecord, version: number, j: Job, r: FnResult) {
    const filled = Object.entries(r.outputs).filter(([, v]) => v != null).map(([k]) => k);
    this.db.insert('gtm_function_runs', {
      function_id: fn.id, version, workspace_id: fn.workspace_id, table_id: j.tableId || null, column_id: j.columnId || null, row_id: j.rowId || null,
      status: r.status, ms: r.ms, filled: JSON.stringify(filled), error: r.error ?? null, at: nowIso(),
    });
    if (++this.inserts % 500 === 0) {
      this.db.run('DELETE FROM gtm_function_runs WHERE at < ?', [new Date(Date.now() - 90 * 86_400_000).toISOString()]);
    }
  }

  stats(id: number, workspaceId: number, days = 30) {
    const fn = this.get(id, workspaceId);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const runs = this.db.all<{ version: number; status: string; ms: number; filled: string; table_id: number | null; at: string }>(
      'SELECT version, status, ms, filled, table_id, at FROM gtm_function_runs WHERE function_id = ? AND at >= ? ORDER BY id DESC LIMIT 50000', [id, since]);
    const n = runs.length;
    const outputs = fn.definition.outputs.map((o) => o.name);
    const fill: Record<string, number> = Object.fromEntries(outputs.map((o) => [o, 0]));
    let errors = 0, empty = 0, ms = 0;
    const byVersion: Record<number, number> = {};
    for (const r of runs) {
      if (r.status === 'error') errors++;
      if (r.status === 'empty') empty++;
      ms += r.ms;
      byVersion[r.version] = (byVersion[r.version] ?? 0) + 1;
      for (const k of JSON.parse(r.filled || '[]') as string[]) if (k in fill) fill[k]++;
    }
    const pct = (x: number) => (n ? Math.round((x / n) * 1000) / 10 : 0);
    return {
      days, rowsProcessed: n,
      errorRate: pct(errors), emptyRate: pct(empty),
      avgMs: n ? Math.round(ms / n) : 0,
      fillRate: Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, pct(v)])),
      byVersion,
      lastRunAt: runs[0]?.at ?? null,
      tables: this.usage(id, workspaceId),
    };
  }

  // ---------- create from columns ----------

  /**
   * Turn selected columns of a table into a function. Columns they read that were not
   * selected become inputs (renamed to snake_case); the selected columns become steps in
   * dependency order; columns nothing else selected reads become outputs.
   */
  fromColumns(tableId: number, columnIds: number[]): { definition: FnDefinition; mapping: Record<string, string> } {
    const all = this.store.columns(tableId);
    const names = all.map((c) => c.name);
    const picked = all.filter((c) => columnIds.includes(c.id));
    if (!picked.length) throw bad('Select at least one column');
    const unsupported = picked.filter((c) => !(STEP_TYPES as readonly string[]).includes(c.type));
    if (unsupported.length) throw bad(`These columns can't be function steps: ${unsupported.map((c) => `${c.name} (${c.type})`).join(', ')}`);
    const pickedNames = new Set(picked.map((c) => c.name));
    const deps = new Map(picked.map((c) => [c.name, this.store.dependencies(c, names)]));

    // Order steps so each comes after the steps it reads.
    const ordered: Column[] = [];
    const visiting = new Set<string>();
    const visit = (c: Column) => {
      if (ordered.includes(c) || visiting.has(c.name)) return;
      visiting.add(c.name);
      for (const d of deps.get(c.name) ?? []) { const dc = picked.find((p) => p.name === d); if (dc) visit(dc); }
      visiting.delete(c.name);
      ordered.push(c);
    };
    picked.sort((a, b) => a.position - b.position).forEach(visit);

    // Unselected columns that are read become inputs.
    const inputCols = [...new Set(picked.flatMap((c) => deps.get(c.name) ?? []))].filter((n) => !pickedNames.has(n))
      .sort((a, b) => names.indexOf(a) - names.indexOf(b));
    const taken = new Set(pickedNames);
    const rename = new Map<string, string>();
    for (const n of inputCols) {
      let slug = snake(n) || 'input';
      while (taken.has(slug)) slug = `${slug}_`;
      taken.add(slug);
      rename.set(n, slug);
    }
    const rewrite = (v: unknown): unknown => {
      let out = v;
      for (const [from, to] of rename) out = rewriteRefs(out, from, to);
      return out;
    };
    const steps: FnStep[] = ordered.map((c) => ({ name: c.name, type: c.type as StepType, config: rewrite(c.config), run_if: c.run_if ? (rewrite(c.run_if) as string) : null }));
    const readByOthers = new Set(picked.flatMap((c) => (deps.get(c.name) ?? []).filter((d) => pickedNames.has(d))));
    const leaves = ordered.filter((c) => !readByOthers.has(c.name));
    const outputs: FnOutput[] = (leaves.length ? leaves : ordered.slice(-1)).map((c) => ({ name: snake(c.name) || 'output', value: `{{${c.name}}}` }));
    return {
      definition: { inputs: inputCols.map((n) => ({ name: rename.get(n)!, description: `Was column “${n}”` })), steps, outputs },
      mapping: Object.fromEntries(inputCols.map((n) => [rename.get(n)!, `{{${n}}}`])),
    };
  }
}

// ---------- helpers ----------

function fromRow(r: any): FnRecord {
  return { ...r, tags: JSON.parse(r.tags || '[]'), definition: normalize(JSON.parse(r.definition || '{}')) };
}

function normalize(d: any): FnDefinition {
  return { inputs: d?.inputs ?? [], steps: d?.steps ?? [], outputs: d?.outputs ?? [] };
}

function cleanTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

/** Checks names are unique and steps only reference inputs and earlier steps. */
export function validate(d: FnDefinition): FnDefinition {
  const def = normalize(d);
  const seen = new Set<string>();
  for (const i of def.inputs) {
    if (!i.name?.trim()) throw bad('Every input needs a name');
    if (seen.has(i.name)) throw bad(`Duplicate name: ${i.name}`);
    seen.add(i.name);
  }
  if (!def.steps.length) throw bad('Add at least one step');
  const all = [...def.inputs.map((i) => i.name), ...def.steps.map((s) => s.name)];
  for (const s of def.steps) {
    if (!s.name?.trim()) throw bad('Every step needs a name');
    if (seen.has(s.name)) throw bad(`Duplicate name: ${s.name}`);
    if (!(STEP_TYPES as readonly string[]).includes(s.type)) throw bad(`Step "${s.name}": type ${s.type} can't run inside a function`);
    const later = all.slice(all.indexOf(s.name) + 1);
    const refs = scanRefs(s, all).filter((r) => later.includes(r));
    if (refs.length) throw bad(`Step "${s.name}" reads ${refs.join(', ')}, which runs later`);
    seen.add(s.name);
  }
  if (!def.outputs.length) throw bad('Add at least one output');
  const outNames = new Set<string>();
  for (const o of def.outputs) {
    if (!o.name?.trim()) throw bad('Every output needs a name');
    if (outNames.has(o.name)) throw bad(`Duplicate output: ${o.name}`);
    outNames.add(o.name);
  }
  return {
    inputs: def.inputs.map((i) => ({ name: i.name.trim(), ...(i.description ? { description: i.description } : {}), ...(i.required ? { required: true } : {}) })),
    steps: def.steps.map((s) => ({ name: s.name.trim(), type: s.type, config: s.config ?? {}, run_if: s.run_if?.trim() || null })),
    outputs: def.outputs.map((o) => ({ name: o.name.trim(), value: o.value ?? '', ...(o.description ? { description: o.description } : {}) })),
  };
}

/** Names a step reads (template tokens, row["X"], row.X, extract source). */
function scanRefs(s: FnStep, names: string[]): string[] {
  const out = new Set<string>();
  const scan = (v: unknown) => {
    if (typeof v === 'string') {
      for (const n of references(v, names)) out.add(n);
      for (const m of v.matchAll(/(?:row|raw)\[(["'])(.+?)\1\]/g)) if (names.includes(m[2])) out.add(m[2]);
      for (const m of v.matchAll(/(?:row|raw)\.([A-Za-z_$][\w$]*)/g)) if (names.includes(m[1])) out.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(s.config);
  if (s.run_if) scan(s.run_if);
  if (s.type === 'extract' && s.config?.source && names.includes(s.config.source)) out.add(s.config.source);
  out.delete(s.name);
  return [...out];
}

/** Rewrite references to `from` (tokens, row["from"], row.from, extract source) to `to`. */
function rewriteRefs(v: unknown, from: string, to: string): unknown {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bracket = new RegExp(`(row|raw)\\[(["'])${esc}\\2\\]`, 'g');
  const dot = /^[A-Za-z_$][\w$]*$/.test(from) ? new RegExp(`\\b(row|raw)\\.${esc}\\b`, 'g') : null;
  const go = (x: unknown): unknown => {
    if (typeof x === 'string') {
      let s = renameRefs(x, from, to).replace(bracket, (_, r, q) => `${r}[${q}${to}${q}]`);
      if (dot) s = s.replace(dot, (_, r) => `${r}[${JSON.stringify(to)}]`);
      return s;
    }
    if (Array.isArray(x)) return x.map(go);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === 'source' && y === from ? to : go(y)]));
    return x;
  };
  return go(v);
}

function snake(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function preview(v: unknown): unknown {
  const s = stringify(v);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : v;
}
