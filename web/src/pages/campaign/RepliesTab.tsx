import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { api, type Paginated } from '../../lib/api.ts';
import { avatarColor, fmtRelative, initials } from '../../lib/format.ts';
import { Card, EmptyState, Loading, Pagination, cx } from '../../components/ui.tsx';
import { ReplyCategory } from '../../components/status.tsx';
import type { Campaign } from './types.ts';

interface Reply {
  id: number;
  from_name: string;
  from_email: string;
  subject: string;
  body_text: string;
  category: string;
  read: number | boolean;
  automated: number | boolean;
  received_at: string;
}

const preview = (t: string) => t.split(/\n\s*On .{5,200}wrote:/)[0]!.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);

export function RepliesTab({ campaign }: { campaign: Campaign }) {
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['campaign', campaign.id, 'replies', page],
    queryFn: () => api.get<Paginated<Reply>>(`/api/campaigns/${campaign.id}/replies`, { page, per_page: 25 }),
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <Loading />;
  const rows = q.data?.data ?? [];
  return (
    <Card padded={false}>
      {rows.length === 0 ? (
        <EmptyState icon={<MessageSquare className="size-5" />} title="No replies yet" description="Replies are pulled from your mailboxes every couple of minutes and show up here and in the Master Inbox." />
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const name = r.from_name || r.from_email;
              return (
                <li key={r.id}>
                  <button onClick={() => navigate(`/inbox?reply=${r.id}`)} className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-slate-50">
                    <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white', avatarColor(r.from_email))}>{initials(name)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cx('text-sm text-slate-900', !r.read ? 'font-semibold' : 'font-medium')}>{name}</span>
                        <ReplyCategory status={r.category} />
                        <span className="ml-auto text-xs text-slate-500">{fmtRelative(r.received_at)}</span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-slate-700">{r.subject}</div>
                      <div className="mt-0.5 truncate text-[13px] text-slate-500">{preview(r.body_text)}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <Pagination meta={q.data?.meta} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
