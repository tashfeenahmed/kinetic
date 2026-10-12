import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { auth, badRequest, bool, canWrite, defineRoutes, HttpError, idParam, notFound, parse } from '../http.ts';
import { fetchPage } from '../gtm/lib/html.ts';
import { INTERNAL_HEADER } from '../agent/internalAuth.ts';
import { TEMPLATES, createDoc, getDoc, knowledgeContext, listDocs, reorderDocs, type DocSource, type KnowledgeDoc } from './store.ts';
import { ResearchService, type ResearchRunState } from './research.ts';
import { applyEdit, EDIT_MODES, runDocAgent } from './docAgent.ts';
import { createFolder, deleteFolder, ensureFolderPath, folderPaths, getFolder, listFolders, moveItems, renameFolder, type KnowledgeFolder } from './folders.ts';

/** The research-run registry per app (tests wait on runs through it). */
export const researchServices = new WeakMap<FastifyInstance, ResearchService>();

export function knowledgeRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Knowledge Hub');
  const { db } = ctx;
  const settings = () => ctx.gtm!.settings;
  const research = new ResearchService(settings, ctx.now);
  researchServices.set(app, research);
  app.addHook('onClose', async () => research.shutdown());
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

  // ---- Fill from website: a multi-step research run ----
  const existingTitles = (ws: number) => new Set(listDocs(db, ws).map((x) => x.title.toLowerCase()));
  const runJson = (run: ResearchRunState) => {
    const res = run.result;
    const existing = res ? existingTitles(run.workspaceId) : null;
    return {
      id: run.id, domain: run.domain, status: run.status, steps: run.steps, error: run.error, started_at: run.started_at, finished_at: run.finished_at,
      result: res ? {
        drafts: res.docs.map((x) => ({ ...x, exists: existing!.has(x.title.toLowerCase()) })),
        summary: res.summary, ai: res.ai, host: res.host, folder_name: res.host, pages: res.pages, searches: res.searches,
        competitors: res.competitors, notes: res.notes,
        usage: { prompt_tokens: res.usage.prompt, completion_tokens: res.usage.completion, cost_usd: Math.round(res.usage.costUsd * 10_000) / 10_000, calls: res.usage.calls },
      } : null,
    };
  };
  const runOf = (req: FastifyRequest) => {
    const run = research.get(auth(req).workspaceId, idParam(req));
    if (!run) throw notFound('research run');
    return run;
  };
  const researchBody = z.object({ domain: z.string().trim().min(3).max(300) });
  r.post('/api/knowledge/research', 'Start "fill from website" research in the background: crawls ~20 pages of the site (nav, footer, sitemap), web-searches competitors, reviews, LinkedIn, press and customers, checks competitor sites, then writes detailed docs (company overview, products, ICP, buyer personas, positioning, competitors table, proof, tone of voice, objection handling). Poll GET /api/knowledge/research/{id}; takes 1-3 minutes', (req) => {
    const a = canWrite(req);
    const b = parse(researchBody, req.body);
    return { data: runJson(research.start(a.workspaceId, b.domain)) };
  }, { body: researchBody });

  r.get('/api/knowledge/research/:id', 'A fill-from-website research run: status (running, done, failed, stopped), live steps, and when done the drafted docs (with exists flags), pages read, searches, competitors and token usage/cost', (req) => ({ data: runJson(runOf(req)) }));

  r.post('/api/knowledge/research/:id/stop', 'Stop a running fill-from-website research run', (req) => {
    const a = canWrite(req);
    return { data: { stopped: research.stop(a.workspaceId, idParam(req)) } };
  });

  // Live steps (not in the API reference: it's a stream).
  app.get('/api/knowledge/research/:id/events', (req, reply) => {
    const run = runOf(req);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (x: ResearchRunState) => reply.raw.write(`data: ${JSON.stringify(runJson(x))}\n\n`);
    send(run);
    const listener = (x: ResearchRunState) => send(x);
    research.bus.on(`run:${run.id}`, listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { clearInterval(ping); research.bus.off(`run:${run.id}`, listener); });
  });

  const autofillBody = z.object({ domain: z.string().trim().min(3).max(300), apply: bool.default(false), ...folderRef });
  r.post('/api/knowledge/autofill', 'Fill from website in one call (waits 1-3 minutes): runs the full research (site crawl, web search for competitors/reviews/press, competitor sites) and drafts detailed docs (company, products, ICP, buyer personas, positioning, competitors, proof, tone of voice, objection handling); apply=true creates them in a folder named after the site (or folder / folder_id)', async (req) => {
    const a = canWrite(req);
    const b = parse(autofillBody, req.body);
    const started = research.start(a.workspaceId, b.domain);
    await research.wait(started.id);
    const run = research.get(a.workspaceId, started.id)!;
    if (!run.result) throw badRequest(`Could not read ${b.domain}: ${run.error ?? run.status}`);
    const d = run.result;
    const existing = existingTitles(a.workspaceId);
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
    return { data: { ...runJson(run).result, drafts, applied: b.apply, created, folder, run_id: run.id } };
  }, { body: autofillBody });

  // ---- "@Agent" inside a document ----
  const agentBody = z.object({
    instruction: z.string().trim().min(1).max(4000),
    selection: z.string().max(50_000).optional(),
    before: z.string().max(200_000).optional(),
    after: z.string().max(200_000).optional(),
    content: z.string().max(200_000).optional(),
    cursor: z.number().int().min(0).optional(),
    mode: z.enum([...EDIT_MODES, 'auto']).default('auto'),
    apply: z.boolean().default(false),
    stream: z.boolean().default(false),
  });
  r.post('/api/knowledge/docs/:id/agent', 'Ask the agent to write inside a Knowledge Hub document: instruction (e.g. "fill this table with 5 competitors"), optional selection text or cursor (char offset in the markdown), optional content (unsaved markdown from the editor); it reads the doc and hub, can web-search, and returns { markdown, mode: insert|replace|append|rewrite }. apply=true saves the edit to the doc', async (req, reply) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const b = parse(agentBody, req.body);
    const path = d.folder_id ? pathsOf(a.workspaceId).get(d.folder_id) : undefined;
    const before = b.before ?? (b.cursor != null ? d.content.slice(0, b.cursor) : undefined);
    const after = b.after ?? (b.cursor != null ? d.content.slice(b.cursor) : undefined);
    const go = async (onStep?: (label: string) => void) => {
      const out = await runDocAgent(ctx, a.workspaceId, { ...d, content: b.content ?? d.content, path }, { instruction: b.instruction, selection: b.selection, before, after, mode: b.mode }, onStep);
      let doc = null;
      if (b.apply) {
        const content = applyEdit(getDoc(db, a.workspaceId, d.id)!.content, { ...out, selection: b.selection, cursor: b.cursor });
        db.update('knowledge_docs', d.id, { content, updated_at: nowIso() });
        doc = docJson(docOf(a.workspaceId, d.id), true);
      }
      return {
        markdown: out.markdown, mode: out.mode, note: out.note, steps: out.steps, applied: b.apply, doc,
        usage: { prompt_tokens: out.usage.prompt, completion_tokens: out.usage.completion, cost_usd: Math.round(out.usage.costUsd * 10_000) / 10_000 },
      };
    };
    if (!b.stream) {
      try { return { data: await go() }; } catch (e: any) { throw e.statusCode === 409 ? new HttpError(409, { error: 'conflict', message: e.message }) : badRequest(e.message); }
    }
    // Server-sent events over the POST response: { type: 'step', label } … then { type: 'done', data } or { type: 'error', message }.
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };
    try { send({ type: 'done', data: await go((label) => send({ type: 'step', label })) }); } catch (e: any) { send({ type: 'error', message: e.message }); }
    reply.raw.end();
  }, { body: agentBody });
}
