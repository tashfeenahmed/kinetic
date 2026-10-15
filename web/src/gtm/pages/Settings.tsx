import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { useAuth } from '../../lib/auth.tsx';

interface KeyInfo {
  key: string; label: string; group: string; priority: 'start' | 'recommended' | 'optional' | 'crm';
  unlocks: string; cost: string; link?: string; free?: string; secret?: boolean; placeholder?: string; domain?: string; icon?: string;
  set: boolean; fromEnv: boolean; preview: string;
}

const PRIORITY: Record<KeyInfo['priority'], string> = { start: 'Start here', recommended: 'Recommended', optional: 'Optional', crm: 'If you use it' };
const GROUP_TESTS: Record<string, { id: string; label: string }> = {
  'AI research': { id: 'openrouter', label: 'Test OpenRouter' },
  'Web search': { id: 'search', label: 'Test search' },
  Alerts: { id: 'slack', label: 'Send Slack test' },
  'Email finding & verification': { id: 'smtp', label: 'Check free SMTP (port 25)' },
  CRM: { id: 'hubspot', label: 'Test HubSpot' },
  'Email infrastructure': { id: 'cloudflare', label: 'Test Cloudflare' },
};

export function Settings({ onSaved, embedded }: { onSaved: () => void; embedded?: boolean }) {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, { ok?: boolean; detail: string }>>({});
  const [filter, setFilter] = useState<'all' | KeyInfo['priority'] | 'missing'>('all');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const { me } = useAuth();
  // Only admins can change keys (the API refuses others); say so instead of letting a save fail.
  const canEdit = !me || me.role === 'admin';

  useEffect(() => { api<KeyInfo[]>('/api/gtm/keys').then(setKeys); }, []);

  const groups = useMemo(() => {
    const shown = keys.filter((k) => filter === 'all' || (filter === 'missing' ? !k.set : k.priority === filter));
    const out = new Map<string, KeyInfo[]>();
    for (const k of shown) out.set(k.group, [...(out.get(k.group) ?? []), k]);
    return [...out.entries()];
  }, [keys, filter]);

  const dirty = Object.keys(draft).length > 0;
  const configured = keys.filter((k) => k.set).length;
  const starters = keys.filter((k) => k.priority === 'start');

  async function save() {
    setError('');
    try {
      setKeys(await api('/api/gtm/keys', { method: 'PUT', body: draft }));
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
      return;
    }
    setDraft({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onSaved();
  }

  // Typed keys live only in this page until saved: warn before they are lost.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function test(id: string) {
    setTests((t) => ({ ...t, [id]: { detail: 'checking…' } }));
    const r = await api(`/api/gtm/keys/test/${id}`, { body: {} }).catch((e) => ({ ok: false, detail: e.message }));
    setTests((t) => ({ ...t, [id]: r }));
  }

  return (
    <div className={embedded ? 'settings embedded' : 'page'}><div className={embedded ? '' : 'page-inner settings'}>
      <div className="settings-head">
        <div>
          <h1>{embedded ? 'Providers & keys' : 'Settings'}</h1>
          <span className="muted" style={{ fontSize: 13 }}>{configured} of {keys.length} configured · {starters.filter((k) => k.set).length}/{starters.length} “start here” keys set</span>
        </div>
        <span style={{ flex: 1 }} />
        {saved && <span className="ok">Saved ✓</span>}
        {error && <span className="err">{error}</span>}
        {canEdit && dirty && <button className="ghost" onClick={() => setDraft({})}>Discard</button>}
        {canEdit && <button className="primary" disabled={!dirty} onClick={save}>Save {dirty ? Object.keys(draft).length : ''} change{Object.keys(draft).length === 1 ? '' : 's'}</button>}
      </div>
      {!canEdit && <p className="hint err">Only workspace admins can add or change keys. Ask an admin to add the key here; you can still see which ones are set.</p>}
      {canEdit && dirty && <p className="hint">You have unsaved keys. Click <b>Save</b> above, or they are lost when you leave this page.</p>}

      <section className="card free-card">
        <header><h3>Works free, no keys</h3></header>
        <p className="hint">These run natively without any key. Paid keys below are optional upgrades — waterfalls try free sources first and fall back to paid ones only when needed.</p>
        <ul className="free-list">
          <li><b>Email finder</b> — learns each company’s address pattern from its website and public GitHub commits, then checks the mailbox over SMTP. <button className="ghost sm" onClick={() => test('smtp')}>Check port 25</button> <TestResult r={tests.smtp} /></li>
          <li><b>Email verification</b> — SMTP mailbox check + MX/disposable checks. Catch-all domains can’t be verified for free.</li>
          <li><b>Company data</b> — YC directory (6k+ companies), Wikidata (employees, founded, industry, LinkedIn), website scrape.</li>
          <li><b>Signals</b> — hiring, news, Hacker News, SEC funding/8-K, gov contracts, tech stack, page changes, GitHub, subdomains.</li>
          <li><b>AI</b> — free OpenRouter models (need the OpenRouter key), or a local Ollama/LM Studio model via <i>AI base URL</i>.</li>
          <li><b>Search</b> — your own SearXNG instance; DuckDuckGo as a last resort (often blocked).</li>
        </ul>
      </section>

      <div className="filters">
        {(['all', 'start', 'recommended', 'optional', 'crm', 'missing'] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'missing' ? 'Not set' : PRIORITY[f]}
          </button>
        ))}
      </div>

      {groups.map(([group, list]) => (
        <section key={group} className="card">
          <header>
            <h3>{group}</h3>
            {GROUP_TESTS[group] && <><button className="ghost sm" onClick={() => test(GROUP_TESTS[group].id)}>{GROUP_TESTS[group].label}</button><TestResult r={tests[GROUP_TESTS[group].id]} /></>}
          </header>
          {list.map((k) => (
            <div className="key-row2" key={k.key}>
              <Logo k={k} />
              <div className="key-info">
                <div className="key-title">
                  <b>{k.label}</b>
                  <span className={`badge p-${k.priority}`}>{PRIORITY[k.priority]}</span>
                  {k.link && <a href={k.link} target="_blank" rel="noreferrer">{k.secret === false ? "docs ↗" : "get key ↗"}</a>}
                </div>
                <div className="key-desc">{k.unlocks}</div>
                <div className="key-meta"><span>💲 {k.cost}</span>{k.free && <span className="free">✓ Free fallback: {k.free}</span>}</div>
                <code className="key-name">{k.key}</code>
              </div>
              <div className="key-input">
                <input
                  type={k.secret === false ? 'text' : 'password'}
                  autoComplete="off"
                  disabled={k.fromEnv || !canEdit}
                  placeholder={k.fromEnv ? `set in .env (${k.preview})` : k.set ? k.preview : k.placeholder ?? 'not set'}
                  value={draft[k.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [k.key]: e.target.value })}
                />
                {canEdit && k.set && !k.fromEnv && <button className="ghost sm" title="Remove on save" onClick={() => setDraft({ ...draft, [k.key]: '' })}>remove</button>}
                {draft[k.key] === '' && k.set && <small className="err">will be removed</small>}
              </div>
            </div>
          ))}
        </section>
      ))}
      <p className="hint">Keys are stored in the local SQLite file (<code>server/data/kineticsand.db</code>) on this machine. Values in <code>.env</code> take precedence and can’t be edited here. Pricing notes: <code>docs/RESEARCH.md</code> and <code>docs/FREE_ALTERNATIVES.md</code>.</p>
    </div></div>
  );
}

function Logo({ k }: { k: KeyInfo }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="logo-tile" title={k.set ? (k.fromEnv ? 'Set in .env' : 'Configured') : 'Not set'}>
      {k.domain && !broken
        ? <img src={`/api/gtm/icon/${k.domain}`} alt="" width={20} height={20} loading="lazy" onError={() => setBroken(true)} />
        : k.icon ? <Icon name={k.icon} size={17} />
        : <span className="logo-letter">{k.label[0]}</span>}
      <span className={`logo-dot ${k.set ? 'ok' : 'off'}`} />
    </span>
  );
}

function TestResult({ r }: { r?: { ok?: boolean; detail: string } }) {
  if (!r) return null;
  return <span className={`hint ${r.ok === true ? 'ok' : r.ok === false ? 'err' : ''}`}>{r.ok === true ? '✓ ' : r.ok === false ? '✕ ' : ''}{r.detail}</span>;
}
