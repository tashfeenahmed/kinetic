import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { Alert, Card, Loading, Stat, Table, Td, Th } from '../../components/ui.tsx';
import { Meter, SectionTitle, StatusBadge, useCompanionStatus, type LimitUse, type Run } from './shared.tsx';

interface Stats {
  limits: LimitUse[];
  jobs: Record<'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled', number>;
  days: { date: string; runs: number; results: number; actions: number }[];
  recent_runs: (Run & { job_id: number; job_name: string; phantom: string })[];
  pending_approvals: number;
}

/** Stats dashboard: limits used, jobs by status, 14-day activity, recent runs. */
export function Overview() {
  const stats = useQuery({ queryKey: ['automations', 'stats'], queryFn: () => api.get<{ data: Stats }>('/api/automations/stats').then((r) => r.data), refetchInterval: 20_000 });
  const status = useCompanionStatus();
  if (stats.isLoading) return <Loading />;
  const s = stats.data;
  if (!s) return <Alert tone="red">Could not load automation stats.</Alert>;
  const online = status.data?.online;
  const devices = status.data?.devices.length ?? 0;

  return (
    <div className="space-y-6">
      {status.data?.paused && <Alert tone="yellow" title="All automations are paused">Resume them on the <Link className="underline" to="/automations/limits">Limits & safety</Link> tab.</Alert>}
      {s.pending_approvals > 0 && <Alert tone="blue" title={`${s.pending_approvals} AI comment${s.pending_approvals === 1 ? '' : 's'} waiting for approval`} action={<Link to="/automations/approvals" className="shrink-0 text-[13px] font-medium underline">Review</Link>} />}

      <div className="grid grid-cols-2 gap-4 rounded-2xl border border-zinc-200 bg-white p-5 sm:grid-cols-5">
        <Stat label="Extension" value={devices ? (online ? 'Online' : 'Offline') : 'Not paired'} sub={devices ? `${devices} browser${devices === 1 ? '' : 's'}` : <Link to="/automations/extension" className="underline">Install</Link>} tone={devices && !online ? 'red' : undefined} />
        <Stat label="Running" value={s.jobs.running + s.jobs.queued} sub={`${s.jobs.queued} queued`} />
        <Stat label="Paused" value={s.jobs.paused} />
        <Stat label="Completed" value={s.jobs.completed} />
        <Stat label="Failed" value={s.jobs.failed} tone={s.jobs.failed ? 'red' : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card title="Last 14 days" description="Runs, results collected and actions performed.">
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={s.days.map((d) => ({ ...d, label: d.date.slice(5) }))} margin={{ left: -18, right: 4, top: 4 }}>
                <CartesianGrid vertical={false} stroke="#f1f1f4" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#71717a' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#71717a' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: '#f4f4f5' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="results" name="Results" fill="#27272a" radius={[3, 3, 0, 0]} />
                <Bar dataKey="actions" name="Actions" fill="#3b5bfd" radius={[3, 3, 0, 0]} />
                <Bar dataKey="runs" name="Runs" fill="#a1a1aa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Limits used" description="Today, and this rolling week where set.">
          <div className="space-y-3">
            {s.limits.map((l) => (
              <Meter key={l.action} label={l.label} used={l.used_today} limit={l.daily}
                sub={l.weekly ? `${l.used_week.toLocaleString()} / ${l.weekly.toLocaleString()} this week` : undefined} />
            ))}
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle>Recent runs</SectionTitle>
        {!s.recent_runs.length ? <p className="text-[13px] text-zinc-500">Nothing has run yet. Start with the <Link to="/automations/catalogue" className="underline">catalogue</Link>.</p> : (
          <div className="rounded-lg border border-zinc-200">
            <Table>
              <thead><tr><Th>Automation</Th><Th>Status</Th><Th>Results</Th><Th>New</Th><Th>Actions</Th><Th>Started</Th></tr></thead>
              <tbody>
                {s.recent_runs.map((r) => (
                  <tr key={r.id} className="text-[13px]">
                    <Td className="py-2"><Link to="/automations/jobs" className="font-medium text-zinc-900 hover:underline">{r.job_name}</Link></Td>
                    <Td className="py-2"><StatusBadge status={r.status} /></Td>
                    <Td className="py-2">{r.results}</Td><Td className="py-2">{r.new_results}</Td><Td className="py-2">{r.actions}</Td>
                    <Td className="py-2 text-zinc-500">{fmtDateTime(r.started_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
