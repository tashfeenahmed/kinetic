import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, badRequest, canWrite, defineRoutes, idParam, notFound, parse } from '../http.ts';
import { applyActions, cloudflare, findZone, makePlan, trackingTarget, verifyDomain } from '../domains/service.ts';
import type { DomainSetup } from '../domains/plan.ts';

const domainRe = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const setupBody = z.object({
  domain: z.string().trim().toLowerCase().regex(domainRe, 'is not a valid domain'),
  provider: z.enum(['google', 'microsoft', 'other']),
  verification: z.string().trim().max(500).optional(),
  dkimValue: z.string().trim().max(3000).optional(),
  dkimSelector: z.string().trim().max(63).optional(),
  msDkim1: z.string().trim().max(300).optional(),
  msDkim2: z.string().trim().max(300).optional(),
  otherMx: z.array(z.string().trim()).max(10).optional(),
  otherSpfInclude: z.string().trim().max(200).optional(),
  dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).default('none'),
  dmarcReportEmail: z.string().trim().email().optional().or(z.literal('')),
  trackingSubdomain: z.string().trim().max(63).regex(/^[a-z0-9-]*$/i, 'letters, digits and dashes only').optional(),
  redirectTo: z.string().trim().url().optional().or(z.literal('')),
  replaceMx: z.boolean().default(true),
});

function row(r: any) {
  return { ...r, setup: JSON.parse(r.setup || '{}'), last_result: r.last_result ? JSON.parse(r.last_result) : null, report: r.report ? JSON.parse(r.report) : null };
}

