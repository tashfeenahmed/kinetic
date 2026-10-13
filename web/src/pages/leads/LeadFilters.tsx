import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Plus, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, cx, Field, Input, Menu, Modal, Popover, Select, useUi } from '../../components/ui.tsx';
import { REPLY_LABELS } from '../../components/status.tsx';

/**
 * Email-activity filters for the Leads page, as GET /api/leads query parameters
 * (opens_min, replied, last_contacted_before=14d, ...). Values are kept as strings.
 */
export type StatFilters = Record<string, string>;

type Kind = 'count' | 'bool' | 'age' | 'labels' | 'campaigns' | 'senders' | 'providers' | 'flag';
interface FieldDef { id: string; label: string; kind: Kind; keys: string[] }

const FIELDS: FieldDef[] = [
  { id: 'opens', label: 'Opens', kind: 'count', keys: ['opens_min', 'opens_max'] },
  { id: 'clicks', label: 'Clicks', kind: 'count', keys: ['clicks_min', 'clicks_max'] },
  { id: 'replies', label: 'Replies', kind: 'count', keys: ['replies_min', 'replies_max'] },
  { id: 'sent', label: 'Emails sent', kind: 'count', keys: ['sent_min', 'sent_max'] },
  { id: 'replied', label: 'Replied', kind: 'bool', keys: ['replied'] },
  { id: 'bounced', label: 'Bounced', kind: 'bool', keys: ['bounced'] },
  { id: 'unsubscribed', label: 'Unsubscribed', kind: 'bool', keys: ['unsubscribed'] },
  { id: 'reply_category', label: 'Reply category', kind: 'labels', keys: ['reply_category'] },
  { id: 'last_contacted', label: 'Last contacted', kind: 'age', keys: ['last_contacted_before', 'last_contacted_after'] },
  { id: 'last_opened', label: 'Last opened', kind: 'age', keys: ['last_opened_before', 'last_opened_after'] },
  { id: 'last_clicked', label: 'Last clicked', kind: 'age', keys: ['last_clicked_before', 'last_clicked_after'] },
  { id: 'last_replied', label: 'Last replied', kind: 'age', keys: ['last_replied_before', 'last_replied_after'] },
  { id: 'in_campaign', label: 'In campaign', kind: 'campaigns', keys: ['in_campaign_ids'] },
  { id: 'not_in_campaign', label: 'Not in campaign', kind: 'campaigns', keys: ['not_in_campaign_ids'] },
  { id: 'no_campaign', label: 'In no campaign', kind: 'flag', keys: ['without_campaign'] },
  { id: 'sender', label: 'Sender mailbox', kind: 'senders', keys: ['sender_email_ids'] },
  { id: 'provider', label: 'Email provider', kind: 'providers', keys: ['email_provider'] },
];

const PROVIDERS = [
  ['google', 'Google'], ['microsoft', 'Microsoft'], ['yahoo', 'Yahoo'], ['zoho', 'Zoho'], ['icloud', 'iCloud'], ['proofpoint', 'Proofpoint'],
  ['mimecast', 'Mimecast'], ['barracuda', 'Barracuda'], ['other', 'Other'], ['none', 'No MX'], ['unknown', 'Not checked yet'],
] as const;
const providerName = (id: string) => PROVIDERS.find((p) => p[0] === id)?.[1] ?? id;
const labelName = (id: string) => REPLY_LABELS.find((l) => l.id === id)?.label ?? id;

/** Keys owned by this builder (everything else on the page has its own control). */
export const STAT_KEYS = FIELDS.flatMap((f) => f.keys).concat('sort');

interface Named { id: number; name?: string; email?: string }
function useLookups(enabled = true) {
  const campaigns = useQuery({ queryKey: ['campaigns', 'all'], queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as Named[]), enabled });
  const senders = useQuery({ queryKey: ['sender-emails'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as Named[]), enabled });
  return { campaigns: campaigns.data ?? [], senders: senders.data ?? [] };
}

