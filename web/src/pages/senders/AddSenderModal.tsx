import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Mail, Server } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { Alert, Button, Field, Input, Modal, Select, Textarea, Toggle, useUi, cx } from '../../components/ui.tsx';
import type { EgressRoute } from './types.ts';

type Mode = 'choose' | 'google' | 'microsoft' | 'custom';

const EMPTY = {
  name: '', email: '', password: '', username: '',
  imap_server: '', imap_port: 993, imap_secure: true,
  smtp_server: '', smtp_port: 465, smtp_secure: true,
  daily_limit: 30, email_signature: '', egress_route_id: '' as string, warmup_enabled: true,
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><path fill="#EA4335" d="M12 10.2v3.9h5.4c-.2 1.3-1.6 3.8-5.4 3.8-3.2 0-5.9-2.7-5.9-6s2.7-6 5.9-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.4 14.6 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.5 0 9.2-3.9 9.2-9.4 0-.6-.1-1.1-.2-1.6H12z" /></svg>
  );
}
function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><path fill="#F25022" d="M3 3h8.5v8.5H3z" /><path fill="#7FBA00" d="M12.5 3H21v8.5h-8.5z" /><path fill="#00A4EF" d="M3 12.5h8.5V21H3z" /><path fill="#FFB900" d="M12.5 12.5H21V21h-8.5z" /></svg>
  );
}

