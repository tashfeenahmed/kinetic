import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { auth, badRequest, bool, canWrite, defineRoutes, idParam, notFound, parse } from '../http.ts';
import { fetchPage } from '../gtm/lib/html.ts';
import { INTERNAL_HEADER } from '../agent/internalAuth.ts';
import { TEMPLATES, createDoc, getDoc, knowledgeContext, listDocs, reorderDocs, type DocSource, type KnowledgeDoc } from './store.ts';
import { draftFromWebsite } from './ai.ts';
import { createFolder, deleteFolder, ensureFolderPath, folderPaths, getFolder, listFolders, moveItems, renameFolder, type KnowledgeFolder } from './folders.ts';

export function knowledgeRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Knowledge Hub');
  const { db } = ctx;
  const settings = () => ctx.gtm!.settings;
  const excerpt = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/[#*_>`~|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const pathsOf = (ws: number) => folderPaths(listFolders(db, ws));
  const docJson = (d: KnowledgeDoc, full = false, paths = pathsOf(d.workspace_id)) => ({
    id: d.id, title: d.title, source_url: d.source_url, pinned: !!d.pinned, position: d.position, created_by: d.created_by,
    folder_id: d.folder_id ?? null, folder_path: d.folder_id ? paths.get(d.folder_id) ?? null : null,
    chars: d.content.length, ...(full ? { content: d.content } : { excerpt: excerpt(d.content) }), created_at: d.created_at, updated_at: d.updated_at,
  });
  const docOf = (ws: number, id: number) => {
    const d = getDoc(db, ws, id);
    if (!d) throw notFound('document');
    return d;
  };
  /** Docs the Kinetic Agent writes (in-process calls) are labelled as such. */
  const author = (req: FastifyRequest): DocSource => (req.headers[INTERNAL_HEADER] !== undefined ? 'agent' : 'user');
  /** folder_id (must be in the workspace) or a folder path such as "Company / Research" (created if missing). */
  const folderFor = (ws: number, b: { folder_id?: number | null; folder?: string }): number | null => {
    if (b.folder_id != null) { if (!getFolder(db, ws, b.folder_id)) throw notFound('folder'); return b.folder_id; }
    if (b.folder?.trim()) return ensureFolderPath(db, ws, b.folder).id;
    return null;
  };
  const folderJson = (f: KnowledgeFolder, paths = pathsOf(f.workspace_id)) => ({
    id: f.id, name: f.name, parent_id: f.parent_id, position: f.position, path: paths.get(f.id) ?? f.name,
    doc_count: db.get<{ n: number }>('SELECT COUNT(*) n FROM knowledge_docs WHERE workspace_id = ? AND folder_id = ?', [f.workspace_id, f.id])!.n,
    created_at: f.created_at, updated_at: f.updated_at,
  });
  const folderRef = { folder_id: z.number().int().positive().nullable().optional(), folder: z.string().trim().max(500).optional() };

  const listQuery = z.object({ q: z.string().max(200).optional() });
  r.get('/api/knowledge/docs', 'List Knowledge Hub documents with their folder_id and folder_path (pinned first, then in the user\'s order); q searches titles and text', (req) => {
    const q = parse(listQuery, req.query);
    const ws = auth(req).workspaceId;
    const paths = pathsOf(ws);
    return { data: listDocs(db, ws, q.q).map((d) => docJson(d, false, paths)) };
  }, { query: listQuery });

  r.get('/api/knowledge/docs/:id', 'Get a Knowledge Hub document with its full markdown content', (req) => ({ data: docJson(docOf(auth(req).workspaceId, idParam(req)), true) }));

  r.get('/api/knowledge/templates', 'Knowledge Hub document templates (starter markdown): company, icp, personas, positioning, competitors, proof, tone, exclusions', () => ({
    data: TEMPLATES,
  }));

  const docBody = z.object({
    title: z.string().trim().max(300).optional(),
    content: z.string().max(200_000).optional(),
    template: z.string().max(40).optional(),
    url: z.string().trim().max(2000).optional(),
    pinned: z.boolean().optional(),
    ...folderRef,
  });
  r.post('/api/knowledge/docs', 'Create a Knowledge Hub document: markdown content, a template key, a URL to import, or blank; folder_id or folder (path) files it in a folder', async (req) => {
    const a = canWrite(req);
    const b = parse(docBody, req.body ?? {});
    let content = b.content ?? '';
    let title = b.title ?? '';
    if (b.template) {
      const t = TEMPLATES.find((x) => x.key === b.template || x.title.toLowerCase() === b.template!.toLowerCase());
      if (!t) throw badRequest(`Unknown template "${b.template}". Use one of: ${TEMPLATES.map((x) => x.key).join(', ')}`);
      content ||= t.content;
      title ||= t.title;
    }
    if (!content.trim() && b.url) {
      try {
        const p = await fetchPage(b.url, 20_000);
        if (p.status >= 400) throw new Error(`HTTP ${p.status}`);
        content = p.text.slice(0, 60_000);
        title ||= p.title || b.url;
      } catch (e: any) { throw badRequest(`Could not fetch ${b.url}: ${e.message}`); }
    }
    const folder_id = folderFor(a.workspaceId, b);
    const d = createDoc(db, a.workspaceId, { title, content, source_url: b.url ?? null, pinned: b.pinned, created_by: author(req), folder_id });
    return { data: docJson(d, true) };
  }, { body: docBody });

  const bulkBody = z.object({
    docs: z.array(z.object({ title: z.string().trim().min(1).max(300), content: z.string().max(200_000) })).min(1).max(30),
    source_url: z.string().trim().max(2000).optional(),
    created_by: z.enum(['user', 'agent', 'autofill']).optional(),
    ...folderRef,
  });
  r.post('/api/knowledge/docs/bulk', 'Create several Knowledge Hub documents at once (e.g. the reviewed drafts from fill-from-website), optionally inside a folder (folder_id, or folder: a name/path created if missing)', (req) => {
    const a = canWrite(req);
    const b = parse(bulkBody, req.body);
    // Created bottom-up so the first doc ends up on top.
    const made = db.tx(() => {
      const folder_id = folderFor(a.workspaceId, b);
      return [...b.docs].reverse().map((d) => createDoc(db, a.workspaceId, { ...d, source_url: b.source_url ?? null, created_by: b.created_by ?? author(req), folder_id })).reverse();
    });
    const paths = pathsOf(a.workspaceId);
    return { data: made.map((d) => docJson(d, false, paths)), folder: made[0]?.folder_id ? folderJson(getFolder(db, a.workspaceId, made[0].folder_id)!, paths) : null };
  }, { body: bulkBody });

  const docPatch = z.object({
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(200_000).optional(),
    pinned: z.boolean().optional(),
    summary: z.string().max(5000).nullable().optional(),
    folder_id: z.number().int().positive().nullable().optional(),
  });
  r.patch('/api/knowledge/docs/:id', 'Edit a Knowledge Hub document: title, markdown content (replaces it), pinned, or folder_id (moves it to the top of that folder; null = top level)', (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const { folder_id, ...b } = parse(docPatch, req.body);
    if (folder_id !== undefined && folder_id !== d.folder_id) moveItems(db, a.workspaceId, { items: [{ type: 'doc', id: d.id }], folder_id, index: 0 });
    if (Object.keys(b).length) db.update('knowledge_docs', d.id, { ...b, updated_at: nowIso() });
    return { data: docJson(docOf(a.workspaceId, d.id), true) };
  }, { body: docPatch });

  r.post('/api/knowledge/docs/:id/duplicate', 'Duplicate a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const copy = db.tx(() => {
      const c = createDoc(db, a.workspaceId, { title: `${d.title} (copy)`, content: d.content, source_url: d.source_url, created_by: author(req), folder_id: d.folder_id });
      moveItems(db, a.workspaceId, { items: [{ type: 'doc', id: c.id }], folder_id: d.folder_id, after: { type: 'doc', id: d.id } });
      return c;
    });
    return { data: docJson(docOf(a.workspaceId, copy.id), true) };
  });

  const reorderBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000) });
  r.post('/api/knowledge/docs/reorder', 'Reorder Knowledge Hub documents within their folders (ids in the new order); to move between folders use POST /api/knowledge/move', (req) => {
    const a = canWrite(req);
    reorderDocs(db, a.workspaceId, parse(reorderBody, req.body).ids);
    return { data: listDocs(db, a.workspaceId).map((d) => docJson(d)) };
  }, { body: reorderBody });

  r.delete('/api/knowledge/docs/:id', 'Delete a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    db.run('DELETE FROM knowledge_docs WHERE id = ?', [docOf(a.workspaceId, idParam(req)).id]);
    return { ok: true };
  });

  // ---- Folders (nested, Notion-like) ----
  r.get('/api/knowledge/folders', 'List Knowledge Hub folders (flat, with parent_id, path like "Company / Research", position and doc_count)', (req) => {
    const ws = auth(req).workspaceId;
    const paths = pathsOf(ws);
    return { data: listFolders(db, ws).map((f) => folderJson(f, paths)) };
  });

  const folderBody = z.object({ name: z.string().trim().min(1).max(200), parent_id: z.number().int().positive().nullable().optional() });
  r.post('/api/knowledge/folders', 'Create a Knowledge Hub folder (at the top of parent_id, or of the top level); folders nest to any depth', (req) => {
    const a = canWrite(req);
    const b = parse(folderBody, req.body);
    return { data: folderJson(createFolder(db, a.workspaceId, b)) };
  }, { body: folderBody });

  const folderPatch = z.object({ name: z.string().trim().min(1).max(200) });
  r.patch('/api/knowledge/folders/:id', 'Rename a Knowledge Hub folder (to move it use POST /api/knowledge/move)', (req) => {
    const a = canWrite(req);
    return { data: folderJson(renameFolder(db, a.workspaceId, idParam(req), parse(folderPatch, req.body).name)) };
  }, { body: folderPatch });

  const folderDelete = z.object({ contents: z.enum(['move_up', 'delete']).default('move_up') });
  r.delete('/api/knowledge/folders/:id', 'Delete a Knowledge Hub folder; contents=move_up (default) moves its docs and subfolders up a level, contents=delete deletes them too', (req) => {
    const a = canWrite(req);
    const q = parse(folderDelete, req.query ?? {});
    return { ok: true, deleted: deleteFolder(db, a.workspaceId, idParam(req), q.contents) };
  }, { query: folderDelete });

  const itemRef = z.object({ type: z.enum(['doc', 'folder']), id: z.number().int().positive() });
  const moveBody = z.object({
    items: z.array(itemRef).min(1).max(500),
    folder_id: z.number().int().positive().nullable(),
    index: z.number().int().min(0).optional(),
    before: itemRef.optional(),
    after: itemRef.optional(),
  });
  r.post('/api/knowledge/move', 'Move and reorder Knowledge Hub docs and folders in one call: items go into folder_id (null = top level) at index, or before/after a sibling (default: the end)', (req) => {
    const a = canWrite(req);
    const b = parse(moveBody, req.body);
    if (b.before && b.after) throw badRequest('Pass before or after, not both');
    moveItems(db, a.workspaceId, b);
    const paths = pathsOf(a.workspaceId);
    return { data: { folders: listFolders(db, a.workspaceId).map((f) => folderJson(f, paths)), docs: listDocs(db, a.workspaceId).map((d) => docJson(d, false, paths)) } };
  }, { body: moveBody });

  const ctxQuery = z.object({ max_chars: z.coerce.number().int().min(500).max(20_000).optional() });
  r.get('/api/knowledge/context', 'Knowledge Hub documents as one compact text for prompts (pinned docs first, truncated to ~5k chars)', (req) => {
    const q = parse(ctxQuery, req.query);
    const text = knowledgeContext(ctx, auth(req).workspaceId, q.max_chars);
    return { data: { text, empty: !text } };
  }, { query: ctxQuery });

  const autofillBody = z.object({ domain: z.string().trim().min(3).max(300), apply: bool.default(false), ...folderRef });
  r.post('/api/knowledge/autofill', 'Fill from website: crawl the domain and draft Knowledge Hub documents (company, offers, ICP, personas, positioning, competitors, case studies, tone); apply=true creates them in a folder named after the site (or folder / folder_id)', async (req) => {
    const a = canWrite(req);
    const b = parse(autofillBody, req.body);
    let d;
    try { d = await draftFromWebsite(settings(), b.domain); } catch (e: any) { throw badRequest(`Could not read ${b.domain}: ${e.message}`); }
    const existing = new Set(listDocs(db, a.workspaceId).map((x) => x.title.toLowerCase()));
    const drafts = d.docs.map((x) => ({ ...x, exists: existing.has(x.title.toLowerCase()) }));
    let created: ReturnType<typeof docJson>[] = [];
    let folder: ReturnType<typeof folderJson> | null = null;
    if (b.apply) {
      // Never overwrite: docs whose title already exists are skipped. The rest go in one folder.
      const fresh = drafts.filter((x) => !x.exists);
      if (fresh.length) {
        const made = db.tx(() => {
          const folder_id = folderFor(a.workspaceId, b.folder_id || b.folder?.trim() ? b : { folder: d.host });
          return [...fresh].reverse().map((x) => createDoc(db, a.workspaceId, { title: x.title, content: x.content, source_url: d.pages[0], created_by: 'autofill', folder_id })).reverse();
        });
        const paths = pathsOf(a.workspaceId);
        created = made.map((x) => docJson(x, false, paths));
        if (made[0].folder_id) folder = folderJson(getFolder(db, a.workspaceId, made[0].folder_id)!, paths);
      }
    }
    return { data: { drafts, summary: d.summary, ai: d.ai, pages: d.pages, host: d.host, folder_name: d.host, applied: b.apply, created, folder } };
  }, { body: autofillBody });
}
