import { useState } from 'react';
import { OutreachForm, outreachDefaults } from './ColumnEditor';
import { Icon } from './Icon';
import { api, type Catalog, type Column } from '../lib/api';

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header><h3>{title}</h3><button className="ghost icon-btn sm" onClick={onClose}><Icon name="x" /></button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

type Src = 'csv' | 'webhook' | 'yc_companies' | 'github_people' | 'hubspot_contacts' | 'hubspot_companies' | 'apollo_people' | 'apollo_companies';

export function ImportDialog({ tableId, webhookUrl, onClose, onDone }: { tableId: number; webhookUrl: string; onClose: () => void; onDone: () => void }) {
  const [src, setSrc] = useState<Src>('csv');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const p = (k: string) => ({ value: params[k] ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setParams({ ...params, [k]: e.target.value }) });

  async function go() {
    setBusy(true);
    setMsg('');
    try {
      const r = src === 'csv'
        ? await api(`/api/gtm/tables/${tableId}/import/csv`, { body: { csv } })
        : await api(`/api/gtm/tables/${tableId}/import/source`, { body: { source: src, params, limit } });
      setMsg(`Imported ${r.imported} rows`);
      onDone();
      onClose();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  const tabs: [Src, string][] = [['csv', 'CSV'], ['webhook', 'Webhook'], ['yc_companies', 'YC companies (free)'], ['github_people', 'GitHub org people (free)'], ['hubspot_contacts', 'HubSpot contacts'], ['hubspot_companies', 'HubSpot companies'], ['apollo_people', 'Apollo people search'], ['apollo_companies', 'Apollo company search']];
  const curl = `curl -X POST ${webhookUrl} \\\n  -H 'content-type: application/json' \\\n  -d '{"Full name":"Ada Lovelace","Company domain":"example.com"}'`;
  return (
    <Modal title="Add rows" onClose={onClose} footer={src !== 'webhook' && <><span className="hint">{msg}</span><span style={{ flex: 1 }} /><button className="primary" disabled={busy || (src === 'csv' && !csv)} onClick={go}>{busy ? 'Importing…' : 'Import'}</button></>}>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={k === src ? 'on' : ''} onClick={() => setSrc(k)}>{l}</button>)}</div>
      {src === 'csv' && (
        <>
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setFileName(f.name); } }} />
            {fileName ? `${fileName} · ${csv.split('\n').length - 1} rows` : 'Choose a CSV file — headers become columns (matched by name)'}
          </label>
          <label>…or paste CSV<textarea rows={6} className="mono" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Full name,Company domain\nAda Lovelace,example.com'} /></label>
        </>
      )}
      {src === 'webhook' && (
        <>
          <p>POST a JSON object (or an array of objects) to this table's URL. Keys become columns; auto-run columns process each new row.</p>
          <pre className="copy">{webhookUrl}</pre>
          <pre>{curl}</pre>
          <p className="hint">The server listens on localhost. To receive webhooks from the internet (Zapier, n8n, Typeform…), expose it with a tunnel such as <code>cloudflared tunnel --url http://localhost:4200</code> and set <code>PUBLIC_URL</code>.</p>
        </>
      )}
      {(src === 'hubspot_contacts' || src === 'hubspot_companies') && <p>Pulls records from HubSpot using your private app token (Settings).</p>}
      {src === 'yc_companies' && (
        <div className="form-grid">
          <label>Keywords / tags (comma = any)<input {...p('query')} placeholder="developer tools, fintech" /></label>
          <label>Batch contains<input {...p('batch')} placeholder="2025, Winter 2024" /></label>
          <label>Region / location<input {...p('region')} placeholder="United States, Europe, London" /></label>
          <label>Status<input {...p('status')} placeholder="Active" /></label>
          <label>Hiring
            <select value={params.hiring ?? ''} onChange={(e) => setParams({ ...params, hiring: e.target.value })}><option value="">Any</option><option value="yes">Hiring now</option><option value="no">Not hiring</option></select>
          </label>
        </div>
      )}
      {src === 'github_people' && (
        <>
          <div className="form-grid">
            <label>GitHub org<input {...p('org')} placeholder="vercel" /></label>
            <label>…or company domain<input {...p('domain')} placeholder="vercel.com" /></label>
          </div>
          <p className="hint">Public members of the org with name, email (if public), website, X and location. Without a GitHub token you get ~50 profiles per hour.</p>
        </>
      )}
      {src === 'apollo_people' && (
        <div className="form-grid">
          <label>Job titles<input {...p('titles')} placeholder="VP Sales, Head of Growth" /></label>
          <label>Company domains<input {...p('domains')} placeholder="stripe.com, ramp.com" /></label>
          <label>Locations<input {...p('locations')} placeholder="United States, London" /></label>
          <label>Seniorities<input {...p('seniorities')} placeholder="vp, director, c_suite" /></label>
        </div>
      )}
      {src === 'apollo_companies' && (
        <div className="form-grid">
          <label>Keywords<input {...p('keywords')} placeholder="fintech, payments" /></label>
          <label>Locations<input {...p('locations')} placeholder="United States" /></label>
          <label>Employee ranges<input {...p('employees')} placeholder="11-50, 51-200" /></label>
        </div>
      )}
      {src !== 'csv' && src !== 'webhook' && <label className="inline">Max rows <input type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>}
    </Modal>
  );
}

