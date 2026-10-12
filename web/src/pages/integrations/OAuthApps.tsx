import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Badge, Button, Card, CopyText, Field, Input, Loading, useUi } from '../../components/ui.tsx';

interface Settings {
  google_client_id: string; google_client_secret_set: boolean;
  microsoft_client_id: string; microsoft_client_secret_set: boolean; microsoft_tenant: string;
  oauth_redirect_uri: string; public_url: string;
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[13px] font-medium text-brand-600 hover:text-brand-700">Setup steps</summary>
      <ol className="mt-3 space-y-1.5 text-[13px] text-slate-600">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600">{i + 1}</span>
            <span className="pt-px">{it}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const code = (s: string) => <code className="rounded bg-slate-100 px-1 py-0.5 text-[12px] text-slate-700">{s}</code>;

export function OAuthApps() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['settings', 'integrations'], queryFn: () => api.get('/api/settings/integrations').then((r) => r.data as Settings), retry: false });
  const [form, setForm] = useState({ google_client_id: '', google_client_secret: '', microsoft_client_id: '', microsoft_client_secret: '', microsoft_tenant: 'common' });
  useEffect(() => {
    if (q.data) setForm((f) => ({ ...f, google_client_id: q.data.google_client_id, microsoft_client_id: q.data.microsoft_client_id, microsoft_tenant: q.data.microsoft_tenant || 'common', google_client_secret: '', microsoft_client_secret: '' }));
  }, [q.data]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: (provider: 'google' | 'microsoft') => api.put('/api/settings/integrations', provider === 'google'
      ? { google_client_id: form.google_client_id, google_client_secret: form.google_client_secret }
      : { microsoft_client_id: form.microsoft_client_id, microsoft_client_secret: form.microsoft_client_secret, microsoft_tenant: form.microsoft_tenant || 'common' }),
    onSuccess: (_r, provider) => { toast(`${provider === 'google' ? 'Google' : 'Microsoft'} app saved`); qc.invalidateQueries({ queryKey: ['settings', 'integrations'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (q.isError) return <Card title="Google & Microsoft sign-in"><Alert tone="yellow">Only workspace admins can view OAuth app settings.</Alert></Card>;
  if (!q.data) return <Card title="Google & Microsoft sign-in"><Loading /></Card>;
  const s = q.data;
  const configured = (id: string, secret: boolean) => id && secret
    ? <Badge tone="green"><CheckCircle2 className="size-3" /> Configured</Badge>
    : <Badge>Not set up</Badge>;

  return (
    <Card title="Google & Microsoft sign-in (OAuth)" description="Use your own app so mailboxes can sign in with Google or Microsoft.">
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-4 py-3">
        <span className="text-sm font-medium text-slate-700">Redirect URI to register:</span>
        <CopyText value={s.oauth_redirect_uri} />
        {s.public_url.includes('localhost') && <span className="text-xs text-slate-500">Set PUBLIC_URL in .env if you reach Kinetic on another address.</span>}
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between"><h4 className="font-semibold text-slate-900">Google</h4>{configured(s.google_client_id, s.google_client_secret_set)}</div>
          <p className="text-[13px] text-slate-500">Optional — Google mailboxes work with app passwords without this.</p>
          <div className="my-3">
            <Steps items={[
              <>In Google Cloud Console create a project and enable the {code('Gmail API')}.</>,
              <>Configure the OAuth consent screen (External or Internal) and add the scope {code('https://mail.google.com/')}.</>,
              <>Create an OAuth client of type <b>Web application</b> and add the redirect URI above.</>,
              <>Leave the app unverified: it works for up to 100 mailboxes, you just click past the “unverified app” notice.</>,
            ]} />
          </div>
          <div className="space-y-3">
            <Field label="Client ID"><Input value={form.google_client_id} onChange={set('google_client_id')} placeholder="1234-abc.apps.googleusercontent.com" /></Field>
            <Field label="Client secret" hint={s.google_client_secret_set ? 'Saved. Leave blank to keep it.' : undefined}><Input type="password" value={form.google_client_secret} onChange={set('google_client_secret')} placeholder={s.google_client_secret_set ? '••••••••' : ''} /></Field>
            <Button variant="primary" loading={save.isPending && save.variables === 'google'} onClick={() => save.mutate('google')}>Save Google app</Button>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between"><h4 className="font-semibold text-slate-900">Microsoft</h4>{configured(s.microsoft_client_id, s.microsoft_client_secret_set)}</div>
          <p className="text-[13px] text-slate-500">Recommended for Microsoft 365 — password SMTP is switched off by default from the end of 2026.</p>
          <div className="my-3">
            <Steps items={[
              <>In Microsoft Entra ID → App registrations, create a new registration (accounts in any organizational directory).</>,
              <>Add a <b>Web</b> redirect URI: the one above.</>,
              <>Under API permissions add delegated {code('IMAP.AccessAsUser.All')}, {code('SMTP.Send')}, {code('offline_access')}, {code('openid')}, {code('email')}.</>,
              <>Click <b>Grant admin consent</b> in each tenant you own. No publisher verification needed for your own tenants.</>,
              <>Create a client secret under Certificates & secrets and paste it below.</>,
            ]} />
          </div>
          <div className="space-y-3">
            <Field label="Application (client) ID"><Input value={form.microsoft_client_id} onChange={set('microsoft_client_id')} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
            <Field label="Client secret" hint={s.microsoft_client_secret_set ? 'Saved. Leave blank to keep it.' : undefined}><Input type="password" value={form.microsoft_client_secret} onChange={set('microsoft_client_secret')} placeholder={s.microsoft_client_secret_set ? '••••••••' : ''} /></Field>
            <Field label="Tenant" hint={'"common" works for any tenant; use your tenant ID to restrict.'}><Input value={form.microsoft_tenant} onChange={set('microsoft_tenant')} /></Field>
            <Button variant="primary" loading={save.isPending && save.variables === 'microsoft'} onClick={() => save.mutate('microsoft')}>Save Microsoft app</Button>
          </div>
        </section>
      </div>
    </Card>
  );
}
