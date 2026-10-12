import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, ExternalLink, Globe, Plus, RefreshCw, XCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtRelative } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Menu, Modal, Select, Table, Td, Textarea, Th, Toggle, cx, useUi } from '../components/ui.tsx';
import { BrandIcon } from '../components/BrandIcon.tsx';

type Provider = 'google' | 'microsoft' | 'other';
interface Setup {
  domain: string; provider: Provider; verification?: string; dkimValue?: string; dkimSelector?: string; msDkim1?: string; msDkim2?: string;
  otherMx?: string[]; otherSpfInclude?: string; dmarcPolicy: 'none' | 'quarantine' | 'reject'; dmarcReportEmail?: string;
  trackingSubdomain?: string; redirectTo?: string; replaceMx: boolean;
}
interface Check { name: string; status: 'pass' | 'warn' | 'fail'; value: string | null; advice: string }
interface DomainRow {
  id: number | null; domain: string; provider?: Provider; status: 'draft' | 'configured' | 'verified' | 'attention' | 'unmanaged';
  setup: Partial<Setup>; report: { checks: Check[]; tracking?: { host: string; ok: boolean } } | null; checked_at?: string; mailboxes: number; connected_mailboxes: number;
}
interface Zone { id: string; name: string; status: string; name_servers: string[]; added: boolean }
interface Action { op: 'create' | 'update' | 'delete' | 'keep'; purpose: string; type: string; name: string; content: string; priority?: number; before?: string; note?: string; ok?: boolean; error?: string }

const PROVIDERS: Record<Provider, { label: string; domain?: string; text: string }> = {
  google: { label: 'Google Workspace', domain: 'google.com', text: 'Best deliverability to Gmail. App passwords work out of the box.' },
  microsoft: { label: 'Microsoft 365', domain: 'microsoft.com', text: 'Best for reaching Outlook/enterprise inboxes. Connect with Microsoft sign-in.' },
  other: { label: 'Other provider', text: 'Zoho, Fastmail, Migadu… enter their MX and SPF values.' },
};
const STATUS: Record<DomainRow['status'], { tone: 'green' | 'blue' | 'yellow' | 'red' | 'gray'; label: string }> = {
  verified: { tone: 'green', label: 'Ready' },
  configured: { tone: 'blue', label: 'Waiting for DNS' },
  attention: { tone: 'red', label: 'Needs attention' },
  draft: { tone: 'gray', label: 'Draft' },
  unmanaged: { tone: 'gray', label: 'Not set up here' },
};

