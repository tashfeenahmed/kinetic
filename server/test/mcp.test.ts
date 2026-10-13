import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

async function setup() {
  env = await makeEnv();
  const tok = await env.api('POST', '/api/api-tokens', { name: 'Claude Code', type: 'api-user' });
  const token = tok.body.data.plain_text_token as string;
  const e = env;
  const rpc = async (method: string, params?: unknown, opts: { headers?: Record<string, string>; id?: number | null } = {}) => {
    const res = await e.app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...opts.headers },
      payload: { jsonrpc: '2.0', ...(opts.id === null ? {} : { id: opts.id ?? 1 }), method, ...(params ? { params } : {}) },
    });
    return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
  };
  return { e, token, rpc };
}

const call = (name: string, args: unknown) => ['tools/call', { name, arguments: args }] as const;

describe('MCP server', () => {
  it('initializes (handshake era), lists the agent tools and answers ping', async () => {
    const { rpc } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kinetic' } });
    expect(init.body.result.instructions).toContain('load_skill');
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-11-25');

    expect((await rpc('notifications/initialized', undefined, { id: null })).status).toBe(202);
    expect((await rpc('ping')).body.result).toEqual({});

    const list = await rpc('tools/list');
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['api', 'find_endpoints', 'list_skills', 'load_skill', 'knowledge', 'web_search', 'fetch_page']);
    expect(list.body.result.tools[0].inputSchema).toMatchObject({ type: 'object', required: ['method', 'path'] });
    expect((await rpc('nope/method')).body.error.code).toBe(-32601);
  });

  it('serves per-request (2026-07-28) clients with header checks and server/discover', async () => {
    const { rpc } = await setup();
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const h = (method: string, extra: Record<string, string> = {}) => ({ headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...extra } });
    const d = await rpc('server/discover', { _meta: meta }, h('server/discover'));
    expect(d.body.result).toMatchObject({ resultType: 'complete', supportedVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']), capabilities: { tools: {} } });
    expect(d.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('kinetic');

    const tl = await rpc('tools/list', { _meta: meta }, h('tools/list'));
    expect(tl.body.result).toMatchObject({ resultType: 'complete', ttlMs: expect.any(Number), cacheScope: 'public' });

    const t = await rpc('tools/call', { name: 'list_skills', arguments: {}, _meta: meta }, h('tools/call', { 'mcp-name': 'list_skills' }));
    expect(t.body.result).toMatchObject({ resultType: 'complete', isError: false });
    expect(t.body.result.content[0].text).toContain('table-building');

    const mismatch = await rpc('tools/call', { name: 'list_skills', arguments: {}, _meta: meta }, h('tools/call', { 'mcp-name': 'api' }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const old = await rpc('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } }, { headers: { 'mcp-protocol-version': '2030-01-01', 'mcp-method': 'tools/list' } });
    expect(old.status).toBe(400);
    expect(old.body.error).toMatchObject({ code: -32022, data: { requested: '2030-01-01' } });
    const unknown = await rpc('nope/method', { _meta: meta }, h('nope/method'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(-32601);
  });

  it('calls the API as the token\'s user and keeps hard-denied routes denied', async () => {
    const { e, rpc } = await setup();
    await e.api('POST', '/api/gtm/tables', { name: 'From MCP test' });
    const ok = await rpc(...call('api', { method: 'GET', path: '/api/gtm/tables' }));
    expect(ok.body.result.isError).toBe(false);
    expect(ok.body.result.content[0].text).toMatch(/^HTTP 200/);
    expect(ok.body.result.content[0].text).toContain('From MCP test');

    const denied = await rpc(...call('api', { method: 'GET', path: '/api/api-tokens' }));
    expect(denied.body.result.isError).toBe(true);
    expect(denied.body.result.content[0].text).toContain('Blocked');

    // Risky routes run without the in-app approval pause (here: a delete).
    const t = await e.api('POST', '/api/gtm/tables', { name: 'Doomed' });
    const del = await rpc(...call('api', { method: 'DELETE', path: `/api/gtm/tables/${t.body.id}` }));
    expect(del.body.result.isError).toBe(false);
    expect((await e.api('GET', `/api/gtm/tables/${t.body.id}`)).status).toBe(404);

    expect((await rpc(...call('ask_user', { question: 'hi' }))).body.error.code).toBe(-32602);
    const eps = await rpc(...call('find_endpoints', { query: 'run estimate' }));
    expect(eps.body.result.content[0].text).toContain('/api/gtm/tables/:id/run/estimate');
  });

  it('needs a valid bearer token, rejects foreign origins, and is not swallowed by the web app', async () => {
    const { e, token } = await setup();
    const post = (headers: Record<string, string>) => e.app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ authorization: `Bearer ${token}`, origin: 'http://bear.test' })).statusCode).toBe(200);
    expect((await e.app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    const batch = await e.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] });
    expect(batch.statusCode).toBe(400);
  });
});
