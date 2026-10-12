/**
 * Column editor sections for cross-table columns: Lookup, Send to table (an action kind)
 * and Function columns. ColumnEditor renders one of these by column type.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, MATCH_MODES, type FnRec, type MatchMode } from '../lib/api';
import { useGtmTables } from '../lib/queries';
import { TemplateInput } from './TemplateInput';
import '../functions.css';

interface FormProps { config: any; set: (patch: any) => void; others: string[] }

/** Columns of a table (names + types), cached per table. */
export function useTableColumns(tableId?: number) {
  return useQuery({
    queryKey: ['gtm-table-columns', tableId],
    queryFn: () => api<{ id: number; name: string; type: string }[]>(`/api/gtm/tables/${tableId}/columns`),
    enabled: !!tableId,
    staleTime: 10_000,
  });
}

export function useFunctions() {
  return useQuery({ queryKey: ['gtm-functions'], queryFn: () => api<FnRec[]>('/api/gtm/functions'), staleTime: 10_000 });
}

/** The match mode a column name suggests. */
function modeFor(column: string): MatchMode {
  if (/e-?mail/i.test(column)) return 'email';
  if (/domain|website|url|site/i.test(column)) return 'domain';
  if (/company|organi[sz]ation|account/i.test(column)) return 'company';
  return 'case_insensitive';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A source column whose name matches `name` (same words, ignoring case and punctuation). */
function sameName(name: string, others: string[]) {
  return others.find((o) => norm(o) === norm(name)) ?? others.find((o) => norm(o).includes(norm(name)) || norm(name).includes(norm(o)));
}

function TableSelect({ value, onChange, currentTableId, label = 'Table' }: { value?: number; onChange: (id: number) => void; currentTableId?: number; label?: string }) {
  const tables = useGtmTables();
  return (
    <label>{label}
      <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        <option value="">Choose a table…</option>
        {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === currentTableId ? ' (this table)' : ''} · {t.row_count} rows</option>)}
      </select>
    </label>
  );
}

// ---------- Lookup ----------

