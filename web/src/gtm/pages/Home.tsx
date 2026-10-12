import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type Catalog } from '../lib/api';
import { Icon } from '../components/Icon';

type Mode = 'companies' | 'people' | 'jobs';

const MODES: Record<Mode, { label: string; icon: string; placeholder: string; hint: string }> = {
  companies: { label: 'Find companies', icon: 'building', placeholder: 'e.g. developer tools, fintech — searches 6,000+ YC companies', hint: 'Free · YC directory' },
  people: { label: 'Find people', icon: 'user', placeholder: 'GitHub org or company domain, e.g. vercel.com', hint: 'Free · public GitHub org members' },
  jobs: { label: 'Find jobs', icon: 'briefcase', placeholder: 'Company domains, e.g. ramp.com, linear.app, notion.com', hint: 'Free · public job boards' },
};

const TEMPLATES = [
  { id: 'company_research', icon: 'building', title: 'Company research', desc: 'Firmographics, tech stack, open roles and an AI summary for each company.' },
  { id: 'find_emails', icon: 'mail', title: 'Find work emails', desc: 'Name + domain → email waterfall (free finder first) → verification → LinkedIn.' },
  { id: 'signals', icon: 'radar', title: 'Monitor accounts', desc: 'Watch hiring, news, SEC filings and tech changes; alert on change.' },
  { id: 'people', icon: 'user', title: 'People list', desc: 'Blank people table: name, company, domain, title, LinkedIn.' },
  { id: 'companies', icon: 'table', title: 'Company list', desc: 'Blank company table: name and domain.' },
];

export function Home({ tables, onOpen, onChanged, catalog }: { tables: any[]; onOpen: (id: number) => void; onChanged: () => void; catalog: Catalog }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('companies');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function find() {
    if (!q.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const name = mode === 'companies' ? `Companies · ${q.trim()}` : mode === 'people' ? `People · ${q.trim()}` : `Jobs · ${q.trim()}`;
      const t = await api('/api/gtm/tables', { body: { name: name.slice(0, 60), template: 'blank' } });
      const source = mode === 'companies' ? 'yc_companies' : mode === 'people' ? 'github_people' : 'jobs';
      const params = mode === 'companies' ? { query: q } : mode === 'people' ? (q.includes('.') ? { domain: q.trim() } : { org: q.trim() }) : { domains: q };
      await api(`/api/gtm/tables/${t.id}/import/source`, { body: { source, params, limit: mode === 'people' ? 30 : 100 } });
      // Drop the placeholder "Name" column that blank tables start with.
      const view = await api(`/api/gtm/tables/${t.id}`);
      const placeholder = view.columns.find((c: any) => c.name === 'Name' && c.type === 'text');
      if (placeholder && view.columns.length > 1) await api(`/api/gtm/columns/${placeholder.id}`, { method: 'DELETE' });
      onChanged();
      onOpen(t.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function template(id: string, title: string) {
    const t = await api('/api/gtm/tables', { body: { name: title, template: id } });
    onChanged();
    navigate(`/tables/${t.id}${id === 'signals' ? '?signals=1' : ''}`);
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="hero">
          <h1>What do you want to find?</h1>
          <p>Build a table, enrich it with waterfalls and AI, and watch for signals.</p>
          <div className="prompt-box">
            <div className="prompt">
              <textarea
                rows={2}
                value={q}
                placeholder={MODES[mode].placeholder}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void find(); } }}
              />
              <div className="prompt-foot">
                {(Object.keys(MODES) as Mode[]).map((m) => (
                  <button key={m} className={`chip ${m === mode ? 'on' : ''}`} style={{ height: 28 }} onClick={() => setMode(m)}>
                    <Icon name={MODES[m].icon} size={13} />{MODES[m].label}
                  </button>
                ))}
                <span className="grow" />
                <span className="hint" style={{ margin: 0 }}>{MODES[mode].hint}</span>
                <button className="primary prompt-send" disabled={busy || !q.trim()} onClick={find} title="Search">
                  {busy ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : <Icon name="arrowRight" />}
                </button>
              </div>
            </div>
            {err && <p className="err" style={{ textAlign: 'center' }}>{err}</p>}
            {!catalog.aiReady && <p className="hint" style={{ textAlign: 'center', marginTop: 14 }}>Tip: add an OpenRouter key in <Link to="/settings/keys">Settings</Link> to unlock AI research columns.</p>}
          </div>
        </div>

        <OutreachSnapshot />

        <div className="section-title"><h2>Start from a template</h2></div>
        <div className="cards">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="tcard" onClick={() => template(t.id, t.title)}>
              <span className="ti"><Icon name={t.icon} /></span>
              <b>{t.title}</b>
              <small>{t.desc}</small>
            </button>
          ))}
        </div>

        <div className="section-title"><h2>Recent tables</h2></div>
        {tables.length ? (
          <table className="list">
            <thead><tr><th>Name</th><th>Rows</th><th>Last updated</th><th /></tr></thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id} onClick={() => onOpen(t.id)}>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="table" size={15} className="muted" /><b style={{ fontWeight: 500 }}>{t.name}</b></span></td>
                  <td className="muted">{t.row_count}</td>
                  <td className="muted">{new Date(t.updated_at).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="ghost sm danger" onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete "${t.name}"?`)) { await api(`/api/gtm/tables/${t.id}`, { method: 'DELETE' }); onChanged(); } }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty-state">No tables yet — search above or pick a template.</div>}
      </div>
    </div>
  );
}

/** Outreach at a glance (last 30 days), linking into the campaign tools. */
function OutreachSnapshot() {
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('/api/workspaces/v1.1/stats?days=30').then((r: any) => setS(r.data)).catch(() => setS(null)); }, []);
  if (!s) return null;
  const tiles: [string, string | number, string][] = [
    ['Emails sent', s.emails_sent ?? 0, '/dashboard'],
    ['Leads contacted', s.leads_contacted ?? 0, '/leads'],
    ['Replies', s.unique_replies ?? 0, '/inbox'],
    ['Interested', s.interested ?? 0, '/inbox'],
    ['Reply rate', `${s.reply_rate ?? 0}%`, '/dashboard'],
  ];
  return (
    <>
      <div className="section-title"><h2>Outreach · last 30 days</h2><Link to="/dashboard" className="hint" style={{ margin: 0 }}>Open dashboard →</Link></div>
      <div className="stat-row">
        {tiles.map(([label, value, to]) => (
          <Link key={label} to={to} className="stat-tile"><span>{label}</span><b>{typeof value === 'number' ? value.toLocaleString() : value}</b></Link>
        ))}
      </div>
    </>
  );
}
