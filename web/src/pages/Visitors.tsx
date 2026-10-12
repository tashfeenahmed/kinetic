import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Eye, MousePointerClick, Radio, Search, Send, UserCheck } from 'lucide-react';
import { api, errorMessage, type Paginated } from '../lib/api.ts';
import { fmtDateTime, fmtNumber, fmtRelative } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Badge, Button, Card, Checkbox, Drawer, EmptyState, Field, Input, Loading, Modal, Pagination, Select, Table, Tabs, Td, Th, cx, useUi } from '../components/ui.tsx';
import { BrandIcon } from '../components/BrandIcon.tsx';
import { useGtmTables } from '../gtm/lib/queries';
import { SitesPanel, SettingsPanel } from './visitors/Setup.tsx';

export interface Tracking { url: string; reachable: boolean; https: boolean; problem: string | null }
interface Overview {
  tracking: Tracking; sites: number; sessions_24h: number; sessions_7d: number; companies_7d: number; people_7d: number; high_intent: number; identified_rate: number;
  settings: { alert_threshold: number };
}
interface PageStat { path: string; views: number }
interface Company {
  id: number; name: string; domain: string | null; source: string; visits: number; pageviews: number; key_pageviews: number; score: number; visits_30d: number;
  first_seen_at: string; last_seen_at: string; top_pages: PageStat[]; people: { id: number; email: string; name: string | null; title: string | null }[];
  profile: { industry: string | null; employees: unknown; description: string | null; location: unknown; linkedin: string | null } | null; pushed_table_id: number | null;
}
interface Person {
  id: number; email: string; name: string | null; title: string | null; lead_id: number | null; company: string | null; company_domain: string | null; source: string;
  visits: number; pageviews: number; score: number; last_seen_at: string; top_pages: PageStat[]; summary: string;
}
interface FeedItem {
  id: number; type: 'pageview' | 'click' | 'identify'; path: string; url: string; title: string; duration_s: number; at: string; site: string;
  company: { id: number; name: string; domain: string | null; score: number } | null; person: { id: number; email: string; name: string | null } | null;
  network: { status: string; name: string | null } | null; referrer: string | null; utm_source: string | null;
}

type Tab = 'companies' | 'people' | 'live' | 'sites' | 'settings';

export function VisitorsPage() {
  const [tab, setTab] = useState<Tab>('companies');
  const overview = useQuery({ queryKey: ['visitors', 'overview'], queryFn: () => api.get<Overview>('/api/visitors/overview'), refetchInterval: 30_000 });
  const o = overview.data;
  const noSites = o && o.sites === 0;
  useEffect(() => { if (noSites) setTab('sites'); }, [noSites]);

  return (
    <Page wide>
      <PageHeader title="Visitors" subtitle="Companies and leads visiting your website — identified from their network and from email click-throughs, scored by intent." />

      {o && !o.tracking.reachable && <div className="mb-4"><TrackingNotice tracking={o.tracking} /></div>}
      {o && o.tracking.reachable && !o.tracking.https && <div className="mb-4"><Alert tone="yellow" title="Tracking URL is not HTTPS">{o.tracking.problem}</Alert></div>}

      {o && (
        <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-5">
          <Metric label="Sessions (24h)" value={fmtNumber(o.sessions_24h)} />
          <Metric label="Sessions (7d)" value={fmtNumber(o.sessions_7d)} sub={`${o.identified_rate}% identified`} />
          <Metric label="Companies (7d)" value={fmtNumber(o.companies_7d)} />
          <Metric label="People (7d)" value={fmtNumber(o.people_7d)} />
          <Metric label="High intent" value={fmtNumber(o.high_intent)} sub={`score ≥ ${o.settings.alert_threshold}`} />
        </div>
      )}

      <Tabs className="mb-4" value={tab} onChange={(t) => setTab(t as Tab)} items={[
        { id: 'companies', label: 'Companies', icon: <Building2 className="size-4" /> },
        { id: 'people', label: 'People', icon: <UserCheck className="size-4" /> },
        { id: 'live', label: 'Live', icon: <Radio className="size-4" /> },
        { id: 'sites', label: 'Sites', count: o?.sites },
        { id: 'settings', label: 'Settings' },
      ]} />

      {tab === 'companies' && <CompaniesPanel threshold={o?.settings.alert_threshold ?? 60} />}
      {tab === 'people' && <PeoplePanel />}
      {tab === 'live' && <LivePanel />}
      {tab === 'sites' && <SitesPanel tracking={o?.tracking} />}
      {tab === 'settings' && <SettingsPanel />}
    </Page>
  );
}