export function LookupForm({ config, set, others, tableId }: FormProps & { tableId: number }) {
  const target = useTableColumns(config.tableId);
  const cols = target.data ?? [];
  useEffect(() => {
    if (config.return === undefined) set({ return: 'first', mode: 'exact', fields: [], value: '', autoRefresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pickMatch = (matchColumn: string) => {
    const mode = matchColumn === '_id' ? 'exact' : modeFor(matchColumn);
    // Same name first, then a column of the same kind (an Email column for a domain match), then a looser name match.
    const src = matchColumn === '_id' ? undefined
      : others.find((o) => norm(o) === norm(matchColumn)) ?? (mode !== 'case_insensitive' ? others.find((o) => modeFor(o) === mode) ?? others.find((o) => mode === 'domain' && modeFor(o) === 'email') : undefined) ?? sameName(matchColumn, others);
    set({ matchColumn, mode, value: config.value || (src ? `{{${src}}}` : '') });
  };
  const fields: string[] = config.fields ?? [];
  const toggle = (n: string) => set({ fields: fields.includes(n) ? fields.filter((f) => f !== n) : [...fields, n] });
  return (
    <>
      <TableSelect value={config.tableId} currentTableId={tableId} label="Look up rows in" onChange={(id) => set({ tableId: id, matchColumn: '', fields: [] })} />
      {config.tableId > 0 && (
        <>
          <div className="form-grid">
            <label>Where column
              <select value={config.matchColumn ?? ''} onChange={(e) => pickMatch(e.target.value)}>
                <option value="">Choose…</option>
                {cols.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                <option value="_id">Row id</option>
              </select>
            </label>
            <label>Matches as
              <select value={config.mode ?? 'exact'} onChange={(e) => set({ mode: e.target.value })}>
                {MATCH_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>
          <label>This row's value<TemplateInput value={config.value ?? ''} onChange={(v) => set({ value: v })} columns={others} placeholder="{{Company domain}}" /></label>
          <label>Return
            <select value={config.return ?? 'first'} onChange={(e) => set({ return: e.target.value })}>
              <option value="first">The first matching row</option>
              <option value="all">All matching rows (a list)</option>
              <option value="count">How many rows match</option>
            </select>
          </label>
          {config.return === 'all' && <label className="inline" style={{ marginTop: 10 }}>Max rows <input type="number" min={1} max={1000} value={config.limit ?? 100} onChange={(e) => set({ limit: Number(e.target.value) })} /></label>}
          {config.return !== 'count' && (
            <fieldset>
              <legend>Fields to return — none selected returns every column; the first is shown in the cell</legend>
              <div className="chips">{cols.map((c) => <button type="button" key={c.id} className={`chip ${fields.includes(c.name) ? 'on' : ''}`} onClick={() => toggle(c.name)}>{c.name}</button>)}</div>
            </fieldset>
          )}
          <label className="check"><input type="checkbox" checked={config.autoRefresh !== false} onChange={(e) => set({ autoRefresh: e.target.checked })} /> Re-run when that table's rows change</label>
          <p className="hint">Each returned field is extractable: <code>{'{{This column.Field}}'}</code> in templates, or click a field in the cell panel and choose “+ col”. The matched row id is in <code>rowId</code>.</p>
        </>
      )}
    </>
  );
}

// ---------- Send to table ----------

export function SendToTableForm({ config, set, others }: FormProps) {
  const target = useTableColumns(config.tableId);
  const targetNames = (target.data ?? []).map((c) => c.name);
  const fields: { name: string; value: string }[] = config.fields ?? [];
  const exploding = !!config.explode?.trim();
  const tokens = exploding ? [...others, 'item', '_index'] : others;
  const upd = (i: number, patch: any) => set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const mapSame = () => {
    const have = new Set(fields.map((f) => f.name));
    const add = targetNames.filter((n) => !have.has(n)).map((n) => ({ name: n, value: sameName(n, others) ? `{{${sameName(n, others)}}}` : '' })).filter((f) => f.value);
    set({ fields: [...fields.filter((f) => f.name || f.value), ...add] });
  };
  return (
    <>
      <TableSelect value={config.tableId} label="Send to table" onChange={(id) => set({ tableId: id })} />
      <label>Explode a list (optional) — one target row per item
        <TemplateInput value={config.explode ?? ''} onChange={(v) => set({ explode: v })} columns={others} placeholder="{{People}}  or  {{Company info.data.people}}" />
      </label>
      {exploding && <p className="hint">Map item fields with <code>{'{{item.name}}'}</code>, <code>{'{{item.email}}'}</code> (or <code>{'{{item}}'}</code> for plain lists) and the position with <code>{'{{_index}}'}</code>. Row columns still work.</p>}
      <fieldset>
        <legend>Fields — target column ← value</legend>
        <datalist id="send-target-cols">{targetNames.map((n) => <option key={n} value={n} />)}</datalist>
        {fields.map((f, i) => (
          <div className="row-flex" key={i}>
            <input list="send-target-cols" style={{ width: 150 }} value={f.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="Target column" />
            <div style={{ flex: 1 }}><TemplateInput value={f.value} onChange={(v) => upd(i, { value: v })} columns={tokens} /></div>
            <button className="ghost sm" onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <div className="row-flex">
          <button className="ghost sm" onClick={() => set({ fields: [...fields, { name: '', value: '' }] })}>+ Map field</button>
          {targetNames.length > 0 && <button className="ghost sm" onClick={mapSame}>Map same-named columns</button>}
        </div>
        <p className="hint">Target columns that don't exist yet are created as text columns.</p>
      </fieldset>
      <fieldset>
        <legend>Duplicates</legend>
        <div className="form-grid">
          <label>Dedupe by target column
            <select value={config.dedupeKey ?? ''} onChange={(e) => set({ dedupeKey: e.target.value, dedupeMode: e.target.value ? modeFor(e.target.value) : undefined })}>
              <option value="">Always create new rows</option>
              {[...new Set([...fields.map((f) => f.name).filter(Boolean), ...targetNames])].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          {config.dedupeKey && (
            <label>Match as
              <select value={config.dedupeMode ?? 'case_insensitive'} onChange={(e) => set({ dedupeMode: e.target.value })}>
                {MATCH_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          )}
        </div>
        {config.dedupeKey && (
          <label>When a matching row exists
            <select value={config.onMatch ?? 'update'} onChange={(e) => set({ onMatch: e.target.value })}>
              <option value="update">Update it with the mapped fields</option>
              <option value="skip">Leave it unchanged</option>
            </select>
          </label>
        )}
      </fieldset>
      <label>Back-reference column (optional) — links each target row to this row
        <input value={config.backRef ?? ''} onChange={(e) => set({ backRef: e.target.value })} placeholder="e.g. Company row" />
      </label>
      <p className="hint">The cell records the target row ids (<code>data.rowIds</code>) so lookups can find them. New target rows run that table's auto-run columns. Rows never flow back to a table they came from.</p>
    </>
  );
}

// ---------- Function column ----------

export function FunctionColumnForm({ config, set, others, onName }: FormProps & { onName: (n: string) => void }) {
  const fns = useFunctions();
  const fn = useMemo(() => fns.data?.find((f) => f.id === Number(config.functionId)), [fns.data, config.functionId]);
  const [def, setDef] = useState(fn?.definition);
  const version = Number(config.version) || fn?.version;
  // The pinned version's definition (inputs may differ from the latest).
  useEffect(() => {
    if (!fn) return;
    if (!version || version === fn.version) { setDef(fn.definition); return; }
    api(`/api/gtm/functions/${fn.id}/versions/${version}`).then((r) => setDef(r.definition)).catch(() => setDef(fn.definition));
  }, [fn, version]);
  const choose = (id: number) => {
    const f = fns.data?.find((x) => x.id === id);
    if (!f) return set({ functionId: null });
    const inputs = Object.fromEntries(f.definition.inputs.map((i) => { const c = sameName(i.name.replace(/_/g, ' '), others); return [i.name, c ? `{{${c}}}` : '']; }));
    set({ functionId: f.id, version: f.version, inputs });
    onName(f.name);
  };
  // Picked from the enrichment picker: map inputs once the function list has loaded.
  useEffect(() => {
    if (fn && config.inputs === undefined) choose(fn.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
  return (
    <>
      <label>Function
        <select value={config.functionId ?? ''} onChange={(e) => choose(Number(e.target.value))}>
          <option value="">Choose a function…</option>
          {(fns.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name} · v{f.version}{f.tags.length ? ` · ${f.tags.join(', ')}` : ''}</option>)}
        </select>
      </label>
      {fns.data?.length === 0 && <p className="hint">No functions yet — <Link to="/functions">create one</Link>, or select columns in a table and choose “Save as function”.</p>}
      {fn && (
        <>
          {fn.description && <p className="hint">{fn.description}</p>}
          {version && version < fn.version ? (
            <p className="warn">Pinned to v{version}; v{fn.version} is available. <button className="sm" onClick={() => set({ version: fn.version })}>Upgrade to v{fn.version}</button></p>
          ) : <p className="hint">Version {version}. <Link to={`/functions/${fn.id}`}>Open in Functions →</Link></p>}
          <fieldset>
            <legend>Inputs</legend>
            {(def?.inputs ?? []).map((i) => (
              <label key={i.name}>{i.name}{i.required ? ' *' : ''}{i.description ? <small className="muted"> — {i.description}</small> : null}
                <TemplateInput value={config.inputs?.[i.name] ?? ''} onChange={(v) => set({ inputs: { ...config.inputs, [i.name]: v } })} columns={others} />
              </label>
            ))}
          </fieldset>
          <p className="hint">Outputs: {(def?.outputs ?? []).map((o) => <code key={o.name} style={{ marginRight: 4 }}>{o.name}</code>)} — extract one with an Extract field column or <code>{'{{Column.output}}'}</code>. Runs {def?.steps.length ?? 0} step{def?.steps.length === 1 ? '' : 's'} per row.</p>
        </>
      )}
    </>
  );
}
