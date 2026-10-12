/** Wires the GTM workbench (tables, enrichment, AI, signals) into the app. */
import type { Ctx } from '../context.ts';
import { emit, onEvent } from '../events.ts';
import { Engine } from './engine/runner.ts';
import { Store } from './engine/store.ts';
import { Bus } from './events.ts';
import { OutreachBridge } from './outreach.ts';
import { Settings } from './settings.ts';
import { unwrap } from './lib/template.ts';
import { setHttpFetch, setProxySource } from './lib/http.ts';

export interface Gtm {
  store: Store;
  settings: Settings;
  bus: Bus;
  engine: Engine;
  outreach: OutreachBridge;
  stop(): void;
}

export function createGtm(ctx: Ctx): Gtm {
  setHttpFetch(ctx.fetch);
  const store = new Store(ctx.db);
  const settings = new Settings(ctx.db);
  setProxySource(() => settings.get('SCRAPE_PROXY'));
  const bus = new Bus();
  const outreach = new OutreachBridge(ctx);
  const engine = new Engine(store, settings, bus, ctx.config.dataDir, outreach);

  // Table signal changes become workspace webhooks ("Signal Changed").
  engine.onSignalChange = (e) => {
    const rowLabel = firstTextValue(store, e.tableId, e.rowId);
    emit(ctx, e.workspaceId, 'SIGNAL_CHANGED', {
      table: { id: e.tableId, name: store.table(e.tableId).name }, row: { id: e.rowId, label: rowLabel },
      column: { id: e.column.id, name: e.column.name, kind: e.column.config?.kind }, from: unwrap(e.from), to: unwrap(e.to),
    });
  };

  // Outreach activity re-runs matching "Outreach status" cells.
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const off = onEvent((source, workspaceId, type, _data, refs) => {
    if (source !== ctx || stopped || type === 'SIGNAL_CHANGED' || !refs.lead_id) return;
    const lead = ctx.db.get<{ email: string }>('SELECT email FROM leads WHERE id = ?', [refs.lead_id]);
    if (!lead) return;
    // Deferred so the triggering transaction (status updates, bounces…) has committed.
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) engine.refreshLead(workspaceId, lead.email);
    }, 100);
    timers.add(t);
  });

  const stop = () => {
    stopped = true;
    off();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    engine.stop();
  };
  return { store, settings, bus, engine, outreach, stop };
}

function firstTextValue(store: Store, _tableId: number, rowId: number): string {
  const v = store.db.get<{ value: string }>(`SELECT c.value FROM gtm_cells c JOIN gtm_columns col ON col.id = c.column_id
    WHERE c.row_id = ? AND col.type = 'text' AND c.value IS NOT NULL AND c.value != '""' ORDER BY col.position LIMIT 1`, [rowId])?.value;
  return v == null ? `Row ${rowId}` : String(unwrap(JSON.parse(v)));
}
