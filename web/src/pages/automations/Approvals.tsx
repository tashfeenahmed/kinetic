import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, MessageSquare, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Button, EmptyState, Loading, Select, Textarea, useUi } from '../../components/ui.tsx';
import { StatusBadge } from './shared.tsx';

interface Approval {
  id: number; job_id: number | null; job_name: string | null; kind: string;
  target: { postUrl?: string; authorName?: string; authorUrl?: string }; context: string | null; draft: string; status: string; created_at: string;
}

/** AI-drafted comments waiting for a human decision before the extension posts them. */
export function Approvals() {
  const [status, setStatus] = useState('pending');
  const list = useQuery({
    queryKey: ['automations', 'approvals', status],
    queryFn: () => api.get<{ data: Approval[] }>('/api/automations/approvals', { status }).then((r) => r.data),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          {['pending', 'approved', 'posted', 'rejected', 'failed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <span className="text-[12.5px] text-zinc-500">Nothing is posted until you approve it.</span>
      </div>
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <EmptyState icon={<MessageSquare className="size-5" />} title={status === 'pending' ? 'No drafts waiting' : `No ${status} drafts`}
          description="The LinkedIn AI Post Responder drafts a comment for each post it finds and puts it here for review." />
      ) : (
        <div className="space-y-3">{list.data.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>
      )}
    </div>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [text, setText] = useState(a.draft);
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => api.post(`/api/automations/approvals/${a.id}/${d}`, d === 'approve' ? { text } : {}),
    onSuccess: (_r, d) => { toast(d === 'approve' ? 'Approved — the extension will post it' : 'Rejected'); void qc.invalidateQueries({ queryKey: ['automations'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const pending = a.status === 'pending';
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 text-[13px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900">{a.target.authorName ?? 'Post'}</span>
        {a.target.postUrl && <a href={a.target.postUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-900">open post <ExternalLink className="size-3" /></a>}
        <span className="text-zinc-400">· {a.job_name ?? 'AI post responder'} · {fmtRelative(a.created_at)}</span>
        <span className="ml-auto"><StatusBadge status={a.status} /></span>
      </div>
      {a.context && <blockquote className="mb-3 line-clamp-4 border-l-2 border-zinc-200 pl-3 text-zinc-600">{a.context}</blockquote>}
      {pending ? (
        <>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" icon={<X className="size-3.5" />} loading={decide.isPending && decide.variables === 'reject'} onClick={() => decide.mutate('reject')}>Reject</Button>
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} disabled={!text.trim()} loading={decide.isPending && decide.variables === 'approve'} onClick={() => decide.mutate('approve')}>Approve & post</Button>
          </div>
        </>
      ) : <div className="whitespace-pre-wrap rounded-md bg-zinc-50 px-3 py-2 text-zinc-800">{a.draft}</div>}
    </div>
  );
}
