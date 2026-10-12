/**
 * Knowledge Hub folders: a Notion-like tree. Folders nest to any depth and hold docs;
 * folders and docs share one ordering (position) among the children of a parent
 * (parent NULL = top level). New items go to the top of their parent.
 */
import { nowIso, type Db } from '../db/db.ts';
import { badRequest, notFound } from '../http.ts';

export interface KnowledgeFolder {
  id: number;
  workspace_id: number;
  parent_id: number | null;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export type ItemType = 'doc' | 'folder';
export interface ItemRef { type: ItemType; id: number }
interface Child extends ItemRef { position: number }

export function listFolders(db: Db, workspaceId: number): KnowledgeFolder[] {
  return db.all<KnowledgeFolder>('SELECT * FROM knowledge_folders WHERE workspace_id = ? ORDER BY position ASC, id ASC', [workspaceId]);
}

export function getFolder(db: Db, workspaceId: number, id: number): KnowledgeFolder | undefined {
  return db.get<KnowledgeFolder>('SELECT * FROM knowledge_folders WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
}

export const PATH_SEP = ' / ';

/** Folder id -> "Parent / Child" path. */
export function folderPaths(folders: Pick<KnowledgeFolder, 'id' | 'parent_id' | 'name'>[]): Map<number, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<number, string>();
  const path = (id: number, seen = new Set<number>()): string => {
    const hit = out.get(id);
    if (hit !== undefined) return hit;
    const f = byId.get(id);
    if (!f) return '';
    seen.add(id);
    const p = f.parent_id != null && !seen.has(f.parent_id) && byId.has(f.parent_id) ? `${path(f.parent_id, seen)}${PATH_SEP}${f.name}` : f.name;
    out.set(id, p);
    return p;
  };
  folders.forEach((f) => path(f.id));
  return out;
}

/** The folder and every folder below it. */
export function descendantIds(folders: Pick<KnowledgeFolder, 'id' | 'parent_id'>[], id: number): Set<number> {
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id != null && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

/** Folders and docs directly inside a parent, in display order. */
export function children(db: Db, workspaceId: number, parentId: number | null): Child[] {
  const folders = db.all<Child>(`SELECT 'folder' AS type, id, position FROM knowledge_folders WHERE workspace_id = ? AND parent_id IS ?`, [workspaceId, parentId]);
  const docs = db.all<Child>(`SELECT 'doc' AS type, id, position FROM knowledge_docs WHERE workspace_id = ? AND folder_id IS ?`, [workspaceId, parentId]);
  return [...folders, ...docs].sort((a, b) => a.position - b.position || (a.type === b.type ? (a.type === 'doc' ? b.id - a.id : a.id - b.id) : a.type === 'folder' ? -1 : 1));
}

/** Position that puts a new item above everything else in the parent. */
export function topPosition(db: Db, workspaceId: number, parentId: number | null): number {
  const p = db.get<{ p: number | null }>(`SELECT MIN(p) p FROM (
    SELECT MIN(position) p FROM knowledge_docs WHERE workspace_id = ? AND folder_id IS ?
    UNION ALL SELECT MIN(position) FROM knowledge_folders WHERE workspace_id = ? AND parent_id IS ?)`, [workspaceId, parentId, workspaceId, parentId])!.p;
  return p == null ? 0 : p - 1;
}

/** Writes 0..n positions (and the parent) for an ordered list of children. */
function writeOrder(db: Db, workspaceId: number, parentId: number | null, items: ItemRef[]) {
  const now = nowIso();
  items.forEach((it, i) => {
    if (it.type === 'doc') db.run('UPDATE knowledge_docs SET position = ?, folder_id = ? WHERE id = ? AND workspace_id = ?', [i, parentId, it.id, workspaceId]);
    else db.run('UPDATE knowledge_folders SET position = ?, parent_id = ?, updated_at = CASE WHEN parent_id IS ? THEN updated_at ELSE ? END WHERE id = ? AND workspace_id = ?', [i, parentId, parentId, now, it.id, workspaceId]);
  });
}

const checkName = (name: string) => {
  const n = name.trim();
  if (!n) throw badRequest('Folder name is required');
  return n.slice(0, 200);
};

const parentOf = (db: Db, workspaceId: number, id: number | null | undefined): number | null => {
  if (id == null) return null;
  if (!getFolder(db, workspaceId, id)) throw notFound('folder');
  return id;
};

export function createFolder(db: Db, workspaceId: number, f: { name: string; parent_id?: number | null }): KnowledgeFolder {
  const parent = parentOf(db, workspaceId, f.parent_id);
  const now = nowIso();
  const id = db.insert('knowledge_folders', { workspace_id: workspaceId, parent_id: parent, name: checkName(f.name), position: topPosition(db, workspaceId, parent), created_at: now, updated_at: now });
  return getFolder(db, workspaceId, id)!;
}

export function renameFolder(db: Db, workspaceId: number, id: number, name: string): KnowledgeFolder {
  if (!getFolder(db, workspaceId, id)) throw notFound('folder');
  db.run('UPDATE knowledge_folders SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [checkName(name), nowIso(), id, workspaceId]);
  return getFolder(db, workspaceId, id)!;
}

/**
 * "Company / Research" -> that folder, creating any missing level (like mkdir -p).
 * Names match case-insensitively among the parent's subfolders.
 */
export function ensureFolderPath(db: Db, workspaceId: number, path: string, parentId: number | null = null): KnowledgeFolder {
  const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw badRequest('Folder name is required');
  let parent = parentOf(db, workspaceId, parentId);
  let folder: KnowledgeFolder | undefined;
  for (const name of parts) {
    folder = db.get<KnowledgeFolder>('SELECT * FROM knowledge_folders WHERE workspace_id = ? AND parent_id IS ? AND lower(name) = lower(?) ORDER BY position, id LIMIT 1', [workspaceId, parent, name])
      ?? createFolder(db, workspaceId, { name, parent_id: parent });
    parent = folder.id;
  }
  return folder!;
}

export interface MoveSpec {
  items: ItemRef[];
  /** Target folder (null = top level). */
  folder_id: number | null;
  /** Insert position among the target's children (after removing the moved items); default: the end. */
  index?: number;
  before?: ItemRef;
  after?: ItemRef;
}

/**
 * Moves docs and folders into a folder (or the top level) at a given place, in one
 * transaction. Refuses to put a folder inside itself or one of its own subfolders.
 */
export function moveItems(db: Db, workspaceId: number, m: MoveSpec): void {
  const parent = parentOf(db, workspaceId, m.folder_id);
  const folders = listFolders(db, workspaceId);
  const seen = new Set<string>();
  const items = m.items.filter((it) => { const k = `${it.type}:${it.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  for (const it of items) {
    if (it.type === 'folder') {
      if (!folders.some((f) => f.id === it.id)) throw notFound(`folder #${it.id}`);
      if (parent != null && descendantIds(folders, it.id).has(parent)) throw badRequest('A folder cannot be moved into itself or one of its subfolders');
    } else if (!db.get('SELECT 1 FROM knowledge_docs WHERE id = ? AND workspace_id = ?', [it.id, workspaceId])) throw notFound(`document #${it.id}`);
  }
  db.tx(() => {
    const siblings: ItemRef[] = children(db, workspaceId, parent).filter((c) => !seen.has(`${c.type}:${c.id}`)).map(({ type, id }) => ({ type, id }));
    const ref = m.before ?? m.after;
    let at = siblings.length;
    if (ref) {
      const i = siblings.findIndex((s) => s.type === ref.type && s.id === ref.id);
      if (i < 0) throw badRequest(`${ref.type} #${ref.id} is not in the target folder`);
      at = m.before ? i : i + 1;
    } else if (m.index != null) at = Math.max(0, Math.min(siblings.length, Math.floor(m.index)));
    siblings.splice(at, 0, ...items.map(({ type, id }) => ({ type, id })));
    writeOrder(db, workspaceId, parent, siblings);
  });
}

/**
 * Deletes a folder. contents='move_up' puts its docs and subfolders where the folder was
 * (in its parent); 'delete' deletes everything inside it too.
 */
export function deleteFolder(db: Db, workspaceId: number, id: number, contents: 'move_up' | 'delete'): { folders: number; docs: number } {
  const f = getFolder(db, workspaceId, id);
  if (!f) throw notFound('folder');
  return db.tx(() => {
    if (contents === 'move_up') {
      const siblings: ItemRef[] = children(db, workspaceId, f.parent_id).map(({ type, id }) => ({ type, id }));
      const at = siblings.findIndex((s) => s.type === 'folder' && s.id === id);
      const kids: ItemRef[] = children(db, workspaceId, id).map(({ type, id }) => ({ type, id }));
      siblings.splice(at, 1, ...kids);
      writeOrder(db, workspaceId, f.parent_id, siblings);
      db.run('DELETE FROM knowledge_folders WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
      return { folders: 1, docs: 0 };
    }
    const ids = [...descendantIds(listFolders(db, workspaceId), id)];
    const marks = ids.map(() => '?').join(',');
    const docs = db.run(`DELETE FROM knowledge_docs WHERE workspace_id = ? AND folder_id IN (${marks})`, [workspaceId, ...ids]).changes;
    db.run(`DELETE FROM knowledge_folders WHERE workspace_id = ? AND id IN (${marks})`, [workspaceId, ...ids]);
    return { folders: ids.length, docs };
  });
}

/** Every item in display order, depth first: folders then their contents. */
export function walkTree(db: Db, workspaceId: number): (ItemRef & { depth: number; parent_id: number | null })[] {
  const out: (ItemRef & { depth: number; parent_id: number | null })[] = [];
  const visit = (parent: number | null, depth: number) => {
    if (depth > 50) return;
    for (const c of children(db, workspaceId, parent)) {
      out.push({ type: c.type, id: c.id, depth, parent_id: parent });
      if (c.type === 'folder') visit(c.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}
