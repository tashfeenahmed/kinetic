import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Archive, Copy, FileText, MoreHorizontal, Pause, Play, Plus, Search, Trash2 } from 'lucide-react';
import { api, errorMessage, type Paginated } from '../lib/api.ts';
import { fmtDate, fmtNumber, fmtPct } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Button, Card, EmptyState, Field, IconButton, Input, Loading, Menu, Modal, Pagination, ProgressBar, Table, Td, Th, cx, useUi } from '../components/ui.tsx';
import { CampaignStatus } from '../components/status.tsx';
import type { Campaign } from './campaign/types.ts';

const STATUSES = [
  { id: '', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
];

export function NewCampaignModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'outbound' | 'reply_followup'>('outbound');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useUi();
  const create = useMutation({
    mutationFn: () => api.post('/api/campaigns', { name: name.trim(), type }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      onClose();
      setName('');
      navigate(`/campaigns/${r.data.id}/sequence`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      description="Give it a name — you'll write the sequence, pick mailboxes and add leads next."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create campaign</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Campaign name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="[SaaS outreach] Companies with 100+ employees" onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate()} />
        </Field>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Type</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              ['outbound', 'Outbound', 'Cold sequence to a list of leads.'],
              ['reply_followup', 'Reply follow-up', 'Continue conversations pushed from the Master Inbox, in the same thread.'],
            ] as const).map(([id, label, desc]) => (
              <button
                key={id}
                type="button"
                onClick={() => setType(id)}
                className={cx('rounded-lg border p-3 text-left transition-colors', type === id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}
              >
                <div className="text-sm font-medium text-slate-900">{label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Shared lifecycle actions for the list and the detail page. */
export function useCampaignActions() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const refresh = (id?: number) => {
    qc.invalidateQueries({ queryKey: ['campaigns'] });
    if (id) qc.invalidateQueries({ queryKey: ['campaign', id] });
  };
  const run = async (fn: () => Promise<unknown>, ok: string, id?: number) => {
    try {
      await fn();
      toast(ok);
      refresh(id);
      return true;
    } catch (e: any) {
      const problems: string[] = e?.problems ?? [];
      toast(problems.length > 1 ? `${e.message} (+${problems.length - 1} more)` : errorMessage(e), 'error');
      return false;
    }
  };
  return {
    pause: (c: Campaign) => run(() => api.patch(`/api/campaigns/${c.id}/pause`), 'Campaign paused', c.id),
    resume: (c: Campaign) => run(() => api.patch(`/api/campaigns/${c.id}/resume`), c.status === 'draft' ? 'Campaign launched' : 'Campaign resumed', c.id),
    launch: (c: Campaign) => run(() => api.post(`/api/campaigns/${c.id}/launch`), 'Campaign launched — sending starts in the next window', c.id),
    duplicate: async (c: Campaign) => {
      try {
        const r = await api.post(`/api/campaigns/${c.id}/duplicate`);
        toast('Campaign duplicated');
        refresh();
        return r.data as Campaign;
      } catch (e) {
        toast(errorMessage(e), 'error');
        return null;
      }
    },
    archive: async (c: Campaign) => {
      if (!(await confirm({ title: 'Archive campaign?', message: 'Scheduled emails are cancelled. You can still view its stats.', confirmLabel: 'Archive' }))) return false;
      return run(() => api.patch(`/api/campaigns/${c.id}/archive`), 'Campaign archived', c.id);
    },
    remove: async (c: Campaign) => {
      if (!(await confirm({ title: `Delete "${c.name}"?`, message: 'This permanently deletes the campaign, its sequence and its stats. Leads stay in your workspace.', confirmLabel: 'Delete campaign', danger: true }))) return false;
      return run(() => api.del(`/api/campaigns/${c.id}`), 'Campaign deleted');
    },
  };
}

export function CampaignsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const actions = useCampaignActions();
  const navigate = useNavigate();

  const list = useQuery({
    queryKey: ['campaigns', { search, status, page }],
    queryFn: () => api.get<Paginated<Campaign>>('/api/campaigns', { search, status, page, per_page: 25 }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const rows = list.data?.data ?? [];
  const filtered = !!search || !!status;

  return (
    <Page wide>
      <PageHeader
        title="Campaigns"
        subtitle="Multi-step email sequences sent from your mailboxes"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button>}
      />

      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Search campaigns" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <div className="flex h-9 items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
            {STATUSES.map((s) => (
              <button
                key={s.id}
                onClick={() => { setStatus(s.id); setPage(1); }}
                className={cx('h-7 whitespace-nowrap rounded-md px-3 text-sm font-medium', status === s.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {list.isLoading ? <Loading /> : rows.length === 0 ? (
          filtered ? (
            <EmptyState icon={<Search className="size-5" />} title="No campaigns match" description="Try a different search or status." />
          ) : (
            <EmptyState
              icon={<FileText className="size-5" />}
              title="Create your first campaign"
              description={<>1. Write a sequence &nbsp;·&nbsp; 2. Attach sender emails &nbsp;·&nbsp; 3. Add leads &nbsp;·&nbsp; 4. Launch. Emails go out inside your schedule, within each mailbox's daily limit.</>}
              action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button>}
            />
          )
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th className="min-w-40">Progress</Th>
                  <Th className="text-right">Sent</Th>
                  <Th className="text-right">Replies</Th>
                  <Th className="text-right">Interested</Th>
                  <Th className="text-right">Bounced</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/campaigns/${c.id}/leads`)}>
                    <Td>
                      <Link to={`/campaigns/${c.id}/leads`} onClick={(e) => e.stopPropagation()} className="font-medium text-slate-900 hover:text-brand-600">{c.name}</Link>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {c.type === 'reply_followup' ? 'Reply follow-up · ' : ''}{c.sequence_steps_count} {c.sequence_steps_count === 1 ? 'step' : 'steps'} · {c.sender_emails_count} {c.sender_emails_count === 1 ? 'mailbox' : 'mailboxes'}
                      </div>
                    </Td>
                    <Td><CampaignStatus status={c.status} /></Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <ProgressBar value={c.stats.progress_percentage} tone={c.status === 'completed' ? 'green' : 'blue'} />
                        <span className="w-10 shrink-0 text-right text-xs text-slate-500">{Math.round(c.stats.progress_percentage)}%</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{fmtNumber(c.stats.total_leads)} leads</div>
                    </Td>
                    <Td className="text-right tabular-nums">{fmtNumber(c.stats.emails_sent)}</Td>
                    <Td className="text-right tabular-nums">
                      {fmtNumber(c.stats.unique_replies_per_contact)}
                      {c.stats.unique_replies_per_contact > 0 && <span className="ml-1.5 text-xs text-slate-400">{fmtPct(c.stats.unique_replies_per_contact_percentage)}</span>}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtNumber(c.stats.interested)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {fmtNumber(c.stats.bounced)}
                      {c.stats.bounced > 0 && <span className={cx('ml-1.5 text-xs', c.stats.bounced_percentage > 3 ? 'text-red-600' : 'text-slate-400')}>{fmtPct(c.stats.bounced_percentage)}</span>}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-500">{fmtDate(c.created_at)}</Td>
                    <Td className="text-right">
                      <div onClick={(e) => e.stopPropagation()}>
                        <Menu
                          trigger={(toggle) => <IconButton label="Campaign actions" onClick={toggle}><MoreHorizontal className="size-4" /></IconButton>}
                          items={[
                            c.status === 'active'
                              ? { label: 'Pause', icon: <Pause className="size-4" />, onClick: () => actions.pause(c) }
                              : { label: c.status === 'draft' ? 'Launch' : 'Resume', icon: <Play className="size-4" />, onClick: () => (c.status === 'draft' ? actions.launch(c) : actions.resume(c)) },
                            { label: 'Duplicate', icon: <Copy className="size-4" />, onClick: async () => { const d = await actions.duplicate(c); if (d) navigate(`/campaigns/${d.id}/sequence`); } },
                            { label: 'Archive', icon: <Archive className="size-4" />, onClick: () => actions.archive(c), disabled: c.status === 'archived' },
                            'divider',
                            { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: () => actions.remove(c) },
                          ]}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination sticky meta={list.data?.meta} onPage={setPage} />
          </>
        )}
      </Card>

      <NewCampaignModal open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

