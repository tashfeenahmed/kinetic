import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, Clock, Eye, Filter, MessageSquare, Pause, Play, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import { api, errorMessage, type Paginated } from '../../lib/api.ts';
import { fmtDateTime, fmtPct, fmtRelative } from '../../lib/format.ts';
import {
  Alert, Badge, Button, Checkbox, EmptyState, Field, Input, Loading, Modal, Pagination, Select, Table, Tabs, Td, Textarea, Th, Toggle, cx, useUi,
} from '../../components/ui.tsx';
import { TemplateInput } from './JobForm.tsx';
import { StatusBadge, splitLines, useTableColumns, useTables } from './shared.tsx';

export interface CampaignSettings {
  visit_first: boolean; connect_note: string; ai_instructions: string;
  messages: { template: string; delay_days: number }[];
  withdraw_after_days: number | null; daily_invites: number; daily_messages: number; stop_on_reply: boolean;
  filters: { titles: string[]; exclude_titles: string[]; locations: string[]; companies: string[] };
}
interface CampaignStats {
  total: number; excluded: number; pending: number; visited: number; invited: number; accepted: number; messaged: number;
  followups: number; replied: number; failed: number; not_accepted: number; done: number; acceptance_rate: number; reply_rate: number;
}
interface Campaign {
  id: number; name: string; status: 'draft' | 'active' | 'paused' | 'completed'; settings: CampaignSettings; table_id: number | null;
  approved_at: string | null; created_at: string; updated_at: string; stats: CampaignStats;
}
interface Lead {
  id: number; profile_url: string; full_name: string | null; title: string | null; company: string | null; location: string | null; headline: string | null;
  excluded: boolean; state: string; messages_sent: number; next_action_at: string | null; invited_at: string | null; accepted_at: string | null;
  last_message_at: string | null; replied_at: string | null; error: string | null;
}

const pct = (n: number) => fmtPct(n <= 1 ? n * 100 : n);

