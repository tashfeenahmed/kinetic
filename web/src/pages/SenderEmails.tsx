import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, ChevronDown, ChevronRight, Globe, MoreHorizontal, Plus, Search, Upload } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtNumber } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import {
  Alert, Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Loading, Menu, Modal, ProgressBar, Select, Textarea, useUi, cx,
} from '../components/ui.tsx';
import { SenderStatus } from '../components/status.tsx';
import { AddSenderModal } from './senders/AddSenderModal.tsx';
import { BulkImportModal } from './senders/BulkImportModal.tsx';
import { SenderDrawer } from './senders/SenderDrawer.tsx';
import { useSenderActions } from './senders/actions.tsx';
import { DOMAIN_STATUS, DomainDrawer, DomainSetupModal, HealthPills, isFreeMail, type DomainReportLite, type DomainRow, type Setup } from './senders/DomainSetup.tsx';
import type { EgressRoute, Sender, Tag } from './senders/types.ts';

type BulkKind = 'limit' | 'signature' | 'route' | 'tag-add' | 'tag-remove';
interface Group { domain: string; row: DomainRow; senders: Sender[] }
type MenuItems = Parameters<typeof Menu>[0]['items'];

const domainOf = (email: string) => email.slice(email.indexOf('@') + 1).toLowerCase();
const COLS = 9;
const rank = (g: Group) => (isFreeMail(g.domain) ? 3 : g.row.id == null ? 2 : g.row.mailboxes > 0 ? 0 : 1);

function readPref(key: string, fallback: boolean) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === '1'; } catch { return fallback; }
}
function writePref(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private window */ }
}

