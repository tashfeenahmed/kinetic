/** Sending domains on the Sender Emails page: Cloudflare DNS setup wizard, health pills and the domain drawer. */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ExternalLink, Globe, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Alert, Badge, Button, Drawer, Field, Input, Loading, Modal, Select, Textarea, Toggle, cx, useUi } from '../../components/ui.tsx';
import { BrandIcon } from '../../components/BrandIcon.tsx';
import { DnsList } from './DnsChecks.tsx';
import type { DnsCheck } from './types.ts';

export type Provider = 'google' | 'microsoft' | 'other';
export interface Setup {
  domain: string; provider: Provider; verification?: string; dkimValue?: string; dkimSelector?: string; msDkim1?: string; msDkim2?: string;
  otherMx?: string[]; otherSpfInclude?: string; dmarcPolicy: 'none' | 'quarantine' | 'reject'; dmarcReportEmail?: string;
  trackingSubdomain?: string; redirectTo?: string; replaceMx: boolean;
}
export interface Check { name: string; status: 'pass' | 'warn' | 'fail'; value: string | null; advice: string }
export interface DomainReportLite { checks: Check[]; tracking?: { host: string; ok: boolean } }
export interface DomainRow {
  id: number | null; domain: string; provider?: Provider; status: 'draft' | 'configured' | 'verified' | 'attention' | 'unmanaged';
  setup: Partial<Setup>; report: DomainReportLite | null; checked_at?: string; mailboxes: number; connected_mailboxes: number;
  last_result?: { results: Action[]; notes: string[] } | null;
}
interface Zone { id: string; name: string; status: string; name_servers: string[]; added: boolean }
interface Action { op: 'create' | 'update' | 'delete' | 'keep'; purpose: string; type: string; name: string; content: string; priority?: number; before?: string; note?: string; ok?: boolean; error?: string }

export const PROVIDERS: Record<Provider, { label: string; domain?: string; text: string }> = {
  google: { label: 'Google Workspace', domain: 'google.com', text: 'Best deliverability to Gmail. App passwords work out of the box.' },
  microsoft: { label: 'Microsoft 365', domain: 'microsoft.com', text: 'Best for reaching Outlook/enterprise inboxes. Connect with Microsoft sign-in.' },
  other: { label: 'Other provider', text: 'Zoho, Fastmail, Migadu… enter their MX and SPF values.' },
};
export const DOMAIN_STATUS: Record<DomainRow['status'], { tone: 'green' | 'blue' | 'yellow' | 'red' | 'gray'; label: string }> = {
  verified: { tone: 'green', label: 'Ready' },
  configured: { tone: 'blue', label: 'Waiting for DNS' },
  attention: { tone: 'red', label: 'Needs attention' },
  draft: { tone: 'gray', label: 'Draft' },
  unmanaged: { tone: 'gray', label: 'Not set up here' },
};

// Personal mailbox providers: their DNS isn't yours, so there is nothing to set up or check.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'mail.com', 'fastmail.com']);
export const isFreeMail = (domain: string) => FREE_MAIL.has(domain.toLowerCase());

const PILL_ORDER = ['SPF', 'DKIM', 'DMARC', 'MX'] as const;
const PILL = {
  pass: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  fail: 'bg-red-50 text-red-700',
  none: 'bg-zinc-100 text-zinc-400',
};

/** SPF / DKIM / DMARC / MX at a glance: green passes, amber needs a look, red is broken, grey unknown. */
export function HealthPills({ checks, loading }: { checks?: Check[] | null; loading?: boolean }) {
  return (
    <span className={cx('inline-flex gap-1', loading && 'animate-pulse')}>
      {PILL_ORDER.map((n) => {
        const c = checks?.find((x) => x.name === n);
        return (
          <span key={n} title={c ? `${n}: ${c.advice}${c.value ? `\n${c.value}` : ''}` : `${n}: not checked yet`}
            className={cx('rounded px-1.5 py-px text-[10.5px] font-medium leading-4', PILL[c?.status ?? 'none'])}>{n}</span>
        );
      })}
    </span>
  );
}

