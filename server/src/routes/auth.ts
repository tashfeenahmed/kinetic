import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { defineRoutes, HttpError, parse, auth, type Auth } from '../http.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.ts';

export const SESSION_COOKIE = 'k_session';
const SESSION_DAYS = 30;

/** Resolves the caller from a Bearer token or session cookie. */
export function authenticate(ctx: Ctx, req: FastifyRequest): Auth | null {
  const { db } = ctx;
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    const row = db.get('SELECT * FROM api_tokens WHERE token_hash = ?', [sha256(token)]);
    if (!row) throw new HttpError(401, { error: 'invalid_token', message: 'Invalid API token.' });
    db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    const user = db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user) return null;
    // api-user tokens are pinned to their workspace; super-admin tokens follow the user's current workspace.
    const workspaceId = row.type === 'api-user' ? row.workspace_id : user.current_workspace_id;
    const member = db.get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, user.id]);
    if (!member) return null;
    return { userId: user.id, workspaceId, role: member.role, via: 'token' };
  }

  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const session = db.get('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', [sha256(sid), new Date().toISOString()]);
  if (!session) return null;
  const user = db.get('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user) return null;
  let member = db.get('SELECT workspace_id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [user.current_workspace_id, user.id]);
  if (!member) {
    member = db.get('SELECT workspace_id, role FROM workspace_members WHERE user_id = ? ORDER BY workspace_id LIMIT 1', [user.id]);
    if (!member) return null;
    db.update('users', user.id, { current_workspace_id: member.workspace_id });
  }
  return { userId: user.id, workspaceId: member.workspace_id, role: member.role, via: 'session' };
}

function createSession(ctx: Ctx, userId: number): string {
  const sid = randomToken(32);
  ctx.db.insert('sessions', { id: sha256(sid), user_id: userId, expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString() });
  return sid;
}

export function userJson(ctx: Ctx, userId: number) {
  const u = ctx.db.get('SELECT id, name, email, current_workspace_id, created_at, updated_at FROM users WHERE id = ?', [userId])!;
  const ws = ctx.db.get('SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?', [u.current_workspace_id, userId]);
  return { ...u, team: ws ?? null, role: ws?.role ?? null };
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Account Management');
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.publicUrl.startsWith('https'), maxAge: SESSION_DAYS * 86_400 };

  r.get('/api/auth/status', 'Whether the app needs first-run setup', (req) => ({
    data: { needs_setup: !ctx.db.get('SELECT 1 FROM users LIMIT 1'), authenticated: !!req.auth },
  }), { public: true });

  const setupBody = z.object({ name: z.string().min(1), email: z.email(), password: z.string().min(8), workspace_name: z.string().min(1).default('Main Workspace') });
  r.post('/api/auth/setup', 'Create the first admin account', (req, reply) => {
    if (ctx.db.get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(409, { error: 'already_setup', message: 'Setup has already been completed.' });
    const b = parse(setupBody, req.body);
    const userId = ctx.db.tx(() => {
      const wsId = ctx.db.insert('workspaces', { name: b.workspace_name });
      const uid = ctx.db.insert('users', { name: b.name, email: b.email, password_hash: hashPassword(b.password), current_workspace_id: wsId });
      ctx.db.insert('workspace_members', { workspace_id: wsId, user_id: uid, role: 'admin' });
      seedWorkspaceDefaults(ctx, wsId);
      return uid;
    });
    reply.setCookie(SESSION_COOKIE, createSession(ctx, userId), cookieOpts);
    return { data: userJson(ctx, userId) };
  }, { body: setupBody, public: true });

  const loginBody = z.object({ email: z.email(), password: z.string().min(1) });
  r.post('/api/auth/login', 'Log in with email and password', (req, reply) => {
    const b = parse(loginBody, req.body);
    const user = ctx.db.get('SELECT * FROM users WHERE email = ?', [b.email]);
    if (!user || !verifyPassword(b.password, user.password_hash)) {
      throw new HttpError(422, { error: 'validation_error', message: 'These credentials do not match our records.', fields: { email: ['These credentials do not match our records.'] } });
    }
    reply.setCookie(SESSION_COOKIE, createSession(ctx, user.id), cookieOpts);
    return { data: userJson(ctx, user.id) };
  }, { body: loginBody, public: true });

  r.post('/api/auth/logout', 'Log out', (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) ctx.db.run('DELETE FROM sessions WHERE id = ?', [sha256(sid)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { data: { success: true } };
  }, { public: true });

  r.get('/api/users', 'Account details', (req) => ({ data: userJson(ctx, auth(req).userId) }));

  const profileBody = z.object({ name: z.string().min(1).optional(), email: z.email().optional() });
  r.put('/api/users/profile', 'Update profile', (req) => {
    const a = auth(req);
    const b = parse(profileBody, req.body);
    ctx.db.update('users', a.userId, { ...b, updated_at: new Date().toISOString() });
    return { data: userJson(ctx, a.userId) };
  }, { body: profileBody });

  const pwBody = z.object({ current_password: z.string(), password: z.string().min(8), password_confirmation: z.string() })
    .refine((v) => v.password === v.password_confirmation, { path: ['password_confirmation'], message: 'Passwords do not match.' });
  r.put('/api/users/password', 'Update password', (req) => {
    const a = auth(req);
    const b = parse(pwBody, req.body);
    const user = ctx.db.get('SELECT * FROM users WHERE id = ?', [a.userId])!;
    if (!verifyPassword(b.current_password, user.password_hash)) {
      throw new HttpError(422, { error: 'validation_error', message: 'Current password is incorrect.', fields: { current_password: ['Current password is incorrect.'] } });
    }
    ctx.db.update('users', a.userId, { password_hash: hashPassword(b.password), updated_at: new Date().toISOString() });
    return { data: { success: true } };
  }, { body: pwBody });
}

/** Default tags and schedule template every new workspace starts with. */
export function seedWorkspaceDefaults(ctx: Ctx, workspaceId: number) {
  for (const name of ['Google', 'Microsoft', 'Custom']) {
    ctx.db.run('INSERT OR IGNORE INTO tags (workspace_id, name, is_default) VALUES (?, ?, 1)', [workspaceId, name]);
  }
  ctx.db.insert('schedule_templates', {
    workspace_id: workspaceId, name: 'Weekdays 9–5',
    days: JSON.stringify({ monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false }),
    start_time: '09:00', end_time: '17:00', timezone: 'America/New_York',
  });
}
