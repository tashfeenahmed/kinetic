import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Papa from 'papaparse';
import { FileUp, List, Search, Table2, UserPlus } from 'lucide-react';
import { api, errorMessage, type Paginated } from '../../lib/api.ts';
import { fmtNumber, fullName } from '../../lib/format.ts';
import { Alert, Button, Checkbox, Field, Input, Loading, Modal, Select, Toggle, cx, useUi } from '../../components/ui.tsx';
import type { Campaign } from './types.ts';
import { outreachDefaults } from '../../gtm/components/ColumnEditor';
import { pushRows } from '../../gtm/lib/push';
import { api as gtmApi, type Column } from '../../gtm/lib/api';
import { useGtmTables } from '../../gtm/lib/queries';

type Mode = 'existing' | 'list' | 'table' | 'csv';

const STANDARD_FIELDS = [
  ['email', 'Email'], ['first_name', 'First name'], ['last_name', 'Last name'], ['company', 'Company'], ['title', 'Title'], ['notes', 'Notes'],
] as const;

/** Best-guess field for a CSV header. */
function guessField(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(email|emailaddress|mail|workemail)$/.test(h)) return 'email';
  if (/^(firstname|first|fname|givenname)$/.test(h)) return 'first_name';
  if (/^(lastname|last|lname|surname|familyname)$/.test(h)) return 'last_name';
  if (/^(company|companyname|organization|organisation|account)$/.test(h)) return 'company';
  if (/^(title|jobtitle|position|role)$/.test(h)) return 'title';
  if (/^(notes|note)$/.test(h)) return 'notes';
  return 'custom';
}

function ExistingLeads({ campaign, onAdded }: { campaign: Campaign; onAdded: (n: number) => void }) {
  const [search, setSearch] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const leads = useQuery({
    queryKey: ['leads', 'picker', { search, onlyNew }],
    queryFn: () => api.get<Paginated<any>>('/api/leads', { search, without_campaign: onlyNew ? 1 : undefined, per_page: 100 }),
  });
  const rows = leads.data?.data ?? [];
  const all = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/campaigns/${campaign.id}/leads/attach-leads`, { lead_ids: [...picked] });
      onAdded(r.data.attached);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600"><Checkbox checked={onlyNew} onChange={setOnlyNew} /> Only leads not in any campaign</label>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
        {leads.isLoading ? <Loading /> : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">No leads found. Import a CSV instead.</div>
        ) : (
          <>
            <label className="sticky top-0 flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
              <Checkbox checked={all} onChange={(v) => setPicked(v ? new Set(rows.map((r) => r.id)) : new Set())} /> Select all {rows.length} shown
              {leads.data && leads.data.meta.total > rows.length && <span className="font-normal text-slate-400">({fmtNumber(leads.data.meta.total)} match — refine the search to see more)</span>}
            </label>
            {rows.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50">
                <Checkbox checked={picked.has(l.id)} onChange={(v) => setPicked((s) => { const n = new Set(s); v ? n.add(l.id) : n.delete(l.id); return n; })} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{fullName(l)}</div>
                  <div className="truncate text-xs text-slate-500">{l.email}{l.company ? ` · ${l.company}` : ''}</div>
                </div>
              </label>
            ))}
          </>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!picked.size} loading={busy} onClick={add}>Add {picked.size || ''} lead{picked.size === 1 ? '' : 's'}</Button>
      </div>
    </div>
  );
}

function LeadListPicker({ campaign, onAdded }: { campaign: Campaign; onAdded: (n: number) => void }) {
  const [listId, setListId] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const lists = useQuery({ queryKey: ['lead-lists'], queryFn: () => api.get('/api/lead-lists').then((r) => r.data as { id: number; name: string; leads_count: number }[]) });
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/campaigns/${campaign.id}/leads/attach-lead-list`, { lead_list_id: Number(listId) });
      onAdded(r.data.attached);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (lists.isLoading) return <Loading />;
  if (!lists.data?.length) return <div className="py-8 text-center text-sm text-slate-500">You don't have any lead lists yet. Import a CSV to create one.</div>;
  return (
    <div className="space-y-4">
      <Field label="Lead list" hint="Leads already in another active campaign are skipped.">
        <Select value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">Choose a list…</option>
          {lists.data.map((l) => <option key={l.id} value={l.id}>{l.name} ({fmtNumber(l.leads_count)} leads)</option>)}
        </Select>
      </Field>
      <div className="flex justify-end"><Button variant="primary" disabled={!listId} loading={busy} onClick={add}>Add list</Button></div>
    </div>
  );
}

