/**
 * Kinetic GTM workbench (tables, enrichment, AI, signals) mounted inside the
 * app router. Pages render inside a `.gtm` wrapper that scopes their styles.
 */
import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useGtmCatalog, useGtmTables } from './lib/queries';
import { TablePage } from './pages/TablePage';
import { Signals } from './pages/Signals';
import { Logs } from './pages/Logs';
import { Settings } from './pages/Settings';
import { FunctionEditor, FunctionsList } from './pages/Functions';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';
import './gtm.css';

export { useGtmCatalog, useGtmTables };

function useRefresh(key: string) {
  const qc = useQueryClient();
  return useCallback(() => { void qc.invalidateQueries({ queryKey: [key] }); }, [qc, key]);
}

const Shell = ({ children }: { children: React.ReactNode }) => <div className="gtm">{children}</div>;
const Waiting = () => <div className="loading">Loading…</div>;

export function GtmTablePage() {
  const { id } = useParams();
  const catalog = useGtmCatalog();
  const tables = useGtmTables();
  const refresh = useRefresh('gtm-tables');
  if (!catalog.data) return <Shell><Waiting /></Shell>;
  return <Shell><TablePage key={id} tableId={Number(id)} catalog={catalog.data} tables={tables.data ?? []} onTablesChanged={refresh} /></Shell>;
}

export function GtmSignalsPage() {
  return <Shell><Signals /></Shell>;
}

/** /functions (library) and /functions/:id (builder, test, stats; "new" for a new one). */
export function GtmFunctionsPage() {
  const { id } = useParams();
  const catalog = useGtmCatalog();
  if (!id) return <Shell><FunctionsList /></Shell>;
  if (!catalog.data) return <Shell><Waiting /></Shell>;
  return <Shell><FunctionEditor key={id} id={id === 'new' ? null : Number(id)} catalog={catalog.data} /></Shell>;
}

export function GtmActivityPage() {
  return <Shell><Logs /></Shell>;
}

/** Settings → "Data, AI & integrations". */
export function GtmKeysSection() {
  const refresh = useRefresh('gtm-catalog');
  return <Shell><Settings embedded onSaved={refresh} /></Shell>;
}
