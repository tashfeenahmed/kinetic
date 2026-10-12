import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, badRequest, canWrite, defineRoutes, idList, idParam, notFound, pageQuery, paginate, parse, bool } from '../http.ts';
import { unsubscribeLead } from '../engine/inbox.ts';
import { cancelScheduled } from '../engine/sequencer.ts';
import { domainOf } from '../lib/dns.ts';
import { tagsFor } from './tags.ts';
import { leadEmailStats, leadFilters, leadWhere } from './leadFilters.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LEAD_STATUSES = ['verified', 'unverified', 'unknown', 'unsubscribed', 'risky', 'inactive', 'bounced'] as const;

const customVarsSchema = z.union([
  z.array(z.object({ name: z.string().min(1), value: z.union([z.string(), z.number(), z.null()]) })),
  z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
]).optional();

export const leadInput = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, 'is invalid'),
  first_name: z.string().trim().max(200).optional(),
  last_name: z.string().trim().max(200).optional(),
  title: z.string().trim().max(300).optional(),
  company: z.string().trim().max(300).optional(),
  notes: z.string().max(5000).optional(),
  custom_variables: customVarsSchema,
});
type LeadInput = z.infer<typeof leadInput>;

function normalizeVars(v: LeadInput['custom_variables']): Record<string, string> {
  if (!v) return {};
  if (Array.isArray(v)) return Object.fromEntries(v.map((x) => [x.name, x.value == null ? '' : String(x.value)]));
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val == null ? '' : String(val)]));
}

/** Registers any new custom variable names in the workspace. */
function registerVars(ctx: Ctx, workspaceId: number, names: string[]) {
  for (const n of names) ctx.db.run('INSERT OR IGNORE INTO custom_variables (workspace_id, name) VALUES (?, ?)', [workspaceId, n]);
}

export function leadJson(ctx: Ctx, l: Row) {
  const vars = JSON.parse(l.custom_variables || '{}');
  const stats = ctx.db.get(
    `SELECT COUNT(*) AS emails_sent, COALESCE(SUM(opens),0) AS opens, COALESCE(SUM(clicks),0) AS clicks,
       (SELECT COUNT(*) FROM replies r WHERE r.lead_id = ? AND r.automated = 0 AND r.folder != 'bounced') AS replies
     FROM sent_emails WHERE lead_id = ?`, [l.id, l.id]);
  return {
    ...l,
    custom_variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
    tags: tagsFor(ctx, 'lead', l.id),
    lead_list: l.lead_list_id ? ctx.db.get('SELECT id, name FROM lead_lists WHERE id = ?', [l.lead_list_id]) ?? null : null,
    overall_stats: stats,
    email_stats: leadEmailStats(ctx, l.id),
  };
}

export type ExistingBehavior = 'put' | 'patch' | 'skip';

/** Creates or updates leads by email. Returns created/updated ids. */
export function upsertLeads(ctx: Ctx, workspaceId: number, rows: LeadInput[], behavior: ExistingBehavior, listId: number | null) {
  const { db } = ctx;
  const result = { created: 0, updated: 0, skipped: 0, lead_ids: [] as number[] };
  const now = ctx.now().toISOString();
  const seen = new Set<string>();
  const varNames = new Set<string>();
  db.tx(() => {
    for (const row of rows) {
      if (seen.has(row.email)) { result.skipped++; continue; }
      seen.add(row.email);
      const vars = normalizeVars(row.custom_variables);
      Object.keys(vars).forEach((k) => varNames.add(k));
      const existing = db.get('SELECT * FROM leads WHERE workspace_id = ? AND email = ?', [workspaceId, row.email]);
      if (!existing) {
        const id = db.insert('leads', {
          workspace_id: workspaceId, email: row.email, first_name: row.first_name ?? '', last_name: row.last_name ?? '',
          title: row.title ?? '', company: row.company ?? '', notes: row.notes ?? '', custom_variables: JSON.stringify(vars),
          lead_list_id: listId, created_at: now, updated_at: now,
        });
        result.created++;
        result.lead_ids.push(id);
        continue;
      }
      result.lead_ids.push(existing.id);
      if (behavior === 'skip') { result.skipped++; continue; }
      const update: Row = { updated_at: now };
      for (const k of ['first_name', 'last_name', 'title', 'company', 'notes'] as const) {
        if (behavior === 'put') update[k] = row[k] ?? '';
        else if (row[k] !== undefined && row[k] !== '') update[k] = row[k];
      }
      const merged = behavior === 'put' ? vars : { ...JSON.parse(existing.custom_variables || '{}'), ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== '')) };
      update.custom_variables = JSON.stringify(merged);
      if (listId) update.lead_list_id = listId;
      db.update('leads', existing.id, update);
      result.updated++;
    }
    registerVars(ctx, workspaceId, [...varNames]);
  });
  return result;
}

