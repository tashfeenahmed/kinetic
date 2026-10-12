import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Globe, MoreHorizontal, Plus, Search, Upload } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtNumber } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import {
  Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Loading, Menu, Modal, ProgressBar, Select, Stat, Table, Td, Textarea, Th, useUi, cx,
} from '../components/ui.tsx';
import { SenderStatus, providerLabel } from '../components/status.tsx';
import { AddSenderModal } from './senders/AddSenderModal.tsx';
import { BulkImportModal } from './senders/BulkImportModal.tsx';
import { SenderDrawer } from './senders/SenderDrawer.tsx';
import { DnsChips } from './senders/DnsChecks.tsx';
import { useSenderActions } from './senders/actions.tsx';
import type { DomainReport, EgressRoute, Sender, Tag } from './senders/types.ts';

type BulkKind = 'limit' | 'signature' | 'route' | 'tag-add' | 'tag-remove';

export function SenderEmailsPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useUi();
  const { actions, modals } = useSenderActions();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [tagId, setTagId] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const [view, setView] = useState<'accounts' | 'domains'>('accounts');

  // Returning from the OAuth provider.
  useEffect(() => {
    const oauth = params.get('oauth');
    if (!oauth) return;
    toast(params.get('message') ?? (oauth === 'connected' ? 'Mailbox connected' : 'Connection failed'), oauth === 'connected' ? 'success' : 'error');
    qc.invalidateQueries({ queryKey: ['senders'] });
    setParams({}, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const senders = useQuery({
    queryKey: ['senders', search, status, tagId],
    queryFn: () => api.get('/api/sender-emails', { search, status, tag_id: tagId }).then((r) => r.data as Sender[]),
  });
  const all = useQuery({ queryKey: ['senders', 'all'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as Sender[]) });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api.get('/api/tags').then((r) => r.data as Tag[]) });

  const rows = senders.data ?? [];
  const totals = useMemo(() => {
    const list = all.data ?? [];
    const connected = list.filter((s) => s.status === 'Connected');
    return {
      connected: connected.length,
      disconnected: list.filter((s) => s.status === 'Disconnected').length,
      capacity: connected.reduce((n, s) => n + s.daily_limit, 0),
      warmup: list.filter((s) => s.warmup_enabled).length,
      total: list.length,
    };
  }, [all.data]);

  useEffect(() => { setSelected(new Set()); }, [search, status, tagId]);
  const ids = [...selected];
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (v: boolean) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set());
  const toggle = (id: number, v: boolean) => setSelected((s) => { const n = new Set(s); v ? n.add(id) : n.delete(id); return n; });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['senders'] }); qc.invalidateQueries({ queryKey: ['warmup'] }); };
  const warmup = async (enable: boolean) => {
    try {
      await api.patch(`/api/warmup/sender-emails/${enable ? 'enable' : 'disable'}`, { sender_email_ids: ids });
      toast(`Warmup ${enable ? 'enabled' : 'disabled'} for ${ids.length} mailbox${ids.length === 1 ? '' : 'es'}`);
      refresh();
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  return (
    <Page wide>
      {modals}
      <PageHeader
        title="Sender Emails"
        subtitle={`${fmtNumber(totals.connected)} connected · ${fmtNumber(totals.capacity)} emails a day · ${fmtNumber(totals.warmup)} warming up`}
        actions={<>
          <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>Bulk import</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add email account</Button>
        </>}
      />

      {totals.disconnected > 0 && (
        <div className="mb-6">
          <Alert tone="red">{totals.disconnected} {totals.disconnected === 1 ? 'mailbox is' : 'mailboxes are'} disconnected. Open the menu on the row and choose Reconnect.</Alert>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl bg-slate-100 p-1">
          {(['accounts', 'domains'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cx('rounded-lg px-3 py-1.5 text-sm font-medium', view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}>
              {v === 'accounts' ? 'Email accounts' : 'Domain health'}
            </button>
          ))}
        </div>
        {view === 'accounts' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input className="w-64 pl-9" placeholder="Search email or name" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
              <option value="">All statuses</option>
              <option value="Connected">Connected</option>
              <option value="Disconnected">Disconnected</option>
              <option value="Paused">Paused</option>
            </Select>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="w-40">
              <option value="">All tags</option>
              {tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
        )}
      </div>

      {view === 'domains' ? <DomainHealth /> : (
        <Card padded={false}>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-brand-50/60 px-4 py-2.5">
              <span className="mr-2 text-sm font-medium text-slate-700">{selected.size} selected</span>
              <Button size="sm" onClick={() => setBulk('limit')}>Set daily limit</Button>
              <Button size="sm" onClick={() => setBulk('signature')}>Set signature</Button>
              <Button size="sm" onClick={() => setBulk('route')}>Assign IP route</Button>
              <Button size="sm" onClick={() => warmup(true)}>Enable warmup</Button>
              <Button size="sm" onClick={() => warmup(false)}>Disable warmup</Button>
              <Button size="sm" onClick={() => setBulk('tag-add')}>Add tag</Button>
              <Button size="sm" onClick={() => setBulk('tag-remove')}>Remove tag</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}
          {senders.isLoading ? <Loading /> : rows.length === 0 ? (
            totals.total === 0 ? (
              <EmptyState icon={<AtSign className="size-5" />} title="No email accounts yet"
                description="Connect the mailboxes you send from. Google Workspace works with an app password; Microsoft 365 with a one-time sign-in."
                action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add email account</Button>} />
            ) : <EmptyState title="No matches" description="Try a different search or filter." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-10"><Checkbox checked={allChecked} indeterminate={selected.size > 0 && !allChecked} onChange={toggleAll} label="Select all" /></Th>
                  <Th>Email</Th>
                  <Th>Status</Th>
                  <Th>Sent (24h)</Th>
                  <Th>Warmup</Th>
                  <Th>IP route</Th>
                  <Th className="text-right">Replies</Th>
                  <Th className="text-right">Bounced</Th>
                  <Th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="cursor-pointer hover:bg-slate-50/70" onClick={() => setOpenId(s.id)}>
                    <Td><Checkbox checked={selected.has(s.id)} onChange={(v) => toggle(s.id, v)} label={`Select ${s.email}`} /></Td>
                    <Td>
                      <div className="font-medium text-slate-900">{s.name}</div>
                      <div className="text-[13px] text-slate-500">{s.email}</div>
                      {/* Only tags you added; the automatic provider tag is noise here. */}
                      {s.tags.some((t) => !t.default) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.tags.filter((t) => !t.default).map((t) => <Badge key={t.id}>{t.name}</Badge>)}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <SenderStatus status={s.status} />
                      {s.status === 'Disconnected' && s.last_error && <div className="mt-1 max-w-56 truncate text-xs text-red-600" title={s.last_error}>{s.last_error}</div>}
                    </Td>
                    <Td className="min-w-36">
                      <div className="mb-1 text-[13px] text-slate-700">{s.sent_last_24h} / {s.daily_limit}</div>
                      <ProgressBar value={(s.sent_last_24h / Math.max(1, s.daily_limit)) * 100} tone={s.sent_last_24h >= s.daily_limit ? 'yellow' : 'blue'} />
                    </Td>
                    <Td>{s.warmup_enabled ? <Badge tone="green" dot>On</Badge> : <Badge>Off</Badge>}</Td>
                    <Td className="text-[13px]">{s.egress_route?.name ?? <span className="text-slate-400">Default</span>}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(s.unique_replied_count)}</Td>
                    <Td className="text-right tabular-nums">{fmtNumber(s.bounced_count)}</Td>
                    <Td onClick={() => undefined}>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Menu
                          trigger={(open) => <IconButton label="Actions" onClick={open}><MoreHorizontal className="size-4" /></IconButton>}
                          items={[
                            { label: 'Open details', onClick: () => setOpenId(s.id) },
                            { label: 'Test connection', onClick: () => actions.testConnection(s) },
                            { label: 'Sync now', onClick: () => actions.syncNow(s) },
                            { label: 'Send test email', onClick: () => actions.sendTest(s) },
                            { label: s.status === 'Paused' ? 'Resume' : 'Pause', onClick: () => actions.togglePause(s) },
                            { label: 'Reconnect', onClick: () => actions.reconnect(s) },
                            'divider',
                            { label: 'Delete', danger: true, onClick: () => actions.remove(s) },
                          ]}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <AddSenderModal open={adding} onClose={() => setAdding(false)} />
      <BulkImportModal open={importing} onClose={() => setImporting(false)} />
      <SenderDrawer senderId={openId} onClose={() => setOpenId(null)} />
      <BulkModal kind={bulk} ids={ids} tags={tags.data ?? []} onClose={() => setBulk(null)} onDone={() => { setBulk(null); refresh(); qc.invalidateQueries({ queryKey: ['tags'] }); }} />
    </Page>
  );
}

function BulkModal({ kind, ids, tags, onClose, onDone }: { kind: BulkKind | null; ids: number[]; tags: Tag[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useUi();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const routes = useQuery({ queryKey: ['egress-routes'], queryFn: () => api.get('/api/egress-routes').then((r) => r.data as EgressRoute[]), enabled: kind === 'route' });
  useEffect(() => { setValue(kind === 'limit' ? '30' : ''); }, [kind]);
  if (!kind) return null;

  const count = `${ids.length} mailbox${ids.length === 1 ? '' : 'es'}`;
  const titles: Record<BulkKind, string> = { limit: 'Set daily limit', signature: 'Set signature', route: 'Assign IP route', 'tag-add': 'Add tag', 'tag-remove': 'Remove tag' };

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === 'limit') await api.patch('/api/sender-emails/daily-limits/bulk', { sender_email_ids: ids, daily_limit: Number(value) });
      if (kind === 'signature') await api.patch('/api/sender-emails/signatures/bulk', { sender_email_ids: ids, email_signature: value });
      if (kind === 'route') await api.patch('/api/sender-emails/egress/bulk', { sender_email_ids: ids, egress_route_id: value ? Number(value) : null });
      if (kind === 'tag-add' || kind === 'tag-remove') {
        let tagId = Number(value);
        if (kind === 'tag-add' && !tags.some((t) => t.id === tagId)) tagId = (await api.post('/api/tags', { name: value.trim() })).data.id;
        await api.post(`/api/tags/${kind === 'tag-add' ? 'attach-to' : 'remove-from'}-sender-emails`, { tag_ids: [tagId], sender_email_ids: ids });
      }
      toast(`${titles[kind]}: updated ${count}`);
      onDone();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  let field;
  if (kind === 'limit') field = <Field label="Emails per day" hint="Per mailbox. 25–40 keeps cold mailboxes healthy."><Input type="number" min={1} max={2000} autoFocus value={value} onChange={(e) => setValue(e.target.value)} /></Field>;
  else if (kind === 'signature') field = <Field label="Signature" hint="Replaces the current signature on every selected mailbox. Use {SENDER_NAME} in campaign bodies for per-mailbox names."><Textarea rows={5} autoFocus value={value} onChange={(e) => setValue(e.target.value)} /></Field>;
  else if (kind === 'route') field = (
    <Field label="IP route">
      <Select value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Server default</option>
        {routes.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
    </Field>
  );
  else field = (
    <Field label="Tag" hint={kind === 'tag-add' ? 'Pick an existing tag or type a new name.' : undefined}>
      {kind === 'tag-add' ? (
        <>
          <Input list="eb-tag-list" autoFocus value={tags.find((t) => String(t.id) === value)?.name ?? value} onChange={(e) => { const t = tags.find((x) => x.name === e.target.value); setValue(t ? String(t.id) : e.target.value); }} placeholder="e.g. Batch 3" />
          <datalist id="eb-tag-list">{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        </>
      ) : (
        <Select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose a tag</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )}
    </Field>
  );

  const valid = kind === 'route' || kind === 'signature' || (kind === 'limit' ? Number(value) > 0 : !!value.trim());
  return (
    <Modal open onClose={onClose} size="sm" title={titles[kind]} description={`Applies to ${count}.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>Apply</Button></>}>
      {field}
    </Modal>
  );
}

function DomainHealth() {
  const { toast } = useUi();
  const [reports, setReports] = useState<DomainReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setReports((await api.get('/api/sender-emails/domains/health')).data); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  const bad = reports?.filter((r) => !r.ok).length ?? 0;
  return (
    <Card title="Domain health" description="Checks MX, SPF, DKIM and DMARC for every domain you send from. Missing records are the most common reason cold email lands in spam."
      actions={<Button variant="primary" size="sm" icon={<Globe className="size-4" />} loading={busy} onClick={run}>{reports ? 'Re-check all' : 'Check all domains'}</Button>}
      padded={false}>
      {!reports ? (
        <p className="px-5 py-6 text-sm text-slate-500">Runs live DNS lookups, so it takes a few seconds for many domains.</p>
      ) : reports.length === 0 ? (
        <EmptyState title="No sending domains yet" description="Add an email account first." />
      ) : (
        <>
          <div className={cx('px-5 py-3 text-sm', bad ? 'text-amber-800' : 'text-emerald-700')}>
            {bad ? `${bad} of ${reports.length} domains have missing or broken records — hover a chip to see what to fix.` : `All ${reports.length} domains look good.`}
          </div>
          <Table>
            <thead><tr><Th>Domain</Th><Th>Records</Th><Th>What to fix</Th></tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.domain}>
                  <Td className="font-medium text-slate-900">{r.domain}</Td>
                  <Td><DnsChips report={r} /></Td>
                  <Td className="max-w-md text-[13px] text-slate-600">
                    {r.checks.filter((c) => c.status !== 'pass').map((c) => <div key={c.name}><b>{c.name}:</b> {c.advice}</div>)}
                    {r.checks.every((c) => c.status === 'pass') && <span className="text-slate-400">Nothing</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}
