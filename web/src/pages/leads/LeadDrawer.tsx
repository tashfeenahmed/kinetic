import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Mail, MailOpen, MessageSquare, MoreHorizontal, Pencil, Plus, Send, Trash2, UserX, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { avatarColor, fmtDateTime, fmtNumber, fullName, initials } from '../../lib/format.ts';
import { Badge, Button, cx, Drawer, EmptyState, Loading, Menu, useUi } from '../../components/ui.tsx';
import { CampaignLeadStatus, CampaignStatus, LeadStatus, ReplyCategory } from '../../components/status.tsx';
import { LeadFormModal } from './LeadFormModal.tsx';
import { AddToCampaignModal, TagPickerModal } from './Pickers.tsx';
import type { Lead } from './types.ts';

interface TimelineItem { kind: 'sent' | 'reply'; at: string; subject: string; campaign?: string | null; opens?: number; category?: string; preview?: string; id: number }

export function LeadDrawer({ leadId, onClose }: { leadId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [editing, setEditing] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [adding, setAdding] = useState(false);
  const open = leadId !== null;

  const lead = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.get(`/api/leads/${leadId}`).then((r) => r.data as Lead), enabled: open });
  const sent = useQuery({ queryKey: ['lead', leadId, 'sent'], queryFn: () => api.get(`/api/leads/${leadId}/sent-emails`).then((r) => r.data as any[]), enabled: open });
  const replies = useQuery({ queryKey: ['lead', leadId, 'replies'], queryFn: () => api.get(`/api/leads/${leadId}/replies`).then((r) => r.data as any[]), enabled: open });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['lead', leadId] }); qc.invalidateQueries({ queryKey: ['leads'] }); };
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const l = lead.data;
  const timeline: TimelineItem[] = [
    ...(sent.data ?? []).map((s) => ({ kind: 'sent' as const, at: s.sent_at, subject: s.subject, campaign: s.campaign_name, opens: s.opens, id: s.id, preview: (s.body_text ?? '').slice(0, 140) })),
    ...(replies.data ?? []).map((r) => ({ kind: 'reply' as const, at: r.received_at, subject: r.subject, category: r.category, id: r.id, preview: (r.body_text ?? '').replace(/\s+/g, ' ').slice(0, 140) })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const removeTag = (tagId: number) => action.mutate(() => api.post('/api/tags/remove-from-leads', { tag_ids: [tagId], lead_ids: [leadId] }));

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={l ? fullName(l) : 'Lead'}
        subtitle={l?.email}
        actions={l && (
          <>
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>Edit</Button>
            <Menu
              trigger={(t) => <Button size="sm" onClick={t} aria-label="More actions"><MoreHorizontal className="size-4" /></Button>}
              items={[
                { label: 'Add to campaign', icon: <Send className="size-4" />, onClick: () => setAdding(true) },
                'divider',
                { label: 'Unsubscribe', icon: <UserX className="size-4" />, disabled: l.status === 'unsubscribed', onClick: async () => {
                  if (await confirm({ title: 'Unsubscribe lead?', message: `${l.email} will be removed from all active sequences and never emailed again.`, confirmLabel: 'Unsubscribe', danger: true })) {
                    action.mutate(() => api.patch(`/api/leads/${l.id}/unsubscribe`));
                    toast('Lead unsubscribed');
                  }
                } },
                { label: 'Add to blacklist', icon: <Ban className="size-4" />, onClick: async () => {
                  if (await confirm({ title: 'Blacklist this email?', message: `${l.email} will be blocked from every campaign in this workspace.`, confirmLabel: 'Blacklist', danger: true })) {
                    action.mutate(() => api.post(`/api/leads/${l.id}/blacklist`));
                    toast('Added to blacklist');
                  }
                } },
                { label: 'Delete lead', icon: <Trash2 className="size-4" />, danger: true, onClick: async () => {
                  if (await confirm({ title: 'Delete lead?', message: 'This removes the lead and its campaign progress. Sent history stays in campaign stats.', confirmLabel: 'Delete', danger: true })) {
                    await api.del(`/api/leads/${l.id}`).catch((e) => toast(errorMessage(e), 'error'));
                    qc.invalidateQueries({ queryKey: ['leads'] });
                    toast('Lead deleted');
                    onClose();
                  }
                } },
              ]}
            />
          </>
        )}
      >
        {!l ? <Loading /> : (
          <div className="space-y-7">
            <div className="flex items-center gap-4">
              <div className={cx('flex size-12 items-center justify-center rounded-full text-base font-semibold text-white', avatarColor(l.email))}>{initials(fullName(l))}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><LeadStatus status={l.status} />{l.lead_list && <Badge>{l.lead_list.name}</Badge>}</div>
                <div className="mt-1 text-sm text-slate-500">{[l.title, l.company].filter(Boolean).join(' at ') || 'No company details'}</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {[['Emails sent', l.overall_stats.emails_sent], ['Opens', l.overall_stats.opens], ['Replies', l.overall_stats.replies]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-slate-200 px-3 py-2"><div className="text-lg font-semibold">{fmtNumber(v as number)}</div><div className="text-xs text-slate-500">{k}</div></div>
              ))}
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Details</h3>
              <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
                {[['First name', l.first_name], ['Last name', l.last_name], ['Company', l.company], ['Title', l.title], ['Added', fmtDateTime(l.created_at)]].map(([k, v]) => (
                  <div key={k} className="contents"><dt className="text-slate-500">{k}</dt><dd className="text-slate-800">{v || <span className="text-slate-400">—</span>}</dd></div>
                ))}
                {l.custom_variables.map((v) => (
                  <div key={v.name} className="contents"><dt className="truncate text-slate-500" title={v.name}>{v.name}</dt><dd className="break-words text-slate-800">{v.value || <span className="text-slate-400">—</span>}</dd></div>
                ))}
              </dl>
              {l.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{l.notes}</p>}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Tags</h3>
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setTagging(true)}>Add tag</Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {l.tags.length === 0 && <span className="text-sm text-slate-400">No tags</span>}
                {l.tags.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                    {t.name}
                    <button onClick={() => removeTag(t.id)} className="rounded p-0.5 hover:bg-slate-200" aria-label={`Remove ${t.name}`}><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Campaigns</h3>
              {!l.campaigns?.length ? <p className="text-sm text-slate-400">Not in any campaign yet.</p> : (
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {l.campaigns.map((c) => (
                    <Link key={c.id} to={`/campaigns/${c.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{c.name}</div>
                        <div className="text-xs text-slate-500">Step {c.current_step} sent{c.next_due_at ? ` · next ${fmtDateTime(c.next_due_at)}` : ''}</div>
                      </div>
                      <div className="flex shrink-0 gap-1.5"><CampaignLeadStatus status={c.status} /><CampaignStatus status={c.campaign_status} /></div>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold text-slate-900">Activity</h3>
              {timeline.length === 0 ? <EmptyState icon={<Mail className="size-5" />} title="No emails yet" description="Sent emails and replies will show up here." /> : (
                <ol className="relative space-y-4 border-l border-slate-200 pl-5">
                  {timeline.map((t) => (
                    <li key={`${t.kind}-${t.id}`} className="relative">
                      <span className={cx('absolute -left-[29px] top-0.5 flex size-[18px] items-center justify-center rounded-full ring-4 ring-white', t.kind === 'sent' ? 'bg-brand-100 text-brand-600' : 'bg-emerald-100 text-emerald-600')}>
                        {t.kind === 'sent' ? <Send className="size-2.5" /> : <MessageSquare className="size-2.5" />}
                      </span>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-medium text-slate-700">{t.kind === 'sent' ? 'Email sent' : 'Reply received'}</span>
                        <span>{fmtDateTime(t.at)}</span>
                        {t.campaign && <Badge>{t.campaign}</Badge>}
                        {t.category && <ReplyCategory status={t.category} />}
                        {!!t.opens && <span className="inline-flex items-center gap-1"><MailOpen className="size-3" /> {t.opens}</span>}
                      </div>
                      {t.kind === 'reply' ? (
                        <Link to={`/inbox?reply=${t.id}`} className="mt-0.5 block truncate text-sm font-medium text-slate-800 hover:text-brand-600">{t.subject || '(no subject)'}</Link>
                      ) : <div className="mt-0.5 truncate text-sm font-medium text-slate-800">{t.subject || '(no subject)'}</div>}
                      {t.preview && <div className="truncate text-[13px] text-slate-500">{t.preview}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </Drawer>
      <LeadFormModal open={editing} onClose={() => setEditing(false)} lead={l} />
      <TagPickerModal open={tagging} onClose={() => setTagging(false)} title="Add tag" confirmLabel="Add tag"
        onPick={async (tagId) => { await api.post('/api/tags/attach-to-leads', { tag_ids: [tagId], lead_ids: [leadId] }); refresh(); }} />
      <AddToCampaignModal open={adding} onClose={() => setAdding(false)} leadIds={leadId ? [leadId] : []} />
    </>
  );
}
