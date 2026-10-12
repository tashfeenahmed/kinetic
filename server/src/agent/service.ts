/**
 * Kinetic Agent: a ReAct loop over OpenRouter tool calling. Turns run in the
 * background (the user can navigate away); every message and tool step is persisted
 * and streamed to open browsers. A run pauses on `ask_user` or on an api call that
 * needs approval, and resumes when the user answers.
 */
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { nowIso, type Row } from '../db/db.ts';
import { agentModel, chat, type ToolCall } from './llm.ts';
import { allSkills, skillsIndex } from './skills.ts';
import { apiTool, grantApproval, runTool, TOOLS, type ApiRequest, type ToolEnv } from './tools.ts';
import { knowledgeContext } from '../knowledge/store.ts';

export const MAX_STEPS = 40;

export interface SessionEvent { type: 'message' | 'session'; data: unknown }

export function messageJson(m: Row) {
  return {
    id: m.id, role: m.role, content: m.content, status: m.status, tool_name: m.tool_name, tool_call_id: m.tool_call_id,
    tool_args: m.tool_args ? safeJson(m.tool_args) : null, tool_calls: m.tool_calls ? safeJson(m.tool_calls) : null,
    meta: safeJson(m.meta) ?? {}, created_at: m.created_at,
  };
}

export function sessionJson(s: Row) {
  return {
    id: s.id, title: s.title, model: s.model, status: s.status, error: s.error,
    usage: { prompt_tokens: s.prompt_tokens, completion_tokens: s.completion_tokens, cost_usd: s.cost_usd },
    created_at: s.created_at, updated_at: s.updated_at,
  };
}

