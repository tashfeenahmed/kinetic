import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, badRequest, bool, canWrite, defineRoutes, HttpError, idList, idParam, notFound, parse, requireAdmin } from '../http.ts';
import { decrypt, encrypt, randomToken } from '../lib/crypto.ts';
import { checkDomain, domainOf } from '../lib/dns.ts';
import { emit } from '../events.ts';
import { guessProvider, PRESETS } from '../mail/providers.ts';
import { authorizeUrl, exchangeCode, idTokenClaims, type OAuthProvider } from '../mail/oauth.ts';
import { getOAuthApp } from '../settings.ts';
import { newMessageId } from '../engine/compose.ts';
import { warmupStats } from '../engine/warmup.ts';
import { syncSender } from '../engine/inbox.ts';
import { tagsFor } from './tags.ts';

const SECRET_COLUMNS = ['secret_enc', 'oauth_access_token_enc'];

export function senderJson(ctx: Ctx, s: Row) {
  const { db } = ctx;
  const stats = db.get(
    `SELECT COUNT(*) AS emails_sent_count, COALESCE(SUM(opens),0) AS total_opened_count,
       COALESCE(SUM(CASE WHEN opens > 0 THEN 1 ELSE 0 END),0) AS unique_opened_count,
       COALESCE(SUM(bounced),0) AS bounced_count, COUNT(DISTINCT lead_id) AS total_leads_contacted_count
     FROM sent_emails WHERE sender_email_id = ? AND kind = 'campaign'`, [s.id])!;
  const replies = db.get(
    `SELECT COUNT(*) AS total_replied_count, COUNT(DISTINCT lead_id) AS unique_replied_count,
       COUNT(DISTINCT CASE WHEN interested = 1 THEN lead_id END) AS interested_leads_count,
       COUNT(DISTINCT CASE WHEN category = 'unsubscribe' THEN lead_id END) AS unsubscribed_count
     FROM replies WHERE sender_email_id = ? AND automated = 0 AND folder != 'bounced'`, [s.id])!;
  const today = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const sentToday = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sent_emails WHERE sender_email_id = ? AND sent_at >= ? AND kind = 'campaign'`, [s.id, today])!.n;
  const out: Row = { ...s };
  for (const c of SECRET_COLUMNS) delete out[c];
  return {
    ...out,
    type: 'Inbox',
    warmup_enabled: !!s.warmup_enabled,
    imap_secure: !!s.imap_secure,
    smtp_secure: !!s.smtp_secure,
    egress_route: s.egress_route_id ? db.get('SELECT id, name FROM egress_routes WHERE id = ?', [s.egress_route_id]) ?? null : null,
    sent_last_24h: sentToday,
    ...stats,
    ...replies,
    tags: tagsFor(ctx, 'sender_email', s.id),
  };
}

const senderInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().min(1),
  username: z.string().optional(),
  provider: z.enum(['google', 'microsoft', 'custom']).optional(),
  imap_server: z.string().trim().min(1).optional(),
  imap_port: z.coerce.number().int().positive().optional(),
  imap_secure: bool.optional(),
  smtp_server: z.string().trim().min(1).optional(),
  smtp_port: z.coerce.number().int().positive().optional(),
  smtp_secure: bool.optional(),
  email_signature: z.string().max(10_000).optional(),
  daily_limit: z.coerce.number().int().min(1).max(2000).optional(),
  egress_route_id: z.coerce.number().int().nullable().optional(),
  warmup_enabled: bool.optional(),
});
type SenderInput = z.infer<typeof senderInput>;

/** Fills provider presets and checks we have server details. */
function resolveServers(b: SenderInput) {
  const provider = b.provider ?? guessProvider(b.smtp_server ?? b.imap_server);
  const preset = provider !== 'custom' ? PRESETS[provider] : null;
  const s = {
    provider,
    imap_server: b.imap_server ?? preset?.imap_server,
    imap_port: b.imap_port ?? preset?.imap_port ?? 993,
    imap_secure: b.imap_secure ?? preset?.imap_secure ?? true,
    smtp_server: b.smtp_server ?? preset?.smtp_server,
    smtp_port: b.smtp_port ?? preset?.smtp_port ?? 465,
    smtp_secure: b.smtp_secure ?? preset?.smtp_secure ?? true,
  };
  if (!s.imap_server || !s.smtp_server) throw new HttpError(422, { error: 'validation_error', message: 'IMAP and SMTP servers are required for custom providers.', fields: { imap_server: ['is required'], smtp_server: ['is required'] } });
  return s;
}

function defaultTagFor(ctx: Ctx, workspaceId: number, provider: string): number | null {
  const name = provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : 'Custom';
  return ctx.db.get('SELECT id FROM tags WHERE workspace_id = ? AND name = ?', [workspaceId, name])?.id ?? null;
}

async function createSender(ctx: Ctx, workspaceId: number, b: SenderInput, verify: boolean): Promise<{ id?: number; error?: string }> {
  const { db } = ctx;
  if (db.get('SELECT 1 FROM sender_emails WHERE workspace_id = ? AND email = ?', [workspaceId, b.email])) return { error: 'already connected in this workspace' };
  const servers = resolveServers(b);
  const row: Row = {
    workspace_id: workspaceId, name: b.name, email: b.email, ...servers, auth_type: 'password',
    username: b.username || b.email, secret_enc: encrypt(b.password), email_signature: b.email_signature ?? '',
    daily_limit: b.daily_limit ?? 30, egress_route_id: b.egress_route_id ?? null,
    warmup_enabled: b.warmup_enabled ? 1 : 0, warmup_started_at: b.warmup_enabled ? ctx.now().toISOString() : null,
  };
  if (verify) {
    const r = await ctx.mail.verify({ ...row, id: 0 });
    if (r.smtp || r.imap) return { error: [r.smtp && `SMTP: ${r.smtp}`, r.imap && `IMAP: ${r.imap}`].filter(Boolean).join(' · ') };
  }
  const id = db.insert('sender_emails', row);
  const tagId = defaultTagFor(ctx, workspaceId, servers.provider);
  if (tagId) db.run('INSERT OR IGNORE INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)', [tagId, 'sender_email', id]);
  emit(ctx, workspaceId, 'EMAIL_ACCOUNT_ADDED', { sender_email_id: id, email: b.email, name: b.name }, { sender_email_id: id });
  return { id };
}

export function senderRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Email Accounts');
  const { db } = ctx;

  const getSender = (ws: number, id: number) => {
    const s = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!s) throw notFound('email account');
    return s;
  };

  const listQ = z.object({ search: z.string().optional(), status: z.enum(['Connected', 'Disconnected', 'Paused']).optional(), tag_id: z.coerce.number().int().optional() });
  r.get('/api/sender-emails', 'List email accounts', (req) => {
    const a = auth(req);
    const q = parse(listQ, req.query);
    const where = ['workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.search) { where.push('(email LIKE ? OR name LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.tag_id) { where.push(`EXISTS (SELECT 1 FROM taggables t WHERE t.taggable_type = 'sender_email' AND t.taggable_id = sender_emails.id AND t.tag_id = ?)`); params.push(q.tag_id); }
    return { data: db.all(`SELECT * FROM sender_emails WHERE ${where.join(' AND ')} ORDER BY email`, params).map((s) => senderJson(ctx, s)) };
  }, { query: listQ });

  r.get('/api/sender-emails/presets', 'Server presets for Google and Microsoft', () => ({ data: PRESETS }));

  r.post('/api/sender-emails/imap-smtp', 'Create IMAP/SMTP email account', async (req) => {
    const a = canWrite(req);
    const b = parse(senderInput.extend({ skip_verification: bool.default(false) }), req.body);
    const res = await createSender(ctx, a.workspaceId, b, !b.skip_verification);
    if (res.error) throw new HttpError(422, { error: 'connection_failed', message: res.error, fields: { email: [res.error] } });
    return { data: senderJson(ctx, getSender(a.workspaceId, res.id!)) };
  }, { body: senderInput });

  const bulkBody = z.object({ csv: z.string().optional(), accounts: z.array(z.any()).optional(), skip_verification: bool.default(false) });
  r.post('/api/sender-emails/bulk', 'Bulk add email accounts (CSV or JSON)', async (req) => {
    const a = canWrite(req);
    const b = parse(bulkBody, req.body);
    let rows: any[] = b.accounts ?? [];
    if (b.csv) {
      try {
        rows = parseCsv(b.csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')), skip_empty_lines: true, trim: true, bom: true });
      } catch (e: any) { throw badRequest(`Could not read CSV: ${e.message}`); }
    }
    if (!rows.length) throw badRequest('No accounts provided.');
    const results: { email: string; ok: boolean; error?: string; id?: number }[] = [];
    const queue = [...rows];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const raw = queue.shift();
        const p = senderInput.safeParse({ ...raw, name: raw.name ?? raw.from_name ?? raw.email });
        if (!p.success) { results.push({ email: String(raw?.email ?? ''), ok: false, error: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); continue; }
        try {
          const res = await createSender(ctx, a.workspaceId, p.data, !b.skip_verification);
          results.push({ email: p.data.email, ok: !res.error, error: res.error, id: res.id });
        } catch (e: any) {
          results.push({ email: p.data.email, ok: false, error: e.message });
        }
      }
    });
    await Promise.all(workers);
    return { data: { added: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results } };
  }, { body: bulkBody });

  r.get('/api/sender-emails/:id', 'Show email account details', (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    return { data: { ...senderJson(ctx, s), warmup: warmupStats(ctx, s.id, 7) } };
  });

  const updateBody = z.object({
    name: z.string().trim().min(1).optional(), daily_limit: z.coerce.number().int().min(1).max(2000).optional(),
    email_signature: z.string().max(10_000).optional(), egress_route_id: z.coerce.number().int().nullable().optional(),
    imap_server: z.string().optional(), imap_port: z.coerce.number().int().optional(), imap_secure: bool.optional(),
    smtp_server: z.string().optional(), smtp_port: z.coerce.number().int().optional(), smtp_secure: bool.optional(),
    username: z.string().optional(),
  });
  r.patch('/api/sender-emails/:id', 'Update email account', (req) => {
    const a = canWrite(req);
    const s = getSender(a.workspaceId, idParam(req));
    const b = parse(updateBody, req.body);
    if (b.egress_route_id && !db.get('SELECT 1 FROM egress_routes WHERE id = ?', [b.egress_route_id])) throw notFound('IP route');
    db.update('sender_emails', s.id, { ...b, updated_at: ctx.now().toISOString() });
    return { data: senderJson(ctx, getSender(a.workspaceId, s.id)) };
  }, { body: updateBody });

  const credBody = z.object({ password: z.string().min(1) });
  r.post('/api/sender-emails/:id/reconnect', 'Update password and reconnect', async (req) => {
    const a = canWrite(req);
    const s = getSender(a.workspaceId, idParam(req));
    const b = parse(credBody, req.body);
    const candidate = { ...s, secret_enc: encrypt(b.password), auth_type: 'password' };
    const v = await ctx.mail.verify(candidate);
    if (v.smtp || v.imap) throw new HttpError(422, { error: 'connection_failed', message: [v.smtp && `SMTP: ${v.smtp}`, v.imap && `IMAP: ${v.imap}`].filter(Boolean).join(' · ') });
    db.update('sender_emails', s.id, { secret_enc: candidate.secret_enc, auth_type: 'password', status: 'Connected', last_error: null, updated_at: ctx.now().toISOString() });
    if (s.status === 'Disconnected') emit(ctx, a.workspaceId, 'EMAIL_ACCOUNT_RECONNECTED', { sender_email_id: s.id, email: s.email }, { sender_email_id: s.id });
    return { data: senderJson(ctx, getSender(a.workspaceId, s.id)) };
  }, { body: credBody });

  r.post('/api/sender-emails/:id/test-connection', 'Test SMTP and IMAP connection', async (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    const v = await ctx.mail.verify(s);
    const ok = !v.smtp && !v.imap;
    if (ok && s.status === 'Disconnected') db.update('sender_emails', s.id, { status: 'Connected', last_error: null });
    return { data: { ok, smtp: v.smtp ?? 'ok', imap: v.imap ?? 'ok' } };
  });

  r.post('/api/sender-emails/:id/sync-now', 'Sync this mailbox now', async (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    const processed = await syncSender(ctx, s);
    return { data: { processed, sender: senderJson(ctx, getSender(a.workspaceId, s.id)) } };
  });

  for (const [action, status] of [['pause', 'Paused'], ['resume', 'Connected']] as const) {
    r.patch(`/api/sender-emails/:id/${action}`, `${action === 'pause' ? 'Pause' : 'Resume'} email account`, (req) => {
      const a = canWrite(req);
      const s = getSender(a.workspaceId, idParam(req));
      db.update('sender_emails', s.id, { status, updated_at: ctx.now().toISOString() });
      if (status === 'Paused') db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'sender paused' WHERE sender_email_id = ? AND status = 'scheduled'`, [s.id]);
      return { data: senderJson(ctx, getSender(a.workspaceId, s.id)) };
    });
  }

  r.delete('/api/sender-emails/:id', 'Delete email account', (req) => {
    const a = canWrite(req);
    const s = getSender(a.workspaceId, idParam(req));
    db.tx(() => {
      db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'sender deleted' WHERE sender_email_id = ? AND status = 'scheduled'`, [s.id]);
      db.run('DELETE FROM sender_emails WHERE id = ?', [s.id]);
      db.run(`DELETE FROM taggables WHERE taggable_type = 'sender_email' AND taggable_id = ?`, [s.id]);
    });
    return { data: { success: true } };
  });

  const testBody = z.object({ to_email: z.email() });
  r.post('/api/sender-emails/:id/send-test', 'Send a plain test email', async (req) => {
    const a = canWrite(req);
    const s = getSender(a.workspaceId, idParam(req));
    const b = parse(testBody, req.body);
    try {
      await ctx.mail.send(s, { from: { name: s.name, email: s.email }, to: b.to_email, subject: `Test email from ${s.name}`, text: `This is a test email sent from ${s.email} by Kinetic.\n\n${s.email_signature ?? ''}`.trim(), messageId: newMessageId(s.email) });
    } catch (e: any) {
      throw new HttpError(422, { error: 'send_failed', message: e.message });
    }
    return { data: { success: true } };
  }, { body: testBody });

  r.get('/api/sender-emails/:id/campaigns', 'Campaigns using this email account', (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    return { data: db.all('SELECT c.id, c.name, c.status FROM campaigns c JOIN campaign_sender_emails cs ON cs.campaign_id = c.id WHERE cs.sender_email_id = ?', [s.id]) };
  });

  r.get('/api/sender-emails/:id/replies', 'Replies received by this email account', (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    return { data: db.all('SELECT * FROM replies WHERE sender_email_id = ? ORDER BY received_at DESC LIMIT 200', [s.id]) };
  });

  r.post('/api/sender-emails/:id/check-mx-records', 'Check DNS records (MX, SPF, DKIM, DMARC)', async (req) => {
    const a = auth(req);
    const s = getSender(a.workspaceId, idParam(req));
    return { data: await checkDomain(domainOf(s.email)) };
  });

  r.get('/api/sender-emails/domains/health', 'DNS health for every sending domain', async (req) => {
    const a = auth(req);
    const domains = [...new Set(db.all('SELECT email FROM sender_emails WHERE workspace_id = ?', [a.workspaceId]).map((s) => domainOf(s.email)))];
    const reports = [];
    for (let i = 0; i < domains.length; i += 8) reports.push(...(await Promise.all(domains.slice(i, i + 8).map((d) => checkDomain(d)))));
    return { data: reports };
  });

  const bulkSig = z.object({ sender_email_ids: idList, email_signature: z.string().max(10_000) });
  r.patch('/api/sender-emails/signatures/bulk', 'Bulk update signatures', (req) => {
    const a = canWrite(req);
    const b = parse(bulkSig, req.body);
    const n = db.run(`UPDATE sender_emails SET email_signature = ? WHERE workspace_id = ? AND id IN (${b.sender_email_ids.map(() => '?').join(',')})`, [b.email_signature, a.workspaceId, ...b.sender_email_ids]).changes;
    return { data: { updated: n } };
  }, { body: bulkSig });

  const bulkLimit = z.object({ sender_email_ids: idList, daily_limit: z.coerce.number().int().min(1).max(2000) });
  r.patch('/api/sender-emails/daily-limits/bulk', 'Bulk update daily limits', (req) => {
    const a = canWrite(req);
    const b = parse(bulkLimit, req.body);
    const n = db.run(`UPDATE sender_emails SET daily_limit = ? WHERE workspace_id = ? AND id IN (${b.sender_email_ids.map(() => '?').join(',')})`, [b.daily_limit, a.workspaceId, ...b.sender_email_ids]).changes;
    return { data: { updated: n } };
  }, { body: bulkLimit });

  const bulkRoute = z.object({ sender_email_ids: idList, egress_route_id: z.coerce.number().int().nullable() });
  r.patch('/api/sender-emails/egress/bulk', 'Assign an IP route to email accounts', (req) => {
    const a = canWrite(req);
    const b = parse(bulkRoute, req.body);
    const n = db.run(`UPDATE sender_emails SET egress_route_id = ? WHERE workspace_id = ? AND id IN (${b.sender_email_ids.map(() => '?').join(',')})`, [b.egress_route_id, a.workspaceId, ...b.sender_email_ids]).changes;
    return { data: { updated: n } };
  }, { body: bulkRoute });

  const moveBody = z.object({ workspace_id: z.coerce.number().int(), sender_email_ids: idList });
  r.post('/api/sender-emails/move-to-another-workspace-bulk', 'Move email accounts to another workspace', (req) => {
    const a = requireAdmin(req);
    const b = parse(moveBody, req.body);
    if (!db.get(`SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ? AND role = 'admin'`, [a.userId, b.workspace_id])) throw notFound('workspace');
    db.tx(() => {
      for (const id of b.sender_email_ids) {
        const s = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [id, a.workspaceId]);
        if (!s) continue;
        db.run('DELETE FROM campaign_sender_emails WHERE sender_email_id = ?', [id]);
        db.run(`DELETE FROM taggables WHERE taggable_type = 'sender_email' AND taggable_id = ?`, [id]);
        db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'moved workspace' WHERE sender_email_id = ? AND status = 'scheduled'`, [id]);
        db.update('sender_emails', id, { workspace_id: b.workspace_id });
      }
    });
    return { data: { success: true } };
  }, { body: moveBody });

  // ---- OAuth (Google / Microsoft) ----
  const o = defineRoutes(app, 'OAuth Sessions');
  const pending = new Map<string, { workspaceId: number; provider: OAuthProvider; expires: number }>();
  const redirectUri = () => `${ctx.config.publicUrl}/oauth/callback`;

  for (const provider of ['google', 'microsoft'] as const) {
    const body = z.object({ admin_consent_prompt: bool.default(false) });
    o.post(`/api/oauth-sessions/${provider}`, `Start ${provider === 'google' ? 'Google' : 'Microsoft'} OAuth connection`, (req) => {
      const a = canWrite(req);
      const b = parse(body, req.body);
      const cfg = getOAuthApp(db, provider);
      if (!cfg) throw new HttpError(422, { error: 'not_configured', message: `Add your ${provider === 'google' ? 'Google' : 'Microsoft'} OAuth client ID and secret in Settings → Integrations first.` });
      const state = randomToken(24);
      pending.set(state, { workspaceId: a.workspaceId, provider, expires: Date.now() + 15 * 60_000 });
      return { data: { url: authorizeUrl(provider, cfg, redirectUri(), state, { adminConsent: b.admin_consent_prompt }), redirect_uri: redirectUri() } };
    }, { body });
  }

  o.get('/oauth/callback', 'OAuth redirect target', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const session = pending.get(q.state ?? '');
    const done = (msg: string, ok: boolean) => reply.redirect(`/sender-emails?oauth=${ok ? 'connected' : 'error'}&message=${encodeURIComponent(msg)}`);
    if (!session || session.expires < Date.now()) return done('This sign-in link expired. Try again.', false);
    pending.delete(q.state!);
    if (q.error) return done(q.error_description ?? q.error, false);
    const cfg = getOAuthApp(db, session.provider)!;
    try {
      const tokens = await exchangeCode(session.provider, cfg, q.code ?? '', redirectUri());
      if (!tokens.refresh_token) return done('No refresh token returned. Remove the app from your account permissions and connect again.', false);
      const claims = idTokenClaims(tokens.id_token);
      const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
      if (!email) return done('Could not read the mailbox address from the provider.', false);
      const preset = PRESETS[session.provider];
      const existing = db.get('SELECT id FROM sender_emails WHERE workspace_id = ? AND email = ?', [session.workspaceId, email]);
      const fields = {
        provider: session.provider, auth_type: 'oauth', username: email, secret_enc: encrypt(tokens.refresh_token),
        oauth_access_token_enc: encrypt(tokens.access_token), oauth_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        ...preset, status: 'Connected', last_error: null,
      };
      if (existing) {
        db.update('sender_emails', existing.id, fields);
      } else {
        const id = db.insert('sender_emails', { workspace_id: session.workspaceId, name: claims.name ?? email, email, ...fields });
        const tagId = defaultTagFor(ctx, session.workspaceId, session.provider);
        if (tagId) db.run('INSERT OR IGNORE INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)', [tagId, 'sender_email', id]);
        emit(ctx, session.workspaceId, 'EMAIL_ACCOUNT_ADDED', { sender_email_id: id, email }, { sender_email_id: id });
      }
      return done(`${email} connected`, true);
    } catch (e: any) {
      return done(e.message, false);
    }
  }, { public: true });

  // ---- IP routes (static egress) ----
  const e = defineRoutes(app, 'Sending IPs');
  e.get('/api/egress-routes', 'List IP routes', (req) => {
    auth(req);
    return { data: db.all(`SELECT r.*, (SELECT COUNT(*) FROM sender_emails s WHERE s.egress_route_id = r.id) AS sender_count FROM egress_routes r ORDER BY r.id`).map(maskRoute) };
  });
  const routeBody = z.object({
    name: z.string().trim().min(1).max(100),
    proxy_url: z.string().trim().regex(/^(socks5?|socks4a?|https?):\/\//, 'must start with socks5://, socks4://, http:// or https://').nullable().optional(),
    local_address: z.string().trim().regex(/^[0-9a-fA-F:.]+$/, 'must be an IP address').nullable().optional(),
  }).refine((v) => v.proxy_url || v.local_address, { message: 'Provide a proxy URL or a local IP address.', path: ['proxy_url'] });
  e.post('/api/egress-routes', 'Create IP route', (req) => {
    requireAdmin(req);
    const b = parse(routeBody, req.body);
    const id = db.insert('egress_routes', { name: b.name, proxy_url: sealProxy(b.proxy_url), local_address: b.local_address ?? null });
    return { data: maskRoute(db.get('SELECT * FROM egress_routes WHERE id = ?', [id])!) };
  }, { body: routeBody });
  e.put('/api/egress-routes/:id', 'Update IP route', (req) => {
    requireAdmin(req);
    const b = parse(routeBody, req.body);
    const current = db.get('SELECT * FROM egress_routes WHERE id = ?', [idParam(req)]);
    if (!current) throw notFound('route');
    // The list shows proxy passwords masked; saving the masked value keeps the stored password.
    const proxy = b.proxy_url && current.proxy_url && b.proxy_url === maskRoute(current).proxy_url ? current.proxy_url : sealProxy(b.proxy_url);
    db.run('UPDATE egress_routes SET name = ?, proxy_url = ?, local_address = ? WHERE id = ?', [b.name, proxy, b.local_address ?? null, current.id]);
    return { data: maskRoute(db.get('SELECT * FROM egress_routes WHERE id = ?', [idParam(req)])!) };
  }, { body: routeBody });
  e.delete('/api/egress-routes/:id', 'Delete IP route', (req) => {
    requireAdmin(req);
    if (!db.run('DELETE FROM egress_routes WHERE id = ?', [idParam(req)]).changes) throw notFound('route');
    return { data: { success: true } };
  });
  e.post('/api/egress-routes/:id/check', 'Check the public IP seen through this route', async (req) => {
    requireAdmin(req);
    const route = db.get('SELECT * FROM egress_routes WHERE id = ?', [idParam(req)]);
    if (!route) throw notFound('route');
    return { data: await probeEgress(route) };
  });

}

