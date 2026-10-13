import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Bookmark, History, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtDateTime, fmtNumber, fmtRelative } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Badge, Button, Drawer, EmptyState, Field, Input, Loading, Modal, Pagination, Select, Table, Tabs, Td, Textarea, Th, Toggle, useUi } from '../components/ui.tsx';
import { useGtmTables } from '../gtm/lib/queries.ts';
import { SaveSearchModal, SCHEDULE_LABELS } from './searches/SaveSearchModal.tsx';

/** Saved searches (watchers) and workspace exclusion lists. */
export function SearchesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'exclusions' ? 'exclusions' : 'saved';
  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Settings', to: '/settings' }]} title="Saved searches" subtitle="Saved searches re-run on a schedule and add only new prospects. Exclusions keep customers, competitors and existing leads out of every search." />
      <Tabs className="mb-5" value={tab} onChange={(t) => setParams(t === 'saved' ? {} : { tab: t })}
        items={[{ id: 'saved', label: 'Saved searches', icon: <Bookmark className="size-4" /> }, { id: 'exclusions', label: 'Exclusions', icon: <Ban className="size-4" /> }]} />
      {tab === 'saved' ? <SavedSearches /> : <Exclusions />}
    </Page>
  );
}

// ---------- saved searches ----------
interface Saved {
  id: number; name: string; source: string; source_label: string; params: Record<string, unknown>; table_id: number | null; table_name: string | null;
  schedule: string; next_run_at: string | null; seen_count: number; max_results: number;
  last_run: { status: string; started_at: string; found: number; new_count: number; excluded: number; error: string | null } | null;
}

function SavedSearches() {
  const q = useQuery({ queryKey: ['saved-searches'], queryFn: () => api.get<Saved[]>('/api/saved-searches'), refetchInterval: 30_000 });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get('/api/sources') });
  const [params, setParams] = useSearchParams();
  const [creating, setCreatingState] = useState(() => params.get('new') === '1');
  const setCreating = (v: boolean) => { setCreatingState(v); if (!v && params.has('new')) setParams({}, { replace: true }); };
  const [history, setHistory] = useState<Saved | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const draft = useMemo(() => ({ name: '', source: 'google_maps', params: { query: 'dentist', location: 'Berlin', radius_km: 10 } }), []);
  const refresh = () => qc.invalidateQueries({ queryKey: ['saved-searches'] });

  async function run(s: Saved) {
    setRunning(s.id);
    try {
      const r = await api.post<any>(`/api/saved-searches/${s.id}/run`);
      if (r.status === 'error') toast(`Run failed: ${r.error}`, 'error');
      else toast(`${r.new_count} new of ${r.found} found${r.excluded ? ` · ${r.excluded} excluded` : ''}`);
      await refresh();
      await qc.invalidateQueries({ queryKey: ['gtm-tables'] });
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setRunning(null); }
  }
  async function setSchedule(s: Saved, schedule: string) {
    try { await api.patch(`/api/saved-searches/${s.id}`, { schedule }); await refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function remove(s: Saved) {
    if (!(await confirm({ title: `Delete “${s.name}”?`, message: 'The search and its history are deleted. Its table and rows are kept.', confirmLabel: 'Delete', danger: true }))) return;
    await api.del(`/api/saved-searches/${s.id}`);
    toast('Search deleted');
    await refresh();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="text-[13.5px] text-slate-500">Save a search from the ⋯ menu in <Link to="/" className="font-medium text-slate-800 hover:underline">Find new prospects</Link>, or create one here.</div>
        <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New saved search</Button>
      </div>
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <EmptyState icon={<Bookmark className="size-5" />} title="No saved searches yet" description="Watch Google Maps, YC, Apollo, GitHub, job boards or lookalikes — new matches land in a table, with an optional Slack or webhook alert." />
      ) : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Source</Th><Th>Table</Th><Th>Schedule</Th><Th>Last run</Th><Th className="text-right">Seen</Th><Th /></tr></thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50/60">
                <Td className="font-medium text-slate-900">{s.name}</Td>
                <Td className="text-[13px]">{s.source_label}</Td>
                <Td className="text-[13px]">{s.table_id ? <Link to={`/tables/${s.table_id}`} className="text-brand-600 hover:underline">{s.table_name}</Link> : <span className="text-slate-400">created on first results</span>}</Td>
                <Td>
                  <Select value={s.schedule} onChange={(e) => setSchedule(s, e.target.value)} className="w-36">
                    {Object.entries(SCHEDULE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Td>
                <Td className="text-[13px]">
                  {!s.last_run ? <span className="text-slate-400">Never</span> : s.last_run.status === 'error'
                    ? <span className="text-red-600" title={s.last_run.error ?? ''}>Failed {fmtRelative(s.last_run.started_at)}</span>
                    : <span><span className="font-medium text-slate-900">{s.last_run.new_count} new</span> · {s.last_run.found} found{s.last_run.excluded ? ` · ${s.last_run.excluded} excluded` : ''} <span className="text-slate-400">· {fmtRelative(s.last_run.started_at)}</span></span>}
                </Td>
                <Td className="text-right text-[13px]">{fmtNumber(s.seen_count)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} loading={running === s.id} onClick={() => run(s)}>Run now</Button>
                  <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => setHistory(s)}>History</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(s)} aria-label="Delete"><Trash2 className="size-3.5" /></Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <SaveSearchModal open={creating} onClose={() => setCreating(false)} draft={draft} sources={sources.data?.sources} editParams />
      <RunHistory search={history} onClose={() => setHistory(null)} />
    </div>
  );
}

