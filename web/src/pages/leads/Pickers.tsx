import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, cx, Field, Input, Modal, Select, Toggle, useUi } from '../../components/ui.tsx';
import { CampaignStatus } from '../../components/status.tsx';
import type { Tag } from './types.ts';

export const useTags = (enabled = true) =>
  useQuery({ queryKey: ['tags'], queryFn: () => api.get('/api/tags').then((r) => r.data as Tag[]), enabled });

/** Choose an existing tag or type a new one; resolves to a tag id. */
export function TagPickerModal({ open, onClose, title, confirmLabel, allowCreate = true, onPick }: {
  open: boolean; onClose: () => void; title: string; confirmLabel: string; allowCreate?: boolean; onPick: (tagId: number) => Promise<void>;
}) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const tags = useTags(open);
  const [selected, setSelected] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  useEffect(() => { if (open) { setSelected(null); setNewName(''); } }, [open]);

  const go = useMutation({
    mutationFn: async () => {
      let id = selected;
      if (!id && newName.trim()) {
        const r = await api.post('/api/tags', { name: newName.trim() });
        id = r.data.id as number;
        qc.invalidateQueries({ queryKey: ['tags'] });
      }
      if (!id) throw new Error('Pick a tag');
      await onPick(id);
    },
    onSuccess: onClose,
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.isPending} disabled={!selected && !newName.trim()} onClick={() => go.mutate()}>{confirmLabel}</Button></>}>
      <div className="flex max-h-60 flex-wrap gap-2 overflow-y-auto scroll-thin">
        {tags.data?.length === 0 && <p className="text-sm text-slate-500">No tags yet.</p>}
        {tags.data?.map((t) => (
          <button key={t.id} onClick={() => { setSelected(t.id); setNewName(''); }}
            className={cx('rounded-md px-2.5 py-1 text-sm ring-1 ring-inset', selected === t.id ? 'bg-brand-600 text-white ring-brand-600' : 'bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100')}>
            {t.name}
          </button>
        ))}
      </div>
      {allowCreate && (
        <Field label="Or create a new tag" className="mt-4">
          <Input value={newName} placeholder="e.g. Hot lead" onChange={(e) => { setNewName(e.target.value); setSelected(null); }} />
        </Field>
      )}
    </Modal>
  );
}

export function AddToCampaignModal({ open, onClose, leadIds, onDone }: { open: boolean; onClose: () => void; leadIds: number[]; onDone?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [campaignId, setCampaignId] = useState('');
  const [parallel, setParallel] = useState(false);
  const campaigns = useQuery({
    queryKey: ['campaigns', 'all'],
    queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as { id: number; name: string; status: string }[]),
    enabled: open,
  });
  useEffect(() => { if (open) { setCampaignId(''); setParallel(false); } }, [open]);
  const selected = campaigns.data?.find((c) => String(c.id) === campaignId);

  const go = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: leadIds, allow_parallel_sending: parallel }),
    onSuccess: (r) => {
      const n = r.data.attached as number;
      const skipped = leadIds.length - n;
      toast(`${n} lead${n === 1 ? '' : 's'} added to ${selected?.name ?? 'campaign'}${skipped ? ` · ${skipped} skipped (already in it or in another active campaign)` : ''}`);
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      qc.invalidateQueries({ queryKey: ['campaign-leads'] });
      onDone?.();
      onClose();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add to campaign" description={`${leadIds.length} lead${leadIds.length === 1 ? '' : 's'} selected`} size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.isPending} disabled={!campaignId} onClick={() => go.mutate()}>Add leads</Button></>}>
      <div className="space-y-4">
        <Field label="Campaign">
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Choose a campaign…</option>
            {campaigns.data?.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        {selected && <div className="text-sm text-slate-500">Status: <CampaignStatus status={selected.status} /></div>}
        <Toggle checked={parallel} onChange={setParallel} label="Allow parallel sending" description="Also add leads that are currently being emailed by another campaign." />
      </div>
    </Modal>
  );
}
