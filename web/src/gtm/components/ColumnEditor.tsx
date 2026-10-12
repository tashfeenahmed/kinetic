import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, TYPE_META, type Catalog, type Column, type ColumnType } from '../lib/api';
import { TemplateInput } from './TemplateInput';
import { Icon } from './Icon';

interface Props {
  tableId: number;
  column: Column | null; // null = new column
  initialType?: ColumnType;
  initialConfig?: any;
  initialName?: string;
  columns: Column[];
  catalog: Catalog;
  onClose: () => void;
  onSaved: (colId: number, runNow: boolean) => void;
}

const INPUT_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name', email: 'Email', domain: 'Company domain / website',
  companyName: 'Company name', linkedinUrl: 'LinkedIn URL', title: 'Job title', url: 'URL',
  target: 'Target', keywords: 'Keywords (comma-separated)', days: 'Look-back days',
};

const TARGET_LABELS: Record<string, string> = {
  hiring: 'ATS board URL or slug (optional — auto-detected from the website)',
  github: 'GitHub org (optional — defaults to domain name)',
  website_change: 'Page URL to watch (defaults to homepage)',
};

/** Guess which column feeds an input, by name. */
function guess(input: string, names: string[]): string {
  const find = (...res: RegExp[]) => names.find((n) => res.some((r) => r.test(n)));
  const pick = (() => {
    switch (input) {
      case 'firstName': return find(/^first/i);
      case 'lastName': return find(/^last/i);
      case 'fullName': return find(/full ?name/i, /^name$/i, /^person/i);
      case 'email': return find(/^(work )?email$/i, /email/i);
      case 'domain': return find(/domain/i, /website/i, /^url$/i);
      case 'companyName': return find(/^company( name)?$/i, /^organi[sz]ation/i, /^account/i);
      case 'linkedinUrl': return find(/linkedin/i);
      case 'title': return find(/title/i);
      default: return undefined;
    }
  })();
  return pick ? `{{${pick}}}` : '';
}

