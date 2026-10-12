import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flame, Inbox, RefreshCw, Reply, ShieldCheck, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtDate, fmtNumber, fmtPct } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Button, Card, Checkbox, EmptyState, Field, Input, Loading, Modal, Select, Stat, Table, Td, Th, Toggle, useUi } from '../components/ui.tsx';
import { SenderStatus } from '../components/status.tsx';
import { HealthBadge } from './warmup/HealthBadge.tsx';
import { WarmupDrawer } from './warmup/WarmupDrawer.tsx';
import type { WarmupStats } from './senders/types.ts';

interface WarmupRow {
  id: number; name: string; email: string; provider: string; status: string;
  warmup_enabled: boolean; warmup_daily_limit: number; warmup_reply_rate: number; warmup_started_at: string | null;
  today_target: number; stats: WarmupStats;
}

function PlacementBar({ inbox, spam }: { inbox: number; spam: number }) {
  const total = inbox + spam;
  if (!total) return <span className="text-[13px] text-slate-400">—</span>;
  return (
    <div className="w-32">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-500" style={{ width: `${(inbox / total) * 100}%` }} />
        <div className="bg-red-500" style={{ width: `${(spam / total) * 100}%` }} />
      </div>
      <div className="mt-1 text-xs text-slate-500">{inbox} inbox · {spam} spam</div>
    </div>
  );
}