export function ScheduleDialog({ tableId, schedule, columns, onClose, onSaved }: { tableId: number; schedule: any; columns: Column[]; onClose: () => void; onSaved: () => void }) {
  const runnable = columns.filter((c) => c.type !== 'text' && c.type !== 'formula' && c.type !== 'extract');
  const [enabled, setEnabled] = useState<boolean>(!!schedule?.enabled);
  const [every, setEvery] = useState<number>(schedule?.everyMinutes ?? 1440);
  const [ids, setIds] = useState<number[]>(schedule?.columnIds ?? runnable.filter((c) => c.type === 'signal').map((c) => c.id));
  async function save() {
    await api(`/api/gtm/tables/${tableId}`, { method: 'PATCH', body: { schedule: { enabled, everyMinutes: every, columnIds: ids } } });
    onSaved();
    onClose();
  }
  return (
    <Modal title="Refresh schedule" onClose={onClose} footer={<><span style={{ flex: 1 }} /><button className="primary" onClick={save}>Save</button></>}>
      <p className="hint">Re-runs the chosen columns for every row on an interval. When a value changes, auto-run columns that reference it fire — that's how signals turn into alerts. The app must be running.</p>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
      <label>Every
        <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          {[[60, 'hour'], [360, '6 hours'], [720, '12 hours'], [1440, 'day'], [10080, 'week']].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Columns to refresh</legend>
        {runnable.length === 0 && <p className="muted">No runnable columns yet.</p>}
        {runnable.map((c) => (
          <label className="check" key={c.id}><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} /> {c.name} <span className="muted">({c.type})</span></label>
        ))}
      </fieldset>
      {schedule?.lastRunAt && <p className="hint">Last run {new Date(schedule.lastRunAt).toLocaleString()}</p>}
    </Modal>
  );
}

const PACK_DEFAULTS = ['hiring', 'news', 'hacker_news', 'funding_sec', 'sec_filings', 'tech_stack'];

