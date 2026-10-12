/**
 * Lead filters by email activity (sent, opens, clicks, replies, bounces, reply category,
 * last contacted/opened/clicked, campaign, mailbox, email provider), saved views,
 * CSV export and bulk actions on a filtered set. Stats come from `lead_stats`, which
 * SQLite triggers keep current (see migration 008), so filters are plain indexed lookups.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify as toCsv } from 'csv-stringify/sync';
import type { Ctx } from '../context.ts';
import { auth, bool, canWrite, defineRoutes, HttpError, idList, idParam, notFound, parse } from '../http.ts';
import { EMAIL_PROVIDERS, resolveDomains, unresolvedDomains } from '../engine/emailProviders.ts';
import { attachLeads } from './leads.ts';
import { setTags } from './tags.ts';

const LEAD_STATUSES = ['verified', 'unverified', 'unknown', 'unsubscribed', 'risky', 'inactive', 'bounced'] as const;

/** "a,b,c" or ["a","b"] -> string[] */
const csvList = z.preprocess((v) => (v == null || v === '' ? undefined : Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean)), z.array(z.string()).optional());
const idCsv = z.preprocess((v) => (v == null || v === '' ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0)), z.array(z.number()).optional());
const count = z.coerce.number().int().min(0).optional();
/** ISO date/datetime, or a relative age like "14d", "12h", "2w", "3m" (= that long ago). */
const when = z.string().trim().regex(/^(\d+[hdwm]|\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?)$/i, 'use an ISO date or an age like 14d').optional();

/** Base filters that the Leads page always had. */
export const leadBaseFilters = z.object({
  search: z.string().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  lead_list_id: z.coerce.number().int().optional(),
  campaign_id: z.coerce.number().int().optional(),
  tag_id: z.coerce.number().int().optional(),
  without_campaign: bool.optional(),
});

/** Email-activity filters. Every one is optional; they combine with AND. */
export const leadStatFilters = z.object({
  sent_min: count, sent_max: count,
  opens_min: count, opens_max: count,
  clicks_min: count, clicks_max: count,
  replies_min: count, replies_max: count,
  replied: bool.optional().describe('true = has a human reply, false = never replied'),
  bounced: bool.optional(),
  unsubscribed: bool.optional(),
  reply_category: csvList.describe('Any reply with one of these labels, e.g. interested,meeting_request'),
  last_contacted_before: when, last_contacted_after: when,
  last_opened_before: when, last_opened_after: when,
  last_clicked_before: when, last_clicked_after: when,
  last_replied_before: when, last_replied_after: when,
  in_campaign_ids: idCsv,
  not_in_campaign_ids: idCsv,
  sender_email_ids: idCsv.describe('Leads emailed by (or assigned to) one of these mailboxes'),
  email_provider: csvList.describe(`Recipient mailbox provider from MX: ${EMAIL_PROVIDERS.join(', ')}, unknown`),
  sort: z.enum(['newest', 'oldest', 'opens', 'clicks', 'replies', 'emails_sent', 'last_contacted', 'last_opened', 'last_replied']).optional(),
});
export const leadFilters = leadBaseFilters.extend(leadStatFilters.shape);
export type LeadFilters = z.infer<typeof leadFilters>;

/** Resolves "14d" style ages against now; passes ISO dates through. */
export function resolveWhen(v: string, now: Date): string {
  const m = /^(\d+)([hdwm])$/i.exec(v);
  if (!m) return /T/.test(v) ? v : `${v}T00:00:00.000Z`;
  const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 }[m[2]!.toLowerCase() as 'h']!;
  return new Date(now.getTime() - Number(m[1]) * unit).toISOString();
}

const STAT_SORT: Record<string, string> = {
  opens: 'opens', clicks: 'clicks', replies: 'replies', emails_sent: 'emails_sent', last_contacted: 'last_sent_at', last_opened: 'last_opened_at', last_replied: 'last_replied_at',
};