const age = (v: string) => {
  const m = /^(\d+)([hdwm])$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { h: 'hour', d: 'day', w: 'week', m: 'month' }[m[2] as 'd'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

/** Human text for one filter key ("Opens ≥ 3", "Last contacted > 14 days ago"). */
function chipText(key: string, value: string, look: ReturnType<typeof useLookups>): string {
  const f = FIELDS.find((x) => x.keys.includes(key));
  if (!f) return `${key} = ${value}`;
  switch (f.kind) {
    case 'count': return key.endsWith('_max') ? (value === '0' ? `${f.label} = 0` : `${f.label} ≤ ${value}`) : `${f.label} ≥ ${value}`;
    case 'bool': return `${f.label} = ${value === 'true' ? 'yes' : 'no'}`;
    case 'age': {
      const a = age(value);
      if (key.endsWith('_before')) return a ? `${f.label} > ${a} ago` : `${f.label} before ${value}`;
      return a ? `${f.label} within ${a}` : `${f.label} after ${value}`;
    }
    case 'labels': return `${f.label}: ${value.split(',').map(labelName).join(', ')}`;
    case 'providers': return `${f.label}: ${value.split(',').map(providerName).join(', ')}`;
    case 'campaigns': return `${f.label}: ${value.split(',').map((id) => look.campaigns.find((c) => String(c.id) === id)?.name ?? `#${id}`).join(', ')}`;
    case 'senders': return `${f.label}: ${value.split(',').map((id) => look.senders.find((c) => String(c.id) === id)?.email ?? `#${id}`).join(', ')}`;
    case 'flag': return f.label;
  }
}

const SORTS: [string, string][] = [['', 'Newest'], ['oldest', 'Oldest'], ['opens', 'Most opens'], ['clicks', 'Most clicks'], ['replies', 'Most replies'], ['last_contacted', 'Last contacted'], ['last_opened', 'Last opened'], ['last_replied', 'Last replied']];

/** "+ Filter" chips, sort and saved views/presets. */
export function LeadFilterBar({ value, onChange, base, onApplyBase }: {
  value: StatFilters;
  onChange: (f: StatFilters) => void;
  /** The page's other filters (search, status, list, tag) — saved with a view. */
  base: Record<string, string>;
  onApplyBase: (b: Record<string, string>) => void;
}) {
  const look = useLookups();
  const chips = Object.entries(value).filter(([k, v]) => k !== 'sort' && v !== '');
  const remove = (k: string) => { const n = { ...value }; delete n[k]; onChange(n); };
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-4 py-2">
      <ViewsMenu value={value} base={base} onApply={(f) => {
        const stat: StatFilters = {};
        const b: Record<string, string> = {};
        for (const [k, v] of Object.entries(f)) {
          const s = Array.isArray(v) ? v.join(',') : String(v);
          if (STAT_KEYS.includes(k)) stat[k] = s; else b[k] = s;
        }
        onChange(stat);
        onApplyBase(b);
      }} />
      {chips.map(([k, v]) => (
        <span key={k} className="inline-flex h-7 items-center gap-1 rounded-[7px] bg-zinc-100 pl-2.5 pr-1 text-[12.5px] text-zinc-800">
          {chipText(k, v, look)}
          <button onClick={() => remove(k)} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800" aria-label="Remove filter"><X className="size-3" /></button>
        </span>
      ))}
      <AddFilter look={look} onAdd={(patch) => onChange({ ...value, ...patch })} current={value} />
      {chips.length > 0 && <button onClick={() => onChange(value.sort ? { sort: value.sort } : {})} className="h-7 px-1.5 text-[12.5px] text-zinc-500 hover:text-zinc-900">Clear</button>}
      <div className="flex-1" />
      <select value={value.sort ?? ''} onChange={(e) => onChange({ ...value, sort: e.target.value })}
        className="h-7 rounded-[7px] bg-transparent px-1.5 text-[12.5px] text-zinc-600 outline-none hover:bg-zinc-50" aria-label="Sort">
        {SORTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
      </select>
    </div>
  );
}

function AddFilter({ look, onAdd, current }: { look: ReturnType<typeof useLookups>; onAdd: (patch: StatFilters) => void; current: StatFilters }) {
  const [open, setOpen] = useState(false);
  const [fieldId, setFieldId] = useState('opens');
  const [op, setOp] = useState('min');
  const [val, setVal] = useState('');
  const [multi, setMulti] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const f = FIELDS.find((x) => x.id === fieldId)!;

  const closeMenu = useCallback(() => setOpen(false), []);
  useEffect(() => {
    setOp(f.kind === 'count' ? 'min' : f.kind === 'bool' ? 'true' : f.kind === 'age' ? 'before' : '');
    setVal(f.kind === 'age' ? '14' : f.kind === 'count' ? '1' : '');
    setMulti([]);
  }, [fieldId]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    const patch: StatFilters = {};
    if (f.kind === 'count') {
      if (val === '' || Number(val) < 0) return;
      if (op === 'eq') { patch[f.keys[0]!] = val; patch[f.keys[1]!] = val; } else patch[op === 'min' ? f.keys[0]! : f.keys[1]!] = val;
    } else if (f.kind === 'bool') patch[f.keys[0]!] = op;
    else if (f.kind === 'flag') patch[f.keys[0]!] = 'true';
    else if (f.kind === 'age') { if (!Number(val)) return; patch[op === 'before' ? f.keys[0]! : f.keys[1]!] = `${Number(val)}d`; }
    else if (f.kind === 'labels' || f.kind === 'providers') { if (!multi.length) return; patch[f.keys[0]!] = multi.join(','); }
    else {
      if (!val) return;
      const prev = (current[f.keys[0]!] ?? '').split(',').filter(Boolean);
      patch[f.keys[0]!] = [...new Set([...prev, val])].join(',');
    }
    onAdd(patch);
    setOpen(false);
  };

  const options = f.kind === 'labels' ? REPLY_LABELS.filter((l) => l.id !== 'bounce').map((l) => [l.id, l.label] as const) : f.kind === 'providers' ? PROVIDERS : null;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-[12.5px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
        <Plus className="size-3.5" /> Filter
      </button>
      <Popover anchor={ref.current} open={open} onClose={closeMenu} className="w-72 space-y-2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          <Select value={fieldId} onChange={(e) => setFieldId(e.target.value)} aria-label="Field">
            {FIELDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
          {f.kind === 'count' && (
            <div className="flex gap-2">
              <Select className="w-24" value={op} onChange={(e) => setOp(e.target.value)} aria-label="Operator"><option value="min">≥</option><option value="max">≤</option><option value="eq">=</option></Select>
              <Input type="number" min={0} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} autoFocus />
            </div>
          )}
          {f.kind === 'bool' && (
            <Select value={op} onChange={(e) => setOp(e.target.value)} aria-label="Value"><option value="true">Yes</option><option value="false">No</option></Select>
          )}
          {f.kind === 'age' && (
            <div className="flex items-center gap-2">
              <Select className="w-36" value={op} onChange={(e) => setOp(e.target.value)} aria-label="Operator"><option value="before">more than</option><option value="after">within the last</option></Select>
              <Input type="number" min={1} className="w-20" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
              <span className="text-[13px] text-slate-500">days{op === 'before' ? ' ago' : ''}</span>
            </div>
          )}
          {options && (
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto scroll-thin">
              {options.map(([id, l]) => (
                <button key={id} onClick={() => setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))}
                  className={cx('rounded-md px-2 py-0.5 text-[12.5px] ring-1 ring-inset', multi.includes(id) ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50')}>{l}</button>
              ))}
            </div>
          )}
          {(f.kind === 'campaigns' || f.kind === 'senders') && (
            <Select value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value">
              <option value="">Choose…</option>
              {(f.kind === 'campaigns' ? look.campaigns : look.senders).map((x) => <option key={x.id} value={x.id}>{x.name ?? x.email}</option>)}
            </Select>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={apply}>Add filter</Button>
          </div>
      </Popover>
    </div>
  );
}

interface View { id: number | string; name: string; filters: Record<string, unknown> }

function ViewsMenu({ value, base, onApply }: { value: StatFilters; base: Record<string, string>; onApply: (f: Record<string, unknown>) => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [active, setActive] = useState<View | null>(null);
  const presets = useQuery({ queryKey: ['lead-filter-presets'], queryFn: () => api.get('/api/leads/filter-presets').then((r) => r.data as View[]), staleTime: Infinity });
  const views = useQuery({ queryKey: ['lead-views'], queryFn: () => api.get('/api/lead-views').then((r) => r.data as View[]) });
  const current = Object.fromEntries(Object.entries({ ...base, ...value }).filter(([, v]) => v !== '' && v != null));
  const save = useMutation({
    mutationFn: () => api.post('/api/lead-views', { name: name.trim(), filters: current }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['lead-views'] }); setActive(r.data); setSaving(false); setName(''); toast('View saved'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const pick = (v: View) => { setActive(v); onApply(v.filters); };
  const saved = views.data ?? [];
  return (
    <>
      <Menu
        align="left"
        trigger={(o) => (
          <button onClick={o} className={cx('inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] hover:bg-zinc-100', active ? 'font-medium text-zinc-900' : 'text-zinc-600')}>
            <Bookmark className="size-3.5" /> {active?.name ?? 'Views'}
          </button>
        )}
        items={[
          ...(presets.data ?? []).map((p) => ({ label: p.name, onClick: () => pick(p) })),
          ...(saved.length ? ['divider' as const, ...saved.map((v) => ({ label: v.name, onClick: () => pick(v) }))] : []),
          'divider' as const,
          { label: 'Save current filters as view…', disabled: !Object.keys(current).length, onClick: () => setSaving(true) },
          ...(active && typeof active.id === 'number' ? [{
            label: `Delete “${active.name}”`, danger: true,
            onClick: async () => {
              if (!(await confirm({ title: `Delete view “${active.name}”?`, message: 'Only the saved filter is removed.', confirmLabel: 'Delete', danger: true }))) return;
              await api.del(`/api/lead-views/${active.id}`).catch((e) => toast(errorMessage(e), 'error'));
              setActive(null);
              qc.invalidateQueries({ queryKey: ['lead-views'] });
            },
          }] : []),
        ]}
      />
      <Modal open={saving} onClose={() => setSaving(false)} title="Save view" size="sm"
        footer={<><Button onClick={() => setSaving(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>Save</Button></>}>
        <Field label="Name"><Input autoFocus value={name} placeholder="e.g. Warm, no reply" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) save.mutate(); }} /></Field>
      </Modal>
    </>
  );
}