function CheckIcon({ check }: { check?: Check }) {
  if (!check) return <Circle className="size-4 text-slate-300" />;
  const Icon = check.status === 'pass' ? CheckCircle2 : check.status === 'warn' ? Circle : XCircle;
  return <span title={`${check.advice}${check.value ? `\n${check.value}` : ''}`}><Icon className={cx('size-4', check.status === 'pass' ? 'text-emerald-600' : check.status === 'warn' ? 'text-amber-500' : 'text-red-500')} /></span>;
}

export function useCloudflare(enabled = true) {
  return useQuery({ queryKey: ['cloudflare'], enabled, queryFn: () => api.get('/api/domains/cloudflare').then((r) => r.data as { connected: boolean; error?: string; zones: Zone[] }) });
}

function ConnectCloudflare({ error, onConnected }: { error?: string; onConnected: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState(error ?? '');
  const save = useMutation({
    mutationFn: async () => {
      await api.put('/api/gtm/keys', { CLOUDFLARE_API_TOKEN: token.trim() });
      const t = await api.post<{ ok: boolean; detail: string }>('/api/gtm/keys/test/cloudflare');
      if (!t.ok) throw new Error(t.detail);
      return t;
    },
    onSuccess: () => { setToken(''); onConnected(); },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <div>
      <div className="flex items-center gap-2.5 text-sm font-medium text-slate-900"><BrandIcon domain="cloudflare.com" size={28} />Connect Cloudflare first</div>
      <p className="mt-2 text-[13px] text-slate-500">Kinetic writes your sending domains' DNS records through Cloudflare's API. Your domains need to use Cloudflare for DNS (free plan is fine).</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] text-slate-600">
        <li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline">Cloudflare → API Tokens <ExternalLink className="size-3" /></a> and click <b>Create Token</b> → <b>Create Custom Token</b>.</li>
        <li>Permissions: <b>Zone → DNS → Edit</b> and <b>Zone → Zone → Read</b>. To add new domains from Kinetic also add <b>Zone → Zone → Edit</b> and <b>Account → Account Settings → Read</b>; for website redirects add <b>Zone → Dynamic Redirect → Edit</b>.</li>
        <li>Zone resources: <b>All zones</b> (or the domains you'll send from). Create the token and paste it below.</li>
      </ol>
      <div className="mt-4 flex gap-2">
        <Input type="password" value={token} onChange={(e) => { setToken(e.target.value); setErr(''); }} placeholder="Cloudflare API token" className="max-w-md" />
        <Button variant="primary" loading={save.isPending} disabled={!token.trim()} onClick={() => save.mutate()}>Connect</Button>
      </div>
      {err && <div className="mt-3"><Alert tone="red">{err}</Alert></div>}
    </div>
  );
}

/**
 * Add a domain or change its DNS: pick a Cloudflare zone (or add one) → provider → details → preview → apply → checks.
 * `review` jumps straight to the DNS plan for an existing setup.
 */
export function DomainSetupModal({ initial, review, trackingTarget, onClose }: { initial?: Partial<Setup>; review?: boolean; trackingTarget: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const cf = useCloudflare();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['domains'] }); void qc.invalidateQueries({ queryKey: ['cloudflare'] }); };
  if (cf.isLoading || !cf.data?.connected) {
    return (
      <Modal open onClose={onClose} size="lg" title={initial?.domain ? `Set up ${initial.domain}` : 'Add a sending domain'} footer={<Button onClick={onClose}>Close</Button>}>
        {cf.isLoading ? <Loading label="Connecting to Cloudflare…" /> : <ConnectCloudflare error={cf.data?.error} onConnected={refresh} />}
      </Modal>
    );
  }
  return <DomainWizard zones={cf.data.zones} trackingTarget={trackingTarget} initial={initial} review={review} onClose={onClose} onDone={refresh} />;
}

