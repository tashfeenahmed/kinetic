import { api, type Column } from './api';

/**
 * Table rows → Leads (optionally a lead list) → Campaign.
 *
 * Pushing is an action column on the table, so every row shows what happened to it
 * ("Added to Q4 founders", "Not added: unsubscribed") and new rows can keep flowing
 * automatically. Sending to the same campaign or list again reuses its column instead
 * of adding another.
 */
export interface PushOptions {
  /** 'campaign' attaches leads to config.campaignId; 'leads' only creates/updates leads (and the list in config.listId). */
  dest: 'campaign' | 'leads';
  /** Field mapping from OutreachForm (email, firstName, …, variables, behavior, listId, campaignId). */
  config: any;
  /** Push only these rows; all rows when omitted. */
  rowIds?: number[];
  /** Name of a verify-email column whose value must be "valid". */
  onlyValidColumn?: string | null;
  auto?: boolean;
  withStatus?: boolean;
  /** Shown in the column name, e.g. the campaign or list name. */
  targetName?: string;
}

export async function pushRows(tableId: number, columns: Column[], o: PushOptions): Promise<{ queued: number; columnId: number }> {
  const kind = o.dest === 'campaign' ? 'outreach_campaign' : 'outreach_update_lead';
  const config = { ...o.config, kind, ...(o.dest === 'leads' ? { campaignId: null } : {}) };
  const same = columns.find((c) => c.type === 'action' && c.config?.kind === kind
    && (o.dest === 'campaign' ? Number(c.config.campaignId) === Number(config.campaignId) : Number(c.config.listId || 0) === Number(config.listId || 0)));
  const run_if = o.onlyValidColumn ? `row[${JSON.stringify(o.onlyValidColumn)}] === "valid"` : null;
  let columnId: number;
  if (same) {
    await api(`/api/gtm/columns/${same.id}`, { method: 'PATCH', body: { config, run_if, ...(o.auto ? { auto_run: true } : {}) } });
    columnId = same.id;
  } else {
    const name = o.dest === 'campaign' ? `→ ${o.targetName ?? 'Campaign'}` : o.targetName ? `→ Leads: ${o.targetName}` : '→ Leads';
    const col = await api(`/api/gtm/tables/${tableId}/columns`, { body: { name, type: 'action', config, auto_run: !!o.auto, run_if } });
    columnId = col.id;
  }
  if (o.withStatus && !columns.some((c) => c.config?.kind === 'outreach_status')) {
    await api(`/api/gtm/tables/${tableId}/columns`, { body: { name: 'Outreach status', type: 'signal', auto_run: true, config: { kind: 'outreach_status', inputs: { email: config.email } } } });
  }
  // Re-sending re-runs rows already pushed (leads are updated, never duplicated).
  const r = await api(`/api/gtm/tables/${tableId}/run`, { body: { columnIds: [columnId], rowIds: o.rowIds, force: !!same || !!o.rowIds } });
  return { queued: r.queued ?? 0, columnId };
}

/** Download chosen rows (in the given order) as CSV. */
export async function downloadRowsCsv(tableId: number, ids: number[], fileName: string) {
  const res = await fetch(`/api/gtm/tables/${tableId}/export.csv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: `${fileName.replace(/[^\w.-]+/g, '_')}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