function RunHistory({ search, onClose }: { search: Saved | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['saved-search-runs', search?.id], queryFn: () => api.get<any[]>(`/api/saved-searches/${search!.id}/runs`), enabled: !!search });
  return (
    <Drawer open={!!search} onClose={onClose} title={search?.name ?? ''} subtitle={search ? `${search.source_label} · ${JSON.stringify(search.params)}` : ''}>
      {q.isLoading ? <Loading /> : !q.data?.length ? <EmptyState title="No runs yet" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Trigger</Th><Th className="text-right">Found</Th><Th className="text-right">New</Th><Th className="text-right">Excluded</Th></tr></thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id}>
                <Td className="text-[13px]">{fmtDateTime(r.started_at)}{r.status === 'error' && <div className="text-xs text-red-600">{r.error}</div>}</Td>
                <Td><Badge tone={r.status === 'error' ? 'red' : r.trigger === 'schedule' ? 'blue' : 'gray'}>{r.status === 'error' ? 'failed' : r.trigger}</Badge></Td>
                <Td className="text-right">{r.found}</Td>
                <Td className="text-right font-medium text-slate-900">{r.new_count}</Td>
                <Td className="text-right">{r.excluded}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Drawer>
  );
}

// ---------- exclusions ----------
interface ExList { id: number; name: string; total: number; counts: Record<string, number>; updated_at: string }
const KIND_LABELS: Record<string, string> = { domain: 'Domains', email: 'Emails', company: 'Companies', linkedin: 'LinkedIn', place: 'Places' };

