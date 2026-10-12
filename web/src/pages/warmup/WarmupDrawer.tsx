import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api.ts';
import { fmtDate } from '../../lib/format.ts';
import { Card, Drawer, Loading } from '../../components/ui.tsx';
import { SenderStatus } from '../../components/status.tsx';
import { HealthBadge } from './HealthBadge.tsx';
import type { WarmupStats } from '../senders/types.ts';

interface Detail {
  id: number; name: string; email: string; status: string; warmup_enabled: boolean; warmup_daily_limit: number; warmup_reply_rate: number;
  today_target: number; stats: WarmupStats; stats_30d: WarmupStats; daily: { day: string; sent: number; inbox: number; spam: number; received: number }[];
}

/** Fills missing days so the chart shows a continuous 30-day axis. */
function fill(daily: Detail['daily']) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    const v = byDay.get(d);
    out.push({ day: d, label: fmtDate(`${d}T12:00:00Z`), sent: v?.sent ?? 0, inbox: v?.inbox ?? 0, spam: v?.spam ?? 0, received: v?.received ?? 0 });
  }
  return out;
}

export function WarmupDrawer({ senderId, onClose }: { senderId: number | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['warmup', 'detail', senderId],
    queryFn: () => api.get(`/api/warmup/sender-emails/${senderId}`).then((r) => r.data as Detail),
    enabled: !!senderId,
  });
  const d = q.data;
  const s30 = d?.stats_30d;
  return (
    <Drawer open={!!senderId} onClose={onClose} width="max-w-2xl" title={d?.name ?? 'Warmup'} subtitle={d?.email} actions={d && <SenderStatus status={d.status} />}>
      {!d ? <Loading /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Health (30d)', <HealthBadge score={s30!.health_score} large />],
              ['Today', `${d.today_target} / ${d.warmup_daily_limit}`],
              ['Sent (30d)', s30!.sent],
              ['Rescued from spam', s30!.rescued],
            ].map(([label, value], i) => (
              <div key={i} className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="mt-0.5 text-lg font-semibold text-slate-900">{value}</div>
              </div>
            ))}
          </div>
          <Card title="Last 30 days" description="Warmup emails this mailbox sent, where they landed, and how many it received from the pool.">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fill(d.daily)} margin={{ left: -20, right: 8, top: 4 }}>
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} interval={4} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0', fontSize: 12 }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="inbox" name="Landed in inbox" stackId="placed" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="spam" name="Landed in spam" stackId="placed" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="received" name="Received" fill="#93c5fd" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Totals (30 days)">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
              {[
                ['Sent', s30!.sent], ['New threads', s30!.sent_new], ['Replies sent', s30!.replies_sent],
                ['Landed in inbox', s30!.landed_inbox], ['Landed in spam', s30!.landed_spam], ['Received', s30!.received],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between border-b border-slate-100 py-1.5"><dt className="text-slate-500">{k}</dt><dd className="font-medium tabular-nums text-slate-800">{v}</dd></div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-slate-500">Reply rate setting: {d.warmup_reply_rate}% · Daily limit: {d.warmup_daily_limit}</p>
          </Card>
        </div>
      )}
    </Drawer>
  );
}
