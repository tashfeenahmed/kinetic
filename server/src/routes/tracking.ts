/** Public endpoints hit by recipients: open pixel, click redirect, unsubscribe page. */
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { emit } from '../events.ts';
import { signUrl } from '../engine/compose.ts';
import { unsubscribeLead } from '../engine/inbox.ts';
import { escapeHtml } from '../lib/html.ts';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Mail scanners prefetch links and images right after delivery; ignore hits within this window. */
const SCANNER_WINDOW_MS = 20_000;

export function trackingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const find = (token: string) => db.get('SELECT * FROM sent_emails WHERE tracking_token = ?', [token]);
  const isScanner = (sentAt: string, ua: string | undefined) =>
    ctx.now().getTime() - Date.parse(sentAt) < SCANNER_WINDOW_MS || /bot|crawler|scanner|barracuda|proofpoint|mimecast/i.test(ua ?? '');

  app.get('/t/o/:token', { config: { public: true } }, (req, reply) => {
    const s = find((req.params as any).token);
    if (s && !isScanner(s.sent_at, req.headers['user-agent'])) {
      const first = !s.first_opened_at;
      db.run('UPDATE sent_emails SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, ?) WHERE id = ?', [ctx.now().toISOString(), s.id]);
      if (first) emit(ctx, s.workspace_id, 'EMAIL_OPENED', { sent_email_id: s.id, campaign_id: s.campaign_id, lead_id: s.lead_id, lead_email: s.to_email }, { campaign_id: s.campaign_id, lead_id: s.lead_id, sent_email_id: s.id });
    }
    reply.header('content-type', 'image/gif').header('cache-control', 'no-store, max-age=0');
    return reply.send(PIXEL);
  });

  app.get('/t/c/:token', { config: { public: true } }, (req, reply) => {
    const { token } = req.params as any;
    const { u, s: sig } = req.query as Record<string, string>;
    if (!u || !/^https?:\/\//i.test(u) || sig !== signUrl(ctx, token, u)) return reply.code(400).send('Invalid link');
    const s = find(token);
    if (s && !isScanner(s.sent_at, req.headers['user-agent'])) {
      db.run('UPDATE sent_emails SET clicks = clicks + 1 WHERE id = ?', [s.id]);
      emit(ctx, s.workspace_id, 'LINK_CLICKED', { sent_email_id: s.id, campaign_id: s.campaign_id, lead_id: s.lead_id, lead_email: s.to_email, url: u }, { campaign_id: s.campaign_id, lead_id: s.lead_id, sent_email_id: s.id });
    }
    return reply.redirect(u);
  });

  const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:420px;width:100%;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#475569;margin:0 0 20px}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head><body><div class="card">${body}</div></body></html>`;

  app.get('/u/:token', { config: { public: true } }, (req, reply) => {
    const { token } = req.params as any;
    const s = find(token);
    reply.header('content-type', 'text/html; charset=utf-8');
    if (!s) return page('Unsubscribe', '<h1>Link expired</h1><p>This unsubscribe link is no longer valid.</p>');
    const lead = s.lead_id ? db.get('SELECT status FROM leads WHERE id = ?', [s.lead_id]) : null;
    if (lead?.status === 'unsubscribed') return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${escapeHtml(s.to_email)} will not receive further emails.</p>`);
    return page('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop receiving emails at ${escapeHtml(s.to_email)}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`);
  });

  // One-click (RFC 8058) and form submissions both land here.
  app.post('/u/:token', { config: { public: true } }, (req, reply) => {
    const s = find((req.params as any).token);
    if (s?.lead_id) {
      const lead = db.get('SELECT * FROM leads WHERE id = ?', [s.lead_id]);
      if (lead) unsubscribeLead(ctx, lead, 'link');
    }
    reply.header('content-type', 'text/html; charset=utf-8');
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${escapeHtml(s?.to_email ?? 'This address')} will not receive further emails.</p>`);
  });
}