/** List of LinkedIn outreach campaigns (separate from the email sequencer). */
export function LinkedInCampaigns() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useUi();
  const list = useQuery({ queryKey: ['automations', 'li-campaigns'], queryFn: () => api.get<{ data: Campaign[] }>('/api/linkedin/campaigns').then((r) => r.data), refetchInterval: 20_000 });
  const [creating, setCreating] = useState(false);
  const [fromTable, setFromTable] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<{ data: Campaign }>('/api/linkedin/campaigns', { name: name.trim() }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['automations', 'li-campaigns'] }); setCreating(false); setName(''); navigate(`/automations/campaigns/${r.data.id}`); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const actions = (
    <div className="flex gap-2">
      <Button icon={<Users className="size-4" />} onClick={() => setFromTable(true)}>From a table</Button>
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-zinc-500">Visit → connect with a note → wait for acceptance → message → up to 3 follow-ups. Stops when they reply. Runs in your browser through the extension, within your daily caps.</p>
        {actions}
      </div>
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <EmptyState icon={<UserPlus className="size-5" />} title="No LinkedIn campaigns yet" description="Import profiles from a table (e.g. a Sales Navigator export), review who's in, then start." action={actions} />
      ) : (
        <div className="rounded-lg border border-zinc-200">
          <Table>
            <thead><tr><Th>Campaign</Th><Th>Status</Th><Th>Leads</Th><Th>Invited</Th><Th>Accepted</Th><Th>Messaged</Th><Th>Replied</Th><Th>Updated</Th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="cursor-pointer text-[13px] hover:bg-zinc-50" onClick={() => navigate(`/automations/campaigns/${c.id}`)}>
                  <Td className="py-2.5 font-medium text-zinc-900">{c.name}</Td>
                  <Td className="py-2.5"><StatusBadge status={c.status} /></Td>
                  <Td className="py-2.5">{c.stats.total - c.stats.excluded}<span className="text-zinc-400"> / {c.stats.total}</span></Td>
                  <Td className="py-2.5">{c.stats.invited + c.stats.accepted + c.stats.messaged + c.stats.replied + c.stats.not_accepted + c.stats.done}</Td>
                  <Td className="py-2.5">{c.stats.accepted + c.stats.messaged + c.stats.replied}<span className="ml-1 text-[11.5px] text-zinc-400">{pct(c.stats.acceptance_rate)}</span></Td>
                  <Td className="py-2.5">{c.stats.messaged}</Td>
                  <Td className="py-2.5">{c.stats.replied}<span className="ml-1 text-[11.5px] text-zinc-400">{pct(c.stats.reply_rate)}</span></Td>
                  <Td className="py-2.5 text-zinc-500">{fmtRelative(c.updated_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New LinkedIn campaign" size="sm"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Heads of growth · Q4" onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate()} /></Field>
      </Modal>
      <ImportTableModal open={fromTable} onClose={() => setFromTable(false)} mode="create" onDone={(id) => id && navigate(`/automations/campaigns/${id}`)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LinkedInCampaignDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [tab, setTab] = useState('overview');
  const [confirmStart, setConfirmStart] = useState(false);
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['automations', 'li-campaign', id], queryFn: () => api.get<{ data: Campaign }>(`/api/linkedin/campaigns/${id}`).then((r) => r.data), refetchInterval: 15_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['automations'] });
  const act = useMutation({
    mutationFn: (a: 'start' | 'pause' | 'resume') => api.post(`/api/linkedin/campaigns/${id}/${a}`, a === 'start' ? { confirm: true } : {}),
    onSuccess: (_r, a) => { toast(a === 'pause' ? 'Paused' : 'Campaign running'); setConfirmStart(false); void refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async () => {
    if (!(await confirm({ title: 'Delete this campaign?', message: 'Its leads and queued actions are deleted. Nothing already sent on LinkedIn is undone.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/linkedin/campaigns/${id}`); void refresh(); navigate('/automations/campaigns'); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  if (q.isLoading) return <Loading />;
  const c = q.data;
  if (!c) return <Alert tone="red">Campaign not found.</Alert>;
  const s = c.stats;
  const ready = s.total - s.excluded;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/automations/campaigns" className="inline-flex items-center gap-1 text-[13px] text-zinc-500 hover:text-zinc-900"><ChevronLeft className="size-4" />Campaigns</Link>
        <h2 className="text-[17px] font-semibold text-zinc-900">{c.name}</h2>
        <StatusBadge status={c.status} />
        <span className="flex-1" />
        {(c.status === 'draft') && <Button variant="primary" icon={<Play className="size-4" />} disabled={!ready} onClick={() => setConfirmStart(true)}>Review & start</Button>}
        {c.status === 'active' && <Button icon={<Pause className="size-4" />} loading={act.isPending} onClick={() => act.mutate('pause')}>Pause</Button>}
        {c.status === 'paused' && <Button variant="primary" icon={<Play className="size-4" />} loading={act.isPending} onClick={() => act.mutate('resume')}>Resume</Button>}
        <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>Delete</Button>
      </div>

      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-7">
        {[
          ['Leads', ready, `${s.excluded} excluded`],
          ['Invites sent', s.invited + s.accepted + s.messaged + s.replied + s.not_accepted + s.done, `${s.pending} to go`],
          ['Accepted', s.accepted + s.messaged + s.replied, pct(s.acceptance_rate)],
          ['Messaged', s.messaged, undefined],
          ['Follow-ups', s.followups, undefined],
          ['Replies', s.replied, pct(s.reply_rate)],
          ['Failed', s.failed, s.not_accepted ? `${s.not_accepted} not accepted` : undefined],
        ].map(([label, value, sub]) => (
          <div key={label as string} className="bg-white px-4 py-3">
            <div className="text-[12px] text-zinc-500">{label}</div>
            <div className={cx('mt-0.5 text-xl font-semibold tabular-nums', label === 'Failed' && Number(value) > 0 ? 'text-red-600' : 'text-zinc-900')}>{Number(value).toLocaleString()}</div>
            {sub && <div className="text-[11.5px] text-zinc-400">{sub}</div>}
          </div>
        ))}
      </div>

      <Tabs value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Steps' }, { id: 'leads', label: 'Leads & review', count: s.total }, { id: 'activity', label: 'Activity' }]} />
      {tab === 'overview' && <StepsEditor campaign={c} />}
      {tab === 'leads' && <LeadsTab campaign={c} />}
      {tab === 'activity' && <Activity id={c.id} />}

      <Modal open={confirmStart} onClose={() => setConfirmStart(false)} title="Start this campaign?" size="md"
        footer={<><Button onClick={() => setConfirmStart(false)}>Not yet</Button><Button variant="primary" loading={act.isPending} onClick={() => act.mutate('start')}>Yes, start sending</Button></>}>
        <div className="space-y-3 text-[13.5px] text-zinc-700">
          <p>Kinetic Companion will act on your LinkedIn account for <b>{ready.toLocaleString()} lead{ready === 1 ? '' : 's'}</b>:</p>
          <ul className="list-disc space-y-1 pl-5">
            {c.settings.visit_first && <li>visit each profile,</li>}
            <li>send a connection request{c.settings.connect_note ? ' with your note' : ' without a note'} (max {c.settings.daily_invites}/day),</li>
            <li>after acceptance, send {c.settings.messages.length} message{c.settings.messages.length === 1 ? '' : 's'} (max {c.settings.daily_messages}/day){c.settings.stop_on_reply ? ', stopping as soon as they reply' : ''}.</li>
          </ul>
          <p className="text-zinc-500">It only runs while your browser is open, within working hours and your global limits. You can pause at any time.</p>
          {s.excluded > 0 && <p className="text-zinc-500">{s.excluded} lead{s.excluded === 1 ? ' is' : 's are'} excluded by the review filters and will be skipped.</p>}
        </div>
      </Modal>
    </div>
  );
}

// ---- steps ----------------------------------------------------------------

function StepsEditor({ campaign: c }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [s, setS] = useState<CampaignSettings>(c.settings);
  useEffect(() => setS(c.settings), [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(s) !== JSON.stringify(c.settings);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/linkedin/campaigns/${c.id}`, { settings: s }),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['automations', 'li-campaign', c.id] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const setMsg = (i: number, patch: Partial<{ template: string; delay_days: number }>) => setS((x) => ({ ...x, messages: x.messages.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const msgs = s.messages.length ? s.messages : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-0">
        <StepCard icon={<Eye className="size-4" />} title="Visit profile" muted={!s.visit_first}
          right={<Toggle checked={s.visit_first} onChange={(v) => setS({ ...s, visit_first: v })} />}>
          They see you in “Who viewed your profile” a little before the invite.
        </StepCard>
        <Arrow />
        <StepCard icon={<UserPlus className="size-4" />} title="Send connection request">
          <TemplateInput field={{ label: 'Note (optional)', max: 300, placeholder: '{Hi|Hello} {first_name}, {ai_message}', help: 'Max 300 characters. Variables {first_name} {company} {title} {location} {headline}, spintax {a|b}, {ai_message}.' }}
            value={s.connect_note} onChange={(v) => setS({ ...s, connect_note: v })} aiInstructions={s.ai_instructions} />
          <Field label="AI instructions for {ai_message}" className="mt-3"><Textarea rows={2} value={s.ai_instructions} onChange={(e) => setS({ ...s, ai_instructions: e.target.value })} placeholder="One specific, friendly sentence about their role or recent post. No pitch." /></Field>
        </StepCard>
        <Arrow />
        <StepCard icon={<Clock className="size-4" />} title="Wait for acceptance">
          <div className="flex flex-wrap items-center gap-2">
            Withdraw if not accepted after
            <Input type="number" min={0} max={60} className="w-20" value={s.withdraw_after_days ?? ''} placeholder="never" onChange={(e) => setS({ ...s, withdraw_after_days: e.target.value === '' ? null : Number(e.target.value) })} />
            days <span className="text-zinc-400">(empty = never)</span>
          </div>
        </StepCard>
        {msgs.map((m, i) => (
          <div key={i}>
            <Arrow label={`${i === 0 ? 'after acceptance, wait' : 'if no reply, wait'} ${m.delay_days} day${m.delay_days === 1 ? '' : 's'}`} />
            <StepCard icon={<MessageSquare className="size-4" />} title={i === 0 ? 'Message 1' : `Follow-up ${i}`}
              right={<Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setS({ ...s, messages: s.messages.filter((_, j) => j !== i) })}>Remove</Button>}>
              <div className="mb-3 flex items-center gap-2">
                Delay
                <Input type="number" min={0} max={15} className="w-20" value={m.delay_days} onChange={(e) => setMsg(i, { delay_days: Math.min(15, Math.max(0, Number(e.target.value) || 0)) })} />
                days {i === 0 ? 'after they accept' : 'after the previous message'} (0–15)
              </div>
              <TemplateInput field={{ label: 'Message', placeholder: 'Thanks for connecting, {first_name}! …' }} value={m.template} onChange={(v) => setMsg(i, { template: v })} aiInstructions={s.ai_instructions} />
            </StepCard>
          </div>
        ))}
        {msgs.length < 4 && (
          <div className="pt-3">
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setS({ ...s, messages: [...s.messages, { template: '', delay_days: s.messages.length ? 3 : 1 }] })}>
              {msgs.length ? `Add follow-up (${4 - msgs.length} left)` : 'Add first message'}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 text-[13px]">
          <div className="mb-3 font-semibold text-zinc-900">Daily caps</div>
          <Field label="Invites per day" hint="Also limited by your global LinkedIn limits."><Input type="number" min={1} max={100} value={s.daily_invites} onChange={(e) => setS({ ...s, daily_invites: Number(e.target.value) || 0 })} /></Field>
          <Field label="Messages per day" className="mt-3"><Input type="number" min={1} max={150} value={s.daily_messages} onChange={(e) => setS({ ...s, daily_messages: Number(e.target.value) || 0 })} /></Field>
          <div className="mt-4"><Toggle checked={s.stop_on_reply} onChange={(v) => setS({ ...s, stop_on_reply: v })} label="Stop on reply" description="Replies are detected by periodic inbox checks." /></div>
        </div>
        <Button variant="primary" className="w-full" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save steps</Button>
        {c.status === 'active' && dirty && <p className="text-[12px] text-zinc-500">Changes apply to the next actions; nothing already sent changes.</p>}
      </div>
    </div>
  );
}

function StepCard({ icon, title, children, right, muted }: { icon: ReactNode; title: string; children: ReactNode; right?: ReactNode; muted?: boolean }) {
  return (
    <div className={cx('rounded-lg border border-zinc-200 bg-white p-4 text-[13px] text-zinc-600', muted && 'opacity-60')}>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">{icon}</span>
        <span className="flex-1 font-medium text-zinc-900">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-6 text-[12px] text-zinc-400">
      <ArrowDown className="size-3.5" />{label}
    </div>
  );
}

// ---- leads & review gate -------------------------------------------------------

function LeadsTab({ campaign: c }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [excluded, setExcluded] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filters, setFilters] = useState(c.settings.filters);
  useEffect(() => setFilters(c.settings.filters), [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const leads = useQuery({
    queryKey: ['automations', 'li-campaign', c.id, 'leads', page, state, excluded],
    queryFn: () => api.get<Paginated<Lead>>(`/api/linkedin/campaigns/${c.id}/leads`, { page, per_page: 50, state, excluded }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['automations', 'li-campaign', c.id] });
  const review = useMutation({
    mutationFn: () => api.post<{ data: { included: number; excluded: number } }>(`/api/linkedin/campaigns/${c.id}/review`, { filters }),
    onSuccess: (r) => { toast(`${r.data.included} included · ${r.data.excluded} excluded`); void refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const toggle = useMutation({
    mutationFn: (l: Lead) => api.patch(`/api/linkedin/campaigns/${c.id}/leads/${l.id}`, { excluded: !l.excluded }),
    onSuccess: () => void refresh(),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const list = (k: keyof CampaignSettings['filters'], label: string, ph: string) => (
    <Field label={label}><Input placeholder={ph} value={filters[k].join(', ')} onChange={(e) => setFilters({ ...filters, [k]: splitLines(e.target.value) })} /></Field>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-zinc-900"><Filter className="size-4 text-zinc-400" />Review gate</div>
        <p className="mb-3 text-[12.5px] text-zinc-500">Keep only the leads that match. Comma-separated keywords; empty = no filter. You can also include/exclude leads one by one below.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {list('titles', 'Title contains', 'founder, head of growth')}
          {list('exclude_titles', 'Title excludes', 'intern, student')}
          {list('locations', 'Location contains', 'United States, London')}
          {list('companies', 'Company contains', '')}
        </div>
        <div className="mt-3 flex justify-end"><Button size="sm" variant="primary" loading={review.isPending} onClick={() => review.mutate()}>Apply filters</Button></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} className="w-40">
          <option value="">All states</option>
          {['pending', 'visited', 'invited', 'accepted', 'messaged', 'replied', 'not_accepted', 'done', 'failed'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
        </Select>
        <Select value={excluded} onChange={(e) => { setExcluded(e.target.value); setPage(1); }} className="w-36">
          <option value="">Included & excluded</option><option value="false">Included</option><option value="true">Excluded</option>
        </Select>
        <span className="flex-1" />
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Paste profiles</Button>
        <Button size="sm" icon={<Users className="size-3.5" />} onClick={() => setImporting(true)}>Import from table</Button>
      </div>

      {leads.isLoading ? <Loading /> : !leads.data?.data.length ? (
        <EmptyState icon={<Users className="size-5" />} title="No leads" description="Paste LinkedIn profile URLs or import them from a table." />
      ) : (
        <div className="rounded-lg border border-zinc-200">
          <Table>
            <thead><tr><Th className="w-10">In</Th><Th>Person</Th><Th>Company</Th><Th>Location</Th><Th>State</Th><Th>Next</Th></tr></thead>
            <tbody>
              {leads.data.data.map((l) => (
                <tr key={l.id} className={cx('text-[13px]', l.excluded && 'text-zinc-400')}>
                  <Td className="py-2"><Checkbox checked={!l.excluded} onChange={() => toggle.mutate(l)} label="Include" /></Td>
                  <Td className="py-2">
                    <a href={l.profile_url} target="_blank" rel="noreferrer" className={cx('font-medium hover:underline', l.excluded ? 'text-zinc-400' : 'text-zinc-900')}>{l.full_name || l.profile_url.replace(/^https?:\/\/(www\.)?linkedin\.com/, '')}</a>
                    <div className="max-w-80 truncate text-[12px] text-zinc-500">{l.title || l.headline}</div>
                  </Td>
                  <Td className="py-2">{l.company}</Td>
                  <Td className="py-2">{l.location}</Td>
                  <Td className="py-2"><StatusBadge status={l.state} />{l.messages_sent > 0 && <span className="ml-1 text-[11.5px] text-zinc-400">{l.messages_sent} msg</span>}
                    {l.error && <div className="max-w-56 truncate text-[11.5px] text-red-600" title={l.error}>{l.error}</div>}</Td>
                  <Td className="py-2 text-[12px] text-zinc-500">{l.next_action_at ? fmtRelative(l.next_action_at) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={leads.data.meta} onPage={setPage} />
        </div>
      )}
      <PasteLeadsModal id={c.id} open={adding} onClose={() => setAdding(false)} />
      <ImportTableModal open={importing} onClose={() => setImporting(false)} mode="import" campaignId={c.id} />
    </div>
  );
}

function PasteLeadsModal({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [text, setText] = useState('');
  const urls = splitLines(text).filter((u) => /linkedin\.com\/(in|sales\/lead)\//i.test(u));
  const add = useMutation({
    mutationFn: () => api.post<{ data: { added: number; skipped: number } }>(`/api/linkedin/campaigns/${id}/leads`, { profiles: urls.map((profile_url) => ({ profile_url })) }),
    onSuccess: (r) => { toast(`${r.data.added} added${r.data.skipped ? `, ${r.data.skipped} skipped` : ''}`); setText(''); onClose(); void qc.invalidateQueries({ queryKey: ['automations', 'li-campaign', id] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Add profiles" description="One LinkedIn profile URL per line. Names, titles and companies are filled in when the profile is visited."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!urls.length} loading={add.isPending} onClick={() => add.mutate()}>Add {urls.length || ''}</Button></>}>
      <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://www.linkedin.com/in/…" className="font-mono text-[12.5px]" />
    </Modal>
  );
}

const MAP_FIELDS: { key: string; label: string; guess: RegExp }[] = [
  { key: 'profile_url', label: 'LinkedIn URL *', guess: /linkedin/i },
  { key: 'full_name', label: 'Full name', guess: /^(full )?name$/i },
  { key: 'first_name', label: 'First name', guess: /first/i },
  { key: 'last_name', label: 'Last name', guess: /last/i },
  { key: 'title', label: 'Title', guess: /title|position|role/i },
  { key: 'company', label: 'Company', guess: /^company$/i },
  { key: 'location', label: 'Location', guess: /location|city|country/i },
  { key: 'headline', label: 'Headline', guess: /headline/i },
];

/** Import leads from a table column mapping — into an existing campaign or as a new one. */
function ImportTableModal({ open, onClose, mode, campaignId, onDone }: { open: boolean; onClose: () => void; mode: 'create' | 'import'; campaignId?: number; onDone?: (id?: number) => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const tables = useTables();
  const [tableId, setTableId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<Record<string, string>>({});
  const cols = useTableColumns(tableId);
  useEffect(() => {
    if (!cols.data) return;
    const m: Record<string, string> = {};
    for (const f of MAP_FIELDS) { const hit = cols.data.find((c) => f.guess.test(c.name)); if (hit) m[f.key] = hit.name; }
    setColumns(m);
  }, [cols.data]);
  const run = useMutation({
    mutationFn: () => {
      const body = { table_id: tableId, columns: Object.fromEntries(Object.entries(columns).filter(([, v]) => v)) };
      return mode === 'create'
        ? api.post<{ data: { id: number } }>('/api/linkedin/campaigns/from-table', { ...body, name: name.trim() || tables.data?.find((t) => t.id === tableId)?.name || 'LinkedIn campaign' })
        : api.post<{ data: { added: number; skipped: number } }>(`/api/linkedin/campaigns/${campaignId}/leads/import-table`, body);
    },
    onSuccess: (r: any) => {
      toast(mode === 'create' ? 'Campaign created' : `${r.data.added} added${r.data.skipped ? `, ${r.data.skipped} skipped` : ''}`);
      void qc.invalidateQueries({ queryKey: ['automations'] });
      onClose();
      onDone?.(mode === 'create' ? r.data.id : undefined);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title={mode === 'create' ? 'New campaign from a table' : 'Import leads from a table'} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!tableId || !columns.profile_url} loading={run.isPending} onClick={() => run.mutate()}>{mode === 'create' ? 'Create campaign' : 'Import'}</Button></>}>
      <div className="space-y-4">
        {mode === 'create' && <Field label="Campaign name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the table name" /></Field>}
        <Field label="Table">
          <Select value={tableId ?? ''} onChange={(e) => setTableId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose a table…</option>
            {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.row_count})</option>)}
          </Select>
        </Field>
        {tableId && (
          <div className="grid gap-3 sm:grid-cols-2">
            {MAP_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <Select value={columns[f.key] ?? ''} onChange={(e) => setColumns((m) => ({ ...m, [f.key]: e.target.value }))}>
                  <option value="">—</option>
                  {(cols.data ?? []).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        )}
        {mode === 'create' && <Badge tone="gray">The campaign starts as a draft — set its steps and review leads before starting.</Badge>}
      </div>
    </Modal>
  );
}

// ---- activity ------------------------------------------------------------------

function Activity({ id }: { id: number }) {
  const q = useQuery({
    queryKey: ['automations', 'li-campaign', id, 'activity'], refetchInterval: 15_000,
    queryFn: () => api.get<{ data: { id: number; kind: string; status: string; lead_name: string | null; profile_url: string | null; error: string | null; updated_at: string }[] }>(`/api/linkedin/campaigns/${id}/activity`).then((r) => r.data),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <p className="py-8 text-center text-[13px] text-zinc-500">No activity yet. Actions appear here as the extension works through the campaign.</p>;
  const KIND: Record<string, string> = { 'linkedin.visit': 'Visit', 'linkedin.connect': 'Invite', 'linkedin.message': 'Message', 'linkedin.check_connections': 'Check acceptances', 'linkedin.check_inbox': 'Check replies', 'linkedin.withdraw_invites': 'Withdraw' };
  return (
    <div className="rounded-lg border border-zinc-200">
      <Table>
        <thead><tr><Th>When</Th><Th>Action</Th><Th>Lead</Th><Th>Status</Th></tr></thead>
        <tbody>
          {q.data.map((a) => (
            <tr key={a.id} className="text-[13px]">
              <Td className="py-2 text-zinc-500">{fmtDateTime(a.updated_at)}</Td>
              <Td className="py-2">{KIND[a.kind] ?? a.kind}</Td>
              <Td className="py-2">{a.profile_url ? <a href={a.profile_url} target="_blank" rel="noreferrer" className="hover:underline">{a.lead_name || a.profile_url}</a> : '—'}</Td>
              <Td className="py-2"><StatusBadge status={a.status} />{a.error && <span className="ml-2 text-[12px] text-red-600">{a.error}</span>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
