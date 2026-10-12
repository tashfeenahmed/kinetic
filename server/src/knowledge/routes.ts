import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { auth, badRequest, canWrite, defineRoutes, idParam, notFound, parse } from '../http.ts';
import { fetchPage } from '../gtm/lib/html.ts';
import { getHub, hubPatchSchema, knowledgeContext, mergeDraft, saveHub } from './store.ts';
import { draftFromText, draftFromWebsite } from './ai.ts';

export function knowledgeRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Knowledge Hub');
  const { db } = ctx;
  const settings = () => ctx.gtm!.settings;
  const docJson = (d: any, full = false) => ({ id: d.id, title: d.title, source_url: d.source_url, summary: d.summary, chars: d.content.length, ...(full ? { content: d.content } : {}), created_at: d.created_at, updated_at: d.updated_at });
  const docOf = (ws: number, id: number) => {
    const d = db.get('SELECT * FROM knowledge_docs WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!d) throw notFound('document');
    return d;
  };

  r.get('/api/knowledge', 'Knowledge Hub: company, offers, ICP, personas, positioning, competitors, proof, tone, exclusions and docs', (req) => {
    const a = auth(req);
    const docs = db.all('SELECT * FROM knowledge_docs WHERE workspace_id = ? ORDER BY id DESC', [a.workspaceId]);
    return { data: getHub(db, a.workspaceId), docs: docs.map((d) => docJson(d)) };
  });

  r.put('/api/knowledge', 'Update Knowledge Hub sections (only the sections sent are replaced)', (req) => {
    const a = canWrite(req);
    const b = parse(hubPatchSchema, req.body);
    saveHub(db, a.workspaceId, b);
    return { data: getHub(db, a.workspaceId) };
  }, { body: hubPatchSchema });

  r.get('/api/knowledge/context', 'Knowledge Hub as a compact text summary for prompts', (req) => {
    const text = knowledgeContext(ctx, auth(req).workspaceId);
    return { data: { text, empty: !text } };
  });

  const autofillBody = z.object({ domain: z.string().trim().min(3).max(300), apply: z.boolean().default(false), save_doc: z.boolean().default(true) });
  r.post('/api/knowledge/autofill', 'AI fill from website: crawl the domain and draft hub sections (apply=true fills empty sections)', async (req) => {
    const a = canWrite(req);
    const b = parse(autofillBody, req.body);
    let d;
    try { d = await draftFromWebsite(settings(), b.domain); } catch (e: any) { throw badRequest(`Could not read ${b.domain}: ${e.message}`); }
    if (b.save_doc && d.text) {
      const now = nowIso();
      db.insert('knowledge_docs', { workspace_id: a.workspaceId, title: `Website: ${d.draft.company?.website || b.domain}`, source_url: d.pages[0], content: d.text.slice(0, 60_000), summary: d.summary || null, created_at: now, updated_at: now });
    }
    if (b.apply) saveHub(db, a.workspaceId, mergeDraft(getHub(db, a.workspaceId), d.draft));
    return { data: { draft: d.draft, ai: d.ai, pages: d.pages, applied: b.apply, hub: getHub(db, a.workspaceId) } };
  }, { body: autofillBody });

  // ---- docs ----
  r.get('/api/knowledge/docs', 'List Knowledge Hub documents', (req) => ({
    data: db.all('SELECT * FROM knowledge_docs WHERE workspace_id = ? ORDER BY id DESC', [auth(req).workspaceId]).map((d) => docJson(d)),
  }));

  r.get('/api/knowledge/docs/:id', 'Get a Knowledge Hub document with its full text', (req) => ({ data: docJson(docOf(auth(req).workspaceId, idParam(req)), true) }));

  const docBody = z.object({ title: z.string().trim().max(300).optional(), content: z.string().max(200_000).optional(), url: z.string().trim().max(2000).optional() })
    .refine((b) => b.content?.trim() || b.url, 'Paste some text or give a URL');
  r.post('/api/knowledge/docs', 'Add a document: pasted text, or a URL to fetch', async (req) => {
    const a = canWrite(req);
    const b = parse(docBody, req.body);
    let content = b.content?.trim() ?? '';
    let title = b.title ?? '';
    if (!content && b.url) {
      try {
        const p = await fetchPage(b.url, 20_000);
        if (p.status >= 400) throw new Error(`HTTP ${p.status}`);
        content = p.text.slice(0, 60_000);
        title ||= p.title || b.url;
      } catch (e: any) { throw badRequest(`Could not fetch ${b.url}: ${e.message}`); }
    }
    const now = nowIso();
    const id = db.insert('knowledge_docs', { workspace_id: a.workspaceId, title: title || content.split('\n')[0].slice(0, 80) || 'Untitled', source_url: b.url ?? null, content, summary: null, created_at: now, updated_at: now });
    return { data: docJson(docOf(a.workspaceId, id)) };
  }, { body: docBody });

  const docPatch = z.object({ title: z.string().trim().min(1).max(300).optional(), content: z.string().max(200_000).optional(), summary: z.string().max(5000).nullable().optional() });
  r.patch('/api/knowledge/docs/:id', 'Edit a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const b = parse(docPatch, req.body);
    db.update('knowledge_docs', d.id, { ...b, updated_at: nowIso() });
    return { data: docJson(docOf(a.workspaceId, d.id)) };
  }, { body: docPatch });

  r.delete('/api/knowledge/docs/:id', 'Delete a Knowledge Hub document', (req) => {
    const a = canWrite(req);
    db.run('DELETE FROM knowledge_docs WHERE id = ?', [docOf(a.workspaceId, idParam(req)).id]);
    return { ok: true };
  });

  const draftBody = z.object({ apply: z.boolean().default(false) });
  r.post('/api/knowledge/docs/:id/draft', 'AI: summarise a document and draft hub sections from it (apply=true fills empty sections)', async (req) => {
    const a = canWrite(req);
    const d = docOf(a.workspaceId, idParam(req));
    const b = parse(draftBody, req.body ?? {});
    let out;
    try { out = await draftFromText(settings(), d.content, { title: d.title }); } catch (e: any) { throw badRequest(e.message); }
    if (out.summary) db.update('knowledge_docs', d.id, { summary: out.summary, updated_at: nowIso() });
    if (b.apply) saveHub(db, a.workspaceId, mergeDraft(getHub(db, a.workspaceId), out.draft));
    return { data: { draft: out.draft, summary: out.summary, applied: b.apply, hub: getHub(db, a.workspaceId) } };
  }, { body: draftBody });
}
