import type { InputHTMLAttributes } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Plus, X } from 'lucide-react';
import { api, type Paginated } from '../../lib/api.ts';
import { Button, Input, Select, cx } from '../../components/ui.tsx';
import { type Action, type Branching, type Campaign, type Condition, type Rule, WEEKDAYS } from './types.ts';

// ---- sentences -------------------------------------------------------------

const PROVIDERS = { google: 'Google', microsoft: 'Microsoft', other: 'other' } as const;
const OPS: Record<string, string> = { equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain', empty: 'is empty', not_empty: 'is not empty', gt: '>', lt: '<' };

export function conditionText(c: Condition): string {
  const not = 'negate' in c && c.negate ? 'not ' : '';
  switch (c.type) {
    case 'opened': return `${not}opened${c.scope === 'any' ? ' any email' : ''}`;
    case 'clicked': return `${not}clicked${c.url ? ` “${c.url}”` : ''}${c.scope === 'any' ? ' in any email' : ''}`;
    case 'replied': return `${not}replied`;
    case 'reply_category': return `reply ${not ? 'is not' : 'is'} ${c.value === 'interested' ? 'interested' : 'not interested'}`;
    case 'lead_field': return `${c.field || 'field'} ${OPS[c.op]}${['empty', 'not_empty'].includes(c.op) ? '' : ` “${c.value ?? ''}”`}`;
    case 'email_provider': return `provider is ${not}${PROVIDERS[c.value]}`;
    case 'has_tag': return `${not ? 'not ' : ''}tagged “${c.tag}”`;
    case 'day_of_week': return `it's ${c.days.map((d) => d.slice(0, 3)).join('/')}`;
    case 'time_since_previous': return `${c.op === 'gt' ? 'more' : 'less'} than ${c.days}d since last email`;
  }
}

export function actionText(a: Action): string {
  switch (a.type) {
    case 'continue': return 'continue';
    case 'jump': return `go to Step ${a.step}`;
    case 'skip': return 'skip next step';
    case 'wait': return `wait ${a.days} more day${a.days === 1 ? '' : 's'}`;
    case 'end': return 'end sequence';
    case 'move': return `move to campaign #${a.campaign_id}`;
    case 'add_tag': return `tag “${a.tag}” and continue`;
  }
}

export const hasRules = (b?: Branching | null) => !!b && (b.rules.length > 0 || b.else.type !== 'continue');

/** Compact summary lines for the steps list, e.g. "If not opened → go to Step 3". */
export function RuleSummary({ branching }: { branching?: Branching | null }) {
  if (!hasRules(branching)) return null;
  const b = branching!;
  return (
    <div className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5 text-[12px] text-slate-500">
      {b.rules.map((r, i) => (
        <div key={i} className="flex items-start gap-1">
          <GitBranch className="mt-0.5 size-3 shrink-0 text-violet-500" />
          <span>If <b className="font-medium text-slate-700">{r.when.map(conditionText).join(r.match === 'any' ? ' or ' : ' and ')}</b> → <b className="font-medium text-slate-700">{actionText(r.then)}</b></span>
        </div>
      ))}
      <div className="pl-4">else → <b className="font-medium text-slate-700">{actionText(b.else)}</b></div>
    </div>
  );
}

// ---- editor ----------------------------------------------------------------

type Kind = 'opened' | 'not_opened' | 'clicked' | 'not_clicked' | 'replied' | 'not_replied' | 'interested' | 'not_interested' | 'lead_field' | 'email_provider' | 'has_tag' | 'no_tag' | 'day_of_week' | 'time_since_previous';
const KINDS: [Kind, string][] = [
  ['not_opened', 'not opened'], ['opened', 'opened'], ['not_clicked', 'not clicked'], ['clicked', 'clicked'],
  ['replied', 'replied'], ['not_replied', 'not replied'], ['interested', 'reply is interested'], ['not_interested', 'reply is not interested'],
  ['lead_field', 'lead field / variable'], ['email_provider', 'email provider is'], ['has_tag', 'has tag'], ['no_tag', 'does not have tag'],
  ['day_of_week', 'day of week is'], ['time_since_previous', 'time since previous email'],
];

function kindOf(c: Condition): Kind {
  switch (c.type) {
    case 'opened': return c.negate ? 'not_opened' : 'opened';
    case 'clicked': return c.negate ? 'not_clicked' : 'clicked';
    case 'replied': return c.negate ? 'not_replied' : 'replied';
    case 'reply_category': return c.value === 'interested' ? 'interested' : 'not_interested';
    case 'has_tag': return c.negate ? 'no_tag' : 'has_tag';
    default: return c.type;
  }
}

function fromKind(k: Kind): Condition {
  switch (k) {
    case 'opened': case 'not_opened': return { type: 'opened', negate: k === 'not_opened' };
    case 'clicked': case 'not_clicked': return { type: 'clicked', negate: k === 'not_clicked' };
    case 'replied': case 'not_replied': return { type: 'replied', negate: k === 'not_replied' };
    case 'interested': case 'not_interested': return { type: 'reply_category', value: k };
    case 'lead_field': return { type: 'lead_field', field: 'title', op: 'contains', value: '' };
    case 'email_provider': return { type: 'email_provider', value: 'microsoft' };
    case 'has_tag': case 'no_tag': return { type: 'has_tag', tag: '', negate: k === 'no_tag' };
    case 'day_of_week': return { type: 'day_of_week', days: ['friday'] };
    case 'time_since_previous': return { type: 'time_since_previous', op: 'gt', days: 3 };
  }
}

const sel = 'w-auto shrink-0 text-[13px]';

function SmallInput({ w, ...rest }: InputHTMLAttributes<HTMLInputElement> & { w: string }) {
  return <span className={cx(w, 'shrink-0')}><Input className="text-[13px]" {...rest} /></span>;
}

function ConditionEditor({ c, onChange }: { c: Condition; onChange: (c: Condition) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select className={sel} value={kindOf(c)} onChange={(e) => onChange(fromKind(e.target.value as Kind))}>
        {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      {(c.type === 'opened' || c.type === 'clicked') && (
        <Select className={sel} value={c.scope ?? 'previous'} onChange={(e) => onChange({ ...c, scope: e.target.value as 'previous' | 'any' })}>
          <option value="previous">this email</option>
          <option value="any">any email so far</option>
        </Select>
      )}
      {c.type === 'clicked' && !c.negate && <SmallInput w="w-40"  placeholder="link contains (optional)" value={c.url ?? ''} onChange={(e) => onChange({ ...c, url: e.target.value || undefined })} />}
      {c.type === 'lead_field' && (
        <>
          <SmallInput w="w-32"  placeholder="title / custom var" value={c.field} onChange={(e) => onChange({ ...c, field: e.target.value })} />
          <Select className={sel} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
            {Object.entries(OPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          {!['empty', 'not_empty'].includes(c.op) && <SmallInput w="w-32"  placeholder="value" value={String(c.value ?? '')} onChange={(e) => onChange({ ...c, value: ['gt', 'lt'].includes(c.op) && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />}
        </>
      )}
      {c.type === 'email_provider' && (
        <Select className={sel} value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as typeof c.value })}>
          <option value="google">Google</option><option value="microsoft">Microsoft</option><option value="other">Other</option>
        </Select>
      )}
      {c.type === 'has_tag' && <SmallInput w="w-36"  placeholder="tag name" value={c.tag} onChange={(e) => onChange({ ...c, tag: e.target.value })} />}
      {c.type === 'day_of_week' && (
        <div className="flex gap-0.5">
          {WEEKDAYS.map((d) => {
            const on = c.days.includes(d);
            return (
              <button key={d} type="button" onClick={() => onChange({ ...c, days: on ? c.days.filter((x) => x !== d) : [...c.days, d] })}
                className={cx('h-7 w-8 rounded-md text-[11px] font-medium', on ? 'bg-zinc-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
                {d.slice(0, 2)}
              </button>
            );
          })}
        </div>
      )}
      {c.type === 'time_since_previous' && (
        <>
          <Select className={sel} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'gt' | 'lt' })}>
            <option value="gt">more than</option><option value="lt">less than</option>
          </Select>
          <SmallInput w="w-20" type="number" min={0}  value={c.days} onChange={(e) => onChange({ ...c, days: Math.max(0, Number(e.target.value) || 0) })} />
          <span className="text-[13px] text-slate-500">days</span>
        </>
      )}
    </div>
  );
}

const ACTIONS: [Action['type'], string][] = [
  ['continue', 'continue to next step'], ['jump', 'go to step'], ['skip', 'skip next step'], ['wait', 'wait extra days'],
  ['end', 'end sequence'], ['move', 'move to campaign'], ['add_tag', 'add tag, continue'],
];

function ActionEditor({ a, onChange, stepCount, campaignId }: { a: Action; onChange: (a: Action) => void; stepCount: number; campaignId: number }) {
  const campaigns = useQuery({
    queryKey: ['campaigns', 'all-for-move'],
    queryFn: () => api.get<Paginated<Campaign>>('/api/campaigns', { per_page: 200 }).then((r) => r.data),
    enabled: a.type === 'move',
  });
  const change = (type: Action['type']) => {
    switch (type) {
      case 'jump': return onChange({ type, step: Math.min(stepCount, 1) });
      case 'wait': return onChange({ type, days: 2 });
      case 'move': return onChange({ type, campaign_id: 0 });
      case 'add_tag': return onChange({ type, tag: '' });
      default: return onChange({ type } as Action);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select className={sel} value={a.type} onChange={(e) => change(e.target.value as Action['type'])}>
        {ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      {a.type === 'jump' && (
        <Select className={sel} value={a.step} onChange={(e) => onChange({ ...a, step: Number(e.target.value) })}>
          {Array.from({ length: stepCount }, (_, i) => <option key={i} value={i + 1}>Step {i + 1}</option>)}
          {a.step > stepCount && <option value={a.step}>Step {a.step} (missing)</option>}
        </Select>
      )}
      {a.type === 'wait' && <><SmallInput w="w-20" type="number" min={1}  value={a.days} onChange={(e) => onChange({ ...a, days: Math.max(1, Number(e.target.value) || 1) })} /><span className="text-[13px] text-slate-500">days</span></>}
      {a.type === 'move' && (
        <Select className={sel} value={a.campaign_id || ''} onChange={(e) => onChange({ ...a, campaign_id: Number(e.target.value) })}>
          <option value="">Choose campaign…</option>
          {campaigns.data?.filter((c) => c.id !== campaignId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      )}
      {a.type === 'add_tag' && <SmallInput w="w-36"  placeholder="tag name" value={a.tag} onChange={(e) => onChange({ ...a, tag: e.target.value })} />}
    </div>
  );
}

const EMPTY: Branching = { rules: [], else: { type: 'continue' } };

/** "Add condition" section of a step: readable if/then rows checked when the next step is due. */
export function StepRulesEditor({ campaign, branching, onChange, stepIndex, stepCount, nextWait }: {
  campaign: Campaign; branching?: Branching | null; onChange: (b: Branching | null) => void; stepIndex: number; stepCount: number; nextWait: number | null;
}) {
  const b = branching ?? EMPTY;
  const set = (patch: Partial<Branching>) => {
    const next = { ...b, ...patch };
    onChange(next.rules.length || next.else.type !== 'continue' || next.max_visits || next.check_after_days !== undefined ? next : null);
  };
  const setRule = (i: number, r: Rule | null) => set({ rules: r ? b.rules.map((x, j) => (j === i ? r : x)) : b.rules.filter((_, j) => j !== i) });
  const isLast = stepIndex === stepCount - 1;
  const when = isLast
    ? `${b.check_after_days ?? 3} day(s) after this step`
    : `when Step ${stepIndex + 2} is due (${nextWait ?? 0} day${nextWait === 1 ? '' : 's'} after this step)`;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800"><GitBranch className="size-4 text-violet-500" />Conditions</div>
          <div className="text-xs text-slate-500">Checked {when}. The first rule that matches wins.</div>
        </div>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ rules: [...b.rules, { when: [{ type: 'opened', negate: true }], match: 'all', then: { type: stepCount > stepIndex + 2 ? 'jump' : 'end', ...(stepCount > stepIndex + 2 ? { step: stepIndex + 3 } : {}) } as Action }] })}>
          Add condition
        </Button>
      </div>

      {b.rules.map((r, i) => (
        <div key={i} className="rounded-md bg-slate-50 p-2.5">
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-1.5">
              {r.when.map((c, ci) => (
                <div key={ci} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-10 shrink-0 text-[13px] font-medium text-slate-500">
                    {ci === 0 ? 'If' : (
                      <button type="button" className="text-violet-600 hover:underline" onClick={() => setRule(i, { ...r, match: r.match === 'all' ? 'any' : 'all' })} title="Switch between and / or">
                        {r.match === 'all' ? 'and' : 'or'}
                      </button>
                    )}
                  </span>
                  <div className="min-w-0 flex-1"><ConditionEditor c={c} onChange={(nc) => setRule(i, { ...r, when: r.when.map((x, j) => (j === ci ? nc : x)) })} /></div>
                  {r.when.length > 1 && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => setRule(i, { ...r, when: r.when.filter((_, j) => j !== ci) })} aria-label="Remove condition"><X className="size-3.5" /></button>}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-10 shrink-0 text-[13px] font-medium text-slate-500">→</span>
                <div className="min-w-0 flex-1"><ActionEditor a={r.then} onChange={(a) => setRule(i, { ...r, then: a })} stepCount={stepCount} campaignId={campaign.id} /></div>
                <button type="button" className="ml-1 text-[12px] text-slate-500 hover:text-slate-800" onClick={() => setRule(i, { ...r, when: [...r.when, { type: 'opened', negate: true }] })}>+ and/or</button>
              </div>
            </div>
            <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => setRule(i, null)} aria-label="Remove rule"><X className="size-4" /></button>
          </div>
        </div>
      ))}

      {(b.rules.length > 0 || b.else.type !== 'continue') && (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5">
          <span className="w-10 shrink-0 text-[13px] font-medium text-slate-500">Else</span>
          <ActionEditor a={b.else} onChange={(a) => set({ else: a })} stepCount={stepCount} campaignId={campaign.id} />
        </div>
      )}

      {(b.rules.length > 0 || isLast) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[12px] text-slate-500">
          {isLast && (
            <label className="flex items-center gap-1.5">Check after
              <SmallInput w="w-16" type="number" min={0} value={b.check_after_days ?? 3} onChange={(e) => set({ check_after_days: Math.max(0, Number(e.target.value) || 0) })} /> days
            </label>
          )}
          <label className="flex items-center gap-1.5">Send this step at most
            <SmallInput w="w-16" type="number" min={1} value={b.max_visits ?? 3} onChange={(e) => set({ max_visits: Math.max(1, Number(e.target.value) || 1) })} /> times per lead (loop guard)
          </label>
        </div>
      )}
    </div>
  );
}