function Exclusions() {
  const q = useQuery({ queryKey: ['exclusions'], queryFn: () => api.get<ExList[]>('/api/exclusions') });
  const [adding, setAdding] = useState<ExList | null>(null);
  const [browsing, setBrowsing] = useState<ExList | null>(null);
  const [naming, setNaming] = useState<{ id?: number; name: string } | null>(null);
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const refresh = () => qc.invalidateQueries({ queryKey: ['exclusions'] });

  async function saveName() {
    if (!naming?.name.trim()) return;
    try {
      if (naming.id) await api.patch(`/api/exclusions/${naming.id}`, { name: naming.name.trim() });
      else { const r = await api.post<{ id: number }>('/api/exclusions', { name: naming.name.trim() }); setAdding({ id: r.id, name: naming.name.trim(), total: 0, counts: {}, updated_at: '' }); }
      setNaming(null);
      await refresh();
    } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function remove(l: ExList) {
    if (!(await confirm({ title: `Delete “${l.name}”?`, message: `${fmtNumber(l.total)} entries stop being excluded from searches.`, confirmLabel: 'Delete list', danger: true }))) return;
    await api.del(`/api/exclusions/${l.id}`);
    toast('List deleted');
    await refresh();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="text-[13.5px] text-slate-500">Applied to Find prospects, table imports from sources and saved searches.</div>
        <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setNaming({ name: '' })}>New list</Button>
      </div>
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <EmptyState icon={<Ban className="size-5" />} title="No exclusion lists" description="Paste or upload customers, competitors or a do-not-contact list, or exclude everyone already in your campaigns." />
      ) : (
        <Table>
          <thead><tr><Th>List</Th>{Object.values(KIND_LABELS).map((k) => <Th key={k} className="text-right">{k}</Th>)}<Th className="text-right">Total</Th><Th>Updated</Th><Th /></tr></thead>
          <tbody>
            {q.data.map((l) => (
              <tr key={l.id} className="hover:bg-slate-50/60">
                <Td className="font-medium text-slate-900"><button className="hover:underline" onClick={() => setBrowsing(l)}>{l.name}</button></Td>
                {Object.keys(KIND_LABELS).map((k) => <Td key={k} className="text-right text-[13px]">{l.counts[k] ? fmtNumber(l.counts[k]) : <span className="text-slate-300">–</span>}</Td>)}
                <Td className="text-right font-medium">{fmtNumber(l.total)}</Td>
                <Td className="text-[13px] text-slate-500">{fmtRelative(l.updated_at)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => setAdding(l)}>Add</Button>
                  <Button size="sm" variant="ghost" onClick={() => setNaming({ id: l.id, name: l.name })} aria-label="Rename"><Pencil className="size-3.5" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(l)} aria-label="Delete"><Trash2 className="size-3.5" /></Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!naming} onClose={() => setNaming(null)} title={naming?.id ? 'Rename list' : 'New exclusion list'} size="sm"
        footer={<><Button onClick={() => setNaming(null)}>Cancel</Button><Button variant="primary" disabled={!naming?.name.trim()} onClick={saveName}>{naming?.id ? 'Rename' : 'Create'}</Button></>}>
        <Field label="Name"><Input autoFocus value={naming?.name ?? ''} onChange={(e) => setNaming((n) => n && { ...n, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveName()} placeholder="Customers, Competitors, Do not contact…" /></Field>
      </Modal>
      <AddEntries list={adding} onClose={() => setAdding(null)} onDone={refresh} />
      <BrowseEntries list={browsing} onClose={() => setBrowsing(null)} />
    </div>
  );
}

function AddEntries({ list, onClose, onDone }: { list: ExList | null; onClose: () => void; onDone: () => void }) {
  const [how, setHow] = useState('paste');
  const [text, setText] = useState('');
  const [kind, setKind] = useState('auto');
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [tableId, setTableId] = useState('');
  const [scope, setScope] = useState('campaigns');
  const [domains, setDomains] = useState(true);
  const [busy, setBusy] = useState(false);
  const tables = useGtmTables();
  const { toast } = useUi();

  async function submit() {
    if (!list) return;
    setBusy(true);
    try {
      let r: any;
      if (how === 'paste') r = await api.post(`/api/exclusions/${list.id}/entries`, { text, kind });
      else if (how === 'upload') r = await api.post(`/api/exclusions/${list.id}/upload`, { csv: csv?.text ?? '', kind });
      else if (how === 'table') r = await api.post(`/api/exclusions/${list.id}/from-table`, { table_id: Number(tableId) });
      else r = await api.post(`/api/exclusions/${list.id}/from-outreach`, { scope, include_domains: domains });
      toast(`Added ${fmtNumber(r.added)} entries${r.duplicates ? ` · ${fmtNumber(r.duplicates)} already listed` : ''}${r.skipped ? ` · ${fmtNumber(r.skipped)} not recognised` : ''}`);
      setText(''); setCsv(null);
      onDone();
      onClose();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }

  const ready = how === 'paste' ? !!text.trim() : how === 'upload' ? !!csv : how === 'table' ? !!tableId : true;
  return (
    <Modal open={!!list} onClose={onClose} title={`Add to “${list?.name ?? ''}”`} size="md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>Add</Button></>}>
      <Tabs className="mb-4" value={how} onChange={setHow} items={[{ id: 'paste', label: 'Paste' }, { id: 'upload', label: 'Upload CSV' }, { id: 'table', label: 'From a table' }, { id: 'outreach', label: 'From outreach' }]} />
      {how === 'paste' && (
        <div className="space-y-3">
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'acme.com\njane@globex.com\nInitech LLC\nhttps://www.linkedin.com/in/someone'} className="font-mono text-[12.5px]" />
          <KindSelect value={kind} onChange={setKind} />
        </div>
      )}
      {how === 'upload' && (
        <div className="space-y-3">
          <input type="file" accept=".csv,.txt,text/csv,text/plain" className="block w-full text-sm"
            onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv({ name: f.name, text: await f.text() }); }} />
          {csv && <p className="text-[13px] text-slate-500">{csv.name} · {fmtNumber(csv.text.split('\n').length - 1)} rows</p>}
          <p className="text-xs text-slate-500">Columns named domain/website, email, company/name, LinkedIn or place id are picked up automatically; a plain one-column list works too. Large files (300k+ rows) are fine.</p>
          <KindSelect value={kind} onChange={setKind} />
        </div>
      )}
      {how === 'table' && (
        <Field label="Table" hint="Every company domain, email, company name, LinkedIn URL and place id in the table is added.">
          <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">Choose a table…</option>
            {tables.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.row_count})</option>)}
          </Select>
        </Field>
      )}
      {how === 'outreach' && (
        <div className="space-y-4">
          <Field label="Who">
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="campaigns">Leads in any campaign</option>
              <option value="leads">All leads</option>
            </Select>
          </Field>
          <Toggle checked={domains} onChange={setDomains} label="Exclude their companies too" description="Adds each lead's work-email domain (free-mail domains are skipped)." />
        </div>
      )}
    </Modal>
  );
}

function KindSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Treat values as">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">Detect automatically</option>
        {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
    </Field>
  );
}

function BrowseEntries({ list, onClose }: { list: ExList | null; onClose: () => void }) {
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['exclusion-entries', list?.id, kind, search, page],
    queryFn: () => api.get<any>(`/api/exclusions/${list!.id}/entries`, { kind, q: search, page, per_page: 100 }),
    enabled: !!list,
  });
  return (
    <Drawer open={!!list} onClose={onClose} title={list?.name ?? ''} subtitle={list ? `${fmtNumber(list.total)} entries` : ''}>
      <div className="mb-3 flex gap-2">
        <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search…" />
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} className="w-40">
          <option value="">All kinds</option>
          {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {q.isLoading ? <Loading /> : (
        <>
          <Table>
            <tbody>
              {q.data?.data.map((e: any) => (
                <tr key={`${e.kind}:${e.value}`}><Td className="w-28"><Badge>{KIND_LABELS[e.kind]}</Badge></Td><Td className="font-mono text-[12.5px]">{e.value}</Td></tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={q.data?.meta} onPage={setPage} />
        </>
      )}
    </Drawer>
  );
}
