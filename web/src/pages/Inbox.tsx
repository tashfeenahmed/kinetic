import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, CircleSlash, Inbox as InboxIcon, PenSquare, Search, Send } from 'lucide-react';
import { api, type Paginated } from '../lib/api.ts';
import { avatarColor, fmtRelative, initials } from '../lib/format.ts';
import { Badge, Button, Checkbox, cx, EmptyState, Input, Loading, Select } from '../components/ui.tsx';
import { ReplyCategory } from '../components/status.tsx';
import { Conversation, SentDetail } from './inbox/Conversation.tsx';
import { ComposeModal } from './inbox/ComposeModal.tsx';

type Folder = 'inbox' | 'sent' | 'spam' | 'bounced';

const FOLDERS: { id: Folder; label: string; icon: typeof InboxIcon }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'spam', label: 'Spam', icon: AlertOctagon },
  { id: 'bounced', label: 'Bounces', icon: CircleSlash },
];

const EMPTY: Record<Folder, [string, string]> = {
  inbox: ['No replies yet', 'Replies to your campaigns and any other mail in your connected mailboxes show up here.'],
  sent: ['Nothing sent yet', 'Emails you send from the inbox and from campaigns appear here.'],
  spam: ['Spam is empty', 'Messages that land in your mailboxes’ spam folders show up here so nothing is missed.'],
  bounced: ['No bounces', 'Delivery failures are collected here and the leads are stopped automatically.'],
};

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

