import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, RotateCcw, Trophy } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtDateTime, fmtNumber, fmtPct } from '../../lib/format.ts';
import { Badge, Button, Input, Select, Table, Td, Th, Toggle, cx, useUi } from '../../components/ui.tsx';
import { AB_DEFAULTS, type AbConfig, type AbTest, type Campaign, METRIC_LABELS, type VariantStats } from './types.ts';

export const useAbTests = (campaignId: number) => useQuery({
  queryKey: ['campaign', campaignId, 'ab-tests'],
  queryFn: () => api.get(`/api/campaigns/${campaignId}/ab-tests`).then((r) => r.data as AbTest[]),
  refetchInterval: 60_000,
});

const conf = (v: VariantStats) => (v.confidence === null ? '—' : `${(v.confidence * 100).toFixed(1)}%`);

/** Per-variant stats with rates, confidence and the winner/leader badge. */
export function VariantStatsTable({ test, campaign, onPick, picking }: { test: AbTest; campaign: Campaign; onPick?: (id: number) => void; picking?: boolean }) {
  const metric = METRIC_LABELS[test.config.metric];
  return (
    <Table>
      <thead>
        <tr>
          <Th>Variant</Th>
          <Th className="text-right">Sent</Th>
          <Th className="text-right">Opens</Th>
          <Th className="text-right">Clicks</Th>
          <Th className="text-right">Replies</Th>
          <Th className="text-right">Interested</Th>
          <Th className="text-right">Bounces</Th>
          <Th className="text-right" >{metric}</Th>
          <Th className="text-right">Confidence</Th>
          {onPick && <Th />}
        </tr>
      </thead>
      <tbody>
        {test.variants.map((v) => (
          <tr key={v.id} className={cx(!v.active && !v.is_winner && 'opacity-50')}>
            <Td className="whitespace-nowrap">
              <Badge tone="purple">{v.letter}</Badge>
              {v.is_winner && <Badge tone="green" className="ml-1"><Trophy className="mr-0.5 inline size-3" />Winner</Badge>}
              {!test.winner_step_id && v.is_leader && <Badge tone="blue" className="ml-1">Leading</Badge>}
              <span className="ml-2 inline-block max-w-56 truncate align-middle text-slate-600">{v.email_subject || <i className="text-slate-400">Reply in thread</i>}</span>
            </Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.sent)}</Td>
            <Td className="text-right tabular-nums">{campaign.open_tracking ? <>{fmtNumber(v.opens)} <span className="text-slate-400">{fmtPct(v.open_rate)}</span></> : '—'}</Td>
            <Td className="text-right tabular-nums">{campaign.click_tracking ? <>{fmtNumber(v.clicks)} <span className="text-slate-400">{fmtPct(v.click_rate)}</span></> : '—'}</Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.replies)} <span className="text-slate-400">{fmtPct(v.reply_rate)}</span></Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.interested)} <span className="text-slate-400">{fmtPct(v.interested_rate)}</span></Td>
            <Td className="text-right tabular-nums">{fmtNumber(v.bounces)} <span className="text-slate-400">{fmtPct(v.bounce_rate)}</span></Td>
            <Td className="text-right font-medium tabular-nums" >{fmtPct(v.metric_rate)}<div className="text-[11px] font-normal text-slate-400">{fmtNumber(v.mature_sent)} counted</div></Td>
            <Td className="text-right tabular-nums">{conf(v)}</Td>
            {onPick && (
              <Td className="text-right">
                {!v.is_winner && <Button size="sm" variant="ghost" disabled={picking} onClick={() => onPick(v.id)}>Pick winner</Button>}
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** A/B settings + live results for one step, shown in the sequence editor when the step has variants. */
export function AbTestPanel({ campaign, stepId, config, onConfig, dirty, onChanged }: { campaign: Campaign; stepId?: number; config?: AbConfig | null; onConfig: (c: AbConfig) => void; dirty: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const tests = useAbTests(campaign.id);
  const test = tests.data?.find((t) => t.step_id === stepId);
  const cfg = config ?? { ...AB_DEFAULTS, enabled: false };
  const set = (patch: Partial<AbConfig>) => onConfig({ ...cfg, ...patch });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['campaign', campaign.id] }); onChanged(); };

  const pick = useMutation({
    mutationFn: (variantId: number) => api.post(`/api/campaigns/${campaign.id}/ab-tests/${stepId}/pick-winner`, { variant_id: variantId }),
    onSuccess: () => { toast('Winner picked: the other variants are switched off'); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reset = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${campaign.id}/ab-tests/${stepId}/reset`),
    onSuccess: () => { toast('Test reset: variants switched back on'); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const onPick = async (id: number) => {
    if (dirty) { toast('Save the sequence first', 'error'); return; }
    const letter = test?.variants.find((v) => v.id === id)?.letter;
    if (await confirm({ title: `Pick variant ${letter} as the winner?`, message: 'The other variants are switched off and every remaining lead gets this one.', confirmLabel: 'Pick winner' })) pick.mutate(id);
  };

  const metricBlocked = (m: string) => (m === 'open_rate' && !campaign.open_tracking) || (m === 'click_rate' && !campaign.click_tracking);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800"><FlaskConical className="size-4 text-violet-500" />A/B test</div>
          <div className="text-xs text-slate-500">
            {test?.status === 'decided'
              ? <>Winner picked {test.decision?.decided_by === 'manual' ? 'manually' : 'automatically'} {fmtDateTime(test.decided_at)}{test.decision?.p_value != null ? ` · p = ${test.decision.p_value.toFixed(4)}` : ''}. {test.reason}</>
              : test?.reason || 'Leads are split evenly across active variants.'}
          </div>
        </div>
        {test?.status === 'decided' && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={reset.isPending} onClick={async () => {
            if (await confirm({ title: 'Reset this A/B test?', message: 'Switched-off variants are turned back on and the test starts again.', confirmLabel: 'Reset test' })) reset.mutate();
          }}>Reset test</Button>
        )}
      </div>

      <Toggle checked={cfg.enabled} onChange={(v) => set({ enabled: v })} label="Pick the winner automatically" description="Two-proportion z-test of the leader against every other variant. Losers are switched off and the rest of the leads get the winner." />
      {cfg.enabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-[12px] text-slate-600">Winning metric
            <Select className="mt-1 h-8 text-[13px]" value={cfg.metric} onChange={(e) => set({ metric: e.target.value as AbConfig['metric'] })}>
              {Object.entries(METRIC_LABELS).map(([k, l]) => <option key={k} value={k} disabled={metricBlocked(k)}>{l}{metricBlocked(k) ? ' (tracking off)' : ''}</option>)}
            </Select>
          </label>
          <label className="text-[12px] text-slate-600">Min. sends per variant
            <Input type="number" min={1} className="mt-1 h-8 text-[13px]" value={cfg.min_sends_per_variant} onChange={(e) => set({ min_sends_per_variant: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <label className="text-[12px] text-slate-600">Wait for replies (days)
            <Input type="number" min={0} className="mt-1 h-8 text-[13px]" value={cfg.reply_wait_days} onChange={(e) => set({ reply_wait_days: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label className="text-[12px] text-slate-600">Confidence
            <Select className="mt-1 h-8 text-[13px]" value={cfg.confidence} onChange={(e) => set({ confidence: Number(e.target.value) })}>
              {[0.8, 0.9, 0.95, 0.99].map((c) => <option key={c} value={c}>{c * 100}%</option>)}
            </Select>
          </label>
          <label className="text-[12px] text-slate-600 sm:col-span-2">Who is tested
            <Select className="mt-1 h-8 text-[13px]" value={cfg.pool} onChange={(e) => set({ pool: e.target.value as AbConfig['pool'] })}>
              <option value="all">All leads until a winner is found</option>
              <option value="percent">A share of leads, then the winner to the rest</option>
            </Select>
          </label>
          {cfg.pool === 'percent' && (
            <label className="text-[12px] text-slate-600">Test share (%)
              <Input type="number" min={1} max={100} className="mt-1 h-8 text-[13px]" value={cfg.test_percent} onChange={(e) => set({ test_percent: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
            </label>
          )}
        </div>
      )}

      {test && test.variants.some((v) => v.sent > 0) && (
        <div className="-mx-4 overflow-x-auto border-t border-slate-100">
          <VariantStatsTable test={test} campaign={campaign} onPick={stepId ? onPick : undefined} picking={pick.isPending} />
        </div>
      )}
      {!stepId && <div className="text-xs text-slate-400">Save the sequence to see results and pick winners.</div>}
    </div>
  );
}
