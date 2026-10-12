import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ChevronRight, Copy, CornerDownRight, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Globe, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { Button, IconButton, Menu, Modal, cx } from '../../components/ui.tsx';

export type Source = 'user' | 'agent' | 'autofill';
export interface DocRow {
  id: number; title: string; source_url: string | null; pinned: boolean; position: number; created_by: Source;
  folder_id: number | null; folder_path: string | null; chars: number; excerpt?: string; created_at: string; updated_at: string;
}
export interface FolderRow { id: number; name: string; parent_id: number | null; position: number; path: string; doc_count: number }
export interface Template { key: string; title: string; content: string }
export interface ItemRef { type: 'doc' | 'folder'; id: number }
export interface MoveSpec { items: ItemRef[]; folder_id: number | null; index?: number; before?: ItemRef; after?: ItemRef }

type Node = { type: 'folder'; id: number; folder: FolderRow; children: Node[] } | { type: 'doc'; id: number; doc: DocRow };

/** Folders and docs share one order per parent (same tie-break as the server). */
const byOrder = (a: { type: string; id: number; position: number }, b: { type: string; id: number; position: number }) =>
  a.position - b.position || (a.type === b.type ? (a.type === 'doc' ? b.id - a.id : a.id - b.id) : a.type === 'folder' ? -1 : 1);

export function buildTree(folders: FolderRow[], docs: DocRow[]): Node[] {
  const known = new Set(folders.map((f) => f.id));
  const kids = (parent: number | null, seen: Set<number>): Node[] => [
    ...folders.filter((f) => (f.parent_id != null && known.has(f.parent_id) ? f.parent_id : null) === parent && !seen.has(f.id))
      .map((f) => ({ type: 'folder' as const, id: f.id, position: f.position, f })),
    ...docs.filter((d) => (d.folder_id != null && known.has(d.folder_id) ? d.folder_id : null) === parent)
      .map((d) => ({ type: 'doc' as const, id: d.id, position: d.position, d })),
  ].sort(byOrder).map((x) => (x.type === 'folder'
    ? { type: 'folder', id: x.id, folder: x.f, children: kids(x.id, new Set([...seen, x.id])) }
    : { type: 'doc', id: x.id, doc: x.d }));
  return kids(null, new Set());
}

/** The folder and all folders below it. */
export function descendantIds(folders: FolderRow[], id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id != null && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

/** Folder ids from the top level down to (and including) `id`. */
export function ancestorIds(folders: FolderRow[], id: number | null): number[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: number[] = [];
  for (let cur = id; cur != null && byId.has(cur) && !out.includes(cur); cur = byId.get(cur)!.parent_id) out.unshift(cur);
  return out;
}

const COLLAPSED_KEY = 'k:knowledge:collapsed';

/** Collapsed folders, remembered per browser. */
export function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    try { return new Set((JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]') as unknown[]).filter((x): x is number => typeof x === 'number')); } catch { return new Set(); }
  });
  const save = (next: Set<number>) => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* storage unavailable */ } return next; };
  const toggle = useCallback((id: number) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return save(n); }), []);
  const expand = useCallback((ids: number[]) => setCollapsed((c) => (ids.some((id) => c.has(id)) ? save(new Set([...c].filter((x) => !ids.includes(x)))) : c)), []);
  return { collapsed, toggle, expand };
}

type Zone = 'before' | 'after' | 'inside' | 'inside-top';
interface DropTarget { key: string; zone: Zone; depth: number }

const ROW = 'group relative flex h-[30px] cursor-pointer select-none items-center gap-1.5 rounded-[7px] pr-1 text-[13px] transition-colors';
const indent = (depth: number) => 6 + depth * 14;

export interface TreeProps {
  folders: FolderRow[];
  docs: DocRow[];
  selected: number | null;
  templates: Template[];
  collapsed: Set<number>;
  renaming: number | null;
  onToggle: (id: number) => void;
  onExpand: (ids: number[]) => void;
  onSelect: (id: number) => void;
  onMove: (m: MoveSpec) => void;
  onNewDoc: (folderId: number | null, t?: Template) => void;
  onNewFolder: (parentId: number | null) => void;
  onRename: (id: number | null, name?: string) => void;
  onDeleteFolder: (f: FolderRow) => void;
  onMoveTo: (item: ItemRef) => void;
  onPin: (d: DocRow) => void;
  onDuplicate: (d: DocRow) => void;
  onDeleteDoc: (d: DocRow) => void;
}

