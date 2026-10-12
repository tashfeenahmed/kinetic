import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Network, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Menu, Modal, Select, Table, Td, Th, useUi } from '../../components/ui.tsx';
import type { EgressRoute } from '../senders/types.ts';

type RouteType = 'socks' | 'http' | 'local';

function routeType(r: EgressRoute): RouteType {
  if (r.local_address && !r.proxy_url) return 'local';
  return r.proxy_url?.startsWith('http') ? 'http' : 'socks';
}

export function IpRoutes() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [editing, setEditing] = useState<EgressRoute | 'new' | null>(null);
  const [checks, setChecks] = useState<Record<number, { loading?: boolean; ip?: string; error?: string }>>({});
  const q = useQuery({ queryKey: ['egress-routes'], queryFn: () => api.get('/api/egress-routes').then((r) => r.data as EgressRoute[]) });

  const check = async (r: EgressRoute) => {
    setChecks((c) => ({ ...c, [r.id]: { loading: true } }));
    try {
      const res = (await api.post(`/api/egress-routes/${r.id}/check`)).data;
      setChecks((c) => ({ ...c, [r.id]: res.ok ? { ip: res.ip } : { error: res.error } }));
    } catch (e) { setChecks((c) => ({ ...c, [r.id]: { error: errorMessage(e) } })); }
  };
  const remove = async (r: EgressRoute) => {
    if (!(await confirm({ title: 'Delete IP route?', message: r.sender_count ? `${r.sender_count} mailboxes use it and will fall back to the server's default IP.` : undefined, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/egress-routes/${r.id}`); toast('IP route deleted'); qc.invalidateQueries({ queryKey: ['egress-routes'] }); qc.invalidateQueries({ queryKey: ['senders'] }); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <Card title="Sending IPs" padded={false}
      description="Mailboxes log in to Google and Microsoft from these IPs. Keep each mailbox on the same IP — a sudden change looks like a suspicious login. About 30 mailboxes per IP is a good ceiling."
      actions={<Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add IP route</Button>}>
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <EmptyState icon={<Network className="size-5" />} title="Using the server's own IP"
          description="Add a SOCKS5 proxy or a second IP on this server to spread mailboxes across static IPs. Then assign mailboxes on the Sender Emails page."
          action={<Button onClick={() => setEditing('new')}>Add IP route</Button>} />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Type</Th><Th>Address</Th><Th className="text-right">Mailboxes</Th><Th>Public IP</Th><Th className="w-12" /></tr></thead>
          <tbody>
            {q.data.map((r) => {
              const c = checks[r.id];
              return (
                <tr key={r.id}>
                  <Td className="font-medium text-slate-900">{r.name}</Td>
                  <Td><Badge>{{ socks: 'SOCKS proxy', http: 'HTTP proxy', local: 'Local IP' }[routeType(r)]}</Badge></Td>
                  <Td className="font-mono text-xs text-slate-600">{r.proxy_url ?? r.local_address}</Td>
                  <Td className="text-right tabular-nums">{r.sender_count}</Td>
                  <Td className="text-[13px]">
                    {c?.loading ? <span className="text-slate-400">Checking…</span>
                      : c?.ip ? <span className="font-mono text-emerald-700">{c.ip}</span>
                      : c?.error ? <span className="text-red-600" title={c.error}>Failed: {c.error.slice(0, 50)}</span>
                      : <button className="font-medium text-brand-600 hover:underline" onClick={() => check(r)}>Check IP</button>}
                  </Td>
                  <Td>
                    <Menu trigger={(open) => <IconButton label="Actions" onClick={open}><MoreHorizontal className="size-4" /></IconButton>}
                      items={[{ label: 'Check IP', onClick: () => check(r) }, { label: 'Edit', onClick: () => setEditing(r) }, 'divider', { label: 'Delete', danger: true, onClick: () => remove(r) }]} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <RouteModal route={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function RouteModal({ route, onClose }: { route: EgressRoute | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const existing = route && route !== 'new' ? route : null;
  const key = existing ? existing.id : route;
  return route ? <RouteForm key={String(key)} existing={existing} onClose={onClose} onSaved={() => { qc.invalidateQueries({ queryKey: ['egress-routes'] }); toast(existing ? 'IP route updated' : 'IP route added'); onClose(); }} /> : null;
}

function RouteForm({ existing, onClose, onSaved }: { existing: EgressRoute | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<RouteType>(existing ? routeType(existing) : 'socks');
  const [value, setValue] = useState(existing?.proxy_url ?? existing?.local_address ?? '');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), proxy_url: type === 'local' ? null : value.trim(), local_address: type === 'local' ? value.trim() : null };
      return existing ? api.put(`/api/egress-routes/${existing.id}`, body) : api.post('/api/egress-routes', body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });
  const placeholder = { socks: 'socks5://user:password@203.0.113.10:1080', http: 'http://user:password@203.0.113.10:3128', local: '203.0.113.11' }[type];
  return (
    <Modal open onClose={onClose} size="md" title={existing ? 'Edit IP route' : 'Add IP route'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim() || !value.trim()} onClick={() => { setError(''); save.mutate(); }}>Save</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="IP 1 — Frankfurt" /></Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => { setType(e.target.value as RouteType); setValue(''); }}>
            <option value="socks">SOCKS5 proxy (a small VPS with a static IP)</option>
            <option value="http">HTTP proxy</option>
            <option value="local">Local IP (this server has several IPs)</option>
          </Select>
        </Field>
        <Field label={type === 'local' ? 'IP address' : 'Proxy URL'} hint={type === 'local' ? 'Must be an address assigned to this machine.' : existing ? 'The password is hidden; leave it as shown to keep it.' : 'Stored encrypted and only used when mailboxes connect.'}>
          <Input className="font-mono text-[13px]" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
        </Field>
      </div>
    </Modal>
  );
}
