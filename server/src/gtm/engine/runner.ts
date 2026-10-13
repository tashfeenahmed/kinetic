/**
 * Cell execution engine: an in-process queue with per-type concurrency,
 * run-if conditions, auto-run cascades to dependent columns, and the
 * table refresh scheduler that powers signals.
 */
import type { Bus } from '../events.ts';
import type { Settings } from '../settings.ts';
import { evaluate, truthy } from '../lib/sandbox.ts';
import { getPath, render, renderDeep, renderValue, stringify } from '../lib/template.ts';
import { enrichKind } from '../providers/catalog.ts';
import { budgetBlock, STEP_PROVIDER } from '../providers/credits.ts';
import { signalKind } from '../providers/signals.ts';
import * as integ from '../providers/integrations.ts';
import type { Ctx, EnrichInput, Hit } from '../providers/types.ts';
import { runAgent } from './agent.ts';
import type { OutreachBridge } from '../outreach.ts';
import { RUNNABLE, type Column, type Store } from './store.ts';
import { Links } from './links.ts';
import { Functions } from './functions.ts';

/** workspaceId is set for cells computed outside a table (function test runs). */
interface Job { tableId: number; rowId: number; columnId: number; type: string; workspaceId?: number }

const LIMITS: Record<string, number> = { ai: 4, enrich: 4, signal: 4, http: 6, action: 2, formula: 20, extract: 20, lookup: 20, function: 4 };

export interface RunOptions {
  /** Re-run cells that already have a value. */
  force?: boolean;
}

interface Outcome { value: unknown; status: 'done' | 'empty' | 'skipped'; error?: string; meta?: Record<string, unknown> }

export class Engine {
  private queue: Job[] = [];
  private queued = new Set<string>();
  private running = new Map<string, Job>();
  private active: Record<string, number> = {};
  private timer?: NodeJS.Timeout;
  private queueNotify = new Set<number>();

  private store: Store;
  private settings: Settings;
  private bus: Bus;

  private dataDir?: string;
  private outreach?: OutreachBridge;
  /** Called when a signal-type cell moves from one value to another (feeds webhooks). */
  onSignalChange?: (e: { workspaceId: number; tableId: number; rowId: number; column: Column; from: unknown; to: unknown }) => void;
  /** Lookups and send-to-table across tables. */
  readonly links: Links;
  /** Reusable functions (the `function` column type). */
  readonly functions: Functions;

  constructor(store: Store, settings: Settings, bus: Bus, dataDir?: string, outreach?: OutreachBridge) {
    this.dataDir = dataDir;
    this.outreach = outreach;
    this.store = store;
    this.settings = settings;
    this.bus = bus;
    this.links = new Links(this, store, bus);
    this.functions = new Functions(this, store);
  }

  start() {
    // Anything interrupted by a restart goes back on the queue.
    const stale = this.store.db.all(`SELECT c.row_id, c.column_id, r.table_id, col.type FROM gtm_cells c
      JOIN gtm_rows r ON r.id = c.row_id JOIN gtm_columns col ON col.id = c.column_id WHERE c.status IN ('queued', 'running', 'stale')`);
    for (const s of stale) this.push({ tableId: s.table_id, rowId: s.row_id, columnId: s.column_id, type: s.type });
    this.pump();
    this.timer = setInterval(() => this.tickSchedules(), 60_000);
  }

  stop() {
    clearInterval(this.timer);
    this.links.stop();
  }

  stats(tableId: number) {
    return {
      pending: this.queue.filter((j) => j.tableId === tableId).length,
      running: [...this.running.values()].filter((j) => j.tableId === tableId).length,
    };
  }

  /** Queue cells. With no rowIds, every row; with no columnIds, every runnable column. */
  run(tableId: number, opts: { columnIds?: number[]; rowIds?: number[] } & RunOptions = {}): number {
    const cols = this.store.columns(tableId).filter((c) => RUNNABLE.includes(c.type) && (!opts.columnIds || opts.columnIds.includes(c.id)));
    const rowIds = opts.rowIds ?? this.store.rowIds(tableId);
    let n = 0;
    this.store.db.tx(() => {
      for (const col of cols) {
        const existing = opts.force ? new Map() : new Map(this.store.db.all(`SELECT row_id, status FROM gtm_cells WHERE column_id = ?`, [col.id]).map((c) => [c.row_id, c.status]));
        for (const rowId of rowIds) {
          const st = existing.get(rowId);
          if (!opts.force && st && st !== 'idle' && st !== 'error') continue;
          if (this.enqueue({ tableId, rowId, columnId: col.id, type: col.type })) n++;
        }
      }
    });
    this.pump();
    return n;
  }

