import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { auth, badRequest, bool, canWrite, defineRoutes, idParam, notFound, parse } from '../http.ts';
import { fetchPage } from '../gtm/lib/html.ts';
import { INTERNAL_HEADER } from '../agent/internalAuth.ts';
import { TEMPLATES, createDoc, getDoc, knowledgeContext, listDocs, reorderDocs, type DocSource, type KnowledgeDoc } from './store.ts';
import { draftFromWebsite } from './ai.ts';

export function knowledgeRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Knowledge Hub');
  const { db } = ctx;
  const settings = () => ctx.gtm!.settings;
  const excerpt = (md: string) => md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/[#*_>`~|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const docJson = (d: KnowledgeDoc, full = false) => ({
    id: d.id, title: d.title, source_url: d.source_url, pinned: !!d.pinned, position: d.position, created_by: d.created_by,
    chars: d.content.length, ...(full ? { content: d.content } : { excerpt: excerpt(d.content) }), created_at: d.created_at, updated_at: d.updated_at,
  });
  const docOf = (ws: number, id: number) => {
    const d = getDoc(db, ws, id);
    if (!d) throw notFound('document');
    return d;
  };
  /** Docs the Kinetic Agent writes (in-process calls) are labelled as such. */
  const author = (req: FastifyRequest): DocSource => (req.headers[INTERNAL_HEADER] !== undefined ? 'agent' : 'user');

  const listQuery = z.object({ q: z.string().max(200).optional() });
  r.get('/api/knowledge/docs', 'List Knowledge Hub documents (pinned first, then in the user\'s order); q searches titles and text', (req) => {
    const q = parse(listQuery, req.query);
    return { data: listDocs(db, auth(req).workspaceId, q.q).map((d) => docJson(d)) };
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
  });
  r.post('/api/knowledge/docs', 'Create a Knowledge Hub document: markdown content, a template key, a URL to import, or blank', async (req) => {
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
    const d = createDoc(db, a.workspaceId, { title, content, source_url: b.url ?? null, pinned: b.pinned, created_by: author(req) });
    return { data: docJson(d, true) };
  }, { body: docBody });

  const bulkBody = z.object({
    docs: z.array(z.object({ title: z.string().trim().min(1).max(300), content: z.string().max(200_000) })).min(1).max(30),
    source_url: z.string().trim().max(2000).optional(),
    created_by: z.enum(['user', 'agent', 'autofill']).optional(),
  });
  r.post('/api/knowledge/docs/bulk', 'Create several Knowledge Hub documents at once (e.g. the reviewed drafts from fill-from-website)', (req) => {
    const a = canWrite(req);
    const b = parse(bulkBody, req.body);
    // Created bottom-up so the first doc ends up on top.
    const made = db.tx(() => [...b.docs].reverse().map((d) => createDoc(db, a.workspaceId, { ...d, source_url: b.source_url ?? null, created_by: b.created_by ?? author(req) })).reverse());
    return { data: made.map((d) => docJson(d)) };
  }, { body: bulkBody });

  const docPatch = z.object({
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(200_000).optional(),
    pinned: z.boolean().optional(),
    summary: z.string().max(5000).nullable().optional(),
  });
  r.patch('/api/knowledge/docs/:id', 'Edit a Knowledge Hub document: title, markdown content (replaces it) or pinned', (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const b = parse(docPatch, req.body);
    db.update('knowledge_docs', d.id, { ...b, updated_at: nowIso() });
    return { data: docJson(docOf(a.workspaceId, d.id), true) };
  }, { body: docPatch });

  r.post('/api/knowledge/docs/:id/duplicate', 'Duplicate a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    return { data: docJson(createDoc(db, a.workspaceId, { title: `${d.title} (copy)`, content: d.content, source_url: d.source_url, created_by: author(req) }), true) };
  });

  const reorderBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000) });
  r.post('/api/knowledge/docs/reorder', 'Reorder Knowledge Hub documents (ids in the new order)', (req) => {
    const a = canWrite(req);
    reorderDocs(db, a.workspaceId, parse(reorderBody, req.body).ids);
    return { data: listDocs(db, a.workspaceId).map((d) => docJson(d)) };
  }, { body: reorderBody });

  r.delete('/api/knowledge/docs/:id', 'Delete a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    db.run('DELETE FROM knowledge_docs WHERE id = ?', [docOf(a.workspaceId, idParam(req)).id]);
    return { ok: true };
  });

  const ctxQuery = z.object({ max_chars: z.coerce.number().int().min(500).max(20_000).optional() });
  r.get('/api/knowledge/context', 'Knowledge Hub documents as one compact text for prompts (pinned docs first, truncated to ~5k chars)', (req) => {
    const q = parse(ctxQuery, req.query);
    const text = knowledgeContext(ctx, auth(req).workspaceId, q.max_chars);
    return { data: { text, empty: !text } };
  }, { query: ctxQuery });

  const autofillBody = z.object({ domain: z.string().trim().min(3).max(300), apply: bool.default(false) });
  r.post('/api/knowledge/autofill', 'Fill from website: crawl the domain and draft Knowledge Hub documents (company, offers, ICP, personas, positioning, competitors, case studies, tone); apply=true creates them', async (req) => {
    const a = canWrite(req);
    const b = parse(autofillBody, req.body);
    let d;
    try { d = await draftFromWebsite(settings(), b.domain); } catch (e: any) { throw badRequest(`Could not read ${b.domain}: ${e.message}`); }
    const existing = new Set(listDocs(db, a.workspaceId).map((x) => x.title.toLowerCase()));
    const drafts = d.docs.map((x) => ({ ...x, exists: existing.has(x.title.toLowerCase()) }));
    let created: ReturnType<typeof docJson>[] = [];
    if (b.apply) {
      // Never overwrite: docs whose title already exists are skipped.
      const fresh = drafts.filter((x) => !x.exists);
      created = db.tx(() => [...fresh].reverse().map((x) => createDoc(db, a.workspaceId, { title: x.title, content: x.content, source_url: d.pages[0], created_by: 'autofill' })).reverse()).map((x) => docJson(x));
    }
    return { data: { drafts, summary: d.summary, ai: d.ai, pages: d.pages, host: d.host, applied: b.apply, created } };
  }, { body: autofillBody });
}
