import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Plus, Search, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtNumber } from '../../lib/format.ts';
import { Badge, Button, Card, Checkbox, EmptyState, Input, Loading, Modal, Select, Table, Td, Th, useUi } from '../../components/ui.tsx';
import { SenderStatus, providerLabel } from '../../components/status.tsx';
import type { Campaign } from './types.ts';

interface AttachedSender { id: number; name: string; email: string; status: string; daily_limit: number; provider: string; warmup_enabled: number; sent_in_campaign: number }
interface Sender { id: number; name: string; email: string; status: string; daily_limit: number; provider: string; tags: { id: number; name: string }[] }

function AddSendersModal({ campaign, attached, onClose }: { campaign: Campaign; attached: Set<number>; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const senders = useQuery({ queryKey: ['sender-emails', 'all'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as Sender[]) });
  const tags = useMemo(() => {
    const m = new Map<number, string>();
    senders.data?.forEach((s) => s.tags.forEach((t) => m.set(t.id, t.name)));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [senders.data]);
  const rows = (senders.data ?? []).filter((s) => !attached.has(s.id))
    .filter((s) => !search || `${s.email} ${s.name}`.toLowerCase().includes(search.toLowerCase()))
    .filter((s) => !tag || s.tags.some((t) => String(t.id) === tag));
  const all = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const capacity = (senders.data ?? []).filter((s) => picked.has(s.id)).reduce((n, s) => n + s.daily_limit, 0);

  const add = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${campaign.id}/attach-sender-emails`, { sender_email_ids: [...picked] }),
    onSuccess: (r) => {
      toast(`${r.data.attached} mailbox${r.data.attached === 1 ? '' : 'es'} added`);
      qc.invalidateQueries({ queryKey: ['campaign', campaign.id] });
      onClose();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <Modal open onClose={onClose} title="Add sender emails" description="Leads are spread across these mailboxes; each lead keeps the same mailbox for the whole sequence." size="lg"
      footer={<>
        {picked.size > 0 && <span className="mr-auto self-center text-sm text-slate-500">+{fmtNumber(capacity)} emails/day capacity</span>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!picked.size} loading={add.isPending} onClick={() => add.mutate()}>Add {picked.size || ''} mailbox{picked.size === 1 ? '' : 'es'}</Button>
      </>}>
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_200px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search mailboxes" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
        {senders.isLoading ? <Loading /> : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            {senders.data?.length ? 'No more mailboxes to add.' : <>No mailboxes yet. <Link to="/sender-emails" className="text-brand-600 hover:underline">Connect one</Link>.</>}
          </div>
        ) : (
          <>
            <label className="sticky top-0 flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
              <Checkbox checked={all} onChange={(v) => setPicked((p) => { const n = new Set(p); rows.forEach((r) => (v ? n.add(r.id) : n.delete(r.id))); return n; })} /> Select all {rows.length}
            </label>
            {rows.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-0 hover:bg-slate-50">
                <Checkbox checked={picked.has(s.id)} onChange={(v) => setPicked((p) => { const n = new Set(p); v ? n.add(s.id) : n.delete(s.id); return n; })} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{s.email}</div>
                  <div className="truncate text-xs text-slate-500">{s.name} · {providerLabel(s.provider)} · {s.daily_limit}/day</div>
                </div>
                {s.status !== 'Connected' && <SenderStatus status={s.status} />}
              </label>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

export function SendersTab({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['campaign', campaign.id, 'senders'], queryFn: () => api.get(`/api/campaigns/${campaign.id}/sender-emails`).then((r) => r.data as AttachedSender[]) });
  const remove = async (s: AttachedSender) => {
    if (!(await confirm({ title: `Remove ${s.email}?`, message: 'Leads assigned to this mailbox move to another one at their next step.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.del(`/api/campaigns/${campaign.id}/remove-sender-emails`, { sender_email_ids: [s.id] });
      toast('Mailbox removed');
      qc.invalidateQueries({ queryKey: ['campaign', campaign.id] });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  if (q.isLoading) return <Loading />;
  const rows = q.data ?? [];
  const capacity = rows.filter((r) => r.status === 'Connected').reduce((n, r) => n + r.daily_limit, 0);

  return (
    <Card
      title={`${rows.length} sender email${rows.length === 1 ? '' : 's'}`}
      description={rows.length ? `Up to ${fmtNumber(Math.min(capacity, campaign.max_emails_per_day))} emails/day from this campaign (mailbox limits ${fmtNumber(capacity)}, campaign limit ${fmtNumber(campaign.max_emails_per_day)}).` : undefined}
      actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add sender emails</Button>}
      padded={false}
    >
      {rows.length === 0 ? (
        <EmptyState icon={<AtSign className="size-5" />} title="No mailboxes attached" description="Attach the mailboxes this campaign should send from. More mailboxes = more volume at safe per-mailbox limits."
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add sender emails</Button>} />
      ) : (
        <Table>
          <thead>
            <tr><Th>Email</Th><Th>Status</Th><Th>Provider</Th><Th className="text-right">Daily limit</Th><Th className="text-right">Sent in campaign</Th><Th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50/60">
                <Td>
                  <div className="font-medium text-slate-900">{s.email}</div>
                  <div className="text-xs text-slate-500">{s.name}{s.warmup_enabled ? ' · warming up' : ''}</div>
                </Td>
                <Td><SenderStatus status={s.status} /></Td>
                <Td><Badge>{providerLabel(s.provider)}</Badge></Td>
                <Td className="text-right tabular-nums">{fmtNumber(s.daily_limit)}</Td>
                <Td className="text-right tabular-nums">{fmtNumber(s.sent_in_campaign)}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => remove(s)}>Remove</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {adding && <AddSendersModal campaign={campaign} attached={new Set(rows.map((r) => r.id))} onClose={() => setAdding(false)} />}
    </Card>
  );
}
