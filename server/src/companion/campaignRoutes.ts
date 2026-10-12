/** LinkedIn outreach campaign API (separate from the email campaigns API). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, canWrite, defineRoutes, HttpError, idParam, notFound, paginate, parse, pageQuery, bool } from '../http.ts';
import {
  loadCampaign, campaignJson, settingsOf, addLeads, leadsFromTable, applyReview, leadJson, loadLead, DEFAULT_CAMPAIGN_SETTINGS, type CampaignSettings,
} from './campaigns.ts';
import { AI_TOKEN, aiReady } from './render.ts';

const list = z.array(z.string().max(200)).max(100);
const settingsSchema = z.object({
  visit_first: z.boolean(),
  connect_note: z.string().max(300 * 2),
  ai_instructions: z.string().max(2000),
  messages: z.array(z.object({ template: z.string().min(1).max(8000), delay_days: z.number().min(0).max(15) })).min(1).max(4),
  withdraw_after_days: z.number().int().min(3).max(90).nullable(),
  daily_invites: z.number().int().min(0).max(100),
  daily_messages: z.number().int().min(0).max(200),
  stop_on_reply: z.boolean(),
  filters: z.object({ titles: list, exclude_titles: list, locations: list, companies: list }).partial(),
}).partial();

const profile = z.object({
  profile_url: z.string().min(3), full_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(),
  title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), headline: z.string().optional(),
});
const columns = z.object({
  profile_url: z.string().min(1), full_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional(),
  title: z.string().optional(), company: z.string().optional(), location: z.string().optional(), headline: z.string().optional(),
});

export function linkedinCampaignRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const r = defineRoutes(app, 'LinkedIn Campaigns');
  const now = () => ctx.now();

  const checkSettings = (s: CampaignSettings) => {
    const usesAi = AI_TOKEN.test(s.connect_note) || s.messages.some((m) => AI_TOKEN.test(m.template));
    if (usesAi && !aiReady(ctx.gtm!.settings)) throw new HttpError(422, { error: 'validation_error', message: '{ai_message} needs an AI model — set OPENROUTER_API_KEY (or AI_BASE_URL) on the Integrations page.' });
    if (s.connect_note.replace(AI_TOKEN, '').length > 300) throw new HttpError(422, { error: 'validation_error', message: 'LinkedIn invitation notes are limited to 300 characters.' });
  };
  const merge = (cur: CampaignSettings, patch: z.infer<typeof settingsSchema>): CampaignSettings =>
    settingsOf({ ...cur, ...patch, filters: { ...cur.filters, ...(patch.filters ?? {}) } });

  r.get('/api/linkedin/campaigns', 'List LinkedIn outreach campaigns with dashboard stats', (req) => {
    const a = auth(req);
    return { data: db.all<{ id: number }>('SELECT id FROM li_campaigns WHERE workspace_id = ? ORDER BY id DESC', [a.workspaceId]).map((c) => campaignJson(ctx, loadCampaign(ctx, c.id))) };
  });

  const createBody = z.object({ name: z.string().min(1).max(120), settings: settingsSchema.optional() });
  r.post('/api/linkedin/campaigns', 'Create a LinkedIn outreach campaign (visit → connect → message → follow-ups); starts as a draft', (req) => {
    const a = canWrite(req);
    const b = parse(createBody, req.body);
    const s = merge(DEFAULT_CAMPAIGN_SETTINGS, b.settings ?? {});
    checkSettings(s);
    const iso = now().toISOString();
    const id = db.insert('li_campaigns', { workspace_id: a.workspaceId, name: b.name, status: 'draft', settings: JSON.stringify(s), created_at: iso, updated_at: iso });
    return { data: campaignJson(ctx, loadCampaign(ctx, id)) };
  }, { body: createBody });

  const fromTable = z.object({ table_id: z.number().int().positive(), name: z.string().min(1).max(120), columns, settings: settingsSchema.optional() });
  r.post('/api/linkedin/campaigns/from-table', 'Create a LinkedIn campaign from a table (one lead per row with a LinkedIn URL)', (req) => {
    const a = canWrite(req);
    const b = parse(fromTable, req.body);
    const leads = leadsFromTable(ctx, a.workspaceId, b.table_id, b.columns);
    const s = merge(DEFAULT_CAMPAIGN_SETTINGS, b.settings ?? {});
    checkSettings(s);
    const iso = now().toISOString();
    const id = db.insert('li_campaigns', { workspace_id: a.workspaceId, name: b.name, status: 'draft', settings: JSON.stringify(s), table_id: b.table_id, created_at: iso, updated_at: iso });
    addLeads(ctx, id, leads, now());
    return { data: campaignJson(ctx, loadCampaign(ctx, id)) };
  }, { body: fromTable });

  r.get('/api/linkedin/campaigns/:id', 'LinkedIn campaign with steps, settings and stats (invites, accepted, follow-ups, replies, failed)', (req) => {
    const a = auth(req);
    return { data: campaignJson(ctx, loadCampaign(ctx, idParam(req), a.workspaceId)) };
  });

  const patchBody = z.object({ name: z.string().min(1).max(120).optional(), settings: settingsSchema.optional() });
  r.patch('/api/linkedin/campaigns/:id', 'Update a LinkedIn campaign name, steps, caps or filters', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const b = parse(patchBody, req.body);
    const data: Record<string, unknown> = { updated_at: now().toISOString() };
    if (b.name) data.name = b.name;
    if (b.settings) {
      const s = merge(c.settings, b.settings);
      checkSettings(s);
      data.settings = JSON.stringify(s);
    }
    db.update('li_campaigns', c.id, data);
    return { data: campaignJson(ctx, loadCampaign(ctx, c.id)) };
  }, { body: patchBody });

  r.delete('/api/linkedin/campaigns/:id', 'Delete a LinkedIn campaign (cancels its queued steps)', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    db.run('DELETE FROM li_campaigns WHERE id = ?', [c.id]);
    return { data: { success: true } };
  });

  const leadQuery = pageQuery.extend({ state: z.string().optional(), excluded: bool.optional() });
  r.get('/api/linkedin/campaigns/:id/leads', 'Leads of a LinkedIn campaign with their step state', (req) => {
    const a = auth(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const q = parse(leadQuery, req.query);
    const where = ['campaign_id = ?'];
    const params: any[] = [c.id];
    if (q.state) { where.push('state = ?'); params.push(q.state); }
    if (q.excluded !== undefined) { where.push('excluded = ?'); params.push(q.excluded ? 1 : 0); }
    return paginate(ctx, `SELECT * FROM li_campaign_leads WHERE ${where.join(' AND ')} ORDER BY id`, params, q,
      (l: any) => leadJson({ ...l, data: {}, excluded: !!l.excluded }));
  }, { query: leadQuery });

  const addBody = z.object({ profiles: z.array(profile).min(1).max(5000) });
  r.post('/api/linkedin/campaigns/:id/leads', 'Add leads (LinkedIn profile URLs) to a LinkedIn campaign', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    return { data: addLeads(ctx, c.id, parse(addBody, req.body).profiles, now()) };
  }, { body: addBody });

  const importBody = z.object({ table_id: z.number().int().positive(), columns });
  r.post('/api/linkedin/campaigns/:id/leads/import-table', 'Import leads into a LinkedIn campaign from a table column', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const b = parse(importBody, req.body);
    return { data: addLeads(ctx, c.id, leadsFromTable(ctx, a.workspaceId, b.table_id, b.columns), now()) };
  }, { body: importBody });

  const leadPatch = z.object({ excluded: z.boolean() });
  r.patch('/api/linkedin/campaigns/:id/leads/:leadId', 'Include or exclude one lead (review gate)', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const lead = loadLead(ctx, idParam(req, 'leadId'));
    if (!lead || lead.campaign_id !== c.id) throw notFound('lead');
    db.run('UPDATE li_campaign_leads SET excluded = ? WHERE id = ?', [parse(leadPatch, req.body).excluded ? 1 : 0, lead.id]);
    return { data: leadJson(loadLead(ctx, lead.id)!) };
  }, { body: leadPatch });

  const reviewBody = z.object({ filters: settingsSchema.shape.filters.optional() });
  r.post('/api/linkedin/campaigns/:id/review', 'Review gate: filter pending leads by title, location or company before starting', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const b = parse(reviewBody, req.body ?? {});
    let filters = c.settings.filters;
    if (b.filters) {
      filters = { ...filters, ...b.filters };
      db.update('li_campaigns', c.id, { settings: JSON.stringify({ ...c.settings, filters }), updated_at: now().toISOString() });
    }
    return { data: applyReview(ctx, c.id, filters) };
  }, { body: reviewBody });

  const startBody = z.object({ confirm: z.literal(true, { message: 'Starting sends LinkedIn invitations and messages from your account — pass confirm: true after the user approves.' }) });
  r.post('/api/linkedin/campaigns/:id/start', 'Start a LinkedIn campaign (sends invites/messages — requires confirm:true after user approval)', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    parse(startBody, req.body ?? {});
    if (c.status === 'active') throw new HttpError(409, { error: 'conflict', message: 'The campaign is already running.' });
    const included = db.get<{ n: number }>(`SELECT COUNT(*) n FROM li_campaign_leads WHERE campaign_id = ? AND excluded = 0`, [c.id])!.n;
    if (!included) throw new HttpError(422, { error: 'validation_error', message: 'Add leads (and review them) before starting.' });
    checkSettings(c.settings);
    db.update('li_campaigns', c.id, { status: 'active', approved_at: c.approved_at ?? now().toISOString(), updated_at: now().toISOString() });
    return { data: campaignJson(ctx, loadCampaign(ctx, c.id)) };
  }, { body: startBody });

  r.post('/api/linkedin/campaigns/:id/pause', 'Pause a LinkedIn campaign', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    if (c.status !== 'active') throw new HttpError(409, { error: 'conflict', message: `The campaign is ${c.status}.` });
    db.update('li_campaigns', c.id, { status: 'paused', updated_at: now().toISOString() });
    return { data: campaignJson(ctx, loadCampaign(ctx, c.id)) };
  });

  r.post('/api/linkedin/campaigns/:id/resume', 'Resume a paused LinkedIn campaign', (req) => {
    const a = canWrite(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    if (c.status !== 'paused') throw new HttpError(409, { error: 'conflict', message: `The campaign is ${c.status}.` });
    db.update('li_campaigns', c.id, { status: 'active', updated_at: now().toISOString() });
    return { data: campaignJson(ctx, loadCampaign(ctx, c.id)) };
  });

  r.get('/api/linkedin/campaigns/:id/activity', 'Recent steps of a LinkedIn campaign (visits, invites, messages, checks)', (req) => {
    const a = auth(req);
    const c = loadCampaign(ctx, idParam(req), a.workspaceId);
    const rows = db.all(`SELECT t.id, t.kind, t.status, t.error, t.updated_at, l.full_name AS lead_name, l.profile_url FROM companion_tasks t
      LEFT JOIN li_campaign_leads l ON l.id = t.campaign_lead_id WHERE t.campaign_id = ? ORDER BY t.updated_at DESC, t.id DESC LIMIT 200`, [c.id]);
    return { data: rows };
  });
}
