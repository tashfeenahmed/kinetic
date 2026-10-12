import { knowledgeContext } from '../knowledge/store.ts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, bool, canWrite, defineRoutes, HttpError, idList, idParam, notFound, parse } from '../http.ts';
import { aiConfig, aiSortingActive, applyLabel, classifyPending, classifyReply, draftReply, modelFor } from '../engine/replyAi.ts';
import { REPLY_LABELS } from '../mail/replyLabels.ts';

const notConfigured = () => new HttpError(422, { error: 'ai_not_configured', message: 'Set OPENROUTER_API_KEY on the Integrations page (or AI_BASE_URL for a local model) to use AI reply sorting.' });

export function replyAiRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Replies');
  const { db } = ctx;

  const getReply = (ws: number, id: number) => {
    const row = db.get('SELECT * FROM replies WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!row) throw notFound('reply');
    return row;
  };
  const json = (row: Row) => ({
    id: row.id, label: row.label ?? row.category, label_source: row.label_source, category: row.category,
    interested: !!row.interested, automated: !!row.automated, ai_status: row.ai_status, ai_confidence: row.ai_confidence,
    ai_summary: row.ai_summary, ai_next_action: row.ai_next_action, ai_details: row.ai_details ? JSON.parse(row.ai_details) : null,
    ai_model: row.ai_model, ai_error: row.ai_error, ai_classified_at: row.ai_classified_at,
  });

  const labelBody = z.object({
    label: z.enum(REPLY_LABELS),
    return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Out-of-office return date (YYYY-MM-DD); pauses the lead until then'),
    skip_webhooks: bool.default(false),
  });
  r.patch('/api/replies/:id/label', 'Re-label a reply by hand (manual override the AI never changes)', (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const b = parse(labelBody, req.body);
    applyLabel(ctx, reply.id, b.label, { source: 'manual', details: b.return_date ? { return_date: b.return_date } : undefined, skipWebhooks: b.skip_webhooks });
    return { data: json(getReply(a.workspaceId, reply.id)) };
  }, { body: labelBody });

  const classifyBody = z.object({ fresh: bool.default(false) });
  r.post('/api/replies/:id/classify', 'Classify one reply with AI now (category, summary, next action)', async (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const b = parse(classifyBody, req.body);
    if (!aiConfig(ctx).configured) throw notConfigured();
    if (reply.label_source === 'manual') return { data: { ...json(reply), manual_override: true } };
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [a.workspaceId])!;
    const model = modelFor(ctx, ws);
    try {
      const info = await classifyReply(ctx, reply, { model, fresh: b.fresh });
      applyLabel(ctx, reply.id, info.label, { source: 'ai', info, model });
    } catch (e: any) {
      db.update('replies', reply.id, { ai_status: 'failed', ai_error: String(e?.message ?? e).slice(0, 500) });
      throw new HttpError(502, { error: 'ai_failed', message: `AI classification failed; the rule label was kept. ${e?.message ?? ''}`.trim() });
    }
    return { data: json(getReply(a.workspaceId, reply.id)) };
  }, { body: classifyBody });

  const reclassifyBody = z.object({
    reply_ids: idList.optional(),
    from: z.string().optional().describe('Received on/after (ISO date or datetime)'),
    to: z.string().optional().describe('Received on/before (ISO date or datetime)'),
    folder: z.enum(['inbox', 'spam', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
  });
  r.post('/api/replies/reclassify', 'Queue replies for AI re-classification (selected ids or a date range); manual labels are kept', (req) => {
    const a = canWrite(req);
    const b = parse(reclassifyBody, req.body);
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [a.workspaceId])!;
    if (!aiConfig(ctx).configured) throw notConfigured();
    if (!ws.ai_reply_sorting) throw new HttpError(422, { error: 'ai_disabled', message: 'Turn on AI reply sorting in the master inbox settings first.' });
    if (!b.reply_ids && !b.from && !b.to) throw new HttpError(422, { error: 'validation_error', message: 'Pass reply_ids or a date range (from/to).' });
    const where = ['workspace_id = ?', `folder != 'bounced'`, `COALESCE(label, category) NOT IN ('bounce','other')`, `(automated = 0 OR label = 'out_of_office')`];
    const params: any[] = [a.workspaceId];
    if (b.reply_ids) { where.push(`id IN (${b.reply_ids.map(() => '?').join(',')})`); params.push(...b.reply_ids); }
    if (b.from) { where.push('received_at >= ?'); params.push(b.from); }
    if (b.to) { where.push('received_at <= ?'); params.push(/T/.test(b.to) ? b.to : `${b.to}T23:59:59.999Z`); }
    if (b.folder !== 'all') { where.push('folder = ?'); params.push(b.folder); }
    const manual = db.get(`SELECT COUNT(*) n FROM replies WHERE ${where.join(' AND ')} AND label_source = 'manual'`, params).n;
    const queued = db.run(`UPDATE replies SET ai_status = 'refresh', ai_error = NULL WHERE id IN (
      SELECT id FROM replies WHERE ${where.join(' AND ')} AND label_source != 'manual' ORDER BY received_at DESC LIMIT ?)`, [...params, b.limit]).changes;
    return { data: { queued, skipped_manual: manual } };
  }, { body: reclassifyBody });

  r.get('/api/replies/ai-status', 'AI reply sorting: whether it is on, the model, and queue counts', (req) => {
    const a = auth(req);
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', [a.workspaceId])!;
    const counts = db.get(`SELECT
        COALESCE(SUM(ai_status IN ('pending','refresh')), 0) AS queued,
        COALESCE(SUM(ai_status = 'failed'), 0) AS failed,
        COALESCE(SUM(ai_status = 'done'), 0) AS classified,
        COALESCE(SUM(label_source = 'manual'), 0) AS manual
      FROM replies WHERE workspace_id = ?`, [a.workspaceId]);
    return { data: { active: aiSortingActive(ctx, ws), enabled: !!ws.ai_reply_sorting, configured: aiConfig(ctx).configured, model: modelFor(ctx, ws), ...counts } };
  });

  r.post('/api/replies/ai-queue/run', 'Classify queued replies now instead of waiting for the background job', async (req) => {
    canWrite(req);
    return { data: await classifyPending(ctx, 24) };
  });

  const draftBody = z.object({ instructions: z.string().max(2000).optional(), use_knowledge: bool.default(true) });
  r.post('/api/replies/:id/draft-reply', 'Draft a reply with AI from the thread, lead, campaign and Knowledge Hub (returns text; does not send)', async (req) => {
    const a = canWrite(req);
    const reply = getReply(a.workspaceId, idParam(req));
    const b = parse(draftBody, req.body);
    if (!aiConfig(ctx).configured) throw notConfigured();
    const knowledge = b.use_knowledge ? knowledgeContext(ctx, a.workspaceId) || null : null;
    try {
      const out = await draftReply(ctx, reply, { instructions: b.instructions, knowledge });
      return { data: { draft: out.draft, model: out.model, knowledge_used: !!knowledge } };
    } catch (e: any) {
      throw new HttpError(502, { error: 'ai_failed', message: `Could not draft a reply: ${e?.message ?? e}` });
    }
  }, { body: draftBody });
}
