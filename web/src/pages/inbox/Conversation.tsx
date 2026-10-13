import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ChevronDown, Forward, Mail, MailOpen, MoreHorizontal, Reply, ReplyAll, Send, Star, PenLine, ThumbsDown, Trash2, UserX, Workflow,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { avatarColor, fmtDateTime, fullName, initials } from '../../lib/format.ts';
import { Badge, Button, cx, Field, IconButton, Input, Loading, Menu, Modal, Select, Shimmer, useUi } from '../../components/ui.tsx';
import { CampaignStatus, LeadStatus, REPLY_LABELS, ReplyCategory } from '../../components/status.tsx';
import { AttachmentList, AttachmentPicker, EmailBody, MarkdownEditor, parseEmails, useAttachments, type AttachmentItem } from './shared.tsx';

interface Message {
  id: number;
  direction: 'sent' | 'received';
  at: string;
  from_name?: string;
  from_email?: string;
  to_email?: string;
  cc?: string;
  subject: string;
  body_text?: string;
  body_html?: string;
  attachments?: AttachmentItem[];
  category?: string;
  label?: string;
  kind?: string;
  opens?: number;
}

interface Thread {
  reply: any;
  messages: Message[];
  lead: { id: number; email: string; first_name: string; last_name: string; company: string; title: string; status: string } | null;
  campaign: { id: number; name: string; status: string } | null;
  sender_email: { id: number; name: string; email: string } | null;
}

function MessageCard({ m }: { m: Message }) {
  const mine = m.direction === 'sent';
  const name = m.from_name || m.from_email || 'Unknown';
  return (
    <article className="border-b border-slate-100 px-5 py-4 last:border-b-0">
      <header className="mb-3 flex items-start gap-3">
        <div className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold text-white', avatarColor(m.from_email ?? name))}>{initials(name)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-medium text-slate-900">{name}</span>
            {mine && <Badge tone="blue" className="px-1.5 py-0 text-[11px]">You</Badge>}
            {m.kind === 'campaign' && <Badge className="px-1.5 py-0 text-[11px]">Campaign</Badge>}
            {(m.label ?? m.category) && (m.label ?? m.category) !== 'reply' && <ReplyCategory status={(m.label ?? m.category)!} />}
          </div>
          <div className="truncate text-xs text-slate-500">
            {m.from_email && <>{m.from_email} · </>}to {m.to_email}{m.cc ? `, cc ${m.cc}` : ''}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11.5px] text-slate-400">
          {fmtDateTime(m.at)}
          {mine && !!m.opens && <div className="mt-0.5 inline-flex items-center gap-1"><MailOpen className="size-3" />{m.opens}</div>}
        </div>
      </header>
      <div className="pl-11"><EmailBody text={m.body_text} html={m.body_html} /></div>
      <AttachmentList items={m.attachments} hideInline={!!m.body_html?.trim()} className="mt-3 pl-11" />
    </article>
  );
}

