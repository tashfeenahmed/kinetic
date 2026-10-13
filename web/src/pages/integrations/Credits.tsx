import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Badge, Button, Card, Input, Loading, ProgressBar, cx, useUi } from '../../components/ui.tsx';
import { BrandIcon } from '../../components/BrandIcon.tsx';

export interface CreditRow {
  id: 'apollo' | 'hunter' | 'prospeo' | 'pdl'; label: string; note: string; connected: boolean;
  month: string; used: number; calls: number; last_at: string | null; budget: number; free_monthly: number;
  blocked: string | null; live: { remaining: number | null; used?: number | null; available?: number | null; resets?: string | null; plan?: string | null } | null;
}

const DOMAINS: Record<CreditRow['id'], string> = { apollo: 'apollo.io', hunter: 'hunter.io', prospeo: 'prospeo.io', pdl: 'peopledatalabs.com' };

export function useCredits() {
  return useQuery({ queryKey: ['gtm-credits'], queryFn: () => api.get('/api/gtm/credits').then((r) => r.data as CreditRow[]), refetchInterval: 60_000 });
}

/**
 * Paid data credits (Integrations → Credits): what each fallback vendor used this month
 * against its monthly budget, the vendor's own live balance where it reports one, and an
 * editable budget. Waterfalls skip a vendor once its budget is reached.
 */
export function CreditsPanel() {
  const q = useCredits();
  const qc = useQueryClient();
  const { toast } = useUi();
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = async (id: string) => {
    const n = Number(edit[id]);
    if (!Number.isFinite(n) || n < 0) return toast('Enter a number of credits (0 = never use it)', 'error');
    try {
      await api.put('/api/gtm/credits/budgets', { [id]: Math.round(n) });
      setEdit((e) => { const { [id]: _, ...rest } = e; return rest; });
      await qc.invalidateQueries({ queryKey: ['gtm-credits'] });
      toast('Budget saved');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <Card padded={false} title="Email & people credits"
      description="Finding emails always tries the free steps first: the company website and web search read with AI, then the email pattern checked over SMTP. These paid vendors only run when those find nothing, in this order, and each stops at its monthly budget.">
      {q.isLoading ? <Loading /> : (
        <div className="divide-y divide-slate-100">
          {(q.data ?? []).map((c, i) => {
            const pct = c.budget ? Math.min(100, (c.used / c.budget) * 100) : 100;
            return (
              <div key={c.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_220px_190px] sm:items-center">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 w-4 text-right text-[12px] font-semibold text-slate-400">{i + 1}</span>
                  <BrandIcon domain={DOMAINS[c.id]} size={22} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-slate-900">
                      {c.label}
                      {!c.connected ? <Badge tone="gray">No key</Badge> : c.blocked ? <Badge tone="yellow">Budget used — skipped</Badge> : <Badge tone="green">In use</Badge>}
                      {c.live?.plan && <span className="text-[12px] font-normal text-slate-400">{c.live.plan} plan</span>}
                    </div>
                    <div className="truncate text-[12.5px] text-slate-500">{c.note}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-[12.5px]">
                    <span className="font-medium text-slate-800">{c.used} / {c.budget} used</span>
                    <span className="text-slate-400">{c.month}</span>
                  </div>
                  <ProgressBar value={pct} tone={pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : 'blue'} />
                  <div className="mt-1 text-[12px] text-slate-500">
                    {c.live?.remaining != null ? <>{c.live.remaining} left on {c.label}{c.live.resets ? ` · resets ${c.live.resets}` : ''}</> : c.connected ? 'Counted by Kinetic' : '—'}
                    {c.last_at && <span className="text-slate-400"> · last used {fmtRelative(c.last_at)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} className={cx('h-8 w-24 text-[13px]')} value={edit[c.id] ?? String(c.budget)} onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })} aria-label={`${c.label} monthly budget`} />
                  {edit[c.id] != null && edit[c.id] !== String(c.budget)
                    ? <Button size="sm" variant="primary" onClick={() => save(c.id)}>Save</Button>
                    : <span className="text-[12px] text-slate-400">/month</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