  /** Remove a table's queued work (running cells finish). */
  cancel(tableId: number) {
    const dropped = this.queue.filter((j) => j.tableId === tableId);
    this.queue = this.queue.filter((j) => j.tableId !== tableId);
    this.store.db.tx(() => {
      for (const j of dropped) {
        this.queued.delete(key(j));
        this.store.db.run(`UPDATE gtm_cells SET status = CASE WHEN value IS NULL THEN 'idle' ELSE 'done' END WHERE row_id = ? AND column_id = ?`, [j.rowId, j.columnId]);
        this.emitCell(j);
      }
    });
    this.notifyQueue(tableId);
    return dropped.length;
  }

  /**
   * Outreach activity for a lead (sent, opened, replied, bounced…): re-run every
   * outreach-status cell that tracks that email in the workspace. Downstream
   * auto-run columns (e.g. a Slack alert on "interested") cascade from there.
   */
  refreshLead(workspaceId: number, email: string): number {
    const cells = this.store.db.all(`SELECT c.row_id, c.column_id, t.id AS table_id FROM gtm_cells c
      JOIN gtm_columns col ON col.id = c.column_id JOIN gtm_tables t ON t.id = col.table_id
      WHERE t.workspace_id = ? AND json_extract(c.meta, '$.email') = ?`, [workspaceId, email.trim().toLowerCase()]);
    for (const c of cells) this.enqueue({ tableId: c.table_id, rowId: c.row_id, columnId: c.column_id, type: 'signal' });
    if (cells.length) this.pump();
    return cells.length;
  }

  /** A text cell (or other input) changed: re-run auto columns that depend on it. */
  inputsChanged(tableId: number, rowId: number, columnNames: string[], fromEngine = false) {
    this.cascade(tableId, rowId, columnNames);
    this.links.changed(tableId, columnNames, fromEngine);
    this.pump();
  }

  private enqueue(j: Job): boolean {
    if (this.queued.has(key(j))) return false;
    this.store.setStatus(j.rowId, j.columnId, 'queued');
    this.emitCell(j);
    this.push(j);
    return true;
  }

  private push(j: Job) {
    if (this.queued.has(key(j))) return;
    this.queued.add(key(j));
    this.queue.push(j);
    this.notifyQueue(j.tableId);
  }

  /** Column id → ids of columns it reads, per table; rebuilt on each pump. */
  private dependencyIds(tableId: number, cache: Map<number, Map<number, number[]>>): Map<number, number[]> {
    let m = cache.get(tableId);
    if (!m) {
      const cols = this.store.columns(tableId);
      const ids = new Map(cols.map((c) => [c.name, c.id]));
      const names = cols.map((c) => c.name);
      m = new Map(cols.map((c) => [c.id, this.store.dependencies(c, names).map((n) => ids.get(n)!).filter(Boolean)]));
      cache.set(tableId, m);
    }
    return m;
  }

  private pump(ignoreDeps = false) {
    const deps = new Map<number, Map<number, number[]>>();
    for (let i = 0; i < this.queue.length; ) {
      const j = this.queue[i];
      if ((this.active[j.type] ?? 0) >= (LIMITS[j.type] ?? 4) || this.running.has(key(j))) { i++; continue; }
      // Wait while a column this cell reads is still queued or running for the same row.
      const upstream = this.dependencyIds(j.tableId, deps).get(j.columnId) ?? [];
      if (!ignoreDeps && upstream.some((c) => { const k = `${j.rowId}:${c}`; return this.queued.has(k) || this.running.has(k); })) { i++; continue; }
      this.queue.splice(i, 1);
      this.queued.delete(key(j));
      this.active[j.type] = (this.active[j.type] ?? 0) + 1;
      this.running.set(key(j), j);
      void this.execute(j).finally(() => {
        this.active[j.type]--;
        this.running.delete(key(j));
        this.notifyQueue(j.tableId);
        this.pump();
      });
      if (ignoreDeps) return; // start just one cell when breaking a cycle
    }
    // Every queued cell is waiting on another queued cell (a reference cycle): break it.
    if (!ignoreDeps && this.queue.length && this.running.size === 0) this.pump(true);
  }

