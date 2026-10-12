import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronDown, ChevronRight, FileText, Globe, Link2, Plus, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtRelative } from '../lib/format.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Checkbox, Field, Input, Loading, Modal, Textarea, cx, useUi } from '../components/ui.tsx';

interface Offer { name: string; description: string; pricing: string }
interface Persona { title: string; pains: string; goals: string; objections: string }
interface Competitor { name: string; domain: string; notes: string }
interface Proof { title: string; summary: string; url: string }
interface Hub {
  company: { name: string; website: string; overview: string };
  offers: Offer[];
  icp: { industries: string[]; sizes: string[]; geos: string[]; tech: string[]; triggers: string[]; notes: string };
  personas: Persona[];
  positioning: string;
  competitors: Competitor[];
  proof: Proof[];
  tone: string;
  exclusions: string;
  updated_at?: string | null;
}
interface Doc { id: number; title: string; source_url: string | null; summary: string | null; chars: number; created_at: string }
type Draft = Partial<Hub>;

const SECTION_LABELS: Record<string, string> = {
  company: 'Company overview', offers: 'Products & offers', icp: 'Ideal customer profile', personas: 'Buyer personas', positioning: 'Positioning & value props',
  competitors: 'Competitors', proof: 'Case studies & proof', tone: 'Tone of voice & email guidelines', exclusions: 'Exclusions / do not target',
};

