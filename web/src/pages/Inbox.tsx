import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, ChevronDown, ChevronLeft, ChevronRight, CircleSlash, Inbox as InboxIcon, PenSquare, Search, Send, ArrowDownUp, X } from 'lucide-react';
import { api, errorMessage, type Paginated } from '../lib/api.ts';
import { avatarColor, fmtRelative, initials } from '../lib/format.ts';
import { Checkbox, cx, EmptyState, IconButton, Loading, useUi } from '../components/ui.tsx';
import { Resizer, usePaneWidth } from '../components/Resizer.tsx';
import { REPLY_LABELS, ReplyCategory } from '../components/status.tsx';
import { Conversation, SentDetail } from './inbox/Conversation.tsx';
import { ComposeModal } from './inbox/ComposeModal.tsx';
import { SyncButton } from './inbox/SyncButton.tsx';

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
  category: string; label?: string; sender_email: string | null; campaign_name: string | null; thread_count: number; interested: boolean;
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
  const folderPane = usePaneWidth('inbox-folders', 200, 160, 320);
  const listPane = usePaneWidth('inbox-list', 380, 280, 680);

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

  // "label:meeting_request" filters by reply label; anything else is a status.
  const labelFilter = status.startsWith('label:') ? status.slice(6) : undefined;
  const replies = useQuery({
    queryKey: ['inbox', 'replies', { folder, q, status, senderId, campaignId, page }],
    queryFn: () => api.get<Paginated<ReplyRow> & { counts: { unread_inbox: number } }>('/api/replies', { folder, search: q, status: labelFilter ? undefined : status, label: labelFilter, sender_email_id: senderId, campaign_id: campaignId, page, per_page: 25 }),
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

  const qc = useQueryClient();
  const { toast } = useUi();
  const aiStatus = useQuery({ queryKey: ['reply-ai-status'], queryFn: () => api.get('/api/replies/ai-status').then((r) => r.data as { active: boolean }) });
  const resort = useMutation({
    mutationFn: async (ids: number[]) => { const r = await api.post('/api/replies/reclassify', { reply_ids: ids }); await api.post('/api/replies/ai-queue/run'); return r.data as { queued: number; skipped_manual: number }; },
    onSuccess: (d) => {
      toast(`${d.queued} re-sorted${d.skipped_manual ? ` · ${d.skipped_manual} kept your label` : ''}`);
      setChecked(new Set());
      qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['thread'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const list = folder === 'sent' ? sent : replies;
  const meta = list.data?.meta;
  const detailOpen = !!(openReply || openSent);

  const filtered = !!(q || status || senderId || campaignId);
  const toggleChecked = (id: number, v: boolean) => setChecked((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });

  return (
    <div className="flex h-full min-h-0 bg-white">
      {/* Folders & filters */}
      <aside style={{ width: folderPane.width }} className={cx('shrink-0 flex-col overflow-y-auto px-2 py-3 scroll-thin', detailOpen ? 'hidden xl:flex' : 'hidden md:flex')}>
        <button onClick={() => setComposing(true)}
          className="mb-3 flex h-8 items-center justify-center gap-2 rounded-[7px] bg-zinc-900 px-3 text-[13px] font-medium text-white hover:bg-zinc-800">
          <PenSquare className="size-3.5" /> Compose
        </button>
        <nav className="flex flex-col gap-px">
          {FOLDERS.map((f) => {
            const Icon = f.icon;
            const active = folder === f.id;
            return (
              <button key={f.id} onClick={() => { setFolder(f.id); select(null); }}
                className={cx('flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-[13px] transition-colors', active ? 'bg-zinc-100 font-medium text-zinc-900' : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900')}>
                <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 truncate text-left">{f.label}</span>
                {f.id === 'inbox' && !!counts.data?.unread_inbox && <span className="text-[11.5px] font-semibold text-brand-600">{counts.data.unread_inbox}</span>}
              </button>
            );
          })}
        </nav>
        <div className="px-2 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-[.06em] text-zinc-400">Filters</div>
        <div className="flex flex-col gap-1.5">
          {folder !== 'sent' && (
            <FilterSelect value={status} onChange={setStatus} placeholder="Any status">
              <option value="interested">Interested</option>
              <option value="not_interested">Not interested</option>
              <option value="unread">Unread</option>
              <option value="not_automated">Not automated</option>
              <option value="automated">Automated</option>
              <option value="unsubscribe">Unsubscribe</option>
              <optgroup label="Category">
                {REPLY_LABELS.filter((l) => l.id !== 'bounce').map((l) => <option key={l.id} value={`label:${l.id}`}>{l.label}</option>)}
              </optgroup>
            </FilterSelect>
          )}
          <FilterSelect value={senderId} onChange={setSenderId} placeholder="Any mailbox">
            {senders.data?.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
          </FilterSelect>
          {folder !== 'sent' && (
            <FilterSelect value={campaignId} onChange={setCampaignId} placeholder="Any campaign">
              {campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </FilterSelect>
          )}
          {filtered && (
            <button onClick={() => { setSearch(''); setStatus(''); setSenderId(''); setCampaignId(''); }} className="flex h-7 items-center gap-1.5 px-2 text-[12.5px] text-zinc-500 hover:text-zinc-900">
              <X className="size-3.5" /> Clear filters
            </button>
          )}
        </div>
      </aside>
      <Resizer pane={folderPane} className={detailOpen ? 'hidden xl:block' : 'hidden md:block'} />

      {/* Thread list */}
      <section style={{ '--list-w': `${listPane.width}px` } as CSSProperties}
        className={cx('min-h-0 w-full flex-col lg:w-[var(--list-w)] lg:shrink-0', detailOpen ? 'hidden lg:flex' : 'flex')}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 px-3">
          {/* Folder switch for small screens */}
          <select className="h-8 rounded-md bg-transparent px-1 text-[13px] font-medium text-zinc-900 outline-none md:hidden" value={folder} onChange={(e) => { setFolder(e.target.value as Folder); select(null); }}>
            {FOLDERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={folder === 'sent' ? 'Search sent' : 'Search threads'}
              className="h-8 w-full rounded-md bg-transparent pl-7 pr-2 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 hover:bg-zinc-50 focus:bg-zinc-50" />
          </div>
          <SyncButton />
          {checked.size > 0 && <span className="shrink-0 text-[12px] text-zinc-600">{checked.size} selected</span>}
          {checked.size > 0 && aiStatus.data?.active && (
            <button onClick={() => resort.mutate([...checked])} disabled={resort.isPending} title="Classify the selected conversations again with AI (your manual labels are kept)"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50">
              <ArrowDownUp className="size-3.5" /> Re-sort
            </button>
          )}
          {meta && meta.total > 0 && <span className="shrink-0 text-[12px] tabular-nums text-zinc-400">{meta.total.toLocaleString()}</span>}
          <IconButton label="Compose" className="md:hidden" onClick={() => setComposing(true)}><PenSquare className="size-4" /></IconButton>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {list.isLoading ? <Loading /> : !list.data?.data.length ? (
            <EmptyState icon={<InboxIcon className="size-5" />} title={EMPTY[folder][0]} description={filtered ? 'Nothing matches these filters.' : EMPTY[folder][1]} />
          ) : folder === 'sent' ? (
            (sent.data?.data ?? []).map((s) => {
              const active = s.latest_reply_id ? openReply === s.latest_reply_id : openSent === s.id;
              return (
                <button key={s.id} onClick={() => (s.latest_reply_id ? select('reply', s.latest_reply_id) : select('sent', s.id))}
                  className={cx(rowClass(active), 'w-full text-left')}>
                  <Avatar seed={s.to_email} name={s.to_email} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-900"><span className="font-normal text-zinc-400">To </span>{s.to_email}</span>
                      <span className="shrink-0 text-[11.5px] text-zinc-400">{fmtRelative(s.sent_at)}</span>
                    </div>
                    <div className="truncate text-[13px] text-zinc-700">{s.subject}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-400">{s.preview}</span>
                      <Tag>{s.campaign_name ?? (s.kind === 'reply' ? 'Reply' : 'Manual')}</Tag>
                    </div>
                  </div>
                </button>
              );
            })
          ) : (
            (replies.data?.data ?? []).map((r) => {
              const active = openReply === r.id;
              const name = r.from_name || r.from_email;
              const providerTag = r.campaign_name ?? (r.sender_email ? r.sender_email.split('@')[1] : null);
              const isChecked = checked.has(r.id);
              return (
                <div key={r.id} onClick={() => select('reply', r.id)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') select('reply', r.id); }}
                  className={cx(rowClass(active), 'group cursor-pointer')}>
                  {/* Avatar turns into a checkbox on hover, or while anything is selected */}
                  <div className="relative mt-0.5 size-7 shrink-0">
                    <div className={cx('transition-opacity', checked.size > 0 ? 'opacity-0' : 'group-hover:opacity-0')}><Avatar seed={r.from_email} name={name} /></div>
                    <div className={cx('absolute inset-0 flex items-center justify-center transition-opacity', checked.size > 0 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                      <Checkbox checked={isChecked} label={`Select ${name}`} onChange={(v) => toggleChecked(r.id, v)} />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      {!r.read && <span className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-brand-600" aria-label="Unread" />}
                      <span className={cx('min-w-0 flex-1 truncate text-[13px] text-zinc-900', !r.read ? 'font-semibold' : 'font-medium')}>
                        {name}
                        {r.thread_count > 1 && <span className="ml-1 text-[11.5px] font-normal text-zinc-400">{r.thread_count}</span>}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-zinc-400">{fmtRelative(r.received_at)}</span>
                    </div>
                    <div className={cx('truncate text-[13px]', !r.read ? 'text-zinc-900' : 'text-zinc-700')}>{r.subject || '(no subject)'}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-400">{r.preview}</span>
                      {(r.label ?? r.category) !== 'reply' && <ReplyCategory status={r.label ?? r.category} />}
                      {providerTag && <Tag>{providerTag}</Tag>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {meta && meta.last_page > 1 && (
          <div className="flex h-10 shrink-0 items-center justify-between border-t border-slate-200 px-3 text-[12px] text-zinc-500">
            <span className="tabular-nums">Page {meta.current_page} of {meta.last_page}</span>
            <div className="flex gap-1">
              <IconButton label="Previous page" className="disabled:pointer-events-none disabled:opacity-30" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" /></IconButton>
              <IconButton label="Next page" className="disabled:pointer-events-none disabled:opacity-30" disabled={page >= meta.last_page} onClick={() => setPage((p) => p + 1)}><ChevronRight className="size-4" /></IconButton>
            </div>
          </div>
        )}
      </section>
      <Resizer pane={listPane} className="hidden lg:block" />

      {/* Conversation */}
      <section className={cx('min-h-0 min-w-0 flex-1 flex-col', detailOpen ? 'flex' : 'hidden lg:flex')}>
        {openReply ? (
          <Conversation key={openReply} replyId={openReply} onBack={() => select(null)} onDeleted={() => select(null)} />
        ) : openSent ? (
          <SentDetail key={openSent} sentId={openSent} onBack={() => select(null)} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon={<InboxIcon className="size-5" />} title="Select a conversation" description="Pick a thread on the left to read it and reply." />
          </div>
        )}
      </section>

      <ComposeModal open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}

const rowClass = (active: boolean) => cx(
  'relative flex items-start gap-3 border-b border-zinc-100 px-4 py-2.5 transition-colors',
  active ? 'bg-zinc-100/80 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-brand-600' : 'hover:bg-zinc-50',
);

function Avatar({ seed, name }: { seed: string; name: string }) {
  return <div className={cx('flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white', avatarColor(seed))}>{initials(name)}</div>;
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="max-w-[45%] shrink-0 truncate rounded bg-zinc-100 px-1.5 py-px text-[11px] text-zinc-500">{children}</span>;
}

function FilterSelect({ value, onChange, placeholder, children }: { value: string; onChange: (v: string) => void; placeholder: string; children: ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={cx('h-8 w-full appearance-none truncate rounded-[7px] bg-transparent pl-2 pr-7 text-[13px] outline-none hover:bg-zinc-50 focus:bg-zinc-50', value ? 'font-medium text-zinc-900' : 'text-zinc-500')}>
        <option value="">{placeholder}</option>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
    </div>
  );
}
