import { useEffect, useMemo, useRef } from 'react';
import { HotTable, type HotTableRef } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import type Handsontable from 'handsontable';
import { display, TYPE_META, type Column, type RowView } from '../lib/api';
import { iconHtml } from './Icon';

registerAllModules();

interface Props {
  columns: Column[];
  rows: RowView[];
  onEditColumn: (col: Column) => void;
  onAddColumn: () => void;
  onSelectCell: (rowId: number, colId: number) => void;
  onEdit: (changes: { rowId: number; columnId: number; value: string }[]) => void;
  onRun: (rowIds: number[], columnIds: number[], force: boolean) => void;
  onDeleteRows: (rowIds: number[]) => void;
  onAddRows: (count: number) => void;
  onResize: (colId: number, width: number) => void;
  onSaveAsFunction?: (columnIds: number[]) => void;
}

export function Grid(props: Props) {
  const hot = useRef<HotTableRef>(null);
  // Renderers and hooks read the latest props through refs so Handsontable settings stay stable.
  const ref = useRef(props);
  ref.current = props;

  const data = useMemo(
    () => props.rows.map((r) => [...props.columns.map((c) => display(r.cells[c.id]?.value)), '']),
    [props.rows, props.columns],
  );

  const settings = useMemo(() => {
    const renderer = function (this: unknown, instance: Handsontable.Core, td: HTMLTableCellElement, row: number, col: number, _prop: unknown, value: unknown) {
      const { rows, columns } = ref.current;
      const physical = instance.toPhysicalRow(row);
      const column = columns[col];
      const cell = column ? rows[physical]?.cells[column.id] : undefined;
      const status = cell?.status ?? 'idle';
      td.className = `ks-cell st-${status} t-${column?.type ?? 'text'}`;
      td.title = cell?.error ?? '';
      const text = value == null ? '' : String(value);
      const runnable = column && column.type !== 'text';
      if (status === 'queued') td.innerHTML = `<span class="st">${iconHtml('clock', 13)} Queued</span>`;
      else if (status === 'running') td.innerHTML = '<span class="st"><span class="spinner"></span> Running</span>';
      else if (status === 'error') td.innerHTML = `<span class="err">${iconHtml('alert', 13)} ${esc(cell?.error ?? 'Error')}</span>`;
      else if (status === 'skipped') td.innerHTML = `<span class="muted">${text ? esc(text) : 'Skipped'}</span>`;
      else if (status === 'empty') td.innerHTML = '<span class="muted">No result</span>';
      else if (runnable && status === 'idle' && !text) td.innerHTML = `<span class="notrun">${iconHtml('play', 11)} Not run</span>`;
      else if (/^https?:\/\//.test(text)) td.innerHTML = `<a href="${esc(text)}" target="_blank" rel="noreferrer">${esc(text.replace(/^https?:\/\/(www\.)?/, ''))}</a>`;
      else td.textContent = text;
      if (cell?.changed_at && column?.type === 'signal' && Date.now() - Date.parse(cell.changed_at) < 7 * 86_400_000) {
        td.insertAdjacentHTML('afterbegin', '<span class="changed" title="Changed in the last 7 days"></span>');
      }
      if (cell?.provider && status === 'done' && column?.type === 'enrich') td.insertAdjacentHTML('beforeend', `<span class="prov">${esc(cell.provider.replace(/ \(.*\)$/, ''))}</span>`);
      return td;
    };
    const addRenderer = function (this: unknown, _i: Handsontable.Core, td: HTMLTableCellElement) {
      td.className = 'add-col-cell';
      td.textContent = '';
      return td;
    };
    return { renderer, addRenderer };
  }, []);

  const selected = () => {
    const h = hot.current?.hotInstance;
    const { rows, columns } = ref.current;
    const rowIds = new Set<number>();
    const colIds = new Set<number>();
    for (const [r1, c1, r2, c2] of h?.getSelected() ?? []) {
      for (let r = Math.max(0, Math.min(r1, r2)); r <= Math.max(r1, r2); r++) {
        const p = h!.toPhysicalRow(r);
        if (rows[p]) rowIds.add(rows[p].id);
      }
      for (let c = Math.max(0, Math.min(c1, c2)); c <= Math.max(c1, c2); c++) if (columns[c]) colIds.add(columns[c].id);
    }
    return { rowIds: [...rowIds], colIds: [...colIds] };
  };

  useEffect(() => {
    // Keep the grid's column widths in sync with saved widths after column changes.
    hot.current?.hotInstance?.render();
  }, [props.rows]);

  return (
    <HotTable
      ref={hot}
      data={data}
      themeName="ht-theme-main"
      licenseKey="non-commercial-and-evaluation"
      height="100%"
      width="100%"
      rowHeaders
      rowHeights={36}
      columnHeaderHeight={38}
      colHeaders={[
        ...props.columns.map((c) => `<span class="col-h"><span class="ty ty-${c.type}" title="${TYPE_META[c.type].label}">${iconHtml(TYPE_META[c.type].icon, 12)}</span><span class="nm">${esc(c.name)}</span>${c.auto_run && c.type !== 'text' ? `<span class="auto" title="Auto-runs when inputs change">${iconHtml('bolt', 12)}</span>` : ''}<span class="col-menu" title="Edit column">${iconHtml('more', 14)}</span></span>`),
        `<span class="add-col-h">${iconHtml('plus', 14)} Add column</span>`,
      ]}
      colWidths={[...props.columns.map((c) => c.width ?? (c.type === 'text' ? 170 : 210)), 150]}
      columns={[
        ...props.columns.map((c) => ({ readOnly: c.type !== 'text', renderer: settings.renderer })),
        { readOnly: true, renderer: settings.addRenderer, columnSorting: { indicator: false, headerAction: false } as any },
      ]}
      manualColumnResize
      columnSorting
      filters
      dropdownMenu={['filter_by_condition', 'filter_by_value', 'filter_action_bar', '---------',
        { key: 'save_fn', name: 'Save columns as function…', callback: () => ref.current.onSaveAsFunction?.(selected().colIds) }] as any}
      autoWrapRow
      autoWrapCol
      outsideClickDeselects={false}
      stretchH="none"
      wordWrap={false}
      afterOnCellMouseDown={(event, coords) => {
        const target = event.target as HTMLElement;
        if (coords.row !== -1) return;
        if (coords.col === ref.current.columns.length || target.closest('.add-col-h')) { ref.current.onAddColumn(); return; }
        const col = ref.current.columns[coords.col ?? -1];
        if (col && (target.closest('.col-menu') || (event as MouseEvent).detail === 2)) ref.current.onEditColumn(col);
      }}
      afterSelectionEnd={(row, col) => {
        if (row < 0 || col < 0) return;
        const h = hot.current?.hotInstance;
        const r = ref.current.rows[h!.toPhysicalRow(row)];
        const c = ref.current.columns[col];
        if (r && c) ref.current.onSelectCell(r.id, c.id);
      }}
      afterChange={(changes, source) => {
        if (!changes || source === 'loadData' || source === 'updateData') return;
        const h = hot.current?.hotInstance;
        const out: { rowId: number; columnId: number; value: string }[] = [];
        for (const [row, prop, oldV, newV] of changes) {
          if (oldV === newV) continue;
          const r = ref.current.rows[h!.toPhysicalRow(row)];
          const c = ref.current.columns[Number(prop)];
          if (r && c?.type === 'text') out.push({ rowId: r.id, columnId: c.id, value: String(newV ?? '') });
        }
        if (out.length) ref.current.onEdit(out);
      }}
      afterColumnResize={(width, col) => {
        const c = ref.current.columns[col];
        if (c) ref.current.onResize(c.id, Math.round(width));
      }}
      contextMenu={{
        items: {
          run: { name: '▶ Run selected cells', callback: () => { const s = selected(); ref.current.onRun(s.rowIds, s.colIds, false); } },
          rerun: { name: '↻ Re-run selected cells', callback: () => { const s = selected(); ref.current.onRun(s.rowIds, s.colIds, true); } },
          sp1: '---------',
          add1: { name: 'Add row', callback: () => ref.current.onAddRows(1) },
          add10: { name: 'Add 10 rows', callback: () => ref.current.onAddRows(10) },
          del: { name: 'Delete selected rows', callback: () => { const s = selected(); if (s.rowIds.length && confirm(`Delete ${s.rowIds.length} row(s)?`)) ref.current.onDeleteRows(s.rowIds); } },
          sp2: '---------',
          savefn: { name: 'Save selected columns as function…', callback: () => ref.current.onSaveAsFunction?.(selected().colIds) },
          sp3: '---------',
          copy: {},
        } as any,
      }}
    />
  );
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
