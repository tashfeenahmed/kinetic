import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, bool, defineRoutes, forbidden, HttpError, idParam, notFound, parse, requireAdmin } from '../http.ts';
import { hashPassword, randomToken, sha256 } from '../lib/crypto.ts';
import { emailField, seedWorkspaceDefaults, userJson } from './auth.ts';
import { inboxAiBody, inboxAiSettings } from '../engine/replyAi.ts';

function memberOf(ctx: Ctx, userId: number, workspaceId: number) {
  return ctx.db.get('SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?', [userId, workspaceId]);
}

function workspaceJson(ctx: Ctx, id: number) {
  const w = ctx.db.get('SELECT * FROM workspaces WHERE id = ?', [id]);
  if (!w) throw notFound('workspace');
  const members = ctx.db.all(
    `SELECT u.id, u.name, u.email, m.role, u.must_change_password AS pending FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name`, [id])
    .map((m) => ({ ...m, pending: !!m.pending }));
  return {
    ...w,
    sync_all_emails: !!w.sync_all_emails,
    smart_warmup_filter: !!w.smart_warmup_filter,
    auto_interested_categorization: !!w.auto_interested_categorization,
    members,
  };
}

export function workspaceRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Workspaces');
  const { db } = ctx;

  r.get('/api/workspaces', 'List workspaces', (req) => {
    const a = auth(req);
    return {
      data: db.all(
        `SELECT w.id, w.name, m.role, w.created_at,
           (SELECT COUNT(*) FROM sender_emails s WHERE s.workspace_id = w.id) AS sender_emails_count,
           (SELECT COUNT(*) FROM campaigns c WHERE c.workspace_id = w.id) AS campaigns_count
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.id`, [a.userId]),
    };
  });

  const nameBody = z.object({ name: z.string().min(1).max(100) });
  r.post('/api/workspaces', 'Create workspace', (req) => {
    const a = requireAdmin(req);
    const b = parse(nameBody, req.body);
    const id = db.tx(() => {
      const wsId = db.insert('workspaces', { name: b.name });
      db.insert('workspace_members', { workspace_id: wsId, user_id: a.userId, role: 'admin' });
      seedWorkspaceDefaults(ctx, wsId);
      return wsId;
    });
    return { data: workspaceJson(ctx, id) };
  }, { body: nameBody });

  r.get('/api/workspaces/:id', 'Workspace details', (req) => {
    const a = auth(req);
    const id = idParam(req);
    if (!memberOf(ctx, a.userId, id)) throw notFound('workspace');
    return { data: workspaceJson(ctx, id) };
  });

  r.put('/api/workspaces/:id', 'Rename workspace', (req) => {
    const a = auth(req);
    const id = idParam(req);
    if (memberOf(ctx, a.userId, id)?.role !== 'admin') throw forbidden();
    db.update('workspaces', id, { ...parse(nameBody, req.body), updated_at: new Date().toISOString() });
    return { data: workspaceJson(ctx, id) };
  }, { body: nameBody });

  r.delete('/api/workspaces/:id', 'Delete workspace', (req) => {
    const a = auth(req);
    const id = idParam(req);
    if (memberOf(ctx, a.userId, id)?.role !== 'admin') throw forbidden();
    const count = db.get<{ n: number }>('SELECT COUNT(*) n FROM workspace_members WHERE user_id = ?', [a.userId])!.n;
    if (count <= 1) throw new HttpError(422, { error: 'validation_error', message: 'You cannot delete your only workspace.' });
    db.run('DELETE FROM workspaces WHERE id = ?', [id]);
    return { data: { success: true } };
  });

  const switchBody = z.object({ team_id: z.coerce.number().int() });
  r.post('/api/workspaces/switch-workspace', 'Switch workspace', (req) => {
    const a = auth(req);
    const b = parse(switchBody, req.body);
    if (!memberOf(ctx, a.userId, b.team_id)) throw notFound('workspace');
    db.update('users', a.userId, { current_workspace_id: b.team_id });
    return { data: userJson(ctx, a.userId) };
  }, { body: switchBody });

  // ---- members ----
  const userBody = z.object({ name: z.string().trim().min(1), email: emailField(), password: z.string().min(8), role: z.enum(['admin', 'editor', 'viewer']).default('editor') });
  r.post('/api/workspaces/v1.1/users', 'Create user and add to current workspace', (req) => {
    const a = requireAdmin(req);
    const b = parse(userBody, req.body);
    const existing = db.get('SELECT * FROM users WHERE email = ?', [b.email]);
    if (existing && memberOf(ctx, existing.id, a.workspaceId)) {
      throw new HttpError(422, { error: 'validation_error', message: `${existing.email} is already in this workspace. Change their role or reset their password in the list instead.`, fields: { email: ['is already a member'] } });
    }
    // Someone with access to other workspaces keeps their own password; anyone else
    // (new, or removed from everything earlier) signs in with the temporary one and picks their own.
    const keepsPassword = !!existing && !!db.get('SELECT 1 FROM workspace_members WHERE user_id = ?', [existing.id]);
    const uid = db.tx(() => {
      let id = existing?.id as number | undefined;
      if (!id) id = db.insert('users', { name: b.name, email: b.email, password_hash: hashPassword(b.password), must_change_password: 1, current_workspace_id: a.workspaceId });
      else if (!keepsPassword) db.update('users', id, { name: b.name, password_hash: hashPassword(b.password), must_change_password: 1, current_workspace_id: a.workspaceId, updated_at: new Date().toISOString() });
      db.run('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [a.workspaceId, id, b.role]);
      return id;
    });
    const u = db.get('SELECT name, email FROM users WHERE id = ?', [uid])!;
    return { data: { id: uid, name: u.name, email: u.email, role: b.role, existing_account: keepsPassword, temporary_password_set: !keepsPassword } };
  }, { body: userBody });

  const resetBody = z.object({ password: z.string().min(8) });
  r.put('/api/workspaces/members/:user_id/password', 'Set a temporary password for a member (they choose their own at next sign-in)', (req) => {
    const a = requireAdmin(req);
    const userId = idParam(req, 'user_id');
    const b = parse(resetBody, req.body);
    if (userId === a.userId) throw new HttpError(422, { error: 'validation_error', message: 'Change your own password in Settings → Profile.' });
    if (!memberOf(ctx, userId, a.workspaceId)) throw notFound('member');
    db.update('users', userId, { password_hash: hashPassword(b.password), must_change_password: 1, updated_at: new Date().toISOString() });
    db.run('DELETE FROM sessions WHERE user_id = ?', [userId]); // signed out everywhere
    return { data: { success: true } };
  }, { body: resetBody });

  const roleBody = z.object({ role: z.enum(['admin', 'editor', 'viewer']) });
  r.put('/api/workspaces/members/:user_id', 'Update member role', (req) => {
    const a = requireAdmin(req);
    const userId = idParam(req, 'user_id');
    const b = parse(roleBody, req.body);
    if (userId === a.userId && b.role !== 'admin') throw new HttpError(422, { error: 'validation_error', message: 'You cannot remove your own admin role.' });
    const changed = db.run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [b.role, a.workspaceId, userId]).changes;
    if (!changed) throw notFound('member');
    return { data: { success: true } };
  }, { body: roleBody });

  r.delete('/api/workspaces/members/:user_id', 'Remove member', (req) => {
    const a = requireAdmin(req);
    const userId = idParam(req, 'user_id');
    if (userId === a.userId) throw new HttpError(422, { error: 'validation_error', message: 'You cannot remove yourself.' });
    db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [a.workspaceId, userId]);
    // No workspace left: end their sessions too.
    if (!db.get('SELECT 1 FROM workspace_members WHERE user_id = ?', [userId])) db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    return { data: { success: true } };
  });

  // ---- master inbox settings ----
  r.get('/api/workspaces/v1.1/master-inbox-settings', 'Get master inbox settings', (req) => {
    const w = workspaceJson(ctx, auth(req).workspaceId);
    return { data: { sync_all_emails: w.sync_all_emails, smart_warmup_filter: w.smart_warmup_filter, auto_interested_categorization: w.auto_interested_categorization, ...inboxAiSettings(ctx, w) } };
  });

  const inboxBody = z.object({ sync_all_emails: bool.optional(), smart_warmup_filter: bool.optional(), auto_interested_categorization: bool.optional(), ...inboxAiBody });
  r.patch('/api/workspaces/v1.1/master-inbox-settings', 'Update master inbox settings', (req) => {
    const a = requireAdmin(req);
    db.update('workspaces', a.workspaceId, parse(inboxBody, req.body));
    const w = workspaceJson(ctx, a.workspaceId);
    return { data: { sync_all_emails: w.sync_all_emails, smart_warmup_filter: w.smart_warmup_filter, auto_interested_categorization: w.auto_interested_categorization, ...inboxAiSettings(ctx, w) } };
  }, { body: inboxBody });

  // ---- API tokens ----
  const tr = defineRoutes(app, 'API Tokens');
  tr.get('/api/api-tokens', 'List API tokens', (req) => {
    const a = auth(req);
    return { data: db.all('SELECT id, name, type, token_prefix, workspace_id, last_used_at, created_at FROM api_tokens WHERE user_id = ? AND (workspace_id = ? OR type = \'super-admin\') ORDER BY id DESC', [a.userId, a.workspaceId]) };
  });

  const tokenBody = z.object({ name: z.string().min(1).max(100), type: z.enum(['api-user', 'super-admin']).default('api-user') });
  tr.post('/api/api-tokens', 'Create API token (shown once)', (req) => {
    const a = requireAdmin(req);
    const b = parse(tokenBody, req.body);
    const plain = `eb_${randomToken(30)}`;
    const id = db.insert('api_tokens', { user_id: a.userId, workspace_id: a.workspaceId, name: b.name, type: b.type, token_hash: sha256(plain), token_prefix: plain.slice(0, 10) });
    return { data: { id, name: b.name, type: b.type, plain_text_token: plain } };
  }, { body: tokenBody });

  tr.delete('/api/api-tokens/:id', 'Revoke API token', (req) => {
    const a = auth(req);
    const changed = db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [idParam(req), a.userId]).changes;
    if (!changed) throw notFound('token');
    return { data: { success: true } };
  });
}
