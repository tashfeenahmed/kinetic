import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, type Paginated } from '../lib/api.ts';
import { fmtDate, fmtNumber, fmtTime, fullName } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Button, Card, EmptyState, Input, Loading, Pagination, ProgressBar, Select, Stat, Table, Td, Th, cx } from '../components/ui.tsx';
import { ScheduledStatus, SenderStatus } from '../components/status.tsx';

interface Summary {
  days: { day: string; status: string; n: number }[];
  capacity: number;
  by_sender: { id: number; email: string; daily_limit: number; status: string; sent: number | null; scheduled: number | null; failed: number | null }[];
}

interface Slot {
  id: number; campaign_id: number; campaign_name: string; step_order: number; email_subject: string | null;
  lead_email: string; first_name: string; last_name: string; sender_email: string; scheduled_at: string; status: string; error: string | null;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDate = (iso: string, days: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return localDate(d); };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function SendingSchedulePage() {
  const [date, setDate] = useState(localDate());
  const [status, setStatus] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [senderId, setSenderId] = useState('');
  const [page, setPage] = useState(1);

  const summary = useQuery({ queryKey: ['schedule-summary'], queryFn: () => api.get('/api/scheduled-emails/summary').then((r) => r.data as Summary), refetchInterval: 60_000 });
  const campaigns = useQuery({ queryKey: ['campaigns', 'options'], queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as { id: number; name: string }[]) });
  const senders = useQuery({ queryKey: ['senders', 'options'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as { id: number; email: string }[]) });
  const slots = useQuery({
    queryKey: ['scheduled-emails', date, status, campaignId, senderId, page],
    queryFn: () => api.get<Paginated<Slot>>('/api/scheduled-emails', { date, tz: TZ, status, campaign_id: campaignId, sender_email_id: senderId, page, per_page: 50 }),
    refetchInterval: 30_000,
  });