/** Mailboxes first, grouped under their sending domain; domains are set up (Cloudflare DNS) from here too. */
export function SenderEmailsPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const { actions, modals } = useSenderActions();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [tagId, setTagId] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const [grouped, setGrouped] = useState(() => readPref('senders-grouped', true));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [setup, setSetup] = useState<{ initial?: Partial<Setup>; review?: boolean } | null>(null);
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  // Returning from the OAuth provider.
  useEffect(() => {
    const oauth = params.get('oauth');
    if (!oauth) return;
    toast(params.get('message') ?? (oauth === 'connected' ? 'Mailbox connected' : 'Connection failed'), oauth === 'connected' ? 'success' : 'error');
    qc.invalidateQueries({ queryKey: ['senders'] });
    qc.invalidateQueries({ queryKey: ['domains'] });
    setParams({}, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const senders = useQuery({
    queryKey: ['senders', search, status, tagId],
    queryFn: () => api.get('/api/sender-emails', { search, status, tag_id: tagId }).then((r) => r.data as Sender[]),
  });
  const all = useQuery({ queryKey: ['senders', 'all'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as Sender[]) });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api.get('/api/tags').then((r) => r.data as Tag[]) });
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<{ data: DomainRow[]; meta: { cloudflare_connected: boolean; tracking_target: string | null } }>('/api/domains') });

  // Domains Kinetic doesn't manage have no stored report: look their DNS up live (read-only, cached).
  const unmanaged = (domains.data?.data ?? []).filter((d) => d.id == null && !isFreeMail(d.domain)).map((d) => d.domain);
  const live = useQueries({
    queries: unmanaged.map((d) => ({
      queryKey: ['domain-dns', d], staleTime: 15 * 60_000, retry: false,
      queryFn: () => api.post('/api/domains/check', { domain: d }).then((r) => r.data as DomainReportLite),
    })),
  });
  const liveBy = new Map(unmanaged.map((d, i) => [d, live[i]!]));
  const reportOf = (d: DomainRow) => (d.id != null ? d.report : liveBy.get(d.domain)?.data ?? null);

  const rows = senders.data ?? [];
  const filtered = !!(search || status || tagId);
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

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const d of domains.data?.data ?? []) map.set(d.domain.toLowerCase(), { domain: d.domain.toLowerCase(), row: d, senders: [] });
    for (const s of rows) {
      const key = domainOf(s.email);
      if (!map.has(key)) map.set(key, { domain: key, row: { id: null, domain: key, status: 'unmanaged', setup: {}, report: null, mailboxes: 0, connected_mailboxes: 0 }, senders: [] });
      map.get(key)!.senders.push(s);
    }
    const q = search.trim().toLowerCase();
    return [...map.values()]
      // While filtering, only groups with matches (or whose name matches the search) stay.
      .filter((g) => !filtered || g.senders.length > 0 || (!!q && !status && !tagId && g.domain.includes(q)))
      // Managed domains with mailboxes, then managed ones still empty, then unmanaged, then personal mail.
      .sort((a, b) => rank(a) - rank(b) || a.domain.localeCompare(b.domain));
  }, [domains.data, rows, filtered, search, status, tagId]);

  useEffect(() => { setSelected(new Set()); }, [search, status, tagId]);
  const ids = [...selected];
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (v: boolean) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set());
  const toggle = (id: number, v: boolean) => setSelected((s) => { const n = new Set(s); v ? n.add(id) : n.delete(id); return n; });
  const toggleMany = (list: number[], v: boolean) => setSelected((s) => { const n = new Set(s); for (const id of list) v ? n.add(id) : n.delete(id); return n; });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['senders'] }); qc.invalidateQueries({ queryKey: ['warmup'] }); qc.invalidateQueries({ queryKey: ['domains'] }); };
  const warmup = async (enable: boolean) => {
    try {
      await api.patch(`/api/warmup/sender-emails/${enable ? 'enable' : 'disable'}`, { sender_email_ids: ids });
      toast(`Warmup ${enable ? 'enabled' : 'disabled'} for ${ids.length} mailbox${ids.length === 1 ? '' : 'es'}`);
      refresh();
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const checkDns = async (d: DomainRow) => {
    setChecking(d.domain);
    try {
      if (d.id != null) { await api.post(`/api/domains/${d.id}/check`); await qc.invalidateQueries({ queryKey: ['domains'] }); }
      else await liveBy.get(d.domain)?.refetch();
      toast(`DNS checked for ${d.domain}`);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setChecking(null); }
  };
  const stopManaging = async (d: DomainRow) => {
    if (!(await confirm({ title: `Stop managing ${d.domain}?`, message: 'It is removed from Kinetic only. Its DNS records stay in Cloudflare and its mailboxes keep working.', confirmLabel: 'Stop managing', danger: true }))) return;
    try { await api.del(`/api/domains/${d.id}`); toast(`${d.domain} is no longer managed`); setOpenDomain(null); refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const setUpDns = (d: DomainRow, review = false) => setSetup({ initial: { ...d.setup, domain: d.domain, ...(d.provider ? { provider: d.provider } : {}) }, review });
  const domainMenu = (d: DomainRow): MenuItems => {
    const free = isFreeMail(d.domain);
    const items: MenuItems = [];
    if (!free) items.push({ label: 'Check DNS again', onClick: () => checkDns(d) });
    items.push({ label: 'View records', onClick: () => setOpenDomain(d.domain.toLowerCase()) });
    if (d.id != null) items.push({ label: 'View / apply DNS plan', onClick: () => setUpDns(d, true) }, { label: 'Edit setup', onClick: () => setUpDns(d) });
    else if (!free) items.push({ label: 'Set up DNS', onClick: () => setUpDns(d) });
    items.push({ label: 'Add mailbox', onClick: () => setAdding(true) });
    if (d.id != null) items.push('divider', { label: 'Stop managing', danger: true, onClick: () => stopManaging(d) });
    return items;
  };

  const loading = senders.isLoading || domains.isLoading;
  const nothing = totals.total === 0 && !domains.data?.data.length;
  const drawerRow = openDomain ? groups.find((g) => g.domain === openDomain)?.row ?? domains.data?.data.find((d) => d.domain.toLowerCase() === openDomain) ?? null : null;

  const senderRow = (s: Sender) => (
    <tr key={s.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setOpenId(s.id)}>
      <C className="w-10 pl-4"><Checkbox checked={selected.has(s.id)} onChange={(v) => toggle(s.id, v)} label={`Select ${s.email}`} /></C>
      <C className={grouped ? 'pl-8' : ''}>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-zinc-900">{s.email}</span>
          {s.name && <span className="truncate text-[12.5px] text-zinc-400">{s.name}</span>}
          {/* Only tags you added; the automatic provider tag is noise here. */}
          {s.tags.filter((t) => !t.default).map((t) => <Badge key={t.id}>{t.name}</Badge>)}
        </div>
      </C>
      <C>
        <SenderStatus status={s.status} />
        {s.status === 'Disconnected' && s.last_error && <div className="mt-0.5 max-w-56 truncate text-xs text-red-600" title={s.last_error}>{s.last_error}</div>}
      </C>
      <C className="min-w-32">
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 tabular-nums text-zinc-700">{s.sent_last_24h} / {s.daily_limit}</span>
          <div className="w-16"><ProgressBar value={(s.sent_last_24h / Math.max(1, s.daily_limit)) * 100} tone={s.sent_last_24h >= s.daily_limit ? 'yellow' : 'blue'} /></div>
        </div>
      </C>
      <C>{s.warmup_enabled ? <Badge tone="green" dot>On</Badge> : <Badge>Off</Badge>}</C>
      <C>{s.egress_route?.name ?? <span className="text-zinc-400">Default</span>}</C>
      <C className="text-right tabular-nums">{fmtNumber(s.unique_replied_count)}</C>
      <C className="text-right tabular-nums">{fmtNumber(s.bounced_count)}</C>
      <C className="w-12 pr-3">
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
      </C>
    </tr>
  );

  const groupHeader = (g: Group) => {
    const d = g.row;
    const managed = d.id != null;
    const free = isFreeMail(g.domain);
    const open = !collapsed.has(g.domain);
    const groupIds = g.senders.map((s) => s.id);
    const every = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
    const some = groupIds.some((id) => selected.has(id));
    const lookup = liveBy.get(d.domain);
    const count = filtered && g.senders.length !== d.mailboxes ? `${g.senders.length} of ${d.mailboxes}` : `${d.mailboxes}`;
    return (
      <tr className="bg-zinc-50/80">
        <td className="w-10 border-b border-zinc-200 py-1.5 pl-4">{groupIds.length > 0 && <Checkbox checked={every} indeterminate={some && !every} onChange={(v) => toggleMany(groupIds, v)} label={`Select all on ${g.domain}`} />}</td>
        <td colSpan={COLS - 1} className="border-b border-zinc-200 py-1.5 pl-3 pr-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <button onClick={() => setCollapsed((c) => { const n = new Set(c); open ? n.add(g.domain) : n.delete(g.domain); return n; })}
              className="flex min-w-0 items-center gap-1.5 text-left" aria-expanded={open}>
              {open ? <ChevronDown className="size-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="size-3.5 shrink-0 text-zinc-400" />}
              <span className="truncate text-[13px] font-semibold text-zinc-900">{g.domain}</span>
            </button>
            {free ? <span className="text-[12px] text-zinc-400">Personal mailbox provider</span> : (
              <button onClick={() => setOpenDomain(g.domain)} title="DNS records and checks" className="shrink-0">
                <HealthPills checks={reportOf(d)?.checks} loading={checking === d.domain || !!lookup?.isFetching} />
              </button>
            )}
            {managed && d.status !== 'verified' && <Badge tone={DOMAIN_STATUS[d.status].tone}>{DOMAIN_STATUS[d.status].label}</Badge>}
            <span className="shrink-0 text-[12px] text-zinc-500">{count} mailbox{d.mailboxes === 1 ? '' : 'es'}{d.mailboxes > 0 && d.connected_mailboxes < d.mailboxes ? ` · ${d.connected_mailboxes} connected` : ''}</span>
            {!managed && !free && (
              <span className="hidden shrink-0 text-[12px] text-zinc-400 sm:inline">
                DNS not managed by Kinetic · <button className="text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900" onClick={() => setUpDns(d)}>Set up DNS</button>
              </span>
            )}
            <span className="flex-1" />
            <Menu trigger={(t) => <IconButton label={`${g.domain} actions`} onClick={t}><MoreHorizontal className="size-4" /></IconButton>} items={domainMenu(d)} />
          </div>
        </td>
      </tr>
    );
  };

  return (
    <Page wide>
      {modals}
      <PageHeader
        title="Sender Emails"
        subtitle={`${fmtNumber(totals.connected)} connected · ${fmtNumber(totals.capacity)} emails a day · ${fmtNumber(totals.warmup)} warming up`}
        actions={<>
          <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>Bulk import</Button>
          <Button icon={<Globe className="size-4" />} onClick={() => setSetup({})}>Add domain</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add email account</Button>
        </>}
      />

      {totals.disconnected > 0 && (
        <div className="mb-5">
          <Alert tone="red">{totals.disconnected} {totals.disconnected === 1 ? 'mailbox is' : 'mailboxes are'} disconnected. Open the menu on the row and choose Reconnect.</Alert>
        </div>
      )}

      {/* Edge to edge, like the Master Inbox: the list runs to the page edges. */}
      <div className="-mx-4 sm:-mx-8">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 pb-3 sm:px-8">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <Input className="h-8 w-60 pl-8 text-[13px]" placeholder="Search mailboxes or domains" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-36 text-[13px]">
            <option value="">All statuses</option>
            <option value="Connected">Connected</option>
            <option value="Disconnected">Disconnected</option>
            <option value="Paused">Paused</option>
          </Select>
          <Select value={tagId} onChange={(e) => setTagId(e.target.value)} className="h-8 w-36 text-[13px]">
            <option value="">All tags</option>
            {tags.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <span className="flex-1" />
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-zinc-600">
            <Checkbox checked={grouped} onChange={(v) => { setGrouped(v); writePref('senders-grouped', v); }} label="Group by domain" />
            Group by domain
          </label>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-brand-50/60 px-4 py-2 sm:px-8">
            <span className="mr-2 text-[13px] font-medium text-zinc-700">{selected.size} selected</span>
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

        {loading ? <Loading /> : nothing ? (
          <EmptyState icon={<AtSign className="size-5" />} title="No email accounts yet"
            description="Connect the mailboxes you send from. Google Workspace works with an app password; Microsoft 365 with a one-time sign-in. Use separate domains for cold email, never your main company domain."
            action={<div className="flex gap-2"><Button icon={<Globe className="size-4" />} onClick={() => setSetup({})}>Add domain</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add email account</Button></div>} />
        ) : (grouped ? groups.length === 0 : rows.length === 0) ? (
          <EmptyState title="No matches" description="Try a different search or filter." />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="text-[12px] text-zinc-500">
                  <H className="w-10 pl-4"><Checkbox checked={allChecked} indeterminate={selected.size > 0 && !allChecked} onChange={toggleAll} label="Select all" /></H>
                  <H>Email</H><H>Status</H><H>Sent (24h)</H><H>Warmup</H><H>IP route</H>
                  <H className="text-right">Replies</H><H className="text-right">Bounced</H><H className="w-12 pr-3" />
                </tr>
              </thead>
              <tbody>
                {grouped ? groups.map((g) => (
                  <Fragment key={g.domain}>
                    {groupHeader(g)}
                    {!collapsed.has(g.domain) && (g.senders.length ? g.senders.map(senderRow) : (
                      <tr>
                        <td className="border-b border-zinc-100" />
                        <td colSpan={COLS - 1} className="border-b border-zinc-100 py-2.5 pl-8 text-[13px] text-zinc-400">
                          No mailboxes on {g.domain} yet. <button className="font-medium text-brand-600 hover:underline" onClick={() => setAdding(true)}>Add mailbox</button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                )) : rows.map(senderRow)}
              </tbody>
            </table>
          </div>
        )}
        {domains.data && !domains.data.meta.cloudflare_connected && !loading && !nothing && (
          <p className="px-4 pt-4 text-[12.5px] text-zinc-400 sm:px-8">Connect Cloudflare from Add domain and Kinetic writes MX, SPF, DKIM and DMARC for your sending domains.</p>
        )}
      </div>

      <AddSenderModal open={adding} onClose={() => setAdding(false)} />
      <BulkImportModal open={importing} onClose={() => setImporting(false)} />
      <SenderDrawer senderId={openId} onClose={() => setOpenId(null)} />
      <BulkModal kind={bulk} ids={ids} tags={tags.data ?? []} onClose={() => setBulk(null)} onDone={() => { setBulk(null); refresh(); qc.invalidateQueries({ queryKey: ['tags'] }); }} />
      {setup && <DomainSetupModal initial={setup.initial} review={setup.review} trackingTarget={domains.data?.meta.tracking_target ?? null} onClose={() => setSetup(null)} />}
      <DomainDrawer domain={drawerRow} report={drawerRow ? reportOf(drawerRow) : null}
        checking={!!drawerRow && (checking === drawerRow.domain || !!liveBy.get(drawerRow.domain)?.isFetching)}
        onClose={() => setOpenDomain(null)}
        onCheck={() => drawerRow && checkDns(drawerRow)}
        onSetup={() => drawerRow && setUpDns(drawerRow)}
        onReview={() => drawerRow && setUpDns(drawerRow, true)}
        onRemove={() => drawerRow && stopManaging(drawerRow)} />
    </Page>
  );
}

/** Compact header and body cells for the edge-to-edge list. */
const H = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cx('whitespace-nowrap border-b border-zinc-200 px-3 py-2 font-medium', className)}>{children}</th>
);
const C = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('border-b border-zinc-100 px-3 py-2 align-middle text-zinc-700', className)}>{children}</td>
);

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
