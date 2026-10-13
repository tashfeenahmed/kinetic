/**
 * MCP server at POST /mcp: lets outside AI clients (Claude Code, Claude Desktop, Cursor…)
 * drive Kinetic with the Kinetic Agent's own tools. Streamable HTTP, stateless, plain JSON
 * responses, hand-written JSON-RPC 2.0. Serves both the per-request protocol (2026-07-28:
 * version in `_meta`, `server/discover`) and the older `initialize` handshake.
 *
 * Auth is a Kinetic API token (`Authorization: Bearer …`); tools act as that token's user
 * and workspace. `api` calls go through the agent policy: hard-denied routes stay denied,
 * but risky calls don't pause — whoever holds the token authorized their client.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { HttpError } from '../http.ts';
import { authenticate } from '../routes/auth.ts';
import { runTool, TOOLS, type ToolEnv } from './tools.ts';

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = { name: 'kinetic', title: 'Kinetic', version: '0.1.0' };

export const MCP_INSTRUCTIONS = `Kinetic is a self-hosted go-to-market platform: Clay-style tables with enrichment, AI research and signals, plus cold email outreach.
- Before a task, call list_skills and load_skill for the matching playbook and follow it. If no skill fits, use find_endpoints.
- Do the work with the api tool. It acts as the API token's user in that token's workspace.
- Use the knowledge tool for the company, offers, ICP, personas and tone before targeting or writing copy.
- Calls that send email, launch campaigns, delete data or spend paid credits run immediately here — confirm with the user first. Before paid enrichment, POST /api/gtm/tables/:id/run/estimate to see the worst-case credits.`;

/** The agent's tools minus ask_user (the MCP client talks to its user itself). */
const MCP_TOOLS = TOOLS.filter((t) => t.function.name !== 'ask_user').map((t) => ({
  name: t.function.name,
  description: t.function.name === 'api'
    ? 'Call any Kinetic HTTP API route as the API token\'s user, e.g. POST /api/gtm/tables. Returns status and a truncated JSON body (large arrays are summarised with their row count). Account, token, password and credential routes are blocked.'
    : t.function.description,
  inputSchema: t.function.parameters,
}));

type Id = string | number | null;
class RpcError extends Error {
  code: number;
  status: number;
  data?: unknown;
  constructor(code: number, message: string, status = 200, data?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function mcpRoutes(app: FastifyInstance, ctx: Ctx) {
  // Stateless: no standalone SSE stream (GET) and no sessions to end (DELETE).
  const notAllowed = (_req: FastifyRequest, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'The MCP endpoint only accepts POST.' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.post('/mcp', async (req, reply) => {
    // DNS-rebinding guard: browsers may only call from this server's own origin.
    const origin = req.headers.origin;
    if (origin && !sameHost(origin, [req.headers.host, hostOf(ctx.config.publicUrl)])) {
      return reply.code(403).send(rpcError(null, -32600, 'Origin not allowed.'));
    }
    const header = req.headers.authorization;
    let a = null;
    try { a = header?.toLowerCase().startsWith('bearer ') ? authenticate(ctx, req) : null; } catch (e) { if (!(e instanceof HttpError)) throw e; }
    if (!a) return reply.code(401).send({ error: 'invalid_token', message: 'Send a Kinetic API token: Authorization: Bearer <token> (Developers → API tokens).' });

    const msg = req.body as any;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return reply.code(400).send(rpcError(msg?.id ?? null, -32600, Array.isArray(msg) ? 'Batches are not supported.' : 'Invalid JSON-RPC request.'));
    }
    if (msg.id === undefined) return reply.code(202).send(); // notifications (initialized, cancelled…) need no answer

    const env: ToolEnv = { ctx, app, workspaceId: a.workspaceId, userId: a.userId, approvals: new Map(), autoApprove: true, via: 'token' };
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const version = params._meta?.[VERSION_KEY];
    const modern = msg.method !== 'initialize' && version !== undefined;
    try {
      if (modern) checkModern(req, msg.method, params, version);
      else checkLegacyHeader(req);
      const result = await handle(msg.method, params, env, modern);
      return reply.send({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : result });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      // Modern clients tell an unknown method apart from a missing endpoint by the 404 + JSON-RPC body.
      const status = e.code === -32601 && modern ? 404 : e.status;
      return reply.code(status).send(rpcError(msg.id, e.code, e.message, e.data));
    }
  });
}

async function handle(method: string, params: any, env: ToolEnv, modern: boolean): Promise<Record<string, unknown>> {
  switch (method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: MCP_INSTRUCTIONS };
    }
    case 'server/discover':
      return { supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS, ...(modern ? {} : { serverInfo: SERVER_INFO }) };
    case 'ping': return {};
    case 'tools/list': return { tools: MCP_TOOLS };
    case 'tools/call': {
      const name = String(params.name ?? '');
      if (!MCP_TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const out = await runTool(name, params.arguments ?? {}, env);
      const text = out.kind === 'result' ? out.content : `Paused: ${out.pause.type === 'approval' ? out.pause.reason : out.pause.question}`;
      return { content: [{ type: 'text', text }], isError: out.kind !== 'result' || !out.ok };
    }
    default: throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Per-request protocol (2026-07-28): known version, and HTTP headers that mirror the body. */
function checkModern(req: FastifyRequest, method: string, params: any, version: unknown) {
  if (typeof version !== 'string' || params._meta?.['io.modelcontextprotocol/clientCapabilities'] === undefined) {
    throw new RpcError(-32602, `Missing _meta "${VERSION_KEY}" or "io.modelcontextprotocol/clientCapabilities".`, 400);
  }
  if (!MODERN.includes(version)) throw new RpcError(-32022, 'Unsupported protocol version', 400, { supported: SUPPORTED, requested: version });
  const h = (name: string) => { const v = req.headers[name]; return typeof v === 'string' ? decodeHeader(v) : undefined; };
  const mismatch = (what: string) => new RpcError(-32020, `Header mismatch: ${what}`, 400);
  if (h('mcp-protocol-version') !== version) throw mismatch('MCP-Protocol-Version must match the request\'s protocol version');
  if (h('mcp-method') !== method) throw mismatch('Mcp-Method must match the request method');
  if (method === 'tools/call' && h('mcp-name') !== String(params.name ?? '')) throw mismatch('Mcp-Name must match the tool name');
}

/** Handshake-era clients send MCP-Protocol-Version from 2025-06-18 on; older ones send none. */
function checkLegacyHeader(req: FastifyRequest) {
  const v = req.headers['mcp-protocol-version'];
  if (typeof v === 'string' && !SUPPORTED.includes(v)) throw new RpcError(-32600, `Unsupported protocol version ${v}. Supported: ${SUPPORTED.join(', ')}`, 400);
}

/** `=?base64?…?=` header values carry non-ASCII names. */
function decodeHeader(v: string): string {
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', ...(id != null ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });

function hostOf(url: string): string | undefined {
  try { return new URL(url).host; } catch { return undefined; }
}

function sameHost(origin: string, hosts: (string | undefined)[]): boolean {
  const h = hostOf(origin);
  return !!h && hosts.includes(h);
}
