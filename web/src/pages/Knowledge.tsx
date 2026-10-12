import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, BookOpen, Check, ChevronLeft, Copy, Eye, FileText, FolderInput, FolderPlus, Globe, MoreHorizontal, Pin, Plus, Search, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtRelative } from '../lib/format.ts';
import { Button, IconButton, Loading, Menu, Modal, cx, useUi } from '../components/ui.tsx';
import { AutofillModal } from './knowledge/Autofill.tsx';
import { DeleteFolderModal, KnowledgeTree, MoveToModal, SearchResults, ancestorIds, useCollapsed, type DocRow, type FolderRow, type ItemRef, type MoveSpec, type Source, type Template } from './knowledge/Tree.tsx';
import './knowledge/knowledge.css';

const DocEditor = lazy(() => import('./knowledge/DocEditor.tsx'));

interface Doc extends DocRow { content: string }

const SOURCE_LABEL: Record<Source, string | null> = { user: null, agent: 'Agent', autofill: 'From website' };
const LIST_KEY = ['knowledge-docs'];
const FOLDERS_KEY = ['knowledge-folders'];

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Knowledge Hub: plain documents the agent, AI columns and reply drafts read. */
export function KnowledgePage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [autofill, setAutofill] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [moving, setMoving] = useState<ItemRef | null>(null);
  const [deleting, setDeleting] = useState<FolderRow | null>(null);
  const { collapsed, toggle, expand } = useCollapsed();

  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => api.get('/api/knowledge/docs').then((r) => r.data as DocRow[]) });
  const folderList = useQuery({ queryKey: FOLDERS_KEY, queryFn: () => api.get('/api/knowledge/folders').then((r) => r.data as FolderRow[]) });
  const found = useQuery({ queryKey: [...LIST_KEY, q], queryFn: () => api.get('/api/knowledge/docs', { q }).then((r) => r.data as DocRow[]), enabled: !!q });
  const templates = useQuery({ queryKey: ['knowledge-templates'], queryFn: () => api.get('/api/knowledge/templates').then((r) => r.data as Template[]), staleTime: Infinity });

  const docs = list.data ?? [];
  const folders = folderList.data ?? [];
  const shown = q ? found.data ?? [] : docs;
  const selected = Number(params.get('doc')) || null;
  const select = useCallback((id: number | null) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('doc', String(id)); else n.delete('doc'); return n; }, { replace: true }), [setParams]);

  // Open the first doc when none (or a deleted one) is selected.
  useEffect(() => {
    if (!list.data) return;
    if (selected && list.data.some((d) => d.id === selected)) return;
    if (selected && !list.data.some((d) => d.id === selected)) { select(list.data[0]?.id ?? null); return; }
    if (!selected && list.data.length && window.matchMedia('(min-width: 768px)').matches) select(list.data[0].id);
  }, [list.data, selected, select]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: LIST_KEY }), qc.invalidateQueries({ queryKey: FOLDERS_KEY })]);

  // Opening a doc (e.g. from an agent link) reveals its folder.
  const selectedFolder = docs.find((d) => d.id === selected)?.folder_id ?? null;
  // Not re-run when folders change, so collapsing the open doc's folder sticks.
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const foldersReady = folderList.isSuccess;
  useEffect(() => { if (selectedFolder && foldersReady) expand(ancestorIds(foldersRef.current, selectedFolder)); }, [selected, selectedFolder, foldersReady, expand]);

  const create = async (t?: Template, folderId: number | null = null) => {
    try {
      const r = await api.post('/api/knowledge/docs', { ...(t ? { template: t.key } : { title: 'Untitled' }), folder_id: folderId });
      if (folderId) expand(ancestorIds(folders, folderId));
      await refresh();
      setFresh(r.data.id);
      select(r.data.id);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const newFolder = async (parentId: number | null) => {
    try {
      const r = await api.post('/api/knowledge/folders', { name: 'New folder', parent_id: parentId });
      if (parentId) expand(ancestorIds(folders, parentId));
      await refresh();
      setRenaming(r.data.id);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  /** First call (menu) starts inline renaming; the input calls again with the new name (undefined = cancel). */
  const rename = async (id: number | null, name?: string) => {
    if (id == null) return;
    if (renaming !== id) { setRenaming(id); return; }
    setRenaming(null);
    if (!name || name === folders.find((f) => f.id === id)?.name) return;
    qc.setQueryData<FolderRow[]>(FOLDERS_KEY, (fs) => fs?.map((f) => (f.id === id ? { ...f, name } : f)));
    try { await api.patch(`/api/knowledge/folders/${id}`, { name }); } catch (e) { toast(errorMessage(e), 'error'); }
    await refresh();
  };
  const removeFolder = async (contents: 'move_up' | 'delete') => {
    const f = deleting;
    if (!f) return;
    try {
      const r = await api.del(`/api/knowledge/folders/${f.id}?contents=${contents}`);
      setDeleting(null);
      await refresh();
      const n = (r as { deleted?: { docs: number } }).deleted?.docs ?? 0;
      toast(contents === 'delete' && n ? `Deleted “${f.name}” and ${n} document${n === 1 ? '' : 's'}` : `Deleted “${f.name}”`);
    } catch (e) { setDeleting(null); toast(errorMessage(e), 'error'); }
  };
  const move = async (m: MoveSpec) => {
    try {
      const r = await api.post('/api/knowledge/move', m);
      const data = r.data as { folders: FolderRow[]; docs: DocRow[] };
      qc.setQueryData(FOLDERS_KEY, data.folders);
      qc.setQueryData(LIST_KEY, data.docs);
      if (m.folder_id) expand(ancestorIds(data.folders, m.folder_id));
    } catch (e) { toast(errorMessage(e), 'error'); await refresh(); }
  };

  const patch = async (d: DocRow, body: Partial<Pick<Doc, 'pinned' | 'title'>>) => {
    try { await api.patch(`/api/knowledge/docs/${d.id}`, body); await refresh(); qc.removeQueries({ queryKey: ['knowledge-doc', d.id] }); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const duplicate = async (d: DocRow) => {
    try { const r = await api.post(`/api/knowledge/docs/${d.id}/duplicate`); await refresh(); select(r.data.id); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const remove = async (d: DocRow) => {
    if (!(await confirm({ title: `Delete “${d.title}”?`, message: 'The agent and AI columns will stop using it. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/knowledge/docs/${d.id}`);
      const rest = docs.filter((x) => x.id !== d.id);
      qc.setQueryData(LIST_KEY, rest);
      if (selected === d.id) select(rest[0]?.id ?? null);
      await refresh();
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const newMenu = (trigger: (open: () => void) => ReactNode) => (
    <Menu align="left" trigger={trigger} items={[
      { label: 'Blank document', icon: <FileText className="size-4 text-zinc-400" />, onClick: () => create() },
      { label: 'New folder', icon: <FolderPlus className="size-4 text-zinc-400" />, onClick: () => newFolder(null) },
      'divider',
      ...(templates.data ?? []).map((t) => ({ label: t.title, icon: <FileText className="size-4 text-zinc-300" />, onClick: () => create(t) })),
      'divider',
      { label: 'Fill from website…', icon: <Globe className="size-4 text-zinc-400" />, onClick: () => setAutofill(true) },
    ]} />
  );

  if (list.isLoading || folderList.isLoading) return <Loading />;
  const current = docs.find((d) => d.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 bg-white">
      {/* Document list */}
      <aside className={cx('w-full shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/40 md:w-[272px]', current ? 'hidden md:flex' : 'flex')}>
        <div className="px-4 pb-3 pt-5">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-900"><BookOpen className="size-4 text-zinc-500" strokeWidth={1.75} />Knowledge</h1>
            {newMenu((open) => <IconButton label="New document" onClick={open} className="size-7"><Plus className="size-4" /></IconButton>)}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-zinc-500">Documents the agent, AI columns and reply drafts read.</p>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search docs"
              className="h-8 w-full rounded-[7px] border border-zinc-200 bg-white pl-8 pr-2 text-[13px] text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none" />
          </div>
        </div>
        {q ? <SearchResults docs={shown} selected={selected} q={q} onSelect={select} /> : (
          <KnowledgeTree folders={folders} docs={docs} selected={selected} templates={templates.data ?? []} collapsed={collapsed} renaming={renaming}
            onToggle={toggle} onExpand={expand} onSelect={select} onMove={move}
            onNewDoc={(folderId, t) => create(t, folderId)} onNewFolder={newFolder} onRename={rename} onDeleteFolder={setDeleting} onMoveTo={setMoving}
            onPin={(d) => patch(d, { pinned: !d.pinned })} onDuplicate={duplicate} onDeleteDoc={remove} />
        )}
        <div className="space-y-0.5 border-t border-zinc-200 p-2">
          <SideButton icon={<Globe className="size-4" />} onClick={() => setAutofill(true)}>Fill from website</SideButton>
          <SideButton icon={<Eye className="size-4" />} onClick={() => setShowContext(true)}>What the AI sees</SideButton>
        </div>
      </aside>

      {/* Editor */}
      <section className={cx('min-w-0 flex-1 overflow-y-auto scroll-thin', !current && 'hidden md:block')}>
        {current ? (
          <DocPane key={current.id} row={current} autoFocus={fresh === current.id} onBack={() => select(null)}
            onPin={() => patch(current, { pinned: !current.pinned })} onDuplicate={() => duplicate(current)} onDelete={() => remove(current)}
            onMoveTo={() => setMoving({ type: 'doc', id: current.id })} />
        ) : (
          <Welcome templates={templates.data ?? []} onCreate={create} onAutofill={() => setAutofill(true)} />
        )}
      </section>

      <AutofillModal open={autofill} folders={folders} onClose={() => setAutofill(false)} onCreated={async (ids, folderId) => {
        setAutofill(false);
        if (folderId) expand([folderId]);
        await refresh();
        if (folderId) { const fs = qc.getQueryData<FolderRow[]>(FOLDERS_KEY) ?? []; expand(ancestorIds(fs, folderId)); }
        if (ids[0]) select(ids[0]);
      }} />
      <MoveToModal item={moving} folders={folders} docs={docs} onClose={() => setMoving(null)}
        onPick={(folderId) => { const item = moving; setMoving(null); if (item) void move({ items: [item], folder_id: folderId }); }} />
      <DeleteFolderModal folder={deleting} folders={folders} docs={docs} onClose={() => setDeleting(null)} onDelete={removeFolder} />
      <ContextModal open={showContext} onClose={() => setShowContext(false)} />
    </div>
  );
}

function SideButton({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2 text-[13px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 [&>svg]:text-zinc-400">
      {icon}{children}
    </button>
  );
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** One document: title + rich-text body, autosaved (debounced) as markdown. */
function DocPane({ row, autoFocus, onBack, onPin, onDuplicate, onDelete, onMoveTo }: { row: DocRow; autoFocus: boolean; onBack: () => void; onPin: () => void; onDuplicate: () => void; onDelete: () => void; onMoveTo: () => void }) {
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ['knowledge-doc', row.id], queryFn: () => api.get(`/api/knowledge/docs/${row.id}`).then((r) => r.data as Doc), staleTime: Infinity, refetchOnWindowFocus: false });
  const [title, setTitle] = useState(row.title);
  const [state, setState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState(row.updated_at);
  const pending = useRef<{ title?: string; content?: string }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const body = pending.current;
    if (!Object.keys(body).length) return;
    pending.current = {};
    setState('saving');
    try {
      const r = await api.patch(`/api/knowledge/docs/${row.id}`, body);
      const d = r.data as Doc;
      qc.setQueryData(['knowledge-doc', row.id], d);
      qc.setQueriesData<DocRow[]>({ queryKey: LIST_KEY }, (rows) => rows?.map((x) => (x.id === d.id ? { ...x, title: d.title, updated_at: d.updated_at, chars: d.chars } : x)));
      setSavedAt(d.updated_at);
      setState(Object.keys(pending.current).length ? 'pending' : 'saved');
    } catch {
      pending.current = { ...body, ...pending.current };
      setState('error');
    }
  }, [qc, row.id]);

  const queue = (change: { title?: string; content?: string }) => {
    pending.current = { ...pending.current, ...change };
    setState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  };

  // Save anything pending when switching docs or leaving the page.
  useEffect(() => () => { void flush(); }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.keys(pending.current).length) { void flush(); e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush]);

  const source = SOURCE_LABEL[row.created_by];
  return (
    <div className="min-h-full">
      <div className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-zinc-100 bg-white/90 px-4 backdrop-blur">
        <button onClick={onBack} className="-ml-1 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 md:hidden" aria-label="All documents"><ChevronLeft className="size-4" /></button>
        <span className="min-w-0 truncate text-[13px] text-zinc-500">Knowledge {row.folder_path?.split(' / ').map((part, i) => <span key={i}><span className="text-zinc-300">/</span> {part} </span>)}<span className="text-zinc-300">/</span> <span className="text-zinc-800">{title || 'Untitled'}</span></span>
        <span className="flex-1" />
        <SaveIndicator state={state} savedAt={savedAt} onRetry={() => void flush()} />
        <IconButton label={row.pinned ? 'Unpin' : 'Pin to top'} onClick={onPin} className={cx('size-7', row.pinned && 'text-zinc-900')}>
          {row.pinned ? <Pin className="size-4 fill-current" /> : <Pin className="size-4" />}
        </IconButton>
        <Menu trigger={(open) => <IconButton label="More" onClick={open} className="size-7"><MoreHorizontal className="size-4" /></IconButton>} items={[
          { label: 'Duplicate', icon: <Copy className="size-4" />, onClick: onDuplicate },
          { label: 'Move to…', icon: <FolderInput className="size-4" />, onClick: onMoveTo },
          'divider',
          { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: onDelete },
        ]} />
      </div>

      <div className="mx-auto w-full max-w-[760px] px-6 pb-10 pt-12 sm:px-12">
        <input value={title} onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) queue({ title: e.target.value.trim() }); }}
          placeholder="Untitled" aria-label="Title"
          className="w-full border-none bg-transparent p-0 text-[30px] font-semibold leading-tight tracking-tight text-zinc-900 placeholder:text-zinc-300 focus:outline-none" />
        <div className="mb-6 mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-zinc-400">
          {source && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500">{source}</span>}
          {row.source_url && <a href={row.source_url} target="_blank" rel="noreferrer" className="truncate hover:text-zinc-600">{row.source_url.replace(/^https?:\/\//, '')}</a>}
          <span>Created {fmtRelative(row.created_at)}</span>
        </div>
        {doc.isLoading || !doc.data ? <p className="text-shimmer text-[14px]">Loading document…</p> : (
          <Suspense fallback={<p className="text-shimmer text-[14px]">Loading editor…</p>}>
            <DocEditor markdown={doc.data.content} docId={row.id} autoFocus={autoFocus} onChange={(md) => queue({ content: md })} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function SaveIndicator({ state, savedAt, onRetry }: { state: SaveState; savedAt: string; onRetry: () => void }) {
  if (state === 'error') return <button onClick={onRetry} className="flex items-center gap-1 text-[12px] text-red-600 hover:underline"><AlertCircle className="size-3.5" />Not saved — retry</button>;
  if (state === 'saving' || state === 'pending') return <span className="text-[12px] text-zinc-400">Saving…</span>;
  return <span className="flex items-center gap-1 text-[12px] text-zinc-400" title={`Saved ${fmtRelative(savedAt)}`}><Check className="size-3.5" />Saved</span>;
}

function Welcome({ templates, onCreate, onAutofill }: { templates: Template[]; onCreate: (t?: Template) => void; onAutofill: () => void }) {
  return (
    <div className="mx-auto max-w-[760px] px-6 py-16 sm:px-12">
      <h2 className="text-[26px] font-semibold tracking-tight text-zinc-900">Your knowledge hub</h2>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-zinc-500">
        Plain documents about what you sell and to whom. The agent reads them in every chat and can write them for you; AI research columns and reply drafts use them too.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => onCreate()}>New document</Button>
        <Button icon={<Globe className="size-4" />} onClick={onAutofill}>Fill from website</Button>
      </div>
      {templates.length > 0 && (
        <>
          <div className="mb-2 mt-10 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Start from a template</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => (
              <button key={t.key} onClick={() => onCreate(t)} className="flex items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2.5 text-left text-[13px] text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50">
                <FileText className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />{t.title}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ContextModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['knowledge-context'], queryFn: () => api.get('/api/knowledge/context').then((r) => r.data as { text: string; empty: boolean }), enabled: open, staleTime: 0 });
  const text = useMemo(() => q.data?.text ?? '', [q.data]);
  return (
    <Modal open={open} onClose={onClose} size="lg" title="What the AI sees"
      description="The compact text added to agent chats, AI research columns and reply drafts: pinned documents first, long ones cut. The agent can open any document in full.">
      {q.isLoading ? <p className="text-shimmer text-[13px]">Building context…</p>
        : <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 font-mono text-[11.5px] leading-snug text-zinc-700 scroll-thin">{text || 'Nothing yet — add a document.'}</pre>}
      {!!text && <p className="mt-2 text-[12px] text-zinc-400">{text.length.toLocaleString()} characters</p>}
    </Modal>
  );
}