export function ColumnEditor(props: Props) {
  const { catalog } = props;
  const isNew = !props.column;
  const [type] = useState<ColumnType>(props.column?.type ?? props.initialType ?? 'enrich');
  const [name, setName] = useState(props.column?.name ?? props.initialName ?? '');
  const [config, setConfig] = useState<any>(props.column?.config ?? props.initialConfig ?? {});
  const [autoRun, setAutoRun] = useState<boolean>(props.column?.auto_run ?? false);
  const [runIf, setRunIf] = useState(props.column?.run_if ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const others = props.columns.filter((c) => c.id !== props.column?.id).map((c) => c.name);
  const set = (patch: any) => setConfig((c: any) => ({ ...c, ...patch }));
  const setInput = (k: string, v: string) => setConfig((c: any) => ({ ...c, inputs: { ...c.inputs, [k]: v } }));

  // Sensible defaults for a new column; a kind chosen in the picker gets its inputs pre-mapped.
  useEffect(() => {
    if (!isNew) return;
    const kind = props.initialConfig?.kind;
    if (props.initialConfig && !kind) return; // e.g. "add as column" from the cell panel
    if (type === 'enrich') return pickEnrich(kind ?? 'work_email');
    if (type === 'signal') return pickSignal(kind ?? 'hiring');
    if (type === 'action') { setConfig({ kind: kind ?? 'slack', text: '' }); setAutoRun(false); return; }
    if (type === 'ai' && !config.prompt) setConfig({ prompt: '', model: catalog.defaultModel, outputs: [{ name: 'answer', type: 'string', description: '' }], webSearch: true, fetchPages: true, maxSteps: 8 });
    if (type === 'http' && !config.url) setConfig({ method: 'GET', url: '', headers: {}, body: '', extract: '' });
    if (type === 'formula' || type === 'extract') setAutoRun(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  function pickEnrich(kind: string) {
    const k = catalog.enrich.find((x) => x.id === kind)!;
    setConfig({ kind, inputs: Object.fromEntries(k.inputs.map((i) => [i, guess(i, others)])), providers: k.steps.map((s) => s.id) });
    if (!name || catalog.enrich.some((x) => x.label === name)) setName(k.label.replace(/^Find |^Enrich /, '').replace(/^./, (c) => c.toUpperCase()));
  }
  function pickSignal(kind: string) {
    const k = catalog.signals.find((x) => x.id === kind)!;
    setConfig({ kind, inputs: Object.fromEntries(k.inputs.map((i) => [i, i === 'days' ? '30' : i === 'keywords' || i === 'target' ? '' : guess(i, others)])) });
    if (!name || catalog.signals.some((x) => x.label === name)) setName(k.label);
  }

  async function save(runNow: boolean) {
    setBusy(true);
    setError('');
    try {
      const body = { name: name.trim() || TYPE_META[type].label, config, auto_run: autoRun, run_if: runIf.trim() || null };
      let id = props.column?.id;
      if (isNew) id = (await api<{ id: number }>(`/api/gtm/tables/${props.tableId}/columns`, { body: { ...body, type } })).id;
      else await api(`/api/gtm/columns/${id}`, { method: 'PATCH', body });
      props.onSaved(id!, runNow);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!props.column || !confirm(`Delete column "${props.column.name}" and its data?`)) return;
    await api(`/api/gtm/columns/${props.column.id}`, { method: 'DELETE' });
    props.onSaved(props.column.id, false);
  }

  const enrich = type === 'enrich' ? catalog.enrich.find((k) => k.id === config.kind) : undefined;
  const signal = type === 'signal' ? catalog.signals.find((k) => k.id === config.kind) : undefined;

  return (
    <aside className="drawer">
      <header>
        <h3>{isNew ? `New ${TYPE_META[type].label.toLowerCase()} column` : props.column!.name}</h3>
        <button className="ghost icon-btn sm" onClick={props.onClose}><Icon name="x" /></button>
      </header>
      <div className="drawer-body">
        <div className="row-flex" style={{ marginTop: 14 }}>
          <span className="type-pill"><span className={`ty ty-${type}`}><Icon name={TYPE_META[type].icon} size={12} /></span>{TYPE_META[type].label}</span>
          <span className="hint" style={{ margin: 0 }}>{TYPE_META[type].hint}</span>
        </div>

        <label>Column name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPE_META[type].label} /></label>

        {type === 'formula' && (
          <>
            <label>Expression
              <textarea rows={4} value={config.expression ?? ''} onChange={(e) => set({ expression: e.target.value })} placeholder={'domain(row["Website"])'} className="mono" />
            </label>
            <p className="hint">JavaScript. <code>row["Col"]</code> is the cell's headline value, <code>raw["Col"]</code> the full result, helpers: <code>domain()</code> <code>first()</code> <code>last()</code> <code>lower()</code> <code>get(obj, "a.b")</code>. Multi-line bodies need <code>return</code>.</p>
            <ColumnChips names={others} onPick={(n) => set({ expression: `${config.expression ?? ''}row["${n}"]` })} />
          </>
        )}

        {type === 'extract' && (
          <>
            <label>From column
              <select value={config.source ?? ''} onChange={(e) => set({ source: e.target.value })}>
                <option value="">Choose…</option>
                {props.columns.filter((c) => c.type !== 'text' && c.id !== props.column?.id).map((c) => <option key={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>Field path<input className="mono" value={config.path ?? ''} onChange={(e) => set({ path: e.target.value })} placeholder="data.industry  or  employees  or  jobs.0.title" /></label>
          </>
        )}

        {type === 'enrich' && (
          <>
            <label>Enrichment
              <select value={config.kind ?? ''} onChange={(e) => pickEnrich(e.target.value)}>
                {catalog.enrich.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </label>
            {enrich && <p className="hint">{enrich.description} Needs: {enrich.needs.map((g) => g.map((i) => INPUT_LABELS[i]).join(' + ')).join(' or ')}.</p>}
            {enrich?.inputs.map((i) => (
              <label key={i}>{INPUT_LABELS[i]}<TemplateInput value={config.inputs?.[i] ?? ''} onChange={(v) => setInput(i, v)} columns={others} /></label>
            ))}
            {enrich && <Waterfall steps={enrich.steps} order={config.providers ?? enrich.steps.map((s) => s.id)} onChange={(providers) => set({ providers })} />}
          </>
        )}

        {type === 'signal' && (
          <>
            <label>Signal
              <select value={config.kind ?? ''} onChange={(e) => pickSignal(e.target.value)}>
                {catalog.signals.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </label>
            {signal && <p className="hint">{signal.description}</p>}
            {signal?.inputs.map((i) => (
              <label key={i}>{i === 'target' ? TARGET_LABELS[signal.id] ?? 'Target' : INPUT_LABELS[i]}
                <TemplateInput value={config.inputs?.[i] ?? ''} onChange={(v) => setInput(i, v)} columns={others} />
              </label>
            ))}
            <p className="hint">Tip: use <b>◉ Signals</b> in the toolbar to add a schedule and change alerts in one go — or add an auto-run Slack action with run-if <code>changed("{name || 'Signal'}")</code> and <code>{'{{_changes}}'}</code> in the message.</p>
          </>
        )}

        {type === 'ai' && (
          <>
            {!catalog.aiReady && <p className="warn">Add an OpenRouter key on the Integrations page to run AI columns.</p>}
            <label>Prompt
              <TemplateInput multiline rows={7} value={config.prompt ?? ''} onChange={(v) => set({ prompt: v })} columns={others}
                placeholder={'Research {{Company}} ({{Company domain}}). What do they sell, who is their ICP, and are they likely to need an outbound data tool? Cite sources.'} />
            </label>
            <label>Model
              <select value={config.model ?? catalog.defaultModel} onChange={(e) => set({ model: e.target.value })}>
                <optgroup label="Recommended">{catalog.models.slice(0, 5).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                <optgroup label="Free (OpenRouter account, no cost)">{catalog.models.slice(5).filter((m) => m.free).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                <optgroup label="All other models">{catalog.models.slice(5).filter((m) => !m.free).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                {config.model && !catalog.models.some((m) => m.id === config.model) && <option value={config.model}>{config.model}</option>}
              </select>
            </label>
            <label>Custom model id (optional — e.g. a local Ollama model when AI_BASE_URL is set)<input className="mono" value={catalog.models.some((m) => m.id === config.model) ? '' : config.model ?? ''} onChange={(e) => set({ model: e.target.value || catalog.defaultModel })} placeholder="e.g. google/gemini-3.8-flash" /></label>
            <div className="row-flex">
              <label className="check"><input type="checkbox" checked={config.webSearch !== false} onChange={(e) => set({ webSearch: e.target.checked })} /> Web search</label>
              <label className="check"><input type="checkbox" checked={config.fetchPages !== false} onChange={(e) => set({ fetchPages: e.target.checked })} /> Read pages</label>
              <label className="inline">Max steps <input type="number" min={1} max={20} value={config.maxSteps ?? 8} onChange={(e) => set({ maxSteps: Number(e.target.value) })} /></label>
            </div>
            <OutputFields value={config.outputs ?? []} onChange={(outputs) => set({ outputs })} />
          </>
        )}

        {type === 'http' && (
          <>
            <div className="row-flex">
              <select value={config.method ?? 'GET'} onChange={(e) => set({ method: e.target.value })} style={{ width: 100 }}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
              <div style={{ flex: 1 }}><TemplateInput value={config.url ?? ''} onChange={(v) => set({ url: v })} columns={others} placeholder="https://api.example.com/lookup?domain={{Company domain}}" /></div>
            </div>
            <JsonField label="Headers (JSON)" value={config.headers ?? {}} onChange={(headers) => set({ headers })} />
            <label>Body (JSON with {'{{tokens}}'}, optional)<TemplateInput multiline rows={4} value={config.body ?? ''} onChange={(v) => set({ body: v })} columns={others} /></label>
            <label>Keep only this response path (optional)<input className="mono" value={config.extract ?? ''} onChange={(e) => set({ extract: e.target.value })} placeholder="data.0.email" /></label>
          </>
        )}

        {type === 'action' && <ActionForm config={config} set={set} others={others} catalog={catalog} />}

        {type !== 'text' && (
          <fieldset>
            <legend>When to run</legend>
            <label className="check"><input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} /> Auto-run when referenced columns change (new rows, edits, signal changes)</label>
            <label>Only run if (JavaScript, optional)
              <input className="mono" value={runIf} onChange={(e) => setRunIf(e.target.value)} placeholder={'changed("Hiring") && row["Hiring"] > 3'} />
              <small className="muted"><code>changed("Col")</code> = that column's value changed since this cell last ran. <code>{'{{_changes}}'}</code> in a message lists what changed.</small>
            </label>
          </fieldset>
        )}
        {error && <p className="err">{error}</p>}
      </div>
      <footer>
        {!isNew && <button className="danger ghost" onClick={remove}>Delete</button>}
        <span style={{ flex: 1 }} />
        <button onClick={() => save(false)} disabled={busy}>Save</button>
        {type !== 'text' && <button className="primary" onClick={() => save(true)} disabled={busy}>Save & run</button>}
      </footer>
    </aside>
  );
}

function ColumnChips({ names, onPick }: { names: string[]; onPick: (n: string) => void }) {
  return <div className="chips">{names.map((n) => <button type="button" className="chip" key={n} onClick={() => onPick(n)}>{n}</button>)}</div>;
}

function Waterfall({ steps, order, onChange }: { steps: Catalog['enrich'][0]['steps']; order: string[]; onChange: (o: string[]) => void }) {
  const enabled = order.filter((id) => steps.some((s) => s.id === id));
  const disabled = steps.filter((s) => !enabled.includes(s.id));
  const move = (i: number, d: number) => {
    const o = [...enabled];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    onChange(o);
  };
  return (
    <fieldset>
      <legend>Waterfall — tried top to bottom, stops at first hit</legend>
      <ol className="waterfall">
        {enabled.map((id, i) => {
          const s = steps.find((x) => x.id === id)!;
          return (
            <li key={id}>
              <span className={`dot ${s.ready ? 'ok' : 'off'}`} title={s.ready ? 'Key configured' : `Needs ${s.requires.join(', ')}`} />
              <span className="grow">{s.label}<small>{s.cost}{!s.ready && ' · no key (skipped)'}</small></span>
              <button className="ghost sm" onClick={() => move(i, -1)}>↑</button>
              <button className="ghost sm" onClick={() => move(i, 1)}>↓</button>
              <button className="ghost sm" onClick={() => onChange(enabled.filter((x) => x !== id))}>✕</button>
            </li>
          );
        })}
      </ol>
      {disabled.length > 0 && <div className="chips">{disabled.map((s) => <button key={s.id} className="chip" onClick={() => onChange([...enabled, s.id])}>+ {s.label}</button>)}</div>}
    </fieldset>
  );
}

function OutputFields({ value, onChange }: { value: { name: string; type: string; description?: string }[]; onChange: (v: any[]) => void }) {
  const upd = (i: number, patch: any) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend>Output fields — each becomes extractable; one field shows directly</legend>
      {value.map((f, i) => (
        <div className="row-flex" key={i}>
          <input style={{ width: 130 }} value={f.name} onChange={(e) => upd(i, { name: e.target.value.replace(/\s+/g, '_') })} placeholder="field_name" />
          <select style={{ width: 95 }} value={f.type} onChange={(e) => upd(i, { type: e.target.value })}>
            {['string', 'number', 'boolean', 'list', 'url'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <input style={{ flex: 1 }} value={f.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} placeholder="what this field means" />
          <button className="ghost sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="ghost sm" onClick={() => onChange([...value, { name: `field_${value.length + 1}`, type: 'string', description: '' }])}>+ Add field</button>
    </fieldset>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: any) => void }) {
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <label>{label}
      <textarea className={`mono ${bad ? 'bad' : ''}`} rows={3} value={text} onChange={(e) => {
        setText(e.target.value);
        try { onChange(JSON.parse(e.target.value || '{}')); setBad(false); } catch { setBad(true); }
      }} />
    </label>
  );
}

function FieldMap({ value, onChange, others, placeholder }: { value: { name: string; value: string }[]; onChange: (v: any[]) => void; others: string[]; placeholder: string }) {
  const upd = (i: number, patch: any) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend>Field mapping</legend>
      {value.map((f, i) => (
        <div className="row-flex" key={i}>
          <input className="mono" style={{ width: 150 }} value={f.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder={placeholder} />
          <div style={{ flex: 1 }}><TemplateInput value={f.value} onChange={(v) => upd(i, { value: v })} columns={others} /></div>
          <button className="ghost sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="ghost sm" onClick={() => onChange([...value, { name: '', value: '' }])}>+ Map field</button>
    </fieldset>
  );
}

/** Guess a column for a lead field from the table's column names. */
function guessCol(others: string[], ...res: RegExp[]) {
  const hit = others.find((n) => res.some((r) => r.test(n)));
  return hit ? `{{${hit}}}` : '';
}

export function outreachDefaults(others: string[], kind: string) {
  return {
    kind,
    email: guessCol(others, /^(work )?email$/i, /email/i),
    firstName: guessCol(others, /^first/i),
    lastName: guessCol(others, /^last/i),
    company: guessCol(others, /^company( name)?$/i, /^organi[sz]ation/i),
    title: guessCol(others, /title/i),
    variables: [],
    behavior: 'patch',
  };
}

export function OutreachForm({ config, set, others }: { config: any; set: (p: any) => void; others: string[] }) {
  const [campaigns, setCampaigns] = useState<{ id: number; name: string; status: string }[]>([]);
  const [lists, setLists] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    api('/api/campaigns?per_page=200').then((r: any) => setCampaigns(r.data ?? [])).catch(() => {});
    api('/api/lead-lists').then((r: any) => setLists(r.data ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    // Fill blanks with guesses the first time the form opens.
    if (config.email === undefined) set(outreachDefaults(others, config.kind));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const vars: { name: string; value: string }[] = config.variables ?? [];
  const mapped = new Set(vars.map((v) => v.value));
  const unmapped = others.filter((n) => !mapped.has(`{{${n}}}`) && ![config.email, config.firstName, config.lastName, config.company, config.title].includes(`{{${n}}}`));
  const varName = (col: string) => col.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return (
    <>
      {config.kind === 'outreach_campaign' && (
        <label>Campaign
          <select value={config.campaignId ?? ''} onChange={(e) => set({ campaignId: Number(e.target.value) || null })}>
            <option value="">Choose a campaign…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
          </select>
        </label>
      )}
      {config.kind === 'outreach_campaign' && campaigns.length === 0 && <p className="hint">No campaigns yet — <Link to="/campaigns">create one in Outreach</Link>.</p>}
      <label>Also add to lead list (optional)
        <select value={config.listId ?? ''} onChange={(e) => set({ listId: Number(e.target.value) || null })}>
          <option value="">No list</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Lead fields</legend>
        <label>Email<TemplateInput value={config.email ?? ''} onChange={(v) => set({ email: v })} columns={others} /></label>
        <div className="form-grid">
          <label>First name<TemplateInput value={config.firstName ?? ''} onChange={(v) => set({ firstName: v })} columns={others} /></label>
          <label>Last name<TemplateInput value={config.lastName ?? ''} onChange={(v) => set({ lastName: v })} columns={others} /></label>
          <label>Company<TemplateInput value={config.company ?? ''} onChange={(v) => set({ company: v })} columns={others} /></label>
          <label>Title<TemplateInput value={config.title ?? ''} onChange={(v) => set({ title: v })} columns={others} /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Custom variables — use them in sequences as {'{VARIABLE_NAME}'}</legend>
        {vars.map((v, i) => (
          <div className="row-flex" key={i}>
            <input className="mono" style={{ width: 150 }} value={v.name} onChange={(e) => set({ variables: vars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="icebreaker" />
            <div style={{ flex: 1 }}><TemplateInput value={v.value} onChange={(val) => set({ variables: vars.map((x, j) => (j === i ? { ...x, value: val } : x)) })} columns={others} /></div>
            <button className="ghost sm" onClick={() => set({ variables: vars.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        {unmapped.length > 0 && (
          <div className="chips" style={{ display: 'flex' }}>
            {unmapped.map((n) => <button key={n} className="chip" onClick={() => set({ variables: [...vars, { name: varName(n), value: `{{${n}}}` }] })}>+ {n}</button>)}
          </div>
        )}
        <p className="hint">AI and enrichment columns become personalization: map an “Icebreaker” AI column to <code>icebreaker</code> and write <code>{'{ICEBREAKER}'}</code> in your sequence.</p>
      </fieldset>
      <label>If the lead already exists
        <select value={config.behavior ?? 'patch'} onChange={(e) => set({ behavior: e.target.value })}>
          <option value="patch">Update filled-in fields, keep the rest</option>
          <option value="put">Replace all fields</option>
          <option value="skip">Leave the lead unchanged</option>
        </select>
      </label>
      {config.kind === 'outreach_campaign' && (
        <label className="check"><input type="checkbox" checked={!!config.allowParallel} onChange={(e) => set({ allowParallel: e.target.checked })} /> Allow leads that are already in another active campaign</label>
      )}
    </>
  );
}

function ActionForm({ config, set, others, catalog }: { config: any; set: (p: any) => void; others: string[]; catalog: Catalog }) {
  const action = catalog.actions.find((a) => a.id === config.kind);
  return (
    <>
      <label>Action
        <select value={config.kind ?? 'slack'} onChange={(e) => set(e.target.value.startsWith('outreach_') ? outreachDefaults(others, e.target.value) : { kind: e.target.value })}>
          {catalog.actions.map((a) => <option key={a.id} value={a.id}>{a.label}{a.ready ? '' : ' (not configured)'}</option>)}
        </select>
      </label>
      {action && !action.ready && <p className="warn">Configure this integration on the Integrations page first.</p>}
      <p className="hint">Actions fire once per run. Turn on auto-run + a run-if to make them alerts (e.g. post to Slack when a signal changes).</p>
      {config.kind === 'slack' && (
        <>
          <label>Message<TemplateInput multiline rows={4} value={config.text ?? ''} onChange={(v) => set({ text: v })} columns={others} placeholder={':rotating_light: {{Company}} is hiring {{Hiring}} engineers — {{Hiring.data.board}}'} /></label>
          <label>Channel (needs bot token; otherwise the incoming webhook is used)<input value={config.channel ?? ''} onChange={(e) => set({ channel: e.target.value })} placeholder="#signals" /></label>
          <label>Incoming webhook URL override (optional)<input value={config.webhookUrl ?? ''} onChange={(e) => set({ webhookUrl: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></label>
        </>
      )}
      {config.kind === 'webhook' && (
        <>
          <div className="row-flex">
            <select value={config.method ?? 'POST'} onChange={(e) => set({ method: e.target.value })} style={{ width: 100 }}>{['POST', 'PUT', 'PATCH', 'GET'].map((m) => <option key={m}>{m}</option>)}</select>
            <div style={{ flex: 1 }}><TemplateInput value={config.url ?? ''} onChange={(v) => set({ url: v })} columns={[]} placeholder="https://n8n.example.com/webhook/…" /></div>
          </div>
          <JsonField label="Headers (JSON)" value={config.headers ?? {}} onChange={(headers) => set({ headers })} />
          <label>Body (JSON with tokens; leave empty to send the whole row)<TemplateInput multiline rows={5} value={config.body ?? ''} onChange={(v) => set({ body: v })} columns={others} /></label>
        </>
      )}
      {config.kind === 'hubspot_contact' && (
        <>
          <label>Email (match key)<TemplateInput value={config.email ?? ''} onChange={(v) => set({ email: v })} columns={others} /></label>
          <FieldMap value={config.fields ?? [{ name: 'firstname', value: '' }, { name: 'lastname', value: '' }, { name: 'jobtitle', value: '' }, { name: 'company', value: '' }]} onChange={(fields) => set({ fields })} others={others} placeholder="hubspot_property" />
        </>
      )}
      {config.kind === 'hubspot_company' && (
        <>
          <label>Domain (match key)<TemplateInput value={config.domain ?? ''} onChange={(v) => set({ domain: v })} columns={others} /></label>
          <FieldMap value={config.fields ?? [{ name: 'name', value: '' }, { name: 'industry', value: '' }]} onChange={(fields) => set({ fields })} others={others} placeholder="hubspot_property" />
        </>
      )}
      {(config.kind === 'outreach_campaign' || config.kind === 'outreach_update_lead') && <OutreachForm config={config} set={set} others={others} />}
      {config.kind === 'salesforce' && (
        <>
          <div className="row-flex">
            <label style={{ flex: 1 }}>Object<input value={config.object ?? 'Lead'} onChange={(e) => set({ object: e.target.value })} /></label>
            <label style={{ flex: 1 }}>Match field<input value={config.matchField ?? 'Email'} onChange={(e) => set({ matchField: e.target.value })} /></label>
          </div>
          <label>Match value<TemplateInput value={config.matchValue ?? ''} onChange={(v) => set({ matchValue: v })} columns={others} /></label>
          <FieldMap value={config.fields ?? [{ name: 'FirstName', value: '' }, { name: 'LastName', value: '' }, { name: 'Company', value: '' }, { name: 'Title', value: '' }]} onChange={(fields) => set({ fields })} others={others} placeholder="Salesforce field" />
        </>
      )}
    </>
  );
}
