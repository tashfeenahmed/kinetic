import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { CheckCircle2, FileUp, Upload } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtNumber } from '../../lib/format.ts';
import { Alert, Badge, Button, cx, Field, Input, Modal, Select, Table, Td, Th, useUi } from '../../components/ui.tsx';
import type { LeadList } from './types.ts';

const STANDARD = [
  { key: 'email', label: 'Email' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'title', label: 'Title' },
  { key: 'notes', label: 'Notes' },
];

/** Guesses the lead field for a CSV header. */
function guess(header: string, customVars: string[]): string {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^(email|emailaddress|mail|workemail|e?mail)$/.test(h) || h.includes('email')) return 'email';
  if (/^(firstname|first|fname|givenname)$/.test(h)) return 'first_name';
  if (/^(lastname|last|lname|surname|familyname)$/.test(h)) return 'last_name';
  if (/^(company|companyname|organization|organisation|account|accountname)$/.test(h)) return 'company';
  if (/^(title|jobtitle|position|role)$/.test(h)) return 'title';
  if (/^(notes?|comment|comments)$/.test(h)) return 'notes';
  const existing = customVars.find((v) => v.toLowerCase().replace(/[^a-z0-9]/g, '') === h);
  if (existing) return `var:${existing}`;
  return `new:${header}`;
}

type Step = 'upload' | 'map' | 'options' | 'done';

