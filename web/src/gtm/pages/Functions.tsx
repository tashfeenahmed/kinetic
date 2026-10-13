/**
 * Functions library: reusable enrichment recipes (inputs → steps → outputs) that any
 * table can use as a `function` column. List, build, test (sandbox) and stats.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, display, STEP_TYPES, TYPE_META, type Catalog, type Column, type FnDefinition, type FnDetail, type FnStep, type FnTestResult, type StepType } from '../lib/api';
import { useGtmTables } from '../lib/queries';
import { ColumnEditor } from '../components/ColumnEditor';
import { TemplateInput } from '../components/TemplateInput';
import { useFunctions, useTableColumns } from '../components/LinkForms';
import { Icon } from '../components/Icon';
import '../functions.css';

// ---------- list ----------

export function FunctionsList() {
  const fns = useFunctions();
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const tags = useMemo(() => [...new Set((fns.data ?? []).flatMap((f) => f.tags))].sort(), [fns.data]);
  const shown = (fns.data ?? []).filter((f) => !tag || f.tags.includes(tag));
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <div className="crumbs" style={{ marginBottom: 4 }}><Link to="/settings">Settings</Link><Icon name="chevronRight" size={14} /></div>
            <h1>Functions</h1>
            <div className="sub">Reusable enrichment recipes: define inputs, steps and outputs once, then use them as a column in any table.</div>
          </div>
          <button className="primary" onClick={() => navigate('/settings/functions/new')}><Icon name="plus" size={15} />New function</button>
        </div>
        {tags.length > 0 && (
          <div className="filters">
            <button className={`chip ${tag === '' ? 'on' : ''}`} onClick={() => setTag('')}>All</button>
            {tags.map((t) => <button key={t} className={`chip ${tag === t ? 'on' : ''}`} onClick={() => setTag(t)}>{t}</button>)}
          </div>
        )}
        {fns.isLoading ? <p className="muted">Loading…</p> : !shown.length ? (
          <div className="empty-state">
            <p style={{ margin: 0, color: 'var(--text)' }}>No functions yet</p>
            <p className="hint">Create one here, or select columns in a table and choose <b>Save columns as function</b> from the column menu.</p>
          </div>
        ) : (
          <table className="list">
            <thead><tr><th>Name</th><th>Steps</th><th>Outputs</th><th>Version</th><th>Used in</th><th>Updated</th></tr></thead>
            <tbody>
              {shown.map((f) => (
                <tr key={f.id} onClick={() => navigate(`/settings/functions/${f.id}`)}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{f.name}</div>
                    {(f.description || f.tags.length > 0) && <div className="hint" style={{ margin: '2px 0 0' }}>{f.tags.map((t) => <span key={t} className="tag-pill">{t}</span>)}{f.description}</div>}
                  </td>
                  <td>{f.definition.steps.length}</td>
                  <td className="muted">{f.definition.outputs.map((o) => o.name).join(', ')}</td>
                  <td><span className="ver">v{f.version}</span></td>
                  <td>{f.usage.tables ? `${f.usage.tables} table${f.usage.tables === 1 ? '' : 's'}` : <span className="muted">—</span>}{f.usage.outdated > 0 && <span className="muted"> · {f.usage.outdated} on older version</span>}</td>
                  <td className="muted nowrap">{new Date(f.updated_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- editor ----------

interface Draft { name: string; description: string; tags: string; definition: FnDefinition }

const BLANK: Draft = {
  name: '', description: '', tags: '',
  definition: { inputs: [{ name: 'domain', description: 'Company website or domain' }], steps: [], outputs: [] },
};

function stepSummary(s: FnStep, catalog: Catalog): string {
  const c = s.config ?? {};
  switch (s.type) {
    case 'enrich': return `${catalog.enrich.find((k) => k.id === c.kind)?.label ?? c.kind} · ${Object.entries(c.inputs ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    case 'ai': return String(c.prompt ?? '').slice(0, 140);
    case 'http': return `${c.method ?? 'GET'} ${c.url ?? ''}`;
    case 'formula': return String(c.expression ?? '');
    case 'extract': return `${c.source ?? '?'} → ${c.path ?? ''}`;
    case 'lookup': return `${c.matchColumn ?? '?'} = ${c.value ?? ''} (${c.mode ?? 'exact'}, ${c.return ?? 'first'})`;
    default: return '';
  }
}

/** Rename {{Old}} / {{Old.path}} / row["Old"] references inside a JSON-ish value. */
function renameIn<T>(v: T, from: string, to: string): T {
  if (from === to) return v;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const json = JSON.stringify(v)
    .replace(new RegExp(`\\{\\{\\s*${esc}(\\s*\\}\\}|\\.)`, 'g'), (_, tail) => `{{${to}${tail}`)
    .replace(new RegExp(`row\\[\\\\"${esc}\\\\"\\]`, 'g'), `row[\\"${to}\\"]`);
  return JSON.parse(json);
}