export function domainRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const r = defineRoutes(app, 'Sending Domains');
  const needCf = () => {
    const cf = cloudflare(ctx);
    if (!cf) throw badRequest('Connect Cloudflare first: add an API token on the Integrations page (or on the Domains page).');
    return cf;
  };

  r.get('/api/domains', 'List sending domains with mailbox counts and DNS status', (req) => {
    const a = auth(req);
    const domains = db.all('SELECT * FROM sending_domains WHERE workspace_id = ? ORDER BY domain', [a.workspaceId]).map(row);
    // Domains that have mailboxes but weren't set up here still show, so every sending domain is visible.
    const senders = db.all(`SELECT lower(substr(email, instr(email, '@') + 1)) AS domain, COUNT(*) AS n,
      SUM(CASE WHEN status = 'Connected' THEN 1 ELSE 0 END) AS connected FROM sender_emails WHERE workspace_id = ? GROUP BY 1`, [a.workspaceId]);
    const byDomain = new Map(senders.map((s) => [s.domain, s]));
    const list = domains.map((d) => ({ ...d, mailboxes: byDomain.get(d.domain.toLowerCase())?.n ?? 0, connected_mailboxes: byDomain.get(d.domain.toLowerCase())?.connected ?? 0 }));
    for (const s of senders) if (!domains.some((d) => d.domain.toLowerCase() === s.domain)) list.push({ id: null, domain: s.domain, status: 'unmanaged', mailboxes: s.n, connected_mailboxes: s.connected, setup: {}, report: null } as any);
    return { data: list, meta: { cloudflare_connected: !!cloudflare(ctx), tracking_target: trackingTarget(ctx) } };
  });

  r.get('/api/domains/cloudflare', 'Cloudflare connection status and zones', async (req) => {
    const a = auth(req);
    const cf = cloudflare(ctx);
    if (!cf) return { data: { connected: false, zones: [] } };
    try {
      await cf.verifyToken();
      const zones = await cf.zones();
      const added = new Set(db.all('SELECT lower(domain) d FROM sending_domains WHERE workspace_id = ?', [a.workspaceId]).map((x) => x.d));
      return { data: { connected: true, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, name_servers: z.name_servers ?? [], added: added.has(z.name.toLowerCase()) })) } };
    } catch (e: any) {
      return { data: { connected: false, error: e.message, zones: [] } };
    }
  });

  const zoneBody = z.object({ domain: z.string().trim().toLowerCase().regex(domainRe, 'is not a valid domain') });
  r.post('/api/domains/cloudflare/zones', 'Add a domain to Cloudflare', async (req) => {
    canWrite(req);
    const b = parse(zoneBody, req.body);
    const cf = needCf();
    const existing = await findZone(cf, b.domain);
    if (existing) return { data: existing };
    const accounts = await cf.accounts();
    if (!accounts.length) throw badRequest('The Cloudflare token can’t see any account. Give it "Account Settings: Read" and "Zone: Edit" permissions.');
    return { data: await cf.createZone(b.domain, accounts[0]!.id) };
  }, { body: zoneBody });

  r.post('/api/domains/plan', 'Preview the DNS changes for a domain', async (req) => {
    canWrite(req);
    const s = parse(setupBody, req.body) as DomainSetup;
    const p = await makePlan(ctx, needCf(), s);
    return { data: { zone: { id: p.zone.id, name: p.zone.name, status: p.zone.status, name_servers: p.zone.name_servers ?? [] }, actions: p.actions, notes: p.notes } };
  }, { body: setupBody });

  r.post('/api/domains/apply', 'Apply DNS records for a sending domain through Cloudflare', async (req) => {
    const a = canWrite(req);
    const s = parse(setupBody, req.body) as DomainSetup;
    const cf = needCf();
    const p = await makePlan(ctx, cf, s);
    const results = await applyActions(cf, p.zone.id, p.actions);
    const notes = [...p.notes];
    if (s.redirectTo) {
      try { await cf.setRedirect(p.zone.id, s.domain, s.redirectTo); }
      catch (e: any) { notes.push(`Website redirect not set: ${e.message}. Give the token "Zone: Dynamic Redirect: Edit" (or add a redirect rule in Cloudflare).`); }
    }
    const target = trackingTarget(ctx);
    const trackingHost = s.trackingSubdomain && target ? `${s.trackingSubdomain}.${s.domain}` : null;
    if (trackingHost && !db.get('SELECT 1 FROM custom_tracking_domains WHERE workspace_id = ? AND domain = ?', [a.workspaceId, trackingHost])) {
      db.insert('custom_tracking_domains', { workspace_id: a.workspaceId, domain: trackingHost });
    }
    const report = await verifyDomain(s.domain, trackingHost);
    const failed = results.filter((x) => !x.ok);
    const status = failed.length ? 'attention' : report.ok ? 'verified' : 'configured';
    const now = new Date().toISOString();
    const existing = db.get('SELECT id FROM sending_domains WHERE workspace_id = ? AND domain = ?', [a.workspaceId, s.domain]);
    const data = { zone_id: p.zone.id, provider: s.provider, setup: JSON.stringify(s), status, last_result: JSON.stringify({ results, notes }), report: JSON.stringify(report), applied_at: now, checked_at: now };
    const id = existing ? (db.update('sending_domains', existing.id, data), existing.id) : db.insert('sending_domains', { workspace_id: a.workspaceId, domain: s.domain, ...data });
    if (trackingHost && report.tracking?.ok) db.run(`UPDATE custom_tracking_domains SET status = 'verified' WHERE workspace_id = ? AND domain = ?`, [a.workspaceId, trackingHost]);
    return { data: { ...row(db.get('SELECT * FROM sending_domains WHERE id = ?', [id])), results, notes } };
  }, { body: setupBody });

  r.post('/api/domains/:id/check', 'Re-check a domain’s DNS', async (req) => {
    const a = canWrite(req);
    const d = db.get('SELECT * FROM sending_domains WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!d) throw notFound('domain');
    const setup = JSON.parse(d.setup || '{}');
    const target = trackingTarget(ctx);
    const report = await verifyDomain(d.domain, setup.trackingSubdomain && target ? `${setup.trackingSubdomain}.${d.domain}` : null);
    const status = d.status === 'attention' ? 'attention' : report.ok ? 'verified' : 'configured';
    db.update('sending_domains', d.id, { report: JSON.stringify(report), status, checked_at: new Date().toISOString() });
    return { data: row(db.get('SELECT * FROM sending_domains WHERE id = ?', [d.id])) };
  });

  r.post('/api/domains/check', 'Check DNS for any domain (no Cloudflare needed)', async (req) => {
    auth(req);
    const b = parse(zoneBody, req.body);
    return { data: await verifyDomain(b.domain) };
  }, { body: zoneBody });

  r.delete('/api/domains/:id', 'Stop managing a domain (DNS records stay in Cloudflare)', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM sending_domains WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('domain');
    return { data: { success: true } };
  });
}