function safeJson(s: string | null) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export class AgentService {
  readonly bus = new EventEmitter();
  private ctx: Ctx;
  private app: FastifyInstance;
  private running = new Map<number, { stopped: boolean; done: Promise<void> }>();
  private approvals = new Map<number, Map<string, string>>();

  constructor(ctx: Ctx, app: FastifyInstance) {
    this.ctx = ctx;
    this.app = app;
    this.bus.setMaxListeners(200);
    // Runs don't survive a restart: settle anything left mid-flight.
    ctx.db.run(`UPDATE agent_messages SET status = 'failed', content = 'Interrupted (server restarted).' WHERE status = 'running'`);
    ctx.db.run(`UPDATE agent_sessions SET status = 'idle' WHERE status = 'running'`);
  }

  private get db() { return this.ctx.db; }

  session(id: number): Row | undefined {
    return this.db.get('SELECT * FROM agent_sessions WHERE id = ?', [id]);
  }

  messages(sessionId: number): Row[] {
    return this.db.all('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY id', [sessionId]);
  }

  createSession(workspaceId: number, userId: number, opts: { title?: string; model?: string | null } = {}): number {
    const now = nowIso();
    return this.db.insert('agent_sessions', { workspace_id: workspaceId, user_id: userId, title: opts.title || 'New chat', model: opts.model || null, status: 'idle', created_at: now, updated_at: now });
  }

  isRunning(sessionId: number) {
    return this.running.has(sessionId);
  }

  /** Resolves when the session's current run finishes (tests, shutdown). */
  async idle(sessionId: number) {
    await this.running.get(sessionId)?.done;
  }

  private publish(sessionId: number, e: SessionEvent) {
    this.bus.emit(`session:${sessionId}`, e);
  }

  private touch(sessionId: number, patch: Row = {}) {
    this.db.update('agent_sessions', sessionId, { ...patch, updated_at: nowIso() });
    this.publish(sessionId, { type: 'session', data: sessionJson(this.session(sessionId)!) });
  }

  private addMessage(sessionId: number, m: Row): number {
    const id = this.db.insert('agent_messages', { session_id: sessionId, created_at: nowIso(), meta: '{}', status: 'done', content: '', ...m });
    this.publish(sessionId, { type: 'message', data: messageJson(this.db.get('SELECT * FROM agent_messages WHERE id = ?', [id])!) });
    return id;
  }

  private updateMessage(sessionId: number, id: number, patch: Row) {
    this.db.update('agent_messages', id, patch);
    this.publish(sessionId, { type: 'message', data: messageJson(this.db.get('SELECT * FROM agent_messages WHERE id = ?', [id])!) });
  }

  /** A new user message. Starts a run unless one is already going. */
  send(sessionId: number, content: string, model?: string | null) {
    const s = this.session(sessionId);
    if (!s) throw new Error('Session not found');
    if (this.running.has(sessionId)) throw Object.assign(new Error('The agent is still working — stop it or wait.'), { statusCode: 409 });
    // A new message supersedes any pending question/approval.
    for (const m of this.db.all(`SELECT id FROM agent_messages WHERE session_id = ? AND status = 'waiting'`, [sessionId])) {
      this.updateMessage(sessionId, m.id, { status: 'skipped', content: 'The user moved on without answering.' });
    }
    const first = !this.db.get(`SELECT 1 FROM agent_messages WHERE session_id = ? AND role = 'user'`, [sessionId]);
    this.addMessage(sessionId, { role: 'user', content });
    this.touch(sessionId, { ...(first && s.title === 'New chat' ? { title: titleFrom(content) } : {}), ...(model !== undefined ? { model: model || null } : {}), error: null });
    this.start(sessionId);
  }

  /** The user's answer to ask_user, or Approve/Reject on a risky api call. */
  async answer(sessionId: number, messageId: number, a: { answer?: string; approve?: boolean }) {
    const m = this.db.get(`SELECT * FROM agent_messages WHERE id = ? AND session_id = ? AND status = 'waiting'`, [messageId, sessionId]);
    if (!m) throw Object.assign(new Error('Nothing is waiting for an answer here.'), { statusCode: 409 });
    if (this.running.has(sessionId)) throw Object.assign(new Error('The agent is still working.'), { statusCode: 409 });
    const meta = safeJson(m.meta) ?? {};
    if (meta.pause?.type === 'approval') {
      const req: ApiRequest = meta.pause.request;
      if (a.approve) {
        this.updateMessage(sessionId, m.id, { status: 'running', meta: JSON.stringify({ ...meta, decision: 'approved' }) });
        const env = this.env(sessionId);
        const token = grantApproval(env, req);
        const out = await apiTool(req, env, token);
        if (out.kind === 'result') {
          this.updateMessage(sessionId, m.id, { status: out.ok ? 'done' : 'failed', content: `The user approved.\n${out.content}`, meta: JSON.stringify({ ...meta, decision: 'approved', label: out.label, links: out.links ?? [] }) });
        } else {
          this.updateMessage(sessionId, m.id, { status: 'failed', content: 'Approval could not be applied.', meta: JSON.stringify({ ...meta, decision: 'approved' }) });
        }
      } else {
        const why = a.answer?.trim() ? ` They said: ${a.answer.trim()}` : '';
        this.updateMessage(sessionId, m.id, { status: 'done', content: `The user declined this request; it was not run.${why}`, meta: JSON.stringify({ ...meta, decision: 'declined', label: `${meta.label?.replace(/ — needs your approval$/, '') ?? 'Request'} → declined` }) });
      }
    } else {
      const text = (a.answer ?? '').trim() || (a.approve === true ? 'Yes' : a.approve === false ? 'No' : '');
      this.updateMessage(sessionId, m.id, { status: 'done', content: `User answered: ${text}`, meta: JSON.stringify({ ...meta, answer: text }) });
    }
    this.start(sessionId);
  }

  stop(sessionId: number) {
    const r = this.running.get(sessionId);
    if (r) r.stopped = true;
    this.running.delete(sessionId); // the old loop sees `stopped` and exits without writing
    for (const m of this.db.all(`SELECT id FROM agent_messages WHERE session_id = ? AND status IN ('running','waiting')`, [sessionId])) {
      this.updateMessage(sessionId, m.id, { status: 'skipped', content: 'Stopped by the user.' });
    }
    this.touch(sessionId, { status: 'idle' });
    return !!r;
  }

  /** App shutdown: let in-flight runs exit without touching the database. */
  shutdown() {
    for (const r of this.running.values()) r.stopped = true;
    this.running.clear();
  }

  private env(sessionId: number): ToolEnv {
    const s = this.session(sessionId)!;
    if (!this.approvals.has(sessionId)) this.approvals.set(sessionId, new Map());
    return { ctx: this.ctx, app: this.app, workspaceId: s.workspace_id, userId: s.user_id, approvals: this.approvals.get(sessionId)! };
  }

  private start(sessionId: number) {
    const state = { stopped: false, done: Promise.resolve() };
    state.done = this.loop(sessionId, state)
      .catch((e: any) => {
        this.ctx.log.error({ err: e, sessionId }, 'agent run failed');
        if (!state.stopped) {
          this.addMessage(sessionId, { role: 'assistant', content: `Something went wrong: ${e.message}`, meta: JSON.stringify({ error: true }) });
          this.touch(sessionId, { status: 'error', error: String(e.message).slice(0, 500) });
        }
      })
      .finally(() => { if (this.running.get(sessionId) === state) this.running.delete(sessionId); });
    this.running.set(sessionId, state);
  }

  private async loop(sessionId: number, state: { stopped: boolean }) {
    this.touch(sessionId, { status: 'running', error: null });
    const settings = this.ctx.gtm!.settings;
    const env = this.env(sessionId);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (state.stopped) return;
      const s = this.session(sessionId)!;
      const r = await chat(settings, { model: agentModel(settings, s.model), messages: this.buildMessages(s), tools: TOOLS, max_tokens: 4000 });
      if (state.stopped) return;
      this.db.run('UPDATE agent_sessions SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?',
        [r.usage.prompt, r.usage.completion, r.usage.costUsd, sessionId]);
      const calls = (r.message.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}`, type: 'function' as const }));
      this.addMessage(sessionId, { role: 'assistant', content: r.message.content ?? '', tool_calls: calls.length ? JSON.stringify(calls) : null });
      if (!calls.length) {
        this.touch(sessionId, { status: 'idle' });
        return;
      }
      const paused = await this.runCalls(sessionId, calls, env, state);
      if (state.stopped) return;
      if (paused) {
        this.touch(sessionId, { status: 'waiting' });
        return;
      }
      this.touch(sessionId);
    }
    this.addMessage(sessionId, { role: 'assistant', content: `I stopped after ${MAX_STEPS} steps. Say “continue” and I’ll pick up where I left off.` });
    this.touch(sessionId, { status: 'idle' });
  }

  /** Runs one assistant message's tool calls in order. True when one paused for the user. */
  private async runCalls(sessionId: number, calls: ToolCall[], env: ToolEnv, state: { stopped: boolean }): Promise<boolean> {
    let paused = false;
    for (const call of calls) {
      const name = call.function?.name ?? '';
      let args: any = {};
      let badArgs = false;
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { badArgs = true; }
      const base = { role: 'tool', tool_call_id: call.id, tool_name: name, tool_args: JSON.stringify(args) };
      if (paused || state.stopped) {
        this.addMessage(sessionId, { ...base, status: 'skipped', content: 'Not run: waiting for the user on an earlier step. Call it again afterwards if it is still needed.' });
        continue;
      }
      if (badArgs) {
        this.addMessage(sessionId, { ...base, status: 'failed', content: 'Error: arguments were not valid JSON.', meta: JSON.stringify({ label: `${name}: invalid arguments` }) });
        continue;
      }
      const id = this.addMessage(sessionId, { ...base, status: 'running', meta: JSON.stringify({ label: runningLabel(name, args) }) });
      const out = await runTool(name, args, env);
      if (state.stopped) return false;
      if (out.kind === 'pause') {
        paused = true;
        this.updateMessage(sessionId, id, { status: 'waiting', content: '', meta: JSON.stringify({ label: out.label, pause: out.pause }) });
      } else {
        this.updateMessage(sessionId, id, { status: out.ok ? 'done' : 'failed', content: out.content, meta: JSON.stringify({ label: out.label, links: out.links ?? [] }) });
      }
    }
    return paused;
  }

  /** System prompt + the conversation in OpenAI format. Older tool output is trimmed. */
  buildMessages(s: Row): unknown[] {
    const rows = this.messages(s.id);
    const recentFrom = Math.max(0, rows.length - 14);
    const out: unknown[] = [{ role: 'system', content: this.systemPrompt(s.workspace_id) }];
    rows.forEach((m, i) => {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const calls = safeJson(m.tool_calls);
        out.push({ role: 'assistant', content: m.content || '', ...(calls?.length ? { tool_calls: calls } : {}) });
      } else if (m.role === 'tool') {
        const content = m.content || (m.status === 'waiting' ? 'Waiting for the user.' : '(no output)');
        out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: i < recentFrom && content.length > 1500 ? `${content.slice(0, 1500)}… [older output trimmed]` : content });
      }
    });
    return out;
  }

  systemPrompt(workspaceId: number): string {
    const db = this.db;
    const ws = db.get('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
    const tables = db.all(`SELECT t.id, t.name, (SELECT COUNT(*) FROM gtm_rows r WHERE r.table_id = t.id) AS rows FROM gtm_tables t WHERE t.workspace_id = ? ORDER BY t.updated_at DESC LIMIT 30`, [workspaceId]);
    const campaigns = db.all(`SELECT id, name, status FROM campaigns WHERE workspace_id = ? AND status != 'archived' ORDER BY id DESC LIMIT 30`, [workspaceId]);
    const senders = db.get<{ n: number }>('SELECT COUNT(*) n FROM sender_emails WHERE workspace_id = ?', [workspaceId])!.n;
    const leads = db.get<{ n: number }>('SELECT COUNT(*) n FROM leads WHERE workspace_id = ?', [workspaceId])!.n;
    const lists = db.all('SELECT id, name FROM lead_lists WHERE workspace_id = ? ORDER BY id DESC LIMIT 15', [workspaceId]);
    const kb = knowledgeContext(this.ctx, workspaceId, 3000);
    const skills = skillsIndex(allSkills(db, workspaceId));
    const settings = this.ctx.gtm!.settings;
    const keys = ['OPENROUTER_API_KEY', 'SERPER_API_KEY', 'GITHUB_TOKEN', 'APOLLO_API_KEY', 'HUNTER_API_KEY', 'ICYPEAS_API_KEY', 'MILLIONVERIFIER_API_KEY', 'PDL_API_KEY', 'SLACK_WEBHOOK_URL'] as const;
    return `You are the Kinetic Agent, an expert go-to-market operator working inside Kinetic, a self-hosted GTM platform (Clay-style tables with enrichment, AI research and signals + cold email outreach).
You DO the work by calling Kinetic's API with the \`api\` tool, as the user, in their current workspace. Today is ${new Date().toISOString().slice(0, 10)}.

How to work:
- Before a task, load the matching skill with load_skill (index below) and follow it. If no skill fits, use find_endpoints.
- Prefer few, well-aimed calls. Read responses: ids you need are in them. Don't invent ids — list or create things first.
- Free sources and providers first; mention when something would cost money.
- Ask the user (ask_user) when key details are missing or ambiguous, and before anything destructive or outbound: deleting data, launching/resuming campaigns, sending any email, any LinkedIn/social action, or paid enrichment over ~100 rows. Risky api calls also pause for the user's Approve click automatically — when that happens just wait; don't retry around it.
- Never try to read or change API keys, tokens, passwords or workspace members.
- Use the Knowledge Hub (below / knowledge tool) to target the right companies and personas and to write on-brand copy. Respect its exclusions.
- When done, reply briefly: what you built (with table/campaign ids), what's still running in the background, and suggested next steps. Use short markdown.

Workspace "${ws?.name ?? workspaceId}" snapshot (live: refreshed every step, so it already includes anything you created earlier in this chat):
- Tables (${tables.length}): ${tables.map((t) => `#${t.id} "${t.name}" (${t.rows} rows)`).join('; ') || 'none yet'}
- Campaigns (${campaigns.length}): ${campaigns.map((c) => `#${c.id} "${c.name}" [${c.status}]`).join('; ') || 'none yet'}
- Sender mailboxes: ${senders}; leads: ${leads}; lead lists: ${lists.map((l) => `#${l.id} "${l.name}"`).join(', ') || 'none'}
- Keys set: ${keys.filter((k) => settings.has(k)).join(', ') || 'none (free sources only)'}

Knowledge Hub:
${kb || '(empty — the user can fill it on the Knowledge page; suggest it when targeting or copy matters)'}

Skills (load_skill name):
${skills || '(none)'}`;
  }
}

function runningLabel(name: string, args: any): string {
  switch (name) {
    case 'api': return `${String(args.method ?? 'GET').toUpperCase()} ${args.path ?? ''}`;
    case 'load_skill': return `Loading skill ${args.name ?? ''}`;
    case 'find_endpoints': return `Searching endpoints “${args.query ?? ''}”`;
    case 'web_search': return `Searching the web “${args.query ?? ''}”`;
    case 'fetch_page': return `Reading ${args.url ?? ''}`;
    case 'knowledge': return 'Reading Knowledge Hub';
    case 'ask_user': return 'Asking you';
    default: return name;
  }
}

export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 60) return one || 'New chat';
  const cut = one.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
}
