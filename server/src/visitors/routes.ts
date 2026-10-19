/** Website visitors API: public snippet + collect endpoint, sites, companies, people, feed, push, settings. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { LIKE_ESCAPE, contains } from '../lib/like.ts';
import { auth, badRequest, canWrite, defineRoutes, idParam, notFound, paginate, parse } from '../http.ts';
import { isIP } from 'node:net';
import { trackerScript } from './script.ts';
import {
  clientIp, collect, collectUrl, companySummary, DEFAULT_KEY_PAGES, getVisitorSettings, lookupIp, newSiteKey, PERSON_SELECT, personSummary,
  publicUrlStatus, pushCompanies, saveVisitorSettings, signLeadToken, siteByKey, siteView, verifySite, visitStats,
} from './service.ts';
import { registerVisitorSignal } from './signal.ts';

const collectBody = z.object({
  k: z.string().min(1).max(64),
  t: z.enum(['pv', 'leave', 'click', 'id']),
  sid: z.string().min(4).max(64),
  vid: z.string().max(64).optional(),
  u: z.string().max(4000).optional(),
  ti: z.string().max(1000).optional(),
  r: z.string().max(4000).optional(),
  d: z.coerce.number().optional(),
  h: z.string().max(4000).optional(),
  x: z.string().max(500).optional(),
  em: z.string().max(320).optional(),
  kv: z.string().max(100).nullable().optional(),
});

const siteBody = z.object({
  domain: z.string().min(3).max(253),
  name: z.string().max(200).optional(),
  key_pages: z.array(z.string().min(1).max(200)).max(50).optional(),
});

const settingsBody = z.object({
  respect_dnt: z.boolean().optional(),
  retention_days: z.number().int().min(30).max(3650).optional(),
  alert_threshold: z.number().int().min(1).max(100).optional(),
  alert_on: z.enum(['targets', 'all', 'off']).optional(),
  alert_slack: z.boolean().optional(),
  alert_webhook_url: z.string().url().nullable().or(z.literal('')).optional(),
  target_domains: z.array(z.string().max(253)).max(5000).optional(),
  auto_push_table_id: z.number().int().positive().nullable().optional(),
  auto_push_score: z.number().int().min(1).max(100).nullable().optional(),
});

const pushBody = z.object({
  company_ids: z.array(z.number().int().positive()).max(5000).optional(),
  min_score: z.number().int().min(0).max(100).optional(),
  days: z.number().int().min(1).max(365).optional(),
  table_id: z.number().int().positive().nullable().optional(),
  table_name: z.string().max(200).optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  site_id: z.coerce.number().int().positive().optional(),
});

function cors(req: FastifyRequest, reply: FastifyReply) {
  const origin = req.headers.origin;
  reply.header('access-control-allow-origin', origin && origin !== 'null' ? origin : '*');
  reply.header('vary', 'Origin');
  reply.header('access-control-allow-methods', 'POST, OPTIONS');
  reply.header('access-control-allow-headers', 'content-type');
  reply.header('access-control-max-age', '86400');
}

function cleanSiteDomain(d: string): string {
  const s = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw badRequest('Enter a domain like acme.com');
  return s;
}

export function visitorRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  registerVisitorSignal(ctx);
  const r = defineRoutes(app, 'Website visitors');
  const siteOf = (req: FastifyRequest, ws: number) => {
    const s = db.get('SELECT * FROM visitor_sites WHERE id = ? AND workspace_id = ?', [idParam(req), ws]);
    if (!s) throw notFound('Site');
    return s;
  };

  // ---------- public: snippet + collect ----------
  app.get('/v.js', { config: { public: true } }, (req, reply) => {
    const k = String((req.query as any)?.k ?? '');
    const site = k ? siteByKey(ctx, k) : null;
    reply.header('content-type', 'application/javascript; charset=utf-8').header('access-control-allow-origin', '*');
    if (!site) return reply.code(404).send('/* Kinetic: unknown site key */');
    reply.header('cache-control', 'public, max-age=3600');
    return trackerScript({ endpoint: collectUrl(ctx), siteKey: site.site_key, respectDnt: getVisitorSettings(ctx, site.workspace_id).respect_dnt });
  });

  app.options('/api/v/collect', { config: { public: true } }, (req, reply) => {
    cors(req, reply);
    return reply.code(204).send();
  });

  r.post('/api/v/collect', 'Collect a website visitor event (public, called by the tracking snippet)', (req, reply) => {
    cors(req, reply);
    let raw: unknown = req.body;
    if (typeof raw === 'string') {
      if (raw.length > 16_000) return reply.code(413).send();
      try { raw = JSON.parse(raw); } catch { return reply.code(400).send({ error: 'bad_request', message: 'Invalid JSON' }); }
    }
    const body = collectBody.safeParse(raw);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Invalid event' });
    const h = req.headers;
    const ip = clientIp(h, req.ip);
    const res = collect(ctx, body.data, {
      ip: isIP(ip) ? ip : req.ip,
      ua: h['user-agent'],
      origin: h.origin,
      dnt: h.dnt === '1' || h['sec-gpc'] === '1',
    });
    if (res.status === 'rejected') return reply.code(res.code).send({ error: res.code === 429 ? 'rate_limited' : 'rejected', message: res.reason });
    return reply.code(204).send();
  }, { body: collectBody, public: true });

  // ---------- overview & settings ----------
  r.get('/api/visitors/overview', 'Website visitors overview: totals, tracking URL status and setup notice', (req) => {
    const ws = auth(req).workspaceId;
    const day = new Date(ctx.now().getTime() - 86_400_000).toISOString();
    const week = new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString();
    const n = (sql: string, p: any[]) => db.get<{ n: number }>(sql, p)!.n;
    const settings = getVisitorSettings(ctx, ws);
    return {
      tracking: publicUrlStatus(ctx),
      sites: n('SELECT COUNT(*) n FROM visitor_sites WHERE workspace_id = ?', [ws]),
      sessions_24h: n('SELECT COUNT(*) n FROM visitor_sessions WHERE workspace_id = ? AND started_at >= ?', [ws, day]),
      sessions_7d: n('SELECT COUNT(*) n FROM visitor_sessions WHERE workspace_id = ? AND started_at >= ?', [ws, week]),
      companies_7d: n('SELECT COUNT(*) n FROM visitor_companies WHERE workspace_id = ? AND last_seen_at >= ?', [ws, week]),
      people_7d: n('SELECT COUNT(*) n FROM visitor_people WHERE workspace_id = ? AND last_seen_at >= ?', [ws, week]),
      high_intent: n('SELECT COUNT(*) n FROM visitor_companies WHERE workspace_id = ? AND score >= ?', [ws, settings.alert_threshold]),
      identified_rate: (() => {
        const t = n('SELECT COUNT(*) n FROM visitor_sessions WHERE workspace_id = ? AND started_at >= ?', [ws, week]);
        const i = n('SELECT COUNT(*) n FROM visitor_sessions WHERE workspace_id = ? AND started_at >= ? AND (company_id IS NOT NULL OR person_id IS NOT NULL)', [ws, week]);
        return t ? Math.round((i / t) * 100) : 0;
      })(),
      settings,
    };
  });

  r.get('/api/visitors/settings', 'Website visitor settings (alerts, retention, Do-Not-Track, auto-push)', (req) => getVisitorSettings(ctx, auth(req).workspaceId));

  r.put('/api/visitors/settings', 'Update website visitor settings', (req) => {
    const a = canWrite(req);
    const b = parse(settingsBody, req.body);
    if (b.auto_push_table_id && !db.get('SELECT 1 FROM gtm_tables WHERE id = ? AND workspace_id = ?', [b.auto_push_table_id, a.workspaceId])) throw badRequest('Table not found in this workspace');
    return saveVisitorSettings(ctx, a.workspaceId, { ...b, alert_webhook_url: b.alert_webhook_url || null } as any);
  }, { body: settingsBody });

  // ---------- sites ----------
  r.get('/api/visitors/sites', 'List tracked websites with install snippets', (req) => {
    const ws = auth(req).workspaceId;
    return { data: db.all('SELECT * FROM visitor_sites WHERE workspace_id = ? ORDER BY id', [ws]).map((s) => siteView(ctx, s)), tracking: publicUrlStatus(ctx) };
  });

  r.post('/api/visitors/sites', 'Add a tracked website (returns the install snippet)', (req) => {
    const a = canWrite(req);
    const b = parse(siteBody, req.body);
    const domain = cleanSiteDomain(b.domain);
    if (db.get('SELECT 1 FROM visitor_sites WHERE workspace_id = ? AND domain = ?', [a.workspaceId, domain])) throw badRequest(`${domain} is already tracked`);
    const id = db.insert('visitor_sites', { workspace_id: a.workspaceId, domain, name: b.name ?? domain, site_key: newSiteKey(), key_pages: JSON.stringify(b.key_pages ?? DEFAULT_KEY_PAGES) });
    return siteView(ctx, db.get('SELECT * FROM visitor_sites WHERE id = ?', [id])!);
  }, { body: siteBody });

  r.patch('/api/visitors/sites/:id', 'Update a tracked website (name, domain, key pages)', (req) => {
    const a = canWrite(req);
    const s = siteOf(req, a.workspaceId);
    const b = parse(siteBody.partial(), req.body);
    const patch: Record<string, unknown> = {};
    if (b.domain) patch.domain = cleanSiteDomain(b.domain);
    if (b.name !== undefined) patch.name = b.name;
    if (b.key_pages) patch.key_pages = JSON.stringify(b.key_pages);
    db.update('visitor_sites', s.id, patch);
    return siteView(ctx, db.get('SELECT * FROM visitor_sites WHERE id = ?', [s.id])!);
  }, { body: siteBody.partial() });

  r.delete('/api/visitors/sites/:id', 'Stop tracking a website and delete its sessions', (req) => {
    const a = canWrite(req);
    db.run('DELETE FROM visitor_sites WHERE id = ?', [siteOf(req, a.workspaceId).id]);
    return { ok: true };
  });

  r.post('/api/visitors/sites/:id/verify', 'Verify the snippet is installed (recent event or snippet found in the page HTML)', async (req) => {
    const a = canWrite(req);
    return verifySite(ctx, siteOf(req, a.workspaceId));
  });

  // ---------- companies ----------
  r.get('/api/visitors/companies', 'List companies that visited your websites, highest intent first', (req) => {
    const ws = auth(req).workspaceId;
    const q = parse(listQuery, req.query);
    const params: any[] = [ws];
    let sql = 'SELECT * FROM visitor_companies WHERE workspace_id = ?';
    if (q.search) { sql += ` AND (name LIKE ? ${LIKE_ESCAPE} OR domain LIKE ? ${LIKE_ESCAPE})`; params.push(contains(q.search), contains(q.search)); }
    if (q.min_score != null) { sql += ' AND score >= ?'; params.push(q.min_score); }
    if (q.days) { sql += ' AND last_seen_at >= ?'; params.push(new Date(ctx.now().getTime() - q.days * 86_400_000).toISOString()); }
    if (q.site_id) { sql += ' AND id IN (SELECT company_id FROM visitor_sessions WHERE site_id = ? AND company_id IS NOT NULL)'; params.push(q.site_id); }
    sql += ' ORDER BY score DESC, last_seen_at DESC';
    return paginate(ctx, sql, params, q, (c) => companySummary(ctx, c));
  }, { query: listQuery });

  r.get('/api/visitors/companies/:id', 'Company visit detail with a session timeline', (req) => {
    const ws = auth(req).workspaceId;
    const c = db.get('SELECT * FROM visitor_companies WHERE id = ? AND workspace_id = ?', [idParam(req), ws]);
    if (!c) throw notFound('Company');
    const sessions = db.all(`SELECT s.*, st.domain AS site_domain, p.email AS person_email, l.first_name, l.last_name FROM visitor_sessions s
      JOIN visitor_sites st ON st.id = s.site_id LEFT JOIN visitor_people p ON p.id = s.person_id LEFT JOIN leads l ON l.id = p.lead_id
      WHERE s.company_id = ? ORDER BY s.started_at DESC LIMIT 50`, [c.id]);
    const events = sessions.length ? db.all(`SELECT id, session_id, type, url, path, title, duration_s, data, created_at FROM visitor_events WHERE session_id IN (${sessions.map(() => '?').join(',')}) ORDER BY id`, sessions.map((s) => s.id)) : [];
    return {
      ...companySummary(ctx, c),
      profile_raw: c.profile ? JSON.parse(c.profile) : null,
      sessions: sessions.map((s) => ({
        id: s.id, site: s.site_domain, started_at: s.started_at, last_seen_at: s.last_seen_at, pageviews: s.pageviews, key_pages: s.key_pages, duration_s: s.duration_s,
        score: s.score, landing_url: s.landing_url, referrer: s.referrer || null, utm: { source: s.utm_source, medium: s.utm_medium, campaign: s.utm_campaign },
        person: s.person_email ? { email: s.person_email, name: [s.first_name, s.last_name].filter(Boolean).join(' ') || null } : null,
        paths: JSON.parse(s.paths || '{}'),
        events: events.filter((e) => e.session_id === s.id).map((e) => ({ type: e.type, path: e.path, url: e.url, title: e.title, duration_s: e.duration_s, at: e.created_at, data: JSON.parse(e.data || '{}') })),
      })),
    };
  });

  // ---------- people ----------
  r.get('/api/visitors/people', 'List identified people (leads who clicked through from email or were identified on the site)', (req) => {
    const ws = auth(req).workspaceId;
    const q = parse(listQuery, req.query);
    const params: any[] = [ws];
    let sql = `${PERSON_SELECT} WHERE p.workspace_id = ?`;
    if (q.search) { sql += ` AND (p.email LIKE ? ${LIKE_ESCAPE} OR l.first_name LIKE ? ${LIKE_ESCAPE} OR l.last_name LIKE ? ${LIKE_ESCAPE} OR c.name LIKE ? ${LIKE_ESCAPE})`; params.push(...Array(4).fill(contains(q.search))); }
    if (q.min_score != null) { sql += ' AND p.score >= ?'; params.push(q.min_score); }
    if (q.days) { sql += ' AND p.last_seen_at >= ?'; params.push(new Date(ctx.now().getTime() - q.days * 86_400_000).toISOString()); }
    sql += ' ORDER BY p.last_seen_at DESC';
    return paginate(ctx, sql, params, q, (p) => personSummary(ctx, p));
  }, { query: listQuery });

  // ---------- live feed ----------
  const feedQuery = z.object({ after_id: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
  r.get('/api/visitors/feed', 'Live feed of recent website events (pass after_id to poll for new ones)', (req) => {
    const ws = auth(req).workspaceId;
    const q = parse(feedQuery, req.query);
    const rows = db.all(`SELECT e.id, e.type, e.path, e.url, e.title, e.duration_s, e.created_at, s.id AS session_id, s.org_status, s.org_name, s.referrer, s.utm_source,
        st.domain AS site, c.id AS company_id, c.name AS company_name, c.domain AS company_domain, c.score AS company_score,
        p.id AS person_id, p.email AS person_email, l.first_name, l.last_name
      FROM visitor_events e JOIN visitor_sessions s ON s.id = e.session_id JOIN visitor_sites st ON st.id = s.site_id
      LEFT JOIN visitor_companies c ON c.id = s.company_id LEFT JOIN visitor_people p ON p.id = s.person_id LEFT JOIN leads l ON l.id = p.lead_id
      WHERE e.workspace_id = ? AND e.id > ? ORDER BY e.id DESC LIMIT ?`, [ws, q.after_id ?? 0, q.limit]);
    return {
      data: rows.map((e) => ({
        id: e.id, type: e.type, path: e.path, url: e.url, title: e.title, duration_s: e.duration_s, at: e.created_at, site: e.site, session_id: e.session_id,
        company: e.company_id ? { id: e.company_id, name: e.company_name, domain: e.company_domain, score: e.company_score } : null,
        person: e.person_id ? { id: e.person_id, email: e.person_email, name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null } : null,
        network: e.company_id ? null : { status: e.org_status, name: e.org_name },
        referrer: e.referrer || null, utm_source: e.utm_source,
      })),
    };
  }, { query: feedQuery });

  // ---------- lookups & actions ----------
  const statsQuery = z.object({ domain: z.string().optional(), email: z.string().optional() });
  r.get('/api/visitors/lookup', 'Website visit stats for a company domain or lead email (last visit, visits in 30 days, pages, score)', (req) => {
    const ws = auth(req).workspaceId;
    const q = parse(statsQuery, req.query);
    if (!q.domain && !q.email) throw badRequest('Pass domain or email');
    return visitStats(ctx, ws, q);
  }, { query: statsQuery });

  r.post('/api/visitors/push', 'Send visiting companies to a table (new or existing); skips domains already in it', (req) => {
    const a = canWrite(req);
    const b = parse(pushBody, req.body);
    if (!b.company_ids?.length && b.min_score == null && !b.days) throw badRequest('Pass company_ids, min_score or days');
    try {
      return pushCompanies(ctx, a.workspaceId, { companyIds: b.company_ids, minScore: b.min_score, days: b.days, tableId: b.table_id, tableName: b.table_name });
    } catch (e: any) {
      if (e?.status) throw e;
      throw badRequest(e?.message ?? 'Push failed');
    }
  }, { body: pushBody });

  const ipBody = z.object({ ip: z.string().min(2).max(64) });
  r.post('/api/visitors/resolve-ip', 'Look up which organisation an IP belongs to (reverse DNS, RDAP, IPinfo; ISPs/cloud filtered)', async (req) => {
    auth(req);
    const b = parse(ipBody, req.body);
    if (!isIP(b.ip)) throw badRequest('Not an IP address');
    return lookupIp(ctx, b.ip);
  }, { body: ipBody });

  const tokenBody = z.object({ lead_id: z.number().int().positive(), url: z.string().url().optional() });
  r.post('/api/visitors/lead-link', 'Build a personal tracked link for a lead (adds the signed k_vid parameter)', (req) => {
    const a = canWrite(req);
    const b = parse(tokenBody, req.body);
    if (!db.get('SELECT 1 FROM leads WHERE id = ? AND workspace_id = ?', [b.lead_id, a.workspaceId])) throw notFound('Lead');
    const token = signLeadToken(ctx, a.workspaceId, b.lead_id);
    let url: string | null = null;
    if (b.url) { const u = new URL(b.url); u.searchParams.set('k_vid', token); url = u.toString(); }
    return { k_vid: token, url };
  }, { body: tokenBody });
}
