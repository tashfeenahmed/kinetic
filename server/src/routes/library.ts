/** Smaller workspace resources: custom variables, blacklists, ignore phrases, reply templates, tracking domains. */
import type { FastifyInstance } from 'fastify';
import { promises as dnsp } from 'node:dns';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, canWrite, defineRoutes, idParam, notFound, pageQuery, paginate, parse } from '../http.ts';
import { cancelScheduled } from '../engine/sequencer.ts';
import { varKey } from '../lib/template.ts';
import { LIKE_ESCAPE, contains } from '../lib/like.ts';

export function libraryRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ---- custom variables ----
  const cv = defineRoutes(app, 'Custom Lead Variables');
  cv.get('/api/custom-variables', 'Get all custom variables', (req) => {
    const a = auth(req);
    return { data: db.all('SELECT id, name FROM custom_variables WHERE workspace_id = ? ORDER BY name', [a.workspaceId]).map((v) => ({ ...v, tag: `{${varKey(v.name)}}` })) };
  });
  const cvBody = z.object({ name: z.string().trim().min(1).max(60) });
  cv.post('/api/custom-variables', 'Create custom variable', (req) => {
    const a = canWrite(req);
    const b = parse(cvBody, req.body);
    db.run('INSERT OR IGNORE INTO custom_variables (workspace_id, name) VALUES (?, ?)', [a.workspaceId, b.name]);
    return { data: db.get('SELECT id, name FROM custom_variables WHERE workspace_id = ? AND name = ?', [a.workspaceId, b.name]) };
  }, { body: cvBody });
  cv.delete('/api/custom-variables/:id', 'Remove custom variable', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM custom_variables WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('custom variable');
    return { data: { success: true } };
  });

  // ---- blacklists ----
  for (const kind of ['email', 'domain'] as const) {
    const table = `blacklisted_${kind}s`;
    const r = defineRoutes(app, kind === 'email' ? 'Email Blacklist' : 'Domain Blacklist');
    const base = `/api/blacklisted-${kind}s`;
    const listQ = pageQuery.extend({ search: z.string().optional() });
    r.get(base, `Get all blacklisted ${kind}s`, (req) => {
      const a = auth(req);
      const q = parse(listQ, req.query);
      return paginate(ctx, `SELECT * FROM ${table} WHERE workspace_id = ? AND ${kind} LIKE ? ${LIKE_ESCAPE} ORDER BY id DESC`, [a.workspaceId, contains(q.search ?? '')], q);
    }, { query: listQ });

    const value = kind === 'email' ? z.email().transform((s) => s.toLowerCase()) : z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'is invalid');
    const add = (workspaceId: number, v: string) => {
      db.run(`INSERT OR IGNORE INTO ${table} (workspace_id, ${kind}) VALUES (?, ?)`, [workspaceId, v]);
      // Stop anything already queued for matching leads.
      const leads = db.all(kind === 'email'
        ? 'SELECT id FROM leads WHERE workspace_id = ? AND email = ?'
        : `SELECT id FROM leads WHERE workspace_id = ? AND email LIKE '%@' || ?`, [workspaceId, v]);
      for (const l of leads) {
        db.run(`UPDATE campaign_leads SET status = 'stopped', next_due_at = NULL WHERE lead_id = ? AND status IN ('pending','in_sequence')`, [l.id]);
        cancelScheduled(ctx, { leadId: l.id }, 'blacklisted');
      }
    };
    const one = z.object({ [kind]: value });
    r.post(base, `Create blacklisted ${kind}`, (req) => {
      const a = canWrite(req);
      const b = parse(one, req.body) as Record<string, string>;
      db.tx(() => add(a.workspaceId, b[kind]!));
      return { data: db.get(`SELECT * FROM ${table} WHERE workspace_id = ? AND ${kind} = ?`, [a.workspaceId, b[kind]]) };
    }, { body: one });
    const many = z.object({ [`${kind}s`]: z.array(z.string()).min(1).max(10_000) });
    r.post(`${base}/bulk`, `Bulk create blacklisted ${kind}s`, (req) => {
      const a = canWrite(req);
      const b = parse(many, req.body) as Record<string, string[]>;
      let added = 0;
      const invalid: string[] = [];
      db.tx(() => {
        for (const raw of b[`${kind}s`]!) {
          const p = value.safeParse(raw.trim());
          if (!p.success) { invalid.push(raw); continue; }
          add(a.workspaceId, p.data);
          added++;
        }
      });
      return { data: { added, invalid } };
    }, { body: many });
    r.get(`${base}/:id`, `Get blacklisted ${kind}`, (req) => {
      const a = auth(req);
      const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`, [idParam(req), a.workspaceId]);
      if (!row) throw notFound();
      return { data: row };
    });
    r.delete(`${base}/:id`, `Remove blacklisted ${kind}`, (req) => {
      const a = canWrite(req);
      if (!db.run(`DELETE FROM ${table} WHERE id = ? AND workspace_id = ?`, [idParam(req), a.workspaceId]).changes) throw notFound();
      return { data: { success: true } };
    });
  }

  // ---- ignore phrases ----
  const ip = defineRoutes(app, 'Ignore Phrases');
  ip.get('/api/ignore-phrases', 'Get all ignore phrases', (req) => ({ data: db.all('SELECT * FROM ignore_phrases WHERE workspace_id = ? ORDER BY id DESC', [auth(req).workspaceId]) }));
  const phraseBody = z.object({ phrase: z.string().trim().min(2).max(300) });
  ip.post('/api/ignore-phrases', 'Create ignore phrase', (req) => {
    const a = canWrite(req);
    const id = db.insert('ignore_phrases', { workspace_id: a.workspaceId, ...parse(phraseBody, req.body) });
    return { data: db.get('SELECT * FROM ignore_phrases WHERE id = ?', [id]) };
  }, { body: phraseBody });
  ip.delete('/api/ignore-phrases/:id', 'Remove ignore phrase', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM ignore_phrases WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound();
    return { data: { success: true } };
  });

  // ---- reply templates ----
  const rt = defineRoutes(app, 'Reply Templates');
  rt.get('/api/reply-templates', 'Get all reply templates', (req) => ({ data: db.all('SELECT * FROM reply_templates WHERE workspace_id = ? ORDER BY name', [auth(req).workspaceId]) }));
  const tplBody = z.object({ name: z.string().trim().min(1).max(100), body: z.string().min(1) });
  rt.post('/api/reply-templates', 'Create reply template', (req) => {
    const a = canWrite(req);
    const id = db.insert('reply_templates', { workspace_id: a.workspaceId, ...parse(tplBody, req.body) });
    return { data: db.get('SELECT * FROM reply_templates WHERE id = ?', [id]) };
  }, { body: tplBody });
  rt.get('/api/reply-templates/:id', 'Reply template details', (req) => {
    const t = db.get('SELECT * FROM reply_templates WHERE id = ? AND workspace_id = ?', [idParam(req), auth(req).workspaceId]);
    if (!t) throw notFound('template');
    return { data: t };
  });
  rt.put('/api/reply-templates/:id', 'Update reply template', (req) => {
    const a = canWrite(req);
    if (!db.run('UPDATE reply_templates SET name = ?, body = ? WHERE id = ? AND workspace_id = ?', [...Object.values(parse(tplBody, req.body)), idParam(req), a.workspaceId]).changes) throw notFound('template');
    return { data: db.get('SELECT * FROM reply_templates WHERE id = ?', [idParam(req)]) };
  }, { body: tplBody });
  rt.delete('/api/reply-templates/:id', 'Delete reply template', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM reply_templates WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('template');
    return { data: { success: true } };
  });

  // ---- custom tracking domains ----
  const td = defineRoutes(app, 'Custom Tracking Domains');
  td.get('/api/custom-tracking-domain', 'Get all custom tracking domains', (req) => ({
    data: db.all('SELECT * FROM custom_tracking_domains WHERE workspace_id = ? ORDER BY id DESC', [auth(req).workspaceId]),
    meta: { cname_target: new URL(ctx.config.publicUrl).hostname },
  }));
  const domainBody = z.object({ domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'is invalid') });
  td.post('/api/custom-tracking-domain', 'Create custom tracking domain', (req) => {
    const a = canWrite(req);
    const id = db.insert('custom_tracking_domains', { workspace_id: a.workspaceId, ...parse(domainBody, req.body) });
    return { data: db.get('SELECT * FROM custom_tracking_domains WHERE id = ?', [id]) };
  }, { body: domainBody });
  td.get('/api/custom-tracking-domain/:id', 'Get a custom tracking domain', (req) => {
    const d = db.get('SELECT * FROM custom_tracking_domains WHERE id = ? AND workspace_id = ?', [idParam(req), auth(req).workspaceId]);
    if (!d) throw notFound('domain');
    return { data: d };
  });
  td.post('/api/custom-tracking-domain/:id/verify', 'Verify CNAME for a tracking domain', async (req) => {
    const a = canWrite(req);
    const d = db.get('SELECT * FROM custom_tracking_domains WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!d) throw notFound('domain');
    const target = new URL(ctx.config.publicUrl).hostname;
    let cnames: string[] = [];
    try { cnames = await dnsp.resolveCname(d.domain); } catch { /* none */ }
    const ok = cnames.some((c) => c.replace(/\.$/, '').toLowerCase() === target.toLowerCase());
    db.update('custom_tracking_domains', d.id, { status: ok ? 'verified' : 'failed' });
    return { data: { ...d, status: ok ? 'verified' : 'failed', found: cnames, expected: target } };
  });
  td.delete('/api/custom-tracking-domain/:id', 'Remove custom tracking domain', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM custom_tracking_domains WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('domain');
    return { data: { success: true } };
  });
}
