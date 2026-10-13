import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Braces, ChevronDown, Clock, CornerDownRight, Eye, Plus, Save, Send, Trash2, Trophy, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { useAuth } from '../../lib/auth.tsx';
import { Alert, Badge, Button, Card, Field, Input, Loading, Modal, Popover, Select, Textarea, Toggle, cx, useUi } from '../../components/ui.tsx';
import { AB_DEFAULTS, type Action, type Campaign, type Step, type Variant, variantLetter } from './types.ts';
import { RuleSummary, StepRulesEditor } from './StepRules.tsx';
import { AbTestPanel } from './AbTestPanel.tsx';
import { EmailHtml } from '../inbox/shared.tsx';

const BUILTINS = [
  ['FIRST_NAME', 'First name'], ['LAST_NAME', 'Last name'], ['EMAIL', 'Email'], ['COMPANY', 'Company'], ['TITLE', 'Title'],
  ['SENDER_NAME', 'Sender name'], ['SENDER_FIRST_NAME', 'Sender first name'], ['SIGNATURE', 'Sender signature'], ['UNSUBSCRIBE_LINK', 'Unsubscribe link'],
] as const;

const varKey = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

const emptyStep = (order: number): Step => ({ email_subject: '', email_body: '', wait_in_days: order === 1 ? 0 : 2, thread_reply: order > 1, active: true, variants: [] });

function getVariant(step: Step, vi: number): Variant {
  return vi === 0 ? step : step.variants[vi - 1]!;
}

function VariablePicker({ onPick }: { onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const vars = useQuery({ queryKey: ['custom-variables'], queryFn: () => api.get('/api/custom-variables').then((r) => r.data as { id: number; name: string }[]) });
  const closeMenu = useCallback(() => setOpen(false), []);
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" icon={<Braces className="size-3.5" />} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)}>
        Insert variable <ChevronDown className="size-3.5" />
      </Button>
      <Popover anchor={ref.current} open={open} onClose={closeMenu} align="right" className="max-h-80 w-60 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg scroll-thin">
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Lead & sender</div>
          {BUILTINS.map(([k, label]) => (
            <button key={k} onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(k); setOpen(false); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span className="text-slate-700">{label}</span><code className="text-[11px] text-slate-400">{`{${k}}`}</code>
            </button>
          ))}
          {!!vars.data?.length && <div className="mt-1 border-t border-slate-100 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Custom variables</div>}
          {vars.data?.map((v) => (
            <button key={v.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(varKey(v.name)); setOpen(false); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span className="truncate text-slate-700">{v.name}</span><code className="ml-2 text-[11px] text-slate-400">{`{${varKey(v.name)}}`}</code>
            </button>
          ))}
      </Popover>
    </div>
  );
}

type Issue = { code: string; message: string; excerpt?: string };

function Preview({ campaign, step, stepIndex, variant, previousSubject }: { campaign: Campaign; step: Step; stepIndex: number; variant: Variant; previousSubject: string }) {
  const [data, setData] = useState<{ subject: string; text: string; html: string | null; missing_variables: string[]; errors?: Issue[]; warnings?: Issue[]; lead: { email: string } } | null>(null);
  const [error, setError] = useState('');
  const threaded = stepIndex > 0 && step.thread_reply;
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await api.post(`/api/campaigns/${campaign.id}/preview`, { email_subject: threaded ? previousSubject : variant.email_subject, email_body: variant.email_body, thread_reply: !!threaded, step_order: stepIndex + 1 });
        setData(r.data);
        setError('');
      } catch (e) {
        setError(errorMessage(e));
      }
    }, 450);
    return () => clearTimeout(t);
  }, [campaign.id, variant.email_subject, variant.email_body, threaded, previousSubject, stepIndex]);

  return (
    <Card title={<span className="flex items-center gap-2"><Eye className="size-4 text-slate-400" />Preview</span>} description={data ? `As ${data.lead.email} would see it` : 'Rendered with a real lead from this campaign'}>
      {error ? <Alert tone="red">{error}</Alert> : !data ? <Loading label="Rendering…" /> : (
        <div className="space-y-3">
          {data.missing_variables.length > 0 && (
            <Alert tone="yellow" title="Unknown variables">
              {data.missing_variables.map((v) => `{${v}}`).join(', ')} won't be replaced, so emails to leads without them are held back. Add a fallback like {'{'}{data.missing_variables[0]}|there{'}'} or check the spelling.
            </Alert>
          )}
          {!!data.errors?.length && <Alert tone="red" title="This email won't be sent">{data.errors.map((e) => e.message).join(' ')}</Alert>}
          {!!data.warnings?.length && (
            <Alert tone="yellow" title="Pre-send check">
              <ul className="list-disc pl-4">{data.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
            </Alert>
          )}
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Subject</div>
            <div className="mt-1 text-sm font-medium text-slate-900">{threaded ? `Re: ${data.subject || previousSubject}` : data.subject || <span className="text-slate-400">No subject</span>}</div>
          </div>
          <div className="border-t border-slate-100 pt-3">
            {data.html && data.text.trim() ? <EmailHtml html={data.html} collapseQuotes={false} />
              : <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{data.text || <span className="text-slate-400">Start writing to see a preview.</span>}</div>}
            {threaded && <div className="mt-3 border-l-2 border-slate-200 pl-3 text-xs text-slate-400">Previous email quoted below, as in a normal reply.</div>}
          </div>
        </div>
      )}
    </Card>
  );
}

