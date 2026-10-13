import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, type Catalog, type CellView, type Column, type ColumnType, type TableView } from '../lib/api';
import { Grid } from '../components/Grid';
import { ColumnEditor } from '../components/ColumnEditor';
import { CellPanel } from '../components/CellPanel';
import { EnrichmentPicker } from '../components/EnrichmentPicker';
import { ImportDialog, ScheduleDialog, SendRowsDialog, SignalPackDialog } from '../components/Dialogs';
import { downloadRowsCsv } from '../lib/push';
import type { GridApi } from '../components/Grid';
import { Icon } from '../components/Icon';
import { SaveAsFunctionDialog } from '../components/SaveAsFunctionDialog';
import { useEventStream } from '../../lib/useEventStream';
import { Popover } from '../../components/ui';

/** Runs that may use paid credits on more rows than this ask first, showing the estimate. */
const PAID_CONFIRM_ROWS = 10;

type Panel =
  | { kind: 'picker' }
  | { kind: 'editor'; column: Column | null; type?: ColumnType; config?: any; name?: string }
  | { kind: 'cell'; rowId: number; colId: number }
  | null;

export function TablePage({ tableId, catalog, tables, onTablesChanged }: { tableId: number; catalog: Catalog; tables: any[]; onTablesChanged: () => void }) {
  const [view, setView] = useState<TableView | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cellVersion, setCellVersion] = useState(0);
  const loc = useLocation();
  const navigate = useNavigate();
  const [fnColumns, setFnColumns] = useState<number[] | null>(null);
  const [dialog, setDialog] = useState<'import' | 'schedule' | 'signals' | 'campaign' | 'leads' | null>(() => (loc.search.includes('signals=1') ? 'signals' : loc.search.includes('campaign=1') ? 'campaign' : null));
  const [sel, setSel] = useState<{ rowIds: number[]; whole: boolean }>({ rowIds: [], whole: false });
  const [visible, setVisible] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLSpanElement>(null);
  const closeExport = useCallback(() => setExportOpen(false), []);
  const grid = useRef<GridApi | null>(null);
  const [queue, setQueue] = useState({ pending: 0, running: 0 });
  const [toast, setToast] = useState('');
  const pending = useRef(new Map<string, { rowId: number; columnId: number; cell: CellView }>());
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const load = useCallback(async () => {
    const v = await api<TableView>(`/api/gtm/tables/${tableId}`);
    setView(v);
    setQueue(v.queue);
  }, [tableId]);

  useEffect(() => { void load(); setSel({ rowIds: [], whole: false }); setVisible(null); }, [load]);
  useEffect(() => { if (loc.search) navigate(`/tables/${tableId}`, { replace: true }); }, [tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates (only while the tab is visible): cell events are batched into one state update per animation frame.
  const frame = useRef(0);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  const flush = () => {
    frame.current = 0;
    const batch = [...pending.current.values()];
    pending.current.clear();
    setView((v) => {
      if (!v) return v;
      const byRow = new Map<number, typeof batch>();
      for (const e of batch) byRow.set(e.rowId, [...(byRow.get(e.rowId) ?? []), e]);
      return { ...v, rows: v.rows.map((r) => (byRow.has(r.id) ? { ...r, cells: { ...r.cells, ...Object.fromEntries(byRow.get(r.id)!.map((e) => [e.columnId, e.cell])) } } : r)) };
    });
    const p = panelRef.current;
    if (p?.kind === 'cell' && batch.some((e) => e.rowId === p.rowId && e.columnId === p.colId)) setCellVersion((x) => x + 1);
  };
  useEventStream(`/api/gtm/tables/${tableId}/events`, (e) => {
    if (e.type === 'cell') {
      pending.current.set(`${e.rowId}:${e.columnId}`, e);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    } else if (e.type === 'rows' || e.type === 'columns') { void load(); onTablesChanged(); }
    else if (e.type === 'queue') setQueue({ pending: e.pending, running: e.running });
  }, () => { void load(); });

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  /** Runs cells; when paid vendors could be used on more than a few rows, confirms with the worst-case estimate first. */
  const run = async (body: { columnIds?: number[]; rowIds?: number[]; force?: boolean }, question?: string) => {
    const est = await api<{ paidCells: number; summary: string }>(`/api/gtm/tables/${tableId}/run/estimate`, { body }).catch(() => null);
    const paid = est && est.paidCells > PAID_CONFIRM_ROWS ? est.summary : '';
    if ((question || paid) && !confirm([question, paid, paid && 'Run now?'].filter(Boolean).join('\n\n'))) return;
    const r = await api(`/api/gtm/tables/${tableId}/run`, { body });
    flash(r.queued ? `Running ${r.queued} cell${r.queued === 1 ? '' : 's'}` : 'Nothing new to run — right-click cells to re-run');
  };

  if (!view) return <div className="loading">Loading…</div>;
  const total = view.rows.length;
  const filtered = visible != null && visible < total;
  // A selection bar for several rows, or whole rows picked from the row numbers.
  const picked = sel.rowIds.length > 1 || sel.whole ? sel.rowIds : [];
  const plural = (n: number) => `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
  const visibleIds = () => grid.current?.visibleRowIds() ?? view.rows.map((r) => r.id);
  const exportRows = async (ids: number[] | null) => {
    setExportOpen(false);
    try {
      if (!ids) { window.location.href = `/api/gtm/tables/${tableId}/export.csv`; return; }
      await downloadRowsCsv(tableId, ids, view.table.name);
    } catch (e: any) { flash(e.message); }
  };
  const deleteRows = async (ids: number[]) => {
    if (!ids.length || !confirm(`Delete ${plural(ids.length)}? Leads already created from them are kept.`)) return;
    await api(`/api/gtm/tables/${tableId}/rows`, { method: 'DELETE', body: { ids } });
    grid.current?.deselect();
    setSel({ rowIds: [], whole: false });
    flash(`Deleted ${plural(ids.length)}`);
  };
  const addRow = async () => {
    await api(`/api/gtm/tables/${tableId}/rows`, { body: { count: 1 } });
    flash('Row added at the bottom — click a cell to type');
  };
  const scopes = [
    { id: 'all', label: `All ${plural(total)}` },
    ...(filtered ? [{ id: 'visible', label: `Rows shown by your filters (${plural(visible!)})`, rowIds: visibleIds() }] : []),
    ...(picked.length ? [{ id: 'selected', label: `Selected rows (${plural(picked.length)})`, rowIds: picked }] : []),
  ];
  const busy = queue.pending + queue.running;
  const runnable = view.columns.filter((c) => c.type !== 'text');
  const selColumn = panel?.kind === 'cell' ? view.columns.find((c) => c.id === panel.colId) : undefined;

  return (
    <div className="table-page">
      <div className="topbar">
        <div className="crumbs">
          <Link to="/">Tables</Link><Icon name="chevronRight" size={14} />
          <input className="title-input" defaultValue={view.table.name} key={`${view.table.id}-${view.table.name}`} size={Math.max(12, view.table.name.length)}
            onBlur={async (e) => { if (e.target.value.trim() && e.target.value !== view.table.name) { await api(`/api/gtm/tables/${tableId}`, { method: 'PATCH', body: { name: e.target.value.trim() } }); onTablesChanged(); } }} />
        </div>
        <span className="grow" />
        {busy > 0 && (
          <span className="queue"><span className="spinner" />{queue.running} running · {queue.pending} queued
            <button className="ghost sm" onClick={() => api(`/api/gtm/tables/${tableId}/stop`, { body: {} })}><Icon name="stop" size={12} />Stop</button>
          </span>
        )}
        <button onClick={() => setDialog('import')} title="Import a CSV, pull from a source or a webhook"><Icon name="upload" size={15} />Import</button>
        <button onClick={addRow} title="Add a blank row"><Icon name="plus" size={15} />Row</button>
        <button onClick={() => setDialog('leads')} disabled={!total} title="Turn rows into leads in a lead list, ready for a campaign"><Icon name="send" size={15} />Send to leads</button>
        <button onClick={() => setDialog('campaign')} disabled={!total} title="Push rows straight into an outreach campaign"><Icon name="send" size={15} />Send to campaign</button>
        <button className="primary" onClick={() => setPanel({ kind: 'picker' })}><Icon name="plus" size={15} />Add enrichment</button>
      </div>

      <div className="subbar">
        <span className="meta-pill"><Icon name="table" size={14} />{filtered ? `${visible!.toLocaleString()} of ${total.toLocaleString()} rows` : `${total.toLocaleString()} rows`} · {view.columns.length} columns</span>
        {filtered && <button className="ghost sm" onClick={() => grid.current?.clearFilters()} title="Show every row again">Clear filters</button>}
        <span className="sep" />
        <button className="ghost sm" onClick={() => run({})} title="Run every cell that hasn't run yet"><Icon name="play" size={13} />Run all</button>
        <button className="ghost sm" onClick={() => setDialog('signals')} title="Add signal monitors and alerts"><Icon name="radar" size={14} />Signals</button>
        <button className="ghost sm" onClick={() => setDialog('schedule')} title="Re-run columns on a schedule">
          <Icon name="clock" size={14} />{view.table.schedule?.enabled ? `Every ${fmtEvery(view.table.schedule.everyMinutes)}` : 'Schedule'}
        </button>
        <span ref={exportRef} style={{ position: 'relative' }}>
          <button className="ghost sm" onClick={() => setExportOpen((o) => !o)} disabled={!total} title="Download as CSV"><Icon name="download" size={14} />Export CSV</button>
          <Popover anchor={exportRef.current} open={exportOpen} onClose={closeExport}>
            <div className="menu-pop" style={{ minWidth: 230, background: 'var(--bg, #fff)', border: '1px solid var(--border, #e4e4e7)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.08)', padding: 4 }}>
              <button className="ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => exportRows(null)}>All {plural(total)}</button>
              {filtered && <button className="ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => exportRows(visibleIds())}>Filtered rows ({plural(visible!)})</button>}
              {picked.length > 0 && <button className="ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => exportRows(picked)}>Selected rows ({plural(picked.length)})</button>}
              {!filtered && <button className="ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => exportRows(visibleIds())} title="In the order shown, after sorting">As sorted on screen</button>}
            </div>
          </Popover>
        </span>
        <Link className="btn ghost sm" style={{ border: 'none', boxShadow: 'none', color: 'var(--text-2)', background: 'transparent' }} to="/settings/functions" title="Reusable enrichment recipes — add one as a column, or save columns as one from Column actions"><Icon name="fn" size={14} />Functions</Link>
        {runnable.length > 0 && <span className="sep" />}
        {runnable.length > 0 && (
          <select
            style={{ width: 'auto', height: 26, fontSize: 12.5, color: 'var(--text-2)' }}
            value=""
            onChange={(e) => {
              const [mode, id] = e.target.value.split(':');
              const col = runnable.find((c) => c.id === Number(id));
              if (!col) return;
              if (mode === 'edit') setPanel({ kind: 'editor', column: col });
              else if (mode === 'fn') setFnColumns([col.id]);
              else if (mode === 'run') void run({ columnIds: [col.id] });
              else void run({ columnIds: [col.id], force: true }, `Re-run "${col.name}" for all ${view.rows.length} rows?`);
            }}
          >
            <option value="">Column actions…</option>
            {runnable.map((c) => (
              <optgroup key={c.id} label={c.name}>
                <option value={`run:${c.id}`}>Run empty cells</option>
                <option value={`force:${c.id}`}>Re-run all rows</option>
                <option value={`edit:${c.id}`}>Edit column</option>
                <option value={`fn:${c.id}`}>Save as function…</option>
              </optgroup>
            ))}
          </select>
        )}
      </div>

      {picked.length > 0 && (
        <div className="subbar selbar" role="toolbar" aria-label="Selected rows" style={{ background: 'var(--accent-soft, #eef2ff)' }}>
          <b style={{ fontSize: 12.5 }}>{plural(picked.length)} selected</b>
          <span className="sep" />
          <button className="ghost sm" onClick={() => run({ rowIds: picked })} title="Run every column that hasn't run for these rows"><Icon name="play" size={13} />Run</button>
          <button className="ghost sm" onClick={() => setDialog('leads')}><Icon name="send" size={13} />Send to leads</button>
          <button className="ghost sm" onClick={() => setDialog('campaign')}><Icon name="send" size={13} />Send to campaign</button>
          <button className="ghost sm" onClick={() => exportRows(picked)}><Icon name="download" size={13} />Export CSV</button>
          <button className="ghost sm" style={{ color: 'var(--red, #dc2626)' }} onClick={() => deleteRows(picked)}><Icon name="trash" size={13} />Delete</button>
          <span className="grow" />
          <button className="ghost sm" onClick={() => { grid.current?.deselect(); setSel({ rowIds: [], whole: false }); }}><Icon name="x" size={13} />Clear selection</button>
        </div>
      )}

      <div className="workspace">
        <div className="grid-wrap">
          {view.rows.length === 0 ? (
            <div className="empty">
              <h3>This table is empty</h3>
              <p>Import a CSV, pull companies, people or jobs for free, POST to the table's webhook — or add rows and paste.</p>
              <div className="row-flex center">
                <button className="primary" onClick={() => setDialog('import')}><Icon name="upload" size={15} />Add rows</button>
                <button onClick={() => api(`/api/gtm/tables/${tableId}/rows`, { body: { count: 10 } })}>Add 10 blank rows</button>
              </div>
            </div>
          ) : (
            <Grid
              columns={view.columns}
              rows={view.rows}
              onEditColumn={(c) => setPanel({ kind: 'editor', column: c })}
              onAddColumn={() => setPanel({ kind: 'picker' })}
              onSelectCell={(rowId, colId, how) => setPanel((p) => (p?.kind === 'editor' || p?.kind === 'picker' ? p : how === 'move' && p?.kind !== 'cell' ? p : { kind: 'cell', rowId, colId }))}
              onEdit={(changes) => api(`/api/gtm/tables/${tableId}/cells`, { method: 'PATCH', body: { changes } }).then(load)}
              onRun={(rowIds, columnIds, force) => run({ rowIds, columnIds, force })}
              onDeleteRows={(ids) => api(`/api/gtm/tables/${tableId}/rows`, { method: 'DELETE', body: { ids } })}
              // Skip no-op updates: a re-render mid-click rebuilds the headers and swallows the filter-menu click.
              onSelectionChange={(n) => setSel((o) => (o.whole === n.whole && o.rowIds.length === n.rowIds.length && o.rowIds.every((id, i) => id === n.rowIds[i]) ? o : n))}
              onFilterChange={setVisible}
              apiRef={grid}
              onAddRows={(count) => api(`/api/gtm/tables/${tableId}/rows`, { body: { count } })}
              onResize={(colId, width) => api(`/api/gtm/columns/${colId}`, { method: 'PATCH', body: { width } })}
              onSaveAsFunction={(ids) => setFnColumns(ids)}
            />
          )}
        </div>
        {panel?.kind === 'picker' && (
          <EnrichmentPicker catalog={catalog} onClose={() => setPanel(null)} onPick={(p) => setPanel({ kind: 'editor', column: null, type: p.type, name: p.name, config: p.config ?? (p.kind ? { kind: p.kind } : undefined) })} />
        )}
        {panel?.kind === 'editor' && (
          <ColumnEditor
            key={panel.column?.id ?? `new-${panel.type}-${panel.config?.kind ?? ''}-${panel.name ?? ''}`}
            tableId={tableId}
            column={panel.column}
            initialType={panel.type}
            initialConfig={panel.config}
            initialName={panel.name}
            columns={view.columns}
            catalog={catalog}
            onClose={() => setPanel(null)}
            onSaved={async (colId, runNow) => {
              const wasNew = !panel.column;
              setPanel(null);
              await load();
              if (runNow) await run({ columnIds: [colId], force: !wasNew });
            }}
          />
        )}
        {panel?.kind === 'cell' && selColumn && (
          <CellPanel
            rowId={panel.rowId}
            column={selColumn}
            version={cellVersion}
            onClose={() => setPanel(null)}
            onRun={() => run({ rowIds: [panel.rowId], columnIds: [panel.colId], force: true })}
            onAddExtract={(path) => setPanel({ kind: 'editor', column: null, type: 'extract', name: `${selColumn.name} · ${path}`, config: { source: selColumn.name, path } })}
          />
        )}
      </div>

      <div className="tabs-bar">
        {tables.map((t) => (
          <Link key={t.id} to={`/tables/${t.id}`} className={`btn tab ${t.id === tableId ? 'on' : ''}`}><Icon name="table" size={13} />{t.name}</Link>
        ))}
        <Link to="/" className="btn tab" title="New table"><Icon name="plus" size={13} /></Link>
      </div>

      {dialog === 'import' && <ImportDialog tableId={tableId} webhookUrl={view.table.webhookUrl} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'signals' && <SignalPackDialog tableId={tableId} columns={view.columns} catalog={catalog} onClose={() => setDialog(null)} onDone={load} />}
      {(dialog === 'campaign' || dialog === 'leads') && (
        <SendRowsDialog tableId={tableId} tableName={view.table.name} columns={view.columns} scopes={scopes} initialDest={dialog}
          onClose={() => setDialog(null)} onDone={(m) => { flash(m); void load(); }} />
      )}
      {dialog === 'schedule' && <ScheduleDialog tableId={tableId} schedule={view.table.schedule} columns={view.columns} onClose={() => setDialog(null)} onSaved={load} />}
      {fnColumns && <SaveAsFunctionDialog tableId={tableId} columns={view.columns} initialIds={fnColumns} onClose={() => setFnColumns(null)} onDone={() => { setFnColumns(null); void load(); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function fmtEvery(m: number) {
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}