/** Knowledge Hub: what we sell and to whom — used by the agent and AI research columns. */
export function KnowledgePage() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['knowledge'], queryFn: () => api.get('/api/knowledge') as Promise<{ data: Hub; docs: Doc[] }> });
  const [hub, setHub] = useState<Hub | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ draft: Draft; source: string } | null>(null);
  useEffect(() => { if (q.data && !dirty) setHub(q.data.data); }, [q.data, dirty]);

  if (q.isLoading || !hub) return <Loading />;
  const set = <K extends keyof Hub>(k: K, v: Hub[K]) => { setHub((h) => (h ? { ...h, [k]: v } : h)); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      const { updated_at: _u, ...body } = hub;
      const r = await api.put('/api/knowledge', body);
      setHub(r.data);
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['knowledge'] });
      toast('Knowledge Hub saved');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Page>
      <div className="mb-6 flex flex-col gap-3 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-900"><BookOpen className="size-5" />Knowledge Hub</h1>
          <p className="mt-1 max-w-2xl text-[14px] text-zinc-500">What you sell and to whom. The agent reads it on every chat, and AI research columns can use it (tick “Use Knowledge Hub”) to judge fit and write on-brand copy.</p>
        </div>
        <div className="flex items-center gap-2">
          {hub.updated_at && !dirty && <span className="text-[12px] text-zinc-400">Saved {fmtRelative(hub.updated_at)}</span>}
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>{dirty ? 'Save changes' : 'Saved'}</Button>
        </div>
      </div>

      <AutoFill onDraft={(d, source) => setDraft({ draft: d, source })} defaultDomain={hub.company.website} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          <Section title={SECTION_LABELS.company}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Company name"><Input value={hub.company.name} onChange={(e) => set('company', { ...hub.company, name: e.target.value })} /></Field>
              <Field label="Website"><Input value={hub.company.website} onChange={(e) => set('company', { ...hub.company, website: e.target.value })} placeholder="acme.com" /></Field>
            </div>
            <Field label="Overview" className="mt-3"><Textarea rows={3} value={hub.company.overview} onChange={(e) => set('company', { ...hub.company, overview: e.target.value })} placeholder="What you do, for whom, in 2–4 sentences." /></Field>
          </Section>

          <Section title={SECTION_LABELS.offers}>
            <ListEditor items={hub.offers} onChange={(v) => set('offers', v)} blank={{ name: '', description: '', pricing: '' }} addLabel="Add offer"
              fields={[{ k: 'name', label: 'Name' }, { k: 'pricing', label: 'Pricing', placeholder: '€49/mo' }, { k: 'description', label: 'Description', long: true }]} />
          </Section>

          <Section title={SECTION_LABELS.icp}>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['industries', 'sizes', 'geos', 'tech', 'triggers'] as const).map((k) => (
                <Field key={k} label={{ industries: 'Industries', sizes: 'Company sizes', geos: 'Geographies', tech: 'Tech they use', triggers: 'Buying triggers' }[k]} hint="Comma-separated">
                  <TagInput value={hub.icp[k]} onChange={(v) => set('icp', { ...hub.icp, [k]: v })} placeholder={{ industries: 'Hospitality, Retail', sizes: '1-50, 51-200', geos: 'Ireland, UK', tech: 'Shopify, Square', triggers: 'Opening a new site, hiring managers' }[k]} />
                </Field>
              ))}
            </div>
            <Field label="Notes" className="mt-3"><Textarea rows={2} value={hub.icp.notes} onChange={(e) => set('icp', { ...hub.icp, notes: e.target.value })} /></Field>
          </Section>

          <Section title={SECTION_LABELS.personas}>
            <ListEditor items={hub.personas} onChange={(v) => set('personas', v)} blank={{ title: '', pains: '', goals: '', objections: '' }} addLabel="Add persona"
              fields={[{ k: 'title', label: 'Title / role' }, { k: 'pains', label: 'Pains', long: true }, { k: 'goals', label: 'Goals', long: true }, { k: 'objections', label: 'Objections', long: true }]} />
          </Section>

          <Section title={SECTION_LABELS.positioning}>
            <Textarea rows={4} value={hub.positioning} onChange={(e) => set('positioning', e.target.value)} placeholder="Why you win: value props and differentiators." />
          </Section>

          <Section title={SECTION_LABELS.competitors}>
            <ListEditor items={hub.competitors} onChange={(v) => set('competitors', v)} blank={{ name: '', domain: '', notes: '' }} addLabel="Add competitor"
              fields={[{ k: 'name', label: 'Name' }, { k: 'domain', label: 'Domain' }, { k: 'notes', label: 'How you compare', long: true }]} />
          </Section>

          <Section title={SECTION_LABELS.proof}>
            <ListEditor items={hub.proof} onChange={(v) => set('proof', v)} blank={{ title: '', summary: '', url: '' }} addLabel="Add proof point"
              fields={[{ k: 'title', label: 'Title', placeholder: 'Café X cut queues 30%' }, { k: 'url', label: 'Link' }, { k: 'summary', label: 'Summary', long: true }]} />
          </Section>

          <Section title={SECTION_LABELS.tone}>
            <Textarea rows={4} value={hub.tone} onChange={(e) => set('tone', e.target.value)} placeholder="e.g. Friendly and direct. Under 90 words, one question as the CTA, no buzzwords, sign off with first name." />
          </Section>

          <Section title={SECTION_LABELS.exclusions}>
            <Textarea rows={3} value={hub.exclusions} onChange={(e) => set('exclusions', e.target.value)} placeholder="Who not to target: existing customers, competitors, chains with 50+ sites…" />
          </Section>
        </div>

        <div className="space-y-5">
          <Docs docs={q.data?.docs ?? []} onDraft={(d, source) => setDraft({ draft: d, source })} />
          <ContextPreview updatedAt={hub.updated_at ?? ''} />
        </div>
      </div>

      {dirty && (
        <div className="sticky bottom-4 mt-6 flex justify-end">
          <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 shadow-lg">
            <span className="text-[13px] text-zinc-600">Unsaved changes</span>
            <Button size="sm" onClick={() => { setDirty(false); setHub(q.data!.data); }}>Discard</Button>
            <Button size="sm" variant="primary" loading={saving} onClick={save}>Save</Button>
          </div>
        </div>
      )}

      {draft && <DraftReview draft={draft.draft} source={draft.source} current={hub} onClose={() => setDraft(null)}
        onApply={(picked) => { setHub((h) => (h ? { ...h, ...picked } : h)); setDirty(true); setDraft(null); toast('Draft applied — review and save'); }} />}
    </Page>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4">
      <h2 className="mb-3 text-[13.5px] font-semibold text-zinc-900">{title}</h2>
      {children}
    </section>
  );
}

function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => { setText(value.join(', ')); }, [value.join('\u0000')]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
    onBlur={() => onChange(text.split(',').map((x) => x.trim()).filter(Boolean))} />;
}