/** CSV text + column mapping -> lead rows. Unmapped columns become custom variables when `include_unmapped`. */
export function csvToLeads(csv: string, mapping: Record<string, string>, includeUnmapped: boolean): { rows: LeadInput[]; invalid: { line: number; email: string; reason: string }[] } {
  const records = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const standard = ['email', 'first_name', 'last_name', 'title', 'company', 'notes'];
  const mappedColumns = new Set(Object.values(mapping));
  const rows: LeadInput[] = [];
  const invalid: { line: number; email: string; reason: string }[] = [];
  records.forEach((rec, i) => {
    const lead: Record<string, any> = { custom_variables: {} as Record<string, string> };
    for (const [field, column] of Object.entries(mapping)) {
      if (!column) continue;
      const value = rec[column] ?? '';
      if (standard.includes(field)) lead[field] = value;
      else lead.custom_variables[field] = value; // field is a custom variable name
    }
    if (includeUnmapped) {
      for (const [col, value] of Object.entries(rec)) if (!mappedColumns.has(col)) lead.custom_variables[col] = value;
    }
    const parsed = leadInput.safeParse(lead);
    if (parsed.success) rows.push(parsed.data);
    else invalid.push({ line: i + 2, email: String(lead.email ?? ''), reason: parsed.error.issues[0]?.message ?? 'invalid' });
  });
  return { rows, invalid };
}