export function TrackingNotice({ tracking }: { tracking: Tracking }) {
  return (
    <Alert tone="yellow" title="Your website can’t reach Kinetic yet">
      <p>{tracking.problem}</p>
      <p className="mt-1.5">Quick option on the Pi: <code className="rounded bg-amber-100 px-1">cloudflared tunnel --url http://localhost:4400</code> (or a named tunnel on your own domain), then set <b>Tracking public URL</b> on the <Link to="/integrations" className="underline">Integrations</Link> page. Only <code className="rounded bg-amber-100 px-1">/v.js</code> and <code className="rounded bg-amber-100 px-1">/api/v/collect</code> need to be public.</p>
    </Alert>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-[12px] text-zinc-500">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tracking-tight text-zinc-900">{value}</div>
      {sub && <div className="text-[11.5px] text-zinc-400">{sub}</div>}
    </div>
  );
}

export function ScoreBadge({ score, threshold = 60 }: { score: number; threshold?: number }) {
  const tone = score >= threshold ? 'red' : score >= threshold / 2 ? 'orange' : 'gray';
  return <Badge tone={tone}>{score}</Badge>;
}

const pagesText = (pages: PageStat[], n = 3) => pages.slice(0, n).map((p) => `${p.path}${p.views > 1 ? ` ×${p.views}` : ''}`).join(', ');

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ---------- companies ----------
function CompaniesPanel({ threshold }: { threshold: number }) {
  const [search, setSearch] = useState('');
  const [days, setDays] = useState('30');
  const [minScore, setMinScore] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [pushing, setPushing] = useState(false);
  const q = useDebounced(search);
  useEffect(() => { setPage(1); }, [q, days, minScore]);
  const list = useQuery({
    queryKey: ['visitors', 'companies', { q, days, minScore, page }],
    queryFn: () => api.get<Paginated<Company>>('/api/visitors/companies', { search: q, days, min_score: minScore, page, per_page: 50 }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const rows = list.data?.data ?? [];
  const toggle = (id: number) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search companies" className="pl-8" />
        </div>
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-36">
          <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="">All time</option>
        </Select>
        <Select value={minScore} onChange={(e) => setMinScore(e.target.value)} className="w-40">
          <option value="">Any score</option><option value={String(Math.round(threshold / 2))}>Warm (≥ {Math.round(threshold / 2)})</option><option value={String(threshold)}>High intent (≥ {threshold})</option>
        </Select>
        <span className="flex-1" />
        <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setPushing(true)}>{checked.size ? `Send ${checked.size} to table` : 'Send to table'}</Button>
      </div>
      {list.isLoading ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<Building2 className="size-5" />} title="No companies identified yet"
          description="Visits from company networks show up here. Home, mobile, VPN and cloud connections are filtered out; leads who click your emails are identified by name." />
      ) : (
        <Table>
          <thead><tr>
            <Th className="w-10" /><Th>Company</Th><Th>Visits</Th><Th>Pages</Th><Th>Top pages</Th><Th>People</Th><Th>Last seen</Th><Th>Score</Th>
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="cursor-pointer text-[13px] hover:bg-zinc-50" onClick={() => setOpen(c.id)}>
                <Td className="py-2"><span onClick={(e) => e.stopPropagation()}><Checkbox checked={checked.has(c.id)} onChange={() => toggle(c.id)} /></span></Td>
                <Td className="py-2">
                  <div className="flex items-center gap-2.5">
                    <BrandIcon domain={c.domain ?? undefined} fallback={<Building2 className="size-3.5" />} size={26} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-zinc-900">{c.name || c.domain}</div>
                      <div className="truncate text-[12px] text-zinc-500">{c.domain ?? 'domain unknown'}{c.profile?.industry ? ` · ${c.profile.industry}` : ''}</div>
                    </div>
                  </div>
                </Td>
                <Td className="py-2">{fmtNumber(c.visits)}</Td>
                <Td className="py-2">{fmtNumber(c.pageviews)}</Td>
                <Td className="max-w-[260px] truncate py-2 text-zinc-600">{pagesText(c.top_pages) || '—'}</Td>
                <Td className="py-2">{c.people.length ? <span title={c.people.map((p) => p.name ?? p.email).join(', ')}>{c.people.length}</span> : <span className="text-zinc-400">—</span>}</Td>
                <Td className="py-2 text-zinc-600">{fmtRelative(c.last_seen_at)}</Td>
                <Td className="py-2"><ScoreBadge score={c.score} threshold={threshold} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination meta={list.data?.meta} onPage={setPage} />
      {open && <CompanyDrawer id={open} threshold={threshold} onClose={() => setOpen(null)} />}
      {pushing && <PushModal companyIds={[...checked]} onClose={() => setPushing(false)} onDone={() => setChecked(new Set())} />}
    </Card>
  );
}

function CompanyDrawer({ id, threshold, onClose }: { id: number; threshold: number; onClose: () => void }) {
  const d = useQuery({ queryKey: ['visitors', 'company', id], queryFn: () => api.get<Company & { sessions: any[] }>(`/api/visitors/companies/${id}`) });
  const c = d.data;
  return (
    <Drawer open onClose={onClose} width="max-w-2xl" title={c ? c.name || c.domain : 'Company'} subtitle={c?.domain ?? undefined}
      actions={c && <ScoreBadge score={c.score} threshold={threshold} />}>
      {!c ? <Loading /> : (
        <div className="space-y-6 text-[13px]">
          <div className="grid grid-cols-4 gap-3">
            {[['Visits', c.visits], ['Last 30 days', c.visits_30d], ['Pages', c.pageviews], ['Key pages', c.key_pageviews]].map(([l, v]) => (
              <div key={l as string} className="rounded-lg border border-zinc-200 px-3 py-2"><div className="text-[11.5px] text-zinc-500">{l}</div><div className="text-[16px] font-semibold">{fmtNumber(v as number)}</div></div>
            ))}
          </div>
          {c.profile && (
            <div className="rounded-lg border border-zinc-200 px-3 py-2.5 text-zinc-700">
              {c.profile.description && <p className="mb-1.5">{c.profile.description}</p>}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-zinc-500">
                {c.profile.industry && <span>{c.profile.industry}</span>}
                {c.profile.employees != null && <span>{String(c.profile.employees)} employees</span>}
                {c.profile.location != null && <span>{String(c.profile.location)}</span>}
                {c.profile.linkedin && <a href={c.profile.linkedin} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">LinkedIn</a>}
              </div>
            </div>
          )}
          {c.people.length > 0 && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-400">Identified people</h3>
              <ul className="space-y-1">{c.people.map((p) => <li key={p.id}><span className="font-medium text-zinc-900">{p.name ?? p.email}</span>{p.name && <span className="text-zinc-500"> · {p.email}</span>}{p.title && <span className="text-zinc-500"> · {p.title}</span>}</li>)}</ul>
            </section>
          )}
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-400">Sessions</h3>
            {c.sessions.length === 0 ? <p className="text-zinc-500">Session details were removed by the retention setting; totals are kept.</p> : (
              <ol className="space-y-4">
                {c.sessions.map((s) => (
                  <li key={s.id} className="rounded-lg border border-zinc-200">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 bg-zinc-50/70 px-3 py-2 text-[12px] text-zinc-600">
                      <span className="font-medium text-zinc-900">{fmtDateTime(s.started_at)}</span>
                      <span>{s.site}</span>
                      <span>{s.pageviews} page{s.pageviews === 1 ? '' : 's'}</span>
                      {s.duration_s > 0 && <span>{fmtDuration(s.duration_s)}</span>}
                      {s.person && <Badge tone="blue">{s.person.name ?? s.person.email}</Badge>}
                      {(s.utm.source || s.referrer) && <span className="truncate">from {s.utm.source ?? hostOf(s.referrer)}</span>}
                      <span className="flex-1" /><ScoreBadge score={s.score} threshold={threshold} />
                    </div>
                    <ul className="divide-y divide-zinc-100">
                      {(s.events.length ? s.events : Object.entries(s.paths as Record<string, number>).map(([path, views]) => ({ type: 'pageview', path, title: `${views} view${views === 1 ? '' : 's'}`, at: null, duration_s: 0 }))).map((e: any, i: number) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-1.5">
                          {e.type === 'click' ? <MousePointerClick className="size-3.5 text-zinc-400" /> : e.type === 'identify' ? <UserCheck className="size-3.5 text-zinc-400" /> : <Eye className="size-3.5 text-zinc-400" />}
                          <span className="font-mono text-[12px] text-zinc-800">{e.path}</span>
                          <span className="min-w-0 flex-1 truncate text-zinc-500">{e.type === 'click' ? `clicked “${e.title}”` : e.title}</span>
                          {e.duration_s > 0 && <span className="text-[11.5px] text-zinc-400">{fmtDuration(e.duration_s)}</span>}
                          {e.at && <span className="text-[11.5px] text-zinc-400">{new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function fmtDuration(s: number) {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
}
function hostOf(u: string) {
  try { return new URL(u).hostname; } catch { return u; }
}

function PushModal({ companyIds, onClose, onDone }: { companyIds: number[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const tables = useGtmTables();
  const [tableId, setTableId] = useState('');
  const [name, setName] = useState('Website visitors');
  const [minScore, setMinScore] = useState('40');
  const push = useMutation({
    mutationFn: () => api.post<{ table_id: number; added: number; skipped: number }>('/api/visitors/push', {
      ...(companyIds.length ? { company_ids: companyIds } : { min_score: Number(minScore) || 0, days: 30 }),
      ...(tableId ? { table_id: Number(tableId) } : { table_name: name }),
    }),
    onSuccess: (r) => {
      toast(`${r.added} compan${r.added === 1 ? 'y' : 'ies'} added${r.skipped ? ` · ${r.skipped} already there` : ''}`);
      void qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      void qc.invalidateQueries({ queryKey: ['visitors'] });
      onDone(); onClose();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open onClose={onClose} title="Send visiting companies to a table" description="Each company becomes a row with its domain, visits, top pages and a live Website visits signal — ready for enrichment and outreach."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={push.isPending} onClick={() => push.mutate()}>Send</Button></>}>
      <div className="space-y-4">
        {companyIds.length ? <p className="text-sm text-zinc-600">{companyIds.length} selected compan{companyIds.length === 1 ? 'y' : 'ies'} (those with a known domain).</p> : (
          <Field label="Companies with a score of at least" hint="Visited in the last 30 days.">
            <Input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value)} />
          </Field>
        )}
        <Field label="Table">
          <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">New table…</option>
            {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        {!tableId && <Field label="New table name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <p className="text-[12.5px] text-zinc-500">Companies already in the table (same domain) are skipped. To do this automatically, set an auto-push table in Settings.</p>
      </div>
    </Modal>
  );
}

// ---------- people ----------
function PeoplePanel() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  useEffect(() => setPage(1), [q]);
  const list = useQuery({
    queryKey: ['visitors', 'people', { q, page }],
    queryFn: () => api.get<Paginated<Person>>('/api/visitors/people', { search: q, page, per_page: 50 }),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const rows = list.data?.data ?? [];
  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" className="pl-8" />
        </div>
      </div>
      {list.isLoading ? <Loading /> : rows.length === 0 ? (
        <EmptyState icon={<UserCheck className="size-5" />} title="No identified people yet"
          description={<>Leads are identified when they click a tracked link in your emails that points to one of your sites, or when your site calls <code>kinetic.identify(email)</code> (e.g. on form submit).</>} />
      ) : (
        <Table>
          <thead><tr><Th>Person</Th><Th>Activity</Th><Th>Visits</Th><Th>Pages</Th><Th>How</Th><Th>Last seen</Th><Th>Score</Th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="text-[13px] hover:bg-zinc-50">
                <Td className="py-2">
                  <div className="font-medium text-zinc-900">{p.name ?? p.email}{p.company && <span className="font-normal text-zinc-500"> · {p.company}</span>}</div>
                  <div className="text-[12px] text-zinc-500">{p.name ? p.email : ''}{p.title ? `${p.name ? ' · ' : ''}${p.title}` : ''}</div>
                </Td>
                <Td className="max-w-[340px] py-2 text-zinc-700">{p.summary}</Td>
                <Td className="py-2">{fmtNumber(p.visits)}</Td>
                <Td className="py-2">{fmtNumber(p.pageviews)}</Td>
                <Td className="py-2">{p.source === 'email_click' ? <Badge tone="blue">Email click</Badge> : <Badge>Identify</Badge>}{!p.lead_id && <span className="ml-1 text-[11.5px] text-zinc-400">not a lead</span>}</Td>
                <Td className="py-2 text-zinc-600">{fmtRelative(p.last_seen_at)}</Td>
                <Td className="py-2"><ScoreBadge score={p.score} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination meta={list.data?.meta} onPage={setPage} />
    </Card>
  );
}

// ---------- live feed ----------
function LivePanel() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [paused, setPaused] = useState(false);
  const lastId = useRef(0);
  const feed = useQuery({
    queryKey: ['visitors', 'feed'],
    queryFn: () => api.get<{ data: FeedItem[] }>('/api/visitors/feed', { after_id: lastId.current, limit: 100 }),
    refetchInterval: paused ? false : 5000,
    gcTime: 0,
  });
  useEffect(() => {
    const fresh = feed.data?.data ?? [];
    if (!fresh.length) return;
    lastId.current = Math.max(lastId.current, ...fresh.map((f) => f.id));
    setItems((prev) => [...fresh.filter((f) => !prev.some((p) => p.id === f.id)), ...prev].slice(0, 300));
  }, [feed.data]);

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 text-[13px] text-zinc-600">
        <span className={cx('size-2 rounded-full', paused ? 'bg-zinc-300' : 'animate-pulse bg-emerald-500')} />
        {paused ? 'Paused' : 'Live — updates every 5 seconds'}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</Button>
      </div>
      {feed.isLoading && !items.length ? <Loading /> : items.length === 0 ? (
        <EmptyState icon={<Radio className="size-5" />} title="Waiting for visitors" description="Events from your tracked sites stream in here as they happen." />
      ) : (
        <ul className="divide-y divide-zinc-100">
          {items.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
              {e.type === 'click' ? <MousePointerClick className="size-4 text-zinc-400" /> : e.type === 'identify' ? <UserCheck className="size-4 text-zinc-400" /> : <Eye className="size-4 text-zinc-400" />}
              <span className="w-56 shrink-0 truncate">
                {e.person ? <span className="font-medium text-zinc-900">{e.person.name ?? e.person.email}</span> : null}
                {e.company ? <span className={e.person ? 'text-zinc-500' : 'font-medium text-zinc-900'}>{e.person ? ' · ' : ''}{e.company.name || e.company.domain}</span>
                  : !e.person && <span className="text-zinc-400">{networkLabel(e.network)}</span>}
              </span>
              <span className="font-mono text-[12px] text-zinc-800">{e.path}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-500">{e.type === 'click' ? `clicked “${e.title}”` : e.type === 'identify' ? `identified as ${e.title}` : e.title}</span>
              <span className="hidden text-[12px] text-zinc-400 sm:inline">{e.site}</span>
              <span className="w-16 text-right text-[12px] text-zinc-400">{fmtRelative(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function networkLabel(n: FeedItem['network']) {
  if (!n) return 'Anonymous';
  const what: Record<string, string> = { pending: 'Identifying…', isp: 'Home / ISP', mobile: 'Mobile network', hosting: 'Cloud / hosting', vpn: 'VPN', private: 'Private network', unknown: 'Unknown network', company: 'Company' };
  return `${what[n.status] ?? 'Anonymous'}${n.name && n.status !== 'pending' ? ` · ${n.name}` : ''}`;
}
