import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, RefreshCw, Send, Stethoscope } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtDateTime, fmtNumber, fmtRelative } from '../../lib/format.ts';
import { Alert, Badge, Button, Card, Drawer, Field, Input, Loading, Select, Textarea, Toggle, useUi } from '../../components/ui.tsx';
import { CampaignStatus, SenderStatus, providerLabel } from '../../components/status.tsx';
import { DnsList } from './DnsChecks.tsx';
import { useSenderActions } from './actions.tsx';
import type { DomainReport, EgressRoute, Sender, WarmupStats } from './types.ts';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="min-w-0 text-right font-medium text-slate-800">{children}</span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export function SenderDrawer({ senderId, onClose }: { senderId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const { actions, modals } = useSenderActions();
  const q = useQuery({
    queryKey: ['sender', senderId],
    queryFn: () => api.get(`/api/sender-emails/${senderId}`).then((r) => r.data as Sender & { warmup: WarmupStats }),
    enabled: !!senderId,
  });
  const campaigns = useQuery({
    queryKey: ['sender', senderId, 'campaigns'],
    queryFn: () => api.get(`/api/sender-emails/${senderId}/campaigns`).then((r) => r.data as { id: number; name: string; status: string }[]),
    enabled: !!senderId,
  });
  const routes = useQuery({ queryKey: ['egress-routes'], queryFn: () => api.get('/api/egress-routes').then((r) => r.data as EgressRoute[]), enabled: !!senderId });
  const [dns, setDns] = useState<DomainReport | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [form, setForm] = useState<Partial<Sender> & { egress: string }>({ egress: '' });
  const [showServers, setShowServers] = useState(false);

  const s = q.data;
  useEffect(() => {
    if (s) setForm({ name: s.name, daily_limit: s.daily_limit, email_signature: s.email_signature, egress: s.egress_route_id ? String(s.egress_route_id) : '', imap_server: s.imap_server, imap_port: s.imap_port, imap_secure: s.imap_secure, smtp_server: s.smtp_server, smtp_port: s.smtp_port, smtp_secure: s.smtp_secure });
  }, [s?.id, s?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDns(null); setShowServers(false); }, [senderId]);

  const save = useMutation({
    mutationFn: () => api.patch(`/api/sender-emails/${senderId}`, {
      name: form.name, daily_limit: Number(form.daily_limit), email_signature: form.email_signature ?? '',
      egress_route_id: form.egress ? Number(form.egress) : null,
      ...(showServers ? { imap_server: form.imap_server, imap_port: Number(form.imap_port), imap_secure: form.imap_secure, smtp_server: form.smtp_server, smtp_port: Number(form.smtp_port), smtp_secure: form.smtp_secure } : {}),
    }),
    onSuccess: () => { toast('Settings saved'); qc.invalidateQueries({ queryKey: ['sender', senderId] }); qc.invalidateQueries({ queryKey: ['senders'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const runDns = async () => {
    setDnsLoading(true);
    try { setDns((await api.post(`/api/sender-emails/${senderId}/check-mx-records`)).data); } catch (e) { toast(errorMessage(e), 'error'); } finally { setDnsLoading(false); }
  };

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const w = s?.warmup;
  const placed = w ? w.landed_inbox + w.landed_spam : 0;

  return (
    <Drawer open={!!senderId} onClose={onClose} width="max-w-2xl"
      title={s?.name ?? 'Email account'}
      subtitle={s?.email}
      actions={s && <SenderStatus status={s.status} />}>
      {modals}
      {!s ? <Loading /> : (
        <div className="space-y-5">
          {s.status === 'Disconnected' && (
            <Alert tone="red" title="This mailbox is disconnected" action={<Button size="sm" onClick={() => actions.reconnect(s)}>Reconnect</Button>}>
              {s.last_error ?? 'The last login failed.'}
            </Alert>
          )}
          {s.status === 'Paused' && s.paused_reason && (
            <Alert tone="yellow" title="Paused automatically">{s.paused_reason}. Resume it once the cause is fixed.</Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Stethoscope className="size-4" />} onClick={() => actions.testConnection(s)}>Test connection</Button>
            <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={() => actions.syncNow(s)}>Sync now</Button>
            <Button size="sm" icon={<Send className="size-4" />} onClick={() => actions.sendTest(s)}>Send test email</Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <MiniStat label="Sent" value={fmtNumber(s.emails_sent_count)} />
            <MiniStat label="Unique opens" value={fmtNumber(s.unique_opened_count)} />
            <MiniStat label="Replies" value={fmtNumber(s.unique_replied_count)} />
            <MiniStat label="Interested" value={fmtNumber(s.interested_leads_count)} />
            <MiniStat label="Bounced" value={fmtNumber(s.bounced_count)} />
          </div>

          <Card title="Overview">
            <Row label="Provider"><Badge>{providerLabel(s.provider)}</Badge> <span className="ml-1 text-xs font-normal text-slate-500">{s.auth_type === 'oauth' ? 'OAuth' : 'Password'}</span></Row>
            <Row label="IMAP">{s.imap_server}:{s.imap_port} {s.imap_secure ? '· SSL' : ''}</Row>
            <Row label="SMTP">{s.smtp_server}:{s.smtp_port} {s.smtp_secure ? '· SSL' : '· STARTTLS'}</Row>
            <Row label="Last synced">{s.last_synced_at ? <span title={fmtDateTime(s.last_synced_at)}>{fmtRelative(s.last_synced_at)}</span> : 'Not yet'}</Row>
            <Row label="Sent last 24h">{s.sent_last_24h} / {s.daily_limit}</Row>
            <Row label="Added">{fmtDateTime(s.created_at)}</Row>
            <Row label="Health">{s.health_score == null ? 'Not checked yet' : `${s.health_score} / 100${s.health_reasons.length ? '' : ' · no problems found'}`}</Row>
            {s.health_reasons.length > 0 && <ul className="list-disc pb-1.5 pl-4 text-xs text-slate-600">{s.health_reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            {s.last_error && s.status !== 'Disconnected' && <Row label="Last error"><span className="text-red-600">{s.last_error}</span></Row>}
          </Card>

          <Card title="Settings">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Sender name"><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
                <Field label="Daily limit"><Input type="number" min={1} max={2000} value={form.daily_limit ?? 30} onChange={(e) => set('daily_limit', e.target.value)} /></Field>
              </div>
              <Field label="IP route" hint={<Link to="/integrations" className="text-brand-600 hover:underline">Manage sending IPs</Link>}>
                <Select value={form.egress} onChange={(e) => set('egress', e.target.value)}>
                  <option value="">Server default</option>
                  {routes.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </Field>
              <Field label="Signature">
                <Textarea rows={4} value={form.email_signature ?? ''} onChange={(e) => set('email_signature', e.target.value)} />
              </Field>
              {form.email_signature && (
                <div className="rounded-lg border border-dashed border-slate-200 p-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Preview</div>
                  {/<[a-z][\s\S]*>/i.test(form.email_signature)
                    // Sandboxed frame: signature HTML can come from any teammate, so it must never run scripts here.
                    ? <iframe title="Signature preview" sandbox="" className="h-28 w-full border-0" srcDoc={`<style>body{margin:0;font:14px/1.5 Inter,system-ui,sans-serif;color:#1e293b}</style>${form.email_signature}`} />
                    : <div className="email-body whitespace-pre-wrap">{form.email_signature}</div>}
                </div>
              )}
              <Toggle checked={showServers} onChange={setShowServers} label="Edit server settings" description="Only change these if your provider's IMAP/SMTP details changed." />
              {showServers && (
                <div className="grid grid-cols-[1fr_90px_auto] items-end gap-3">
                  <Field label="IMAP host"><Input value={form.imap_server ?? ''} onChange={(e) => set('imap_server', e.target.value)} /></Field>
                  <Field label="Port"><Input type="number" value={form.imap_port ?? 993} onChange={(e) => set('imap_port', e.target.value)} /></Field>
                  <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-600" checked={!!form.imap_secure} onChange={(e) => set('imap_secure', e.target.checked)} /> SSL</label>
                  <Field label="SMTP host"><Input value={form.smtp_server ?? ''} onChange={(e) => set('smtp_server', e.target.value)} /></Field>
                  <Field label="Port"><Input type="number" value={form.smtp_port ?? 465} onChange={(e) => set('smtp_port', e.target.value)} /></Field>
                  <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" className="accent-brand-600" checked={!!form.smtp_secure} onChange={(e) => set('smtp_secure', e.target.checked)} /> SSL</label>
                </div>
              )}
              <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></div>
            </div>
          </Card>

          <Card title="Domain health" description="SPF, DKIM and DMARC decide whether mailbox providers trust this domain."
            actions={<Button size="sm" loading={dnsLoading} onClick={runDns}>{dns ? 'Re-check' : 'Check DNS'}</Button>}>
            {dns ? <DnsList checks={dns.checks} /> : <p className="text-sm text-slate-500">Run a check to look up the DNS records for <b>{s.email.split('@')[1]}</b>.</p>}
          </Card>

          <Card title="Warmup (last 7 days)" actions={<Link to="/warmup" className="text-sm font-medium text-brand-600 hover:underline">Open warmup</Link>}>
            {!s.warmup_enabled && !w?.sent ? (
              <p className="text-sm text-slate-500">Warmup is off for this mailbox.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="Sent" value={w?.sent ?? 0} />
                <MiniStat label="Received" value={w?.received ?? 0} />
                <MiniStat label="Inbox rate" value={w?.health_score === null || !placed ? '—' : `${w!.health_score}%`} />
                <MiniStat label="Rescued from spam" value={w?.rescued ?? 0} />
              </div>
            )}
          </Card>

          <Card title="Campaigns using this mailbox" padded={false}>
            {campaigns.data?.length ? (
              <ul className="divide-y divide-slate-100">
                {campaigns.data.map((c) => (
                  <li key={c.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <Link to={`/campaigns/${c.id}`} className="flex items-center gap-2 font-medium text-slate-800 hover:text-brand-600"><Mail className="size-4 text-slate-400" />{c.name}</Link>
                    <CampaignStatus status={c.status} />
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-4 text-sm text-slate-500">Not used in any campaign yet.</p>}
          </Card>

          <div className="flex justify-end">
            <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => actions.remove(s, onClose)}>Delete email account</Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

