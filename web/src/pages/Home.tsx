import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ArrowRight, AtSign, Briefcase, Building2, CheckCircle2, ChevronRight, Circle, FileText, Flame, Inbox, Loader2, Mail, Radar, Rocket,
  Table2, User, Users,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { avatarColor, fmtDate, fmtNumber, fmtPct, fmtRelative, initials } from '../lib/format.ts';
import { Page } from '../components/Layout.tsx';
import { Alert, Button, Card, EmptyState, Loading, ProgressBar, Select, cx } from '../components/ui.tsx';
import { CampaignStatus, ReplyCategory } from '../components/status.tsx';
import { useGtmTables } from '../gtm/lib/queries.ts';

/**
 * Home = the whole pipeline on one page:
 * find prospects → enrich in tables → send campaigns → work replies.
 */

const SERIES = [
  { key: 'sent', label: 'Sent', color: '#3b5bfd' },
  { key: 'replied', label: 'Replies', color: '#14b8a6' },
  { key: 'interested', label: 'Interested', color: '#f59e0b' },
  { key: 'bounced', label: 'Bounced', color: '#ef4444' },
] as const;

type Mode = 'companies' | 'people' | 'jobs';
const MODES: Record<Mode, { label: string; icon: typeof Building2; placeholder: string; hint: string }> = {
  companies: { label: 'Companies', icon: Building2, placeholder: 'What kind of companies? e.g. developer tools, fintech', hint: 'Free · 6,000+ YC companies' },
  people: { label: 'People', icon: User, placeholder: 'Company domain or GitHub org, e.g. vercel.com', hint: 'Free · public GitHub org members' },
  jobs: { label: 'Jobs', icon: Briefcase, placeholder: 'Company domains, e.g. ramp.com, linear.app', hint: 'Free · public job boards' },
};

const TEMPLATES = [
  { id: 'company_research', icon: Building2, title: 'Research companies', desc: 'Firmographics, tech stack, open roles and an AI summary.' },
  { id: 'find_emails', icon: Mail, title: 'Find work emails', desc: 'Name + domain → verified email → LinkedIn.' },
  { id: 'signals', icon: Radar, title: 'Monitor accounts', desc: 'Hiring, news, SEC filings, tech changes — alerts on change.' },
  { id: 'people', icon: Users, title: 'Blank people list', desc: 'Name, company, domain, title, LinkedIn.' },
];