  private async execute(j: Job) {
    let col: Column;
    try { col = this.store.column(j.columnId); this.store.rowTable(j.rowId); } catch { return; } // deleted meanwhile
    const cols = this.store.columns(j.tableId);
    this.store.setStatus(j.rowId, j.columnId, 'running');
    this.emitCell(j);
    const started = Date.now();
    let changed = false;
    const before = this.store.cell(j.rowId, j.columnId)?.value;
    try {
      const row = this.store.rowValues(j.rowId, cols);
      const outcome = await this.compute(col, row, j);
      changed = this.store.writeCell(j.rowId, j.columnId, {
        value: outcome.status === 'skipped' ? undefined : outcome.value,
        status: outcome.status, error: outcome.error ?? null,
        meta: { ...outcome.meta, ms: Date.now() - started, ranAt: new Date(started).toISOString() },
      });
    } catch (e: any) {
      const message = e?.message ?? String(e);
      this.store.writeCell(j.rowId, j.columnId, { status: 'error', error: message, meta: { ms: Date.now() - started, ranAt: new Date(started).toISOString() } });
      this.store.log('error', col.type, `${col.name}: ${message}`, j);
    }
    this.emitCell(j);
    if (changed) {
      this.cascade(j.tableId, j.rowId, [col.name]);
      this.links.changed(j.tableId, [col.name], true);
      if (col.type === 'signal' && before != null && this.onSignalChange) {
        try {
          this.onSignalChange({ workspaceId: this.store.table(j.tableId).workspace_id, tableId: j.tableId, rowId: j.rowId, column: col, from: before, to: this.store.cell(j.rowId, j.columnId)?.value });
        } catch (e: any) { this.store.log('warn', 'events', `signal webhook: ${e.message}`, j); }
      }
    }
  }

  private cascade(tableId: number, rowId: number, changedNames: string[]) {
    const cols = this.store.columns(tableId);
    const names = cols.map((c) => c.name);
    for (const c of cols) {
      if (!c.auto_run || !RUNNABLE.includes(c.type)) continue;
      const deps = this.store.dependencies(c, names);
      if (deps.some((d) => changedNames.includes(d))) this.enqueue({ tableId, rowId, columnId: c.id, type: c.type });
    }
  }

  private workspaceOf(j: Job): number {
    return j.workspaceId ?? this.store.table(j.tableId).workspace_id;
  }

  private ctx(j: Job, prev?: unknown): Ctx {
    return { settings: this.settings, dataDir: this.dataDir, workspaceId: this.workspaceOf(j), outreach: this.outreach, prev, log: (m) => this.store.log('info', 'provider', m, j) };
  }