  const chart = useMemo(() => {
    const map = new Map<string, { sent: number; scheduled: number; failed: number }>();
    for (const d of summary.data?.days ?? []) {
      const e = map.get(d.day) ?? { sent: 0, scheduled: 0, failed: 0 };
      if (d.status === 'sent') e.sent += d.n;
      else if (d.status === 'scheduled' || d.status === 'sending') e.scheduled += d.n;
      else if (d.status === 'failed') e.failed += d.n;
      map.set(d.day, e);
    }
    const out = [];
    const today = new Date();
    for (let i = -6; i <= 7; i++) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i)).toISOString().slice(0, 10);
      out.push({ day, label: i === 0 ? 'Today' : fmtDate(`${day}T12:00:00Z`), ...(map.get(day) ?? { sent: 0, scheduled: 0, failed: 0 }) });
    }
    return out;
  }, [summary.data]);

  const today = chart.find((d) => d.label === 'Today');
  const reset = (fn: () => void) => { fn(); setPage(1); };

  return (
    <Page wide>
      <PageHeader title="Sending Schedule" subtitle="Emails are booked when a campaign's window opens and spread across the day" />

      <div className="mb-8 grid grid-cols-2 gap-6 rounded-2xl border border-slate-200 bg-white p-5 lg:grid-cols-4">
        <Stat label="Daily capacity" value={fmtNumber(summary.data?.capacity ?? 0)} />
        <Stat label="Sent today" value={fmtNumber(today?.sent ?? 0)} />
        <Stat label="Scheduled today" value={fmtNumber(today?.scheduled ?? 0)} />
        <Stat label="Failed today" value={fmtNumber(today?.failed ?? 0)} tone={today?.failed ? 'red' : undefined} />
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card title="Last 7 days and next 7 days">
          {summary.isLoading ? <Loading /> : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ left: -16, right: 8, top: 4 }}>
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={44} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0', fontSize: 12 }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sent" name="Sent" stackId="a" fill="#10b981" />
                  <Bar dataKey="scheduled" name="Scheduled" stackId="a" fill="#3b82f6" />
                  <Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Mailboxes today" padded={false}>
          {!summary.data?.by_sender.length ? (
            <EmptyState title="No mailboxes" description={<Link to="/sender-emails" className="text-brand-600 hover:underline">Add email accounts</Link>} />
          ) : (
            <div className="max-h-72 overflow-y-auto scroll-thin">
              <Table>
                <thead><tr><Th>Mailbox</Th><Th className="text-right">Sent</Th><Th className="text-right">Queued</Th><Th>Usage</Th></tr></thead>
                <tbody>
                  {summary.data.by_sender.map((s) => {
                    const used = (s.sent ?? 0) + (s.scheduled ?? 0);
                    return (
                      <tr key={s.id}>
                        <Td>
                          <div className="max-w-52 truncate text-[13px] font-medium text-slate-800">{s.email}</div>
                          {s.status !== 'Connected' && <SenderStatus status={s.status} className="mt-1" />}
                          {!!s.failed && <div className="text-xs text-red-600">{s.failed} failed</div>}
                        </Td>
                        <Td className="text-right tabular-nums">{s.sent ?? 0}</Td>
                        <Td className="text-right tabular-nums">{s.scheduled ?? 0}</Td>
                        <Td className="min-w-28">
                          <div className="mb-1 text-xs text-slate-500">{used} / {s.daily_limit}</div>
                          <ProgressBar value={(used / Math.max(1, s.daily_limit)) * 100} tone={used >= s.daily_limit ? 'yellow' : 'blue'} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <Card padded={false}
        title={<span className="flex items-center gap-2"><CalendarClock className="size-4 text-slate-400" /> Emails for {date === localDate() ? 'today' : fmtDate(`${date}T12:00:00`, { weekday: 'long', month: 'short', day: 'numeric' })}</span>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label="Previous day" onClick={() => reset(() => setDate((d) => shiftDate(d, -1)))}><ChevronLeft className="size-4" /></Button>
              <Input type="date" className="h-8 w-40" value={date} onChange={(e) => e.target.value && reset(() => setDate(e.target.value))} />
              <Button size="sm" variant="ghost" aria-label="Next day" onClick={() => reset(() => setDate((d) => shiftDate(d, 1)))}><ChevronRight className="size-4" /></Button>
              {date !== localDate() && <Button size="sm" onClick={() => reset(() => setDate(localDate()))}>Today</Button>}
            </div>
            <Select value={status} onChange={(e) => reset(() => setStatus(e.target.value))} className="w-36">
              <option value="">All statuses</option>
              {['scheduled', 'sending', 'sent', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
            </Select>
            <Select value={campaignId} onChange={(e) => reset(() => setCampaignId(e.target.value))} className="w-44">
              <option value="">All campaigns</option>
              {campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select value={senderId} onChange={(e) => reset(() => setSenderId(e.target.value))} className="w-52">
              <option value="">All mailboxes</option>
              {senders.data?.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
            </Select>
          </div>
        }>
        {slots.isLoading ? <Loading /> : !slots.data?.data.length ? (
          <EmptyState icon={<CalendarClock className="size-5" />} title="Nothing scheduled for this day"
            description="Emails appear here once an active campaign's sending window opens for the day." />
        ) : (
          <>
            <Table>
              <thead><tr><Th>Time</Th><Th>Campaign</Th><Th>Step</Th><Th>Lead</Th><Th>From</Th><Th>Status</Th></tr></thead>
              <tbody>
                {slots.data.data.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/70">
                    <Td className="whitespace-nowrap tabular-nums text-slate-800">{fmtTime(s.scheduled_at)}</Td>
                    <Td><Link to={`/campaigns/${s.campaign_id}`} className="font-medium text-slate-800 hover:text-brand-600">{s.campaign_name}</Link></Td>
                    <Td className="whitespace-nowrap">
                      <span className="text-slate-800">Step {s.step_order}</span>
                      {s.email_subject && <div className="max-w-56 truncate text-xs text-slate-500">{s.email_subject}</div>}
                    </Td>
                    <Td><div className="text-slate-800">{fullName(s)}</div>{fullName(s) !== s.lead_email && <div className="text-xs text-slate-500">{s.lead_email}</div>}</Td>
                    <Td className="text-[13px]">{s.sender_email}</Td>
                    <Td>
                      <ScheduledStatus status={s.status} />
                      {s.error && (s.status === 'failed' || s.status === 'cancelled') && <div className={cx('mt-1 max-w-64 truncate text-xs', s.status === 'failed' ? 'text-red-600' : 'text-slate-500')} title={s.error}>{s.error}</div>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination meta={slots.data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </Page>
  );
}