export function HomePage() {
  const { me } = useAuth();
  const [days, setDays] = useState(30);
  const tables = useGtmTables();
  const stats = useQuery({ queryKey: ['ws-stats', days], queryFn: () => api.get('/api/workspaces/v1.1/stats', { days }).then((r) => r.data) });
  const chart = useQuery({ queryKey: ['ws-chart', days], queryFn: () => api.get('/api/workspaces/v1.1/line-area-chart-stats', { days }).then((r) => r.data as any[]) });
  const replies = useQuery({ queryKey: ['dash-replies'], queryFn: () => api.get('/api/replies', { folder: 'inbox', status: 'not_automated', per_page: 5 }).then((r) => r.data as any[]) });
  const campaigns = useQuery({ queryKey: ['dash-campaigns'], queryFn: () => api.get('/api/campaigns', { status: 'active', per_page: 5 }).then((r) => r.data as any[]) });
  const allCampaigns = useQuery({ queryKey: ['dash-campaign-count'], queryFn: () => api.get('/api/campaigns', { per_page: 1 }).then((r) => r.meta.total as number) });
  const warmup = useQuery({ queryKey: ['dash-warmup'], queryFn: () => api.get('/api/warmup/sender-emails').then((r) => (r.data as any[]).filter((s) => s.warmup_enabled).length) });
  const signals = useQuery({ queryKey: ['home-signals'], queryFn: () => api.get<any[]>('/api/gtm/signals', { limit: 6 }), refetchInterval: 60_000 });

  const s = stats.data;
  const prospects = (tables.data ?? []).reduce((n, t) => n + t.row_count, 0);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Page>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{greeting}{me?.name ? `, ${me.name.split(' ')[0]}` : ''}</h1>
          <p className="mt-1 text-[15px] text-slate-500">Find prospects, enrich them in tables, reach out, and work the replies — all from here.</p>
        </div>
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
      </div>

      {s && (
        <GetStarted counts={{
          lists: (tables.data?.length ?? 0) + (s.total_leads > 0 ? 1 : 0),
          senders: s.connected_senders + s.disconnected_senders, warmup: warmup.data ?? 0,
          campaigns: allCampaigns.data ?? 0, active: s.launched_campaigns,
        }} />
      )}

      {s?.disconnected_senders > 0 && (
        <div className="mb-6">
          <Alert tone="red" title={`${s.disconnected_senders} sender ${s.disconnected_senders === 1 ? 'email is' : 'emails are'} disconnected`} action={<Link to="/sender-emails"><Button size="sm">Fix now</Button></Link>}>
            Campaigns skip disconnected mailboxes until you reconnect them.
          </Alert>
        </div>
      )}

      <FindBox />

      {/* The pipeline, left to right */}
      <h2 className="mb-3 mt-10 text-[15px] font-semibold text-slate-900">Your pipeline</h2>
      {!s ? <Loading /> : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stage to={tables.data?.[0] ? `/tables/${tables.data[0].id}` : '/'} icon={Table2} label="Prospects in tables" value={prospects} hint={`${tables.data?.length ?? 0} ${tables.data?.length === 1 ? 'table' : 'tables'}`} />
          <Stage to="/leads" icon={Users} label="Leads" value={s.total_leads} hint="ready for campaigns" />
          <Stage to="/campaigns" icon={Rocket} label="Contacted" value={s.leads_contacted} hint={`${fmtNumber(s.emails_sent)} sent · ${fmtPct(s.bounce_rate)} bounced`} tone={s.bounce_rate > 3 ? 'warn' : undefined} />
          <Stage to="/inbox" icon={Inbox} label="Replied" value={s.unique_replies} hint={`${fmtPct(s.reply_rate)} reply rate`} />
          <Stage to="/inbox" icon={CheckCircle2} label="Interested" value={s.interested} hint={`${fmtPct(s.interested_rate)} of contacted`} last />
        </div>
      )}

      <Card title="Sending activity" className="mt-6" actions={
        <div className="hidden gap-4 text-xs text-slate-500 sm:flex">
          {SERIES.map((x) => <span key={x.key} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: x.color }} />{x.label}</span>)}
        </div>
      }>
        <div className="h-64 pb-4">
          {chart.data ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart.data} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  {SERIES.map((x) => (
                    <linearGradient key={x.key} id={`g-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={x.color} stopOpacity={0.16} />
                      <stop offset="100%" stopColor={x.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke="#f4f4f5" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 12, fill: '#71717a' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#71717a' }} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(d) => fmtDate(String(d), { weekday: 'short', month: 'short', day: 'numeric' })} contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7', fontSize: 13 }} />
                {SERIES.map((x) => <Area key={x.key} type="monotone" dataKey={x.key} name={x.label} stroke={x.color} strokeWidth={2} fill={`url(#g-${x.key})`} />)}
              </AreaChart>
            </ResponsiveContainer>
          ) : <Loading />}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Replies to handle" description="Newest human replies across all campaigns" padded={false} actions={<Link to="/inbox" className="text-sm font-medium text-brand-600 hover:text-brand-700">Open inbox</Link>}>
          {replies.data?.length === 0 && <EmptyState icon={<Inbox className="size-5" />} title="No replies yet" description="Replies from your leads land here and in the Master Inbox." />}
          <ul className="divide-y divide-slate-100">
            {replies.data?.map((r) => (
              <li key={r.id}>
                <Link to={`/inbox?reply=${r.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                  <div className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white', avatarColor(r.from_email))}>{initials(r.from_name || r.from_email)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cx('truncate text-sm', r.read ? 'text-slate-700' : 'font-semibold text-slate-900')}>{r.from_name || r.from_email}</span>
                      <ReplyCategory status={r.category} />
                    </div>
                    <div className="truncate text-[13px] text-slate-500">{r.preview}</div>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{fmtRelative(r.received_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Active campaigns" description="Sending right now" padded={false} actions={<Link to="/campaigns" className="text-sm font-medium text-brand-600 hover:text-brand-700">All campaigns</Link>}>
          {campaigns.data?.length === 0 && <EmptyState icon={<FileText className="size-5" />} title="No active campaigns" description="Send rows from a table to a campaign, then launch it." />}
          <ul className="divide-y divide-slate-100">
            {campaigns.data?.map((c) => (
              <li key={c.id}>
                <Link to={`/campaigns/${c.id}/stats`} className="block px-5 py-3 hover:bg-slate-50">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-slate-900">{c.name}</span>
                    <CampaignStatus status={c.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <ProgressBar value={c.stats.progress_percentage} />
                    <span className="w-10 shrink-0 text-right text-xs text-slate-500">{Math.round(c.stats.progress_percentage)}%</span>
                  </div>
                  <div className="mt-1.5 flex gap-4 text-xs text-slate-500">
                    <span>{fmtNumber(c.stats.emails_sent)} sent</span>
                    <span>{fmtPct(c.stats.unique_replies_per_contact_percentage)} replied</span>
                    <span>{fmtNumber(c.stats.interested)} interested</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Your tables" description="Prospect lists you're enriching" padded={false}>
          {tables.data?.length === 0 && <EmptyState icon={<Table2 className="size-5" />} title="No tables yet" description="Search above or start from a template below." />}
          <ul className="divide-y divide-slate-100">
            {tables.data?.slice(0, 6).map((t) => (
              <li key={t.id}>
                <Link to={`/tables/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                  <Table2 className="size-4 text-slate-400" />
                  <span className="flex-1 truncate text-sm font-medium text-slate-900">{t.name}</span>
                  <span className="text-xs text-slate-500">{fmtNumber(t.row_count)} rows · {fmtRelative(t.updated_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Latest signals" description="Changes on your accounts and outreach moments" padded={false} actions={<Link to="/signals" className="text-sm font-medium text-brand-600 hover:text-brand-700">All signals</Link>}>
          {signals.data?.length === 0 && <EmptyState icon={<Radar className="size-5" />} title="No signals yet" description="Add Signals to a company table to watch hiring, news, funding and tech changes." />}
          <ul className="divide-y divide-slate-100">
            {signals.data?.map((x, i) => (
              <li key={i}>
                <Link to={x.source === 'outreach' ? (x.replyId ? '/inbox' : x.campaignId ? `/campaigns/${x.campaignId}` : '/leads') : `/tables/${x.tableId}`} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                  {x.source === 'outreach' ? <Mail className="mt-0.5 size-4 text-teal-600" /> : <Radar className="mt-0.5 size-4 text-orange-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-900"><span className="font-medium">{String(x.row)}</span> · {x.source === 'outreach' ? x.label : x.column}</div>
                    <div className="truncate text-[13px] text-slate-500">{x.source === 'outreach' ? x.table : `${short(x.to)}`}</div>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{fmtRelative(x.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <h2 className="mb-3 mt-10 text-[15px] font-semibold text-slate-900">Start something new</h2>
      <Templates />
    </Page>
  );
}

function short(v: unknown): string {
  const h = v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as any) ? (v as any).value : v;
  if (h == null) return '';
  return Array.isArray(h) ? h.join(', ') : typeof h === 'object' ? JSON.stringify(h) : String(h);
}

function Stage({ to, icon: Icon, label, value, hint, tone, last }: { to: string; icon: typeof Users; label: string; value: number; hint: string; tone?: 'warn'; last?: boolean }) {
  return (
    <Link to={to} className="group relative rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 hover:shadow-sm">
      <div className="flex items-center gap-2 text-[13px] text-slate-500"><Icon className="size-4" strokeWidth={1.75} />{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900">{fmtNumber(value ?? 0)}</div>
      <div className={cx('mt-0.5 text-xs', tone === 'warn' ? 'text-red-600' : 'text-slate-400')}>{hint}</div>
      {!last && <ChevronRight className="absolute -right-[13px] top-1/2 z-10 hidden size-5 -translate-y-1/2 rounded-full border border-slate-200 bg-white p-0.5 text-slate-400 md:block" />}
    </Link>
  );
}

function GetStarted({ counts }: { counts: { lists: number; senders: number; warmup: number; campaigns: number; active: number } }) {
  const steps = [
    { done: counts.lists > 0, title: 'Build a prospect list', text: 'Search below, import a CSV or start from a template.', to: '#find', icon: Table2 },
    { done: counts.senders > 0, title: 'Connect a mailbox', text: 'Add the inboxes you will send from.', to: '/sender-emails', icon: AtSign },
    { done: counts.warmup > 0, title: 'Turn on warmup', text: 'Build reputation for 2–4 weeks first.', to: '/warmup', icon: Flame },
    { done: counts.campaigns > 0, title: 'Create a campaign', text: 'Write the sequence; send table rows to it.', to: '/campaigns', icon: FileText },
    { done: counts.active > 0, title: 'Launch', text: 'Review the checklist and start sending.', to: '/campaigns', icon: Rocket },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <Card title="Get started" description={`${done} of ${steps.length} steps done`} className="mb-6">
      <ProgressBar value={(done / steps.length) * 100} />
      <div className="mt-4 grid gap-3 pb-5 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => {
          const inner = (
            <>
              <div className="flex items-center gap-2">
                {s.done ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Circle className="size-4 text-slate-300" />}
                <span className={cx('text-sm font-medium', s.done ? 'text-emerald-800' : 'text-slate-800')}>{s.title}</span>
              </div>
              <p className="mt-1 text-[13px] text-slate-500">{s.text}</p>
            </>
          );
          const cls = cx('rounded-lg border p-3.5 transition-colors', s.done ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50');
          return s.to.startsWith('#') ? <a key={s.title} href={s.to} className={cls}>{inner}</a> : <Link key={s.title} to={s.to} className={cls}>{inner}</Link>;
        })}
      </div>
    </Card>
  );
}

/** Free prospect search that lands in a new table. */
function FindBox() {
  const [mode, setMode] = useState<Mode>('companies');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function find() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      const name = `${MODES[mode].label} · ${q.trim()}`.slice(0, 60);
      const t = await api.post<{ id: number }>('/api/gtm/tables', { name, template: 'blank' });
      const source = mode === 'companies' ? 'yc_companies' : mode === 'people' ? 'github_people' : 'jobs';
      const params = mode === 'companies' ? { query: q } : mode === 'people' ? (q.includes('.') ? { domain: q.trim() } : { org: q.trim() }) : { domains: q };
      await api.post(`/api/gtm/tables/${t.id}/import/source`, { source, params, limit: mode === 'people' ? 30 : 100 });
      const view = await api.get<any>(`/api/gtm/tables/${t.id}`);
      const placeholder = view.columns.find((c: any) => c.name === 'Name' && c.type === 'text');
      if (placeholder && view.columns.length > 1) await api.del(`/api/gtm/columns/${placeholder.id}`);
      await qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      navigate(`/tables/${t.id}`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="find" className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_40px_rgba(16,16,20,.08)]">
      <div className="mb-2 text-[15px] font-semibold text-slate-900">Find new prospects</div>
      <textarea
        rows={2}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void find(); } }}
        placeholder={MODES[mode].placeholder}
        className="w-full resize-none border-0 bg-transparent p-0 text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(Object.keys(MODES) as Mode[]).map((m) => {
          const M = MODES[m];
          return (
            <button key={m} onClick={() => setMode(m)} className={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium', m === mode ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70')}>
              <M.icon className="size-3.5" />{M.label}
            </button>
          );
        })}
        <span className="flex-1" />
        <span className="hidden text-xs text-slate-400 sm:inline">{MODES[mode].hint}</span>
        <button onClick={find} disabled={busy || !q.trim()} className="ml-2 inline-flex size-8 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40" aria-label="Search">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </div>
  );
}

function Templates() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  async function create(id: string, title: string) {
    const t = await api.post<{ id: number }>('/api/gtm/tables', { name: title, template: id });
    await qc.invalidateQueries({ queryKey: ['gtm-tables'] });
    navigate(`/tables/${t.id}${id === 'signals' ? '?signals=1' : ''}`);
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {TEMPLATES.map((t) => (
        <button key={t.id} onClick={() => create(t.id, t.title)} className="rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm">
          <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><t.icon className="size-4" /></span>
          <div className="mt-2.5 text-sm font-semibold text-slate-900">{t.title}</div>
          <div className="mt-0.5 text-[13px] text-slate-500">{t.desc}</div>
        </button>
      ))}
      <Link to="/leads" className="flex items-center justify-between rounded-xl border border-dashed border-slate-300 p-4 text-sm font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900 sm:col-span-2 lg:col-span-4">
        Already have leads? Open them in a table from the Leads page <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}