  /** Compute one cell. Exposed for tests. */
  async compute(col: Column, row: Record<string, unknown>, j: Job): Promise<Outcome> {
    // changed("Col") is true when that cell moved from a previous value since this cell last ran
    // (or in the last 30 minutes if it never has). First fills and manual text edits don't count.
    const lastRun: string | undefined = this.store.cell(j.rowId, j.columnId)?.meta?.ranAt;
    const since = lastRun ?? new Date(Date.now() - 30 * 60_000).toISOString();
    const changes = this.store.recentChanges(j.rowId, this.store.columns(j.tableId).filter((c) => c.type !== 'text' && c.id !== col.id), since);
    const helpers = { changed: (name: string) => changes.some((c) => c.name === name), changes: () => changes.map((c) => c.name) };
    row = { ...row, _changes: changes.map((c) => `*${c.name}*: ${short(c.from)} → ${short(c.to)}`).join('\n') };
    if (col.run_if?.trim()) {
      let ok = false;
      try { ok = truthy(evaluate(col.run_if, row, helpers)); } catch (e: any) { return { value: null, status: 'skipped', error: `Run-if error: ${e.message}` }; }
      if (!ok) return { value: null, status: 'skipped', error: 'Run condition not met' };
    }
    const cfg = col.config ?? {};
    switch (col.type) {
      case 'formula': {
        const v = evaluate(cfg.expression ?? 'null', row, helpers);
        return { value: v ?? null, status: v == null || v === '' ? 'empty' : 'done' };
      }
      case 'extract': {
        const v = getPath(row[cfg.source], cfg.path ?? '');
        return { value: v ?? null, status: v == null ? 'empty' : 'done' };
      }
      case 'enrich': return this.enrich(cfg, row, j);
      case 'signal': {
        const kind = signalKind(cfg.kind);
        const input = renderInputs(cfg.inputs, row) as any;
        if (input.days) input.days = Number(input.days);
        const prev = this.store.cell(j.rowId, j.columnId)?.value;
        const hit = await kind.run(input, this.ctx(j, prev));
        // Outreach events look cells up by email to refresh them.
        const meta = kind.id === 'outreach_status' && input.email ? { provider: kind.id, email: String(input.email).trim().toLowerCase() } : { provider: kind.id };
        return hitOutcome(hit, meta);
      }
      case 'ai': {
        const prompt = render(cfg.prompt ?? '', row);
        if (!prompt.trim()) return { value: null, status: 'skipped', error: 'Empty prompt' };
        const r = await runAgent({ prompt, model: cfg.model, outputs: cfg.outputs ?? [], webSearch: cfg.webSearch !== false, fetchPages: cfg.fetchPages !== false, maxSteps: cfg.maxSteps, useKnowledge: !!cfg.useKnowledge }, this.ctx(j));
        const keys = Object.keys(r.output);
        const headline = keys.length === 1 ? r.output[keys[0]] : r.output;
        const empty = keys.every((k) => r.output[k] == null);
        return {
          value: empty ? null : { value: headline, data: r.output, sources: r.sources },
          status: empty ? 'empty' : 'done',
          meta: { provider: r.model, steps: r.steps, usage: r.usage, sources: r.sources },
        };
      }
      case 'http': {
        const url = render(cfg.url ?? '', row);
        if (!url) return { value: null, status: 'skipped', error: 'No URL' };
        const hit = await integ.callHttp({ url, method: cfg.method, headers: renderDeep(cfg.headers ?? {}, row) as any, body: cfg.body ? renderBody(cfg.body, row) : undefined });
        const value = cfg.extract ? getPath(hit.value, cfg.extract) : hit.value;
        return { value: value == null ? null : { value, data: hit.value }, status: value == null ? 'empty' : 'done', meta: { provider: new URL(url).hostname } };
      }
      case 'action':
        if (cfg.kind === 'send_to_table') return this.links.send(cfg, row, j, this.workspaceOf(j));
        return this.action(cfg, row, this.workspaceOf(j), j.tableId);
      case 'lookup': return this.links.lookup(cfg, row, j, this.workspaceOf(j));
      case 'function': return this.functions.runColumn(cfg, row, { ...j, workspaceId: this.workspaceOf(j) });
      default:
        return { value: null, status: 'skipped', error: `Column type ${col.type} does not run` };
    }
  }

  private async enrich(cfg: any, row: Record<string, unknown>, j: Job): Promise<Outcome> {
    const kind = enrichKind(cfg.kind);
    const input = renderInputs(cfg.inputs, row) as EnrichInput;
    if (!kind.needs.some((group) => group.every((k) => input[k]))) {
      return { value: null, status: 'skipped', error: `Missing input — needs one of: ${kind.needs.map((g) => g.join(' + ')).join(' | ')}` };
    }
    const order: string[] = cfg.providers?.length ? cfg.providers : kind.steps.map((s) => s.id);
    const attempts: { provider: string; result: string; ms: number }[] = [];
    let lastError: string | undefined;
    let fallback: { hit: Hit; id: string; label: string } | undefined;
    for (const id of order) {
      const step = kind.steps.find((s) => s.id === id);
      if (!step) continue;
      if (step.requires.some((k) => !this.settings.has(k))) { attempts.push({ provider: id, result: 'no key', ms: 0 }); continue; }
      // Paid vendors stop at their monthly credit budget (Integrations → Credits).
      const paid = STEP_PROVIDER[id];
      const blocked = paid ? budgetBlock(this.settings.db, paid) : null;
      if (blocked) { attempts.push({ provider: id, result: `skipped: ${blocked}`, ms: 0 }); continue; }
      const t = Date.now();
      try {
        const hit = await step.run(input, this.ctx(j));
        const found = hit && hit.value != null && hit.value !== '';
        attempts.push({ provider: id, result: found ? (hit.weak ? `weak: ${hit.confidence ?? 'unconfirmed'}` : 'found') : 'not found', ms: Date.now() - t });
        if (found && hit.weak) { fallback ??= { hit, id, label: step.label }; continue; }
        if (found) {
          return { value: { value: hit.value, provider: id, confidence: hit.confidence, data: hit.data }, status: 'done', meta: { provider: step.label, attempts } };
        }
      } catch (e: any) {
        lastError = `${step.label}: ${e.message}`;
        attempts.push({ provider: id, result: `error: ${e.message}`.slice(0, 200), ms: Date.now() - t });
        this.store.log('warn', 'enrich', lastError, j);
      }
    }
    if (fallback) {
      const { hit, id, label } = fallback;
      return { value: { value: hit.value, provider: id, confidence: hit.confidence, data: hit.data }, status: 'done', meta: { provider: label, attempts } };
    }
    const allFailed = attempts.length > 0 && attempts.every((a) => a.result.startsWith('error') || a.result === 'no key');
    if (allFailed && lastError) throw new Error(lastError);
    if (attempts.every((a) => a.result === 'no key')) return { value: null, status: 'skipped', error: 'No provider in this waterfall has an API key', meta: { attempts } };
    return { value: null, status: 'empty', meta: { attempts } };
  }

