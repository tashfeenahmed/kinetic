import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ListPlus, Pencil, Plus, Search, Table2, Tag as TagIcon, Trash2, Upload, Users, X } from 'lucide-react';
import { useOpenInTable } from '../components/openInTable.ts';
import { api, errorMessage, withQuery, type Paginated } from '../lib/api.ts';
import { avatarColor, fmtDate, fmtNumber, fmtRelative, fullName, initials } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import {
  Badge, Button, Card, Checkbox, cx, EmptyState, Field, IconButton, Input, Loading, Menu, Modal, Pagination, Select, Table, Td, Th, useUi,
} from '../components/ui.tsx';
import { LeadStatus } from '../components/status.tsx';
import { ImportWizard } from './leads/ImportWizard.tsx';
import { LeadFormModal } from './leads/LeadFormModal.tsx';
import { LeadDrawer } from './leads/LeadDrawer.tsx';
import { AddToCampaignModal, TagPickerModal, useTags } from './leads/Pickers.tsx';
import { LEAD_STATUSES, type Lead, type LeadList } from './leads/types.ts';
import { LeadFilterBar, type StatFilters } from './leads/LeadFilters.tsx';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const useLists = () => useQuery({ queryKey: ['lead-lists'], queryFn: () => api.get('/api/lead-lists').then((r) => r.data as LeadList[]) });

function ManageListsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const lists = useLists();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ['lead-lists'] });
  const mut = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: done, onError: (e) => toast(errorMessage(e), 'error') });

  return (
    <Modal open={open} onClose={onClose} title="Lead lists" description="Group leads into lists to filter them and add them to campaigns together." footer={<Button onClick={onClose}>Done</Button>}>
      <div className="flex gap-2">
        <Input placeholder="New list name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { mut.mutate(() => api.post('/api/lead-lists', { name: name.trim() })); setName(''); } }} />
        <Button variant="primary" disabled={!name.trim()} onClick={() => { mut.mutate(() => api.post('/api/lead-lists', { name: name.trim() })); setName(''); }}>Create</Button>
      </div>
      <div className="mt-4 max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
        {lists.data?.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">No lists yet.</p>}
        {lists.data?.map((l) => (
          <div key={l.id} className="flex items-center gap-2 px-3 py-2">
            {editing?.id === l.id ? (
              <>
                <Input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { mut.mutate(() => api.put(`/api/lead-lists/${l.id}`, { name: editing.name })); setEditing(null); } }} />
                <Button size="sm" variant="primary" onClick={() => { mut.mutate(() => api.put(`/api/lead-lists/${l.id}`, { name: editing.name })); setEditing(null); }}>Save</Button>
              </>
            ) : (
              <>
                <span className="flex-1 truncate text-sm text-slate-800">{l.name}</span>
                <span className="text-xs text-slate-500">{fmtNumber(l.leads_count ?? 0)} leads</span>
                <IconButton label="Rename" onClick={() => setEditing({ id: l.id, name: l.name })}><Pencil className="size-3.5" /></IconButton>
                <IconButton label="Delete" onClick={async () => {
                  if (await confirm({ title: `Delete “${l.name}”?`, message: 'The leads stay in your workspace; only the list is removed.', confirmLabel: 'Delete list', danger: true })) {
                    mut.mutate(() => api.del(`/api/lead-lists/${l.id}`));
                  }
                }}><Trash2 className="size-3.5" /></IconButton>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function StatusModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (status: string) => void }) {
  const [status, setStatus] = useState('verified');
  return (
    <Modal open={open} onClose={onClose} title="Update status" size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { onPick(status); onClose(); }}>Update</Button></>}>
      <Field label="New status" hint={status === 'unsubscribed' ? 'Unsubscribed leads are removed from all active sequences.' : undefined}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

export function LeadsPage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [listId, setListId] = useState('');
  const [tagId, setTagId] = useState('');
  const [stat, setStat] = useState<StatFilters>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openLead, setOpenLead] = useState<number | null>(null);
  const [modal, setModal] = useState<'import' | 'add' | 'lists' | 'campaign' | 'tag-add' | 'tag-remove' | 'status' | null>(null);
  const q = useDebounced(search);

  const statKey = JSON.stringify(stat);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [q, status, listId, tagId, statKey]);

  const filters = { search: q, status, lead_list_id: listId, tag_id: tagId, ...stat };
  const leads = useQuery({
    queryKey: ['leads', { q, status, listId, tagId, stat, page }],
    queryFn: () => api.get<Paginated<Lead>>('/api/leads', { ...filters, page, per_page: 50 }),
    placeholderData: (prev) => prev,
  });
  const lists = useLists();
  const tags = useTags();

  const rows = leads.data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (v: boolean) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set());
  const toggle = (id: number, v: boolean) => setSelected((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
  const ids = [...selected];
  const statActive = Object.entries(stat).some(([k, v]) => k !== 'sort' && v !== '');
  const filtered = !!(q || status || listId || tagId || statActive);
  const total = leads.data?.meta.total ?? 0;
  const clearAll = () => { setSearch(''); setStatus(''); setListId(''); setTagId(''); setStat({}); };
  const selectAllMatching = useMutation({
    mutationFn: () => api.get('/api/leads/ids', filters).then((r) => r.data as { ids: number[]; total: number }),
    onSuccess: (d) => {
      const ids = d.ids.slice(0, 10_000);
      setSelected(new Set(ids));
      if (d.total > ids.length) toast(`Selected the first ${fmtNumber(ids.length)} of ${fmtNumber(d.total)} leads`, 'info');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const openInTable = useOpenInTable();
  const bulk = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['lead'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const deleteSelected = async () => {
    if (!(await confirm({ title: `Delete ${ids.length} lead${ids.length === 1 ? '' : 's'}?`, message: 'They will be removed from all campaigns. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    bulk.mutate(async () => { await api.del('/api/leads/bulk', { lead_ids: ids }); setSelected(new Set()); toast(`${ids.length} leads deleted`); });
  };

  return (
    <Page wide>
      <PageHeader
        title="Leads"
        subtitle="Store and segment all your contacts"
        actions={<>
          <a href={withQuery('/api/leads/export', filters)} download title="Download the leads matching these filters, with email stats"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
            <Download className="size-4" /> Export
          </a>
          <Button icon={<Table2 className="size-4" />} loading={openInTable.isPending} onClick={() => openInTable.mutate(listId ? { list_id: Number(listId) } : { all: true })} title="Open these leads as a table to enrich, research and sync back">
            {listId ? 'Open list in table' : 'Open in table'}
          </Button>
          <Button icon={<Plus className="size-4" />} onClick={() => setModal('add')}>Add lead</Button>
          <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setModal('import')}>Import CSV</Button>
        </>}
      />

      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Search by name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="lg:w-40">
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
            </Select>
            <div className="flex gap-1 lg:w-56">
              <Select value={listId} onChange={(e) => setListId(e.target.value)} className="flex-1">
                <option value="">All lists</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
              <IconButton label="Manage lists" className="h-9 w-9 border border-slate-300 bg-white" onClick={() => setModal('lists')}><ListPlus className="size-4" /></IconButton>
            </div>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="lg:w-40">
              <option value="">All tags</option>
              {tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
        </div>

        <LeadFilterBar value={stat} onChange={setStat} base={{ search, status, lead_list_id: listId, tag_id: tagId }}
          onApplyBase={(b) => { setSearch(b.search ?? ''); setStatus(b.status ?? ''); setListId(b.lead_list_id ?? ''); setTagId(b.tag_id ?? ''); }} />

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-brand-50/60 px-4 py-2.5">
            <span className="mr-2 text-sm font-medium text-slate-800">{fmtNumber(selected.size)} selected</span>
            {allSelected && total > selected.size && (
              <button onClick={() => selectAllMatching.mutate()} disabled={selectAllMatching.isPending} className="mr-2 text-[13px] font-medium text-brand-600 hover:underline disabled:opacity-50">
                Select all {fmtNumber(total)} matching
              </button>
            )}
            <Button size="sm" variant="primary" onClick={() => setModal('campaign')}>Add to campaign</Button>
            <Menu
              align="left"
              trigger={(t) => <Button size="sm" icon={<TagIcon className="size-3.5" />} onClick={t}>Tags</Button>}
              items={[{ label: 'Add tag', onClick: () => setModal('tag-add') }, { label: 'Remove tag', onClick: () => setModal('tag-remove') }]}
            />
            <Button size="sm" onClick={() => setModal('status')}>Update status</Button>
            <Button size="sm" icon={<Table2 className="size-3.5" />} loading={openInTable.isPending} onClick={() => openInTable.mutate({ lead_ids: ids })}>Open in table</Button>
            <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" icon={<Trash2 className="size-3.5" />} onClick={deleteSelected}>Delete</Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {leads.isLoading ? <Loading /> : rows.length === 0 ? (
          filtered ? (
            <EmptyState icon={<Search className="size-5" />} title="No leads match these filters" action={<Button onClick={clearAll}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={<Users className="size-5" />} title="No leads yet" description="Import a CSV from your list builder or add leads one at a time. Unlimited storage — you never need to delete old leads."
              action={<Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setModal('import')}>Import CSV</Button>} />
          )
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10"><Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} onChange={toggleAll} label="Select all" /></Th>
                  <Th>Lead</Th>
                  <Th>Company</Th>
                  <Th>Status</Th>
                  <Th>Tags</Th>
                  <Th>List</Th>
                  <Th className="text-right">Sent</Th>
                  <Th className="text-right">Opens</Th>
                  <Th className="text-right">Replies</Th>
                  <Th>Last contacted</Th>
                  <Th>Added</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} onClick={() => setOpenLead(l.id)} className={cx('cursor-pointer hover:bg-slate-50', selected.has(l.id) && 'bg-brand-50/40')}>
                    <Td><Checkbox checked={selected.has(l.id)} onChange={(v) => toggle(l.id, v)} label={`Select ${l.email}`} /></Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <div className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white', avatarColor(l.email))}>{initials(fullName(l))}</div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-slate-900">{fullName(l) !== l.email ? fullName(l) : <span className="text-slate-500">No name</span>}</div>
                          <div className="truncate text-[13px] text-slate-500">{l.email}</div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="max-w-[200px] truncate text-slate-800">{l.company || <span className="text-slate-400">—</span>}</div>
                      {l.title && <div className="max-w-[200px] truncate text-[13px] text-slate-500">{l.title}</div>}
                    </Td>
                    <Td><LeadStatus status={l.status} /></Td>
                    <Td>
                      <div className="flex max-w-[220px] flex-wrap gap-1">
                        {l.tags.slice(0, 3).map((t) => <Badge key={t.id}>{t.name}</Badge>)}
                        {l.tags.length > 3 && <Badge>+{l.tags.length - 3}</Badge>}
                      </div>
                    </Td>
                    <Td className="max-w-[160px] truncate text-[13px]">{l.lead_list?.name ?? <span className="text-slate-400">—</span>}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(l.overall_stats.emails_sent)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(l.overall_stats.opens)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(l.overall_stats.replies)}</Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-500">{l.email_stats?.last_sent_at ? fmtRelative(l.email_stats.last_sent_at) : '—'}</Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-500">{fmtDate(l.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination meta={leads.data?.meta} onPage={(p) => { setPage(p); setSelected(new Set()); }} />
          </>
        )}
      </Card>

      <ImportWizard open={modal === 'import'} onClose={() => setModal(null)} />
      <LeadFormModal open={modal === 'add'} onClose={() => setModal(null)} onSaved={(l) => setOpenLead(l.id)} />
      <ManageListsModal open={modal === 'lists'} onClose={() => setModal(null)} />
      <AddToCampaignModal open={modal === 'campaign'} onClose={() => setModal(null)} leadIds={ids} onDone={() => setSelected(new Set())} />
      <TagPickerModal open={modal === 'tag-add'} onClose={() => setModal(null)} title={`Add tag to ${ids.length} leads`} confirmLabel="Add tag"
        onPick={async (tagId) => { await api.post('/api/tags/attach-to-leads', { tag_ids: [tagId], lead_ids: ids }); qc.invalidateQueries({ queryKey: ['leads'] }); toast('Tag added'); }} />
      <TagPickerModal open={modal === 'tag-remove'} onClose={() => setModal(null)} title={`Remove tag from ${ids.length} leads`} confirmLabel="Remove tag" allowCreate={false}
        onPick={async (tagId) => { await api.post('/api/tags/remove-from-leads', { tag_ids: [tagId], lead_ids: ids }); qc.invalidateQueries({ queryKey: ['leads'] }); toast('Tag removed'); }} />
      <StatusModal open={modal === 'status'} onClose={() => setModal(null)}
        onPick={(s) => bulk.mutate(async () => { await api.patch('/api/leads/bulk-update-status', { lead_ids: ids, status: s }); toast('Status updated'); })} />
      <LeadDrawer leadId={openLead} onClose={() => setOpenLead(null)} />
    </Page>
  );
}