/** WHERE clauses + params for leads (alias `l`) matching the filters, and the ORDER BY. */
export function leadWhere(ctx: Ctx, workspaceId: number, q: Partial<LeadFilters>): { where: string[]; params: any[]; order: string } {
  const where = ['l.workspace_id = ?'];
  const params: any[] = [workspaceId];
  if (q.search) {
    where.push(`(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ? OR (l.first_name || ' ' || l.last_name) LIKE ?)`);
    params.push(...Array(5).fill(`%${q.search}%`));
  }
  if (q.status) { where.push('l.status = ?'); params.push(q.status); }
  if (q.lead_list_id) { where.push('l.lead_list_id = ?'); params.push(q.lead_list_id); }
  if (q.campaign_id) { where.push('EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.campaign_id = ?)'); params.push(q.campaign_id); }
  if (q.without_campaign) where.push('NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id)');
  if (q.tag_id) { where.push(`EXISTS (SELECT 1 FROM taggables t WHERE t.taggable_type = 'lead' AND t.taggable_id = l.id AND t.tag_id = ?)`); params.push(q.tag_id); }

  // Stat conditions all go into one lookup on lead_stats.
  const st: string[] = [];
  const sp: any[] = [];
  const range = (col: string, min?: number, max?: number) => {
    if (min != null) { st.push(`ls.${col} >= ?`); sp.push(min); }
    if (max != null) { st.push(`ls.${col} <= ?`); sp.push(max); }
  };
  range('emails_sent', q.sent_min, q.sent_max);
  range('opens', q.opens_min, q.opens_max);
  range('clicks', q.clicks_min, q.clicks_max);
  range('replies', q.replies_min, q.replies_max);
  if (q.replied != null) st.push(q.replied ? 'ls.replies > 0' : 'ls.replies = 0');
  const now = ctx.now();
  const dates: [keyof LeadFilters, string, '<' | '>='][] = [
    ['last_contacted_before', 'last_sent_at', '<'], ['last_contacted_after', 'last_sent_at', '>='],
    ['last_opened_before', 'last_opened_at', '<'], ['last_opened_after', 'last_opened_at', '>='],
    ['last_clicked_before', 'last_clicked_at', '<'], ['last_clicked_after', 'last_clicked_at', '>='],
    ['last_replied_before', 'last_replied_at', '<'], ['last_replied_after', 'last_replied_at', '>='],
  ];
  for (const [key, col, op] of dates) {
    const v = q[key] as string | undefined;
    if (v) { st.push(`ls.${col} ${op} ?`); sp.push(resolveWhen(v, now)); }
  }
  if (st.length) {
    where.push(`l.id IN (SELECT ls.lead_id FROM lead_stats ls WHERE ls.workspace_id = ? AND ${st.join(' AND ')})`);
    params.push(workspaceId, ...sp);
  }

  if (q.bounced != null) {
    const b = `(l.status = 'bounced' OR EXISTS (SELECT 1 FROM lead_stats lb WHERE lb.lead_id = l.id AND lb.bounced = 1))`;
    where.push(q.bounced ? b : `NOT ${b}`);
  }
  if (q.unsubscribed != null) where.push(q.unsubscribed ? `l.status = 'unsubscribed'` : `l.status != 'unsubscribed'`);
  if (q.reply_category?.length) {
    const ph = q.reply_category.map(() => '?').join(',');
    where.push(`l.id IN (SELECT r.lead_id FROM replies r WHERE r.workspace_id = ? AND r.lead_id IS NOT NULL AND COALESCE(r.label, r.category) IN (${ph}))`);
    params.push(workspaceId, ...q.reply_category);
  }
  if (q.in_campaign_ids?.length) {
    where.push(`l.id IN (SELECT cl.lead_id FROM campaign_leads cl WHERE cl.campaign_id IN (${q.in_campaign_ids.map(() => '?').join(',')}))`);
    params.push(...q.in_campaign_ids);
  }
  if (q.not_in_campaign_ids?.length) {
    where.push(`l.id NOT IN (SELECT cl.lead_id FROM campaign_leads cl WHERE cl.campaign_id IN (${q.not_in_campaign_ids.map(() => '?').join(',')}))`);
    params.push(...q.not_in_campaign_ids);
  }
  if (q.sender_email_ids?.length) {
    const ph = q.sender_email_ids.map(() => '?').join(',');
    where.push(`l.id IN (SELECT s.lead_id FROM sent_emails s WHERE s.sender_email_id IN (${ph}) AND s.lead_id IS NOT NULL
      UNION SELECT cl.lead_id FROM campaign_leads cl WHERE cl.sender_email_id IN (${ph}))`);
    params.push(...q.sender_email_ids, ...q.sender_email_ids);
  }
  if (q.email_provider?.length) {
    const known = q.email_provider.filter((p) => p !== 'unknown');
    const dom = `lower(substr(l.email, instr(l.email, '@') + 1))`;
    const parts: string[] = [];
    if (known.length) { parts.push(`${dom} IN (SELECT domain FROM email_domains WHERE provider IN (${known.map(() => '?').join(',')}))`); params.push(...known); }
    if (known.length !== q.email_provider.length) parts.push(`${dom} NOT IN (SELECT domain FROM email_domains)`);
    where.push(`(${parts.join(' OR ')})`);
  }

  const col = q.sort ? STAT_SORT[q.sort] : undefined;
  const order = col ? `ORDER BY (SELECT ls2.${col} FROM lead_stats ls2 WHERE ls2.lead_id = l.id) DESC, l.id DESC` : q.sort === 'oldest' ? 'ORDER BY l.id ASC' : 'ORDER BY l.id DESC';
  return { where, params, order };
}

