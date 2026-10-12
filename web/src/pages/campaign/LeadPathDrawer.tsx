import { useQuery } from '@tanstack/react-query';
import { GitBranch, MessageSquare, Send } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { Badge, Drawer, Loading } from '../../components/ui.tsx';
import type { Campaign } from './types.ts';

type PathEvent =
  | { type: 'sent'; id: number; at: string; step_order: number; variant: string | null; subject: string; opens: number; clicks: number; replies: number; bounced: number }
  | { type: 'branch'; id: number; at: string; from_step: number; rule_index: number | null; target_step: number | null; reason: string; description: string }
  | { type: 'reply'; id: number; at: string; category: string; subject: string };

interface LeadPath {
  lead: { id: number; email: string };
  status: string;
  current_step: number;
  next_step: number | null;
  next_due_at: string | null;
  email_provider: string | null;
  timeline: PathEvent[];
}

/** Which steps a lead got, which branch it took at each decision and why. */
export function LeadPathDrawer({ campaign, leadId, onClose }: { campaign: Campaign; leadId: number; onClose: () => void }) {
  const path = useQuery({
    queryKey: ['campaign', campaign.id, 'lead-path', leadId],
    queryFn: () => api.get(`/api/campaigns/${campaign.id}/leads/${leadId}/path`).then((r) => r.data as LeadPath),
  });
  const p = path.data;
  return (
    <Drawer open onClose={onClose} title="Lead path" subtitle={p?.lead.email}>
      {!p ? <Loading /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-[13px] text-slate-600">
            <Badge>{p.status.replace('_', ' ')}</Badge>
            {p.next_step && ['pending', 'in_sequence'].includes(p.status) && <span>Next: Step {p.next_step}{p.next_due_at ? `, due ${fmtDateTime(p.next_due_at)}` : ''}</span>}
            {p.email_provider && <span className="text-slate-400">· {p.email_provider === 'google' ? 'Google' : p.email_provider === 'microsoft' ? 'Microsoft' : 'Other'} mailbox</span>}
          </div>
          {p.timeline.length === 0 && <div className="text-sm text-slate-500">Nothing sent yet.</div>}
          <ol className="relative space-y-3 border-l border-slate-200 pl-5">
            {p.timeline.map((e) => (
              <li key={`${e.type}-${e.id}`} className="relative">
                <span className="absolute -left-[27px] top-0.5 flex size-5 items-center justify-center rounded-full bg-white ring-1 ring-slate-200">
                  {e.type === 'sent' ? <Send className="size-3 text-emerald-600" /> : e.type === 'branch' ? <GitBranch className="size-3 text-violet-600" /> : <MessageSquare className="size-3 text-brand-600" />}
                </span>
                <div className="text-[11px] text-slate-400">{fmtDateTime(e.at)}</div>
                {e.type === 'sent' && (
                  <div className="text-[13px] text-slate-800">
                    <span className="font-medium">Step {e.step_order}</span>{e.variant && <Badge tone="purple" className="ml-1.5">{e.variant}</Badge>}
                    <span className="ml-1.5 text-slate-500">{e.subject}</span>
                    <div className="text-[12px] text-slate-500">
                      {[e.opens ? 'opened' : 'not opened', e.clicks ? 'clicked' : null, e.replies ? 'replied' : null, e.bounced ? 'bounced' : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                )}
                {e.type === 'branch' && (
                  <div className="text-[13px] text-slate-800">
                    After step {e.from_step}: <span className="font-medium">{e.description}</span>
                    <div className="text-[12px] text-slate-500">{e.rule_index === null ? 'Else' : `Rule ${e.rule_index + 1}`}: {e.reason}</div>
                  </div>
                )}
                {e.type === 'reply' && <div className="text-[13px] text-slate-800">Replied <span className="text-slate-500">({e.category.replace('_', ' ')})</span></div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Drawer>
  );
}
