import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, type TestEnv } from './helpers.ts';
import { agentServices } from '../src/agent/routes.ts';
import { classify, classifyRoute } from '../src/agent/policy.ts';
import { builtinSkills, parseFrontmatter } from '../src/agent/skills.ts';
import { apiTool, grantApproval, truncateJson, type ToolEnv } from '../src/agent/tools.ts';
import { compactSchema, findEndpoints } from '../src/agent/endpoints.ts';
import { z } from 'zod';

/** Scripted OpenRouter: each call returns the next step; records request bodies. */
function scriptedLlm(steps: ({ tool: string; args: unknown } | { text: string })[]) {
  const bodies: any[] = [];
  let i = 0;
  const handler = (body: any) => {
    bodies.push(body);
    const s = steps[Math.min(i++, steps.length - 1)];
    const message = 'text' in s
      ? { role: 'assistant', content: s.text }
      : { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.002 } });
  };
  return { bodies, handler };
}

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

async function setup(llm?: (body: any) => Response, pages: Record<string, string> = {}) {
  env = await makeEnv({
    fetch: (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('openrouter.ai') && llm) return llm(JSON.parse(init.body));
      for (const [k, html] of Object.entries(pages)) if (u.startsWith(k)) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  if (llm) env.ctx.gtm!.settings.set('OPENROUTER_API_KEY', 'test-key');
  return env;
}

const agentOf = (e: TestEnv) => agentServices.get(e.app)!;

async function chatOnce(e: TestEnv, message: string) {
  const r = await e.api('POST', '/api/agent/sessions', { message });
  expect(r.status).toBe(200);
  await agentOf(e).idle(r.body.data.id);
  return (await e.api('GET', `/api/agent/sessions/${r.body.data.id}`)).body.data;
}

const toolEnv = (e: TestEnv): ToolEnv => {
  const ws = e.ctx.db.get('SELECT id FROM workspaces LIMIT 1')!.id;
  const user = e.ctx.db.get('SELECT id FROM users LIMIT 1')!.id;
  return { ctx: e.ctx, app: e.app, workspaceId: ws, userId: user, approvals: new Map() };
};

describe('agent loop', () => {
  it('loads a skill, creates a table through the API, then answers', async () => {
    const llm = scriptedLlm([
      { tool: 'load_skill', args: { name: 'build-prospect-list' } },
      { tool: 'api', args: { method: 'POST', path: '/api/gtm/tables', body: { name: 'Irish POS companies', template: 'companies' } } },
      { text: 'Created table **Irish POS companies**.' },
    ]);
    const e = await setup(llm.handler);
    const s = await chatOnce(e, 'Find 50 Irish POS companies and their CEO emails');

    expect(s.status).toBe('idle');
    expect(s.title).toBe('Find 50 Irish POS companies and their CEO emails');
    const tools = s.messages.filter((m: any) => m.role === 'tool');
    expect(tools.map((m: any) => [m.tool_name, m.status])).toEqual([['load_skill', 'done'], ['api', 'done']]);
    expect(tools[0].meta.label).toBe('Loaded skill build-prospect-list');
    expect(tools[0].content).toContain('# Skill: build-prospect-list');
    const table = e.ctx.db.get(`SELECT * FROM gtm_tables WHERE name = 'Irish POS companies'`);
    expect(table).toBeTruthy();
    expect(tools[1].meta.label).toBe(`POST /api/gtm/tables → created table #${table.id}`);
    expect(tools[1].meta.links).toEqual([{ label: `Table #${table.id}`, to: `/tables/${table.id}` }]);
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Created table **Irish POS companies**.' });

    // The model saw tools, the skills index and the workspace snapshot; tool results were fed back.
    expect(llm.bodies[0].tools.map((t: any) => t.function.name)).toEqual(['api', 'find_endpoints', 'list_skills', 'load_skill', 'knowledge', 'web_search', 'fetch_page', 'ask_user']);
    expect(llm.bodies[0].messages[0].content).toContain('- build-prospect-list:');
    expect(llm.bodies[0].model).toBe('anthropic/claude-haiku-5.5');
    expect(llm.bodies[2].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c2' });
    expect(llm.bodies[2].messages[0].content).toContain('"Irish POS companies"'); // snapshot is rebuilt each step
    expect(s.usage).toMatchObject({ prompt_tokens: 3000, completion_tokens: 300 });
    expect(s.usage.cost_usd).toBeCloseTo(0.006);
  });

  it('uses AGENT_MODEL, then a per-chat model', async () => {
    const llm = scriptedLlm([{ text: 'hi' }]);
    const e = await setup(llm.handler);
    e.ctx.gtm!.settings.set('AGENT_MODEL', 'google/gemini-3.8-flash');
    const s = await chatOnce(e, 'hello');
    expect(llm.bodies[0].model).toBe('google/gemini-3.8-flash');
    await e.api('POST', `/api/agent/sessions/${s.id}/messages`, { content: 'again', model: 'anthropic/claude-sonnet-5.5' });
    await agentOf(e).idle(s.id);
    expect(llm.bodies[1].model).toBe('anthropic/claude-sonnet-5.5');
  });

  it('ask_user pauses the run until the user answers', async () => {
    const llm = scriptedLlm([
      { tool: 'ask_user', args: { question: 'Which country?', options: ['Ireland', 'UK'] } },
      { text: 'Great, Ireland it is.' },
    ]);
    const e = await setup(llm.handler);
    const s = await chatOnce(e, 'Find POS companies');
    expect(s.status).toBe('waiting');
    const q = s.messages.find((m: any) => m.status === 'waiting');
    expect(q.meta.pause).toEqual({ type: 'question', question: 'Which country?', options: ['Ireland', 'UK'] });
    const r = await e.api('POST', `/api/agent/sessions/${s.id}/answer`, { message_id: q.id, answer: 'Ireland' });
    expect(r.status).toBe(200);
    await agentOf(e).idle(s.id);
    const after = (await e.api('GET', `/api/agent/sessions/${s.id}`)).body.data;
    expect(after.status).toBe('idle');
    expect(llm.bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'User answered: Ireland' });
  });

  it('reports a clear error without an AI key', async () => {
    const e = await setup();
    const s = await chatOnce(e, 'hello');
    expect(s.status).toBe('error');
    expect(s.messages.at(-1).content).toContain('OPENROUTER_API_KEY');
  });
});

describe('approval gating', () => {
  it('pauses risky calls for approval; declining leaves data alone', async () => {
    const llm = { h: (_b: any) => Response.json({}) };
    const e = await setup((b) => llm.h(b));
    const t = await e.api('POST', '/api/gtm/tables', { name: 'Keep me' });
    const steps = scriptedLlm([
      { tool: 'api', args: { method: 'DELETE', path: `/api/gtm/tables/${t.body.id}` } },
      { text: 'Okay, not deleted.' },
    ]);
    llm.h = steps.handler;

    const s = await chatOnce(e, 'Delete my table');
    expect(s.status).toBe('waiting');
    const pending = s.messages.find((m: any) => m.status === 'waiting');
    expect(pending.meta.pause).toMatchObject({ type: 'approval', reason: 'This deletes data.', request: { method: 'DELETE', path: `/api/gtm/tables/${t.body.id}` } });
    expect(e.ctx.db.get('SELECT 1 FROM gtm_tables WHERE id = ?', [t.body.id])).toBeTruthy();

    await e.api('POST', `/api/agent/sessions/${s.id}/answer`, { message_id: pending.id, approve: false });
    await agentOf(e).idle(s.id);
    expect(e.ctx.db.get('SELECT 1 FROM gtm_tables WHERE id = ?', [t.body.id])).toBeTruthy();
    expect(steps.bodies[1].messages.at(-1).content).toContain('declined');
  });

  it('runs the exact request once the user approves', async () => {
    const llm = { h: (_b: any) => Response.json({}) };
    const e = await setup((b) => llm.h(b));
    const t = await e.api('POST', '/api/gtm/tables', { name: 'Delete me' });
    llm.h = scriptedLlm([
      { tool: 'api', args: { method: 'DELETE', path: `/api/gtm/tables/${t.body.id}` } },
      { text: 'Deleted.' },
    ]).handler;
    const s = await chatOnce(e, 'Delete it');
    const pending = s.messages.find((m: any) => m.status === 'waiting');
    await e.api('POST', `/api/agent/sessions/${s.id}/answer`, { message_id: pending.id, approve: true });
    await agentOf(e).idle(s.id);
    expect(e.ctx.db.get('SELECT 1 FROM gtm_tables WHERE id = ?', [t.body.id])).toBeUndefined();
    const done = (await e.api('GET', `/api/agent/sessions/${s.id}`)).body.data.messages.find((m: any) => m.id === pending.id);
    expect(done.status).toBe('done');
    expect(done.meta.decision).toBe('approved');
  });

  it('api tool: risky routes need a matching single-use approval token', async () => {
    const e = await setup();
    const te = toolEnv(e);
    const c = await e.api('POST', '/api/campaigns', { name: 'Q4' });
    const launch = { method: 'POST', path: `/api/campaigns/${c.body.data.id}/launch` };

    const r1 = await apiTool(launch, te);
    expect(r1.kind).toBe('pause');
    const r2 = await apiTool(launch, te, 'made-up-token');
    expect(r2.kind).toBe('pause');
    const other = grantApproval(te, { method: 'POST', path: '/api/campaigns/999/launch' });
    expect((await apiTool(launch, te, other)).kind).toBe('pause');

    const token = grantApproval(te, launch);
    const r3 = await apiTool(launch, te, token);
    expect(r3.kind).toBe('result'); // ran (422: no senders/sequence yet, which is the route's own check)
    expect((r3 as any).content).toContain('HTTP 422');
    expect((await apiTool(launch, te, token)).kind).toBe('pause'); // token is single use

    // Replying to email and sending new mail are gated too.
    for (const path of ['/api/replies/1/reply', '/api/replies/1/forward', '/api/replies/new']) {
      expect(classifyRoute('POST', path)).toMatchObject({ kind: 'approve' });
    }
    expect(classifyRoute('PATCH', '/api/campaigns/3/resume')).toMatchObject({ kind: 'approve' });
    expect(classifyRoute('POST', '/api/linkedin/connect')).toMatchObject({ kind: 'approve' });
    expect(classifyRoute('POST', '/api/gtm/tables')).toEqual({ kind: 'allow' });
  });

  it('paid enrichment over 100 rows and outbound action columns need approval', async () => {
    const e = await setup();
    const te = toolEnv(e);
    const t = await e.api('POST', '/api/gtm/tables', { name: 'Big', template: 'find_emails' });
    await e.api('POST', `/api/gtm/tables/${t.body.id}/rows`, { count: 150 });
    const env2 = { db: e.ctx.db, settings: e.ctx.gtm!.settings, workspaceId: te.workspaceId };
    const run = `/api/gtm/tables/${t.body.id}/run`;
    expect(classify('POST', run, {}, env2).kind).toBe('allow'); // free waterfall only
    e.ctx.gtm!.settings.set('ICYPEAS_API_KEY', 'k');
    expect(classify('POST', run, {}, env2)).toMatchObject({ kind: 'approve' });
    expect(classify('POST', run, { rowIds: [1, 2, 3] }, env2).kind).toBe('allow');
    const col = await e.api('POST', `/api/gtm/tables/${t.body.id}/columns`, { name: 'Ping', type: 'action', config: { kind: 'slack', text: 'hi' } });
    expect(classify('POST', run, { columnIds: [col.body.id], rowIds: [1] }, env2)).toMatchObject({ kind: 'approve' });
  });
});

describe('denylist', () => {
  it('hard-denies auth, tokens, users, workspace delete/members and secrets', async () => {
    const e = await setup();
    const te = toolEnv(e);
    const cases: [string, string][] = [
      ['POST', '/api/auth/login'], ['POST', '/api/api-tokens'], ['GET', '/api/api-tokens'], ['DELETE', '/api/api-tokens/1'],
      ['PUT', '/api/users/password'], ['GET', '/api/users'], ['DELETE', '/api/workspaces/1'], ['PUT', '/api/workspaces/members/2'],
      ['POST', '/api/workspaces/v1.1/users'], ['POST', '/api/workspaces/switch-workspace'], ['PUT', '/api/gtm/keys'],
      ['POST', '/api/agent/sessions'], ['GET', '/api/gtm/tables/1/events'], ['GET', '/hooks/abc'],
    ];
    for (const [m, p] of cases) expect(classifyRoute(m, p), `${m} ${p}`).toMatchObject({ kind: 'deny' });

    const before = e.ctx.db.get('SELECT COUNT(*) n FROM api_tokens')!.n;
    const r = await apiTool({ method: 'POST', path: '/api/api-tokens', body: { name: 'x', type: 'super-admin' } }, te);
    expect(r).toMatchObject({ kind: 'result', ok: false });
    expect((r as any).content).toMatch(/^Blocked:/);
    expect(e.ctx.db.get('SELECT COUNT(*) n FROM api_tokens')!.n).toBe(before);
    expect((await apiTool({ method: 'GET', path: '/api/../api/users' }, te) as any).ok).toBe(false);

    // find_endpoints never offers denied routes.
    expect(findEndpoints('api token password login').some((x) => /api-tokens|users|auth/.test(x.path))).toBe(false);
    expect(findEndpoints('campaign launch').find((x) => x.path === '/api/campaigns/:id/launch')).toMatchObject({ needs_approval: true });
  });

  it('agent internal tokens cannot be forged from outside', async () => {
    const e = await setup();
    const r = await e.app.inject({ method: 'GET', url: '/api/gtm/tables', headers: { 'x-kinetic-agent-token': 'guess' } });
    expect(r.statusCode).toBe(401);
  });

  it('api tool acts as the user, scoped to the chat workspace, with truncated output', async () => {
    const e = await setup();
    const te = toolEnv(e);
    const t = await e.api('POST', '/api/gtm/tables', { name: 'Rows' });
    await e.api('POST', `/api/gtm/tables/${t.body.id}/rows`, { count: 60 });
    const r: any = await apiTool({ method: 'GET', path: `/api/gtm/tables/${t.body.id}` }, te);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('60 total');
    expect(r.content.length).toBeLessThan(6200);
    const other = e.ctx.db.insert('workspaces', { name: 'Other' });
    const foreign = e.ctx.db.insert('gtm_tables', { workspace_id: other, name: 'Secret', webhook_token: 'x1', schedule: '{}', created_at: 'x', updated_at: 'x' });
    const r2: any = await apiTool({ method: 'GET', path: `/api/gtm/tables/${foreign}` }, te);
    expect(r2.ok).toBe(false);
    expect(r2.content).toContain('HTTP 404');
  });

  it('truncates big JSON and summarises arrays', () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Row ${i}`, text: 'x'.repeat(300) })) };
    const s = truncateJson(big, 3000);
    expect(s.length).toBeLessThanOrEqual(3100);
    expect(s).toContain('500 total');
  });

  it('describes zod bodies compactly', () => {
    const s = compactSchema(z.object({ mode: z.enum(['companies', 'people']), query: z.string(), limit: z.number().int().default(100) }));
    expect(s).toBe('{mode: "companies"|"people", query: string, limit?: number = 100}');
  });
});

describe('skills', () => {
  it('parses frontmatter', () => {
    const { meta, body } = parseFrontmatter('---\nname: my-skill\ndescription: "Use when: things"\n  continue here\n---\n# Title\nSteps');
    expect(meta).toEqual({ name: 'my-skill', description: 'Use when: things continue here' });
    expect(body).toBe('# Title\nSteps');
  });

  it('loads every *.md in the skills folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    writeFileSync(join(dir, 'a.md'), '---\nname: alpha\ndescription: First\n---\nBody A');
    writeFileSync(join(dir, 'b.md'), '# No frontmatter\nUse this for B things.');
    writeFileSync(join(dir, 'c.txt'), 'ignored');
    const s = builtinSkills(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(s.map((x) => [x.name, x.description])).toEqual([['alpha', 'First'], ['b', 'Use this for B things.']]);
  });

  it('ships the built-in skills with names and descriptions', () => {
    const names = builtinSkills().map((s) => s.name);
    for (const n of ['build-prospect-list', 'table-building', 'enrich-emails-and-phones', 'signals-monitoring', 'campaign-from-table', 'inbox-triage-basics', 'knowledge-hub']) expect(names).toContain(n);
    for (const s of builtinSkills()) {
      expect(s.description.length, s.name).toBeGreaterThan(20);
      expect(s.body, s.name).toMatch(/\/api\//);
    }
  });

  it('custom skills: CRUD, no built-in name clashes, usable by load_skill', async () => {
    const llm = scriptedLlm([{ tool: 'load_skill', args: { name: 'irish-pos' } }, { text: 'done' }]);
    const e = await setup(llm.handler);
    const c = await e.api('POST', '/api/agent/skills', { name: 'irish-pos', description: 'Irish point-of-sale prospecting', body: 'Use POST /api/gtm/find with mode companies.' });
    expect(c.status).toBe(200);
    expect((await e.api('POST', '/api/agent/skills', { name: 'table-building', description: 'x' })).status).toBe(409);
    expect((await e.api('POST', '/api/agent/skills', { name: 'Bad Name!', description: 'x' })).status).toBe(422);
    const list = (await e.api('GET', '/api/agent/skills')).body.data;
    expect(list.find((s: any) => s.name === 'irish-pos')).toMatchObject({ builtin: false });
    expect(list.find((s: any) => s.name === 'table-building')).toMatchObject({ builtin: true });

    const s = await chatOnce(e, 'go');
    expect(s.messages.find((m: any) => m.role === 'tool').content).toContain('Use POST /api/gtm/find');
    expect(llm.bodies[0].messages[0].content).toContain('- irish-pos: Irish point-of-sale prospecting');

    const u = await e.api('PUT', `/api/agent/skills/${c.body.data.id}`, { name: 'irish-pos', description: 'Updated', body: 'New body' });
    expect(u.body.data.description).toBe('Updated');
    expect((await e.api('GET', '/api/agent/skills/irish-pos')).body.data.body).toBe('New body');
    expect((await e.api('DELETE', `/api/agent/skills/${c.body.data.id}`)).status).toBe(200);
    expect((await e.api('GET', '/api/agent/skills/irish-pos')).status).toBe(404);
  });
});
