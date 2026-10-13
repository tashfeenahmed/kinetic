import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Kanban, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtNumber, fmtRelative, fullName } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Badge, EmptyState, IconButton, Input, Loading, Select, cx, useUi, type Tone } from '../components/ui.tsx';

/**
 * Deals: replies open them (interested → meeting); the rest is moved here by hand.
 * One column per stage; drag a card or use its stage menu.
 */

export const DEAL_STAGES = [
  { id: 'interested', label: 'Interested', tone: 'yellow' },
  { id: 'meeting', label: 'Meeting booked', tone: 'blue' },
  { id: 'proposal', label: 'Proposal sent', tone: 'purple' },
  { id: 'won', label: 'Won', tone: 'green' },
  { id: 'lost', label: 'Lost', tone: 'gray' },
] as const satisfies readonly { id: string; label: string; tone: Tone }[];

export interface Deal {
  id: number;
  stage: string;
  value: number | null;
  currency: string | null;
  lost_reason: string | null;
  lead: { id: number; email: string; first_name?: string; last_name?: string; company?: string; title?: string };
  campaign_id: number | null;
  campaign_name: string | null;
  stage_changed_at: string;
}

const money = (v: number | null, cur: string | null) => (v == null ? '' : `${cur ? `${cur} ` : ''}${fmtNumber(v)}`);