/** The Knowledge sidebar: pinned shortcuts, then the folder tree with Notion-like drag and drop. */
export function KnowledgeTree(p: TreeProps) {
  const tree = useMemo(() => buildTree(p.folders, p.docs), [p.folders, p.docs]);
  const parentOf = useMemo(() => new Map(p.folders.map((f) => [f.id, f.parent_id])), [p.folders]);
  const [drag, setDrag] = useState<ItemRef | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const hoverTimer = useRef<{ id: number; t: ReturnType<typeof setTimeout> } | null>(null);
  const pinned = p.docs.filter((d) => d.pinned);

  const clearHover = () => { if (hoverTimer.current) { clearTimeout(hoverTimer.current.t); hoverTimer.current = null; } };
  const end = () => { setDrag(null); setDrop(null); clearHover(); };
  useEffect(() => clearHover, []);

  /** Dropping a folder inside itself or its own subfolders is not allowed. */
  const blocked = (folderOfNode: number | null, node: ItemRef) => {
    if (!drag) return true;
    if (drag.type === node.type && drag.id === node.id) return true;
    if (drag.type !== 'folder') return false;
    for (let cur = folderOfNode; cur != null; cur = parentOf.get(cur) ?? null) if (cur === drag.id) return true;
    return false;
  };

  const over = (e: DragEvent, n: Node, depth: number, parent: number | null) => {
    if (!drag) return;
    if (blocked(n.type === 'folder' ? n.id : parent, n)) { e.dataTransfer.dropEffect = 'none'; setDrop(null); return; }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    let zone: Zone;
    if (n.type === 'doc') zone = y < 0.5 ? 'before' : 'after';
    else {
      const open = !p.collapsed.has(n.id) && n.children.length > 0;
      zone = y < 0.25 ? 'before' : y > 0.75 ? (open ? 'inside-top' : 'after') : 'inside';
      // Hovering a collapsed folder opens it after a moment.
      if (zone === 'inside' && p.collapsed.has(n.id)) {
        if (hoverTimer.current?.id !== n.id) { clearHover(); hoverTimer.current = { id: n.id, t: setTimeout(() => p.onExpand([n.id]), 650) }; }
      } else clearHover();
    }
    const key = `${n.type}:${n.id}`;
    const d = zone === 'inside-top' ? depth + 1 : depth;
    if (drop?.key !== key || drop.zone !== zone) setDrop({ key, zone, depth: d });
  };

  const dropOn = (e: DragEvent, n: Node, parent: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    const item = drag;
    const t = drop;
    end();
    if (!item || !t || t.key !== `${n.type}:${n.id}`) return;
    const ref: ItemRef = { type: n.type, id: n.id };
    if (t.zone === 'inside') { p.onMove({ items: [item], folder_id: n.id }); p.onExpand([n.id]); } else if (t.zone === 'inside-top') p.onMove({ items: [item], folder_id: n.id, index: 0 });
    else p.onMove({ items: [item], folder_id: parent, [t.zone]: ref });
  };

  const dragProps = (ref: ItemRef, enabled: boolean) => ({
    draggable: enabled,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${ref.type}:${ref.id}`);
      setDrag(ref);
    },
    onDragEnd: end,
  });

  const indicator = (key: string) => {
    if (!drop || drop.key !== key || drop.zone === 'inside') return null;
    return <div className={cx('pointer-events-none absolute right-1 z-10 h-[2px] rounded-full bg-sky-500', drop.zone === 'before' ? '-top-px' : '-bottom-px')} style={{ left: indent(drop.depth) }} />;
  };

  const docMenu = (d: DocRow) => (
    <Menu trigger={(open) => <IconButton label="Document actions" onClick={open} className="size-6 text-zinc-400 hover:bg-zinc-200/70"><MoreHorizontal className="size-3.5" /></IconButton>} items={[
      { label: d.pinned ? 'Unpin' : 'Pin to top', icon: d.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />, onClick: () => p.onPin(d) },
      { label: 'Duplicate', icon: <Copy className="size-4" />, onClick: () => p.onDuplicate(d) },
      { label: 'Move to…', icon: <FolderInput className="size-4" />, onClick: () => p.onMoveTo({ type: 'doc', id: d.id }) },
      'divider',
      { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: () => p.onDeleteDoc(d) },
    ]} />
  );

  const docRow = (d: DocRow, depth: number, parent: number | null, shortcut = false) => {
    const key = `doc:${d.id}`;
    const active = d.id === p.selected;
    const node: Node = { type: 'doc', id: d.id, doc: d };
    return (
      <div key={shortcut ? `pin-${d.id}` : key} role="treeitem" aria-selected={active} data-kind="doc" data-id={d.id} data-title={d.title}
        {...(shortcut ? {} : dragProps({ type: 'doc', id: d.id }, true))}
        onDragOver={shortcut ? undefined : (e) => over(e, node, depth, parent)}
        onDrop={shortcut ? undefined : (e) => dropOn(e, node, parent)}
        onClick={() => p.onSelect(d.id)}
        title={d.title || 'Untitled'}
        className={cx(ROW, active ? 'bg-zinc-200/60 font-medium text-zinc-900' : 'text-zinc-700 hover:bg-zinc-100', drag?.type === 'doc' && drag.id === d.id && 'opacity-40')}
        style={{ paddingLeft: indent(depth) + 18 }}>
        {!shortcut && indicator(key)}
        {d.source_url ? <Globe className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} /> : <FileText className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />}
        <span className="min-w-0 flex-1 truncate">{d.title || 'Untitled'}</span>
        {shortcut && d.folder_path && <span className="max-w-[45%] shrink truncate text-[11.5px] font-normal text-zinc-400">{d.folder_path}</span>}
        <div className="flex shrink-0 opacity-0 group-hover:opacity-100 has-[button[aria-expanded=true]]:opacity-100 [&:has(.absolute)]:opacity-100" onClick={(e) => e.stopPropagation()}>{docMenu(d)}</div>
      </div>
    );
  };

  const folderRow = (n: Extract<Node, { type: 'folder' }>, depth: number, parent: number | null): ReactNode => {
    const f = n.folder;
    const key = `folder:${f.id}`;
    const open = !p.collapsed.has(f.id);
    const isRenaming = p.renaming === f.id;
    const isInside = drop?.key === key && drop.zone === 'inside';
    return (
      <div key={key} role="group">
        <div role="treeitem" aria-expanded={open} data-kind="folder" data-id={f.id} data-title={f.name}
          {...dragProps({ type: 'folder', id: f.id }, !isRenaming)}
          onDragOver={(e) => over(e, n, depth, parent)}
          onDrop={(e) => dropOn(e, n, parent)}
          onClick={() => !isRenaming && p.onToggle(f.id)}
          className={cx(ROW, 'text-zinc-700', isInside ? 'bg-sky-50 ring-1 ring-inset ring-sky-300' : 'hover:bg-zinc-100', drag?.type === 'folder' && drag.id === f.id && 'opacity-40')}
          style={{ paddingLeft: indent(depth) }}>
          {indicator(key)}
          <ChevronRight className={cx('size-3.5 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} />
          {open && n.children.length ? <FolderOpen className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} /> : <Folder className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />}
          {isRenaming
            ? <RenameInput initial={f.name} onDone={(name) => p.onRename(f.id, name)} />
            : <span className="min-w-0 flex-1 truncate">{f.name}</span>}
          {!isRenaming && (
            <div className="flex shrink-0 opacity-0 group-hover:opacity-100 has-[button[aria-expanded=true]]:opacity-100 [&:has(.absolute)]:opacity-100" onClick={(e) => e.stopPropagation()}>
              <Menu trigger={(o) => <IconButton label="Folder actions" onClick={o} className="size-6 text-zinc-400 hover:bg-zinc-200/70"><MoreHorizontal className="size-3.5" /></IconButton>} items={[
                { label: 'Rename', icon: <Pencil className="size-4" />, onClick: () => p.onRename(f.id) },
                { label: 'New subfolder', icon: <FolderPlus className="size-4" />, onClick: () => p.onNewFolder(f.id) },
                { label: 'Move to…', icon: <FolderInput className="size-4" />, onClick: () => p.onMoveTo({ type: 'folder', id: f.id }) },
                'divider',
                { label: 'Delete folder', icon: <Trash2 className="size-4" />, danger: true, onClick: () => p.onDeleteFolder(f) },
              ]} />
              <Menu trigger={(o) => <IconButton label={`New document in ${f.name}`} onClick={o} className="size-6 text-zinc-400 hover:bg-zinc-200/70"><Plus className="size-3.5" /></IconButton>} items={[
                { label: 'Blank document', icon: <FileText className="size-4 text-zinc-400" />, onClick: () => p.onNewDoc(f.id) },
                { label: 'New subfolder', icon: <FolderPlus className="size-4 text-zinc-400" />, onClick: () => p.onNewFolder(f.id) },
                ...(p.templates.length ? ['divider' as const] : []),
                ...p.templates.map((t) => ({ label: t.title, icon: <FileText className="size-4 text-zinc-300" />, onClick: () => p.onNewDoc(f.id, t) })),
              ]} />
            </div>
          )}
        </div>
        {open && (n.children.length
          ? n.children.map((c) => (c.type === 'folder' ? folderRow(c, depth + 1, f.id) : docRow(c.doc, depth + 1, f.id)))
          : <div className="flex h-7 items-center text-[12px] text-zinc-400" style={{ paddingLeft: indent(depth + 1) + 18 }}>Empty</div>)}
      </div>
    );
  };

  const rootDrop = drag && drop?.key === 'root';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin" role="tree" aria-label="Knowledge documents">
      {pinned.length > 0 && (
        <div data-pinned>
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Pinned</div>
          {pinned.map((d) => docRow(d, 0, null, true))}
        </div>
      )}
      <div className={cx('group/head flex items-center justify-between px-2 pb-1', pinned.length ? 'pt-3' : 'pt-1')}>
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Documents</span>
        <IconButton label="New folder" onClick={() => p.onNewFolder(null)} className="size-6 text-zinc-400 opacity-0 hover:bg-zinc-200/70 group-hover/head:opacity-100 focus:opacity-100"><FolderPlus className="size-3.5" /></IconButton>
      </div>
      {tree.length === 0 && <p className="px-2 py-2 text-[12.5px] text-zinc-400">No documents yet.</p>}
      {tree.map((n) => (n.type === 'folder' ? folderRow(n, 0, null) : docRow(n.doc, 0, null)))}
      {/* Space under the tree: drop here to move to the end of the top level. */}
      <div data-kind="root-drop"
        onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (drop?.key !== 'root') setDrop({ key: 'root', zone: 'after', depth: 0 }); }}
        onDragLeave={() => drop?.key === 'root' && setDrop(null)}
        onDrop={(e) => { e.preventDefault(); const item = drag; end(); if (item) p.onMove({ items: [item], folder_id: null }); }}
        className={cx('relative mt-0.5 min-h-10 flex-1 rounded-[7px]', drag && 'min-h-16')}>
        {rootDrop && <div className="pointer-events-none absolute left-1.5 right-1 top-0 h-[2px] rounded-full bg-sky-500" />}
      </div>
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name?: string) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name?: string) => { if (done.current) return; done.current = true; onDone(name); };
  return (
    <input autoFocus value={v} aria-label="Folder name" onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(v.trim() || undefined); if (e.key === 'Escape') finish(); }}
      onBlur={() => finish(v.trim() || undefined)}
      className="h-6 min-w-0 flex-1 rounded-[5px] border border-zinc-300 bg-white px-1.5 text-[13px] text-zinc-900 focus:border-zinc-400 focus:outline-none" />
  );
}

/** Search results: matching docs with their folder path. */
export function SearchResults({ docs, selected, q, onSelect }: { docs: DocRow[]; selected: number | null; q: string; onSelect: (id: number) => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin">
      {docs.length === 0 && <p className="px-2 py-3 text-[12.5px] text-zinc-400">Nothing matches “{q}”.</p>}
      {docs.map((d) => (
        <button key={d.id} onClick={() => onSelect(d.id)} data-kind="result"
          className={cx('flex w-full items-start gap-2 rounded-[7px] px-2 py-1.5 text-left transition-colors', d.id === selected ? 'bg-zinc-200/60' : 'hover:bg-zinc-100')}>
          <FileText className="mt-0.5 size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className={cx('block truncate text-[13px]', d.id === selected ? 'font-medium text-zinc-900' : 'text-zinc-700')}>{d.title || 'Untitled'}</span>
            <span className="block truncate text-[11.5px] text-zinc-400">{d.folder_path ? d.folder_path : 'Top level'}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Keyboard/menu fallback for drag and drop: pick a folder. */
export function MoveToModal({ item, folders, docs, onClose, onPick }: { item: ItemRef | null; folders: FolderRow[]; docs: DocRow[]; onClose: () => void; onPick: (folderId: number | null) => void }) {
  const [q, setQ] = useState('');
  useEffect(() => { if (item) setQ(''); }, [item]);
  if (!item) return null;
  const blocked = item.type === 'folder' ? descendantIds(folders, item.id) : new Set<number>();
  const current = item.type === 'doc' ? docs.find((d) => d.id === item.id)?.folder_id ?? null : folders.find((f) => f.id === item.id)?.parent_id ?? null;
  const label = item.type === 'doc' ? docs.find((d) => d.id === item.id)?.title : folders.find((f) => f.id === item.id)?.name;
  // Folders in tree order with depth.
  const rows: { f: FolderRow; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => folders.filter((f) => f.parent_id === parent).sort((a, b) => a.position - b.position || a.id - b.id)
    .forEach((f) => { rows.push({ f, depth }); walk(f.id, depth + 1); });
  walk(null, 0);
  const term = q.trim().toLowerCase();
  const shown = term ? rows.filter((r) => r.f.path.toLowerCase().includes(term)) : rows;
  const option = (key: string, id: number | null, text: ReactNode, depth: number, icon: ReactNode) => {
    const disabled = id != null && blocked.has(id);
    const here = id === current;
    return (
      <button key={key} disabled={disabled || here} onClick={() => onPick(id)} data-kind="move-target"
        className="flex h-8 w-full items-center gap-2 rounded-[7px] pr-2 text-left text-[13px] text-zinc-700 hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent"
        style={{ paddingLeft: 8 + depth * 14 }}>
        {icon}<span className="min-w-0 flex-1 truncate">{text}</span>{here && <span className="text-[11.5px] text-zinc-400">Current</span>}
      </button>
    );
  };
  return (
    <Modal open onClose={onClose} size="sm" title={`Move “${label ?? ''}”`} description="Pick a folder. You can also drag items in the sidebar.">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a folder"
          className="h-8 w-full rounded-[7px] border border-zinc-200 bg-white pl-8 pr-2 text-[13px] text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none" />
      </div>
      <div className="max-h-[50vh] overflow-y-auto scroll-thin">
        {!term && option('root', null, 'Top level', 0, <CornerDownRight className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />)}
        {shown.map((r) => option(`f${r.f.id}`, r.f.id, term ? r.f.path : r.f.name, term ? 0 : r.depth, <Folder className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />))}
        {term && !shown.length && <p className="px-2 py-2 text-[12.5px] text-zinc-400">No folder matches.</p>}
      </div>
    </Modal>
  );
}

/** Delete a folder: move what's inside up a level, or delete it all. */
export function DeleteFolderModal({ folder, folders, docs, onClose, onDelete }: { folder: FolderRow | null; folders: FolderRow[]; docs: DocRow[]; onClose: () => void; onDelete: (contents: 'move_up' | 'delete') => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setBusy(null); }, [folder]);
  if (!folder) return null;
  const inside = descendantIds(folders, folder.id);
  const nDocs = docs.filter((d) => d.folder_id != null && inside.has(d.folder_id)).length;
  const nFolders = inside.size - 1;
  const parent = folders.find((f) => f.id === folder.parent_id);
  const what = [nDocs && `${nDocs} document${nDocs === 1 ? '' : 's'}`, nFolders && `${nFolders} subfolder${nFolders === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  const run = (c: 'move_up' | 'delete') => { setBusy(c); onDelete(c); };
  return (
    <Modal open onClose={onClose} size="sm" title={`Delete “${folder.name}”?`}
      description={what ? `It holds ${what}. Keep them by moving them to ${parent ? `“${parent.name}”` : 'the top level'}, or delete everything.` : 'The folder is empty.'}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        {what ? <>
          <Button variant="danger" loading={busy === 'delete'} onClick={() => run('delete')}>Delete everything</Button>
          <Button variant="primary" loading={busy === 'move_up'} onClick={() => run('move_up')}>Move contents up</Button>
        </> : <Button variant="danger" loading={!!busy} onClick={() => run('move_up')}>Delete folder</Button>}
      </>}>
      {what ? <p className="text-[13px] text-zinc-500">Deleted documents can’t be recovered; the agent and AI columns stop using them.</p> : null}
    </Modal>
  );
}