function ListEditor<T extends Record<string, string>>({ items, onChange, blank, fields, addLabel }: {
  items: T[]; onChange: (v: T[]) => void; blank: T; addLabel: string;
  fields: { k: keyof T & string; label: string; long?: boolean; placeholder?: string }[];
}) {
  const update = (i: number, k: string, v: string) => onChange(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i} className="relative rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 pr-10">
          <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="absolute right-2 top-2 rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600" aria-label="Remove" title="Remove"><X className="size-3.5" /></button>
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((f) => (
              <label key={f.k} className={cx('block', f.long && 'sm:col-span-2')}>
                <span className="mb-1 block text-[12px] font-medium text-zinc-500">{f.label}</span>
                {f.long
                  ? <Textarea rows={2} value={it[f.k] ?? ''} placeholder={f.placeholder} onChange={(e) => update(i, f.k, e.target.value)} />
                  : <Input value={it[f.k] ?? ''} placeholder={f.placeholder} onChange={(e) => update(i, f.k, e.target.value)} />}
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...items, { ...blank }])}>{addLabel}</Button>
    </div>
  );
}

function AutoFill({ onDraft, defaultDomain }: { onDraft: (d: Draft, source: string) => void; defaultDomain: string }) {
  const { toast } = useUi();
  const qc = useQueryClient();
  const [domain, setDomain] = useState(defaultDomain);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/knowledge/autofill', { domain: domain.trim(), apply: false });
      await qc.invalidateQueries({ queryKey: ['knowledge'] });
      if (!r.data.ai) toast('No AI model is set up, so only the basics were read from the site. Add an OpenRouter key for a full draft.', 'info');
      onDraft(r.data.draft, `${r.data.pages.length} page${r.data.pages.length === 1 ? '' : 's'} from ${domain.trim()}`);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-gradient-to-br from-zinc-50 to-white p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white"><Sparkles className="size-4" /></div>
        <div>
          <div className="text-[13.5px] font-medium text-zinc-900">AI fill from website</div>
          <div className="text-[12.5px] text-zinc-500">Reads your home, about, product, pricing and customer pages and drafts every section. You review before anything changes.</div>
        </div>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) void go(); }}>
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" className="w-56" />
        <Button type="submit" variant="primary" loading={busy} disabled={!domain.trim()} icon={<Wand2 className="size-4" />}>Draft</Button>
      </form>
    </div>
  );
}