function useDealUpdate() {
  const qc = useQueryClient();
  const { toast } = useUi();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Partial<Deal>) => api.patch(`/api/deals/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deals'] }); qc.invalidateQueries({ queryKey: ['ws-stats'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
}

export function PipelinePage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const deals = useQuery({ queryKey: ['deals'], queryFn: () => api.get('/api/deals').then((r) => r.data as Deal[]) });
  const update = useDealUpdate();
  const [over, setOver] = useState<string | null>(null);
  const remove = async (d: Deal) => {
    if (!(await confirm({ title: 'Delete this deal?', message: `The deal with ${d.lead.company || fullName(d.lead)} is removed. The lead and its replies stay.`, confirmLabel: 'Delete', danger: true }))) return;
    await api.del(`/api/deals/${d.id}`).then(() => qc.invalidateQueries({ queryKey: ['deals'] })).catch((e) => toast(errorMessage(e), 'error'));
  };

  const all = deals.data ?? [];
  const wonValue = all.filter((d) => d.stage === 'won').reduce((n, d) => n + (d.value ?? 0), 0);
  return (
    <Page wide>
      <PageHeader title="Pipeline" subtitle="Deals start when a lead replies with interest or asks for a meeting. Move them along as they progress." />
      {deals.isLoading ? <Loading /> : !all.length ? (
        <EmptyState icon={<Kanban className="size-5" />} title="No deals yet" description="When a lead says they're interested or asks for a meeting, a deal appears here. You can also open one from a conversation in the Master Inbox." />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500">{all.filter((d) => d.stage !== 'won' && d.stage !== 'lost').length} open · {all.filter((d) => d.stage === 'won').length} won{wonValue ? ` (${fmtNumber(wonValue)})` : ''}</p>
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
            {DEAL_STAGES.map((s) => {
              const items = all.filter((d) => d.stage === s.id);
              const total = items.reduce((n, d) => n + (d.value ?? 0), 0);
              return (
                <section key={s.id}
                  onDragOver={(e) => { e.preventDefault(); setOver(s.id); }} onDragLeave={() => setOver(null)}
                  onDrop={(e) => { e.preventDefault(); setOver(null); const id = Number(e.dataTransfer.getData('text/deal')); const d = all.find((x) => x.id === id); if (d && d.stage !== s.id) update.mutate({ id, stage: s.id }); }}
                  className={cx('flex min-h-40 flex-col rounded-xl border bg-slate-50/60 p-2', over === s.id ? 'border-brand-400 bg-brand-50/40' : 'border-slate-200')}>
                  <header className="mb-2 flex items-center justify-between px-1.5 pt-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-slate-800"><Badge tone={s.tone} dot>{s.label}</Badge><span className="text-slate-400">{items.length}</span></span>
                    {total > 0 && <span className="text-xs text-slate-500">{fmtNumber(total)}</span>}
                  </header>
                  <div className="flex flex-col gap-2">
                    {items.map((d) => <DealCard key={d.id} deal={d} onRemove={() => remove(d)} />)}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </Page>
  );
}

function DealCard({ deal: d, onRemove }: { deal: Deal; onRemove: () => void }) {
  const update = useDealUpdate();
  const save = (field: 'value' | 'currency' | 'lost_reason', raw: string) => {
    const v = field === 'value' ? (raw.trim() === '' ? null : Number(raw)) : raw.trim() || null;
    if (field === 'value' && v !== null && Number.isNaN(v)) return;
    if (v !== (d[field] ?? null)) update.mutate({ id: d.id, [field]: v });
  };
  return (
    <article draggable onDragStart={(e) => e.dataTransfer.setData('text/deal', String(d.id))}
      className="cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-sm active:cursor-grabbing">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-slate-900">{d.lead.company || fullName(d.lead)}</div>
          <div className="truncate text-xs text-slate-500">{d.lead.company ? fullName(d.lead) : d.lead.title || ''}</div>
        </div>
        <IconButton label="Delete deal" onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>
      </div>
      {d.campaign_name && <Link to={`/campaigns/${d.campaign_id}`} className="mt-1 block truncate text-xs text-slate-500 hover:text-brand-600">{d.campaign_name}</Link>}
      <div className="mt-2 flex gap-1.5">
        <Input key={`v${d.value}`} type="number" min={0} placeholder="Value" defaultValue={d.value ?? ''} onBlur={(e) => save('value', e.target.value)} className="h-8 min-w-0 flex-1 text-[13px]" aria-label="Deal value" />
        <Input key={`c${d.currency}`} placeholder="EUR" defaultValue={d.currency ?? ''} onBlur={(e) => save('currency', e.target.value)} className="h-8 w-16 text-[13px]" aria-label="Currency" />
      </div>
      {d.stage === 'lost' && (
        <Input key={`l${d.lost_reason}`} placeholder="Why was it lost?" defaultValue={d.lost_reason ?? ''} onBlur={(e) => save('lost_reason', e.target.value)} className="mt-1.5 h-8 text-[13px]" aria-label="Lost reason" />
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <Select value={d.stage} onChange={(e) => update.mutate({ id: d.id, stage: e.target.value })} className="h-8 w-auto text-[12.5px]" aria-label="Stage">
          {DEAL_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
        <span className="shrink-0 text-[11.5px] text-slate-400" title="Last stage change">{fmtRelative(d.stage_changed_at)}</span>
      </div>
    </article>
  );
}

/** Small stage picker for a lead (used in the inbox conversation header). */
export function DealPicker({ leadId }: { leadId: number }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const deal = useQuery({ queryKey: ['deals', 'lead', leadId], queryFn: () => api.get('/api/deals', { lead_id: leadId }).then((r) => (r.data as Deal[])[0] ?? null) });
  const set = useMutation({
    mutationFn: (stage: string) => (deal.data ? api.patch(`/api/deals/${deal.data.id}`, { stage }) : api.post('/api/deals', { lead_id: leadId, stage })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deals'] }); qc.invalidateQueries({ queryKey: ['ws-stats'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (deal.isLoading) return null;
  const d = deal.data;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-slate-500">Deal:</span>
      <Select value={d?.stage ?? ''} onChange={(e) => e.target.value && set.mutate(e.target.value)} className="h-7 w-auto py-0 text-[12.5px]" aria-label="Deal stage">
        {!d && <option value="">No deal</option>}
        {DEAL_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </Select>
      {d?.value != null && <span className="text-slate-600">{money(d.value, d.currency)}</span>}
    </span>
  );
}