export function leadRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Leads');
  const { db } = ctx;

  const getLead = (ws: number, id: number) => {
    const l = db.get('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!l) throw notFound('lead');
    return l;
  };

  // Filters (incl. email stats: opens, clicks, replies, last contacted…) live in leadFilters.ts.
  const listQuery = pageQuery.extend(leadFilters.shape);
  r.get('/api/leads', 'Get all leads (filter by status, list, tag, campaign and email stats: sent/opens/clicks/replies, bounced, reply category, last contacted, mailbox, email provider)', (req) => {
    const a = auth(req);
    const q = parse(listQuery, req.query);
    const { where, params, order } = leadWhere(ctx, a.workspaceId, q);
    return paginate(ctx, `SELECT l.* FROM leads l WHERE ${where.join(' AND ')} ${order}`, params, q, (l) => leadJson(ctx, l));
  }, { query: listQuery });

  r.post('/api/leads', 'Create lead', (req) => {
    const a = canWrite(req);
    const b = parse(leadInput.extend({ lead_list_id: z.number().int().optional() }), req.body);
    if (db.get('SELECT 1 FROM leads WHERE workspace_id = ? AND email = ?', [a.workspaceId, b.email])) {
      throw Object.assign(badRequest('A lead with this email already exists.'), { status: 422, body: { error: 'validation_error', message: 'A lead with this email already exists.', fields: { email: ['has already been taken'] } } });
    }
    const res = upsertLeads(ctx, a.workspaceId, [b], 'skip', b.lead_list_id ?? null);
    return { data: leadJson(ctx, getLead(a.workspaceId, res.lead_ids[0]!)) };
  }, { body: leadInput });

  const multiBody = z.object({ leads: z.array(z.any()).min(1).max(5000), existing_lead_behavior: z.enum(['put', 'patch', 'skip']).default('patch'), lead_list_id: z.number().int().optional() });
  const bulk = (req: any) => {
    const a = canWrite(req);
    const b = parse(multiBody, req.body);
    const valid: LeadInput[] = [];
    const invalid: { index: number; email: string; reason: string }[] = [];
    b.leads.forEach((l: unknown, i: number) => {
      const p = leadInput.safeParse(l);
      if (p.success) valid.push(p.data);
      else invalid.push({ index: i, email: String((l as any)?.email ?? ''), reason: p.error.issues[0]?.message ?? 'invalid' });
    });
    if (b.lead_list_id && !db.get('SELECT 1 FROM lead_lists WHERE id = ? AND workspace_id = ?', [b.lead_list_id, a.workspaceId])) throw notFound('lead list');
    const res = upsertLeads(ctx, a.workspaceId, valid, b.existing_lead_behavior, b.lead_list_id ?? null);
    return { data: { ...res, invalid } };
  };
  r.post('/api/leads/multiple', 'Bulk create leads', bulk, { body: multiBody });
  r.post('/api/leads/create-or-update/multiple', 'Update or create multiple leads', bulk, { body: multiBody });

  const csvBody = z.object({
    csv: z.string().min(1),
    mapping: z.record(z.string(), z.string()),
    include_unmapped: bool.default(false),
    existing_lead_behavior: z.enum(['put', 'patch', 'skip']).default('patch'),
    lead_list_id: z.number().int().optional(),
    new_list_name: z.string().optional(),
    campaign_id: z.number().int().optional(),
  });
  r.post('/api/leads/bulk/csv', 'Bulk create leads from CSV text', (req) => {
    const a = canWrite(req);
    const b = parse(csvBody, req.body);
    if (!b.mapping.email) throw badRequest('Map a column to email.');
    let listId = b.lead_list_id ?? null;
    if (!listId && b.new_list_name) listId = db.insert('lead_lists', { workspace_id: a.workspaceId, name: b.new_list_name });
    let parsed;
    try { parsed = csvToLeads(b.csv, b.mapping, b.include_unmapped); } catch (e: any) { throw badRequest(`Could not read CSV: ${e.message}`); }
    const res = upsertLeads(ctx, a.workspaceId, parsed.rows, b.existing_lead_behavior, listId);
    let attached = 0;
    if (b.campaign_id) attached = attachLeads(ctx, a.workspaceId, b.campaign_id, res.lead_ids, false);
    return { data: { ...res, invalid: parsed.invalid, lead_list_id: listId, attached_to_campaign: attached } };
  }, { body: csvBody });

  r.get('/api/leads/:id', 'Get single lead', (req) => {
    const a = auth(req);
    const lead = getLead(a.workspaceId, idParam(req));
    const campaigns = db.all(
      `SELECT c.id, c.name, c.status AS campaign_status, cl.status, cl.current_step, cl.last_sent_at, cl.next_due_at
       FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ?`, [lead.id]);
    return { data: { ...leadJson(ctx, lead), campaigns } };
  });

  const updateLead = (req: any) => {
    const a = canWrite(req);
    const lead = getLead(a.workspaceId, idParam(req));
    const b = parse(leadInput.partial(), req.body);
    if (b.email && b.email !== lead.email && db.get('SELECT 1 FROM leads WHERE workspace_id = ? AND email = ?', [a.workspaceId, b.email])) {
      throw Object.assign(badRequest('email taken'), { status: 422, body: { error: 'validation_error', message: 'A lead with this email already exists.', fields: { email: ['has already been taken'] } } });
    }
    const update: Row = { updated_at: ctx.now().toISOString() };
    for (const k of ['email', 'first_name', 'last_name', 'title', 'company', 'notes'] as const) if (b[k] !== undefined) update[k] = b[k];
    if (b.custom_variables !== undefined) {
      const vars = normalizeVars(b.custom_variables);
      update.custom_variables = JSON.stringify(req.method === 'PUT' ? vars : { ...JSON.parse(lead.custom_variables), ...vars });
      registerVars(ctx, a.workspaceId, Object.keys(vars));
    }
    db.update('leads', lead.id, update);
    return { data: leadJson(ctx, getLead(a.workspaceId, lead.id)) };
  };
  r.put('/api/leads/:id', 'Update lead (replace)', updateLead, { body: leadInput.partial() });
  r.patch('/api/leads/:id', 'Update lead', updateLead, { body: leadInput.partial() });

  r.delete('/api/leads/:id', 'Delete lead', (req) => {
    const a = canWrite(req);
    const lead = getLead(a.workspaceId, idParam(req));
    db.run('DELETE FROM leads WHERE id = ?', [lead.id]);
    db.run(`DELETE FROM taggables WHERE taggable_type = 'lead' AND taggable_id = ?`, [lead.id]);
    return { data: { success: true } };
  });

  const idsBody = z.object({ lead_ids: idList });
  r.delete('/api/leads/bulk', 'Bulk delete leads', (req) => {
    const a = canWrite(req);
    const b = parse(idsBody, req.body);
    const ph = b.lead_ids.map(() => '?').join(',');
    const n = db.run(`DELETE FROM leads WHERE workspace_id = ? AND id IN (${ph})`, [a.workspaceId, ...b.lead_ids]).changes;
    db.run(`DELETE FROM taggables WHERE taggable_type = 'lead' AND taggable_id IN (${ph})`, b.lead_ids);
    return { data: { deleted: n } };
  }, { body: idsBody });

  const statusBody = z.object({ status: z.enum(LEAD_STATUSES) });
  r.patch('/api/leads/:id/update-status', 'Update lead status', (req) => {
    const a = canWrite(req);
    const lead = getLead(a.workspaceId, idParam(req));
    const b = parse(statusBody, req.body);
    if (b.status === 'unsubscribed') unsubscribeLead(ctx, lead, 'manual');
    else db.update('leads', lead.id, { status: b.status, updated_at: ctx.now().toISOString() });
    return { data: leadJson(ctx, getLead(a.workspaceId, lead.id)) };
  }, { body: statusBody });

  const bulkStatusBody = z.object({ lead_ids: idList, status: z.enum(LEAD_STATUSES) });
  r.patch('/api/leads/bulk-update-status', 'Bulk update lead status', (req) => {
    const a = canWrite(req);
    const b = parse(bulkStatusBody, req.body);
    for (const id of b.lead_ids) {
      const lead = db.get('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, a.workspaceId]);
      if (!lead) continue;
      if (b.status === 'unsubscribed') unsubscribeLead(ctx, lead, 'manual');
      else db.update('leads', id, { status: b.status, updated_at: ctx.now().toISOString() });
    }
    return { data: { success: true } };
  }, { body: bulkStatusBody });

  r.patch('/api/leads/:id/unsubscribe', 'Unsubscribe lead', (req) => {
    const a = canWrite(req);
    const lead = getLead(a.workspaceId, idParam(req));
    unsubscribeLead(ctx, lead, 'manual');
    return { data: leadJson(ctx, getLead(a.workspaceId, lead.id)) };
  });

  r.post('/api/leads/:id/blacklist', 'Add lead to blacklist', (req) => {
    const a = canWrite(req);
    const lead = getLead(a.workspaceId, idParam(req));
    db.run('INSERT OR IGNORE INTO blacklisted_emails (workspace_id, email) VALUES (?, ?)', [a.workspaceId, lead.email]);
    db.run(`UPDATE campaign_leads SET status = 'stopped', next_due_at = NULL WHERE lead_id = ? AND status IN ('pending','in_sequence')`, [lead.id]);
    cancelScheduled(ctx, { leadId: lead.id }, 'blacklisted');
    return { data: { success: true } };
  });

  r.get('/api/leads/:id/replies', 'Replies from lead', (req) => {
    const a = auth(req);
    const lead = getLead(a.workspaceId, idParam(req));
    return { data: db.all('SELECT * FROM replies WHERE lead_id = ? ORDER BY received_at DESC', [lead.id]) };
  });

  r.get('/api/leads/:id/sent-emails', 'Emails sent to lead', (req) => {
    const a = auth(req);
    const lead = getLead(a.workspaceId, idParam(req));
    return { data: db.all(`SELECT s.*, c.name AS campaign_name FROM sent_emails s LEFT JOIN campaigns c ON c.id = s.campaign_id WHERE s.lead_id = ? ORDER BY s.sent_at DESC`, [lead.id]) };
  });

  r.get('/api/leads/:id/scheduled-emails', 'Scheduled emails for lead', (req) => {
    const a = auth(req);
    const lead = getLead(a.workspaceId, idParam(req));
    return { data: db.all(`SELECT * FROM scheduled_emails WHERE lead_id = ? ORDER BY scheduled_at DESC`, [lead.id]) };
  });

  // ---- lead lists ----
  const lr = defineRoutes(app, 'Lead Lists');
  lr.get('/api/lead-lists', 'Get all lead lists', (req) => {
    const a = auth(req);
    return { data: db.all(`SELECT ll.*, (SELECT COUNT(*) FROM leads l WHERE l.lead_list_id = ll.id) AS leads_count FROM lead_lists ll WHERE workspace_id = ? ORDER BY id DESC`, [a.workspaceId]) };
  });
  const listBody = z.object({ name: z.string().min(1).max(200) });
  lr.post('/api/lead-lists', 'Create lead list', (req) => {
    const a = canWrite(req);
    const id = db.insert('lead_lists', { workspace_id: a.workspaceId, ...parse(listBody, req.body) });
    return { data: db.get('SELECT * FROM lead_lists WHERE id = ?', [id]) };
  }, { body: listBody });
  lr.get('/api/lead-lists/:id', 'View lead list', (req) => {
    const a = auth(req);
    const l = db.get(`SELECT ll.*, (SELECT COUNT(*) FROM leads l WHERE l.lead_list_id = ll.id) AS leads_count FROM lead_lists ll WHERE id = ? AND workspace_id = ?`, [idParam(req), a.workspaceId]);
    if (!l) throw notFound('lead list');
    return { data: l };
  });
  lr.put('/api/lead-lists/:id', 'Rename lead list', (req) => {
    const a = canWrite(req);
    const n = db.run('UPDATE lead_lists SET name = ? WHERE id = ? AND workspace_id = ?', [parse(listBody, req.body).name, idParam(req), a.workspaceId]).changes;
    if (!n) throw notFound('lead list');
    return { data: db.get('SELECT * FROM lead_lists WHERE id = ?', [idParam(req)]) };
  }, { body: listBody });
  lr.delete('/api/lead-lists/:id', 'Delete lead list (keeps the leads)', (req) => {
    const a = canWrite(req);
    const n = db.run('DELETE FROM lead_lists WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes;
    if (!n) throw notFound('lead list');
    return { data: { success: true } };
  });
}

/** Adds leads to a campaign. Returns how many were newly attached. */
export function attachLeads(ctx: Ctx, workspaceId: number, campaignId: number, leadIds: number[], allowParallel: boolean): number {
  const { db } = ctx;
  const campaign = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [campaignId, workspaceId]);
  if (!campaign) throw notFound('campaign');
  let added = 0;
  db.tx(() => {
    for (const id of leadIds) {
      const lead = db.get('SELECT id, email, status FROM leads WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
      if (!lead) continue;
      if (!allowParallel && db.get(`SELECT 1 FROM campaign_leads WHERE lead_id = ? AND campaign_id != ? AND status IN ('pending','in_sequence')`, [id, campaignId])) continue;
      const blocked = ['unsubscribed', 'bounced'].includes(lead.status)
        || db.get('SELECT 1 FROM blacklisted_emails WHERE workspace_id = ? AND email = ? UNION ALL SELECT 1 FROM blacklisted_domains WHERE workspace_id = ? AND domain = ?', [workspaceId, lead.email, workspaceId, domainOf(lead.email)]);
      const r = db.run('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, ?)', [campaignId, id, blocked ? 'stopped' : 'pending']);
      added += r.changes;
    }
    if (added && campaign.status === 'completed') db.update('campaigns', campaignId, { status: 'active' });
  });
  return added;
}