function Docs({ docs, onDraft }: { docs: Doc[]; onDraft: (d: Draft, source: string) => void }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<number | 'add' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['knowledge'] });
  const add = async () => {
    setBusy('add');
    try {
      await api.post('/api/knowledge/docs', { title: title || undefined, content: content || undefined, url: url || undefined });
      setAdding(false); setTitle(''); setContent(''); setUrl('');
      await refresh();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(null); }
  };
  const draft = async (d: Doc) => {
    setBusy(d.id);
    try {
      const r = await api.post(`/api/knowledge/docs/${d.id}/draft`, { apply: false });
      await refresh();
      onDraft(r.data.draft, d.title);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(null); }
  };
  const remove = async (d: Doc) => {
    if (!(await confirm({ title: `Delete “${d.title}”?`, message: 'Sections already drafted from it are kept.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/knowledge/docs/${d.id}`); await refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13.5px] font-semibold text-zinc-900">Docs</h2>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add</Button>
      </div>
      <p className="mb-3 text-[12.5px] text-zinc-500">Paste a sales deck, notes or case studies, or import a URL. AI can summarise any doc into the sections.</p>
      {docs.length === 0 && <p className="text-[12.5px] text-zinc-400">No docs yet.</p>}
      <div className="space-y-2">
        {docs.map((d) => (
          <div key={d.id} className="group rounded-lg border border-zinc-200 p-2.5">
            <div className="flex items-start gap-2">
              {d.source_url ? <Globe className="mt-0.5 size-3.5 shrink-0 text-zinc-400" /> : <FileText className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-zinc-800" title={d.title}>{d.title}</div>
                <div className="text-[11.5px] text-zinc-400">{d.chars.toLocaleString()} chars · {fmtRelative(d.created_at)}</div>
                {d.summary && <p className="mt-1 line-clamp-3 text-[12px] text-zinc-600">{d.summary}</p>}
              </div>
              <button onClick={() => remove(d)} className="rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 group-hover:opacity-100" aria-label="Delete doc" title="Delete"><Trash2 className="size-3.5" /></button>
            </div>
            <Button size="sm" variant="ghost" className="mt-1" loading={busy === d.id} icon={<Wand2 className="size-3.5" />} onClick={() => draft(d)}>Draft sections from this</Button>
          </div>
        ))}
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a doc" size="lg"
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={busy === 'add'} disabled={!content.trim() && !url.trim()} onClick={add}>Add doc</Button></>}>
        <div className="space-y-3">
          <Field label="Title (optional)"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sales deck Q3" /></Field>
          <Field label="Import from URL" hint="Leave the text empty to fetch the page."><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.com/customers" /></Field>
          <Field label="…or paste text"><Textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        </div>
      </Modal>
    </section>
  );
}

function ContextPreview({ updatedAt }: { updatedAt: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['knowledge-context', updatedAt], queryFn: () => api.get('/api/knowledge/context').then((r) => r.data as { text: string; empty: boolean }), enabled: open });
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left text-[13.5px] font-semibold text-zinc-900">
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}What the AI sees
      </button>
      {open && (q.isLoading ? <p className="mt-2 text-[12.5px] text-zinc-400">Loading…</p>
        : <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-snug text-zinc-700 scroll-thin">{q.data?.text || 'Nothing yet — fill in a section and save.'}</pre>)}
      {!open && <p className="mt-1 text-[12px] text-zinc-500">The compact summary added to agent and AI column prompts (saved changes only).</p>}
    </section>
  );
}

function hasContent(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.values(v).some(hasContent);
  return typeof v === 'string' ? v.trim().length > 0 : false;
}

function preview(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : Object.values(x).filter(Boolean).join(' — '))).join('\n');
  if (v && typeof v === 'object') return Object.entries(v).filter(([, x]) => hasContent(x)).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : x}`).join('\n');
  return '';
}

/** Pick which drafted sections to use; sections you already filled are unticked by default. */
function DraftReview({ draft, source, current, onApply, onClose }: { draft: Draft; source: string; current: Hub; onApply: (picked: Partial<Hub>) => void; onClose: () => void }) {
  const keys = Object.keys(SECTION_LABELS).filter((k) => hasContent((draft as any)[k]));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(keys.filter((k) => !hasContent((current as any)[k]))));
  const apply = () => {
    const out: Partial<Hub> = {};
    for (const k of picked) {
      const v = (draft as any)[k];
      (out as any)[k] = k === 'company' || k === 'icp' ? { ...(current as any)[k], ...Object.fromEntries(Object.entries(v).filter(([, x]) => hasContent(x))) } : v;
    }
    onApply(out);
  };
  return (
    <Modal open onClose={onClose} size="xl" title="Review the AI draft" description={`Drafted from ${source}. Tick the sections to use — ticked sections replace what's there. Nothing is saved until you click Save.`}
      footer={<><Button onClick={onClose}>Discard draft</Button><Button variant="primary" disabled={!picked.size} onClick={apply}>Use {picked.size} section{picked.size === 1 ? '' : 's'}</Button></>}>
      {keys.length === 0 ? <p className="text-[13px] text-zinc-500">The AI couldn't draft anything from this source.</p> : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1 scroll-thin">
          {keys.map((k) => (
            <div key={k} className={cx('rounded-lg border p-3', picked.has(k) ? 'border-zinc-300 bg-white' : 'border-zinc-200 bg-zinc-50/60')}>
              <div className="flex items-center gap-2">
                <Checkbox checked={picked.has(k)} onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; })} />
                <span className="text-[13px] font-medium text-zinc-900">{SECTION_LABELS[k]}</span>
                {hasContent((current as any)[k]) && <span className="text-[11.5px] text-amber-600">you already have this</span>}
              </div>
              <pre className="ml-6 mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-[12.5px] text-zinc-600 scroll-thin">{preview((draft as any)[k])}</pre>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-zinc-400"><Link2 className="size-3" />Source text is kept under Docs.</p>
    </Modal>
  );
}