/** Proxy URLs can hold credentials, so they are stored encrypted ("enc:" prefix). */
const sealProxy = (url: string | null | undefined) => (url ? `enc:${encrypt(url)}` : null);
export const openProxy = (stored: string | null | undefined) => (!stored ? null : stored.startsWith('enc:') ? decrypt(stored.slice(4)) : stored);

function maskRoute(r: Row) {
  const url = openProxy(r.proxy_url);
  return { ...r, proxy_url: url ? url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@') : null };
}

/** Connects through the route to a public IP echo service. */
async function probeEgress(stored: Row): Promise<{ ok: boolean; ip?: string; error?: string }> {
  const route: Row = { ...stored, proxy_url: openProxy(stored.proxy_url) };
  const { SocksClient } = await import('socks');
  const net = await import('node:net');
  try {
    let socket: import('node:net').Socket;
    if (route.proxy_url?.startsWith('socks')) {
      const u = new URL(route.proxy_url);
      const { socket: s } = await SocksClient.createConnection({
        proxy: { host: u.hostname, port: Number(u.port || 1080), type: u.protocol.startsWith('socks4') ? 4 : 5, userId: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined },
        command: 'connect', destination: { host: 'api.ipify.org', port: 80 }, timeout: 15_000,
      });
      socket = s;
    } else if (route.proxy_url) {
      return { ok: false, error: 'IP check supports SOCKS routes and local addresses. HTTP proxies are still used for mail.' };
    } else {
      socket = net.connect({ host: 'api.ipify.org', port: 80, localAddress: route.local_address });
      await new Promise<void>((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
    }
    const body = await new Promise<string>((res, rej) => {
      let data = '';
      socket.setTimeout(15_000, () => rej(new Error('timeout')));
      socket.on('data', (d) => (data += d));
      socket.on('end', () => res(data));
      socket.on('error', rej);
      socket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    });
    const ip = body.split('\r\n\r\n')[1]?.trim();
    return { ok: !!ip, ip };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

