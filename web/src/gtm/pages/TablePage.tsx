import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api, type Catalog, type CellView, type Column, type ColumnType, type TableView } from '../lib/api';
import { Grid } from '../components/Grid';
import { ColumnEditor } from '../components/ColumnEditor';
import { CellPanel } from '../components/CellPanel';
import { EnrichmentPicker } from '../components/EnrichmentPicker';
import { ImportDialog, ScheduleDialog, SendToCampaignDialog, SignalPackDialog } from '../components/Dialogs';
import { Icon } from '../components/Icon';
import { SaveAsFunctionDialog } from '../components/SaveAsFunctionDialog';

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
  const [dialog, setDialog] = useState<'import' | 'schedule' | 'signals' | 'campaign' | null>(() => (loc.search.includes('signals=1') ? 'signals' : loc.search.includes('campaign=1') ? 'campaign' : null));
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

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (loc.search) navigate(`/tables/${tableId}`, { replace: true }); }, [tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: cell events are batched into one state update per animation frame.
  useEffect(() => {
    const es = new EventSource(`/api/gtm/tables/${tableId}/events`);
    let frame = 0;
    const flush = () => {
      frame = 0;
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
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'cell') {
        pending.current.set(`${e.rowId}:${e.columnId}`, e);
        if (!frame) frame = requestAnimationFrame(flush);
      } else if (e.type === 'rows' || e.type === 'columns') { void load(); onTablesChanged(); }
      else if (e.type === 'queue') setQueue({ pending: e.pending, running: e.running });
    };
    return () => { es.close(); if (frame) cancelAnimationFrame(frame); };
  }, [tableId, load, onTablesChanged]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  const run = async (body: { columnIds?: number[]; rowIds?: number[]; force?: boolean }) => {
    const r = await api(`/api/gtm/tables/${tableId}/run`, { body });
    flash(r.queued ? `Running ${r.queued} cell${r.queued === 1 ? '' : 's'}` : 'Nothing new to run — right-click cells to re-run');
  };

  if (!view) return <div className="loading">Loading…</div>;
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
        <button onClick={() => setDialog('import')}><Icon name="upload" size={15} />Add rows</button>
        <button onClick={() => setDialog('campaign')} disabled={!view.rows.length} title="Push rows into an outreach campaign"><Icon name="send" size={15} />Send to campaign</button>
        <button className="primary" onClick={() => setPanel({ kind: 'picker' })}><Icon name="plus" size={15} />Add enrichment</button>
      </div>

      <div className="subbar">
        <span className="meta-pill"><Icon name="table" size={14} />{view.rows.length.toLocaleString()} rows · {view.columns.length} columns</span>
        <span className="sep" />
        <button className="ghost sm" onClick={() => run({})} title="Run every cell that hasn't run yet"><Icon name="play" size={13} />Run all</button>
        <button className="ghost sm" onClick={() => setDialog('signals')} title="Add signal monitors and alerts"><Icon name="radar" size={14} />Signals</button>
        <button className="ghost sm" onClick={() => setDialog('schedule')} title="Re-run columns on a schedule">
          <Icon name="clock" size={14} />{view.table.schedule?.enabled ? `Every ${fmtEvery(view.table.schedule.everyMinutes)}` : 'Schedule'}
        </button>
        <a className="btn ghost sm" style={{ border: 'none', boxShadow: 'none', color: 'var(--text-2)', background: 'transparent' }} href={`/api/gtm/tables/${tableId}/export.csv`}><Icon name="download" size={14} />Export</a>
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
              else if (confirm(`Re-run "${col.name}" for all ${view.rows.length} rows?`)) void run({ columnIds: [col.id], force: true });
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
              onSelectCell={(rowId, colId) => setPanel((p) => (p?.kind === 'editor' || p?.kind === 'picker' ? p : { kind: 'cell', rowId, colId }))}
              onEdit={(changes) => api(`/api/gtm/tables/${tableId}/cells`, { method: 'PATCH', body: { changes } }).then(load)}
              onRun={(rowIds, columnIds, force) => run({ rowIds, columnIds, force })}
              onDeleteRows={(ids) => api(`/api/gtm/tables/${tableId}/rows`, { method: 'DELETE', body: { ids } })}
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
      {dialog === 'campaign' && <SendToCampaignDialog tableId={tableId} columns={view.columns} onClose={() => setDialog(null)} onDone={(m) => { flash(m); void load(); }} />}
      {dialog === 'schedule' && <ScheduleDialog tableId={tableId} schedule={view.table.schedule} columns={view.columns} onClose={() => setDialog(null)} onSaved={load} />}
      {fnColumns && <SaveAsFunctionDialog tableId={tableId} columns={view.columns} initialIds={fnColumns} onClose={() => setFnColumns(null)} onDone={() => { setFnColumns(null); void load(); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function fmtEvery(m: number) {
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}
