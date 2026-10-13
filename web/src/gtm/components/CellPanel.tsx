import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from './Icon';
import { api, display, type Column } from '../lib/api';

interface Props {
  rowId: number;
  column: Column;
  version: number; // bump to refetch when the cell changes
  onClose: () => void;
  onRun: () => void;
  onAddExtract: (path: string) => void;
}

export function CellPanel({ rowId, column, version, onClose, onRun, onAddExtract }: Props) {
  const [cell, setCell] = useState<any>(null);
  useEffect(() => { api(`/api/gtm/cells/${rowId}/${column.id}`).then(setCell).catch(() => setCell(null)); }, [rowId, column.id, version]);
  if (!cell) return null;

  const v = cell.value;
  const data = v && typeof v === 'object' && !Array.isArray(v) ? (v.data ?? (('value' in v) ? null : v)) : null;
  const fields = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.entries(data).filter(([k, x]) => k !== 'raw' && k !== 'text' && x != null && x !== '')
    : [];
  const meta = cell.meta ?? {};

  return (
    <aside className="drawer cellpanel">
      <header>
        <h3>{column.name} <span className={`status st-${cell.status}`}>{cell.status}</span></h3>
        <button className="ghost icon-btn sm" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="drawer-body">
        {cell.error && <p className="err">{cell.error}</p>}
        <div className="headline"><LinkOrText text={display(v)} /></div>
        {v?.confidence && <p className="hint">Confidence: {v.confidence}</p>}
        {v?.provider && <p className="hint">Found by: <b>{v.provider}</b></p>}
        {cell.changed_at && <p className="hint">Last changed {new Date(cell.changed_at).toLocaleString()}{cell.prev_value != null && <> · was <code>{display(cell.prev_value).slice(0, 80)}</code></>}</p>}

        {fields.length > 0 && (
          <section>
            <h4>Fields</h4>
            <table className="kv">
              <tbody>
                {fields.map(([k, x]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td><Val v={x} /></td>
                    <td><button className="ghost sm" title="Add as column" onClick={() => onAddExtract(k)}>+ col</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {Array.isArray(meta.attempts) && (
          <section>
            <h4>Waterfall</h4>
            <table className="kv">
              <tbody>{meta.attempts.map((a: any, i: number) => <tr key={i}><th>{a.provider}</th><td className={a.result === 'found' ? 'ok' : a.result.startsWith('error') ? 'err' : 'muted'}>{a.result}</td><td className="muted">{a.ms ? `${a.ms}ms` : ''}</td></tr>)}</tbody>
            </table>
          </section>
        )}

        {Array.isArray(meta.steps) && (
          <section>
            <h4>Agent steps · {meta.provider}</h4>
            <ol className="steps">{meta.steps.map((s: any, i: number) => <li key={i} className={s.ok ? '' : 'err'}><b>{s.tool}</b> {String(s.input).slice(0, 120)}</li>)}</ol>
            {meta.usage && <p className="hint">{meta.usage.prompt + meta.usage.completion} tokens{meta.usage.costUsd ? ` · $${meta.usage.costUsd.toFixed(5)}` : ''}</p>}
          </section>
        )}
        {Array.isArray(meta.functionSteps) && (
          <section>
            <h4>Function steps · <Link to={`/settings/functions/${meta.functionId}`}>{meta.provider}</Link></h4>
            <table className="kv">
              <tbody>{meta.functionSteps.map((s: any, i: number) => (
                <tr key={i}>
                  <th>{s.name}<br /><small className="muted">{s.type}{s.provider ? ` · ${s.provider}` : ''}</small></th>
                  <td className={s.status === 'done' ? 'ok' : s.status === 'error' ? 'err' : 'muted'}>{s.status === 'done' ? (display(s.value) || 'done') : s.error ? `${s.status}: ${s.error}` : s.status}</td>
                  <td className="muted nowrap">{s.ms}ms</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        )}
        {(column.type === 'lookup' || column.config?.kind === 'send_to_table') && meta.tableId && (
          <p className="hint">{column.type === 'lookup' ? `${meta.matched ?? 0} matching row${meta.matched === 1 ? '' : 's'} (${meta.mode})` : `${meta.rowIds?.length ?? 0} target row${meta.rowIds?.length === 1 ? '' : 's'}`} in <Link to={`/tables/${meta.tableId}`}>{meta.provider === 'send_to_table' ? 'the target table' : meta.provider}</Link></p>
        )}

        {(v?.sources ?? meta.sources)?.length > 0 && (
          <section>
            <h4>Sources</h4>
            <ul className="sources">{(v?.sources ?? meta.sources).map((s: string) => <li key={s}><a href={s} target="_blank" rel="noreferrer">{s}</a></li>)}</ul>
          </section>
        )}

        <details>
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify({ value: cell.value, meta: cell.meta }, null, 2)}</pre>
        </details>
        {meta.ms != null && <p className="hint">Took {meta.ms} ms · updated {new Date(cell.updated_at).toLocaleString()}</p>}
      </div>
      {column.type !== 'text' && (
        <footer><span style={{ flex: 1 }} /><button className="primary" onClick={onRun}>↻ Run this cell</button></footer>
      )}
    </aside>
  );
}

/** Where a cell value should open: web addresses, bare domains/LinkedIn paths and email addresses. */
export function hrefFor(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(t)) return `mailto:${t}`;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}

function LinkOrText({ text }: { text: string }) {
  if (!text) return <span className="muted">—</span>;
  const href = hrefFor(text);
  if (!href) return <>{text}</>;
  return (
    <a href={href} target={href.startsWith('mailto:') ? undefined : '_blank'} rel="noreferrer" className="cell-link">
      {text}<Icon name="external" size={13} />
    </a>
  );
}

function Val({ v }: { v: unknown }) {
  if (typeof v === 'string' && hrefFor(v)) return <LinkOrText text={v} />;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object')) return <>{v.join(', ')}</>;
    return <details><summary>{v.length} items</summary><pre>{JSON.stringify(v, null, 2)}</pre></details>;
  }
  if (v && typeof v === 'object') return <details><summary>object</summary><pre>{JSON.stringify(v, null, 2)}</pre></details>;
  return <>{String(v)}</>;
}