/** Stats for one lead, as shown on the Leads page. */
export function leadEmailStats(ctx: Ctx, leadId: number) {
  return ctx.db.get(`SELECT emails_sent, opens, clicks, replies, bounced, last_sent_at, last_opened_at, last_clicked_at, last_replied_at FROM lead_stats WHERE lead_id = ?`, [leadId]) ?? null;
}

/** Ready-made filters for the Leads page and the agent. */
export const LEAD_FILTER_PRESETS = [
  { id: 'opened_no_reply', name: 'Opened 3+ times, no reply', filters: { opens_min: 3, replied: false } },
  { id: 'clicked_no_reply', name: 'Clicked, no reply', filters: { clicks_min: 1, replied: false } },
  { id: 'never_opened', name: 'Never opened', filters: { sent_min: 1, opens_max: 0 } },
  { id: 'bounced', name: 'Bounced', filters: { bounced: true } },
  { id: 'interested', name: 'Interested', filters: { reply_category: ['interested', 'meeting_request'] } },
];

const MAX_IDS = 50_000;

export function leadFilterRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Leads');
  const { db } = ctx;

  const matchingIds = (workspaceId: number, f: Partial<LeadFilters>, limit = MAX_IDS) => {
    const { where, params, order } = leadWhere(ctx, workspaceId, f);
    return db.all<{ id: number }>(`SELECT l.id FROM leads l WHERE ${where.join(' AND ')} ${order} LIMIT ?`, [...params, limit]).map((x) => x.id);
  };

  r.get('/api/leads/filter-presets', 'Ready-made lead filters by email activity (opened no reply, never opened, bounced, interested…)', () => ({ data: LEAD_FILTER_PRESETS }));

  r.get('/api/leads/ids', 'Ids of all leads matching the GET /api/leads filters (up to 50,000)', (req) => {
    const a = auth(req);
    const q = parse(leadFilters, req.query);
    const ids = matchingIds(a.workspaceId, q, MAX_IDS + 1);
    return { data: { ids: ids.slice(0, MAX_IDS), total: Math.min(ids.length, MAX_IDS), truncated: ids.length > MAX_IDS } };
  }, { query: leadFilters });

  r.get('/api/leads/export', 'Export leads matching the GET /api/leads filters as CSV, with email stats', (req, reply) => {
    const a = auth(req);
    const q = parse(leadFilters, req.query);
    const { where, params, order } = leadWhere(ctx, a.workspaceId, q);
    const rows = db.all(
      `SELECT l.*, ls.emails_sent, ls.opens, ls.clicks, ls.replies, ls.bounced AS has_bounced, ls.last_sent_at, ls.last_opened_at, ls.last_clicked_at, ls.last_replied_at,
         (SELECT provider FROM email_domains WHERE domain = lower(substr(l.email, instr(l.email, '@') + 1))) AS email_provider
       FROM leads l LEFT JOIN lead_stats ls ON ls.lead_id = l.id WHERE ${where.join(' AND ')} ${order} LIMIT 200000`, params);
    const varNames = [...new Set(rows.flatMap((x) => Object.keys(JSON.parse(x.custom_variables || '{}'))))].slice(0, 50);
    const head = ['email', 'first_name', 'last_name', 'title', 'company', 'status', 'emails_sent', 'opens', 'clicks', 'replies', 'bounced',
      'last_contacted_at', 'last_opened_at', 'last_clicked_at', 'last_replied_at', 'email_provider', 'created_at', ...varNames];
    const body = toCsv([head, ...rows.map((x) => {
      const vars = JSON.parse(x.custom_variables || '{}');
      return [x.email, x.first_name, x.last_name, x.title, x.company, x.status, x.emails_sent ?? 0, x.opens ?? 0, x.clicks ?? 0, x.replies ?? 0, x.has_bounced ? 'yes' : 'no',
        x.last_sent_at ?? '', x.last_opened_at ?? '', x.last_clicked_at ?? '', x.last_replied_at ?? '', x.email_provider ?? '', x.created_at, ...varNames.map((n) => vars[n] ?? '')];
    })]);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="leads-${ctx.now().toISOString().slice(0, 10)}.csv"`);
    return reply.send(body);
  }, { query: leadFilters });

  const bulkBody = z.object({
    filters: leadFilters.default({}),
    lead_ids: idList.optional().describe('Use these ids instead of filters'),
    action: z.enum(['add_to_campaign', 'attach_tags', 'remove_tags']),
    campaign_id: z.coerce.number().int().optional(),
    tag_ids: idList.optional(),
    allow_parallel_sending: bool.default(false),
  });
  r.post('/api/leads/bulk-by-filter', 'Bulk action on every lead matching filters: add to campaign, attach or remove tags', (req) => {
    const a = canWrite(req);
    const b = parse(bulkBody, req.body);
    const ids = b.lead_ids ?? matchingIds(a.workspaceId, b.filters);
    if (b.action === 'add_to_campaign') {
      if (!b.campaign_id) throw new HttpError(422, { error: 'validation_error', message: 'campaign_id is required.' });
      return { data: { matched: ids.length, attached: ids.length ? attachLeads(ctx, a.workspaceId, b.campaign_id, ids, b.allow_parallel_sending) : 0 } };
    }
    if (!b.tag_ids) throw new HttpError(422, { error: 'validation_error', message: 'tag_ids is required.' });
    return { data: { matched: ids.length, changed: ids.length ? setTags(ctx, a.workspaceId, 'lead', b.tag_ids, ids, b.action === 'attach_tags') : 0 } };
  }, { body: bulkBody });

  // ---- email providers (MX) ----
  r.get('/api/leads/email-providers', 'Lead counts by recipient mailbox provider (Google, Microsoft, …) from cached MX lookups', (req) => {
    const a = auth(req);
    const rows = db.all(`SELECT COALESCE(d.provider, 'unknown') AS provider, COUNT(*) AS leads FROM leads l
      LEFT JOIN email_domains d ON d.domain = lower(substr(l.email, instr(l.email, '@') + 1)) WHERE l.workspace_id = ? GROUP BY 1 ORDER BY 2 DESC`, [a.workspaceId]);
    return { data: rows };
  });

  const refreshBody = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
  r.post('/api/leads/email-providers/refresh', 'Look up MX records now for lead domains not resolved yet', async (req) => {
    const a = canWrite(req);
    const b = parse(refreshBody, req.body);
    const domains = unresolvedDomains(ctx, b.limit, a.workspaceId);
    const resolved = await resolveDomains(ctx, domains);
    return { data: { resolved, remaining: unresolvedDomains(ctx, 1000, a.workspaceId).length } };
  }, { body: refreshBody });

  // ---- saved views ----
  const v = defineRoutes(app, 'Lead Views');
  const viewJson = (x: any) => ({ ...x, filters: JSON.parse(x.filters || '{}') });
  v.get('/api/lead-views', 'Saved lead filters (views)', (req) => {
    const a = auth(req);
    return { data: db.all('SELECT * FROM lead_views WHERE workspace_id = ? ORDER BY name', [a.workspaceId]).map(viewJson) };
  });
  const viewBody = z.object({ name: z.string().trim().min(1).max(100), filters: z.record(z.string(), z.any()).default({}) });
  const checkFilters = (f: Record<string, unknown>) => { parse(leadFilters, f); return f; };
  v.post('/api/lead-views', 'Save a lead filter as a view (filters use GET /api/leads parameters)', (req) => {
    const a = canWrite(req);
    const b = parse(viewBody, req.body);
    const id = db.insert('lead_views', { workspace_id: a.workspaceId, name: b.name, filters: JSON.stringify(checkFilters(b.filters)) });
    return { data: viewJson(db.get('SELECT * FROM lead_views WHERE id = ?', [id])) };
  }, { body: viewBody });
  v.put('/api/lead-views/:id', 'Update a saved lead view', (req) => {
    const a = canWrite(req);
    const b = parse(viewBody.partial(), req.body);
    const view = db.get('SELECT * FROM lead_views WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!view) throw notFound('view');
    db.update('lead_views', view.id, { ...(b.name ? { name: b.name } : {}), ...(b.filters ? { filters: JSON.stringify(checkFilters(b.filters)) } : {}) });
    return { data: viewJson(db.get('SELECT * FROM lead_views WHERE id = ?', [view.id])) };
  }, { body: viewBody.partial() });
  v.delete('/api/lead-views/:id', 'Delete a saved lead view', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM lead_views WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('view');
    return { data: { success: true } };
  });
}
