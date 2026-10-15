import { useState, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { Alert, Button, Field, Input } from '../components/ui.tsx';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/logo.svg" alt="" className="size-12" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
        {footer && <div className="mt-4 text-center text-xs leading-relaxed text-slate-500">{footer}</div>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { email, password });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to Kinetic"
      footer={<>No account yet? Ask your Kinetic admin to add you under Settings → Workspace &amp; team.<br />Forgot your password? An admin can set a new temporary one for you there.</>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Email"><Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function SetupPage() {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspace_name: 'Main Workspace' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/setup', form);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Set up Kinetic" subtitle="Create the first account. It becomes the admin."
      footer="Only this first account can be created here. After that, admins add everyone else under Settings → Workspace & team.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-600">
          As the admin you can connect mailboxes and integrations, and add teammates as <b>admins</b>, <b>editors</b> (run campaigns) or <b>viewers</b> (read only).
        </div>
        <Field label="Your name"><Input required autoFocus value={form.name} onChange={set('name')} /></Field>
        <Field label="Email"><Input type="email" required value={form.email} onChange={set('email')} /></Field>
        <Field label="Password" hint="At least 8 characters"><Input type="password" required minLength={8} value={form.password} onChange={set('password')} /></Field>
        <Field label="Workspace name"><Input required value={form.workspace_name} onChange={set('workspace_name')} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Create account</Button>
      </form>
    </AuthShell>
  );
}

/** Shown after signing in with a temporary password (new member, or an admin reset it). */
export function ChoosePasswordPage() {
  const { me, refresh } = useAuth();
  const [pw, setPw] = useState({ password: '', password_confirmation: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.password !== pw.password_confirmation) return setError('The passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await api.put('/api/users/password', pw);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => { await api.post('/api/auth/logout'); window.location.assign('/'); };

  return (
    <AuthShell title={`Welcome${me?.name ? `, ${me.name.split(' ')[0]}` : ''}`}
      subtitle={me?.team ? `You’ve been added to ${me.team.name} as ${`${/^[aeiou]/.test(me.team.role) ? 'an' : 'a'} ${me.team.role}`}.` : 'Choose your password to continue.'}
      footer={<button onClick={signOut} className="text-slate-500 underline hover:text-slate-700">Sign out</button>}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">You signed in with a temporary password. Choose your own to continue.</p>
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" autoFocus required minLength={8} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
        <Field label="Confirm new password"><Input type="password" autoComplete="new-password" required value={pw.password_confirmation} onChange={(e) => setPw({ ...pw, password_confirmation: e.target.value })} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Save and continue</Button>
      </form>
    </AuthShell>
  );
}