export function AddSenderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string>('');
  const [oauthError, setOauthError] = useState<{ provider: string; message: string; notConfigured: boolean } | null>(null);
  const qc = useQueryClient();
  const { toast } = useUi();
  const routes = useQuery({ queryKey: ['egress-routes'], queryFn: () => api.get('/api/egress-routes').then((r) => r.data as EgressRoute[]), enabled: open });

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const reset = () => { setMode('choose'); setForm(EMPTY); setError(''); setOauthError(null); };
  const close = () => { reset(); onClose(); };

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(), email: form.email.trim(), password: form.password,
        daily_limit: Number(form.daily_limit) || 30, email_signature: form.email_signature,
        egress_route_id: form.egress_route_id ? Number(form.egress_route_id) : null,
        warmup_enabled: form.warmup_enabled,
      };
      if (mode === 'google') body.provider = 'google';
      if (mode === 'custom') {
        Object.assign(body, {
          provider: 'custom', username: form.username.trim() || undefined,
          imap_server: form.imap_server.trim(), imap_port: Number(form.imap_port), imap_secure: form.imap_secure,
          smtp_server: form.smtp_server.trim(), smtp_port: Number(form.smtp_port), smtp_secure: form.smtp_secure,
        });
      }
      return api.post('/api/sender-emails/imap-smtp', body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['senders'] });
      qc.invalidateQueries({ queryKey: ['warmup'] });
      toast(`${r.data.email} connected`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const startOAuth = async (provider: 'google' | 'microsoft') => {
    setOauthError(null);
    try {
      const r = await api.post(`/api/oauth-sessions/${provider}`, {});
      window.location.href = r.data.url;
    } catch (e) {
      setOauthError({ provider, message: errorMessage(e), notConfigured: e instanceof ApiError && e.status === 422 });
    }
  };

  const canSubmit = form.name.trim() && form.email.trim() && form.password && (mode !== 'custom' || (form.imap_server.trim() && form.smtp_server.trim()));

  const commonFields = (
    <div className="space-y-4 border-t border-slate-100 pt-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Daily sending limit" hint="25–40 is a safe range per mailbox">
          <Input type="number" min={1} max={2000} value={form.daily_limit} onChange={(e) => set('daily_limit', Number(e.target.value))} />
        </Field>
        <Field label="IP route" hint={<>Optional · <Link to="/integrations" className="text-brand-600 hover:underline" onClick={close}>manage</Link></>}>
          <Select value={form.egress_route_id} onChange={(e) => set('egress_route_id', e.target.value)}>
            <option value="">Server default</option>
            {routes.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Signature" hint="Added to the end of every campaign email. Plain text or HTML.">
        <Textarea rows={3} value={form.email_signature} onChange={(e) => set('email_signature', e.target.value)} placeholder={'Alex Morgan\nHead of Growth, Bear Co'} />
      </Field>
      <Toggle checked={form.warmup_enabled} onChange={(v) => set('warmup_enabled', v)} label="Start warmup" description="Joins your private warmup pool right away (recommended for new mailboxes)." />
    </div>
  );

  const nameEmail = (
    <div className="grid grid-cols-2 gap-4">
      <Field label="Sender name"><Input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Alex Morgan" /></Field>
      <Field label="Email address"><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="alex@yourdomain.com" /></Field>
    </div>
  );

  let body;
  let footer = null;
  if (mode === 'choose') {
    const option = (m: Mode, icon: React.ReactNode, title: string, desc: string) => (
      <button onClick={() => setMode(m)} className="flex w-full items-start gap-4 rounded-xl border border-slate-200 p-4 text-left transition hover:border-brand-500 hover:bg-brand-50/40">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white">{icon}</div>
        <div>
          <div className="font-medium text-slate-900">{title}</div>
          <div className="mt-0.5 text-[13px] text-slate-500">{desc}</div>
        </div>
      </button>
    );
    body = (
      <div className="space-y-3">
        {option('google', <GoogleIcon />, 'Google Workspace / Gmail', 'Connect with an app password. No Google approval needed.')}
        {option('microsoft', <MicrosoftIcon />, 'Microsoft 365 / Outlook', 'Sign in with Microsoft using your own Entra app.')}
        {option('custom', <Server className="size-5 text-slate-600" />, 'Any provider (IMAP / SMTP)', 'Zoho, Fastmail, your own server, or any mailbox with IMAP and SMTP.')}
      </div>
    );
  } else if (mode === 'microsoft') {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">You'll be sent to Microsoft to sign in to the mailbox. After you approve access, you come back here and the mailbox is connected.</p>
        {oauthError && (
          <Alert tone={oauthError.notConfigured ? 'yellow' : 'red'} title={oauthError.notConfigured ? 'OAuth app not set up yet' : 'Could not start sign-in'}>
            {oauthError.message}{' '}
            {oauthError.notConfigured && <Link to="/integrations" onClick={close} className="font-medium underline">Open Integrations</Link>}
          </Alert>
        )}
        <Button variant="primary" className="w-full" icon={<MicrosoftIcon />} onClick={() => startOAuth('microsoft')}>Sign in with Microsoft</Button>
        <div className="rounded-lg bg-slate-50 p-3 text-[13px] text-slate-600">
          Microsoft is switching off password-based SMTP for Microsoft 365, so OAuth is the reliable way to connect Outlook mailboxes.
          Set up your Microsoft app once under <Link to="/integrations" onClick={close} className="font-medium text-brand-600 hover:underline">Integrations</Link>.
        </div>
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" /></div>
        <Button className="w-full" icon={<GoogleIcon />} onClick={() => startOAuth('google')}>Sign in with Google (OAuth)</Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {error && <Alert tone="red" title="Couldn't connect this mailbox">{error}</Alert>}
        {mode === 'google' && (
          <div className="rounded-lg bg-slate-50 p-3 text-[13px] text-slate-600">
            <div className="mb-1 font-medium text-slate-800">How to get an app password</div>
            <ol className="list-decimal space-y-0.5 pl-4">
              <li>Turn on 2-Step Verification for the Google account.</li>
              <li>Create an app password at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">myaccount.google.com/apppasswords</a>.</li>
              <li>Make sure IMAP is enabled in Gmail settings (Workspace admins: allow IMAP for users).</li>
            </ol>
          </div>
        )}
        {nameEmail}
        {mode === 'google' ? (
          <Field label="App password" hint="16 characters, spaces are fine"><Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="abcd efgh ijkl mnop" /></Field>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Username" hint="Leave blank to use the email address"><Input value={form.username} onChange={(e) => set('username', e.target.value)} /></Field>
              <Field label="Password"><Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} /></Field>
            </div>
            <ServerRow label="IMAP (receiving)" host={form.imap_server} port={form.imap_port} secure={form.imap_secure}
              onHost={(v) => set('imap_server', v)} onPort={(v) => set('imap_port', v)} onSecure={(v) => set('imap_secure', v)} placeholder="imap.yourprovider.com" />
            <ServerRow label="SMTP (sending)" host={form.smtp_server} port={form.smtp_port} secure={form.smtp_secure}
              onHost={(v) => set('smtp_server', v)}
              onPort={(v) => { set('smtp_port', v); if (v === 587) set('smtp_secure', false); if (v === 465) set('smtp_secure', true); }}
              onSecure={(v) => set('smtp_secure', v)} placeholder="smtp.yourprovider.com"
              hint={form.smtp_port === 587 ? 'Port 587 uses STARTTLS — keep SSL off.' : undefined} />
          </>
        )}
        {commonFields}
      </div>
    );
    footer = (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" loading={create.isPending} disabled={!canSubmit} onClick={() => { setError(''); create.mutate(); }}>
          {create.isPending ? 'Testing connection…' : 'Connect mailbox'}
        </Button>
      </>
    );
  }

  const titles: Record<Mode, string> = { choose: 'Add email account', google: 'Connect Google Workspace', microsoft: 'Connect Microsoft 365', custom: 'Connect via IMAP / SMTP' };
  return (
    <Modal open={open} onClose={close} size="lg" footer={footer}
      title={<span className="flex items-center gap-2">{mode !== 'choose' && <button onClick={() => { setMode('choose'); setError(''); }} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Back"><ArrowLeft className="size-4" /></button>}{titles[mode]}</span>}
      description={mode === 'choose' ? 'Choose how this mailbox connects. We test the connection before saving.' : mode === 'microsoft' ? undefined : 'We log in over SMTP and IMAP to check the details before saving.'}>
      {body}
    </Modal>
  );
}

function ServerRow({ label, host, port, secure, onHost, onPort, onSecure, placeholder, hint }: {
  label: string; host: string; port: number; secure: boolean; placeholder: string; hint?: string;
  onHost: (v: string) => void; onPort: (v: number) => void; onSecure: (v: boolean) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-slate-700">
        {label.startsWith('IMAP') ? <Mail className="size-4 text-slate-400" /> : <KeyRound className="size-4 text-slate-400" />} {label}
      </div>
      <div className="grid grid-cols-[1fr_96px_auto] items-center gap-3">
        <Input value={host} onChange={(e) => onHost(e.target.value)} placeholder={placeholder} aria-label={`${label} host`} />
        <Input type="number" value={port} onChange={(e) => onPort(Number(e.target.value))} aria-label={`${label} port`} />
        <label className={cx('flex items-center gap-2 text-sm text-slate-600')}>
          <input type="checkbox" checked={secure} onChange={(e) => onSecure(e.target.checked)} className="size-4 accent-brand-600" /> SSL
        </label>
      </div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}
