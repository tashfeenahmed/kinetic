import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Eye, MoreHorizontal, Pause, Play, RefreshCw, Square, Table2, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtDateTime, fmtRelative } from '../../lib/format.ts';
import { Badge, Button, Drawer, EmptyState, IconButton, Loading, Menu, ProgressBar, Select, Table, Td, Th, useUi } from '../../components/ui.tsx';
import { NetworkIcon, StatusBadge, type Job, type Run } from './shared.tsx';

export type JobAction = 'start' | 'pause' | 'resume' | 'cancel' | 'run-now' | 'delete';

export function useJobActions() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const m = useMutation({
    mutationFn: ({ id, action }: { id: number; action: JobAction }) =>
      action === 'delete' ? api.del(`/api/automations/jobs/${id}`) : api.post(`/api/automations/jobs/${id}/${action}`),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      toast({ start: 'Started', pause: 'Paused', resume: 'Resumed', cancel: 'Cancelled', 'run-now': 'Queued a new run', delete: 'Deleted' }[v.action]);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return async (job: Job, action: JobAction) => {
    if (action === 'start' && job.category === 'action' && !(await confirm({
      title: `Start “${job.name}”?`,
      message: 'The extension will act on your account (visit, connect, message, like or comment) at human pace within your daily limits and working hours.',
      confirmLabel: 'Start automation',
    }))) return;
    if (action === 'delete' && !(await confirm({ title: `Delete “${job.name}”?`, message: 'Its queued tasks and run history are deleted. The results table is kept.', confirmLabel: 'Delete', danger: true }))) return;
    if (action === 'cancel' && !(await confirm({ title: `Cancel “${job.name}”?`, message: 'Queued tasks are dropped. Results already collected stay in the table.', confirmLabel: 'Cancel automation', danger: true }))) return;
    m.mutate({ id: job.id, action });
  };
}

const EVERY: Record<string, string> = { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly' };

export function JobsList({ filter, emptyAction }: { filter?: { phantom?: string; category?: string }; emptyAction?: React.ReactNode }) {
  const jobs = useQuery({
    queryKey: ['automations', 'jobs', filter ?? {}],
    queryFn: () => api.get<{ data: Job[] }>('/api/automations/jobs', filter).then((r) => r.data),
    refetchInterval: 10_000,
  });
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const act = useJobActions();

  if (jobs.isLoading) return <Loading />;
  const rows = (jobs.data ?? []).filter((j) => !status || j.status === status);
  if (!jobs.data?.length) return <EmptyState icon={<Bot className="size-5" />} title="No automations yet" description="Pick one from the catalogue — results land in a table you can enrich and send to campaigns." action={emptyAction} />;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">All statuses</option>
          {['draft', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <span className="text-[12.5px] text-zinc-500">{rows.length} automation{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="rounded-lg border border-zinc-200">
        <Table>
          <thead><tr><Th>Automation</Th><Th>Status</Th><Th>Progress</Th><Th>Schedule</Th><Th>Results</Th><Th>Last run</Th><Th className="w-10" /></tr></thead>
          <tbody>
            {rows.map((j) => {
              const total = j.progress.total ?? (j.tasks.pending + j.tasks.leased + j.tasks.done + j.tasks.failed + j.tasks.skipped);
              const done = j.progress.done ?? (j.tasks.done + j.tasks.failed + j.tasks.skipped);
              return (
                <tr key={j.id} className="cursor-pointer text-[13px] hover:bg-zinc-50" onClick={() => setOpenId(j.id)}>
                  <Td className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      <NetworkIcon network={j.network} size={22} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-900">{j.name}</div>
                        <div className="truncate text-[12px] text-zinc-500">{j.phantom_label}</div>
                      </div>
                    </div>
                  </Td>
                  <Td className="py-2.5"><StatusBadge status={j.status} />{j.error && <div className="mt-0.5 max-w-48 truncate text-[11.5px] text-red-600" title={j.error}>{j.error}</div>}</Td>
                  <Td className="w-44 py-2.5">
                    {total > 0 ? (<><ProgressBar value={(done / total) * 100} tone={j.status === 'failed' ? 'red' : 'blue'} /><div className="mt-1 text-[11.5px] text-zinc-500">{done} / {total}{j.progress.message ? ` · ${j.progress.message}` : ''}</div></>)
                      : <span className="text-[12px] text-zinc-400">{j.progress.message ?? '—'}</span>}
                  </Td>
                  <Td className="py-2.5">{j.schedule.every ? <Badge tone="purple">{EVERY[j.schedule.every]}{j.watcher ? ' · new only' : ''}</Badge> : <span className="text-zinc-400">Once</span>}
                    {j.next_run_at && <div className="mt-0.5 text-[11.5px] text-zinc-400">next {fmtRelative(j.next_run_at)}</div>}</Td>
                  <Td className="py-2.5">
                    {j.table_id ? <Link to={`/tables/${j.table_id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-zinc-800 hover:underline"><Table2 className="size-3.5 text-zinc-400" />{j.results_count.toLocaleString()}</Link> : j.results_count}
                  </Td>
                  <Td className="py-2.5 text-[12px] text-zinc-500">{fmtRelative(j.last_run_at)}</Td>
                  <Td className="py-2.5" onClick={() => {}}>
                    <span onClick={(e) => e.stopPropagation()}><JobMenu job={j} act={act} onOpen={() => setOpenId(j.id)} /></span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
      <JobDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function JobMenu({ job: j, act, onOpen }: { job: Job; act: ReturnType<typeof useJobActions>; onOpen: () => void }) {
  const items: Parameters<typeof Menu>[0]['items'] = [{ label: 'Details', icon: <Eye className="size-4" />, onClick: onOpen }];
  if (j.status === 'draft') items.push({ label: 'Start', icon: <Play className="size-4" />, onClick: () => act(j, 'start') });
  if (j.status === 'queued' || j.status === 'running') items.push({ label: 'Pause', icon: <Pause className="size-4" />, onClick: () => act(j, 'pause') });
  if (j.status === 'paused') items.push({ label: 'Resume', icon: <Play className="size-4" />, onClick: () => act(j, 'resume') });
  if (['completed', 'failed', 'cancelled'].includes(j.status)) items.push({ label: 'Run again', icon: <RefreshCw className="size-4" />, onClick: () => act(j, 'run-now') });
  if (['draft', 'queued', 'running', 'paused'].includes(j.status)) items.push({ label: 'Cancel', icon: <Square className="size-4" />, onClick: () => act(j, 'cancel') });
  items.push('divider', { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: () => act(j, 'delete') });
  return <Menu trigger={(open) => <IconButton label="Actions" onClick={open}><MoreHorizontal className="size-4" /></IconButton>} items={items} />;
}

interface TaskRow { id: number; kind: string; status: string; target: Record<string, any>; error: string | null; attempts: number; results_count: number; not_before: string | null; updated_at: string }

export function JobDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const job = useQuery({
    queryKey: ['automations', 'job', id], enabled: !!id, refetchInterval: 8000,
    queryFn: () => api.get<{ data: Job & { runs: Run[] } }>(`/api/automations/jobs/${id}`).then((r) => r.data),
  });
  const tasks = useQuery({
    queryKey: ['automations', 'job', id, 'tasks'], enabled: !!id, refetchInterval: 8000,
    queryFn: () => api.get<{ data: TaskRow[] }>(`/api/automations/jobs/${id}/tasks`).then((r) => r.data),
  });
  const act = useJobActions();
  const j = job.data;
  return (
    <Drawer open={!!id} onClose={onClose} width="max-w-3xl" title={j?.name ?? 'Automation'} subtitle={j?.phantom_label}
      actions={j && (
        <>
          {j.status === 'draft' && <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => act(j, 'start')}>Start</Button>}
          {(j.status === 'queued' || j.status === 'running') && <Button size="sm" icon={<Pause className="size-3.5" />} onClick={() => act(j, 'pause')}>Pause</Button>}
          {j.status === 'paused' && <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => act(j, 'resume')}>Resume</Button>}
          {['completed', 'failed', 'cancelled'].includes(j.status) && <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => act(j, 'run-now')}>Run again</Button>}
        </>
      )}>
      {!j ? <Loading /> : (
        <div className="space-y-6 text-[13px]">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <Info label="Status"><StatusBadge status={j.status} /></Info>
            <Info label="Results">{j.table_id ? <Link className="hover:underline" to={`/tables/${j.table_id}`}>{j.results_count.toLocaleString()} in {j.table_name ?? 'table'}</Link> : j.results_count}</Info>
            <Info label="Schedule">{j.schedule.every ? `${EVERY[j.schedule.every]}${j.watcher ? ', new only' : ''}` : 'Once'}</Info>
            <Info label="Next run">{fmtDateTime(j.next_run_at)}</Info>
          </div>
          {j.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{j.error}</div>}
          <div>
            <div className="mb-2 font-semibold text-zinc-900">Inputs</div>
            <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-50 p-3 text-[12px] text-zinc-700">{JSON.stringify(j.params, null, 2)}</pre>
          </div>
          <div>
            <div className="mb-2 font-semibold text-zinc-900">Runs</div>
            {!j.runs.length ? <p className="text-zinc-500">No runs yet.</p> : (
              <Table><thead><tr><Th>Started</Th><Th>Status</Th><Th>Results</Th><Th>New</Th><Th>Actions</Th><Th>Finished</Th></tr></thead>
                <tbody>{j.runs.map((r) => (
                  <tr key={r.id} className="text-[12.5px]"><Td className="py-2">{fmtDateTime(r.started_at)}</Td><Td className="py-2"><StatusBadge status={r.status} />{r.error && <div className="text-[11.5px] text-red-600">{r.error}</div>}</Td>
                    <Td className="py-2">{r.results}</Td><Td className="py-2">{r.new_results}</Td><Td className="py-2">{r.actions}</Td><Td className="py-2">{fmtDateTime(r.finished_at)}</Td></tr>
                ))}</tbody></Table>
            )}
          </div>
          <div>
            <div className="mb-2 font-semibold text-zinc-900">Tasks <span className="font-normal text-zinc-400">({j.tasks.pending} pending · {j.tasks.leased} running · {j.tasks.done} done · {j.tasks.failed} failed)</span></div>
            {!tasks.data?.length ? <p className="text-zinc-500">No tasks.</p> : (
              <Table><thead><tr><Th>Target</Th><Th>Status</Th><Th>Results</Th><Th>Updated</Th></tr></thead>
                <tbody>{tasks.data.slice(0, 200).map((t) => (
                  <tr key={t.id} className="text-[12.5px]">
                    <Td className="max-w-72 truncate py-2">{t.target?.url ?? t.target?.profileUrl ?? t.target?.postUrl ?? t.kind}</Td>
                    <Td className="py-2"><StatusBadge status={t.status} />{t.error && <div className="max-w-60 truncate text-[11.5px] text-red-600" title={t.error}>{t.error}</div>}
                      {t.status === 'pending' && t.not_before && <div className="text-[11.5px] text-zinc-400">after {fmtRelative(t.not_before)}</div>}</Td>
                    <Td className="py-2">{t.results_count}</Td><Td className="py-2 text-zinc-500">{fmtRelative(t.updated_at)}</Td>
                  </tr>
                ))}</tbody></Table>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11.5px] text-zinc-400">{label}</div><div className="mt-0.5 text-zinc-800">{children}</div></div>;
}
