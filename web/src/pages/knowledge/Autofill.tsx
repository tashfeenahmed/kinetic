import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, Globe, Minus, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Checkbox, Input, Modal, Select, Shimmer, cx, useUi } from '../../components/ui.tsx';
import type { FolderRow } from './Tree.tsx';
import './knowledge.css';

const MarkdownPreview = lazy(() => import('./DocEditor.tsx').then((m) => ({ default: m.MarkdownPreview })));

interface DraftDoc { key: string; title: string; content: string; exists: boolean }
interface AutofillResult {
  drafts: DraftDoc[]; summary: string; ai: boolean; pages: string[]; host: string; folder_name?: string;
  searches: string[]; competitors: { name: string; website: string }[]; notes: string[];
  usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number; calls: number };
}
interface Step { id: number; label: string; status: 'running' | 'done' | 'failed' | 'skipped'; detail?: string }
interface ResearchRun { id: number; status: 'running' | 'done' | 'failed' | 'stopped'; steps: Step[]; error: string | null; result: AutofillResult | null }

/** Where the drafts go: a new folder (named after the site by default), an existing folder, or the top level. */
type Target = { kind: 'new'; name: string } | { kind: 'existing'; id: number } | { kind: 'root' };

const money = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(3)}` : '$0');

/** Follows a research run live (server-sent events, falling back to polling). */
function useResearchRun(id: number | null, onUpdate: (r: ResearchRun) => void) {
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  useEffect(() => {
    if (id == null) return;
    let finished = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const take = (r: ResearchRun) => {
      if (finished) return;
      cb.current(r);
      if (r.status !== 'running') { finished = true; es.close(); if (poll) clearInterval(poll); }
    };
    const es = new EventSource(`/api/knowledge/research/${id}/events`);
    es.onmessage = (e) => { try { take(JSON.parse(e.data)); } catch { /* ignore */ } };
    es.onerror = () => {
      es.close();
      if (finished || poll) return;
      poll = setInterval(() => { api.get(`/api/knowledge/research/${id}`).then((r) => take(r.data as ResearchRun)).catch(() => {}); }, 2000);
    };
    return () => { finished = true; es.close(); if (poll) clearInterval(poll); };
  }, [id]);
}

/** "Fill from website": domain -> research run (live steps) -> drafted docs -> tick the ones to create -> into a folder. */
export function AutofillModal({ open, folders, onClose, onCreated }: { open: boolean; folders: FolderRow[]; onClose: () => void; onCreated: (ids: number[], folderId: number | null) => void }) {
  const { toast } = useUi();
  const [domain, setDomain] = useState('');
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [result, setResult] = useState<AutofillResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<Target>({ kind: 'new', name: '' });
  const busy = run?.status === 'running';

  useEffect(() => { if (!open) { setResult(null); setRun(null); setOpenKey(null); } }, [open]);

  useResearchRun(busy ? run!.id : null, (r) => {
    setRun(r);
    if (r.status === 'failed') toast(`Could not research ${domain.trim()}: ${r.error ?? 'unknown error'}`, 'error');
    if (r.status !== 'done' || !r.result) return;
    const res = r.result;
    setResult(res);
    setPicked(new Set(res.drafts.filter((d) => !d.exists).map((d) => d.key)));
    setOpenKey(res.drafts[0]?.key ?? null);
    const name = res.folder_name || res.host || 'Company';
    // Re-running for the same site files into its existing folder.
    const same = folders.find((f) => f.parent_id == null && f.name.toLowerCase() === name.toLowerCase());
    setTarget(same ? { kind: 'existing', id: same.id } : { kind: 'new', name });
  });

  const read = async () => {
    try {
      setResult(null);
      setRun((await api.post('/api/knowledge/research', { domain: domain.trim() })).data as ResearchRun);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const stop = async () => {
    if (run && busy) await api.post(`/api/knowledge/research/${run.id}/stop`).catch(() => {});
    setRun(null);
  };

  const create = async () => {
    if (!result) return;
    setCreating(true);
    try {
      const docs = result.drafts.filter((d) => picked.has(d.key)).map((d) => ({ title: d.title, content: d.content }));
      const where = target.kind === 'new' ? { folder: target.name.trim().replace(/\//g, '-') || result.host } : target.kind === 'existing' ? { folder_id: target.id } : {};
      const r = await api.post<{ data: { id: number }[]; folder: { id: number; name: string } | null }>('/api/knowledge/docs/bulk', { docs, created_by: 'autofill', source_url: result.pages[0], ...where });
      toast(`Created ${docs.length} document${docs.length === 1 ? '' : 's'}${r.folder ? ` in “${r.folder.name}”` : ''}`);
      onCreated(r.data.map((d) => d.id), r.folder?.id ?? null);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setCreating(false); }
  };

  const toggle = (k: string, v: boolean) => setPicked((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; });

  if (result) {
    return (
      <Modal open={open} onClose={onClose} size="xl" title="Review the drafts"
        description={<>
          {`Researched ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} on ${result.host}`}
          {result.searches.length > 0 && `, ${result.searches.length} web searches`}
          {result.competitors.length > 0 && ` and ${result.competitors.length} competitor sites (${result.competitors.map((c) => c.name).join(', ')})`}
          {result.ai && ` · cost ${money(result.usage.cost_usd)} (${Math.round((result.usage.prompt_tokens + result.usage.completion_tokens) / 1000)}k tokens)`}
          {'. Tick the documents to create — nothing is saved until you do, and you can edit everything afterwards.'}
          {result.notes.map((n) => <span key={n} className="mt-1 block text-amber-700">{n}</span>)}
        </>}
        footer={<>
          <FolderPicker folders={folders} value={target} onChange={setTarget} />
          <Button onClick={() => setResult(null)}>Back</Button>
          <Button variant="primary" loading={creating} disabled={!picked.size} onClick={create}>Create {picked.size} document{picked.size === 1 ? '' : 's'}</Button>
        </>}>
        {result.drafts.length === 0 ? <p className="text-[13px] text-zinc-500">Nothing could be drafted from this site.</p> : (
          <div className="max-h-[62vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 scroll-thin">
            {result.drafts.map((d) => {
              const expanded = openKey === d.key;
              return (
                <div key={d.key} className={cx(!picked.has(d.key) && 'bg-zinc-50/60')}>
                  <div className="flex items-center gap-2.5 px-3 py-2.5">
                    <Checkbox checked={picked.has(d.key)} onChange={(v) => toggle(d.key, v)} />
                    <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpenKey(expanded ? null : d.key)}>
                      {expanded ? <ChevronDown className="size-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="size-3.5 shrink-0 text-zinc-400" />}
                      <span className="truncate text-[13.5px] font-medium text-zinc-900">{d.title}</span>
                      <span className="shrink-0 text-[12px] text-zinc-400">{d.content.length.toLocaleString()} chars</span>
                    </button>
                    {d.exists && <span className="shrink-0 text-[12px] text-amber-600">You already have a doc with this title</span>}
                  </div>
                  {expanded && (
                    <div className="px-10 pb-4 pt-1">
                      <Suspense fallback={<p className="text-shimmer text-[12.5px]">Loading preview…</p>}><MarkdownPreview markdown={d.content} /></Suspense>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Fill from website"
      description="Kinetic researches your company like an analyst: it reads ~20 pages of your site, searches the web for competitors, reviews and press, checks competitor sites, then writes detailed docs — company overview, products, ICP, buyer personas, positioning, competitors, proof, tone of voice and objection handling. Takes a minute or two; you review everything before it is saved."
      footer={<>
        {busy ? <Button onClick={stop}>Stop</Button> : <Button onClick={onClose}>Cancel</Button>}
        <Button variant="primary" disabled={!domain.trim() || busy} onClick={read} icon={<Globe className="size-4" />}>Research website</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (domain.trim() && !busy) void read(); }}>
        <Input autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" disabled={busy} />
      </form>
      {run && run.status !== 'stopped' && <Progress run={run} />}
    </Modal>
  );
}

/** The run's steps as they happen: finished ones ticked, running ones shimmering. */
function Progress({ run }: { run: ResearchRun }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [run.steps.length]);
  const pages = run.steps.filter((s) => s.label.startsWith('Reading /') && s.status === 'done').length;
  const searches = run.steps.filter((s) => s.label.startsWith('Searching') && s.status === 'done').length;
  const written = run.steps.filter((s) => s.label.startsWith('Writing') && s.status === 'done').length;
  return (
    <div className="mt-4" aria-live="polite">
      <div className="mb-1.5 flex gap-3 text-[11.5px] text-zinc-400">
        <span>{pages + (run.steps.length ? 1 : 0)} pages read</span><span>{searches} searches</span><span>{written} docs written</span>
      </div>
      <div ref={ref} className="max-h-[260px] space-y-1 overflow-y-auto pr-1 scroll-thin">
        {run.steps.length === 0 && <Shimmer className="text-[13px]">Starting…</Shimmer>}
        {run.steps.map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-[13px]">
            {s.status === 'running' ? <span className="mx-1 size-1.5 shrink-0 rounded-full bg-zinc-500" />
              : s.status === 'done' ? <Check className="size-3.5 shrink-0 text-zinc-400" />
                : s.status === 'failed' ? <X className="size-3.5 shrink-0 text-zinc-300" /> : <Minus className="size-3.5 shrink-0 text-zinc-300" />}
            {s.status === 'running' ? <Shimmer className="font-medium">{s.label}</Shimmer>
              : <span className={cx('truncate', s.status === 'done' ? 'text-zinc-500' : 'text-zinc-400')}>{s.label.replace(/…$/, '')}</span>}
            {s.detail && s.status !== 'running' && <span className="ml-auto shrink-0 truncate pl-2 text-[11.5px] text-zinc-400" style={{ maxWidth: '45%' }}>{s.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Save to" control for the review step. */
function FolderPicker({ folders, value, onChange }: { folders: FolderRow[]; value: Target; onChange: (t: Target) => void }) {
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  const selectValue = value.kind === 'existing' ? String(value.id) : value.kind;
  return (
    <div className="mr-auto flex min-w-0 items-center gap-2 text-[13px] text-zinc-500">
      <Folder className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
      <span className="shrink-0">Save to</span>
      <Select aria-label="Target folder" value={selectValue} className="w-[190px] shrink-0"
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'new' ? { kind: 'new', name: value.kind === 'new' ? value.name : '' } : v === 'root' ? { kind: 'root' } : { kind: 'existing', id: Number(v) });
        }}>
        <option value="new">New folder</option>
        {sorted.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
        <option value="root">Top level (no folder)</option>
      </Select>
      {value.kind === 'new' && (
        <Input aria-label="New folder name" value={value.name} onChange={(e) => onChange({ kind: 'new', name: e.target.value })} placeholder="Folder name" className="w-40" />
      )}
    </div>
  );
}
