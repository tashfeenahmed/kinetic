import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AtSign, CheckCircle2, Circle, FileText, Flame, Inbox, Rocket, Users } from 'lucide-react';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { avatarColor, fmtDate, fmtNumber, fmtPct, fmtRelative, initials } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Button, Card, EmptyState, Loading, ProgressBar, Select, Stat, cx } from '../components/ui.tsx';
import { CampaignStatus, ReplyCategory } from '../components/status.tsx';

const SERIES = [
  { key: 'sent', label: 'Sent', color: '#2563eb' },
  { key: 'replied', label: 'Replies', color: '#10b981' },
  { key: 'interested', label: 'Interested', color: '#f59e0b' },
  { key: 'bounced', label: 'Bounced', color: '#ef4444' },
] as const;

function Onboarding({ counts }: { counts: { senders: number; leads: number; campaigns: number; active: number; warmup: number } }) {
  const steps = [
    { done: counts.senders > 0, title: 'Connect a sender email', text: 'Add the mailboxes you will send from.', to: '/sender-emails', icon: AtSign },
    { done: counts.warmup > 0, title: 'Turn on warmup', text: 'Let new mailboxes build reputation for 2–4 weeks.', to: '/warmup', icon: Flame },
    { done: counts.leads > 0, title: 'Import leads', text: 'Upload a CSV of the people you want to reach.', to: '/leads', icon: Users },
    { done: counts.campaigns > 0, title: 'Create a campaign', text: 'Write your sequence and choose your schedule.', to: '/campaigns', icon: FileText },
    { done: counts.active > 0, title: 'Launch', text: 'Review the checklist and start sending.', to: '/campaigns', icon: Rocket },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <Card title="Get started" description={`${done} of ${steps.length} steps done`} className="mb-6">
      <ProgressBar value={(done / steps.length) * 100} />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => (
          <Link key={s.title} to={s.to} className={cx('group rounded-lg border p-3.5 transition-colors', s.done ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200 hover:border-brand-300 hover:bg-brand-50/40')}>
            <div className="flex items-center gap-2">
              {s.done ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Circle className="size-4 text-slate-300" />}
              <span className={cx('text-sm font-medium', s.done ? 'text-emerald-800' : 'text-slate-800')}>{s.title}</span>
            </div>
            <p className="mt-1 text-[13px] text-slate-500">{s.text}</p>
          </Link>
        ))}
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const { me } = useAuth();
  const [days, setDays] = useState(30);
  const stats = useQuery({ queryKey: ['ws-stats', days], queryFn: () => api.get('/api/workspaces/v1.1/stats', { days }).then((r) => r.data) });
  const chart = useQuery({ queryKey: ['ws-chart', days], queryFn: () => api.get('/api/workspaces/v1.1/line-area-chart-stats', { days }).then((r) => r.data as any[]) });
  const replies = useQuery({ queryKey: ['dash-replies'], queryFn: () => api.get('/api/replies', { folder: 'inbox', status: 'not_automated', per_page: 6 }).then((r) => r.data as any[]) });
  const campaigns = useQuery({ queryKey: ['dash-campaigns'], queryFn: () => api.get('/api/campaigns', { status: 'active', per_page: 6 }).then((r) => r.data as any[]) });
  const allCampaigns = useQuery({ queryKey: ['dash-campaign-count'], queryFn: () => api.get('/api/campaigns', { per_page: 1 }).then((r) => r.meta.total as number) });
  const warmup = useQuery({ queryKey: ['dash-warmup'], queryFn: () => api.get('/api/warmup/sender-emails').then((r) => (r.data as any[]).filter((s) => s.warmup_enabled).length) });

  const s = stats.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        subtitle={`${greeting}, ${me?.name.split(' ')[0] ?? ''}`}
        actions={
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        }
      />

      {s && (
        <Onboarding counts={{ senders: s.connected_senders + s.disconnected_senders, leads: s.total_leads, campaigns: allCampaigns.data ?? 0, active: s.launched_campaigns, warmup: warmup.data ?? 0 }} />
      )}

      {s?.disconnected_senders > 0 && (
        <div className="mb-6">
          <Alert tone="red" title={`${s.disconnected_senders} sender ${s.disconnected_senders === 1 ? 'email is' : 'emails are'} disconnected`} action={<Link to="/sender-emails"><Button size="sm">Fix now</Button></Link>}>
            Campaigns skip disconnected mailboxes until you reconnect them.
          </Alert>
        </div>
      )}

      {!s ? <Loading /> : (
        <div className="grid grid-cols-2 gap-6 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Emails sent" value={fmtNumber(s.emails_sent)} />
          <Stat label="Leads contacted" value={fmtNumber(s.leads_contacted)} />
          <Stat label="Reply rate" value={fmtPct(s.reply_rate)} />
          <Stat label="Interested" value={fmtNumber(s.interested)} />
          <Stat label="Bounce rate" value={fmtPct(s.bounce_rate)} tone={s.bounce_rate > 3 ? 'red' : undefined} />
          <Stat label="Active campaigns" value={fmtNumber(s.active_campaigns)} />
        </div>
      )}

      <Card title="Activity" className="mt-6" actions={
        <div className="hidden gap-4 text-xs text-slate-500 sm:flex">
          {SERIES.map((x) => <span key={x.key} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: x.color }} />{x.label}</span>)}
        </div>
      }>
        <div className="h-72">
          {chart.data ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart.data} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  {SERIES.map((x) => (
                    <linearGradient key={x.key} id={`g-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={x.color} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={x.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(d) => fmtDate(String(d), { weekday: 'short', month: 'short', day: 'numeric' })} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }} />
                {SERIES.map((x) => <Area key={x.key} type="monotone" dataKey={x.key} name={x.label} stroke={x.color} strokeWidth={2} fill={`url(#g-${x.key})`} />)}
              </AreaChart>
            </ResponsiveContainer>
          ) : <Loading />}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Latest replies" padded={false} actions={<Link to="/inbox" className="text-sm font-medium text-brand-600 hover:text-brand-700">Open inbox</Link>}>
          {replies.data?.length === 0 && <EmptyState icon={<Inbox className="size-5" />} title="No replies yet" description="Replies from your leads show up here and in the Master Inbox." />}
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

        <Card title="Active campaigns" padded={false} actions={<Link to="/campaigns" className="text-sm font-medium text-brand-600 hover:text-brand-700">All campaigns</Link>}>
          {campaigns.data?.length === 0 && <EmptyState icon={<FileText className="size-5" />} title="No active campaigns" description="Launch a campaign to see its progress here." />}
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
    </Page>
  );
}
