import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtDate } from '../../lib/format.ts';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal, Select, Table, Td, Th, Toggle, useUi } from '../../components/ui.tsx';

interface Seed { id: number; provider: string; email: string; imap_server: string; imap_port: number; imap_secure: number; username: string; created_at: string }

const PRESETS: Record<string, { host: string; hint: string }> = {
  gmail: { host: 'imap.gmail.com', hint: 'Use an app password (2-Step Verification must be on).' },
  outlook: { host: 'outlook.office365.com', hint: 'Outlook.com / Hotmail accounts need an app password from account.microsoft.com/security.' },
  yahoo: { host: 'imap.mail.yahoo.com', hint: 'Generate an app password under Yahoo Account Security.' },
  other: { host: '', hint: 'Any mailbox with IMAP access.' },
};

export function SeedAccounts() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['seed-accounts'], queryFn: () => api.get('/api/seed-accounts').then((r) => r.data as Seed[]) });

  const remove = async (s: Seed) => {
    if (!(await confirm({ title: 'Remove seed inbox?', message: s.email, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.del(`/api/seed-accounts/${s.id}`); toast('Seed inbox removed'); qc.invalidateQueries({ queryKey: ['seed-accounts'] }); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <Card title="Inbox placement seed inboxes" padded={false}
      description="Test inboxes you own at Gmail, Outlook, Yahoo and others. Placement tests (on each campaign) send to these and check over IMAP whether you land in the inbox or spam."
      actions={<Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add seed inbox</Button>}>
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <EmptyState icon={<FlaskConical className="size-5" />} title="No seed inboxes yet"
          description="Add a personal Gmail, an Outlook.com and a Yahoo account for a realistic picture across providers."
          action={<Button onClick={() => setAdding(true)}>Add seed inbox</Button>} />
      ) : (
        <Table>
          <thead><tr><Th>Provider</Th><Th>Email</Th><Th>IMAP</Th><Th>Added</Th><Th className="w-12" /></tr></thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id}>
                <Td><Badge tone="blue">{s.provider}</Badge></Td>
                <Td className="font-medium text-slate-900">{s.email}</Td>
                <Td className="font-mono text-xs text-slate-600">{s.imap_server}:{s.imap_port}</Td>
                <Td className="text-[13px]">{fmtDate(s.created_at)}</Td>
                <Td><IconButton label="Remove" onClick={() => remove(s)}><Trash2 className="size-4" /></IconButton></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {adding && <AddSeedModal onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddSeedModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [f, setF] = useState({ provider: 'gmail', email: '', username: '', password: '', imap_server: PRESETS.gmail!.host, imap_port: 993, imap_secure: true });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.post('/api/seed-accounts', { ...f, username: f.username || undefined }),
    onSuccess: () => { toast('Seed inbox added'); qc.invalidateQueries({ queryKey: ['seed-accounts'] }); onClose(); },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal open onClose={onClose} title="Add seed inbox" description="We log in over IMAP to confirm access before saving."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.email || !f.password || !f.imap_server} onClick={() => { setError(''); save.mutate(); }}>Add inbox</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Provider" hint={PRESETS[f.provider]?.hint}>
          <Select value={f.provider} onChange={(e) => { const p = e.target.value; setF((x) => ({ ...x, provider: p, imap_server: PRESETS[p]?.host ?? '', imap_port: 993, imap_secure: true })); }}>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook / Hotmail</option>
            <option value="yahoo">Yahoo</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email"><Input type="email" autoFocus value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Username" hint="Defaults to the email"><Input value={f.username} onChange={(e) => set('username', e.target.value)} /></Field>
        </div>
        <Field label="Password / app password"><Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_96px] gap-4">
          <Field label="IMAP host"><Input value={f.imap_server} onChange={(e) => set('imap_server', e.target.value)} /></Field>
          <Field label="Port"><Input type="number" value={f.imap_port} onChange={(e) => set('imap_port', Number(e.target.value))} /></Field>
        </div>
        <Toggle checked={f.imap_secure} onChange={(v) => set('imap_secure', v)} label="Use SSL" />
      </div>
    </Modal>
  );
}
