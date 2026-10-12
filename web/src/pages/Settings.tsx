import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle, Plus, Trash2, Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import {
  Alert, Badge, Button, Card, CopyText, EmptyState, Field, Input, Loading, Modal, Pagination, Select, Table, Td, Textarea, Th, Toggle, cx, useUi,
} from '../components/ui.tsx';

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'workspace', label: 'Workspace & team' },
  { id: 'inbox', label: 'Master inbox' },
  { id: 'blacklist', label: 'Blacklist' },
  { id: 'ignore-phrases', label: 'Ignore phrases' },
  { id: 'variables', label: 'Custom variables' },
  { id: 'tags', label: 'Tags' },
  { id: 'templates', label: 'Reply templates' },
  { id: 'tracking', label: 'Tracking domains' },
  { id: 'dns', label: 'Domain checker' },
];

export function SettingsPage() {
  const { section = 'profile' } = useParams();
  // Provider keys moved to the Integrations page.
  if (section === 'keys') return <Navigate to="/integrations#providers" replace />;
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <Page>
      <PageHeader title="Settings" subtitle="Your account, workspace and sending rules." />
      <div className="flex flex-col gap-8 lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto lg:w-52 lg:flex-col scroll-thin">
          {SECTIONS.map((s) => (
            <NavLink key={s.id} to={`/settings/${s.id}`} className={() => cx('whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium', current.id === s.id ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900')}>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-6">
          {current.id === 'profile' && <Profile />}
          {current.id === 'workspace' && <Workspace />}
          {current.id === 'inbox' && <InboxSettings />}
          {current.id === 'blacklist' && <Blacklist />}
          {current.id === 'ignore-phrases' && <SimpleList kind="ignore" />}
          {current.id === 'variables' && <SimpleList kind="variables" />}
          {current.id === 'tags' && <SimpleList kind="tags" />}
          {current.id === 'templates' && <Templates />}
          {current.id === 'tracking' && <TrackingDomains />}
          {current.id === 'dns' && <DomainChecker />}
        </div>
      </div>
    </Page>
  );
}

function Profile() {
  const { me, refresh } = useAuth();
  const { toast } = useUi();
  const [name, setName] = useState(me?.name ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [pw, setPw] = useState({ current_password: '', password: '', password_confirmation: '' });
  const saveProfile = useMutation({
    mutationFn: () => api.put('/api/users/profile', { name, email }),
    onSuccess: async () => { toast('Profile saved'); await refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const savePw = useMutation({
    mutationFn: () => api.put('/api/users/password', pw),
    onSuccess: () => { toast('Password updated'); setPw({ current_password: '', password: '', password_confirmation: '' }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <>
      <Card title="Profile">
        <div className="grid max-w-xl gap-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <div><Button variant="primary" loading={saveProfile.isPending} onClick={() => saveProfile.mutate()}>Save profile</Button></div>
        </div>
      </Card>
      <Card title="Password">
        <div className="grid max-w-xl gap-4">
          <Field label="Current password"><Input type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></Field>
          <Field label="Confirm new password"><Input type="password" value={pw.password_confirmation} onChange={(e) => setPw({ ...pw, password_confirmation: e.target.value })} /></Field>
          <div><Button variant="primary" loading={savePw.isPending} disabled={!pw.current_password || !pw.password} onClick={() => savePw.mutate()}>Update password</Button></div>
        </div>
      </Card>
    </>
  );
}

function Workspace() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const ws = useQuery({ queryKey: ['workspace', me?.current_workspace_id], queryFn: () => api.get(`/api/workspaces/${me!.current_workspace_id}`).then((r) => r.data) });
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [member, setMember] = useState({ name: '', email: '', password: '', role: 'editor' });
  useEffect(() => { if (ws.data) setName(ws.data.name); }, [ws.data]);
  const isAdmin = me?.role === 'admin';

  const rename = useMutation({
    mutationFn: () => api.put(`/api/workspaces/${me!.current_workspace_id}`, { name }),
    onSuccess: async () => { toast('Workspace renamed'); qc.invalidateQueries({ queryKey: ['workspaces'] }); await refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const addMember = useMutation({
    mutationFn: () => api.post('/api/workspaces/v1.1/users', member),
    onSuccess: () => { toast('Member added'); setAdding(false); setMember({ name: '', email: '', password: '', role: 'editor' }); ws.refetch(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const setRole = async (userId: number, role: string) => {
    try { await api.put(`/api/workspaces/members/${userId}`, { role }); ws.refetch(); toast('Role updated'); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const removeMember = async (m: any) => {
    if (!(await confirm({ title: `Remove ${m.name}?`, message: 'They will lose access to this workspace.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.del(`/api/workspaces/members/${m.id}`); ws.refetch(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const deleteWs = async () => {
    if (!(await confirm({ title: `Delete “${ws.data.name}”?`, message: 'All leads, campaigns, mailboxes and replies in this workspace are deleted permanently.', confirmLabel: 'Delete workspace', danger: true }))) return;
    try {
      await api.del(`/api/workspaces/${me!.current_workspace_id}`);
      qc.clear();
      await refresh();
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  if (!ws.data) return <Loading />;
  return (
    <>
      <Card title="Workspace">
        <div className="flex max-w-xl items-end gap-3">
          <Field label="Name" className="flex-1"><Input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} /></Field>
          <Button variant="primary" disabled={!isAdmin || !name.trim()} loading={rename.isPending} onClick={() => rename.mutate()}>Save</Button>
        </div>
      </Card>
      <Card title="Team members" description="Unlimited members, no per-seat fees. Viewers can look but not change anything." padded={false}
        actions={isAdmin && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add member</Button>}>
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th /></tr></thead>
          <tbody>
            {ws.data.members.map((m: any) => (
              <tr key={m.id}>
                <Td className="font-medium text-slate-900">{m.name}{m.id === me?.id && <span className="ml-2 text-xs text-slate-400">(you)</span>}</Td>
                <Td>{m.email}</Td>
                <Td>
                  {isAdmin && m.id !== me?.id ? (
                    <Select value={m.role} onChange={(e) => setRole(m.id, e.target.value)} className="w-32">
                      <option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
                    </Select>
                  ) : <Badge tone={m.role === 'admin' ? 'purple' : 'gray'}>{m.role}</Badge>}
                </Td>
                <Td className="text-right">{isAdmin && m.id !== me?.id && <Button size="sm" variant="ghost" onClick={() => removeMember(m)}>Remove</Button>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {isAdmin && (
        <Card title="Danger zone">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-slate-600">Delete this workspace and everything in it.</p>
            <Button variant="danger" onClick={deleteWs}>Delete workspace</Button>
          </div>
        </Card>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add team member" description="Creates a login for them and adds them to this workspace." size="sm"
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={addMember.isPending} onClick={() => addMember.mutate()}>Add member</Button></>}>
        <div className="space-y-4">
          <Field label="Name"><Input value={member.name} onChange={(e) => setMember({ ...member, name: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="They can change it in Settings → Profile."><Input type="password" value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} /></Field>
          <Field label="Role">
            <Select value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}>
              <option value="admin">Admin — full access</option><option value="editor">Editor — run campaigns</option><option value="viewer">Viewer — read only</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  );
}

function InboxSettings() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const s = useQuery({ queryKey: ['inbox-settings'], queryFn: () => api.get('/api/workspaces/v1.1/master-inbox-settings').then((r) => r.data) });
  const [model, setModel] = useState<string | null>(null);
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch('/api/workspaces/v1.1/master-inbox-settings', patch);
      qc.invalidateQueries({ queryKey: ['inbox-settings'] });
      qc.invalidateQueries({ queryKey: ['reply-ai-status'] });
      toast('Saved');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const resort = useMutation({
    mutationFn: () => api.post('/api/replies/reclassify', { from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }),
    onSuccess: (r) => toast(`${r.data.queued} replies queued for AI sorting${r.data.skipped_manual ? ` · ${r.data.skipped_manual} with your own label kept` : ''}`),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!s.data) return <Loading />;
  const ai = s.data;
  return (
    <>
      <Card title="Master inbox" description="How replies are collected and labelled.">
        <div className="max-w-2xl space-y-5">
          <Toggle checked={s.data.sync_all_emails} onChange={(v) => save({ sync_all_emails: v })} label="Show all incoming email" description="Off: only replies to your campaigns appear. On: every message your mailboxes receive appears (warmup traffic is always hidden)." />
          <Toggle checked={s.data.auto_interested_categorization} onChange={(v) => save({ auto_interested_categorization: v })} label="Detect interested replies automatically" description="Replies like “sounds good, let's talk” are labelled Interested and stop the sequence for that lead." />
          <Toggle checked={s.data.smart_warmup_filter} onChange={(v) => save({ smart_warmup_filter: v })} label="Hide warmup emails" description="Warmup conversations are filed into the “Kinetic Warmup” folder and never shown here." />
        </div>
      </Card>
      <Card title="AI reply sorting" description="Every human reply is read by an AI model and sorted into meeting requests, questions, objections, referrals, out-of-office and more, with a one-line summary and a suggested next step. Labels you set by hand are never changed."
        actions={ai.ai_configured && ai.ai_reply_sorting ? <Button size="sm" loading={resort.isPending} onClick={() => resort.mutate()}>Re-sort last 30 days</Button> : undefined}>
        <div className="max-w-2xl space-y-5">
          {!ai.ai_configured && (
            <Alert tone="yellow" title="No AI key yet">Add an OpenRouter key (or a local model URL) on the <NavLink to="/integrations#providers" className="font-medium underline">Integrations</NavLink> page. Until then replies are sorted by keyword rules.</Alert>
          )}
          <Toggle checked={ai.ai_reply_sorting} onChange={(v) => save({ ai_reply_sorting: v })} label="Sort replies with AI" description="Runs in the background after each sync, so the inbox never waits on it. If the model fails, the keyword label stays." />
          <Field label="Model" hint={`Default: ${ai.ai_effective_model}. Any OpenRouter model id works; cheap fast models are plenty.`}>
            <div className="flex gap-2">
              <Input value={model ?? ai.ai_reply_model ?? ''} placeholder={ai.ai_effective_model} onChange={(e) => setModel(e.target.value)} />
              {model !== null && model !== (ai.ai_reply_model ?? '') && <Button onClick={() => { void save({ ai_reply_model: model.trim() || null }); setModel(null); }}>Save</Button>}
            </div>
          </Field>
          <Toggle checked={ai.ai_auto_unsubscribe} onChange={(v) => save({ ai_auto_unsubscribe: v })} label="Unsubscribe on unsubscribe intent" description="When the AI reads “please stop emailing me”, the lead is unsubscribed everywhere, like the unsubscribe link." />
          <Toggle checked={ai.ai_pause_on_ooo} onChange={(v) => save({ ai_pause_on_ooo: v })} label="Pause leads who are out of office" description="When an out-of-office reply says when they’re back, their next email waits until that date." />
        </div>
      </Card>
    </>
  );
}

function Blacklist() {
  const [kind, setKind] = useState<'emails' | 'domains'>('domains');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [bulk, setBulk] = useState('');
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useUi();
  const list = useQuery({ queryKey: ['blacklist', kind, search, page], queryFn: () => api.get(`/api/blacklisted-${kind}`, { search, page, per_page: 25 }) });
  const add = useMutation({
    mutationFn: () => api.post(`/api/blacklisted-${kind}/bulk`, { [kind]: bulk.split(/[\s,;]+/).filter(Boolean) }),
    onSuccess: (r) => {
      toast(`${r.data.added} added${r.data.invalid.length ? `, ${r.data.invalid.length} invalid skipped` : ''}`);
      setBulk(''); setOpen(false); qc.invalidateQueries({ queryKey: ['blacklist'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (id: number) => { await api.del(`/api/blacklisted-${kind}/${id}`); qc.invalidateQueries({ queryKey: ['blacklist'] }); };
  const field = kind === 'emails' ? 'email' : 'domain';
  return (
    <Card title="Blacklist" description="Never email these addresses or domains. Anything already scheduled is cancelled." padded={false}
      actions={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Add {kind}</Button>}>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <div className="inline-flex rounded-lg bg-slate-100 p-1">
          {(['domains', 'emails'] as const).map((k) => (
            <button key={k} onClick={() => { setKind(k); setPage(1); }} className={cx('rounded-md px-3 py-1 text-sm font-medium', kind === k ? 'bg-white shadow-sm' : 'text-slate-600')}>{k === 'domains' ? 'Domains' : 'Emails'}</button>
          ))}
        </div>
        <div className="relative w-64"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
      </div>
      {list.data?.data.length === 0 ? <EmptyState title={`No blacklisted ${kind}`} description="Add competitors, existing customers or anyone who asked not to be contacted." /> : (
        <>
          <Table>
            <thead><tr><Th>{kind === 'emails' ? 'Email' : 'Domain'}</Th><Th>Added</Th><Th /></tr></thead>
            <tbody>
              {list.data?.data.map((r: any) => (
                <tr key={r.id}><Td className="font-medium text-slate-900">{r[field]}</Td><Td>{fmtDate(r.created_at)}</Td><Td className="text-right"><Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => remove(r.id)}>Remove</Button></Td></tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={list.data?.meta} onPage={setPage} />
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Add ${kind}`} description="Paste one per line, or separated by commas."
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!bulk.trim()} onClick={() => add.mutate()}>Add</Button></>}>
        <Textarea rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={kind === 'emails' ? 'ceo@competitor.com\nfriend@company.com' : 'competitor.com\ncustomer.com'} />
      </Modal>
    </Card>
  );
}

/** Ignore phrases, custom variables and tags share the same add/remove list UI. */
function SimpleList({ kind }: { kind: 'ignore' | 'variables' | 'tags' }) {
  const cfg = {
    ignore: { url: '/api/ignore-phrases', field: 'phrase', title: 'Ignore phrases', desc: 'Inbound messages containing these phrases are treated as automated: they never stop a sequence or count as replies.', placeholder: 'e.g. this mailbox is not monitored' },
    variables: { url: '/api/custom-variables', field: 'name', title: 'Custom variables', desc: 'Extra lead fields you can use in emails. They are also created automatically when you import CSV columns.', placeholder: 'e.g. City' },
    tags: { url: '/api/tags', field: 'name', title: 'Tags', desc: 'Label leads, campaigns and mailboxes to filter them quickly.', placeholder: 'e.g. Enterprise' },
  }[kind];
  const qc = useQueryClient();
  const { toast } = useUi();
  const [value, setValue] = useState('');
  const list = useQuery({ queryKey: ['simple', kind], queryFn: () => api.get(cfg.url).then((r) => r.data as any[]) });
  const add = useMutation({
    mutationFn: () => api.post(cfg.url, { [cfg.field]: value.trim() }),
    onSuccess: () => { setValue(''); qc.invalidateQueries({ queryKey: ['simple', kind] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (id: number) => {
    try { await api.del(`${cfg.url}/${id}`); qc.invalidateQueries({ queryKey: ['simple', kind] }); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <Card title={cfg.title} description={cfg.desc}>
      <form className="mb-4 flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) add.mutate(); }}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={cfg.placeholder} />
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!value.trim()}>Add</Button>
      </form>
      {list.data?.length === 0 && <p className="text-sm text-slate-500">Nothing here yet.</p>}
      <div className="flex flex-wrap gap-2">
        {list.data?.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white py-1 pl-3 pr-1 text-sm">
            {r[cfg.field]}
            {kind === 'variables' && <span className="font-mono text-xs text-slate-500">{r.tag}</span>}
            {kind === 'tags' && r.usage_count !== undefined && <span className="text-xs text-slate-400">{r.usage_count}</span>}
            {!(kind === 'tags' && r.default) && <button onClick={() => remove(r.id)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600" aria-label="Remove"><Trash2 className="size-3.5" /></button>}
          </span>
        ))}
      </div>
    </Card>
  );
}

function Templates() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const list = useQuery({ queryKey: ['reply-templates'], queryFn: () => api.get('/api/reply-templates').then((r) => r.data as any[]) });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [form, setForm] = useState({ name: '', body: '' });
  const openEdit = (t: any | null) => { setForm({ name: t?.name ?? '', body: t?.body ?? '' }); setEditing(t); };
  const save = useMutation({
    mutationFn: () => (editing ? api.put(`/api/reply-templates/${editing.id}`, form) : api.post('/api/reply-templates', form)),
    onSuccess: () => { toast('Template saved'); setEditing(undefined); qc.invalidateQueries({ queryKey: ['reply-templates'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (t: any) => {
    if (!(await confirm({ title: `Delete “${t.name}”?`, confirmLabel: 'Delete', danger: true }))) return;
    await api.del(`/api/reply-templates/${t.id}`);
    qc.invalidateQueries({ queryKey: ['reply-templates'] });
  };
  return (
    <Card title="Reply templates" description="Saved answers you can drop into a reply from the Master Inbox." padded={false}
      actions={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => openEdit(null)}>New template</Button>}>
      {list.data?.length === 0 ? <EmptyState title="No templates yet" description="Save your common answers — booking links, pricing, case studies." /> : (
        <ul className="divide-y divide-slate-100">
          {list.data?.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-sm text-slate-500">{t.body}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" onClick={() => openEdit(t)}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => remove(t)}><Trash2 className="size-4" /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit template' : 'New template'} size="lg"
        footer={<><Button onClick={() => setEditing(undefined)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!form.name.trim() || !form.body.trim()} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Booking link" /></Field>
          <Field label="Message"><Textarea rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={'Great to hear! Here is my calendar: https://cal.com/you\n\nTalk soon,'} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function TrackingDomains() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [domain, setDomain] = useState('');
  const list = useQuery({ queryKey: ['tracking-domains'], queryFn: () => api.get('/api/custom-tracking-domain') });
  const add = useMutation({
    mutationFn: () => api.post('/api/custom-tracking-domain', { domain }),
    onSuccess: () => { setDomain(''); qc.invalidateQueries({ queryKey: ['tracking-domains'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const verify = async (id: number) => {
    const r = await api.post(`/api/custom-tracking-domain/${id}/verify`);
    toast(r.data.status === 'verified' ? 'CNAME verified' : `CNAME not found yet (expected ${r.data.expected})`, r.data.status === 'verified' ? 'success' : 'error');
    qc.invalidateQueries({ queryKey: ['tracking-domains'] });
  };
  const remove = async (id: number) => { await api.del(`/api/custom-tracking-domain/${id}`); qc.invalidateQueries({ queryKey: ['tracking-domains'] }); };
  const target = list.data?.meta?.cname_target;
  return (
    <Card title="Custom tracking domains" description="Open/click tracking and unsubscribe links use this domain instead of the app's address, which keeps your links consistent with your brand." padded={false}>
      <div className="space-y-3 border-b border-slate-100 px-5 py-4">
        <p className="text-sm text-slate-600">Create a CNAME record pointing your tracking subdomain (e.g. <span className="font-mono text-xs">track.yourdomain.com</span>) to:</p>
        {target && <CopyText value={target} />}
        <form className="flex max-w-xl gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) add.mutate(); }}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="track.yourdomain.com" />
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!domain.trim()}>Add domain</Button>
        </form>
      </div>
      {list.data?.data.length === 0 ? <EmptyState title="No tracking domains" description="Optional — plain-text campaigns without tracking don't need one." /> : (
        <Table>
          <thead><tr><Th>Domain</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {list.data?.data.map((d: any) => (
              <tr key={d.id}>
                <Td className="font-medium text-slate-900">{d.domain}</Td>
                <Td><Badge tone={d.status === 'verified' ? 'green' : d.status === 'failed' ? 'red' : 'yellow'}>{d.status}</Badge></Td>
                <Td className="text-right"><div className="flex justify-end gap-1"><Button size="sm" onClick={() => verify(d.id)}>Verify</Button><Button size="sm" variant="ghost" onClick={() => remove(d.id)}><Trash2 className="size-4" /></Button></div></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function DnsReport({ report }: { report: { domain: string; checks: { name: string; status: string; value: string | null; advice: string }[] } }) {
  const icon = (s: string): ReactNode => s === 'pass' ? <CheckCircle2 className="size-4 text-emerald-600" /> : s === 'warn' ? <AlertTriangle className="size-4 text-amber-500" /> : <XCircle className="size-4 text-red-600" />;
  return (
    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {report.checks.map((c) => (
        <div key={c.name} className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5">{icon(c.status)}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-900">{c.name}</div>
            {c.value && <div className="mt-0.5 break-all font-mono text-xs text-slate-500">{c.value}</div>}
            <div className="mt-0.5 text-[13px] text-slate-600">{c.advice}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DomainChecker() {
  const [domain, setDomain] = useState('');
  const check = useMutation({ mutationFn: () => api.post('/api/tools/domain-check', { domain }).then((r) => r.data) });
  return (
    <Card title="Domain checker" description="Check MX, SPF, DKIM and DMARC for any domain before you send from it.">
      <form className="mb-4 flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) check.mutate(); }}>
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourdomain.com" />
        <Button type="submit" variant="primary" loading={check.isPending} disabled={!domain.trim()}>Check</Button>
      </form>
      {check.error && <Alert tone="red">{errorMessage(check.error)}</Alert>}
      {check.data && (
        <div className="max-w-2xl space-y-3">
          <Alert tone={check.data.ok ? 'green' : 'yellow'} title={check.data.ok ? `${check.data.domain} is ready to send` : `${check.data.domain} needs attention`} />
          <DnsReport report={check.data} />
        </div>
      )}
    </Card>
  );
}