export function DomainsPage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<{ data: DomainRow[]; meta: { cloudflare_connected: boolean; tracking_target: string | null } }>('/api/domains') });
  const cf = useQuery({ queryKey: ['cloudflare'], queryFn: () => api.get('/api/domains/cloudflare').then((r) => r.data as { connected: boolean; error?: string; zones: Zone[] }) });
  const [wizard, setWizard] = useState<{ initial?: Partial<Setup> } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['domains'] }); void qc.invalidateQueries({ queryKey: ['cloudflare'] }); };

  const check = useMutation({
    mutationFn: (id: number) => api.post(`/api/domains/${id}/check`),
    onSuccess: () => { toast('DNS checked'); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (d: DomainRow) => {
    if (!(await confirm({ title: `Stop managing ${d.domain}?`, message: 'It is removed from Kinetic only. Its DNS records stay in Cloudflare and its mailboxes keep working.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.del(`/api/domains/${d.id}`); toast('Domain removed'); refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const connected = !!cf.data?.connected;
  const rows = domains.data?.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Domains"
        subtitle="Sending domains for your Google Workspace and Microsoft 365 mailboxes. Kinetic writes MX, SPF, DKIM and DMARC to Cloudflare for you."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={!connected} onClick={() => setWizard({})}>Add domain</Button>}
      />

      {cf.isLoading ? <Loading /> : !connected ? <ConnectCloudflare error={cf.data?.error} onConnected={refresh} /> : (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
          <BrandIcon domain="cloudflare.com" size={28} />
          <span>Connected to Cloudflare · {cf.data!.zones.length} domain{cf.data!.zones.length === 1 ? '' : 's'} in your account</span>
          <span className="flex-1" />
          <Link to="/integrations#providers" className="text-brand-600 hover:underline">Manage token</Link>
        </div>
      )}

      <Card padded={false}>
        {domains.isLoading ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<Globe className="size-5" />} title="No sending domains yet"
            description="Use separate domains for cold email (e.g. getacme.com), never your main company domain. Add one and Kinetic configures its DNS."
            action={connected ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setWizard({})}>Add domain</Button> : undefined} />
        ) : (
          <Table>
            <thead><tr><Th>Domain</Th><Th>Mailboxes</Th><Th>MX</Th><Th>SPF</Th><Th>DKIM</Th><Th>DMARC</Th><Th>Status</Th><Th className="w-10" /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.domain} className="hover:bg-slate-50">
                  <Td>
                    <div className="flex items-center gap-2.5">
                      {d.provider ? <BrandIcon domain={PROVIDERS[d.provider].domain} fallback={<Globe className="size-3.5" />} size={26} /> : <BrandIcon fallback={<Globe className="size-3.5" />} size={26} />}
                      <div>
                        <div className="font-medium text-slate-900">{d.domain}</div>
                        <div className="text-xs text-slate-500">{d.provider ? PROVIDERS[d.provider].label : 'Mailboxes only'}{d.checked_at ? ` · checked ${fmtRelative(d.checked_at)}` : ''}</div>
                      </div>
                    </div>
                  </Td>
                  <Td><Link to="/sender-emails" className="text-slate-700 hover:text-brand-600">{d.connected_mailboxes}/{d.mailboxes}</Link></Td>
                  {(['MX', 'SPF', 'DKIM', 'DMARC'] as const).map((n) => <Td key={n}><CheckIcon check={d.report?.checks.find((c) => c.name === n)} /></Td>)}
                  <Td><Badge tone={STATUS[d.status].tone} dot>{STATUS[d.status].label}</Badge></Td>
                  <Td>
                    {d.id ? (
                      <Menu trigger={(t) => <Button size="sm" variant="ghost" onClick={t}>•••</Button>} items={[
                        { label: 'Re-check DNS', icon: <RefreshCw className="size-4" />, onClick: () => check.mutate(d.id!) },
                        { label: 'Edit setup', icon: <Globe className="size-4" />, onClick: () => setWizard({ initial: { ...d.setup, domain: d.domain } }), disabled: !connected },
                        { label: 'Remove from Kinetic', danger: true, onClick: () => remove(d) },
                      ]} />
                    ) : connected ? <Button size="sm" onClick={() => setWizard({ initial: { domain: d.domain } })}>Set up</Button> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <p className="mt-4 text-[13px] text-slate-500">
        After the DNS is set: create mailboxes in Google Workspace or Microsoft 365 → connect them in <Link to="/sender-emails" className="text-brand-600 hover:underline">Sender Emails</Link> → turn on <Link to="/warmup" className="text-brand-600 hover:underline">warmup</Link> for 2–4 weeks before sending.
      </p>

      {wizard && <DomainWizard zones={cf.data?.zones ?? []} trackingTarget={domains.data?.meta.tracking_target ?? null} initial={wizard.initial} onClose={() => setWizard(null)} onDone={refresh} />}
    </Page>
  );
}

function CheckIcon({ check }: { check?: Check }) {
  if (!check) return <Circle className="size-4 text-slate-300" />;
  const Icon = check.status === 'pass' ? CheckCircle2 : check.status === 'warn' ? Circle : XCircle;
  return <span title={`${check.advice}${check.value ? `\n${check.value}` : ''}`}><Icon className={cx('size-4', check.status === 'pass' ? 'text-emerald-600' : check.status === 'warn' ? 'text-amber-500' : 'text-red-500')} /></span>;
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
    <Card className="mb-6" title={<span className="flex items-center gap-2.5"><BrandIcon domain="cloudflare.com" size={30} />Connect Cloudflare</span>}
      description="Kinetic writes your sending domains' DNS records through Cloudflare's API. Your domains need to use Cloudflare for DNS (free plan is fine).">
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
        <li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-600 hover:underline">Cloudflare → API Tokens <ExternalLink className="size-3" /></a> and click <b>Create Token</b> → <b>Create Custom Token</b>.</li>
        <li>Permissions: <b>Zone → DNS → Edit</b> and <b>Zone → Zone → Read</b>. To add new domains from Kinetic also add <b>Zone → Zone → Edit</b> and <b>Account → Account Settings → Read</b>; for website redirects add <b>Zone → Dynamic Redirect → Edit</b>.</li>
        <li>Zone resources: <b>All zones</b> (or the domains you'll send from). Create the token and paste it below.</li>
      </ol>
      <div className="mt-4 flex gap-2 pb-5">
        <Input type="password" value={token} onChange={(e) => { setToken(e.target.value); setErr(''); }} placeholder="Cloudflare API token" className="max-w-md" />
        <Button variant="primary" loading={save.isPending} disabled={!token.trim()} onClick={() => save.mutate()}>Connect</Button>
      </div>
      {err && <div className="pb-5"><Alert tone="red">{err}</Alert></div>}
    </Card>
  );
}

const STEPS = ['Domain', 'Mailbox provider', 'Details', 'Review', 'Done'] as const;
type Step = (typeof STEPS)[number];

function DomainWizard({ zones, trackingTarget, initial, onClose, onDone }: { zones: Zone[]; trackingTarget: string | null; initial?: Partial<Setup>; onClose: () => void; onDone: () => void }) {
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
          <div className="rounded-xl border border-dashed border-slate-300 p-4">
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
              <li>Connect them in <Link to="/sender-emails" className="text-brand-600 hover:underline">Sender Emails</Link> <ArrowRight className="inline size-3" /> enable <Link to="/warmup" className="text-brand-600 hover:underline">warmup</Link>.</li>
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ActionsTable({ actions }: { actions: Action[] }) {
  const tone = { create: 'green', update: 'yellow', delete: 'red', keep: 'gray' } as const;
  const label = { create: 'Add', update: 'Change', delete: 'Remove', keep: 'Keep' } as const;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
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
