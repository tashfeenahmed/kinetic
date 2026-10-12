import { lazy, Suspense, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Globe } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Checkbox, Input, Modal, cx, useUi } from '../../components/ui.tsx';
import './knowledge.css';

const MarkdownPreview = lazy(() => import('./DocEditor.tsx').then((m) => ({ default: m.MarkdownPreview })));

interface DraftDoc { key: string; title: string; content: string; exists: boolean }
interface AutofillResult { drafts: DraftDoc[]; summary: string; ai: boolean; pages: string[]; host: string }

const STEPS = ['Reading the home page', 'Following about, product and pricing pages', 'Drafting the documents', 'Tidying up the drafts'];

/** "Fill from website": domain -> crawl -> drafted docs -> tick the ones to create. */
export function AutofillModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (ids: number[]) => void }) {
  const { toast } = useUi();
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<AutofillResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 4500);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => { if (!open) { setResult(null); setBusy(false); setOpenKey(null); } }, [open]);

  const read = async () => {
    setBusy(true);
    try {
      const r = (await api.post('/api/knowledge/autofill', { domain: domain.trim() })).data as AutofillResult;
      setResult(r);
      setPicked(new Set(r.drafts.filter((d) => !d.exists).map((d) => d.key)));
      setOpenKey(r.drafts[0]?.key ?? null);
      if (!r.ai) toast('No AI model is set up, so only a short company overview was read from the site. Add an OpenRouter key for full drafts.', 'info');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  const create = async () => {
    if (!result) return;
    setCreating(true);
    try {
      const docs = result.drafts.filter((d) => picked.has(d.key)).map((d) => ({ title: d.title, content: d.content }));
      const r = await api.post('/api/knowledge/docs/bulk', { docs, created_by: 'autofill', source_url: result.pages[0] });
      toast(`Created ${docs.length} document${docs.length === 1 ? '' : 's'}`);
      onCreated((r.data as { id: number }[]).map((d) => d.id));
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setCreating(false); }
  };

  const toggle = (k: string, v: boolean) => setPicked((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; });

  if (result) {
    return (
      <Modal open={open} onClose={onClose} size="xl" title="Review the drafts"
        description={`Drafted from ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} on ${result.host}. Tick the documents to create — nothing is saved until you do, and you can edit everything afterwards.`}
        footer={<>
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
      description="Kinetic reads your home, about, product, pricing and customer pages and drafts the core documents: company overview, offers, ICP, personas, positioning, competitors, case studies and tone of voice. You review them before anything is created."
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" disabled={!domain.trim() || busy} onClick={read} icon={<Globe className="size-4" />}>Read website</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (domain.trim() && !busy) void read(); }}>
        <Input autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" disabled={busy} />
      </form>
      {busy && (
        <div className="mt-4 space-y-1.5" aria-live="polite">
          {STEPS.map((s, i) => (
            <div key={s} className={cx('flex items-center gap-2 text-[13px]', i > step && 'text-zinc-300')}>
              {i < step ? <Check className="size-3.5 text-zinc-500" /> : <span className={cx('size-1.5 rounded-full', i === step ? 'bg-zinc-500' : 'bg-zinc-200')} style={{ margin: '0 4px' }} />}
              <span className={cx(i === step ? 'text-shimmer font-medium' : i < step ? 'text-zinc-500' : '')}>{i === step ? `${s}…` : s}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
