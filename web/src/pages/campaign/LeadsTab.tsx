import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ArrowRightLeft, Clock, Pause, Play, Plus, Search, Send, Table2, Trash2, Users, Ban } from 'lucide-react';
import { useOpenInTable } from '../../components/openInTable.ts';
import { api, errorMessage, type Paginated } from '../../lib/api.ts';
import { fmtDateTime, fmtNumber, fullName } from '../../lib/format.ts';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Loading, Menu, Modal, Pagination, Select, Table, Td, Th, cx, useUi } from '../../components/ui.tsx';
import { CampaignLeadStatus } from '../../components/status.tsx';
import type { Campaign } from './types.ts';
import { AddLeadsModal } from './AddLeadsModal.tsx';

interface CampaignLeadRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
  lead_status: string;
  campaign_lead_id: number;
  status: string;
  current_step: number;
  last_sent_at: string | null;
  next_due_at: string | null;
  sender_email: string | null;
  emails_sent: number;
  opens: number;
  replies: number;
  next_scheduled_at: string | null;
  tags: { id: number; name: string }[];
}

const LEAD_FILTERS = [
  ['', 'All statuses'], ['pending', 'Not started'], ['in_sequence', 'In sequence'], ['completed', 'Completed'], ['replied', 'Replied'],
  ['interested', 'Interested'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced'], ['stopped', 'Stopped'],
] as const;

const STOPPED = new Set(['stopped', 'paused', 'unsubscribed', 'bounced', 'replied', 'interested']);

/** One small round icon per sequence step, like the campaign view in EmailBison. */
function StepDots({ row, steps }: { row: CampaignLeadRow; steps: number }) {
  if (!steps) return <span className="text-xs text-slate-400">No steps</span>;
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: steps }, (_, i) => {
        const order = i + 1;
        const sent = order <= row.current_step;
        const halted = !sent && STOPPED.has(row.status);
        const next = !sent && !halted && order === row.current_step + 1 && row.next_scheduled_at;
        const title = sent ? `Step ${order}: sent` : halted ? `Step ${order}: won't send (${row.status.replace('_', ' ')})` : next ? `Step ${order}: scheduled ${fmtDateTime(row.next_scheduled_at)}` : `Step ${order}: upcoming`;
        return (
          <span
            key={order}
            title={title}
            className={cx(
              'flex size-7 items-center justify-center rounded-md ring-1 ring-inset',
              sent ? 'bg-emerald-50 text-emerald-600 ring-emerald-200' : halted ? 'bg-amber-50 text-amber-600 ring-amber-200' : next ? 'bg-blue-50 text-brand-600 ring-blue-200' : 'bg-slate-50 text-slate-400 ring-slate-200',
            )}
          >
            {sent ? <Send className="size-3.5" /> : halted ? <Pause className="size-3.5" /> : <Clock className="size-3.5" />}
          </span>
        );
      })}
    </div>
  );
}