interface ReplyRow {
  id: number; from_name: string; from_email: string; subject: string; preview: string; received_at: string; read: boolean;
  category: string; sender_email: string | null; campaign_name: string | null; thread_count: number; interested: boolean;
}
interface SentRow {
  id: number; to_email: string; subject: string; preview: string; sent_at: string; campaign_name: string | null; sender_email: string | null; kind: string; latest_reply_id: number | null; opens: number;
}

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [folder, setFolder] = useState<Folder>('inbox');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [senderId, setSenderId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const q = useDebounced(search);

  const replyParam = params.get('reply');
  const sentParam = params.get('sent');
  const openReply = replyParam ? Number(replyParam) : null;
  const openSent = sentParam ? Number(sentParam) : null;
  const select = (kind: 'reply' | 'sent' | null, id?: number) => {
    const next = new URLSearchParams(params);
    next.delete('reply'); next.delete('sent');
    if (kind && id) next.set(kind, String(id));
    setParams(next, { replace: false });
  };

  useEffect(() => { setPage(1); setChecked(new Set()); }, [folder, q, status, senderId, campaignId]);

  const senders = useQuery({ queryKey: ['sender-emails'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as { id: number; email: string }[]) });
  const campaigns = useQuery({ queryKey: ['campaigns', 'all'], queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as { id: number; name: string }[]) });

  const replies = useQuery({
    queryKey: ['inbox', 'replies', { folder, q, status, senderId, campaignId, page }],
    queryFn: () => api.get<Paginated<ReplyRow> & { counts: { unread_inbox: number } }>('/api/replies', { folder, search: q, status, sender_email_id: senderId, campaign_id: campaignId, page, per_page: 25 }),
    enabled: folder !== 'sent',
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const sent = useQuery({
    queryKey: ['inbox', 'sent', { q, senderId, page }],
    queryFn: () => api.get<Paginated<SentRow>>('/api/sent-emails', { kind: 'all', search: q, sender_email_id: senderId, page, per_page: 25 }),
    enabled: folder === 'sent',
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const counts = useQuery({
    queryKey: ['inbox', 'counts'],
    queryFn: () => api.get('/api/replies', { folder: 'inbox', per_page: 1 }).then((r) => r.counts as { unread_inbox: number; unread_interested: number }),
    refetchInterval: 30_000,
  });

  const list = folder === 'sent' ? sent : replies;
  const meta = list.data?.meta;
  const detailOpen = !!(openReply || openSent);

  return (
    <div className="flex h-full min-h-0 bg-white">
      {/* Folders & filters */}
      <aside className={cx('w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r border-slate-200 px-4 py-5 scroll-thin', detailOpen ? 'hidden xl:flex' : 'hidden md:flex')}>
        <Button variant="primary" className="mb-2 w-full" icon={<PenSquare className="size-4" />} onClick={() => setComposing(true)}>Compose</Button>
        {FOLDERS.map((f) => {
          const Icon = f.icon;
          const active = folder === f.id;
          return (
            <button key={f.id} onClick={() => { setFolder(f.id); select(null); }}
              className={cx('flex items-center gap-3 rounded-xl border px-4 py-2.5 text-[15px] transition-colors', active ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
              <Icon className="size-[18px]" strokeWidth={1.75} />
              <span className="flex-1 text-left">{f.label}</span>
              {f.id === 'inbox' && !!counts.data?.unread_inbox && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">{counts.data.unread_inbox}</span>}
            </button>
          );
        })}
        <div className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">Filters</div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {folder !== 'sent' && (
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Message status</option>
            <option value="interested">Interested</option>
            <option value="not_interested">Not interested</option>
            <option value="unread">Unread</option>
            <option value="not_automated">Not automated</option>
            <option value="automated">Automated</option>
            <option value="unsubscribe">Unsubscribe</option>
          </Select>
        )}
        <Select value={senderId} onChange={(e) => setSenderId(e.target.value)}>
          <option value="">Sender email</option>
          {senders.data?.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
        </Select>
        {folder !== 'sent' && (
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Campaign</option>
            {campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </aside>

      {/* Thread list */}
      <section className={cx('min-h-0 w-full flex-col border-r border-slate-200 lg:w-[400px] lg:shrink-0 2xl:w-[460px]', detailOpen ? 'hidden lg:flex' : 'flex')}>
        <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-5">
          {/* Folder switch for small screens */}
          <Select className="w-36 md:hidden" value={folder} onChange={(e) => { setFolder(e.target.value as Folder); select(null); }}>
            {FOLDERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
          <span className="hidden text-sm text-slate-500 md:inline">{folder === 'sent' ? 'Sent emails' : 'Unified threads'}</span>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            {checked.size > 0 && <span className="text-slate-700">{checked.size} selected</span>}
            <span>Page {meta?.current_page ?? 1}</span>
            <Button size="sm" className="md:hidden" variant="primary" onClick={() => setComposing(true)} aria-label="Compose"><PenSquare className="size-4" /></Button>
          </div>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4 scroll-thin">
          {list.isLoading ? <Loading /> : !list.data?.data.length ? (
            <EmptyState icon={<InboxIcon className="size-5" />} title={EMPTY[folder][0]} description={q || status || senderId || campaignId ? 'Nothing matches these filters.' : EMPTY[folder][1]} />
          ) : folder === 'sent' ? (
            (sent.data?.data ?? []).map((s) => {
              const active = s.latest_reply_id ? openReply === s.latest_reply_id : openSent === s.id;
              return (
                <button key={s.id} onClick={() => (s.latest_reply_id ? select('reply', s.latest_reply_id) : select('sent', s.id))}
                  className={cx('flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors', active ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200 hover:bg-slate-50')}>
                  <div className={cx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white', avatarColor(s.to_email))}>{initials(s.to_email)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-slate-900">To: {s.to_email}</span>
                      {s.campaign_name ? <Badge className="max-w-[120px] truncate">{s.campaign_name}</Badge> : <Badge tone="blue">{s.kind === 'reply' ? 'Reply' : 'Manual'}</Badge>}
                    </div>
                    <div className="truncate text-sm text-slate-700">{s.subject}</div>
                    <div className="truncate text-[13px] text-slate-500">{s.preview}</div>
                  </div>
                  <div className="shrink-0 text-xs text-slate-500">{fmtRelative(s.sent_at)}</div>
                </button>
              );
            })
          ) : (
            (replies.data?.data ?? []).map((r) => {
              const active = openReply === r.id;
              const name = r.from_name || r.from_email;
              const providerTag = r.campaign_name ?? (r.sender_email ? r.sender_email.split('@')[1] : null);
              return (
                <div key={r.id} onClick={() => select('reply', r.id)} role="button"
                  className={cx('flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors', active ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200 hover:bg-slate-50')}>
                  <Checkbox checked={checked.has(r.id)} label={`Select ${name}`}
                    onChange={(v) => setChecked((s) => { const n = new Set(s); if (v) n.add(r.id); else n.delete(r.id); return n; })} />
                  <div className={cx('flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white', avatarColor(r.from_email))}>{initials(name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {!r.read && <span className="size-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />}
                      <span className={cx('min-w-0 flex-1 truncate text-slate-900', !r.read ? 'font-semibold' : 'font-medium')}>
                        {name}
                        {r.thread_count > 1 && <span className="ml-1.5 text-xs font-normal text-slate-400">{r.thread_count}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">{fmtRelative(r.received_at)}</span>
                    </div>
                    {(r.category !== 'reply' || providerTag) && (
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        {r.category !== 'reply' && <ReplyCategory status={r.category} />}
                        {providerTag && <Badge className="min-w-0 truncate">{providerTag}</Badge>}
                      </div>
                    )}
                    <div className={cx('mt-1 truncate text-sm', !r.read ? 'text-slate-800' : 'text-slate-600')}>{r.subject || '(no subject)'} <span className="text-slate-400">— {r.preview}</span></div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {meta && meta.last_page > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-[13px] text-slate-600">
            <span>{meta.total.toLocaleString()} total</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button size="sm" disabled={page >= meta.last_page} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </section>

      {/* Conversation */}
      <section className={cx('min-h-0 min-w-0 flex-1 flex-col', detailOpen ? 'flex' : 'hidden lg:flex')}>
        {openReply ? (
          <Conversation key={openReply} replyId={openReply} onBack={() => select(null)} onDeleted={() => select(null)} />
        ) : openSent ? (
          <SentDetail key={openSent} sentId={openSent} onBack={() => select(null)} />
        ) : (
          <div className="flex h-full items-center justify-center bg-slate-50/60">
            <EmptyState icon={<InboxIcon className="size-5" />} title="Select a conversation" description="Pick a thread on the left to read it and reply." />
          </div>
        )}
      </section>

      <ComposeModal open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}
