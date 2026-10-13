import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Field, Input, Modal, Select, Textarea, Toggle, useUi } from '../../components/ui.tsx';
import { useGtmTables } from '../../gtm/lib/queries.ts';

export const SCHEDULE_LABELS: Record<string, string> = { off: 'Manual only', hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };

export interface SearchDraft {
  name: string;
  source: string;
  params: Record<string, unknown>;
  max_results?: number;
}

/**
 * Save a search as a watcher: name, target table, schedule and alert.
 * With `editParams`, the source params are editable as JSON (Searches page "New saved search").
 */
export function SaveSearchModal({ open, onClose, draft, sources, editParams }: {
  open: boolean;
  onClose: () => void;
  draft: SearchDraft;
  sources?: { id: string; label: string; ready: boolean }[];
  editParams?: boolean;
}) {
  const [name, setName] = useState(draft.name);
  const [source, setSource] = useState(draft.source);
  const [params, setParams] = useState(JSON.stringify(draft.params, null, 2));
  const [maxResults, setMaxResults] = useState(draft.max_results ?? 100);
  const [schedule, setSchedule] = useState('daily');
  const [tableId, setTableId] = useState('');
  const [alertKind, setAlertKind] = useState('');
  const [alertTarget, setAlertTarget] = useState('');
  const [excl, setExcl] = useState(true);
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tables = useGtmTables();
  const qc = useQueryClient();
  const { toast } = useUi();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setName(draft.name); setSource(draft.source); setParams(JSON.stringify(draft.params, null, 2)); setMaxResults(draft.max_results ?? 100); setErr('');
    // Reset only when the modal opens, so typing isn't undone by a parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      let p: Record<string, unknown> = draft.params;
      if (editParams) {
        try { p = params.trim() ? JSON.parse(params) : {}; } catch { throw new Error('Params must be valid JSON, e.g. {"query": "dentist", "location": "Berlin"}'); }
      }
      const alert = alertKind === 'slack' ? { kind: 'slack', channel: alertTarget || undefined } : alertKind === 'webhook' ? { kind: 'webhook', url: alertTarget } : {};
      const r = await api.post<{ id: number; run?: { table_id: number | null; new_count: number; status: string; error?: string } }>('/api/saved-searches', {
        name: name.trim(), source, params: p, max_results: maxResults, schedule, apply_exclusions: excl, alert, run_now: runNow,
        table_id: tableId ? Number(tableId) : null,
      });
      await qc.invalidateQueries({ queryKey: ['saved-searches'] });
      await qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      onClose();
      if (r.run?.status === 'error') toast(`Saved, but the first run failed: ${r.run.error}`, 'error');
      else if (r.run?.table_id) { toast(`Saved · ${r.run.new_count} rows added`); navigate(`/tables/${r.run.table_id}`); }
      else toast('Search saved');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Save search" description="Re-run it on demand or on a schedule. Each run adds only rows it has never added before." size="md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !source} onClick={save}>{runNow ? 'Save and run' : 'Save'}</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Dentists in Berlin" /></Field>
        {editParams && sources && (
          <>
            <Field label="Source">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                {sources.map((s) => <option key={s.id} value={s.id} disabled={!s.ready}>{s.label}{s.ready ? '' : ' (needs a key)'}</option>)}
              </Select>
            </Field>
            <Field label="Search params (JSON)" hint={PARAM_HINTS[source] ?? 'Source-specific parameters, e.g. {"query": "…"}'}>
              <Textarea rows={4} value={params} onChange={(e) => setParams(e.target.value)} className="font-mono text-[12.5px]" />
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Schedule">
            <Select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
              {Object.entries(SCHEDULE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Max results per run"><Input type="number" min={1} max={2000} value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value) || 100)} /></Field>
        </div>
        <Field label="Add new rows to" hint="A new table named after the search is created on the first run with results.">
          <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
            <option value="">New table</option>
            {tables.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <Field label="Alert on new rows">
            <Select value={alertKind} onChange={(e) => setAlertKind(e.target.value)}>
              <option value="">None</option>
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
            </Select>
          </Field>
          {alertKind && (
            <Field label={alertKind === 'slack' ? 'Channel (optional)' : 'Webhook URL'}>
              <Input value={alertTarget} onChange={(e) => setAlertTarget(e.target.value)} placeholder={alertKind === 'slack' ? '#new-leads (uses the default Slack webhook if empty)' : 'https://…'} />
            </Field>
          )}
        </div>
        <Toggle checked={excl} onChange={setExcl} label="Skip excluded companies and people" description="Rows on any exclusion list are never added." />
        <Toggle checked={runNow} onChange={setRunNow} label="Run now" description="Fill the table straight away; later runs add only new rows." />
        {err && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{err}</p>}
      </div>
    </Modal>
  );
}

export const PARAM_HINTS: Record<string, string> = {
  google_maps: '{"query": "dentist", "location": "Berlin", "radius_km": 10} or {"query": "cafe", "bbox": {"south":…, "west":…, "north":…, "east":…}}',
  funding_rounds: '{"countries": "us,uk,fr,es,ch,no", "sector": "tech", "days": 3} — sector: tech | health | fintech | energy | consumer; or "keywords": "robots, drones"',
  company_lookalikes: '{"seeds": ["stripe.com", "adyen.com"]} or {"table_id": 12}',
  people_lookalikes: '{"seeds": ["VP Sales", "Head of Revenue"], "companies": ["ramp.com"]}',
  find_companies: '{"query": "restaurant POS"}',
  ai_companies: '{"query": "B2B payroll software in the UK"}',
  yc_companies: '{"query": "fintech", "batch": "W24", "hiring": "yes"}',
  apollo_companies: '{"keywords": "logistics", "locations": "Germany", "employees": "11-50"}',
  apollo_people: '{"titles": "Head of Sales", "domains": "ramp.com", "seniorities": "vp,director"}',
  github_people: '{"org": "vercel"}',
  jobs: '{"domains": "ramp.com, linear.app", "keywords": "sales"}',
  hubspot_contacts: '{}',
  hubspot_companies: '{}',
};