function MoveModal({ campaign, leadIds, onClose, onDone }: { campaign: Campaign; leadIds: number[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState('');
  const [includeBad, setIncludeBad] = useState(false);
  const { toast } = useUi();
  const campaigns = useQuery({
    queryKey: ['campaigns', 'all-for-move'],
    queryFn: () => api.get<Paginated<Campaign>>('/api/campaigns', { per_page: 200 }).then((r) => r.data.filter((c) => c.id !== campaign.id)),
  });
  const move = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${campaign.id}/leads/move-to-another-campaign`, { target_campaign_id: Number(target), lead_ids: leadIds, include_bounced_and_unsubscribed: includeBad }),
    onSuccess: (r) => { toast(`Moved ${r.data.moved} lead${r.data.moved === 1 ? '' : 's'}`); onDone(); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open onClose={onClose} title={`Move ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`} description="They are removed from this campaign and start the other campaign's sequence from step 1." size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!target} loading={move.isPending} onClick={() => move.mutate()}>Move leads</Button></>}>
      <div className="space-y-4">
        <Field label="Target campaign">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a campaign…</option>
            {campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox checked={includeBad} onChange={setIncludeBad} /> Include bounced and unsubscribed leads
        </label>
      </div>
    </Modal>
  );
}

export function LeadsTab({ campaign }: { campaign: Campaign }) {
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<number[] | null>(null);
  const qc = useQueryClient();
  const { toast, confirm } = useUi();

  const list = useQuery({
    queryKey: ['campaign', campaign.id, 'leads', { search, status, page }],
    queryFn: () => api.get<Paginated<CampaignLeadRow>>(`/api/campaigns/${campaign.id}/leads`, { search, status, page, per_page: 25 }),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const steps = campaign.sequence_steps_count;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['campaign', campaign.id] });
    qc.invalidateQueries({ queryKey: ['campaigns'] });
    setSelected(new Set());
  };

  const act = async (kind: 'stop' | 'resume' | 'remove', ids: number[]) => {
    if (kind === 'remove' && !(await confirm({ title: `Remove ${ids.length} lead${ids.length === 1 ? '' : 's'} from this campaign?`, message: 'Their progress in this campaign is deleted. The leads stay in your workspace.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      if (kind === 'stop') await api.post(`/api/campaigns/${campaign.id}/leads/stop-future-emails`, { lead_ids: ids });
      if (kind === 'resume') await api.post(`/api/campaigns/${campaign.id}/leads/resume`, { lead_ids: ids });
      if (kind === 'remove') await api.del(`/api/campaigns/${campaign.id}/leads`, { lead_ids: ids });
      toast(kind === 'stop' ? 'Future emails stopped' : kind === 'resume' ? 'Leads resumed' : 'Leads removed');
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (v: boolean) => setSelected((s) => {
    const n = new Set(s);
    rows.forEach((r) => (v ? n.add(r.id) : n.delete(r.id)));
    return n;
  });
  const openInTable = useOpenInTable();
  const ids = useMemo(() => [...selected], [selected]);
  const filtered = !!search || !!status;

  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="flex items-center justify-between gap-3 px-6 py-5">
          <span className="text-[15px] font-medium text-slate-900">Filters and Search</span>
          <div className="flex gap-2">
            <Button onClick={() => setShowFilters((v) => !v)}>Toggle Filters</Button>
            <Button icon={<Table2 className="size-4" />} loading={openInTable.isPending} onClick={() => openInTable.mutate({ campaign_id: campaign.id })} title="Open this campaign's leads as a table — enrich, research, watch outreach status">Open in table</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add leads</Button>
          </div>
        </div>
        {showFilters && (
          <div className="grid gap-3 border-t border-slate-100 px-6 py-4 sm:grid-cols-[1fr_220px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" placeholder="Search name, email or company" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            </div>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              {LEAD_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm">
          <span className="font-medium text-brand-700">{selected.size} selected</span>
          <div className="flex-1" />
          <Button size="sm" icon={<Ban className="size-3.5" />} onClick={() => act('stop', ids)}>Stop future emails</Button>
          <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => act('resume', ids)}>Resume</Button>
          <Button size="sm" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => setMoving(ids)}>Move</Button>
          <Button size="sm" icon={<Table2 className="size-3.5" />} onClick={() => openInTable.mutate({ lead_ids: ids, name: `${campaign.name} · ${ids.length} leads` })}>Open in table</Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => act('remove', ids)}>Remove</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div>
        {list.isLoading ? <Loading /> : rows.length === 0 ? (
          <Card>
            {filtered ? (
              <EmptyState icon={<Search className="size-5" />} title="No leads match these filters" />
            ) : (
              <EmptyState icon={<Users className="size-5" />} title="No leads in this campaign yet" description="Add existing leads, a lead list, or import a CSV. Each lead goes through the sequence one step at a time."
                action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add leads</Button>} />
            )}
          </Card>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10 pl-0"><Checkbox checked={allOnPage} indeterminate={!allOnPage && rows.some((r) => selected.has(r.id))} onChange={toggleAll} label="Select all" /></Th>
                  <Th>Lead</Th>
                  <Th>Status</Th>
                  <Th>Tags</Th>
                  <Th>Scheduled Emails</Th>
                  <Th>Sent</Th>
                  <Th>Opens</Th>
                  <Th>Replies</Th>
                  <Th>Manage</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.campaign_lead_id} className={selected.has(r.id) ? 'bg-brand-50/40' : 'hover:bg-slate-50/60'}>
                    <Td className="pl-0"><Checkbox checked={selected.has(r.id)} onChange={(v) => setSelected((s) => { const n = new Set(s); v ? n.add(r.id) : n.delete(r.id); return n; })} label={`Select ${r.email}`} /></Td>
                    <Td>
                      <div className="font-medium text-slate-900">{fullName(r) === r.email ? r.email.split('@')[0] : fullName(r)}</div>
                      <div className="text-[13px] text-slate-500">{r.email}</div>
                    </Td>
                    <Td><CampaignLeadStatus status={r.status} /></Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {r.tags.length ? r.tags.map((t) => <Badge key={t.id}>{t.name}</Badge>) : <span className="text-slate-300">—</span>}
                      </div>
                    </Td>
                    <Td><StepDots row={r} steps={steps} /></Td>
                    <Td className="tabular-nums">{fmtNumber(r.emails_sent)}</Td>
                    <Td className="tabular-nums">{fmtNumber(r.opens)}</Td>
                    <Td className="tabular-nums">{fmtNumber(r.replies)}</Td>
                    <Td>
                      <Menu
                        trigger={(toggle) => <Button size="sm" onClick={toggle}>Manage</Button>}
                        items={[
                          { label: 'Stop future emails', icon: <Ban className="size-4" />, onClick: () => act('stop', [r.id]), disabled: !['pending', 'in_sequence'].includes(r.status) },
                          { label: 'Resume sequence', icon: <Play className="size-4" />, onClick: () => act('resume', [r.id]), disabled: !['stopped', 'paused', 'replied'].includes(r.status) },
                          { label: 'Move to another campaign', icon: <ArrowRightLeft className="size-4" />, onClick: () => setMoving([r.id]) },
                          'divider',
                          { label: 'Remove from campaign', icon: <Trash2 className="size-4" />, danger: true, onClick: () => act('remove', [r.id]) },
                        ]}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination meta={list.data?.meta} onPage={setPage} />
          </>
        )}
      </div>

      {adding && <AddLeadsModal campaign={campaign} onClose={() => setAdding(false)} onDone={refresh} />}
      {moving && <MoveModal campaign={campaign} leadIds={moving} onClose={() => setMoving(null)} onDone={refresh} />}
    </div>
  );
}
