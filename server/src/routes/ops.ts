/** Warmup, sending schedule, webhooks, placement tests, dashboard stats, events and settings. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '../context.ts';
import { auth, bool, canWrite, defineRoutes, HttpError, idList, idParam, notFound, pageQuery, paginate, parse, requireAdmin } from '../http.ts';
import { encrypt, randomToken } from '../lib/crypto.ts';
import { EVENT_TYPES, webhookPayload, type EventType } from '../events.ts';
import { attempt } from '../engine/webhooks.ts';
import { rampTarget, warmupStats, warmupTimezone } from '../engine/warmup.ts';
import { placementSummary, startPlacementTest } from '../engine/placement.ts';
import { runImap } from '../mail/gateway.ts';
import { checkDomain } from '../lib/dns.ts';
import { getSetting, setSetting, warmupFilterPhrase } from '../settings.ts';
import { isValidTimezone } from '../lib/schedule.ts';
import { dailySeries } from './campaigns.ts';
import { notWarmupMailbox } from './tags.ts';

export function opsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ---- warmup ----
  const w = defineRoutes(app, 'Warmup');
  const warmupRow = (s: any) => ({
    id: s.id, name: s.name, email: s.email, provider: s.provider, status: s.status,
    warmup_enabled: !!s.warmup_enabled, warmup_daily_limit: s.warmup_daily_limit, warmup_reply_rate: s.warmup_reply_rate,
    warmup_started_at: s.warmup_started_at, today_target: s.warmup_enabled ? rampTarget(s, ctx.now(), warmupTimezone(ctx)) : 0,
    stats: warmupStats(ctx, s.id, 7),
  });
  w.get('/api/warmup/sender-emails', 'Email accounts with warmup stats', (req) => {
    const a = auth(req);
    const pool = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sender_emails WHERE warmup_enabled = 1 AND status = 'Connected'`)!.n;
    return { data: db.all('SELECT * FROM sender_emails WHERE workspace_id = ? ORDER BY email', [a.workspaceId]).map(warmupRow), meta: { pool_size: pool } };
  });
  w.get('/api/warmup/sender-emails/:id', 'Warmup details for one email account', (req) => {
    const a = auth(req);
    const s = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!s) throw notFound('email account');
    const since = DateTime.fromJSDate(ctx.now()).toUTC().startOf('day').minus({ days: 29 });
    const series = db.all(
      `SELECT substr(COALESCE(sent_at, scheduled_at),1,10) day,
         SUM(CASE WHEN from_sender_id = ? AND status = 'sent' THEN 1 ELSE 0 END) sent,
         SUM(CASE WHEN from_sender_id = ? AND landed_folder = 'inbox' THEN 1 ELSE 0 END) inbox,
         SUM(CASE WHEN from_sender_id = ? AND landed_folder = 'spam' THEN 1 ELSE 0 END) spam,
         SUM(CASE WHEN to_sender_id = ? AND received_at IS NOT NULL THEN 1 ELSE 0 END) received
       FROM warmup_emails WHERE (from_sender_id = ? OR to_sender_id = ?) AND COALESCE(sent_at, scheduled_at) >= ? GROUP BY day ORDER BY day`,
      [s.id, s.id, s.id, s.id, s.id, s.id, since.toISO()]);
    return { data: { ...warmupRow(s), stats_30d: warmupStats(ctx, s.id, 30), daily: series } };
  });
  const idsBody = z.object({ sender_email_ids: idList });
  for (const enable of [true, false]) {
    w.patch(`/api/warmup/sender-emails/${enable ? 'enable' : 'disable'}`, `${enable ? 'Enable' : 'Disable'} warmup`, (req) => {
      const a = canWrite(req);
      const b = parse(idsBody, req.body);
      const ph = b.sender_email_ids.map(() => '?').join(',');
      db.tx(() => {
        db.run(`UPDATE sender_emails SET warmup_enabled = ?, warmup_started_at = CASE WHEN ? = 1 THEN COALESCE(warmup_started_at, ?) ELSE warmup_started_at END WHERE workspace_id = ? AND id IN (${ph})`,
          [enable ? 1 : 0, enable ? 1 : 0, ctx.now().toISOString(), a.workspaceId, ...b.sender_email_ids]);
        if (!enable) db.run(`UPDATE warmup_emails SET status = 'cancelled' WHERE status = 'scheduled' AND from_sender_id IN (${ph})`, b.sender_email_ids);
      });
      return { data: { success: true } };
    }, { body: idsBody });
  }
  const limitsBody = z.object({ sender_email_ids: idList, daily_limit: z.coerce.number().int().min(1).max(200), daily_reply_limit: z.coerce.number().int().min(0).max(100).optional() });
  w.patch('/api/warmup/sender-emails/update-daily-warmup-limits', 'Update warmup limits', (req) => {
    const a = canWrite(req);
    const b = parse(limitsBody, req.body);
    const ph = b.sender_email_ids.map(() => '?').join(',');
    db.run(`UPDATE sender_emails SET warmup_daily_limit = ?, warmup_reply_rate = COALESCE(?, warmup_reply_rate) WHERE workspace_id = ? AND id IN (${ph})`,
      [b.daily_limit, b.daily_reply_limit ?? null, a.workspaceId, ...b.sender_email_ids]);
    return { data: { success: true } };
  }, { body: limitsBody });
  w.get('/api/warmup/settings', 'Warmup settings', (req) => {
    auth(req);
    return { data: { timezone: warmupTimezone(ctx), filter_phrase: warmupFilterPhrase(db), folder: 'Kinetic Warmup', window: '08:00–20:00' } };
  });
  const wsBody = z.object({ timezone: z.string().refine(isValidTimezone, 'is not a valid timezone') });
  w.put('/api/warmup/settings', 'Update warmup settings', (req) => {
    requireAdmin(req);
    setSetting(db, 'warmup_timezone', parse(wsBody, req.body).timezone);
    return { data: { timezone: warmupTimezone(ctx) } };
  }, { body: wsBody });

  // ---- sending schedule ----
  const sch = defineRoutes(app, 'Scheduled Emails');
  const schQ = pageQuery.extend({ status: z.enum(['scheduled', 'sending', 'sent', 'failed', 'cancelled']).optional(), date: z.string().optional(), tz: z.string().optional(), campaign_id: z.coerce.number().int().optional(), sender_email_id: z.coerce.number().int().optional() });
  sch.get('/api/scheduled-emails', 'Scheduled emails across campaigns', (req) => {
    const a = auth(req);
    const q = parse(schQ, req.query);
    const where = ['se.workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.status) { where.push('se.status = ?'); params.push(q.status); }
    if (q.campaign_id) { where.push('se.campaign_id = ?'); params.push(q.campaign_id); }
    if (q.sender_email_id) { where.push('se.sender_email_id = ?'); params.push(q.sender_email_id); }
    if (q.date) {
      // The day is interpreted in the viewer's timezone when given.
      const d = DateTime.fromISO(q.date, { zone: q.tz && isValidTimezone(q.tz) ? q.tz : 'utc' }).startOf('day');
      where.push('se.scheduled_at >= ? AND se.scheduled_at < ?');
      params.push(d.toUTC().toISO(), d.plus({ days: 1 }).toUTC().toISO());
    }
    return paginate(ctx,
      `SELECT se.*, l.email AS lead_email, l.first_name, l.last_name, s.email AS sender_email, c.name AS campaign_name, st.email_subject
       FROM scheduled_emails se JOIN leads l ON l.id = se.lead_id JOIN sender_emails s ON s.id = se.sender_email_id
       JOIN campaigns c ON c.id = se.campaign_id LEFT JOIN sequence_steps st ON st.id = se.sequence_step_id
       WHERE ${where.join(' AND ')} ORDER BY se.scheduled_at`, params, q);
  }, { query: schQ });
  sch.get('/api/scheduled-emails/summary', 'Today and upcoming sending summary', (req) => {
    const a = auth(req);
    const from = DateTime.fromJSDate(ctx.now()).toUTC().startOf('day');
    const days = db.all(
      `SELECT substr(scheduled_at,1,10) day, status, COUNT(*) n FROM scheduled_emails WHERE workspace_id = ? AND scheduled_at >= ? AND scheduled_at < ? GROUP BY day, status`,
      [a.workspaceId, from.minus({ days: 6 }).toISO(), from.plus({ days: 8 }).toISO()]);
    const capacity = db.get<{ n: number }>(`SELECT COALESCE(SUM(daily_limit),0) n FROM sender_emails WHERE workspace_id = ? AND status = 'Connected'`, [a.workspaceId])!.n;
    const bySender = db.all(
      `SELECT s.id, s.email, s.daily_limit, s.status,
         SUM(CASE WHEN se.status = 'sent' THEN 1 ELSE 0 END) sent, SUM(CASE WHEN se.status = 'scheduled' THEN 1 ELSE 0 END) scheduled, SUM(CASE WHEN se.status = 'failed' THEN 1 ELSE 0 END) failed
       FROM sender_emails s LEFT JOIN scheduled_emails se ON se.sender_email_id = s.id AND se.scheduled_at >= ? AND se.scheduled_at < ?
       WHERE s.workspace_id = ? GROUP BY s.id ORDER BY s.email`, [from.toISO(), from.plus({ days: 1 }).toISO(), a.workspaceId]);
    return { data: { days, capacity, by_sender: bySender } };
  });
  sch.get('/api/scheduled-emails/:id', 'Get scheduled email', (req) => {
    const a = auth(req);
    const row = db.get('SELECT * FROM scheduled_emails WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!row) throw notFound('scheduled email');
    return { data: row };
  });

  // ---- webhooks ----
  const wh = defineRoutes(app, 'Webhooks');
  const hookJson = (h: any) => ({ ...h, events: JSON.parse(h.events) });
  wh.get('/api/webhook-url', 'Get all webhooks', (req) => ({ data: db.all('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY id', [auth(req).workspaceId]).map(hookJson) }));
  const hookBody = z.object({ name: z.string().trim().min(1).max(100), url: z.url(), events: z.array(z.enum(Object.keys(EVENT_TYPES) as [EventType, ...EventType[]])).min(1) });
  wh.post('/api/webhook-url', 'Create webhook', (req) => {
    const a = canWrite(req);
    const b = parse(hookBody, req.body);
    const id = db.insert('webhooks', { workspace_id: a.workspaceId, name: b.name, url: b.url, events: JSON.stringify(b.events), secret: randomToken(24) });
    return { data: hookJson(db.get('SELECT * FROM webhooks WHERE id = ?', [id])) };
  }, { body: hookBody });
  wh.get('/api/webhook-url/:id', 'Get webhook', (req) => {
    const h = db.get('SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?', [idParam(req), auth(req).workspaceId]);
    if (!h) throw notFound('webhook');
    return { data: hookJson(h) };
  });
  wh.put('/api/webhook-url/:id', 'Update webhook', (req) => {
    const a = canWrite(req);
    const b = parse(hookBody, req.body);
    if (!db.run('UPDATE webhooks SET name = ?, url = ?, events = ? WHERE id = ? AND workspace_id = ?', [b.name, b.url, JSON.stringify(b.events), idParam(req), a.workspaceId]).changes) throw notFound('webhook');
    return { data: hookJson(db.get('SELECT * FROM webhooks WHERE id = ?', [idParam(req)])) };
  }, { body: hookBody });
  wh.delete('/api/webhook-url/:id', 'Delete webhook', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('webhook');
    return { data: { success: true } };
  });
  wh.get('/api/webhook-events/event-types', 'Webhook event types', () => ({ data: Object.entries(EVENT_TYPES).map(([id, name]) => ({ id, name })) }));
  const sampleQ = z.object({ event_type: z.enum(Object.keys(EVENT_TYPES) as [EventType, ...EventType[]]) });
  const sample = (ws: { id: number; name: string }, type: EventType) => webhookPayload(ctx, ws.id, ws.name, type, sampleData(type));
  wh.get('/api/webhook-events/sample-payload', 'Sample payload for an event type', (req) => {
    const a = auth(req);
    const ws = db.get('SELECT id, name FROM workspaces WHERE id = ?', [a.workspaceId])!;
    return { data: sample(ws as any, parse(sampleQ, req.query).event_type) };
  }, { query: sampleQ });
  const testBody = z.object({ event_type: z.enum(Object.keys(EVENT_TYPES) as [EventType, ...EventType[]]), url: z.url() });
  wh.post('/api/webhook-events/test-event', 'Send a test webhook', async (req) => {
    const a = canWrite(req);
    const b = parse(testBody, req.body);
    const ws = db.get('SELECT id, name FROM workspaces WHERE id = ?', [a.workspaceId])!;
    const payload = JSON.stringify(sample(ws as any, b.event_type));
    try {
      const res = await ctx.fetch(b.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kinetic-event': b.event_type, 'x-kinetic-test': '1' }, body: payload, signal: AbortSignal.timeout(15_000) });
      return { data: { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 1000) } };
    } catch (e: any) {
      throw new HttpError(422, { error: 'delivery_failed', message: e.message });
    }
  }, { body: testBody });
  const delQ = pageQuery.extend({ webhook_id: z.coerce.number().int().optional(), status: z.enum(['pending', 'succeeded', 'failed']).optional() });
  wh.get('/api/webhook-deliveries', 'Recent webhook deliveries', (req) => {
    const a = auth(req);
    const q = parse(delQ, req.query);
    const where = ['w.workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.webhook_id) { where.push('d.webhook_id = ?'); params.push(q.webhook_id); }
    if (q.status) { where.push('d.status = ?'); params.push(q.status); }
    return paginate(ctx, `SELECT d.id, d.webhook_id, w.name AS webhook_name, d.event_type, d.status, d.attempts, d.next_attempt_at, d.created_at FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE ${where.join(' AND ')} ORDER BY d.id DESC`, params, q);
  }, { query: delQ });
  wh.get('/api/webhook-deliveries/:id', 'Webhook delivery with attempts', (req) => {
    const a = auth(req);
    const d = db.get('SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!d) throw notFound('delivery');
    return { data: { ...d, payload: JSON.parse(d.payload), attempts_log: db.all('SELECT * FROM webhook_attempts WHERE webhook_delivery_id = ? ORDER BY id', [d.id]) } };
  });
  wh.post('/api/webhook-deliveries/:id/retry', 'Retry a webhook delivery now', async (req) => {
    const a = canWrite(req);
    const d = db.get('SELECT d.*, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!d) throw notFound('delivery');
    const ok = await attempt(ctx, { ...d, attempts: Math.min(d.attempts, 4) });
    if (ok) db.update('webhook_deliveries', d.id, { status: 'succeeded' });
    return { data: { ok } };
  });

  // ---- inbox placement ----
  const pl = defineRoutes(app, 'Inbox Placement');
  pl.get('/api/seed-accounts', 'Seed inboxes used for placement tests', (req) => {
    auth(req);
    return { data: db.all('SELECT id, provider, email, imap_server, imap_port, imap_secure, username, created_at FROM seed_accounts ORDER BY provider, email') };
  });
  const seedBody = z.object({
    provider: z.string().trim().min(1).max(30), email: z.email(), imap_server: z.string().trim().min(1), imap_port: z.coerce.number().int().default(993),
    imap_secure: bool.default(true), username: z.string().optional(), password: z.string().min(1), skip_verification: bool.default(false),
  });
  pl.post('/api/seed-accounts', 'Add a seed inbox', async (req) => {
    requireAdmin(req);
    const b = parse(seedBody, req.body);
    if (!b.skip_verification) {
      try {
        await runImap({ host: b.imap_server, port: b.imap_port, secure: b.imap_secure, auth: { user: b.username || b.email, pass: b.password } }, async () => undefined);
      } catch (e: any) {
        throw new HttpError(422, { error: 'connection_failed', message: `IMAP: ${e.responseText ?? e.message}` });
      }
    }
    const id = db.insert('seed_accounts', { provider: b.provider.toLowerCase(), email: b.email.toLowerCase(), imap_server: b.imap_server, imap_port: b.imap_port, imap_secure: b.imap_secure ? 1 : 0, username: b.username || b.email, secret_enc: encrypt(b.password) });
    return { data: db.get('SELECT id, provider, email, imap_server, imap_port FROM seed_accounts WHERE id = ?', [id]) };
  }, { body: seedBody });
  pl.delete('/api/seed-accounts/:id', 'Remove a seed inbox', (req) => {
    requireAdmin(req);
    if (!db.run('DELETE FROM seed_accounts WHERE id = ?', [idParam(req)]).changes) throw notFound('seed account');
    return { data: { success: true } };
  });
  const testQ = z.object({ campaign_id: z.coerce.number().int().optional() });
  pl.get('/api/placement-tests', 'List placement tests', (req) => {
    const a = auth(req);
    const q = parse(testQ, req.query);
    const rows = db.all(`SELECT * FROM placement_tests WHERE workspace_id = ? ${q.campaign_id ? 'AND campaign_id = ?' : ''} ORDER BY id DESC LIMIT 100`, q.campaign_id ? [a.workspaceId, q.campaign_id] : [a.workspaceId]);
    return { data: rows.map((t) => { const { results: _r, ...sum } = placementSummary(ctx, t.id); return { ...t, summary: sum }; }) };
  }, { query: testQ });
  const startBody = z.object({ campaign_id: z.coerce.number().int(), sequence_step_id: z.coerce.number().int().optional(), sender_email_ids: idList, seed_account_ids: z.array(z.coerce.number().int()).optional() });
  pl.post('/api/placement-tests', 'Run an inbox placement test', async (req) => {
    const a = canWrite(req);
    const b = parse(startBody, req.body);
    try {
      const id = await startPlacementTest(ctx, { workspaceId: a.workspaceId, campaignId: b.campaign_id, stepId: b.sequence_step_id, senderIds: b.sender_email_ids, seedIds: b.seed_account_ids });
      return { data: { ...db.get('SELECT * FROM placement_tests WHERE id = ?', [id]), summary: placementSummary(ctx, id) } };
    } catch (e: any) {
      throw new HttpError(422, { error: 'validation_error', message: e.message });
    }
  }, { body: startBody });
  pl.get('/api/placement-tests/:id', 'Placement test results', (req) => {
    const a = auth(req);
    const t = db.get('SELECT * FROM placement_tests WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!t) throw notFound('test');
    return { data: { ...t, summary: placementSummary(ctx, t.id) } };
  });

  // ---- dashboard / stats ----
  const st = defineRoutes(app, 'Workspace Stats');
  const rangeQ = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
  st.get('/api/workspaces/v1.1/stats', 'Workspace stats summary', (req) => {
    const a = auth(req);
    const q = parse(rangeQ, req.query);
    const since = new Date(ctx.now().getTime() - q.days * 86_400_000).toISOString();
    const s = db.get(
      `SELECT COUNT(*) emails_sent, COUNT(DISTINCT lead_id) leads_contacted, COUNT(DISTINCT CASE WHEN opens > 0 THEN lead_id END) unique_opens,
         COUNT(DISTINCT CASE WHEN bounced = 1 THEN lead_id END) bounced
       FROM sent_emails WHERE workspace_id = ? AND kind = 'campaign' AND sent_at >= ?`, [a.workspaceId, since])!;
    const r = db.get(
      `SELECT COUNT(DISTINCT lead_id) unique_replies, COUNT(DISTINCT CASE WHEN interested = 1 THEN lead_id END) interested
       FROM replies WHERE workspace_id = ? AND automated = 0 AND folder != 'bounced' AND received_at >= ?`, [a.workspaceId, since])!;
    const unsub = db.get<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE workspace_id = ? AND type = 'LEAD_UNSUBSCRIBED' AND created_at >= ?`, [a.workspaceId, since])!.n;
    const pct = (n: number) => (s.leads_contacted ? Math.round((n / s.leads_contacted) * 1000) / 10 : 0);
    const counts = db.get(
      `SELECT (SELECT COUNT(*) FROM campaigns WHERE workspace_id = ? AND status = 'active') active_campaigns,
         (SELECT COUNT(*) FROM campaigns WHERE workspace_id = ? AND launched_at IS NOT NULL) launched_campaigns,
         (SELECT COUNT(*) FROM sender_emails WHERE workspace_id = ? AND status = 'Connected') connected_senders,
         (SELECT COUNT(*) FROM sender_emails WHERE workspace_id = ? AND status = 'Disconnected') disconnected_senders,
         (SELECT COUNT(*) FROM leads WHERE workspace_id = ?) total_leads,
         (SELECT COUNT(*) FROM replies WHERE workspace_id = ? AND folder = 'inbox' AND read = 0 AND ${notWarmupMailbox('sender_email_id')}) unread_replies,
         (SELECT COUNT(*) FROM scheduled_emails WHERE workspace_id = ? AND status = 'scheduled') scheduled_emails`,
      Array(8).fill(a.workspaceId))!;
    return {
      data: {
        ...s, ...r, unsubscribed: unsub,
        reply_rate: pct(r.unique_replies), interested_rate: pct(r.interested), bounce_rate: pct(s.bounced), open_rate: pct(s.unique_opens),
        ...counts,
      },
    };
  }, { query: rangeQ });
  st.get('/api/workspaces/v1.1/line-area-chart-stats', 'Workspace daily stats', (req) => {
    const a = auth(req);
    return { data: dailySeries(ctx, { workspaceId: a.workspaceId }, parse(rangeQ, req.query).days) };
  }, { query: rangeQ });

  // ---- events ----
  const ev = defineRoutes(app, 'Events');
  const evQ = pageQuery.extend({ type: z.string().optional(), campaign_id: z.coerce.number().int().optional() });
  ev.get('/api/events', 'Activity log (last 10 days)', (req) => {
    const a = auth(req);
    const q = parse(evQ, req.query);
    const where = ['workspace_id = ?', 'created_at >= ?'];
    const params: any[] = [a.workspaceId, new Date(ctx.now().getTime() - 10 * 86_400_000).toISOString()];
    if (q.type) { where.push('type = ?'); params.push(q.type); }
    if (q.campaign_id) { where.push('campaign_id = ?'); params.push(q.campaign_id); }
    return paginate(ctx, `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC`, params, q, (e) => ({ ...e, name: EVENT_TYPES[e.type as EventType] ?? e.type, data: JSON.parse(e.data) }));
  }, { query: evQ });

  // ---- settings & tools ----
  const se = defineRoutes(app, 'Settings');
  se.get('/api/settings/integrations', 'OAuth app and integration settings', (req) => {
    requireAdmin(req);
    const has = (k: string) => !!getSetting(db, k);
    return {
      data: {
        google_client_id: getSetting(db, 'google_client_id') ?? '', google_client_secret_set: has('google_client_secret'),
        microsoft_client_id: getSetting(db, 'microsoft_client_id') ?? '', microsoft_client_secret_set: has('microsoft_client_secret'),
        microsoft_tenant: getSetting(db, 'microsoft_tenant') ?? 'common',
        oauth_redirect_uri: `${ctx.config.publicUrl}/oauth/callback`,
        public_url: ctx.config.publicUrl,
      },
    };
  });
  const integBody = z.object({
    google_client_id: z.string().optional(), google_client_secret: z.string().optional(),
    microsoft_client_id: z.string().optional(), microsoft_client_secret: z.string().optional(), microsoft_tenant: z.string().optional(),
  });
  se.put('/api/settings/integrations', 'Save OAuth app settings', (req) => {
    requireAdmin(req);
    const b = parse(integBody, req.body);
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (k.endsWith('_secret') && v === '') continue; // blank secret field = keep current
      setSetting(db, k, v.trim(), { secret: k.endsWith('_secret') });
    }
    return { data: { success: true } };
  }, { body: integBody });
  const domainBody = z.object({ domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'is invalid') });
  se.post('/api/tools/domain-check', 'Check DNS setup of any domain', async (req) => {
    auth(req);
    return { data: await checkDomain(parse(domainBody, req.body).domain) };
  }, { body: domainBody });
  se.get('/api/system', 'System information', (req) => {
    auth(req);
    return { data: { version: '0.1.0', public_url: ctx.config.publicUrl, workers: ctx.config.workers, data_dir: ctx.config.dataDir } };
  });
}

function sampleData(type: EventType): Record<string, unknown> {
  const lead = { lead_id: 42, lead_email: 'jane@acme.com' };
  const sender = { sender_email_id: 7, sender_email: 'alex@yourdomain.com' };
  switch (type) {
    case 'EMAIL_SENT': case 'LEAD_FIRST_CONTACTED':
      return { scheduled_email_id: 101, sent_email_id: 555, campaign_id: 3, campaign_name: 'Q4 outreach', ...lead, ...sender, sequence_step_id: 9, step_order: 1, subject: 'Quick question' };
    case 'LEAD_REPLIED': case 'LEAD_INTERESTED': case 'UNTRACKED_REPLY_RECEIVED':
      return { reply_id: 77, from_email: 'jane@acme.com', from_name: 'Jane Doe', subject: 'Re: Quick question', text_body: 'Sounds interesting, can we talk Tuesday?', category: 'interested', interested: true, automated: false, campaign_id: 3, ...lead, ...sender, received_at: new Date().toISOString() };
    case 'LEAD_UNSUBSCRIBED': return { ...lead, source: 'link' };
    case 'EMAIL_OPENED': case 'LINK_CLICKED': return { sent_email_id: 555, campaign_id: 3, ...lead, url: type === 'LINK_CLICKED' ? 'https://example.com' : undefined };
    case 'EMAIL_BOUNCED': return { sent_email_id: 555, campaign_id: 3, ...lead, ...sender, diagnostic: '550 5.1.1 The email account that you tried to reach does not exist.' };
    case 'MANUAL_EMAIL_SENT': return { sent_email_id: 556, ...sender, to: ['jane@acme.com'], subject: 'Re: Quick question', lead_id: 42 };
    case 'EMAIL_ACCOUNT_ADDED': case 'EMAIL_ACCOUNT_RECONNECTED': return { ...sender, email: sender.sender_email };
    case 'EMAIL_ACCOUNT_DISCONNECTED': return { ...sender, email: sender.sender_email, error: 'Invalid credentials' };
    case 'TAG_ATTACHED': case 'TAG_REMOVED': return { tag_id: 1, tag_name: 'Interested', taggable_id: 20, taggable_type: 'Campaign' };
    case 'CAMPAIGN_COMPLETED': return { campaign_id: 3, campaign_name: 'Q4 outreach' };
    case 'SIGNAL_CHANGED': return { table: { id: 4, name: 'Target accounts' }, row: { id: 18, label: 'Acme' }, column: { id: 31, name: 'Hiring (open roles)', kind: 'hiring' }, from: 12, to: 19 };
    case 'WEBSITE_VISIT': return { site: 'yourdomain.com', session_id: 900, landing_url: 'https://yourdomain.com/pricing', referrer: null, company: { name: 'Acme', domain: 'acme.com' }, ...lead };
    case 'HIGH_INTENT_VISIT': return { site: 'yourdomain.com', score: 72, reason: 'known_lead', text: 'High-intent visit on yourdomain.com: Jane Doe (Acme) — score 72', company: { id: 5, name: 'Acme', domain: 'acme.com', visits: 3, pageviews: 9, score: 72 }, person: { email: 'jane@acme.com', name: 'Jane Doe', lead_id: 42, visits: 3, score: 72 }, top_pages: [{ path: '/pricing', views: 3 }] };
    case 'AB_TEST_WINNER': return { decision_id: 5, campaign_id: 3, campaign_name: 'Q4 outreach', step_order: 1, winner_step_id: 10, winner_variant: 'B', decided_by: 'auto', metric: 'reply_rate', p_value: 0.012, confidence: 0.988, deactivated_step_ids: [9], variants: [{ id: 9, variant: 'A', sent: 120, metric_rate: 2.5 }, { id: 10, variant: 'B', sent: 118, metric_rate: 7.63 }] };
    case 'LEAD_MEETING_REQUEST': return { reply_id: 77, ...lead, from_email: 'jane@acme.com', subject: 'Re: Quick question', campaign_id: 3, label: 'meeting_request', source: 'ai', summary: 'Wants a call on Tuesday afternoon.', next_action: 'Send two Tuesday afternoon slots.' };
    case 'LEAD_OUT_OF_OFFICE': return { reply_id: 78, ...lead, from_email: 'jane@acme.com', subject: 'Out of office', campaign_id: 3, label: 'out_of_office', source: 'ai', summary: 'Away until October 20.', return_date: '2026-10-20', paused_until: '2026-10-20T08:00:00.000Z' };
    case 'LINKEDIN_CONNECTION_ACCEPTED': case 'LINKEDIN_REPLY_RECEIVED': return { linkedin_campaign: { id: 2, name: 'Founders Q4' }, lead: { id: 9, profile_url: 'https://www.linkedin.com/in/jane-doe/', full_name: 'Jane Doe', state: type === 'LINKEDIN_REPLY_RECEIVED' ? 'replied' : 'accepted' }, ...(type === 'LINKEDIN_REPLY_RECEIVED' ? { message: 'Thanks — happy to chat next week.' } : {}) };
    case 'LINKEDIN_POST_ENGAGER': return { automation: { id: 5, name: 'Competitor posts' }, post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000000/', engager: { fullName: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe/', engagement: 'comment', commentText: 'Great point!' } };
    case 'COMPANION_JOB_COMPLETED': return { automation: { id: 5, name: 'Head of Growth search', phantom: 'linkedin.search_export' }, run: { id: 12, status: 'completed', results: 240, new_results: 37, error: null }, table_id: 4 };
  }
}