export function SignalPackDialog({ tableId, columns, catalog, onClose, onDone }: { tableId: number; columns: Column[]; catalog: Catalog; onClose: () => void; onDone: () => void }) {
  const text = columns.filter((c) => c.type === 'text').map((c) => c.name);
  const pick = (re: RegExp) => text.find((n) => re.test(n)) ?? '';
  const [nameColumn, setName] = useState(pick(/^company( name)?$/i) || pick(/company|account|organi/i) || text[0] || '');
  const [domainColumn, setDomain] = useState(pick(/domain|website|url/i));
  const [signals, setSignals] = useState<string[]>(PACK_DEFAULTS);
  const [every, setEvery] = useState(1440);
  const [alert, setAlert] = useState<'slack' | 'webhook' | 'none'>('slack');
  const [channel, setChannel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [msg, setMsg] = useState('');
  const slackReady = catalog.actions.find((a) => a.id === 'slack')?.ready;

  async function go() {
    try {
      const r = await api(`/api/gtm/tables/${tableId}/signal-pack`, { body: { nameColumn, domainColumn: domainColumn || undefined, signals, everyMinutes: every, alert, slackChannel: channel || undefined, webhookUrl: webhookUrl || undefined } });
      onDone();
      onClose();
      return r;
    } catch (e: any) { setMsg(e.message); }
  }

  return (
    <Modal title="Add signal pack" onClose={onClose} footer={<><span className="err">{msg}</span><span style={{ flex: 1 }} /><button className="primary" disabled={!nameColumn || !signals.length} onClick={go}>Add {signals.length} signals</button></>}>
      <p className="hint">Adds one column per signal, runs them now as a baseline, re-checks on a schedule, and sends an alert only when a value changes — e.g. new roles posted, a new headline, a fresh 8-K, a new subdomain.</p>
      <div className="form-grid">
        <label>Company name column<select value={nameColumn} onChange={(e) => setName(e.target.value)}>{text.map((n) => <option key={n}>{n}</option>)}</select></label>
        <label>Domain column<select value={domainColumn} onChange={(e) => setDomain(e.target.value)}><option value="">(none)</option>{text.map((n) => <option key={n}>{n}</option>)}</select></label>
      </div>
      <fieldset>
        <legend>Signals</legend>
        {catalog.signals.map((s) => (
          <label className="check" key={s.id} title={s.description}>
            <input type="checkbox" checked={signals.includes(s.id)} onChange={(e) => setSignals(e.target.checked ? [...signals, s.id] : signals.filter((x) => x !== s.id))} />
            <span>{s.label}{s.requires.length > 0 && <span className="muted"> · needs {s.requires.join(' or ').replace(/\|/g, ' or ')}</span>}<br /><small className="muted">{s.description}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <label>Re-check every
          <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>{[[360, '6 hours'], [720, '12 hours'], [1440, 'day'], [10080, 'week']].map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
        </label>
        <label>Alert on change
          <select value={alert} onChange={(e) => setAlert(e.target.value as any)}><option value="slack">Slack</option><option value="webhook">Webhook</option><option value="none">No alert</option></select>
        </label>
      </div>
      {alert === 'slack' && (slackReady
        ? <label>Channel (optional — needs a bot token; otherwise your incoming webhook's channel)<input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="#signals" /></label>
        : <p className="warn">Add a Slack incoming webhook URL on the Integrations page for alerts to send.</p>)}
      {alert === 'webhook' && <label>Webhook URL<input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://n8n.example.com/webhook/…" /></label>}
    </Modal>
  );
}

/** Table → Outreach in one step: push column (+ status column), then run it. */
export function SendToCampaignDialog({ tableId, columns, onClose, onDone }: { tableId: number; columns: Column[]; onClose: () => void; onDone: (msg: string) => void }) {
  const names = columns.map((c) => c.name);
  const [config, setConfig] = useState<any>(() => outreachDefaults(names, 'outreach_campaign'));
  const verify = columns.find((c) => c.type === 'enrich' && c.config?.kind === 'verify_email');
  const [onlyValid, setOnlyValid] = useState(!!verify);
  const [auto, setAuto] = useState(false);
  const [withStatus, setWithStatus] = useState(!columns.some((c) => c.config?.kind === 'outreach_status'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (p: any) => setConfig((c: any) => ({ ...c, ...p }));

  async function go() {
    if (!config.campaignId) return setErr('Choose a campaign');
    if (!config.email) return setErr('Map the email column');
    setBusy(true);
    setErr('');
    try {
      const col = await api(`/api/gtm/tables/${tableId}/columns`, { body: {
        name: 'Push to campaign', type: 'action', config, auto_run: auto,
        run_if: onlyValid && verify ? `row[${JSON.stringify(verify.name)}] === "valid"` : null,
      } });
      if (withStatus) {
        await api(`/api/gtm/tables/${tableId}/columns`, { body: { name: 'Outreach status', type: 'signal', auto_run: true, config: { kind: 'outreach_status', inputs: { email: config.email } } } });
      }
      const r = await api(`/api/gtm/tables/${tableId}/run`, { body: { columnIds: [col.id] } });
      onDone(`Pushing ${r.queued} row${r.queued === 1 ? '' : 's'} to the campaign`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send rows to a campaign" onClose={onClose} footer={<><span className="err">{err}</span><span style={{ flex: 1 }} /><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={go}>{busy ? 'Sending…' : 'Send to campaign'}</button></>}>
      <p className="hint">Creates or updates a lead for every row and attaches it to the campaign. Blacklisted, bounced and unsubscribed leads are skipped automatically.</p>
      <OutreachForm config={config} set={set} others={names} />
      <fieldset>
        <legend>Options</legend>
        {verify
          ? <label className="check"><input type="checkbox" checked={onlyValid} onChange={(e) => setOnlyValid(e.target.checked)} /> Only rows where “{verify.name}” is <b>valid</b></label>
          : <p className="hint">Tip: add a <b>Verify email</b> enrichment first so only deliverable addresses are sent.</p>}
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Keep pushing new rows automatically (inbound webhooks, imports, enrichment updates)</label>
        <label className="check"><input type="checkbox" checked={withStatus} onChange={(e) => setWithStatus(e.target.checked)} /> Add an <b>Outreach status</b> column (sent, opened, replied, interested — updates live)</label>
      </fieldset>
    </Modal>
  );
}