  private async action(cfg: any, row: Record<string, unknown>, workspaceId?: number, tableId?: number): Promise<Outcome> {
    const fields = (cfg.fields ?? []).map((f: any) => ({ name: f.name, value: renderValue(f.value ?? '', row) }));
    let hit: Hit;
    switch (cfg.kind) {
      case 'slack':
        hit = await integ.slackPost(this.settings, { text: render(cfg.text ?? '', row), channel: cfg.channel || undefined, webhookUrl: cfg.webhookUrl || undefined });
        break;
      case 'webhook': {
        const body = cfg.body?.trim() ? renderBody(cfg.body, row) : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in (v as any) ? (v as any).value : v]));
        hit = await integ.callHttp({ url: render(cfg.url ?? '', row), method: cfg.method || 'POST', headers: renderDeep(cfg.headers ?? {}, row) as any, body });
        hit = { value: 'sent', data: { response: hit.value } };
        break;
      }
      case 'hubspot_contact':
        hit = await integ.hubspotUpsertContact(this.settings, stringify(renderValue(cfg.email ?? '', row)), fields);
        break;
      case 'hubspot_company':
        hit = await integ.hubspotUpsertCompany(this.settings, stringify(renderValue(cfg.domain ?? '', row)), fields);
        break;
      case 'outreach_campaign':
      case 'outreach_update_lead': {
        if (!this.outreach || !workspaceId) throw new Error('Outreach is not available');
        const v = (t: string | undefined) => stringify(renderValue(t ?? '', row)).trim();
        const variables: Record<string, string> = {};
        for (const f of cfg.variables ?? []) if (f.name) variables[f.name] = v(f.value);
        const email = v(cfg.email);
        if (!email) return { value: null, status: 'skipped', error: 'No email for this row' };
        const r = this.outreach.pushLead(workspaceId, {
          email, first_name: v(cfg.firstName), last_name: v(cfg.lastName), company: v(cfg.company), title: v(cfg.title), variables,
        }, { campaignId: cfg.kind === 'outreach_campaign' ? Number(cfg.campaignId) || null : null, listId: Number(cfg.listId) || null, behavior: cfg.behavior ?? 'patch', allowParallel: !!cfg.allowParallel, source: emailProvenance(cfg.email, row, tableId ?? 0, this.store) });
        const label = r.campaign ? (r.campaign.attached ? `Added to ${r.campaign.name}` : `Not added: ${r.campaign.reason}`) : r.created ? 'Lead created' : 'Lead updated';
        return { value: { value: label, data: r }, status: r.campaign && !r.campaign.attached ? 'skipped' : 'done', error: r.campaign && !r.campaign.attached ? label : undefined, meta: { provider: 'outreach', leadId: r.leadId } };
      }
      case 'salesforce':
        hit = await integ.salesforceUpsert(this.settings, cfg.object || 'Lead', cfg.matchField || 'Email', stringify(renderValue(cfg.matchValue ?? '', row)), fields);
        break;
      default:
        throw new Error(`Unknown action ${cfg.kind}`);
    }
    return hitOutcome(hit, { provider: cfg.kind, sentAt: new Date().toISOString() });
  }

  private tickSchedules() {
    const tables = this.store.db.all('SELECT id, schedule FROM gtm_tables');
    for (const t of tables) {
      const s = JSON.parse(t.schedule || '{}');
      if (!s.enabled || !s.everyMinutes || !s.columnIds?.length) continue;
      if (s.lastRunAt && Date.now() - Date.parse(s.lastRunAt) < s.everyMinutes * 60_000) continue;
      this.store.updateTable(t.id, { schedule: { ...s, lastRunAt: new Date().toISOString() } });
      const n = this.run(t.id, { columnIds: s.columnIds, force: true });
      this.store.log('info', 'schedule', `Scheduled refresh queued ${n} cells`, { tableId: t.id });
    }
  }

  private emitCell(j: { tableId: number; rowId: number; columnId: number }) {
    const c = this.store.cell(j.rowId, j.columnId);
    if (!c) return;
    this.bus.publish({ type: 'cell', tableId: j.tableId, rowId: j.rowId, columnId: j.columnId, cell: { value: c.value, status: c.status, error: c.error, changed_at: c.changed_at, provider: c.meta?.provider } });
  }

  private notifyQueue(tableId: number) {
    if (this.queueNotify.has(tableId)) return;
    this.queueNotify.add(tableId);
    setTimeout(() => {
      this.queueNotify.delete(tableId);
      this.bus.publish({ type: 'queue', tableId, ...this.stats(tableId) });
    }, 250);
  }
}

