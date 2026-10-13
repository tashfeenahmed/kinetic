import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, canWrite, defineRoutes, HttpError, idParam, notFound, parse } from '../http.ts';
import { DEAL_STAGES, dealOfLead, openDeal, setDealStage } from '../engine/deals.ts';

const DEAL_SQL = `SELECT d.*, l.email AS lead_email, l.first_name, l.last_name, l.company, l.title, c.name AS campaign_name
  FROM deals d JOIN leads l ON l.id = d.lead_id LEFT JOIN campaigns c ON c.id = d.campaign_id`;

const dealJson = (d: Row) => ({
  id: d.id, stage: d.stage, value: d.value, currency: d.currency, lost_reason: d.lost_reason, notes: d.notes,
  lead_id: d.lead_id, campaign_id: d.campaign_id, reply_id: d.reply_id,
  lead: { id: d.lead_id, email: d.lead_email, first_name: d.first_name, last_name: d.last_name, company: d.company, title: d.title },
  campaign_name: d.campaign_name ?? null,
  stage_changed_at: d.stage_changed_at, meeting_at: d.meeting_at, created_at: d.created_at, updated_at: d.updated_at,
});

export function dealRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Deals');
  const { db } = ctx;
  const getDeal = (workspaceId: number, id: number) => {
    const d = db.get(`${DEAL_SQL} WHERE d.id = ? AND d.workspace_id = ?`, [id, workspaceId]);
    if (!d) throw notFound('deal');
    return d;
  };

  const listQ = z.object({
    stage: z.string().optional(), campaign_id: z.coerce.number().int().optional(), lead_id: z.coerce.number().int().optional(),
    search: z.string().trim().optional(),
  });
  r.get('/api/deals', 'List deals (pipeline). Filter by stage (comma-separated), campaign_id, lead_id or search', (req) => {
    const a = auth(req);
    const q = parse(listQ, req.query);
    const where = ['d.workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    const stages = (q.stage ?? '').split(',').map((s) => s.trim()).filter((s) => (DEAL_STAGES as readonly string[]).includes(s));
    if (stages.length) { where.push(`d.stage IN (${stages.map(() => '?').join(',')})`); params.push(...stages); }
    if (q.campaign_id) { where.push('d.campaign_id = ?'); params.push(q.campaign_id); }
    if (q.lead_id) { where.push('d.lead_id = ?'); params.push(q.lead_id); }
    if (q.search) {
      where.push(`(l.email LIKE ? OR l.company LIKE ? OR l.first_name || ' ' || l.last_name LIKE ?)`);
      params.push(...Array(3).fill(`%${q.search}%`));
    }
    const rows = db.all(`${DEAL_SQL} WHERE ${where.join(' AND ')} ORDER BY d.stage_changed_at DESC LIMIT 2000`, params);
    return { data: rows.map(dealJson), stages: DEAL_STAGES };
  }, { query: listQ });

  r.get('/api/deals/:id', 'Get a deal', (req) => {
    const a = auth(req);
    return { data: dealJson(getDeal(a.workspaceId, idParam(req))) };
  });

  const fields = {
    value: z.number().min(0).nullable().optional(),
    currency: z.string().trim().max(10).nullable().optional(),
    lost_reason: z.string().trim().max(1000).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  };
  const createBody = z.object({ lead_id: z.coerce.number().int().positive(), stage: z.enum(DEAL_STAGES).default('interested'), ...fields });
  r.post('/api/deals', 'Open a deal for a lead by hand (one deal per lead)', (req) => {
    const a = canWrite(req);
    const { lead_id, stage, ...rest } = parse(createBody, req.body);
    if (!db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [lead_id, a.workspaceId])) throw notFound('lead');
    if (dealOfLead(ctx, a.workspaceId, lead_id)) throw new HttpError(409, { error: 'conflict', message: 'This lead already has a deal' });
    // Credit the campaign of the lead's latest reply, if any.
    const last = db.get('SELECT id, campaign_id FROM replies WHERE lead_id = ? AND automated = 0 ORDER BY received_at DESC LIMIT 1', [lead_id]);
    const { deal } = openDeal(ctx, a.workspaceId, lead_id, { stage, campaignId: last?.campaign_id ?? null, replyId: last?.id ?? null, source: 'manual', fields: rest });
    return { data: dealJson(getDeal(a.workspaceId, deal.id)) };
  }, { body: createBody });

  const patchBody = z.object({ stage: z.enum(DEAL_STAGES).optional(), ...fields });
  r.patch('/api/deals/:id', 'Update a deal: move it to another stage, set its value, lost reason or notes', (req) => {
    const a = canWrite(req);
    const d = getDeal(a.workspaceId, idParam(req));
    const { stage, ...rest } = parse(patchBody, req.body);
    const extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    db.tx(() => {
      if (stage && stage !== d.stage) setDealStage(ctx, d, stage, 'manual', extra);
      else if (Object.keys(extra).length) db.update('deals', d.id, { ...extra, updated_at: ctx.now().toISOString() });
    });
    return { data: dealJson(getDeal(a.workspaceId, d.id)) };
  }, { body: patchBody });

  r.delete('/api/deals/:id', 'Delete a deal', (req) => {
    const a = canWrite(req);
    const n = db.run('DELETE FROM deals WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes;
    if (!n) throw notFound('deal');
    return { data: { success: true } };
  });
}