export function WarmupPage() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);

  const q = useQuery({
    queryKey: ['warmup', 'list'],
    queryFn: () => api.get('/api/warmup/sender-emails') as Promise<{ data: WarmupRow[]; meta: { pool_size: number } }>,
    refetchInterval: 60_000,
  });
  const rows = q.data?.data ?? [];
  const pool = q.data?.meta.pool_size ?? 0;

  const totals = useMemo(() => {
    const on = rows.filter((r) => r.warmup_enabled);
    const sum = (k: keyof WarmupStats) => rows.reduce((n, r) => n + ((r.stats[k] as number) ?? 0), 0);
    const placed = sum('landed_inbox') + sum('landed_spam');
    return { warming: on.length, sent: sum('sent'), inboxRate: placed ? (sum('landed_inbox') / placed) * 100 : null, rescued: sum('rescued') };
  }, [rows]);

  const setWarmup = async (ids: number[], enable: boolean) => {
    try {
      await api.patch(`/api/warmup/sender-emails/${enable ? 'enable' : 'disable'}`, { sender_email_ids: ids });
      toast(`Warmup ${enable ? 'enabled' : 'disabled'}${ids.length > 1 ? ` for ${ids.length} mailboxes` : ''}`);
      qc.invalidateQueries({ queryKey: ['warmup'] });
      qc.invalidateQueries({ queryKey: ['senders'] });
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const ids = [...selected];
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <Page wide>
      <PageHeader
        title="Email Warmup"
        subtitle={`${pool} ${pool === 1 ? 'mailbox' : 'mailboxes'} in your pool · they email each other and land in the "Kinetic Warmup" folder`}
      />

      {pool < 2 && (
        <div className="mb-6"><Alert tone="yellow">Turn on warmup for at least 2 mailboxes — they need each other to exchange emails.</Alert></div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="Warming" value={fmtNumber(totals.warming)} />
        <Stat label="Sent (7 days)" value={fmtNumber(totals.sent)} />
        <Stat label="Inbox placement" value={totals.inboxRate === null ? '—' : fmtPct(totals.inboxRate)} tone={totals.inboxRate !== null && totals.inboxRate < 90 ? 'red' : undefined} />
        <Stat label="Rescued from spam" value={fmtNumber(totals.rescued)} />
      </div>

      <Card padded={false}>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-brand-50/60 px-4 py-2.5">
            <span className="mr-2 text-sm font-medium text-slate-700">{selected.size} selected</span>
            <Button size="sm" onClick={() => setWarmup(ids, true)}>Enable warmup</Button>
            <Button size="sm" onClick={() => setWarmup(ids, false)}>Disable warmup</Button>
            <Button size="sm" onClick={() => setLimitsOpen(true)}>Set limits</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        {q.isLoading ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={<Inbox className="size-5" />} title="No mailboxes yet" description="Add email accounts first, then turn on warmup here."
            action={<Link to="/sender-emails"><Button variant="primary">Add email accounts</Button></Link>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10"><Checkbox checked={allChecked} indeterminate={selected.size > 0 && !allChecked} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} label="Select all" /></Th>
                <Th>Mailbox</Th>
                <Th>Status</Th>
                <Th>Warmup</Th>
                <Th>Today</Th>
                <Th className="text-right">Sent 7d</Th>
                <Th className="text-right">Received 7d</Th>
                <Th>Inbox vs spam</Th>
                <Th>Health</Th>
                <Th className="text-right">Replies</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50/70" onClick={() => setOpenId(r.id)}>
                  <Td><Checkbox checked={selected.has(r.id)} onChange={(v) => setSelected((s) => { const n = new Set(s); v ? n.add(r.id) : n.delete(r.id); return n; })} label={`Select ${r.email}`} /></Td>
                  <Td><div className="font-medium text-slate-900">{r.name}</div><div className="text-[13px] text-slate-500">{r.email}</div></Td>
                  <Td><SenderStatus status={r.status} /></Td>
                  <Td><div onClick={(e) => e.stopPropagation()}><Toggle checked={r.warmup_enabled} onChange={(v) => setWarmup([r.id], v)} /></div></Td>
                  <Td className="whitespace-nowrap text-[13px]">{r.warmup_enabled ? `${r.today_target} / ${r.warmup_daily_limit}` : <span className="text-slate-400">—</span>}</Td>
                  <Td className="text-right tabular-nums">{r.stats.sent}</Td>
                  <Td className="text-right tabular-nums">{r.stats.received}</Td>
                  <Td><PlacementBar inbox={r.stats.landed_inbox} spam={r.stats.landed_spam} /></Td>
                  <Td><HealthBadge score={r.stats.health_score} /></Td>
                  <Td className="text-right tabular-nums">{r.stats.replies_sent}</Td>
                  <Td className="whitespace-nowrap text-[13px]">{r.warmup_started_at ? fmtDate(r.warmup_started_at) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <WarmupSettings />
      <LimitsModal open={limitsOpen} ids={ids} rows={rows} onClose={() => setLimitsOpen(false)} />
      <WarmupDrawer senderId={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}

function LimitsModal({ open, ids, rows, onClose }: { open: boolean; ids: number[]; rows: WarmupRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const first = rows.find((r) => r.id === ids[0]);
  const [limit, setLimit] = useState(20);
  const [rate, setRate] = useState(35);
  useEffect(() => { if (open && first) { setLimit(first.warmup_daily_limit); setRate(first.warmup_reply_rate); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api.patch('/api/warmup/sender-emails/update-daily-warmup-limits', { sender_email_ids: ids, daily_limit: limit, daily_reply_limit: rate }),
    onSuccess: () => { toast('Warmup limits updated'); qc.invalidateQueries({ queryKey: ['warmup'] }); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Warmup limits" description={`Applies to ${ids.length} mailbox${ids.length === 1 ? '' : 'es'}.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={limit < 1 || rate < 0 || rate > 100} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Max warmup emails per day" hint="Ramp-up still applies: 2 on day one, +2 each day until this limit. 20–40 is typical.">
          <Input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </Field>
        <Field label="Reply rate (%)" hint="Share of received warmup emails that get a reply. 30–40% looks natural.">
          <Input type="number" min={0} max={100} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </Field>
      </div>
    </Modal>
  );
}

function WarmupSettings() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const settings = useQuery({ queryKey: ['warmup', 'settings'], queryFn: () => api.get('/api/warmup/settings').then((r) => r.data as { timezone: string; filter_phrase: string; folder: string; window: string }) });
  const zones = useQuery({ queryKey: ['timezones'], queryFn: () => api.get('/api/campaigns/schedule/available-timezones').then((r) => r.data as string[]), staleTime: Infinity });
  const [tz, setTz] = useState('');
  useEffect(() => { if (settings.data) setTz(settings.data.timezone); }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api.put('/api/warmup/settings', { timezone: tz }),
    onSuccess: () => { toast('Warmup settings saved'); qc.invalidateQueries({ queryKey: ['warmup', 'settings'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Card className="mt-6" title="Warmup settings" description="Applies to the whole pool.">
      {!settings.data ? <Loading /> : (
        <div className="grid gap-6 md:grid-cols-3">
          <Field label="Timezone" hint={`Warmup emails go out between ${settings.data.window} in this timezone.`}>
            <div className="flex gap-2">
              <Select value={tz} onChange={(e) => setTz(e.target.value)} className="flex-1">
                {(zones.data ?? [tz]).map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
              <Button variant="primary" loading={save.isPending} disabled={tz === settings.data.timezone} onClick={() => save.mutate()}>Save</Button>
            </div>
          </Field>
          <div>
            <div className="mb-1.5 text-sm font-medium text-slate-700">Sending window</div>
            <div className="flex h-9 items-center text-sm text-slate-800"><RefreshCw className="mr-2 size-4 text-slate-400" />{settings.data.window} daily</div>
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium text-slate-700">Mailbox folder</div>
            <div className="flex h-9 items-center text-sm text-slate-800">"{settings.data.folder}"</div>
            <div className="text-xs text-slate-500">Warmup emails are filed here after they're processed.</div>
          </div>
        </div>
      )}
    </Card>
  );
}