const key = (j: { rowId: number; columnId: number }) => `${j.rowId}:${j.columnId}`;

function short(v: unknown): string {
  const s = stringify(v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as any) ? (v as any).value : v);
  return s.length > 140 ? `${s.slice(0, 137)}…` : s || '∅';
}

function renderInputs(inputs: Record<string, string> | undefined, row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, tpl] of Object.entries(inputs ?? {})) {
    if (!tpl) continue;
    const v = stringify(renderValue(tpl, row)).trim();
    if (v) out[k] = v;
  }
  return out;
}

/** A JSON body template: render tokens inside the parsed structure so values stay typed. */
function renderBody(body: string, row: Record<string, unknown>): unknown {
  try { return renderDeep(JSON.parse(body), row); } catch { return render(body, row); }
}

function hitOutcome(hit: Hit | null, meta: Record<string, unknown>): Outcome {
  if (!hit || hit.value == null || (Array.isArray(hit.value) && !hit.value.length)) {
    return { value: hit?.data ? { value: null, data: hit.data } : null, status: 'empty', meta: { ...meta, note: hit?.data?.note } };
  }
  return { value: { value: hit.value, confidence: hit.confidence, data: hit.data }, status: 'done', meta };
}

/**
 * Where the row's email came from, for the lead's record: the enrichment column the
 * email template points at (provider, confidence, the page or method behind it), or the
 * plain table column when the email was typed in or imported.
 */
export function emailProvenance(template: string | undefined, row: Record<string, unknown>, tableId: number, store: { table: (id: number) => { name: string } }): { label: string; detail: Record<string, unknown> } {
  const col = String(template ?? '').match(/\{\{\s*([^}.]+?)\s*(?:\.[^}]*)?\}\}/)?.[1]?.trim();
  let tableName = '';
  try { tableName = store.table(tableId).name; } catch { /* table gone */ }
  const cell = col ? row[col] : undefined;
  const base = { table_id: tableId, table: tableName, column: col ?? null };
  if (cell && typeof cell === 'object' && 'value' in (cell as any)) {
    const c = cell as { provider?: string; confidence?: string; data?: Record<string, any> };
    const d = c.data ?? {};
    const page = d.source_url ?? d.sources?.[0] ?? (typeof d.source === 'string' && /^https?:/.test(d.source) ? d.source : undefined);
    const how = d.email_source ?? (typeof d.source === 'string' ? d.source : undefined);
    const label = [`Table "${tableName || tableId}"`, c.provider ? `found by ${c.provider}` : null, how ?? c.confidence ?? null].filter(Boolean).join(' · ');
    return { label, detail: { ...base, provider: c.provider ?? null, confidence: c.confidence ?? null, method: how ?? null, page: page ?? null, found_by: d.found_by ?? null } };
  }
  return { label: `Table "${tableName || tableId}"${col ? ` · column ${col}` : ''}`, detail: base };
}