export function ImportWizard({ open, onClose, campaignId }: { open: boolean; onClose: () => void; campaignId?: number }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [listMode, setListMode] = useState<'none' | 'existing' | 'new'>('new');
  const [listId, setListId] = useState('');
  const [newList, setNewList] = useState('');
  const [campaign, setCampaign] = useState(campaignId ? String(campaignId) : '');
  const [behavior, setBehavior] = useState<'patch' | 'put' | 'skip'>('patch');
  const [result, setResult] = useState<any>(null);
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState('');

  const customVars = useQuery({ queryKey: ['custom-variables'], queryFn: () => api.get('/api/custom-variables').then((r) => r.data as { id: number; name: string }[]), enabled: open });
  const lists = useQuery({ queryKey: ['lead-lists'], queryFn: () => api.get('/api/lead-lists').then((r) => r.data as LeadList[]), enabled: open });
  const campaigns = useQuery({ queryKey: ['campaigns', 'all'], queryFn: () => api.get('/api/campaigns', { per_page: 200 }).then((r) => r.data as { id: number; name: string; status: string }[]), enabled: open && !campaignId });

  const reset = () => {
    setStep('upload'); setFileName(''); setCsvText(''); setHeaders([]); setRows([]); setTargets({}); setResult(null); setParseError('');
    setListMode('new'); setListId(''); setNewList(''); setCampaign(campaignId ? String(campaignId) : ''); setBehavior('patch');
  };
  const close = () => { onClose(); setTimeout(reset, 200); };

  const load = (file: File) => {
    setParseError('');
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const fields = (res.meta.fields ?? []).filter((f) => f.trim() !== '');
        if (!fields.length || !res.data.length) { setParseError('That file has no rows. Make sure the first row contains column names.'); return; }
        const names = (customVars.data ?? []).map((v) => v.name);
        const t: Record<string, string> = {};
        let emailTaken = false;
        for (const f of fields) {
          let g = guess(f, names);
          if (g === 'email') { if (emailTaken) g = `new:${f}`; emailTaken = true; }
          t[f] = g;
        }
        // Only one column per standard field.
        const used = new Set<string>();
        for (const f of fields) {
          if (!t[f]!.startsWith('new:') && !t[f]!.startsWith('var:')) {
            if (used.has(t[f]!)) t[f] = `new:${f}`;
            used.add(t[f]!);
          }
        }
        setFileName(file.name);
        setHeaders(fields);
        setRows(res.data);
        setCsvText(Papa.unparse({ fields, data: res.data.map((r) => fields.map((f) => r[f] ?? '')) }));
        setTargets(t);
        setNewList(file.name.replace(/\.csv$/i, ''));
        setStep('map');
      },
      error: (err) => setParseError(err.message),
    });
  };

  const emailColumn = headers.find((h) => targets[h] === 'email');
  const validEmails = useMemo(() => (emailColumn ? rows.filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((r[emailColumn] ?? '').trim())).length : 0), [rows, emailColumn]);

  const run = useMutation({
    mutationFn: () => {
      const mapping: Record<string, string> = {};
      for (const [col, target] of Object.entries(targets)) {
        if (target === 'skip') continue;
        if (target.startsWith('var:') || target.startsWith('new:')) {
          const name = target.slice(4).trim();
          if (name) mapping[name] = col;
        } else mapping[target] = col;
      }
      return api.post('/api/leads/bulk/csv', {
        csv: csvText,
        mapping,
        existing_lead_behavior: behavior,
        lead_list_id: listMode === 'existing' && listId ? Number(listId) : undefined,
        new_list_name: listMode === 'new' && newList.trim() ? newList.trim() : undefined,
        campaign_id: campaign ? Number(campaign) : undefined,
      });
    },
    onSuccess: (r) => {
      setResult(r.data);
      setStep('done');
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead-lists'] });
      qc.invalidateQueries({ queryKey: ['custom-variables'] });
      qc.invalidateQueries({ queryKey: ['campaign'] });
      qc.invalidateQueries({ queryKey: ['campaign-leads'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const stepper = (
    <ol className="mb-5 flex items-center gap-2 text-[13px]">
      {(['upload', 'map', 'options', 'done'] as Step[]).map((s, i) => {
        const idx = ['upload', 'map', 'options', 'done'].indexOf(step);
        const label = ['Upload', 'Map columns', 'Options', 'Done'][i];
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-slate-200" />}
            <span className={cx('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold', i < idx ? 'bg-emerald-500 text-white' : i === idx ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600')}>{i + 1}</span>
            <span className={i === idx ? 'font-medium text-slate-900' : 'text-slate-500'}>{label}</span>
          </li>
        );
      })}
    </ol>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (step === 'upload') {
    body = (
      <>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) load(f); }}
          onClick={() => fileRef.current?.click()}
          className={cx('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors', dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50')}
        >
          <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Upload className="size-5" /></div>
          <div className="text-[15px] font-medium text-slate-900">Drop a CSV file here, or click to browse</div>
          <div className="mt-1 text-sm text-slate-500">The first row should contain column names. Any extra columns can become custom variables.</div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
        </div>
        {parseError && <div className="mt-3"><Alert tone="red">{parseError}</Alert></div>}
      </>
    );
    footer = <Button onClick={close}>Cancel</Button>;
  } else if (step === 'map') {
    const varNames = (customVars.data ?? []).map((v) => v.name);
    const usedStandard = new Set(Object.values(targets).filter((t) => !t.includes(':') && t !== 'skip'));
    body = (
      <>
        <div className="mb-4 flex items-center gap-2 text-sm text-slate-600">
          <FileUp className="size-4" /> <span className="font-medium text-slate-800">{fileName}</span> · {fmtNumber(rows.length)} rows
        </div>
        {!emailColumn && <div className="mb-3"><Alert tone="yellow">Map one column to <b>Email</b> to continue.</Alert></div>}
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
          <Table>
            <thead className="sticky top-0 bg-slate-50"><tr><Th>CSV column</Th><Th>Sample values</Th><Th className="w-64">Import as</Th></tr></thead>
            <tbody>
              {headers.map((h) => {
                const t = targets[h] ?? 'skip';
                return (
                  <tr key={h}>
                    <Td className="font-medium text-slate-900">{h}</Td>
                    <Td className="max-w-xs"><div className="truncate text-slate-500">{rows.slice(0, 3).map((r) => r[h]).filter(Boolean).join(', ') || '—'}</div></Td>
                    <Td>
                      <Select value={t} onChange={(e) => setTargets((all) => ({ ...all, [h]: e.target.value }))}>
                        <optgroup label="Lead fields">
                          {STANDARD.map((s) => <option key={s.key} value={s.key} disabled={usedStandard.has(s.key) && t !== s.key}>{s.label}</option>)}
                        </optgroup>
                        <optgroup label="Custom variable">
                          <option value={`new:${h}`}>{varNames.includes(h) ? h : `New variable “${h}”`}</option>
                          {varNames.filter((v) => v !== h).map((v) => <option key={v} value={`var:${v}`}>{v}</option>)}
                        </optgroup>
                        <option value="skip">Don’t import</option>
                      </Select>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-slate-700">Preview</div>
          <div className="overflow-x-auto rounded-lg border border-slate-200 scroll-thin">
            <Table>
              <thead className="bg-slate-50"><tr>{headers.map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{headers.map((h) => <Td key={h} className="max-w-[200px] truncate">{r[h]}</Td>)}</tr>)}</tbody>
            </Table>
          </div>
        </div>
      </>
    );
    footer = <><Button onClick={() => setStep('upload')}>Back</Button><Button variant="primary" disabled={!emailColumn} onClick={() => setStep('options')}>Continue</Button></>;
  } else if (step === 'options') {
    body = (
      <div className="space-y-5">
        <Alert tone="blue">{fmtNumber(validEmails)} of {fmtNumber(rows.length)} rows have a valid email address.</Alert>
        <Field label="Lead list" hint="Lists help you find and reuse groups of leads later.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={listMode} onChange={(e) => setListMode(e.target.value as any)} className="sm:w-48">
              <option value="new">Create a new list</option>
              <option value="existing">Add to existing list</option>
              <option value="none">Don’t add to a list</option>
            </Select>
            {listMode === 'new' && <Input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="List name" />}
            {listMode === 'existing' && (
              <Select value={listId} onChange={(e) => setListId(e.target.value)} className="flex-1">
                <option value="">Choose a list…</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({fmtNumber(l.leads_count ?? 0)})</option>)}
              </Select>
            )}
          </div>
        </Field>
        {!campaignId && (
          <Field label="Add to campaign (optional)">
            <Select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">Don’t add to a campaign</option>
              {campaigns.data?.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-700">If a lead already exists</div>
          <div className="space-y-2">
            {([
              ['patch', 'Fill in new information', 'Keep existing values, add anything that was blank.'],
              ['put', 'Overwrite with the file', 'Replace existing values with what is in this CSV.'],
              ['skip', 'Skip existing leads', 'Leave them untouched.'],
            ] as const).map(([v, label, desc]) => (
              <label key={v} className={cx('flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5', behavior === v ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200 hover:bg-slate-50')}>
                <input type="radio" className="mt-1 accent-brand-600" checked={behavior === v} onChange={() => setBehavior(v)} />
                <span><span className="block text-sm font-medium text-slate-800">{label}</span><span className="block text-[13px] text-slate-500">{desc}</span></span>
              </label>
            ))}
          </div>
        </div>
      </div>
    );
    footer = <><Button onClick={() => setStep('map')}>Back</Button><Button variant="primary" loading={run.isPending} disabled={listMode === 'existing' && !listId} onClick={() => run.mutate()}>Import {fmtNumber(validEmails)} leads</Button></>;
  } else {
    const r = result ?? {};
    body = (
      <div>
        <div className="flex flex-col items-center py-4 text-center">
          <CheckCircle2 className="size-10 text-emerald-500" />
          <h3 className="mt-3 text-lg font-semibold text-slate-900">Import complete</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Created', r.created], ['Updated', r.updated], ['Skipped', r.skipped], ['Invalid', r.invalid?.length ?? 0]].map(([l, v]) => (
            <div key={l} className="rounded-lg border border-slate-200 px-3 py-2.5 text-center">
              <div className="text-xl font-semibold text-slate-900">{fmtNumber(v as number)}</div>
              <div className="text-xs text-slate-500">{l}</div>
            </div>
          ))}
        </div>
        {r.attached_to_campaign > 0 && <div className="mt-4"><Alert tone="green">{fmtNumber(r.attached_to_campaign)} leads added to the campaign.</Alert></div>}
        {r.invalid?.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-sm font-medium text-slate-700">Rows that were not imported</div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
              <Table>
                <thead className="bg-slate-50"><tr><Th>Line</Th><Th>Email</Th><Th>Reason</Th></tr></thead>
                <tbody>{r.invalid.map((x: any) => <tr key={x.line}><Td>{x.line}</Td><Td>{x.email || <span className="text-slate-400">(empty)</span>}</Td><Td><Badge tone="red">{x.reason}</Badge></Td></tr>)}</tbody>
              </Table>
            </div>
          </div>
        )}
      </div>
    );
    footer = <Button variant="primary" onClick={close}>Done</Button>;
  }

  return (
    <Modal open={open} onClose={close} title="Import leads from CSV" size="xl" footer={footer}>
      {stepper}
      {body}
    </Modal>
  );
}

