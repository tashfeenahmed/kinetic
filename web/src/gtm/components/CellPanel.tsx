import { useEffect, useState } from 'react';
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
        <div className="headline">{display(v) || <span className="muted">—</span>}</div>
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

function Val({ v }: { v: unknown }) {
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return <a href={v} target="_blank" rel="noreferrer">{v}</a>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object')) return <>{v.join(', ')}</>;
    return <details><summary>{v.length} items</summary><pre>{JSON.stringify(v, null, 2)}</pre></details>;
  }
  if (v && typeof v === 'object') return <details><summary>object</summary><pre>{JSON.stringify(v, null, 2)}</pre></details>;
  return <>{String(v)}</>;
}