const STEPS = ['Domain', 'Mailbox provider', 'Details', 'Review', 'Done'] as const;
type Step = (typeof STEPS)[number];

function DomainWizard({ zones, trackingTarget, initial, review, onClose, onDone }: { zones: Zone[]; trackingTarget: string | null; initial?: Partial<Setup>; review?: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useUi();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(initial?.domain ? (initial.provider ? 'Details' : 'Mailbox provider') : 'Domain');
  const [s, setS] = useState<Setup>({ domain: '', provider: 'google', dmarcPolicy: 'none', replaceMx: true, trackingSubdomain: trackingTarget ? 'track' : '', ...initial } as Setup);
  const [newDomain, setNewDomain] = useState('');
  const [created, setCreated] = useState<Zone | null>(null);
  const [plan, setPlan] = useState<{ actions: Action[]; notes: string[]; zone: Zone } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState('');
  const set = (p: Partial<Setup>) => setS((x) => ({ ...x, ...p }));
  const body = () => ({ ...s, otherMx: s.otherMx?.filter(Boolean), dmarcReportEmail: s.dmarcReportEmail || undefined, redirectTo: s.redirectTo || undefined, trackingSubdomain: s.trackingSubdomain || undefined });

  const addZone = useMutation({
    mutationFn: () => api.post('/api/domains/cloudflare/zones', { domain: newDomain.trim().toLowerCase() }).then((r) => r.data as Zone),
    onSuccess: (z) => { setCreated(z); set({ domain: z.name }); setNewDomain(''); void qc.invalidateQueries({ queryKey: ['cloudflare'] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const preview = useMutation({
    mutationFn: () => api.post('/api/domains/plan', body()).then((r) => r.data),
    onSuccess: (p) => { setPlan(p); setStep('Review'); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: () => api.post('/api/domains/apply', body()).then((r) => r.data),
    onSuccess: (r) => { setResult(r); setStep('Done'); onDone(); toast(`DNS for ${s.domain} updated`); },
    onError: (e) => setErr(errorMessage(e)),
  });
  useEffect(() => setErr(''), [step]);
  // "View DNS plan" opens straight on the preview of the saved setup.
  const started = useRef(false);
  useEffect(() => {
    if (review && !started.current && s.domain && s.provider) { started.current = true; preview.mutate(); }
  }, [review]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = plan?.actions.filter((a) => a.op !== 'keep').length ?? 0;
  const footer = (
    <>
      <span className="flex-1 text-left text-xs text-slate-400">Step {STEPS.indexOf(step) + 1} of {STEPS.length} · {step}</span>
      {step === 'Domain' && <Button variant="primary" disabled={!s.domain} onClick={() => setStep('Mailbox provider')}>Continue</Button>}
      {step === 'Mailbox provider' && <><Button onClick={() => setStep('Domain')}>Back</Button><Button variant="primary" onClick={() => setStep('Details')}>Continue</Button></>}
      {step === 'Details' && <><Button onClick={() => setStep('Mailbox provider')}>Back</Button><Button variant="primary" loading={preview.isPending} onClick={() => preview.mutate()}>Preview changes</Button></>}
      {step === 'Review' && <><Button onClick={() => setStep('Details')}>Back</Button><Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>{changes ? `Apply ${changes} change${changes === 1 ? '' : 's'}` : 'Re-check DNS'}</Button></>}
      {step === 'Done' && <Button variant="primary" onClick={onClose}>Done</Button>}
    </>
  );

  return (
    <Modal open onClose={onClose} size="xl" title={s.domain ? `Set up ${s.domain}` : 'Add a sending domain'} description="Kinetic writes the DNS records to Cloudflare. Nothing changes until you apply." footer={footer}>
      {err && <div className="mb-4"><Alert tone="red">{err}</Alert></div>}

      {review && step === 'Details' && preview.isPending ? <Loading label="Building the DNS plan…" /> : <>
      {step === 'Domain' && (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-slate-700">Domains in your Cloudflare account</div>
            {zones.length === 0 && <p className="text-sm text-slate-500">None yet — add one below.</p>}
            <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
              {zones.map((z) => (
                <button key={z.id} onClick={() => set({ domain: z.name })} className={cx('flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm', s.domain === z.name ? 'border-zinc-900 ring-1 ring-zinc-900' : 'border-slate-200 hover:border-slate-300')}>
                  <span className="font-medium text-slate-900">{z.name}</span>
                  <span className="flex gap-1.5">{z.added && <Badge tone="blue">in Kinetic</Badge>}{z.status !== 'active' && <Badge tone="yellow">{z.status}</Badge>}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-dashed border-slate-300 p-4">
            <div className="text-sm font-medium text-slate-700">Add a new domain to Cloudflare</div>
            <p className="mt-0.5 text-[13px] text-slate-500">Bought it elsewhere (Namecheap, GoDaddy…)? Kinetic adds it to Cloudflare, then you switch its nameservers at your registrar.</p>
            <div className="mt-3 flex gap-2">
              <Input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="getacme.com" className="max-w-xs" onKeyDown={(e) => e.key === 'Enter' && newDomain.trim() && addZone.mutate()} />
              <Button loading={addZone.isPending} disabled={!newDomain.trim()} onClick={() => addZone.mutate()}>Add to Cloudflare</Button>
            </div>
            {created && (
              <div className="mt-3"><Alert tone="yellow" title={`${created.name} added to Cloudflare`}>
                At your registrar, change the nameservers to {created.name_servers.length ? created.name_servers.map((n, i) => <span key={n}>{i > 0 && ' and '}<b className="font-mono">{n}</b></span>) : 'the ones shown in Cloudflare'}. Records can be set up now; they go live once the switch completes (usually under an hour).
              </Alert></div>
            )}
          </div>
        </div>
      )}

      {step === 'Mailbox provider' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
            <button key={p} onClick={() => set({ provider: p })} className={cx('rounded-xl border p-4 text-left', s.provider === p ? 'border-zinc-900 ring-1 ring-zinc-900' : 'border-slate-200 hover:border-slate-300')}>
              <BrandIcon domain={PROVIDERS[p].domain} fallback={<Globe className="size-4" />} size={32} />
              <div className="mt-2.5 text-sm font-semibold text-slate-900">{PROVIDERS[p].label}</div>
              <div className="mt-0.5 text-[13px] text-slate-500">{PROVIDERS[p].text}</div>
            </button>
          ))}
        </div>
      )}

      {step === 'Details' && (
        <div className="space-y-5">
          <Alert tone="blue">
            Two values only exist in your {s.provider === 'microsoft' ? 'Microsoft 365' : s.provider === 'google' ? 'Google Workspace' : 'provider'} admin: the <b>verification code</b> and the <b>DKIM key</b>. Paste them below — or leave them empty, apply the rest now, and come back with “Edit setup”.
          </Alert>
          {s.provider === 'google' && (
            <>
              <Field label="Domain verification (optional)" hint="Google Admin → Account → Domains → Manage domains → Add a domain → verify with a TXT record. Paste the whole value.">
                <Input value={s.verification ?? ''} onChange={(e) => set({ verification: e.target.value })} placeholder="google-site-verification=…" />
              </Field>
              <Field label="DKIM key" hint="Google Admin → Apps → Google Workspace → Gmail → Authenticate email → Generate new record (2048-bit). Paste the TXT value, apply, then click “Start authentication” in Google.">
                <Textarea rows={3} value={s.dkimValue ?? ''} onChange={(e) => set({ dkimValue: e.target.value })} placeholder="v=DKIM1; k=rsa; p=MIIBIjANBgkq…" className="font-mono text-xs" />
              </Field>
            </>
          )}
          {s.provider === 'microsoft' && (
            <>
              <Field label="Domain verification (optional)" hint="Microsoft 365 admin center → Settings → Domains → Add domain → TXT record value.">
                <Input value={s.verification ?? ''} onChange={(e) => set({ verification: e.target.value })} placeholder="MS=ms12345678" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="DKIM selector1 CNAME target" hint="Microsoft Defender → Email & collaboration → Policies → Email authentication settings → DKIM → your domain.">
                  <Input value={s.msDkim1 ?? ''} onChange={(e) => set({ msDkim1: e.target.value })} placeholder="selector1-getacme-com._domainkey.tenant.onmicrosoft.com" />
                </Field>
                <Field label="DKIM selector2 CNAME target">
                  <Input value={s.msDkim2 ?? ''} onChange={(e) => set({ msDkim2: e.target.value })} placeholder="selector2-getacme-com._domainkey.tenant.onmicrosoft.com" />
                </Field>
              </div>
            </>
          )}
          {s.provider === 'other' && (
            <>
              <Field label="MX records" hint="One per line: priority and host, as your provider lists them.">
                <Textarea rows={3} value={(s.otherMx ?? []).join('\n')} onChange={(e) => set({ otherMx: e.target.value.split('\n') })} placeholder={'10 mx.zoho.com\n20 mx2.zoho.com'} className="font-mono text-xs" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <Field label="SPF include"><Input value={s.otherSpfInclude ?? ''} onChange={(e) => set({ otherSpfInclude: e.target.value })} placeholder="zoho.com" /></Field>
                <Field label="DKIM selector"><Input value={s.dkimSelector ?? ''} onChange={(e) => set({ dkimSelector: e.target.value })} placeholder="default" /></Field>
              </div>
              <Field label="DKIM key"><Textarea rows={2} value={s.dkimValue ?? ''} onChange={(e) => set({ dkimValue: e.target.value })} placeholder="v=DKIM1; k=rsa; p=…" className="font-mono text-xs" /></Field>
              <Field label="Domain verification (optional)"><Input value={s.verification ?? ''} onChange={(e) => set({ verification: e.target.value })} /></Field>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="DMARC policy" hint="Start with “none” (monitor only); tighten once everything passes.">
              <Select value={s.dmarcPolicy} onChange={(e) => set({ dmarcPolicy: e.target.value as Setup['dmarcPolicy'] })}>
                <option value="none">none — monitor</option><option value="quarantine">quarantine — spam folder</option><option value="reject">reject — block</option>
              </Select>
            </Field>
            <Field label="DMARC reports to (optional)"><Input value={s.dmarcReportEmail ?? ''} onChange={(e) => set({ dmarcReportEmail: e.target.value })} placeholder="dmarc@yourcompany.com" /></Field>
            <Field label="Tracking subdomain (optional)" hint={trackingTarget ? `Points ${s.trackingSubdomain || 'track'}.${s.domain} at ${trackingTarget} for open/click tracking.` : 'Needs a public PUBLIC_URL; skipped while Kinetic runs on localhost.'}>
              <Input value={s.trackingSubdomain ?? ''} onChange={(e) => set({ trackingSubdomain: e.target.value })} placeholder="track" disabled={!trackingTarget} />
            </Field>
            <Field label="Redirect the website to (optional)" hint="Visitors to this domain land on your real site.">
              <Input value={s.redirectTo ?? ''} onChange={(e) => set({ redirectTo: e.target.value })} placeholder="https://yourcompany.com" />
            </Field>
          </div>
          <Toggle checked={s.replaceMx} onChange={(v) => set({ replaceMx: v })} label="Replace other mail servers" description="Remove MX records that don't belong to the provider you picked (recommended for a dedicated sending domain)." />
        </div>
      )}

      {step === 'Review' && plan && (
        <div className="space-y-4">
          {plan.zone.status !== 'active' && <Alert tone="yellow">This domain isn't active on Cloudflare yet. Switch its nameservers to {plan.zone.name_servers.join(' and ')} at your registrar.</Alert>}
          {changes === 0 && <Alert tone="green">Everything is already set up — nothing to change.</Alert>}
          <ActionsTable actions={plan.actions} />
          {plan.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-600">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </div>
      )}

      {step === 'Done' && result && (
        <div className="space-y-4">
          {result.results.some((x: Action) => !x.ok)
            ? <Alert tone="red" title="Some records couldn't be written">Check the errors below — usually a token permission. Fix it and apply again.</Alert>
            : <Alert tone="green" title="DNS updated">Records are live on Cloudflare. Mailbox providers usually see them within minutes.</Alert>}
          <ActionsTable actions={result.results} />
          {result.report && (
            <div className="grid gap-2 sm:grid-cols-4">
              {result.report.checks.map((c: Check) => (
                <div key={c.name} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900"><CheckIcon check={c} />{c.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{c.status === 'pass' ? 'Passing' : c.advice}</div>
                </div>
              ))}
            </div>
          )}
          {result.notes?.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-600">{result.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>}
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
            <div className="font-medium text-slate-900">Next</div>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5">
              <li>Create 2–3 mailboxes on {s.domain} in {s.provider === 'microsoft' ? 'Microsoft 365' : s.provider === 'google' ? 'Google Workspace' : 'your provider'}{s.dkimValue || s.msDkim1 ? ' and turn DKIM signing on' : ''}.</li>
              <li>Connect them here with <b>Add email account</b>, then turn on <Link to="/warmup" className="text-brand-600 hover:underline">warmup</Link> for 2–4 weeks before sending.</li>
            </ol>
          </div>
        </div>
      )}
      </>}
    </Modal>
  );
}

export function ActionsTable({ actions }: { actions: Action[] }) {
  const tone = { create: 'green', update: 'yellow', delete: 'red', keep: 'gray' } as const;
  const label = { create: 'Add', update: 'Change', delete: 'Remove', keep: 'Keep' } as const;
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2">Action</th><th className="px-3 py-2">Record</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Value</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {actions.map((a, i) => (
            <tr key={i} className={a.op === 'keep' ? 'text-slate-400' : 'text-slate-700'}>
              <td className="px-3 py-2 align-top">
                <Badge tone={tone[a.op]}>{label[a.op]}</Badge>
                {a.ok === false && <div className="mt-1 max-w-[180px] text-xs text-red-600">{a.error}</div>}
                {a.ok === true && a.op !== 'keep' && <div className="mt-1 text-xs text-emerald-600">done</div>}
              </td>
              <td className="px-3 py-2 align-top"><div className="font-medium">{a.type}</div><div className="text-xs text-slate-400">{a.purpose}</div></td>
              <td className="px-3 py-2 align-top font-mono text-xs">{a.name}</td>
              <td className="max-w-[360px] break-all px-3 py-2 align-top font-mono text-xs">
                {a.priority != null && `${a.priority} `}{a.content}
                {a.before && <div className="mt-0.5 text-slate-400 line-through">{a.before}</div>}
                {a.note && <div className="mt-0.5 font-sans text-slate-400">{a.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Domain detail: DNS check results, the records Kinetic wrote, and the saved setup. */
export function DomainDrawer({ domain, report, checking, onClose, onCheck, onSetup, onReview, onRemove }: {
  domain: DomainRow | null; report: DomainReportLite | null; checking: boolean; onClose: () => void;
  onCheck: () => void; onSetup: () => void; onReview: () => void; onRemove: () => void;
}) {
  if (!domain) return null;
  const managed = domain.id != null;
  const free = isFreeMail(domain.domain);
  const written = domain.last_result?.results.filter((a) => a.op !== 'keep') ?? [];
  const setup = domain.setup;
  return (
    <Drawer open onClose={onClose} width="max-w-2xl" title={domain.domain}
      subtitle={<span className="flex items-center gap-2">
        <Badge tone={DOMAIN_STATUS[domain.status].tone} dot>{managed ? DOMAIN_STATUS[domain.status].label : free ? 'Personal mailbox provider' : 'DNS not managed by Kinetic'}</Badge>
        <span>{domain.mailboxes} mailbox{domain.mailboxes === 1 ? '' : 'es'}{domain.provider ? ` · ${PROVIDERS[domain.provider].label}` : ''}{domain.checked_at ? ` · checked ${fmtRelative(domain.checked_at)}` : ''}</span>
      </span>}
      actions={!free && <Button size="sm" loading={checking} onClick={onCheck}>Check DNS again</Button>}>
      <div className="space-y-7">
        {free ? (
          <p className="text-[13px] text-slate-500">{domain.domain} is a personal mailbox provider. Its DNS belongs to the provider, so there is nothing to set up.</p>
        ) : (
          <section>
            <h3 className="mb-3 text-[13px] font-semibold text-slate-900">DNS checks</h3>
            {report ? <DnsList checks={report.checks as DnsCheck[]} /> : checking ? <Loading label="Checking DNS…" /> : <p className="text-[13px] text-slate-500">Not checked yet.</p>}
            {report?.tracking && <p className="mt-3 text-[13px] text-slate-600">Tracking domain <span className="font-mono">{report.tracking.host}</span>: {report.tracking.ok ? 'points at Kinetic' : 'not pointing at Kinetic yet'}</p>}
          </section>
        )}

        {managed ? (
          <>
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-slate-900">Records Kinetic wrote</h3>
                <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={onSetup}>Edit setup</Button><Button size="sm" onClick={onReview}>View DNS plan</Button></div>
              </div>
              {written.length ? <ActionsTable actions={written} /> : <p className="text-[13px] text-slate-500">Nothing written yet. Open the DNS plan to preview and apply.</p>}
              {domain.last_result?.notes?.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-slate-600">{domain.last_result.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            </section>
            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-slate-900">Setup</h3>
              <dl className="grid grid-cols-[160px_1fr] gap-y-1.5 text-[13px]">
                <dt className="text-slate-500">Mailbox provider</dt><dd className="text-slate-800">{domain.provider ? PROVIDERS[domain.provider].label : '—'}</dd>
                <dt className="text-slate-500">DMARC policy</dt><dd className="text-slate-800">{setup.dmarcPolicy ?? 'none'}{setup.dmarcReportEmail ? ` · reports to ${setup.dmarcReportEmail}` : ''}</dd>
                <dt className="text-slate-500">Tracking subdomain</dt><dd className="text-slate-800">{setup.trackingSubdomain ? `${setup.trackingSubdomain}.${domain.domain}` : '—'}</dd>
                <dt className="text-slate-500">Website redirect</dt><dd className="text-slate-800">{setup.redirectTo || '—'}</dd>
                <dt className="text-slate-500">DKIM</dt><dd className="text-slate-800">{setup.dkimValue || setup.msDkim1 ? 'Key saved' : 'Not added yet'}</dd>
              </dl>
            </section>
            <div className="border-t border-slate-100 pt-4">
              <Button size="sm" variant="ghost" className="text-red-600" onClick={onRemove}>Stop managing this domain</Button>
              <p className="mt-1 text-xs text-slate-400">Removes it from Kinetic only. DNS records stay in Cloudflare and mailboxes keep working.</p>
            </div>
          </>
        ) : !free && (
          <Alert tone="blue" title="DNS not managed by Kinetic" action={<Button size="sm" onClick={onSetup}>Set up DNS</Button>}>
            Kinetic can write MX, SPF, DKIM and DMARC for this domain through Cloudflare.
          </Alert>
        )}
      </div>
    </Drawer>
  );
}
