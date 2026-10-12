import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db/db.ts';
import { auth, canWrite, defineRoutes, HttpError, idParam, notFound, parse } from '../http.ts';
import { listModels } from '../gtm/engine/agent.ts';
import { agentModel, aiReady } from './llm.ts';
import { AgentService, messageJson, sessionJson } from './service.ts';
import { builtinSkills, customSkills, findSkill, SKILL_NAME_RE } from './skills.ts';

/** The running agent service per app (tests wait on runs through it). */
export const agentServices = new WeakMap<FastifyInstance, AgentService>();

export function agentRoutes(app: FastifyInstance, ctx: Ctx): AgentService {
  const agent = new AgentService(ctx, app);
  agentServices.set(app, agent);
  app.addHook('onClose', async () => agent.shutdown());
  const r = defineRoutes(app, 'Kinetic Agent');
  const { db } = ctx;
  const settings = () => ctx.gtm!.settings;

  /** The session, verified to belong to the caller's workspace and user. */
  const sessionOf = (req: any) => {
    const a = auth(req);
    const s = db.get('SELECT * FROM agent_sessions WHERE id = ? AND workspace_id = ? AND user_id = ?', [idParam(req), a.workspaceId, a.userId]);
    if (!s) throw notFound('chat');
    return s;
  };
  const conflict = (fn: () => unknown) => {
    try { return fn(); } catch (e: any) {
      if (e.statusCode === 409) throw new HttpError(409, { error: 'conflict', message: e.message });
      throw e;
    }
  };

  r.get('/api/agent/config', 'Agent models, default model and whether AI is configured', async () => ({
    data: { models: await listModels(), defaultModel: agentModel(settings()), aiReady: aiReady(settings()) },
  }));

  // ---- sessions ----
  r.get('/api/agent/sessions', 'List agent chats', (req) => {
    const a = auth(req);
    return { data: db.all('SELECT * FROM agent_sessions WHERE workspace_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 200', [a.workspaceId, a.userId]).map(sessionJson) };
  });

  const createBody = z.object({ message: z.string().trim().max(20_000).optional(), model: z.string().max(200).nullable().optional(), title: z.string().trim().max(200).optional() });
  r.post('/api/agent/sessions', 'Start an agent chat (optionally with a first message)', (req) => {
    const a = canWrite(req);
    const b = parse(createBody, req.body ?? {});
    const id = agent.createSession(a.workspaceId, a.userId, { title: b.title, model: b.model });
    if (b.message) agent.send(id, b.message);
    return { data: sessionJson(agent.session(id)!) };
  }, { body: createBody });

  r.get('/api/agent/sessions/:id', 'Get an agent chat with its messages and tool steps', (req) => {
    const s = sessionOf(req);
    return { data: { ...sessionJson(s), running: agent.isRunning(s.id), messages: agent.messages(s.id).map(messageJson) } };
  });

  const patchBody = z.object({ title: z.string().trim().min(1).max(200).optional(), model: z.string().max(200).nullable().optional() });
  r.patch('/api/agent/sessions/:id', 'Rename an agent chat or change its model', (req) => {
    const s = sessionOf(req);
    canWrite(req);
    const b = parse(patchBody, req.body);
    db.update('agent_sessions', s.id, { ...(b.title ? { title: b.title } : {}), ...(b.model !== undefined ? { model: b.model || null } : {}), updated_at: nowIso() });
    return { data: sessionJson(agent.session(s.id)!) };
  }, { body: patchBody });

  r.delete('/api/agent/sessions/:id', 'Delete an agent chat', (req) => {
    const s = sessionOf(req);
    canWrite(req);
    agent.stop(s.id);
    db.run('DELETE FROM agent_sessions WHERE id = ?', [s.id]);
    return { ok: true };
  });

  const msgBody = z.object({ content: z.string().trim().min(1).max(20_000), model: z.string().max(200).nullable().optional() });
  r.post('/api/agent/sessions/:id/messages', 'Send a message to the agent (runs in the background)', (req) => {
    const s = sessionOf(req);
    canWrite(req);
    const b = parse(msgBody, req.body);
    conflict(() => agent.send(s.id, b.content, b.model));
    return { data: sessionJson(agent.session(s.id)!) };
  }, { body: msgBody });

  const answerBody = z.object({ message_id: z.number().int().positive(), answer: z.string().max(5000).optional(), approve: z.boolean().optional() });
  r.post('/api/agent/sessions/:id/answer', 'Answer the agent’s question, or approve/decline a risky action', async (req) => {
    const s = sessionOf(req);
    canWrite(req);
    const b = parse(answerBody, req.body);
    try { await agent.answer(s.id, b.message_id, b); } catch (e: any) {
      if (e.statusCode === 409) throw new HttpError(409, { error: 'conflict', message: e.message });
      throw e;
    }
    return { data: sessionJson(agent.session(s.id)!) };
  }, { body: answerBody });

  r.post('/api/agent/sessions/:id/stop', 'Stop the agent', (req) => {
    const s = sessionOf(req);
    return { data: { stopped: agent.stop(s.id) } };
  });

  // Live progress (not in the API reference: it's a stream).
  app.get('/api/agent/sessions/:id/events', (req, reply) => {
    const s = sessionOf(req);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: 'session', data: sessionJson(agent.session(s.id) ?? s) });
    const listener = (e: unknown) => send(e);
    agent.bus.on(`session:${s.id}`, listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { clearInterval(ping); agent.bus.off(`session:${s.id}`, listener); });
  });

  // ---- skills ----
  r.get('/api/agent/skills', 'List agent skills: built-in (read-only) and custom', (req) => {
    const a = auth(req);
    return { data: [...builtinSkills(), ...customSkills(db, a.workspaceId)] };
  });

  r.get('/api/agent/skills/:id', 'Get one agent skill by name (or custom skill id)', (req) => {
    const a = auth(req);
    const key = String((req.params as any).id);
    const s = /^\d+$/.test(key) ? customSkills(db, a.workspaceId).find((x) => x.id === Number(key)) : findSkill(db, a.workspaceId, key);
    if (!s) throw notFound('skill');
    return { data: s };
  });

  const skillBody = z.object({
    name: z.string().trim().toLowerCase().regex(SKILL_NAME_RE, 'use lowercase letters, numbers and dashes (2-63 chars)'),
    description: z.string().trim().min(1).max(1000),
    body: z.string().max(100_000).default(''),
  });
  const nameFree = (ws: number, name: string, exceptId?: number) => {
    if (builtinSkills().some((s) => s.name === name)) throw new HttpError(409, { error: 'conflict', message: `"${name}" is a built-in skill name` });
    const other = db.get('SELECT id FROM agent_skills WHERE workspace_id = ? AND name = ?', [ws, name]);
    if (other && other.id !== exceptId) throw new HttpError(409, { error: 'conflict', message: `A skill named "${name}" already exists` });
  };
  r.post('/api/agent/skills', 'Create a custom agent skill (markdown instructions)', (req) => {
    const a = canWrite(req);
    const b = parse(skillBody, req.body);
    nameFree(a.workspaceId, b.name);
    const now = nowIso();
    const id = db.insert('agent_skills', { workspace_id: a.workspaceId, name: b.name, description: b.description, body: b.body, created_at: now, updated_at: now });
    return { data: customSkills(db, a.workspaceId).find((s) => s.id === id) };
  }, { body: skillBody });

  const skillOf = (req: any, ws: number) => {
    const s = db.get('SELECT * FROM agent_skills WHERE id = ? AND workspace_id = ?', [idParam(req), ws]);
    if (!s) throw notFound('skill');
    return s;
  };
  r.put('/api/agent/skills/:id', 'Update a custom agent skill', (req) => {
    const a = canWrite(req);
    const s = skillOf(req, a.workspaceId);
    const b = parse(skillBody, req.body);
    nameFree(a.workspaceId, b.name, s.id);
    db.update('agent_skills', s.id, { name: b.name, description: b.description, body: b.body, updated_at: nowIso() });
    return { data: customSkills(db, a.workspaceId).find((x) => x.id === s.id) };
  }, { body: skillBody });

  r.delete('/api/agent/skills/:id', 'Delete a custom agent skill', (req) => {
    const a = canWrite(req);
    db.run('DELETE FROM agent_skills WHERE id = ?', [skillOf(req, a.workspaceId).id]);
    return { ok: true };
  });

  return agent;
}