function TestEmailModal({ campaign, stepId, onClose }: { campaign: Campaign; stepId: number; onClose: () => void }) {
  const { me } = useAuth();
  const { toast } = useUi();
  const [to, setTo] = useState(me?.email ?? '');
  const [sender, setSender] = useState('');
  const senders = useQuery({
    queryKey: ['campaign', campaign.id, 'test-senders'],
    queryFn: async () => {
      const attached = (await api.get(`/api/campaigns/${campaign.id}/sender-emails`)).data as { id: number; email: string; status: string }[];
      if (attached.length) return attached;
      return (await api.get('/api/sender-emails')).data as { id: number; email: string; status: string }[];
    },
  });
  useEffect(() => { if (!sender && senders.data?.[0]) setSender(String(senders.data[0].id)); }, [senders.data, sender]);
  const send = useMutation({
    mutationFn: () => api.post(`/api/campaigns/sequence-steps/${stepId}/test-email`, { sender_email_id: Number(sender), to_email: to }),
    onSuccess: () => { toast(`Test email sent to ${to}`); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open onClose={onClose} title="Send a test email" description="Uses sample lead data. The subject is prefixed with [Test]." size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send className="size-4" />} disabled={!sender || !to} loading={send.isPending} onClick={() => send.mutate()}>Send test</Button></>}>
      <div className="space-y-4">
        {senders.data && senders.data.length === 0 && <Alert tone="yellow">Connect a sender email first.</Alert>}
        <Field label="Send from">
          <Select value={sender} onChange={(e) => setSender(e.target.value)}>
            {senders.data?.map((s) => <option key={s.id} value={s.id}>{s.email}{s.status !== 'Connected' ? ` (${s.status})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Send to"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function SequenceTab({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const seq = useQuery({ queryKey: ['campaign', campaign.id, 'sequence'], queryFn: () => api.get(`/api/campaigns/${campaign.id}/sequence`).then((r) => r.data as { title: string; steps: Step[] }) });
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [si, setSi] = useState(0);
  const [vi, setVi] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [testStep, setTestStep] = useState<number | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'subject' | 'body'>('body');

  useEffect(() => {
    if (seq.data && !steps) setSteps(seq.data.steps.length ? seq.data.steps : [emptyStep(1)]);
  }, [seq.data, steps]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (payload: Step[]) => api.put(`/api/campaigns/${campaign.id}/sequence`, { steps: payload }),
    onSuccess: (r) => {
      setSteps(r.data.steps);
      setDirty(false);
      qc.setQueryData(['campaign', campaign.id, 'sequence'], r.data);
      qc.invalidateQueries({ queryKey: ['campaign', campaign.id] });
      toast('Sequence saved');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (seq.isLoading || !steps) return <Loading />;

  const step = steps[si] ?? steps[0]!;
  const vIndex = Math.min(vi, step.variants.length);
  const variant = getVariant(step, vIndex);
  const threaded = si > 0 && step.thread_reply;
  const previousSubject = (() => {
    for (let i = si - 1; i >= 0; i--) if (!(i > 0 && steps[i]!.thread_reply)) return steps[i]!.email_subject;
    return '';
  })();
  const allInactive = [step, ...step.variants].every((v) => !v.active);

  const update = (fn: (draft: Step[]) => void) => {
    setSteps((prev) => {
      const draft: Step[] = structuredClone(prev!);
      fn(draft);
      return draft;
    });
    setDirty(true);
  };
  const updateVariant = (patch: Partial<Variant>) => update((d) => {
    const s = d[si]!;
    if (vIndex === 0) Object.assign(s, patch);
    else Object.assign(s.variants[vIndex - 1]!, patch);
  });
  const updateStep = (patch: Partial<Step>) => update((d) => Object.assign(d[si]!, patch));

  const insertVar = (key: string) => {
    const token = `{${key}}`;
    const target = lastField.current === 'subject' && !threaded ? subjectRef.current : bodyRef.current;
    const field = target === subjectRef.current ? 'email_subject' : 'email_body';
    const value = variant[field];
    const start = target?.selectionStart ?? value.length;
    const end = target?.selectionEnd ?? value.length;
    updateVariant({ [field]: value.slice(0, start) + token + value.slice(end) });
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const addStep = () => {
    update((d) => { d.push(emptyStep(d.length + 1)); });
    setSi(steps.length);
    setVi(0);
  };
  const removeStep = async (i: number) => {
    if (steps.length === 1) return;
    if (!(await confirm({ title: `Delete step ${i + 1}?`, message: 'Leads who have not reached this step will skip it. Changes apply when you save.', confirmLabel: 'Delete step', danger: true }))) return;
    update((d) => {
      d.splice(i, 1);
      // Keep "go to step N" targets pointing at the same emails; jumps to the deleted step continue instead.
      const fix = (a: Action): Action => (a.type !== 'jump' ? a : a.step === i + 1 ? { type: 'continue' } : a.step > i + 1 ? { ...a, step: a.step - 1 } : a);
      for (const s of d) if (s.branching) s.branching = { ...s.branching, else: fix(s.branching.else), rules: s.branching.rules.map((r) => ({ ...r, then: fix(r.then) })) };
    });
    setSi(Math.max(0, i - 1));
    setVi(0);
  };
  const addVariant = () => {
    update((d) => {
      const s = d[si]!;
      s.variants.push({ email_subject: s.email_subject, email_body: s.email_body, active: true });
      if (!s.ab_test) s.ab_test = { ...AB_DEFAULTS };
    });
    setVi(step.variants.length + 1);
  };
  const removeVariant = async () => {
    if (vIndex === 0) return;
    if (!(await confirm({ title: `Delete variant ${variantLetter(vIndex)}?`, confirmLabel: 'Delete', danger: true }))) return;
    update((d) => { d[si]!.variants.splice(vIndex - 1, 1); });
    setVi(vIndex - 1);
  };

  const onSave = () => save.mutate(steps);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          {steps.length} step{steps.length === 1 ? '' : 's'} · each lead gets them in order and stops when they reply.
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="flex items-center gap-1 text-xs font-medium text-amber-600"><span className="size-1.5 rounded-full bg-amber-500" />Unsaved changes</span>}
          {dirty && <Button variant="ghost" onClick={() => { setSteps(null); setDirty(false); setSi(0); setVi(0); }}>Discard</Button>}
          <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={onSave}>Save sequence</Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,380px)]">
        {/* Steps list */}
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i}>
              {i > 0 && (
                <div className="flex items-center gap-1.5 py-1.5 pl-4 text-xs text-slate-500">
                  <Clock className="size-3.5" /> Wait {s.wait_in_days} day{s.wait_in_days === 1 ? '' : 's'}
                </div>
              )}
              <button
                onClick={() => { setSi(i); setVi(0); }}
                className={cx('w-full rounded-xl border px-4 py-3 text-left transition-colors', i === si ? 'border-brand-500 bg-white ring-1 ring-brand-500' : 'border-slate-200 bg-white hover:bg-slate-50')}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900">Step {i + 1}</span>
                  <span className="flex gap-1">
                    {i > 0 && s.thread_reply && <Badge tone="blue">Reply</Badge>}
                    {s.variants.length > 0 && <Badge tone="purple">{s.variants.length + 1} variants</Badge>}
                  </span>
                </div>
                <div className="mt-1 truncate text-[13px] text-slate-500">
                  {i > 0 && s.thread_reply ? <span className="flex items-center gap-1"><CornerDownRight className="size-3" />Same thread</span> : s.email_subject || <span className="italic text-slate-400">No subject</span>}
                </div>
                <RuleSummary branching={s.branching} />
              </button>
            </div>
          ))}
          <Button className="mt-2 w-full" icon={<Plus className="size-4" />} onClick={addStep}>Add step</Button>
        </div>

        {/* Editor */}
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex flex-wrap items-center gap-1">
              {[step, ...step.variants].map((v, i) => (
                <button key={i} onClick={() => setVi(i)} className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium', i === vIndex ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100', !v.active && 'line-through opacity-60')}>
                  Variant {variantLetter(i)}{!!v.id && step.ab_winner_step_id === v.id && <Trophy className="size-3.5 text-amber-500" />}
                </button>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={addVariant} title="A/B test this step">Add variant</Button>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" icon={<Send className="size-3.5" />} disabled={!variant.id || dirty} title={!variant.id || dirty ? 'Save first' : undefined} onClick={() => setTestStep(variant.id!)}>Send test</Button>
              {vIndex > 0 && <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={removeVariant}>Delete variant</Button>}
              {steps.length > 1 && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => removeStep(si)}>Delete step</Button>}
            </div>
          </div>

          <div className="space-y-4 p-5">
            {si > 0 && (
              <div className="grid gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-2">
                <Field label="Wait before sending" hint="Calendar days after the previous step, in the campaign timezone.">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0} max={365} className="w-24" value={step.wait_in_days} onChange={(e) => updateStep({ wait_in_days: Math.max(0, Number(e.target.value) || 0) })} />
                    <span className="text-sm text-slate-600">days</span>
                  </div>
                </Field>
                <div className="pt-1">
                  <Toggle checked={step.thread_reply} onChange={(v) => updateStep({ thread_reply: v })} label="Reply in the same thread" description="Sends as “Re:” to the previous email, quoting it." />
                </div>
              </div>
            )}

            {step.variants.length > 0 && (
              <Toggle checked={variant.active} onChange={(v) => updateVariant({ active: v })} label={`Variant ${variantLetter(vIndex)} active`} description="Leads are split evenly across active variants. Compare them in Stats." />
            )}
            {allInactive && <Alert tone="yellow">All variants of this step are off — leads will skip this step.</Alert>}

            <Field label="Subject">
              {threaded ? (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-sm text-slate-500">
                  Re: {previousSubject || 'previous subject'}
                </div>
              ) : (
                <Input ref={subjectRef} value={variant.email_subject} onFocus={() => (lastField.current = 'subject')} onChange={(e) => updateVariant({ email_subject: e.target.value })} placeholder="{Quick|Short} question, {FIRST_NAME}" />
              )}
            </Field>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Body</span>
                <VariablePicker onPick={insertVar} />
              </div>
              <Textarea
                ref={bodyRef}
                rows={14}
                value={variant.email_body}
                onFocus={() => (lastField.current = 'body')}
                onChange={(e) => updateVariant({ email_body: e.target.value })}
                placeholder={'Hi {FIRST_NAME},\n\nI noticed {COMPANY} is hiring SDRs…\n\n{SENDER_FIRST_NAME}'}
                className="min-h-72"
              />
              <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-slate-400" />
                <span>
                  <code className="rounded bg-slate-100 px-1">{'{FIRST_NAME}'}</code> inserts lead data, <code className="rounded bg-slate-100 px-1">{'{FIRST_NAME|there}'}</code> adds a fallback,
                  {' '}<code className="rounded bg-slate-100 px-1">{'{Hi|Hello|Hey}'}</code> picks one option per lead. Your mailbox signature is added automatically unless you place <code className="rounded bg-slate-100 px-1">{'{SIGNATURE}'}</code>.
                  {' '}Format with Markdown: <code className="rounded bg-slate-100 px-1">**bold**</code>, <code className="rounded bg-slate-100 px-1">_italic_</code>, <code className="rounded bg-slate-100 px-1">[link](https://…)</code>, <code className="rounded bg-slate-100 px-1">- list</code>
                  {campaign.plain_text ? ' (this campaign sends plain text, so the formatting is left out; turn off "Send as plain text" in Settings to keep it).' : '.'}
                </span>
              </p>
            </div>

            {step.variants.length > 0 && (
              <AbTestPanel campaign={campaign} stepId={step.id} config={step.ab_test} onConfig={(c) => updateStep({ ab_test: c })} dirty={dirty}
                onChanged={() => { setSteps(null); setDirty(false); qc.invalidateQueries({ queryKey: ['campaign', campaign.id, 'sequence'] }); }} />
            )}
            <StepRulesEditor campaign={campaign} branching={step.branching} onChange={(b) => updateStep({ branching: b })}
              stepIndex={si} stepCount={steps.length} nextWait={steps[si + 1]?.wait_in_days ?? null} />
          </div>
        </Card>

        {/* Preview */}
        <div className="lg:col-span-2 xl:col-span-1">
          <Preview campaign={campaign} step={step} stepIndex={si} variant={variant} previousSubject={previousSubject} />
        </div>
      </div>

      {testStep && <TestEmailModal campaign={campaign} stepId={testStep} onClose={() => setTestStep(null)} />}
    </div>
  );
}
