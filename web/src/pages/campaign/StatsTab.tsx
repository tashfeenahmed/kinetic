import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api.ts';
import { fmtDate, fmtNumber, fmtPct, plural } from '../../lib/format.ts';
import { Badge, Card, Loading, Stat, Table, Td, Th, cx } from '../../components/ui.tsx';
import { type Campaign, type CampaignStats, variantLetter } from './types.ts';

interface StepStat {
  sequence_step_id: number;
  step_order: number;
  variant_of_step_id: number | null;
  email_subject: string;
  active: number;
  sent: number;
  leads_contacted: number;
  unique_opens: number;
  bounced: number;
  unique_replies: number;
  interested: number;
  unsubscribed: number;
}

const SERIES = [
  { key: 'sent', label: 'Sent', color: '#2563eb' },
  { key: 'replied', label: 'Replied', color: '#10b981' },
  { key: 'interested', label: 'Interested', color: '#8b5cf6' },
  { key: 'bounced', label: 'Bounced', color: '#ef4444' },
] as const;

const rate = (n: number, d: number) => (d ? (n / d) * 100 : 0);

export function StatsTab({ campaign }: { campaign: Campaign }) {
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: ['campaign', campaign.id, 'stats'],
    queryFn: () => api.post(`/api/campaigns/${campaign.id}/stats`, {}).then((r) => r.data as CampaignStats & { sequence_step_stats: StepStat[] }),
    refetchInterval: 60_000,
  });
  const chart = useQuery({
    queryKey: ['campaign', campaign.id, 'chart', days],
    queryFn: () => api.get(`/api/campaigns/${campaign.id}/line-area-chart-stats`, { days }).then((r) => r.data as Record<string, any>[]),
  });

  if (stats.isLoading) return <Loading />;
  const s = stats.data!;

  // Label variants A, B, C within each step.
  const letters = new Map<number, string>();
  const byStep = new Map<number, StepStat[]>();
  for (const r of s.sequence_step_stats) byStep.set(r.step_order, [...(byStep.get(r.step_order) ?? []), r]);
  for (const rows of byStep.values()) {
    rows.sort((a, b) => (a.variant_of_step_id ? 1 : 0) - (b.variant_of_step_id ? 1 : 0) || a.sequence_step_id - b.sequence_step_id);
    rows.forEach((r, i) => letters.set(r.sequence_step_id, variantLetter(i)));
  }
  const bestReply = new Map<number, number>();
  for (const [order, rows] of byStep) {
    if (rows.length < 2) continue;
    const best = rows.filter((r) => r.sent >= 20).sort((a, b) => rate(b.unique_replies, b.sent) - rate(a.unique_replies, a.sent))[0];
    if (best && best.unique_replies > 0) bestReply.set(order, best.sequence_step_id);
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Sent" value={fmtNumber(s.emails_sent)} sub={`${plural(s.total_leads, 'lead')} total`} />
        <Stat label="Contacted" value={fmtNumber(s.total_leads_contacted)} sub={`${fmtPct(s.progress_percentage)} finished`} />
        <Stat label="Opened" value={campaign.open_tracking ? fmtPct(s.unique_opens_per_contact_percentage) : '—'} sub={campaign.open_tracking ? plural(s.unique_opens_per_contact, 'lead') : 'Tracking off'} />
        <Stat label="Replied" value={fmtPct(s.unique_replies_per_contact_percentage)} sub={plural(s.unique_replies_per_contact, 'lead')} tone="blue" />
        <Stat label="Interested" value={fmtPct(s.interested_percentage)} sub={plural(s.interested, 'lead')} tone="green" />
        <Stat label="Bounced" value={fmtPct(s.bounced_percentage)} sub={plural(s.bounced, 'lead')} tone={s.bounced_percentage > 3 ? 'red' : undefined} />
        <Stat label="Unsubscribed" value={fmtPct(s.unsubscribed_percentage)} sub={plural(s.unsubscribed, 'lead')} />
      </div>

      <Card
        title="Activity"
        actions={
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={cx('rounded-md px-2.5 py-1 text-xs font-medium', days === d ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}>{d} days</button>
            ))}
          </div>
        }
      >
        {chart.isLoading ? <Loading /> : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart.data} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <defs>
                  {SERIES.map((x) => (
                    <linearGradient key={x.key} id={`g-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={x.color} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={x.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d) => fmtDate(`${d}T12:00:00Z`)} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(d) => fmtDate(`${d}T12:00:00Z`, { weekday: 'short', month: 'short', day: 'numeric' })} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 13 }} />
                {SERIES.map((x) => <Area key={x.key} type="monotone" dataKey={x.key} name={x.label} stroke={x.color} strokeWidth={2} fill={`url(#g-${x.key})`} />)}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="Sequence steps" description="Variants of the same step are A/B tested — the leader is marked once each has 20+ sends." padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>Step</Th>
              <Th>Subject</Th>
              <Th className="text-right">Sent</Th>
              <Th className="text-right">Opens</Th>
              <Th className="text-right">Replies</Th>
              <Th className="text-right">Reply rate</Th>
              <Th className="text-right">Interested</Th>
              <Th className="text-right">Bounced</Th>
            </tr>
          </thead>
          <tbody>
            {s.sequence_step_stats.length === 0 && <tr><Td className="text-center text-slate-500" >No steps yet.</Td></tr>}
            {[...byStep.entries()].sort((a, b) => a[0] - b[0]).flatMap(([order, rows]) => rows.map((r, i) => (
              <tr key={r.sequence_step_id} className={cx(!r.active && 'opacity-50')}>
                <Td className="whitespace-nowrap">
                  {i === 0 ? <span className="font-medium text-slate-900">Step {order}</span> : <span className="pl-4 text-slate-400">↳</span>}
                  {rows.length > 1 && <Badge tone="purple" className="ml-2">{letters.get(r.sequence_step_id)}</Badge>}
                  {bestReply.get(order) === r.sequence_step_id && <Badge tone="green" className="ml-1">Leading</Badge>}
                </Td>
                <Td className="max-w-72 truncate">{r.email_subject || <span className="italic text-slate-400">Reply in thread</span>}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(r.sent)}</Td>
                <Td className="text-right tabular-nums">{campaign.open_tracking ? fmtNumber(r.unique_opens) : '—'}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(r.unique_replies)}</Td>
                <Td className="text-right tabular-nums font-medium">{fmtPct(rate(r.unique_replies, r.leads_contacted))}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(r.interested)}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(r.bounced)}</Td>
              </tr>
            )))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
