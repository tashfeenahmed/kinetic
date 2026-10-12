import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Button, Drawer, Field, Input, Select, Textarea, Toggle, cx, useUi } from '../../components/ui.tsx';
import { CategoryChip, NetworkIcon, useTableColumns, useTables, splitLines, type Job, type Phantom, type PhantomField } from './shared.tsx';

type Targets = { mode: 'urls'; text: string } | { mode: 'table'; table_id: number | null; column: string };

function initialValues(p: Phantom, initial?: Record<string, any>) {
  const v: Record<string, any> = {};
  for (const f of p.fields) {
    if (f.type === 'targets') continue;
    v[f.key] = initial?.[f.key] ?? f.default ?? (f.type === 'boolean' ? false : '');
  }
  return v;
}

/** New-automation drawer, generated from the phantom's field schema. */
export function JobForm({ phantom, open, onClose, onCreated, initial }: {
  phantom: Phantom | null; open: boolean; onClose: () => void; onCreated?: (job: Job) => void;
  initial?: { name?: string; params?: Record<string, any>; schedule?: 'hourly' | 'daily' | 'weekly' };
}) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, any>>({});
  const [targets, setTargets] = useState<Targets>({ mode: 'urls', text: '' });
  const [output, setOutput] = useState<{ mode: 'new' | 'existing'; table_name: string; table_id: number | null }>({ mode: 'new', table_name: '', table_id: null });
  const [schedule, setSchedule] = useState<'' | 'hourly' | 'daily' | 'weekly'>('');
  const [alerts, setAlerts] = useState({ slack: false, slack_channel: '', webhook_url: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phantom || !open) return;
    setName(initial?.name ?? phantom.label);
    setValues(initialValues(phantom, initial?.params));
    const t = initial?.params?.targets;
    setTargets(t?.table_id ? { mode: 'table', table_id: t.table_id, column: t.column ?? '' } : { mode: 'urls', text: (t?.urls ?? []).join('\n') });
    setOutput({ mode: 'new', table_name: '', table_id: null });
    setSchedule(initial?.schedule ?? (phantom.category === 'monitor' ? 'daily' : ''));
    setAlerts({ slack: false, slack_channel: '', webhook_url: '' });
    setError(null);
  }, [phantom, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  const buildParams = () => {
    const params: Record<string, any> = {};
    for (const f of phantom!.fields) {
      if (f.type === 'targets') {
        params[f.key] = targets.mode === 'urls' ? { urls: splitLines(targets.text) } : { table_id: targets.table_id, column: targets.column };
      } else if (f.type === 'number') {
        const n = values[f.key];
        if (n !== '' && n != null) params[f.key] = Number(n);
      } else if (values[f.key] !== '' && values[f.key] != null) params[f.key] = values[f.key];
    }
    return params;
  };

  const create = useMutation({
    mutationFn: (start: boolean) => api.post<{ data: Job }>('/api/automations/jobs', {
      phantom: phantom!.id, name: name.trim() || phantom!.label, params: buildParams(),
      ...(output.mode === 'existing' && output.table_id ? { table_id: output.table_id } : { table_name: output.table_name.trim() || undefined }),
      ...(schedule ? { schedule: { every: schedule }, watcher: true } : {}),
      alerts: { ...(alerts.slack ? { slack: true, slack_channel: alerts.slack_channel || undefined } : {}), ...(alerts.webhook_url ? { webhook_url: alerts.webhook_url } : {}) },
      start,
    }),
    onSuccess: (r, start) => {
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      toast(start ? 'Automation started' : 'Saved as draft — review and start it from Jobs');
      onCreated?.(r.data);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (!phantom) return null;
  const sends = !!phantom.sends;

  return (
    <Drawer open={open} onClose={onClose} width="max-w-2xl"
      title={<span className="flex items-center gap-2.5"><NetworkIcon network={phantom.network} size={24} /> {phantom.label}</span>}
      subtitle={phantom.description}
      actions={<CategoryChip category={phantom.category} />}>
      <div className="space-y-5 text-[13.5px]">
        {phantom.runner === 'extension'
          ? <p className="text-[12.5px] text-zinc-500">Runs in your own browser through the Kinetic Companion extension, at human pace, within your limits and working hours.</p>
          : <p className="text-[12.5px] text-zinc-500">Runs on the Kinetic server using public data — no extension needed.</p>}
        {sends && (
          <Alert tone="yellow" title="This automation acts on your account">
            It sends, follows, likes or comments as you. It is saved as a draft until you start it, and daily limits always apply.
          </Alert>
        )}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>

        {phantom.fields.map((f) => f.type === 'targets'
          ? <TargetsInput key={f.key} field={f} value={targets} onChange={setTargets} />
          : <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} aiInstructions={values.ai_instructions} />)}

        <div className="space-y-3 border-t border-zinc-100 pt-4">
          <div className="text-[13px] font-semibold text-zinc-900">Results</div>
          <div className="flex gap-2">
            {(['new', 'existing'] as const).map((m) => (
              <button key={m} onClick={() => setOutput((o) => ({ ...o, mode: m }))}
                className={cx('rounded-[7px] border px-3 py-1.5 text-[13px]', output.mode === m ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50')}>
                {m === 'new' ? 'New table' : 'Existing table'}
              </button>
            ))}
          </div>
          {output.mode === 'new'
            ? <Field hint="Columns are created from the results; rows are deduped by the profile/post URL."><Input placeholder={name || phantom.label} value={output.table_name} onChange={(e) => setOutput((o) => ({ ...o, table_name: e.target.value }))} /></Field>
            : <TablePicker value={output.table_id} onChange={(id) => setOutput((o) => ({ ...o, table_id: id }))} />}
        </div>

        {phantom.watchable && (
          <div className="space-y-3 border-t border-zinc-100 pt-4">
            <Toggle checked={!!schedule} onChange={(v) => setSchedule(v ? 'daily' : '')} label="Watcher mode"
              description="Re-run on a schedule and add only new results to the table." />
            {schedule && (
              <>
                <Select value={schedule} onChange={(e) => setSchedule(e.target.value as any)} className="w-48">
                  <option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option>
                </Select>
                <Toggle checked={alerts.slack} onChange={(v) => setAlerts((a) => ({ ...a, slack: v }))} label="Slack alert on new results" description="Uses the Slack webhook or bot token from Integrations." />
                {alerts.slack && <Input placeholder="#channel (optional, needs a bot token)" value={alerts.slack_channel} onChange={(e) => setAlerts((a) => ({ ...a, slack_channel: e.target.value }))} />}
                <Field label="Webhook URL (optional)" hint="POSTed with the new results after each run."><Input placeholder="https://…" value={alerts.webhook_url} onChange={(e) => setAlerts((a) => ({ ...a, webhook_url: e.target.value }))} /></Field>
              </>
            )}
          </div>
        )}

        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
          <Button onClick={onClose}>Cancel</Button>
          {sends && <Button loading={create.isPending && create.variables === false} onClick={() => create.mutate(false)}>Save as draft</Button>}
          <Button variant="primary" loading={create.isPending && create.variables === true} onClick={() => create.mutate(true)}>{sends ? 'Start now' : 'Create & run'}</Button>
        </div>
      </div>
    </Drawer>
  );
}

function FieldInput({ field: f, value, onChange, aiInstructions }: { field: PhantomField; value: any; onChange: (v: any) => void; aiInstructions?: string }) {
  const label = <>{f.label}{f.required && <span className="text-red-500"> *</span>}</>;
  switch (f.type) {
    case 'boolean':
      return <Toggle checked={!!value} onChange={onChange} label={f.label} description={f.help} />;
    case 'select':
      return (
        <Field label={label} hint={f.help}>
          <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
      );
    case 'number':
      return <Field label={label} hint={f.help}><Input type="number" min={f.min} max={f.max} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="w-40" /></Field>;
    case 'textarea':
      return <Field label={label} hint={f.help}><Textarea rows={3} placeholder={f.placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
    case 'template':
      return <TemplateInput field={f} value={value ?? ''} onChange={onChange} aiInstructions={aiInstructions} />;
    default:
      return <Field label={label} hint={f.help}><Input type={f.type === 'url' ? 'url' : 'text'} placeholder={f.placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
}

const SAMPLE_PROFILE = { firstName: 'Alex', lastName: 'Rivera', fullName: 'Alex Rivera', company: 'Northwind', title: 'Head of Growth', location: 'Austin, Texas', headline: 'Head of Growth at Northwind' };

/** Template textarea with a live preview rendered by the server (variables, spintax, AI line). */
export function TemplateInput({ field: f, value, onChange, aiInstructions, label }: { field: Pick<PhantomField, 'label' | 'help' | 'placeholder' | 'max' | 'required'>; value: string; onChange: (v: string) => void; aiInstructions?: string; label?: string }) {
  const [preview, setPreview] = useState<{ text: string; missing: string[]; ai_used: boolean } | null>(null);
  const [aiPreview, setAiPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const usesAi = /\{ai_message\}/i.test(value);
  useEffect(() => {
    if (!value.trim()) { setPreview(null); return; }
    const t = setTimeout(() => {
      // AI previews cost a call; only when asked.
      const tpl = usesAi && !aiPreview ? value.replace(/\{ai_message\}/gi, '[AI-written line]') : value;
      setLoading(true);
      api.post<{ data: { text: string; missing: string[]; ai_used: boolean } }>('/api/automations/preview-message', { template: tpl, profile: SAMPLE_PROFILE, ai_instructions: aiInstructions || undefined })
        .then((r) => setPreview(r.data)).catch(() => setPreview(null)).finally(() => setLoading(false));
    }, 400);
    return () => clearTimeout(t);
  }, [value, aiPreview, aiInstructions, usesAi]);
  const over = !!f.max && value.length > f.max;
  return (
    <Field label={<>{label ?? f.label}{f.required && <span className="text-red-500"> *</span>}</>} hint={f.help}>
      <Textarea rows={4} placeholder={f.placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-[13px]" />
      <div className="mt-1 flex items-center justify-between text-[11.5px] text-zinc-400">
        <span>{usesAi && <button type="button" onClick={(e) => { e.preventDefault(); setAiPreview((v) => !v); }} className="inline-flex items-center gap-1 text-zinc-600 hover:text-zinc-900"><Eye className="size-3" />{aiPreview ? 'Hide AI preview' : 'Preview AI line'}</button>}</span>
        {f.max ? <span className={cx(over && 'text-red-600')}>{value.length} / {f.max}</span> : null}
      </div>
      {preview && (
        <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[13px] text-zinc-700">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Preview for {SAMPLE_PROFILE.fullName}{loading && ' …'}</div>
          <div className="whitespace-pre-wrap">{preview.text}</div>
          {preview.missing.length > 0 && <div className="mt-1 text-[12px] text-amber-700">Unknown variables: {preview.missing.join(', ')}</div>}
        </div>
      )}
    </Field>
  );
}

function TablePicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const tables = useTables();
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Choose a table…</option>
      {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.row_count})</option>)}
    </Select>
  );
}

export function TargetsInput({ field, value, onChange }: { field: Pick<PhantomField, 'label' | 'placeholder' | 'help' | 'required'>; value: Targets; onChange: (t: Targets) => void }) {
  const cols = useTableColumns(value.mode === 'table' ? value.table_id : null);
  const count = useMemo(() => (value.mode === 'urls' ? splitLines(value.text).length : 0), [value]);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">{field.label}{field.required && <span className="text-red-500"> *</span>}</span>
        <div className="flex gap-1 text-[12px]">
          {(['urls', 'table'] as const).map((m) => (
            <button key={m} type="button" onClick={() => onChange(m === 'urls' ? { mode: 'urls', text: '' } : { mode: 'table', table_id: null, column: '' })}
              className={cx('rounded-md px-2 py-0.5', value.mode === m ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>
              {m === 'urls' ? 'Paste URLs' : 'From a table'}
            </button>
          ))}
        </div>
      </div>
      {value.mode === 'urls' ? (
        <>
          <Textarea rows={5} placeholder={field.placeholder} value={value.text} onChange={(e) => onChange({ mode: 'urls', text: e.target.value })} className="font-mono text-[12.5px]" />
          <div className="mt-1 text-xs text-slate-500">{count ? `${count} URL${count === 1 ? '' : 's'}` : field.help}</div>
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <TablePicker value={value.table_id} onChange={(id) => onChange({ mode: 'table', table_id: id, column: '' })} />
          <Select value={value.column} disabled={!value.table_id} onChange={(e) => onChange({ ...value, column: e.target.value })}>
            <option value="">Column…</option>
            {(cols.data ?? []).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </Select>
          <div className="col-span-2 text-xs text-slate-500">Every non-empty value in the column becomes a target; the row's other columns are available as template variables.</div>
        </div>
      )}
    </div>
  );
}