/** Rows of a research table join the campaign (as leads) through the table's push column. */
function TablePicker({ campaign, onQueued }: { campaign: Campaign; onQueued: (n: number, table: string) => void }) {
  const [tableId, setTableId] = useState('');
  const [onlyValid, setOnlyValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const tables = useGtmTables();
  const view = useQuery({ queryKey: ['gtm-table-columns', tableId], enabled: !!tableId, queryFn: () => gtmApi<{ columns: Column[]; table: { name: string } }>(`/api/gtm/tables/${tableId}`) });
  const cols = view.data?.columns ?? [];
  const mapping = useMemo(() => outreachDefaults(cols.map((c) => c.name), 'outreach_campaign'), [cols]);
  const verify = cols.find((c) => c.type === 'enrich' && c.config?.kind === 'verify_email');
  const add = async () => {
    setBusy(true);
    try {
      const r = await pushRows(Number(tableId), cols, {
        dest: 'campaign', config: { ...mapping, campaignId: campaign.id }, targetName: campaign.name,
        onlyValidColumn: onlyValid && verify ? verify.name : null, withStatus: true,
      });
      onQueued(r.queued, view.data!.table.name);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (tables.isLoading) return <Loading />;
  if (!tables.data?.length) return <div className="py-8 text-center text-sm text-slate-500">You don't have any tables yet. Find prospects from Home to create one.</div>;
  const emailCol = mapping.email.replace(/^\{\{|\}\}$/g, '');
  return (
    <div className="space-y-4">
      <Field label="Table" hint="Each row becomes a lead (matched by email, never duplicated) and joins at step 1. Unsubscribed, bounced and blacklisted addresses are skipped.">
        <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">Choose a table…</option>
          {tables.data.map((t) => <option key={t.id} value={t.id}>{t.name} ({fmtNumber(t.row_count)} rows)</option>)}
        </Select>
      </Field>
      {tableId && view.data && (emailCol
        ? <p className="text-[13px] text-slate-600">Email from column <b>{emailCol}</b>{mapping.firstName && <>, name from <b>{mapping.firstName.replace(/[{}]/g, '')}</b></>}. To map more fields or personalisation variables, use <b>Send to campaign</b> in the table.</p>
        : <Alert tone="yellow">This table has no email column. Add a Work email enrichment in the table first.</Alert>)}
      {verify && <Toggle checked={onlyValid} onChange={setOnlyValid} label={`Only rows where “${verify.name}” is valid`} />}
      <div className="flex justify-end"><Button variant="primary" disabled={!tableId || !emailCol} loading={busy} onClick={add}>Add table rows</Button></div>
    </div>
  );
}

function CsvImport({ campaign, onAdded }: { campaign: Campaign; onAdded: (n: number, summary: string) => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<Record<string, string>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // column -> field ('skip' | 'custom' | standard)
  const [listName, setListName] = useState('');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const read = async (f: File) => {
    setError('');
    const text = await f.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const cols = (parsed.meta.fields ?? []).filter(Boolean);
    if (!cols.length) { setError('Could not find a header row in this file.'); return; }
    setFile({ name: f.name, text });
    setHeaders(cols);
    setSample(parsed.data.slice(0, 3));
    setRowCount(parsed.data.length);
    setMapping(Object.fromEntries(cols.map((c) => [c, guessField(c)])));
    setListName(f.name.replace(/\.csv$/i, ''));
  };

  const emailColumn = Object.entries(mapping).find(([, f]) => f === 'email')?.[0];
  const doubles = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(mapping).forEach((f) => { if (f !== 'skip' && f !== 'custom') counts[f] = (counts[f] ?? 0) + 1; });
    return Object.entries(counts).filter(([, n]) => n > 1).map(([f]) => f);
  }, [mapping]);

  const submit = async () => {
    if (!file || !emailColumn) return;
    setBusy(true);
    setError('');
    const body: Record<string, string> = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (field === 'skip') continue;
      body[field === 'custom' ? col : field] = col;
    }
    try {
      const r = await api.post('/api/leads/bulk/csv', {
        csv: file.text, mapping: body, existing_lead_behavior: updateExisting ? 'patch' : 'skip',
        new_list_name: listName.trim() || undefined, campaign_id: campaign.id,
      });
      const d = r.data;
      const parts = [`${d.created} new`, d.updated ? `${d.updated} updated` : '', d.invalid.length ? `${d.invalid.length} invalid rows skipped` : ''].filter(Boolean);
      onAdded(d.attached_to_campaign, parts.join(', '));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!file) {
    return (
      <div className="space-y-3">
        {error && <Alert tone="red">{error}</Alert>}
        <label
          className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-brand-400 hover:bg-brand-50/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) read(f); }}
        >
          <FileUp className="size-8 text-slate-400" />
          <div className="mt-3 text-sm font-medium text-slate-800">Drop a CSV here or click to choose</div>
          <div className="mt-1 text-xs text-slate-500">Needs a header row and an email column. Other columns become custom variables.</div>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
        </label>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700"><span className="font-medium">{file.name}</span> · {fmtNumber(rowCount)} rows</span>
        <Button size="sm" variant="ghost" onClick={() => { setFile(null); setHeaders([]); }}>Choose another file</Button>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold text-slate-600">
            <tr><th className="px-3 py-2">CSV column</th><th className="px-3 py-2">Example</th><th className="px-3 py-2">Import as</th></tr>
          </thead>
          <tbody>
            {headers.map((h) => (
              <tr key={h} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium text-slate-800">{h}</td>
                <td className="max-w-40 truncate px-3 py-2 text-slate-500">{sample.map((s) => s[h]).find(Boolean) ?? '—'}</td>
                <td className="w-48 px-3 py-1.5">
                  <Select value={mapping[h]} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}>
                    {STANDARD_FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    <option value="custom">Custom variable</option>
                    <option value="skip">Don't import</option>
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!emailColumn && <Alert tone="yellow">Map one column to Email.</Alert>}
      {doubles.length > 0 && <Alert tone="yellow">Each field can only be mapped once: {doubles.join(', ')}.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Save as lead list" hint="Leave empty to skip creating a list."><Input value={listName} onChange={(e) => setListName(e.target.value)} /></Field>
        <div className="pt-6"><Toggle checked={updateExisting} onChange={setUpdateExisting} label="Update existing leads" description="Fill in new values for leads that already exist." /></div>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!emailColumn || doubles.length > 0} loading={busy} onClick={submit}>Import {fmtNumber(rowCount)} rows</Button>
      </div>
    </div>
  );
}

export function AddLeadsModal({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('existing');
  const { toast } = useUi();
  const finished = (n: number, extra?: string) => {
    toast(`${fmtNumber(n)} lead${n === 1 ? '' : 's'} added to the campaign${extra ? ` (${extra})` : ''}`);
    onDone();
    onClose();
  };
  const options: { id: Mode; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: 'existing', label: 'Existing leads', desc: 'Pick from your workspace', icon: <UserPlus className="size-4" /> },
    { id: 'list', label: 'Lead list', desc: 'Add a whole list', icon: <List className="size-4" /> },
    { id: 'table', label: 'Table', desc: 'Rows from a research table', icon: <Table2 className="size-4" /> },
    { id: 'csv', label: 'Import CSV', desc: 'Upload a spreadsheet', icon: <FileUp className="size-4" /> },
  ];
  return (
    <Modal open onClose={onClose} title="Add leads" description={`Leads join "${campaign.name}" at step 1.`} size="lg">
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map((o) => (
          <button key={o.id} onClick={() => setMode(o.id)} className={cx('rounded-lg border p-3 text-left transition-colors', mode === o.id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-900">{o.icon}{o.label}</div>
            <div className="mt-0.5 hidden text-xs text-slate-500 sm:block">{o.desc}</div>
          </button>
        ))}
      </div>
      {mode === 'existing' && <ExistingLeads campaign={campaign} onAdded={(n) => finished(n)} />}
      {mode === 'list' && <LeadListPicker campaign={campaign} onAdded={(n) => finished(n)} />}
      {mode === 'table' && <TablePicker campaign={campaign} onQueued={(n, t) => { toast(n ? `Adding ${fmtNumber(n)} row${n === 1 ? '' : 's'} from “${t}” — they appear in a few seconds` : `No new rows in “${t}” to add`); onDone(); onClose(); }} />}
      {mode === 'csv' && <CsvImport campaign={campaign} onAdded={finished} />}
    </Modal>
  );
}