export function FunctionEditor({ id, catalog }: { id: number | null; catalog: Catalog }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['gtm-function', id], queryFn: () => api<FnDetail>(`/api/gtm/functions/${id}`), enabled: !!id });
  const [draft, setDraft] = useState<Draft | null>(id ? null : BLANK);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'build' | 'test' | 'stats'>('build');
  const [editing, setEditing] = useState<{ index: number | null; type: StepType } | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (detail.data && !dirty) setDraft({ name: detail.data.name, description: detail.data.description, tags: detail.data.tags.join(', '), definition: detail.data.definition });
  }, [detail.data, dirty]);

  if (!draft) return <div className="loading">Loading…</div>;
  const def = draft.definition;
  const update = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const setDef = (patch: Partial<FnDefinition>) => update({ definition: { ...def, ...patch } });
  const names = [...def.inputs.map((i) => i.name), ...def.steps.map((s) => s.name)];

  // Inputs and earlier steps as pseudo-columns, so the column editor offers them as {{tokens}}.
  const scopeFor = (index: number | null): Column[] => [
    ...def.inputs.map((i, k) => ({ id: -1000 - k, table_id: 0, name: i.name, type: 'function' as const, config: {}, position: k, width: null, auto_run: false, run_if: null })),
    ...def.steps.slice(0, index ?? def.steps.length).map((s, k) => ({ id: -(k + 1), table_id: 0, name: s.name, type: s.type, config: s.config, position: 100 + k, width: null, auto_run: false, run_if: s.run_if ?? null })),
  ];

  const submitStep = (s: { name: string; type: string; config: any; run_if: string | null }) => {
    const step: FnStep = { name: s.name, type: s.type as StepType, config: s.config, run_if: s.run_if };
    if (editing?.index == null) {
      let name = step.name;
      for (let n = 2; names.includes(name); n++) name = `${step.name} ${n}`;
      const steps = [...def.steps, { ...step, name }];
      // The first steps' results become outputs by default.
      const outputs = def.outputs.length ? def.outputs : [{ name: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'result', value: `{{${name}}}` }];
      setDef({ steps, outputs });
    } else {
      const old = def.steps[editing.index];
      const steps = def.steps.map((x, i) => (i === editing.index ? step : i > editing.index! ? renameIn(x, old.name, step.name) : x));
      setDef({ steps, outputs: renameIn(def.outputs, old.name, step.name) });
    }
    setEditing(null);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= def.steps.length) return;
    const steps = [...def.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setDef({ steps });
  };

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { name: draft!.name.trim(), description: draft!.description, tags: draft!.tags.split(',').map((t) => t.trim()).filter(Boolean), definition: def };
      if (!id) {
        const r = await api<{ id: number }>('/api/gtm/functions', { body });
        setDirty(false);
        void qc.invalidateQueries({ queryKey: ['gtm-functions'] });
        navigate(`/settings/functions/${r.id}`, { replace: true });
        return;
      }
      const r = await api<{ version: number; bumped: boolean }>(`/api/gtm/functions/${id}`, { method: 'PATCH', body });
      setDirty(false);
      setMsg(r.bumped ? `Saved as v${r.version}. Columns stay on their version until you upgrade them.` : 'Saved');
      setTimeout(() => setMsg(''), 4000);
      void qc.invalidateQueries({ queryKey: ['gtm-functions'] });
      void detail.refetch();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!id || !confirm(`Delete function "${draft!.name}"? Columns using it will stop running.`)) return;
    await api(`/api/gtm/functions/${id}`, { method: 'DELETE' });
    void qc.invalidateQueries({ queryKey: ['gtm-functions'] });
    navigate('/settings/functions');
  }

  const editingStep = editing?.index != null ? def.steps[editing.index] : null;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <div className="crumbs" style={{ marginBottom: 4 }}><Link to="/settings">Settings</Link><Icon name="chevronRight" size={14} /><Link to="/settings/functions">Functions</Link><Icon name="chevronRight" size={14} /></div>
            <div className="row-flex" style={{ marginTop: 0 }}>
              <input className="title-input" style={{ fontSize: 20, minWidth: 260 }} value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="Function name" />
              {detail.data && <span className="ver">v{detail.data.version}</span>}
              {dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
            </div>
          </div>
          {msg && <span className="hint">{msg}</span>}
          {id && <button className="ghost danger" onClick={remove}>Delete</button>}
          <button className="primary" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? 'Saving…' : id ? 'Save' : 'Create function'}</button>
        </div>
        {error && <p className="err">{error}</p>}
        <div className="tabs" style={{ display: 'inline-flex' }}>
          <button className={tab === 'build' ? 'on' : ''} onClick={() => setTab('build')}>Build</button>
          <button className={tab === 'test' ? 'on' : ''} onClick={() => setTab('test')}>Test</button>
          {id && <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>Stats & usage</button>}
        </div>

        {tab === 'build' && (
          <>
            <div className="card">
              <div className="form-grid">
                <label style={{ marginTop: 0 }}>Description<input value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder="What it finds, and from what" /></label>
                <label style={{ marginTop: 0 }}>Tags (comma-separated)<input value={draft.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="company, email" /></label>
              </div>
            </div>

            <div className="card">
              <header><h2>Inputs</h2><span className="hint" style={{ margin: 0 }}>Mapped from table columns when the function is used. Steps read them as <code>{'{{name}}'}</code>.</span></header>
              {def.inputs.map((inp, i) => (
                <div className="fn-io" key={i}>
                  <input className="mono" value={inp.name} onChange={(e) => { const n = e.target.value.replace(/\s+/g, '_'); setDef({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, name: n } : x)), steps: renameIn(def.steps, inp.name, n), outputs: renameIn(def.outputs, inp.name, n) }); }} placeholder="input_name" />
                  <input value={inp.description ?? ''} onChange={(e) => setDef({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} placeholder="What to pass in" />
                  <label className="check" style={{ marginTop: 0 }}><input type="checkbox" checked={!!inp.required} onChange={(e) => setDef({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> Required</label>
                  <button className="ghost sm" onClick={() => setDef({ inputs: def.inputs.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <div className="row-flex"><button className="ghost sm" onClick={() => setDef({ inputs: [...def.inputs, { name: `input_${def.inputs.length + 1}` }] })}>+ Add input</button></div>
            </div>

            <div className="card">
              <header><h2>Steps</h2><span className="hint" style={{ margin: 0 }}>Run top to bottom for each row. Each step can read the inputs and earlier steps, and has its own run-if.</span></header>
              {def.steps.length === 0 && <p className="hint">No steps yet. Add an enrichment, AI research, HTTP call, formula, extract or lookup.</p>}
              <ol className="fn-steps">
                {def.steps.map((s, i) => (
                  <li className="fn-step" key={`${s.name}-${i}`}>
                    <span className="num">{i + 1}</span>
                    <span className={`ty ty-${s.type}`}><Icon name={TYPE_META[s.type].icon} size={12} /></span>
                    <div className="body">
                      <b>{s.name}</b>{s.run_if && <span className="tag-pill" style={{ marginLeft: 6 }}>if {s.run_if.slice(0, 40)}</span>}
                      <small>{stepSummary(s, catalog)}</small>
                    </div>
                    <button className="ghost sm" onClick={() => move(i, -1)}>↑</button>
                    <button className="ghost sm" onClick={() => move(i, 1)}>↓</button>
                    <button className="ghost sm" onClick={() => setEditing({ index: i, type: s.type })}>Edit</button>
                    <button className="ghost sm" onClick={() => setDef({ steps: def.steps.filter((_, j) => j !== i) })}>✕</button>
                  </li>
                ))}
              </ol>
              <div className="chips" style={{ marginTop: 10 }}>
                {STEP_TYPES.map((t) => <button key={t} className="chip" onClick={() => setEditing({ index: null, type: t })}>+ {TYPE_META[t].label}</button>)}
              </div>
            </div>

            <div className="card">
              <header><h2>Outputs</h2><span className="hint" style={{ margin: 0 }}>The cell's value is an object of these; extract any of them into its own column.</span></header>
              {def.outputs.map((o, i) => (
                <div className="fn-io out" key={i}>
                  <input className="mono" value={o.name} onChange={(e) => setDef({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/\s+/g, '_') } : x)) })} placeholder="output_name" />
                  <TemplateInput value={o.value} onChange={(v) => setDef({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, value: v } : x)) })} columns={names} placeholder="{{Step name.field}}" />
                  <button className="ghost sm" onClick={() => setDef({ outputs: def.outputs.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <div className="row-flex">
                <button className="ghost sm" onClick={() => setDef({ outputs: [...def.outputs, { name: `output_${def.outputs.length + 1}`, value: '' }] })}>+ Add output</button>
                {def.steps.filter((s) => !def.outputs.some((o) => o.value === `{{${s.name}}}`)).map((s) => (
                  <button key={s.name} className="chip" onClick={() => setDef({ outputs: [...def.outputs, { name: s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), value: `{{${s.name}}}` }] })}>+ {s.name}</button>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'test' && <TestPanel definition={def} />}
        {tab === 'stats' && detail.data && <StatsPanel fn={detail.data} onChanged={() => detail.refetch()} />}
      </div>

      {editing && (
        <div className="fn-drawer">
          <ColumnEditor
            key={`${editing.index ?? 'new'}-${editing.type}`}
            tableId={0}
            column={editingStep ? { id: -(editing.index! + 1), table_id: 0, name: editingStep.name, type: editingStep.type, config: editingStep.config, position: editing.index!, width: null, auto_run: false, run_if: editingStep.run_if ?? null } : null}
            initialType={editing.type}
            columns={scopeFor(editing.index)}
            catalog={catalog}
            onClose={() => setEditing(null)}
            onSaved={() => setEditing(null)}
            onSubmit={submitStep}
          />
        </div>
      )}
    </div>
  );
}

// ---------- test (sandbox) ----------

function TestPanel({ definition }: { definition: FnDefinition }) {
  const [mode, setMode] = useState<'samples' | 'table'>('samples');
  const [samples, setSamples] = useState<Record<string, string>[]>([{}]);
  const [tableId, setTableId] = useState<number>();
  const [limit, setLimit] = useState(5);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [results, setResults] = useState<FnTestResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tables = useGtmTables();
  const cols = useTableColumns(tableId);
  const colNames = (cols.data ?? []).map((c) => c.name);

  // Guess the mapping when a table is chosen.
  useEffect(() => {
    if (!cols.data) return;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    setMapping(Object.fromEntries(definition.inputs.map((i) => { const c = cols.data!.find((x) => norm(x.name) === norm(i.name)) ?? cols.data!.find((x) => norm(x.name).includes(norm(i.name))); return [i.name, c ? `{{${c.name}}}` : '']; })));
  }, [cols.data, definition.inputs]);

  async function run() {
    setBusy(true);
    setError('');
    setResults(null);
    try {
      const body = mode === 'samples'
        ? { definition, inputs: samples.filter((s) => Object.values(s).some((v) => v?.trim())) }
        : { definition, tableId, limit, mapping };
      const r = await api<{ results: FnTestResult[] }>('/api/gtm/functions/test', { body });
      setResults(r.results);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <header><h2>Test</h2><span className="hint" style={{ margin: 0 }}>Runs the current draft (saved or not). Nothing is written to any table. Paid providers and AI still spend credits.</span></header>
      <div className="tabs" style={{ display: 'inline-flex' }}>
        <button className={mode === 'samples' ? 'on' : ''} onClick={() => setMode('samples')}>Sample inputs</button>
        <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Rows of a table</button>
      </div>
      {mode === 'samples' ? (
        <>
          {samples.map((s, k) => (
            <div className="row-flex" key={k}>
              {definition.inputs.map((i) => <input key={i.name} style={{ flex: 1, minWidth: 140 }} value={s[i.name] ?? ''} placeholder={i.name} onChange={(e) => setSamples(samples.map((x, j) => (j === k ? { ...x, [i.name]: e.target.value } : x)))} />)}
              {samples.length > 1 && <button className="ghost sm" onClick={() => setSamples(samples.filter((_, j) => j !== k))}>✕</button>}
            </div>
          ))}
          <div className="row-flex"><button className="ghost sm" onClick={() => setSamples([...samples, {}])}>+ Add sample</button></div>
        </>
      ) : (
        <>
          <div className="form-grid">
            <label>Table
              <select value={tableId ?? ''} onChange={(e) => setTableId(Number(e.target.value) || undefined)}>
                <option value="">Choose a table…</option>
                {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.row_count} rows</option>)}
              </select>
            </label>
            <label>First N rows<input type="number" min={1} max={25} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
          </div>
          {tableId && definition.inputs.map((i) => (
            <label key={i.name}>{i.name}<TemplateInput value={mapping[i.name] ?? ''} onChange={(v) => setMapping({ ...mapping, [i.name]: v })} columns={colNames} /></label>
          ))}
        </>
      )}
      <div className="row-flex" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy || !definition.steps.length || (mode === 'table' && !tableId)} onClick={run}><Icon name="play" size={13} />{busy ? 'Running…' : 'Run test'}</button>
        {error && <span className="err">{error}</span>}
      </div>
      {results && results.length === 0 && <p className="hint">No samples to run — fill in at least one input.</p>}
      {results?.map((r, k) => (
        <div className="fn-result" key={k}>
          <header>
            <span className={`status st-${r.status}`}>{r.status}</span>
            <b>{r.rowId ? `Row ${r.rowId}` : `Sample ${k + 1}`}</b>
            <span>{Object.entries(r.inputs).map(([n, v]) => `${n}=${display(v) || '∅'}`).join(' · ')}</span>
            <span className="grow" /><span>{r.ms} ms</span>
          </header>
          {r.error && <p className="err">{r.error}</p>}
          <table className="kv"><tbody>
            {Object.entries(r.outputs).map(([n, v]) => <tr key={n}><th>{n}</th><td>{v == null ? <span className="muted">—</span> : display(v)}</td></tr>)}
          </tbody></table>
          <details>
            <summary>Steps</summary>
            <table className="kv"><tbody>
              {r.steps.map((s, i) => (
                <tr key={i}>
                  <th>{s.name}<br /><small className="muted">{s.type}{s.provider ? ` · ${String(s.provider)}` : ''}</small></th>
                  <td className={s.status === 'done' ? 'ok' : s.status === 'error' ? 'err' : 'muted'}>{s.status === 'done' ? (display(s.value) || 'done') : s.error ? `${s.status}: ${s.error}` : s.status}</td>
                  <td className="muted nowrap">{s.ms} ms</td>
                </tr>
              ))}
            </tbody></table>
          </details>
        </div>
      ))}
    </div>
  );
}

// ---------- stats & usage ----------

function StatsPanel({ fn, onChanged }: { fn: FnDetail; onChanged: () => void }) {
  const s = fn.stats;
  const [busy, setBusy] = useState(false);
  const upgrade = async (columnIds?: number[]) => {
    setBusy(true);
    try { await api(`/api/gtm/functions/${fn.id}/upgrade-columns`, { body: { columnIds } }); onChanged(); } finally { setBusy(false); }
  };
  const outdated = fn.columns.filter((c) => c.version !== fn.version);
  return (
    <>
      <div className="stat-row" style={{ marginTop: 14 }}>
        <div className="stat-tile"><span>Rows processed ({s.days}d)</span><b>{s.rowsProcessed.toLocaleString()}</b></div>
        <div className="stat-tile"><span>Avg run time</span><b>{s.avgMs < 1000 ? `${s.avgMs} ms` : `${(s.avgMs / 1000).toFixed(1)} s`}</b></div>
        <div className="stat-tile"><span>Error rate</span><b>{s.errorRate}%</b></div>
        <div className="stat-tile"><span>No result</span><b>{s.emptyRate}%</b></div>
        <div className="stat-tile"><span>Last run</span><b style={{ fontSize: 14 }}>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}</b></div>
      </div>
      <div className="card">
        <header><h2>Fill rate per output</h2></header>
        {Object.entries(s.fillRate).map(([k, pct]) => (
          <div className="fill" key={k}><span className="mono">{k}</span><div className="fill-bar"><span style={{ width: `${pct}%` }} /></div><span className="pct">{pct}%</span></div>
        ))}
        {!s.rowsProcessed && <p className="hint">No runs yet. Stats count function cells run in tables (test runs aren't counted).</p>}
        {Object.keys(s.byVersion).length > 1 && <p className="hint">Runs by version: {Object.entries(s.byVersion).map(([v, n]) => `v${v}: ${n}`).join(' · ')}</p>}
      </div>
      <div className="card">
        <header><h2>Used in</h2><span className="grow" />{outdated.length > 0 && <button className="sm" disabled={busy} onClick={() => upgrade()}>Upgrade all to v{fn.version}</button>}</header>
        {!fn.columns.length ? <p className="hint">Not used yet. In a table, click <b>Add enrichment → Functions</b>.</p> : (
          <table className="list">
            <thead><tr><th>Table</th><th>Column</th><th>Version</th><th /></tr></thead>
            <tbody>
              {fn.columns.map((c) => (
                <tr key={c.column_id}>
                  <td><Link to={`/tables/${c.table_id}`}>{c.table}</Link></td>
                  <td>{c.column}</td>
                  <td><span className="ver">v{c.version ?? fn.version}</span></td>
                  <td style={{ textAlign: 'right' }}>{c.version !== fn.version && <button className="sm" disabled={busy} onClick={() => upgrade([c.column_id])}>Upgrade</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Versions: {fn.versions.map((v) => `v${v.version} (${new Date(v.created_at).toLocaleDateString()})`).join(' · ')}</p>
      </div>
    </>
  );
}