function Composer({ thread, replyId, onSent }: { thread: Thread; replyId: number; onSent: () => void }) {
  const { toast } = useUi();
  const [body, setBody] = useState('');
  const [replyAll, setReplyAll] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState('');
  const att = useAttachments();
  const templates = useQuery({ queryKey: ['reply-templates'], queryFn: () => api.get('/api/reply-templates').then((r) => r.data as { id: number; name: string; body: string }[]) });
  const aiStatus = useQuery({ queryKey: ['reply-ai-status'], queryFn: () => api.get('/api/replies/ai-status').then((r) => r.data as { configured: boolean }) });
  // Whatever is already typed is passed along as instructions ("say we're booked until May").
  const draft = useMutation({
    mutationFn: () => api.post(`/api/replies/${replyId}/draft-reply`, { instructions: body.trim() || undefined }).then((r) => r.data as { draft: string; knowledge_used: boolean }),
    onSuccess: (d) => setBody(d.draft),
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  useEffect(() => { setBody(''); setCc(''); setShowCc(false); setReplyAll(false); att.clear(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [replyId]);

  const send = useMutation({
    mutationFn: () => api.post(`/api/replies/${replyId}/reply`, { message: body, reply_all: replyAll, cc_emails: parseEmails(cc), attachments: att.payload() }),
    onSuccess: () => { toast('Reply sent'); setBody(''); setCc(''); att.clear(); onSent(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const to = thread.reply.from_email;
  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
          <button onClick={() => setReplyAll(false)} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-1', !replyAll ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}><Reply className="size-3.5" /> Reply</button>
          <button onClick={() => setReplyAll(true)} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-1', replyAll ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}><ReplyAll className="size-3.5" /> Reply all</button>
        </div>
        <span className="truncate">to <span className="text-slate-700">{to}</span>{thread.sender_email && <> from <span className="text-slate-700">{thread.sender_email.email}</span></>}</span>
        <div className="flex-1" />
        {aiStatus.data?.configured && (
          <button onClick={() => draft.mutate()} disabled={draft.isPending} title={body.trim() ? 'Draft a reply with AI, using what you typed as instructions' : 'Draft a reply with AI from the thread, lead, campaign and knowledge'}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50">
            {draft.isPending ? <Shimmer>Drafting…</Shimmer> : <><PenLine className="size-3.5" /> Draft with AI</>}
          </button>
        )}
        {!showCc && <button className="text-brand-600 hover:underline" onClick={() => setShowCc(true)}>Add Cc</button>}
        {!!templates.data?.length && (
          <Select className="w-44" value="" onChange={(e) => { const t = templates.data!.find((x) => String(x.id) === e.target.value); if (t) setBody((b) => (b ? `${b}\n\n${t.body}` : t.body)); }}>
            <option value="">Insert template…</option>
            {templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
      </div>
      {showCc && <Input className="mb-2" placeholder="Cc: name@company.com" value={cc} onChange={(e) => setCc(e.target.value)} />}
      <MarkdownEditor rows={3} className="resize-none border-slate-200 shadow-none" placeholder={`Reply to ${thread.reply.from_name || to}…`} value={body} onChange={setBody}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) send.mutate(); }} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AttachmentPicker att={att} className="flex-1" />
        <span className="hidden text-xs text-slate-400 sm:inline">⌘↵ to send</span>
        <Button variant="primary" icon={<Send className="size-4" />} loading={send.isPending} disabled={!body.trim() || att.totalSize > 15 * 1024 * 1024} onClick={() => send.mutate()}>Send</Button>
      </div>
    </div>
  );
}

function ForwardModal({ open, onClose, replyId }: { open: boolean; onClose: () => void; replyId: number }) {
  const { toast } = useUi();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (open) { setTo(''); setNote(''); } }, [open]);
  const go = useMutation({
    mutationFn: () => api.post(`/api/replies/${replyId}/forward`, { to_emails: parseEmails(to), message: note.trim() || 'FYI' }),
    onSuccess: () => { toast('Forwarded'); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Forward conversation" size="md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.isPending} disabled={!parseEmails(to).length} onClick={() => go.mutate()}>Forward</Button></>}>
      <div className="space-y-3">
        <Field label="To"><Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="teammate@company.com" /></Field>
        <Field label="Note" hint="Attachments on the original email are forwarded too."><MarkdownEditor rows={4} value={note} onChange={setNote} placeholder="Add a note (optional)" /></Field>
      </div>
    </Modal>
  );
}

function PushModal({ open, onClose, replyId }: { open: boolean; onClose: () => void; replyId: number }) {
  const { toast } = useUi();
  const qc = useQueryClient();
  const [campaignId, setCampaignId] = useState('');
  const campaigns = useQuery({ queryKey: ['campaigns', 'all'], queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as { id: number; name: string; type: string; status: string }[]), enabled: open });
  const followups = campaigns.data?.filter((c) => c.type === 'reply_followup') ?? [];
  useEffect(() => { if (open) setCampaignId(''); }, [open]);
  const go = useMutation({
    mutationFn: () => api.post(`/api/replies/${replyId}/followup-campaign/push`, { campaign_id: Number(campaignId) }),
    onSuccess: () => { toast('Lead added to follow-up campaign'); qc.invalidateQueries({ queryKey: ['thread'] }); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Push to follow-up campaign" description="The campaign continues this conversation as a reply in the same thread, from the same mailbox." size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={go.isPending} disabled={!campaignId} onClick={() => go.mutate()}>Add to campaign</Button></>}>
      {campaigns.isLoading ? <Loading /> : followups.length === 0 ? (
        <p className="text-sm text-slate-600">You don’t have a reply follow-up campaign yet. Create a campaign with the type <b>Reply follow-up</b> first.</p>
      ) : (
        <Field label="Campaign">
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Choose…</option>
            {followups.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}

export function Conversation({ replyId, onBack, onDeleted }: { replyId: number; onBack: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [modal, setModal] = useState<'forward' | 'push' | null>(null);
  const thread = useQuery({
    queryKey: ['thread', replyId],
    queryFn: () => api.get(`/api/replies/${replyId}/conversation-thread`).then((r) => r.data as Thread),
  });

  // Opening a conversation marks it read on the server; refresh the counters.
  useEffect(() => {
    if (thread.data) { qc.invalidateQueries({ queryKey: ['unread-count'] }); qc.invalidateQueries({ queryKey: ['inbox'] }); }
  }, [thread.data?.reply.id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { qc.invalidateQueries({ queryKey: ['thread', replyId] }); qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['unread-count'] }); };
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'error') });

  if (thread.isLoading) return <Loading />;
  if (thread.isError || !thread.data) return <div className="p-8 text-sm text-slate-500">This conversation could not be loaded.</div>;
  const t = thread.data;
  const r = t.reply;
  const interested = !!r.interested;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-start gap-2">
          <IconButton label="Back" className="lg:hidden" onClick={onBack}><ArrowLeft className="size-4" /></IconButton>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-slate-900">{r.subject || '(no subject)'}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <LabelPicker reply={r} onPick={(label) => act.mutate(() => api.patch(`/api/replies/${r.id}/label`, { label }))} />
              {r.folder !== 'inbox' && <Badge tone={r.folder === 'spam' ? 'orange' : 'red'}>{r.folder === 'spam' ? 'Spam' : 'Bounced'}</Badge>}
              {(r.ai_status === 'pending' || r.ai_status === 'refresh') && <span className="text-[11.5px] text-slate-400">Sorting with AI…</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant={interested ? 'success' : 'secondary'} icon={<Star className={cx('size-3.5', interested && 'fill-current')} />}
              onClick={() => act.mutate(() => api.patch(`/api/replies/${r.id}/${interested ? 'mark-as-not-interested' : 'mark-as-interested'}`))}>
              {interested ? 'Interested' : 'Mark interested'}
            </Button>
            <Menu
              trigger={(o) => <Button size="sm" onClick={o} aria-label="More"><MoreHorizontal className="size-4" /></Button>}
              items={[
                { label: 'Not interested', icon: <ThumbsDown className="size-4" />, onClick: () => act.mutate(() => api.patch(`/api/replies/${r.id}/mark-as-not-interested`)) },
                { label: r.read ? 'Mark as unread' : 'Mark as read', icon: <Mail className="size-4" />, onClick: () => act.mutate(() => api.patch(`/api/replies/${r.id}/mark-as-read-or-unread`, { read: !r.read })) },
                { label: r.automated ? 'Not automated' : 'Mark as automated', icon: <Mail className="size-4" />, onClick: () => act.mutate(() => api.patch(`/api/replies/${r.id}/mark-as-automated-or-not-automated`, { automated: !r.automated })) },
                { label: 'Forward', icon: <Forward className="size-4" />, onClick: () => setModal('forward') },
                { label: 'Push to follow-up campaign', icon: <Workflow className="size-4" />, onClick: () => setModal('push') },
                'divider',
                { label: 'Unsubscribe contact', icon: <UserX className="size-4" />, onClick: async () => {
                  if (await confirm({ title: 'Unsubscribe this contact?', message: `${r.from_email} will be stopped in every campaign and never emailed again.`, confirmLabel: 'Unsubscribe', danger: true })) {
                    act.mutate(() => api.patch(`/api/replies/${r.id}/unsubscribe`));
                  }
                } },
                { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: async () => {
                  if (await confirm({ title: 'Delete this message?', message: 'It is removed from Kinetic only, not from the mailbox.', confirmLabel: 'Delete', danger: true })) {
                    await api.del(`/api/replies/${r.id}`).then(() => { refresh(); onDeleted(); }).catch((e) => toast(errorMessage(e), 'error'));
                  }
                } },
              ]}
            />
          </div>
        </div>
        <AiSummary reply={r} />
        {(t.lead || t.campaign) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]">
            {t.lead && (
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium text-slate-800">{fullName(t.lead)}</span>
                <span className="truncate text-slate-500">{[t.lead.title, t.lead.company].filter(Boolean).join(' · ')}</span>
                <LeadStatus status={t.lead.status} />
              </div>
            )}
            {t.campaign && (
              <Link to={`/campaigns/${t.campaign.id}`} className="flex items-center gap-2 text-slate-600 hover:text-brand-600">
                Campaign: <span className="font-medium text-slate-800">{t.campaign.name}</span> <CampaignStatus status={t.campaign.status} />
              </Link>
            )}
          </div>
        )}
      </header>
      <div className="flex-1 overflow-y-auto scroll-thin">
        {t.messages.map((m) => <MessageCard key={`${m.direction}-${m.id}`} m={m} />)}
      </div>
      {r.folder !== 'bounced' && <Composer thread={t} replyId={r.id} onSent={refresh} />}
      <ForwardModal open={modal === 'forward'} onClose={() => setModal(null)} replyId={r.id} />
      <PushModal open={modal === 'push'} onClose={() => setModal(null)} replyId={r.id} />
    </div>
  );
}

/** The reply's label as a badge that opens a re-label menu. A label you pick is never changed by the AI. */
function LabelPicker({ reply, onPick }: { reply: any; onPick: (label: string) => void }) {
  const current = reply.label ?? reply.category;
  return (
    <Menu
      align="left"
      trigger={(o) => (
        <button onClick={o} title={reply.label_source === 'manual' ? 'Label set by you' : 'Change label'} className="group inline-flex items-center gap-0.5 rounded-md">
          <ReplyCategory status={current} />
          <ChevronDown className="size-3 text-slate-400 group-hover:text-slate-700" />
        </button>
      )}
      items={REPLY_LABELS.filter((l) => l.id !== 'bounce').map((l) => ({
        label: <span className={cx(l.id === current && 'font-medium text-slate-900')}>{l.label}</span>,
        onClick: () => { if (l.id !== current) onPick(l.id); },
      }))}
    />
  );
}

const OBJECTION: Record<string, string> = { price: 'price', timing: 'timing', competitor: 'competitor', no_need: 'no need', authority: 'authority', other: 'other' };

/** One-line AI read of the reply: summary, suggested next action and confidence. */
function AiSummary({ reply: r }: { reply: any }) {
  if (!r.ai_summary && !r.ai_next_action) return null;
  const d = r.ai_details ?? {};
  const extra = [
    d.objection_type && `Objection: ${OBJECTION[d.objection_type] ?? d.objection_type}`,
    d.referral && `Refers to ${[d.referral.name, d.referral.email].filter(Boolean).join(' · ')}`,
    d.return_date && `Back ${d.return_date}`,
  ].filter(Boolean);
  return (
    <div className="mt-2 flex items-start gap-2 text-[12.5px] leading-snug">
      <span className="mt-px inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-50 px-1 py-px text-[10.5px] font-semibold text-violet-700" title={r.ai_model ?? 'AI'}>
        AI
      </span>
      <div className="min-w-0 flex-1">
        {r.ai_summary && <span className="text-slate-700">{r.ai_summary}</span>}
        {r.ai_next_action && <span className="text-slate-500"> → {r.ai_next_action}</span>}
        {extra.length > 0 && <span className="text-slate-400"> · {extra.join(' · ')}</span>}
      </div>
      {r.ai_confidence != null && <span className="shrink-0 text-[11px] tabular-nums text-slate-400" title="Model confidence">{Math.round(r.ai_confidence * 100)}%</span>}
    </div>
  );
}

/** Read-only view of an email we sent that has no replies yet. */
export function SentDetail({ sentId, onBack }: { sentId: number; onBack: () => void }) {
  const q = useQuery({ queryKey: ['sent-email', sentId], queryFn: () => api.get(`/api/sent-emails/${sentId}`).then((r) => r.data) });
  if (q.isLoading) return <Loading />;
  const s = q.data;
  if (!s) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <IconButton label="Back" className="lg:hidden" onClick={onBack}><ArrowLeft className="size-4" /></IconButton>
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-slate-900">{s.subject}</h2>
          <p className="mt-0.5 text-[13px] text-slate-500">No replies yet{s.kind === 'campaign' ? ' · sent by a campaign' : ''}</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto scroll-thin">
        <MessageCard m={{ id: s.id, direction: 'sent', at: s.sent_at, from_name: s.sender_name, from_email: s.sender_email, to_email: s.to_email, cc: s.cc, subject: s.subject, body_text: s.body_text, body_html: s.body_html, kind: s.kind, opens: s.opens }} />
      </div>
    </div>
  );
}
