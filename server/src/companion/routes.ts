/**
 * Companion HTTP API: extension endpoints (pair, heartbeat, poll, results…), automations
 * (phantom catalogue, jobs, stats, limits, approvals) and the packed extension download.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { ROOT } from '../config.ts';
import { auth, canWrite, defineRoutes, forbidden, HttpError, idParam, notFound, parse } from '../http.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { PHANTOMS, NETWORK_LABELS, DEFAULT_LIMITS } from './catalog.ts';
import { loadSettings, saveSettings, allUsage, pacing } from './settings.ts';
import {
  createJob, updateJob, loadJob, jobJson, runJson, startRun, pauseJob, resumeJob, cancelJob, loadTask, refreshRun,
} from './jobs.ts';
import { leaseTask, leasedTask, progressTask, resultsTask, completeTask, safetyStop, loadDevice, type Device } from './queue.ts';
import { renderMessage, aiReady, AI_TOKEN } from './render.ts';
import { loadLead } from './campaigns.ts';
import { linkedinCampaignRoutes } from './campaignRoutes.ts';
import { dirEntries, zip } from './zip.ts';
import { EXTENSION_SITES, type Site } from './protocol.ts';

export const EXTENSION_DIST = join(ROOT, 'extension', 'dist');
const ONLINE_MS = 3 * 60_000;
const J = (s: string | null, d: any = {}) => (s ? JSON.parse(s) : d);

export function companionRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const now = () => ctx.now();

  // The extension calls the API from a chrome-extension:// origin with a Bearer token (never cookies).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/companion/')) {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    return payload;
  });
  app.route({ method: 'OPTIONS', url: '/api/companion/*', config: { public: true }, handler: (_req, reply) => reply.code(204).send() });

  // ---------------------------------------------------------------- pairing & devices
  const cr = defineRoutes(app, 'Companion Extension');

  /** The browser behind an extension request, identified by its API token (auto-registered on first use). */
  const deviceFor = (req: FastifyRequest): Device => {
    const a = auth(req);
    if (a.via !== 'token') throw forbidden('Extension endpoints need a Kinetic API token — pair the Kinetic Companion extension.');
    const token = String(req.headers.authorization ?? '').slice(7).trim();
    const tok = db.get<{ id: number; name: string }>('SELECT id, name FROM api_tokens WHERE token_hash = ?', [sha256(token)]);
    if (!tok) throw new HttpError(401, { error: 'invalid_token', message: 'Invalid API token.' });
    let dev = db.get<{ id: number; workspace_id: number }>('SELECT id, workspace_id FROM companion_devices WHERE api_token_id = ?', [tok.id]);
    if (!dev) {
      const id = db.insert('companion_devices', { workspace_id: a.workspaceId, user_id: a.userId, api_token_id: tok.id, name: tok.name.replace(/^Kinetic Companion · /, '') || 'Browser', created_at: now().toISOString() });
      dev = { id, workspace_id: a.workspaceId };
    }
    db.update('companion_devices', dev.id, { last_seen_at: now().toISOString(), ...(dev.workspace_id !== a.workspaceId ? { workspace_id: a.workspaceId } : {}) });
    return loadDevice(ctx, dev.id)!;
  };

  const deviceJson = (d: any) => {
    const task = d.current_task_id ? db.get(`SELECT t.id, t.kind, j.name AS job_name, c.name AS campaign_name FROM companion_tasks t
      LEFT JOIN companion_jobs j ON j.id = t.job_id LEFT JOIN li_campaigns c ON c.id = t.campaign_id WHERE t.id = ? AND t.status = 'leased'`, [d.current_task_id]) : null;
    return {
      id: d.id, name: d.name, version: d.version, online: !!d.last_seen_at && now().getTime() - Date.parse(d.last_seen_at) < ONLINE_MS,
      paused: !!d.paused, accounts: J(d.accounts), site_pauses: Object.fromEntries(Object.entries(J(d.site_pauses) as Record<string, string>).filter(([, v]) => Date.parse(v) > now().getTime())),
      last_error: d.last_error, last_seen_at: d.last_seen_at, user_agent: d.user_agent,
      current_task: task ? { id: task.id, kind: task.kind, job_name: task.job_name ?? task.campaign_name ?? null } : null, created_at: d.created_at,
    };
  };

  const manifest = () => {
    const f = join(EXTENSION_DIST, 'manifest.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as { version: string } : null;
  };

  cr.get('/api/companion/status', 'Companion extension status: download, paired browsers, online state', (req) => {
    const a = auth(req);
    const devices = db.all('SELECT * FROM companion_devices WHERE workspace_id = ? ORDER BY id', [a.workspaceId]).map(deviceJson);
    const m = manifest();
    return {
      data: {
        kinetic_url: ctx.config.publicUrl,
        extension: { available: !!m, version: m?.version ?? null, download_url: '/companion/extension.zip' },
        devices, online: devices.some((d) => d.online && !d.paused), paused: loadSettings(db, a.workspaceId).paused,
      },
    };
  });

  cr.post('/api/companion/pairing-code', 'Create a 10-minute code to pair the Kinetic Companion browser extension', (req) => {
    const a = canWrite(req);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const expires = new Date(now().getTime() + 10 * 60_000).toISOString();
    db.run('DELETE FROM companion_pairing_codes WHERE expires_at < ?', [now().toISOString()]);
    db.insert('companion_pairing_codes', { code: raw, workspace_id: a.workspaceId, user_id: a.userId, expires_at: expires });
    return { data: { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: expires, kinetic_url: ctx.config.publicUrl } };
  });

  const pairBody = z.object({ code: z.string().min(4), name: z.string().max(80).optional(), version: z.string().max(40).optional() });
  cr.post('/api/companion/pair', 'Extension: exchange a pairing code for an API token', (req) => {
    const b = parse(pairBody, req.body);
    const code = b.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = db.get('SELECT * FROM companion_pairing_codes WHERE code = ?', [code]);
    if (!row || row.used_at || row.expires_at < now().toISOString()) throw new HttpError(422, { error: 'invalid_code', message: 'That pairing code is wrong or expired. Create a new one on the Automations → Extension page.' });
    const name = (b.name?.trim() || 'Chrome').slice(0, 80);
    const plain = `kc_${randomToken(30)}`;
    const out = db.tx(() => {
      db.run('UPDATE companion_pairing_codes SET used_at = ? WHERE code = ?', [now().toISOString(), code]);
      const tokenId = db.insert('api_tokens', { user_id: row.user_id, workspace_id: row.workspace_id, name: `Kinetic Companion · ${name}`, type: 'api-user', token_hash: sha256(plain), token_prefix: plain.slice(0, 10) });
      const deviceId = db.insert('companion_devices', { workspace_id: row.workspace_id, user_id: row.user_id, api_token_id: tokenId, name, version: b.version ?? null, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300), last_seen_at: now().toISOString(), created_at: now().toISOString() });
      return { deviceId };
    });
    const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [row.workspace_id]);
    return { token: plain, device_id: out.deviceId, workspace_name: ws?.name ?? '', kinetic_url: ctx.config.publicUrl };
  }, { body: pairBody, public: true });

  cr.get('/api/companion/me', 'Extension: the paired browser and its workspace', (req) => {
    const d = deviceFor(req);
    const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [d.workspace_id]);
    return { device: deviceJson(db.get('SELECT * FROM companion_devices WHERE id = ?', [d.id])), workspace_name: ws?.name ?? '' };
  });

  cr.post('/api/companion/unpair', 'Extension: unpair this browser (revokes its token)', (req) => {
    const d = deviceFor(req);
    const tok = db.get<{ api_token_id: number | null }>('SELECT api_token_id FROM companion_devices WHERE id = ?', [d.id]);
    db.tx(() => {
      db.run(`UPDATE companion_tasks SET status = 'pending', device_id = NULL, lease_expires_at = NULL WHERE device_id = ? AND status = 'leased'`, [d.id]);
      db.run('DELETE FROM companion_devices WHERE id = ?', [d.id]);
      if (tok?.api_token_id) db.run('DELETE FROM api_tokens WHERE id = ?', [tok.api_token_id]);
    });
    return { ok: true };
  });

  const heartbeatBody = z.object({
    version: z.string().max(40).optional(), paused: z.boolean().optional(), current_task_id: z.number().int().nullable().optional(),
    user_agent: z.string().max(300).optional(), accounts: z.record(z.string(), z.boolean()).optional(), name: z.string().max(80).optional(),
  });
  cr.post('/api/companion/heartbeat', 'Extension: heartbeat with version, logged-in sites and pause state', (req) => {
    const d = deviceFor(req);
    const b = parse(heartbeatBody, req.body);
    const data: Record<string, unknown> = {};
    if (b.version) data.version = b.version;
    if (b.user_agent) data.user_agent = b.user_agent;
    if (b.accounts) data.accounts = JSON.stringify(b.accounts);
    if (b.paused !== undefined) data.paused = b.paused ? 1 : 0;
    if (b.name) data.name = b.name;
    db.update('companion_devices', d.id, data);
    const s = loadSettings(db, d.workspace_id);
    const pauses = Object.fromEntries(Object.entries(d.site_pauses).filter(([, v]) => Date.parse(v) > now().getTime()));
    return {
      paused_all: s.paused, device_paused: b.paused ?? d.paused, site_pauses: pauses, pacing: pacing(s), server_time: now().toISOString(),
      limits: allUsage(db, d.workspace_id, s, now()).map(({ remaining: _r, ...u }) => u),
    };
  }, { body: heartbeatBody });

  const pollBody = z.object({ sites: z.array(z.enum(EXTENSION_SITES as [Site, ...Site[]])).optional() });
  cr.post('/api/companion/poll', 'Extension: get the next task (respects limits, working hours and pacing)', (req) => {
    const d = deviceFor(req);
    const b = parse(pollBody, req.body ?? {});
    return leaseTask(ctx, d, now(), { sites: b.sites });
  }, { body: pollBody });

  const progressBody = z.object({ message: z.string().max(500).optional(), done: z.number().optional(), total: z.number().optional(), cursor: z.any().optional() });
  cr.post('/api/companion/tasks/:id/progress', 'Extension: report task progress (extends the lease)', (req) => {
    const d = deviceFor(req);
    return progressTask(ctx, leasedTask(ctx, idParam(req), d), parse(progressBody, req.body ?? {}), now());
  }, { body: progressBody });

  const resultsBody = z.object({
    records: z.array(z.record(z.string(), z.any())).max(5000).optional(),
    captures: z.array(z.object({ parser: z.string(), data: z.any(), url: z.string().optional() })).max(200).optional(),
    cursor: z.any().optional(),
  });
  cr.post('/api/companion/tasks/:id/results', 'Extension: post a batch of scraped records', async (req) => {
    const d = deviceFor(req);
    return resultsTask(ctx, leasedTask(ctx, idParam(req), d), d, parse(resultsBody, req.body ?? {}), now());
  }, { body: resultsBody });

  const renderBody = z.object({ template: z.string().max(10_000).optional(), profile: z.record(z.string(), z.any()).default({}) });
  cr.post('/api/companion/tasks/:id/render', 'Extension: personalise a note/message for a profile (variables, spintax, AI line)', async (req) => {
    const d = deviceFor(req);
    const t = leasedTask(ctx, idParam(req), d);
    const b = parse(renderBody, req.body ?? {});
    const template = b.template ?? String(t.params.template ?? t.params.note ?? t.params.message ?? '');
    const lead = t.campaign_lead_id ? loadLead(ctx, t.campaign_lead_id) : undefined;
    const known = lead ? { fullName: lead.full_name, firstName: lead.first_name, lastName: lead.last_name, title: lead.title, company: lead.company, location: lead.location, headline: lead.headline } : {};
    const profile = { ...Object.fromEntries(Object.entries(known).filter(([, v]) => v)), ...b.profile };
    try {
      const r = await renderMessage({
        template, profile, row: (t.target.row as Record<string, unknown> | undefined) ?? lead?.data ?? {},
        aiInstructions: String(t.params.ai_instructions ?? ''), settings: ctx.gtm!.settings,
        maxLength: t.kind.includes('connect') ? 300 : 8000,
      });
      return { text: r.text };
    } catch (e: any) {
      throw new HttpError(422, { error: 'render_failed', message: e.message });
    }
  }, { body: renderBody });

  const completeBody = z.object({
    status: z.enum(['done', 'failed', 'skipped']), more: z.boolean().optional(), cursor: z.any().optional(),
    result: z.record(z.string(), z.any()).optional(), error: z.string().max(2000).optional(), actions: z.number().int().min(0).max(1000).optional(),
  });
  cr.post('/api/companion/tasks/:id/complete', 'Extension: finish a task (done, failed or skipped)', (req) => {
    const d = deviceFor(req);
    return completeTask(ctx, leasedTask(ctx, idParam(req), d), d, parse(completeBody, req.body), now());
  }, { body: completeBody });

  const safetyBody = z.object({ kind: z.enum(['rate_limited', 'challenge', 'logged_out', 'restricted', 'error']), message: z.string().max(1000).optional(), url: z.string().max(2000).optional(), site: z.enum(EXTENSION_SITES as [Site, ...Site[]]).optional() });
  cr.post('/api/companion/tasks/:id/error', 'Extension: safety stop (rate limit, challenge, logged out) — pauses that site', (req) => {
    const d = deviceFor(req);
    const b = parse(safetyBody, req.body);
    const id = Number((req.params as any).id);
    const t = id > 0 ? loadTask(ctx, id) : undefined;
    const own = t && t.workspace_id === d.workspace_id && t.device_id === d.id ? t : null;
    const res = safetyStop(ctx, own ?? (b.site ? ({ site: b.site, status: 'none' } as any) : null), d, b, now());
    if (own?.run_id) refreshRun(ctx, own.run_id, now());
    return res;
  }, { body: safetyBody });

  const devicePatch = z.object({ paused: z.boolean().optional(), name: z.string().min(1).max(80).optional(), clear_site_pause: z.string().optional() });
  cr.patch('/api/companion/devices/:id', 'Pause/resume or rename a paired browser, or clear a site safety pause', (req) => {
    const a = canWrite(req);
    const id = idParam(req);
    const dev = loadDevice(ctx, id);
    if (!dev || dev.workspace_id !== a.workspaceId) throw notFound('device');
    const b = parse(devicePatch, req.body);
    const data: Record<string, unknown> = {};
    if (b.paused !== undefined) data.paused = b.paused ? 1 : 0;
    if (b.name) data.name = b.name;
    if (b.clear_site_pause) {
      const { [b.clear_site_pause]: _gone, ...rest } = dev.site_pauses;
      data.site_pauses = JSON.stringify(rest);
      data.last_error = null;
      db.run(`UPDATE companion_tasks SET not_before = NULL WHERE workspace_id = ? AND site = ? AND status = 'pending' AND not_before > ?`, [a.workspaceId, b.clear_site_pause, now().toISOString()]);
    }
    db.update('companion_devices', id, data);
    return { data: deviceJson(db.get('SELECT * FROM companion_devices WHERE id = ?', [id])) };
  }, { body: devicePatch });

  cr.delete('/api/companion/devices/:id', 'Unpair a browser (revokes its token)', (req) => {
    const a = canWrite(req);
    const id = idParam(req);
    const dev = db.get('SELECT * FROM companion_devices WHERE id = ? AND workspace_id = ?', [id, a.workspaceId]);
    if (!dev) throw notFound('device');
    db.tx(() => {
      db.run(`UPDATE companion_tasks SET status = 'pending', device_id = NULL, lease_expires_at = NULL WHERE device_id = ? AND status = 'leased'`, [id]);
      db.run('DELETE FROM companion_devices WHERE id = ?', [id]);
      if (dev.api_token_id) db.run('DELETE FROM api_tokens WHERE id = ?', [dev.api_token_id]);
    });
    return { data: { success: true } };
  });

  const pauseBody = z.object({ paused: z.boolean() });
  cr.post('/api/companion/pause-all', 'Pause or resume every automation and campaign in this workspace', (req) => {
    const a = canWrite(req);
    return { data: saveSettings(db, a.workspaceId, { paused: parse(pauseBody, req.body).paused }) };
  }, { body: pauseBody });

  // The packed extension, zipped on demand from extension/dist (built by `npm run build:extension`).
  let zipCache: { mtime: number; url: string; buf: Buffer } | null = null;
  app.get('/companion/extension.zip', { config: { public: true } }, (_req, reply) => {
    const m = join(EXTENSION_DIST, 'manifest.json');
    if (!existsSync(m)) return reply.code(404).send({ error: 'not_built', message: 'The extension is not built on this server. Run `npm run build:extension` (or `npm run build`) and reload.' });
    const mtime = statSync(m).mtimeMs;
    if (!zipCache || zipCache.mtime !== mtime || zipCache.url !== ctx.config.publicUrl) {
      const entries = dirEntries(EXTENSION_DIST).filter((e) => e.name !== 'kinetic.json');
      entries.push({ name: 'kinetic.json', data: Buffer.from(JSON.stringify({ url: ctx.config.publicUrl }, null, 2)) });
      zipCache = { mtime, url: ctx.config.publicUrl, buf: zip(entries) };
    }
    const version = manifest()?.version ?? 'dev';
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="kinetic-companion-${version}.zip"`).header('cache-control', 'no-cache');
    return reply.send(zipCache.buf);
  });

  // ---------------------------------------------------------------- automations
  const r = defineRoutes(app, 'Automations');

  r.get('/api/automations/phantoms', 'Automation catalogue (LinkedIn, Sales Navigator, Instagram, X, Facebook, Reddit, GitHub) with input schemas', (req) => {
    const a = auth(req);
    const paired = !!db.get('SELECT 1 FROM companion_devices WHERE workspace_id = ? LIMIT 1', [a.workspaceId]);
    const ai = aiReady(ctx.gtm!.settings);
    return {
      data: PHANTOMS.map((p) => ({ ...p, needs_extension: p.runner === 'extension', ready: p.runner === 'server' || paired, ai_ready: ai })),
      networks: Object.entries(NETWORK_LABELS).map(([id, label]) => ({ id, label })),
      limits: DEFAULT_LIMITS,
    };
  });

  const jobQuery = z.object({ phantom: z.string().optional(), category: z.enum(['data', 'action', 'monitor']).optional(), status: z.string().optional() });
  r.get('/api/automations/jobs', 'List automations (jobs) with status, progress and schedule', (req) => {
    const a = auth(req);
    const q = parse(jobQuery, req.query);
    const where = ['workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.phantom) { where.push('phantom = ?'); params.push(q.phantom); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.category) {
      const ids = PHANTOMS.filter((p) => p.category === q.category).map((p) => p.id);
      where.push(`phantom IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const rows = db.all<{ id: number }>(`SELECT id FROM companion_jobs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`, params);
    return { data: rows.map((x) => jobJson(ctx, loadJob(ctx, x.id))) };
  }, { query: jobQuery });

  const schedule = z.object({ every: z.enum(['hourly', 'daily', 'weekly']).nullable().optional() });
  const alerts = z.object({ slack: z.boolean().optional(), slack_channel: z.string().max(100).optional(), webhook_url: z.string().url().or(z.literal('')).optional() });
  const createBody = z.object({
    phantom: z.string().min(1), name: z.string().max(120).optional(), params: z.record(z.string(), z.any()).default({}),
    table_id: z.number().int().positive().optional(), table_name: z.string().max(80).optional(), column_map: z.record(z.string(), z.string()).optional(),
    schedule: schedule.optional(), watcher: z.boolean().optional(), alerts: alerts.optional(), start: z.boolean().optional(),
  });
  r.post('/api/automations/jobs', 'Create an automation from a phantom (results go to a new or existing table); action phantoms start as drafts', (req) => {
    const a = canWrite(req);
    const b = parse(createBody, req.body);
    return { data: jobJson(ctx, createJob(ctx, a.workspaceId, { ...b, schedule: b.schedule ? { every: b.schedule.every ?? null } : undefined }, now())) };
  }, { body: createBody });

  r.get('/api/automations/jobs/:id', 'Automation details with recent runs', (req) => {
    const a = auth(req);
    const job = loadJob(ctx, idParam(req), a.workspaceId);
    const runs = db.all('SELECT * FROM companion_runs WHERE job_id = ? ORDER BY id DESC LIMIT 50', [job.id]).map(runJson);
    return { data: { ...jobJson(ctx, job), runs } };
  });

  const patchBody = createBody.pick({ name: true, params: true, schedule: true, watcher: true, alerts: true, column_map: true }).partial();
  r.patch('/api/automations/jobs/:id', 'Update an automation (name, inputs, schedule, alerts, column mapping)', (req) => {
    const a = canWrite(req);
    const job = loadJob(ctx, idParam(req), a.workspaceId);
    const b = parse(patchBody, req.body);
    return { data: jobJson(ctx, updateJob(ctx, job, { ...b, schedule: b.schedule ? { every: b.schedule.every ?? null } : undefined }, now())) };
  }, { body: patchBody });

  const lifecycle = (path: string, summary: string, fn: (job: ReturnType<typeof loadJob>) => unknown) =>
    r.post(`/api/automations/jobs/:id/${path}`, summary, (req) => {
      const a = canWrite(req);
      const job = loadJob(ctx, idParam(req), a.workspaceId);
      fn(job);
      return { data: jobJson(ctx, loadJob(ctx, job.id)) };
    });
  lifecycle('start', 'Start an automation (sends LinkedIn actions for action phantoms — confirm with the user first)', (job) => {
    if (!['draft', 'completed', 'failed', 'cancelled'].includes(job.status)) throw new HttpError(409, { error: 'conflict', message: `The automation is already ${job.status}.` });
    startRun(ctx, job.id, now());
  });
  lifecycle('run-now', 'Run a scheduled/finished automation again now', (job) => {
    if (job.status === 'running') throw new HttpError(409, { error: 'conflict', message: 'The automation is already running.' });
    if (job.status === 'paused') resumeJob(ctx, job, now()); else startRun(ctx, job.id, now());
  });
  lifecycle('pause', 'Pause an automation', (job) => pauseJob(ctx, job, now()));
  lifecycle('resume', 'Resume a paused automation', (job) => resumeJob(ctx, job, now()));
  lifecycle('cancel', 'Cancel an automation and its queued tasks', (job) => cancelJob(ctx, job, now()));

  r.delete('/api/automations/jobs/:id', 'Delete an automation (its table is kept)', (req) => {
    const a = canWrite(req);
    const job = loadJob(ctx, idParam(req), a.workspaceId);
    db.run('DELETE FROM companion_jobs WHERE id = ?', [job.id]);
    return { data: { success: true } };
  });

  const taskQuery = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
  r.get('/api/automations/jobs/:id/tasks', 'Tasks of an automation (one per target / page) with status and errors', (req) => {
    const a = auth(req);
    const job = loadJob(ctx, idParam(req), a.workspaceId);
    const q = parse(taskQuery, req.query);
    const rows = db.all(`SELECT id, kind, status, target, error, attempts, results_count, not_before, updated_at FROM companion_tasks
      WHERE job_id = ? ${q.status ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT ?`, q.status ? [job.id, q.status, q.limit] : [job.id, q.limit]);
    return { data: rows.map((t) => ({ ...t, target: J(t.target) })) };
  }, { query: taskQuery });

  r.get('/api/automations/stats', 'Automation dashboard: limits used today/this week, jobs by status, 14-day runs and results', (req) => {
    const a = auth(req);
    const s = loadSettings(db, a.workspaceId);
    const jobs = { draft: 0, queued: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 } as Record<string, number>;
    for (const x of db.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM companion_jobs WHERE workspace_id = ? GROUP BY status', [a.workspaceId])) jobs[x.status] = x.n;
    const since = new Date(now().getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
    const runs = new Map(db.all<{ d: string; runs: number; results: number }>(`SELECT substr(started_at, 1, 10) d, COUNT(*) runs, SUM(new_results) results FROM companion_runs
      WHERE workspace_id = ? AND started_at >= ? GROUP BY d`, [a.workspaceId, since]).map((x) => [x.d, x]));
    const acts = new Map(db.all<{ d: string; n: number }>(`SELECT substr(at, 1, 10) d, SUM(count) n FROM companion_actions WHERE workspace_id = ? AND at >= ? AND action NOT LIKE '%.scrape' GROUP BY d`,
      [a.workspaceId, since]).map((x) => [x.d, x.n]));
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.parse(since) + i * 86_400_000).toISOString().slice(0, 10);
      return { date: d, runs: runs.get(d)?.runs ?? 0, results: runs.get(d)?.results ?? 0, actions: acts.get(d) ?? 0 };
    });
    const recent = db.all(`SELECT r.*, j.name AS job_name, j.phantom FROM companion_runs r JOIN companion_jobs j ON j.id = r.job_id WHERE r.workspace_id = ? ORDER BY r.id DESC LIMIT 20`, [a.workspaceId])
      .map((x) => ({ ...runJson(x), job_id: x.job_id, job_name: x.job_name, phantom: x.phantom }));
    const approvals = db.get<{ n: number }>(`SELECT COUNT(*) n FROM companion_approvals WHERE workspace_id = ? AND status = 'pending'`, [a.workspaceId])!.n;
    return { data: { limits: allUsage(db, a.workspaceId, s, now()).map(({ remaining: _r, ...u }) => u), jobs, days, recent_runs: recent, pending_approvals: approvals } };
  });

  r.get('/api/automations/settings', 'Automation limits, working hours, pacing delays and pause state', (req) => ({ data: loadSettings(db, auth(req).workspaceId) }));

  const days = z.object({ monday: z.boolean(), tuesday: z.boolean(), wednesday: z.boolean(), thursday: z.boolean(), friday: z.boolean(), saturday: z.boolean(), sunday: z.boolean() }).partial();
  const hm = z.string().regex(/^\d{2}:\d{2}$/);
  const settingsBody = z.object({
    limits: z.record(z.string(), z.object({ daily: z.number().int().min(0).max(100_000), weekly: z.number().int().min(0).max(1_000_000).nullable().optional() })).optional(),
    working_hours: z.object({ enabled: z.boolean().optional(), timezone: z.string().optional(), start: hm.optional(), end: hm.optional(), days: days.optional() }).optional(),
    delays: z.object({ action_min_sec: z.number().min(5).max(3600), action_max_sec: z.number().min(5).max(7200), page_min_sec: z.number().min(1).max(600), page_max_sec: z.number().min(1).max(1200) }).partial().optional(),
    max_actions_per_hour: z.number().int().min(1).max(200).optional(),
    paused: z.boolean().optional(),
    scrape_outside_hours: z.boolean().optional(),
  });
  r.put('/api/automations/settings', 'Update automation limits (per action, daily/weekly), working hours, pacing and pause', (req) => {
    const a = canWrite(req);
    const b = parse(settingsBody, req.body) as any;
    if (b.limits) for (const v of Object.values(b.limits) as any[]) if (v.weekly === undefined) v.weekly = null;
    return { data: saveSettings(db, a.workspaceId, b) };
  }, { body: settingsBody });

  // ---------------------------------------------------------------- approvals (AI comments)
  const approvalQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'posted', 'failed']).optional() });
  r.get('/api/automations/approvals', 'AI-drafted LinkedIn comments waiting for approval', (req) => {
    const a = auth(req);
    const q = parse(approvalQuery, req.query);
    const rows = db.all(`SELECT p.*, j.name AS job_name FROM companion_approvals p LEFT JOIN companion_jobs j ON j.id = p.job_id
      WHERE p.workspace_id = ? ${q.status ? 'AND p.status = ?' : ''} ORDER BY p.id DESC LIMIT 200`, q.status ? [a.workspaceId, q.status] : [a.workspaceId]);
    return { data: rows.map((x) => ({ id: x.id, job_id: x.job_id, job_name: x.job_name, kind: x.kind, target: J(x.target), context: x.context, draft: x.draft, status: x.status, created_at: x.created_at, decided_at: x.decided_at })) };
  }, { query: approvalQuery });

  const approveBody = z.object({ text: z.string().min(1).max(1250).optional() });
  r.post('/api/automations/approvals/:id/approve', 'Approve (optionally edit) an AI-drafted comment so the extension posts it', (req) => {
    const a = canWrite(req);
    const ap = db.get('SELECT * FROM companion_approvals WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!ap) throw notFound('approval');
    if (ap.status !== 'pending') throw new HttpError(409, { error: 'conflict', message: `Already ${ap.status}.` });
    const text = parse(approveBody, req.body ?? {}).text ?? ap.draft;
    if (!text?.trim()) throw new HttpError(422, { error: 'validation_error', message: 'The comment is empty — write it before approving.' });
    const iso = now().toISOString();
    const run = ap.job_id ? db.get<{ id: number }>(`SELECT id FROM companion_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1`, [ap.job_id]) : undefined;
    db.tx(() => {
      const taskId = db.insert('companion_tasks', {
        workspace_id: a.workspaceId, job_id: ap.job_id, run_id: run?.id ?? null, kind: 'linkedin.comment', site: 'linkedin', runner: 'extension', action: 'linkedin.comment',
        target: JSON.stringify({ postUrl: J(ap.target).postUrl, postUrn: J(ap.target).postUrn ?? null }), params: JSON.stringify({ text: text.trim() }), status: 'pending', priority: 2, created_at: iso, updated_at: iso,
      });
      db.run(`UPDATE companion_approvals SET status = 'approved', draft = ?, task_id = ?, decided_at = ? WHERE id = ?`, [text.trim(), taskId, iso, ap.id]);
      if (ap.job_id) {
        const job = loadJob(ctx, ap.job_id);
        if (job.status !== 'running' && job.status !== 'paused') {
          // The run waited for decisions; reopen it so the comment task is handed out.
          if (run) db.run(`UPDATE companion_runs SET status = 'running', finished_at = NULL WHERE id = ?`, [run.id]);
          db.update('companion_jobs', job.id, { status: 'running', updated_at: iso });
        }
      }
    });
    return { data: { success: true } };
  }, { body: approveBody });

  r.post('/api/automations/approvals/:id/reject', 'Reject an AI-drafted comment (nothing is posted)', (req) => {
    const a = canWrite(req);
    const ap = db.get('SELECT * FROM companion_approvals WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!ap) throw notFound('approval');
    db.run(`UPDATE companion_approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`, [now().toISOString(), ap.id]);
    const run = ap.job_id ? db.get<{ id: number }>(`SELECT id FROM companion_runs WHERE job_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, [ap.job_id]) : undefined;
    if (run) refreshRun(ctx, run.id, now());
    return { data: { success: true } };
  });

  const previewBody = z.object({ template: z.string().max(10_000), profile: z.record(z.string(), z.any()).optional(), ai_instructions: z.string().max(2000).optional(), max_length: z.number().int().optional() });
  r.post('/api/automations/preview-message', 'Preview a LinkedIn note/message template (variables, spintax, optional AI line) for a sample profile', async (req) => {
    auth(req);
    const b = parse(previewBody, req.body);
    const settings = ctx.gtm!.settings;
    const useAi = AI_TOKEN.test(b.template) && aiReady(settings);
    try {
      const r = await renderMessage({ template: b.template, profile: b.profile ?? {}, aiInstructions: b.ai_instructions, settings, preview: !useAi, maxLength: b.max_length });
      const missing = AI_TOKEN.test(b.template) && !useAi ? [...r.missing, 'ai_message (no AI model configured)'] : r.missing;
      return { data: { text: r.text, missing, ai_used: r.aiUsed } };
    } catch (e: any) {
      throw new HttpError(422, { error: 'render_failed', message: e.message });
    }
  }, { body: previewBody });

  linkedinCampaignRoutes(app, ctx);
}
