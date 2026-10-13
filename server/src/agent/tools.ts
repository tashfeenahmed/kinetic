/**
 * The agent's small fixed toolset. Features are learned from skills, not tools:
 * `api` reaches every Kinetic route in-process as the chatting user.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import type { Auth } from '../http.ts';
import { webSearch } from '../gtm/providers/search.ts';
import { readPage } from '../gtm/engine/agent.ts';
import { fnTool } from './llm.ts';
import { classify } from './policy.ts';
import { findEndpoints } from './endpoints.ts';
import { allSkills, findSkill, skillsIndex } from './skills.ts';
import { INTERNAL_HEADER, mintInternalToken, revokeInternalToken } from './internalAuth.ts';
import { docsInTreeOrder, findDoc, knowledgeContext, pathTitle, searchDocs } from '../knowledge/store.ts';
import { folderPaths, listFolders } from '../knowledge/folders.ts';

export const TOOLS = [
  fnTool('api', 'Call any Kinetic HTTP API route as the current user, e.g. POST /api/gtm/tables. Returns status and a truncated JSON body (large arrays are summarised with their row count). Risky routes (launch/resume campaigns, sending email, deletes, social actions, paid enrichment over ~100 rows) pause for the user\'s approval automatically.', {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', description: 'Route path starting with /api/, ids filled in, e.g. /api/gtm/tables/12/columns' },
    query: { type: 'object', description: 'Optional query string parameters', additionalProperties: true },
    body: { type: 'object', description: 'Optional JSON body', additionalProperties: true },
  }, ['method', 'path']),
  fnTool('find_endpoints', 'Search the API reference by keywords. Returns method, path, summary and a compact body schema. Use when no skill covers what you need.', { query: { type: 'string' } }, ['query']),
  fnTool('list_skills', 'List available skills (playbooks) with their descriptions.', {}),
  fnTool('load_skill', 'Load a skill\'s full instructions by name. Load the relevant skill BEFORE starting a task it covers.', { name: { type: 'string' } }, ['name']),
  fnTool('knowledge', 'Read the Knowledge Hub documents (company, offers, ICP, personas, positioning, competitors, case studies, tone, do-not-target…). No arguments: the folders, the list of docs (with folder paths) plus their combined text. doc: one document\'s full markdown by id or title. query: search all docs for matching lines. To create or edit docs use the api tool (knowledge-hub skill).', {
    doc: { type: 'string', description: 'Document id or title' },
    query: { type: 'string', description: 'Words to search for' },
  }),
  fnTool('web_search', 'Search the web. Returns titles, URLs and snippets.', { query: { type: 'string' } }, ['query']),
  fnTool('fetch_page', 'Fetch a web page and return its readable text (first ~12k chars).', { url: { type: 'string' } }, ['url']),
  fnTool('ask_user', 'Ask the user a question and wait for the answer. Use for missing details and before anything destructive or outbound. Offer short options when you can.', {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, description: 'Optional quick-reply buttons' },
  }, ['question']),
];

export interface ToolEnv {
  ctx: Ctx;
  app: FastifyInstance;
  workspaceId: number;
  userId: number;
  /** One-time approval tokens granted by the user for exact requests. */
  approvals: Map<string, string>;
  /** Run approval-needing calls without pausing (MCP: the token holder authorized their AI client). Hard denies still apply. */
  autoApprove?: boolean;
  /** How the caller signed in (default: session, i.e. the in-app chat). */
  via?: Auth['via'];
}

export interface Link { label: string; to: string }

/** A finished tool call, or a pause for the user (question or approval). */
export type ToolOutcome =
  | { kind: 'result'; ok: boolean; content: string; label: string; links?: Link[] }
  | { kind: 'pause'; label: string; pause: { type: 'question'; question: string; options: string[] } | { type: 'approval'; reason: string; request: ApiRequest } };

export interface ApiRequest { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

const MAX_RESULT = 6000;

export async function runTool(name: string, args: any, env: ToolEnv): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'api': return await apiTool(args, env);
      case 'find_endpoints': {
        const r = findEndpoints(String(args.query ?? ''));
        return ok(r.length ? JSON.stringify(r, null, 1) : 'No matching endpoints. Try other keywords.', `Searched endpoints “${args.query ?? ''}” (${r.length})`);
      }
      case 'list_skills': {
        const skills = allSkills(env.ctx.db, env.workspaceId);
        return ok(skillsIndex(skills) || 'No skills.', `Listed ${skills.length} skills`);
      }
      case 'load_skill': {
        const s = findSkill(env.ctx.db, env.workspaceId, String(args.name ?? ''));
        if (!s) return fail(`No skill named "${args.name}". Available: ${allSkills(env.ctx.db, env.workspaceId).map((x) => x.name).join(', ')}`, `Skill ${args.name} not found`);
        return ok(`# Skill: ${s.name}\n${s.body}`, `Loaded skill ${s.name}`);
      }
      case 'knowledge': return knowledgeTool(args, env);
      case 'web_search': {
        const settings = env.ctx.gtm!.settings;
        const r = await webSearch(String(args.query ?? ''), { settings, log: () => {} }, 8);
        return ok(r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') || 'No results.', `Searched the web “${args.query}” (${r.results.length})`);
      }
      case 'fetch_page': {
        const settings = env.ctx.gtm!.settings;
        const text = await readPage(String(args.url ?? ''), { settings, log: () => {} });
        return ok(text, `Read ${String(args.url ?? '').replace(/^https?:\/\//, '').slice(0, 80)}`);
      }
      case 'ask_user': {
        const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 6) : [];
        return { kind: 'pause', label: 'Asked you a question', pause: { type: 'question', question: String(args.question ?? ''), options } };
      }
      default:
        return fail(`Unknown tool ${name}. Tools: ${TOOLS.map((t) => t.function.name).join(', ')}`, `Unknown tool ${name}`);
    }
  } catch (e: any) {
    return fail(`Error: ${e.message}`, `${name} failed: ${String(e.message).slice(0, 120)}`);
  }
}

function knowledgeTool(args: any, env: ToolEnv): ToolOutcome {
  const docs = docsInTreeOrder(env.ctx.db, env.workspaceId);
  const folders = listFolders(env.ctx.db, env.workspaceId);
  if (!docs.length && !folders.length) return ok('The Knowledge Hub has no documents yet. Offer to fill it from the user\'s website (POST /api/knowledge/autofill) or write docs with POST /api/knowledge/docs — see the knowledge-hub skill.', 'Read Knowledge Hub (empty)');
  const paths = folderPaths(folders);
  const folderIndex = folders.length
    ? `Folders (folder_id: path):\n${folders.map((f) => ({ id: f.id, path: paths.get(f.id)! })).sort((a, b) => a.path.localeCompare(b.path)).map((f) => `folder ${f.id}: ${f.path}`).join('\n')}\n\n`
    : '';
  const index = folderIndex + (docs.length ? docs.map((d) => `#${d.id} ${pathTitle(d)}${d.pinned ? ' [pinned]' : ''} (${d.content.length} chars, updated ${d.updated_at.slice(0, 10)})`).join('\n') : '(no documents yet)');
  const ref = String(args.doc ?? '').trim();
  if (ref) {
    const d = findDoc(env.ctx.db, env.workspaceId, ref);
    if (!d) return fail(`No document matching "${ref}". Documents:\n${index}`, `Doc “${ref}” not found`);
    const where = d.folder_id ? `, in folder ${d.folder_id} “${paths.get(d.folder_id)}”` : '';
    return ok(`# ${d.title} (doc #${d.id}${where}${d.pinned ? ', pinned' : ''}, updated ${d.updated_at})\n\n${d.content || '(empty)'}`, `Read doc “${d.title}”`, [{ label: d.title, to: `/knowledge?doc=${d.id}` }]);
  }
  const q = String(args.query ?? '').trim();
  if (q) {
    const hits = searchDocs(docs.map((d) => ({ ...d, title: pathTitle(d) })), q);
    if (!hits.length) return ok(`Nothing matches "${q}". Documents:\n${index}`, `Searched Knowledge Hub “${q}” (0)`);
    return ok(hits.map((h) => `#${h.id} ${h.title}\n${h.hits.map((l) => `  ${l}`).join('\n')}`).join('\n\n'), `Searched Knowledge Hub “${q}” (${hits.length})`);
  }
  return ok(`Documents:\n${index}\n\n${knowledgeContext(env.ctx, env.workspaceId, 12_000)}`, `Read Knowledge Hub (${docs.length} doc${docs.length === 1 ? '' : 's'})`);
}

const ok = (content: string, label: string, links?: Link[]): ToolOutcome => ({ kind: 'result', ok: true, content: clip(content, 14_000), label, links });
const fail = (content: string, label: string): ToolOutcome => ({ kind: 'result', ok: false, content, label });

export function requestKey(r: ApiRequest): string {
  return createHash('sha256').update(JSON.stringify([r.method.toUpperCase(), r.path.split('?')[0], r.query ?? {}, r.body ?? null])).digest('hex');
}

/** Called when the user clicks Approve: a single-use token bound to this exact request. */
export function grantApproval(env: Pick<ToolEnv, 'approvals'>, r: ApiRequest): string {
  const token = randomBytes(16).toString('hex');
  env.approvals.set(token, requestKey(r));
  return token;
}

export async function apiTool(args: any, env: ToolEnv, approvalToken?: string): Promise<ToolOutcome> {
  const method = String(args.method ?? 'GET').toUpperCase();
  let raw = String(args.path ?? '').trim();
  try { if (/^https?:\/\//.test(raw)) raw = new URL(raw).pathname + new URL(raw).search; } catch { /* keep */ }
  const [pathname, qs] = raw.split('?');
  const query: Record<string, unknown> = { ...Object.fromEntries(new URLSearchParams(qs ?? '')), ...(args.query && typeof args.query === 'object' ? args.query : {}) };
  const body = args.body;
  const req: ApiRequest = { method, path: pathname, ...(Object.keys(query).length ? { query } : {}), ...(body !== undefined ? { body } : {}) };
  const label = `${method} ${pathname}`;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fail(`Unsupported method ${method}`, label);
  if (/\.\.|\/\/|[\s\\]/.test(pathname)) return fail('Invalid path.', label);

  const settings = env.ctx.gtm!.settings;
  const verdict = classify(method, pathname, body, { db: env.ctx.db, settings, workspaceId: env.workspaceId });
  if (verdict.kind === 'deny') return fail(`Blocked: ${verdict.reason}`, `${label} → blocked`);
  if (verdict.kind === 'approve' && !env.autoApprove) {
    const key = approvalToken ? env.approvals.get(approvalToken) : undefined;
    if (approvalToken) env.approvals.delete(approvalToken);
    if (key !== requestKey(req)) return { kind: 'pause', label: `${label} — needs your approval`, pause: { type: 'approval', reason: verdict.reason, request: req } };
  }

  // Act as the user, with their current role in the chat's workspace.
  const member = env.ctx.db.get<{ role: Auth['role'] }>('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [env.workspaceId, env.userId]);
  if (!member) return fail('You no longer have access to this workspace.', `${label} → forbidden`);
  const token = mintInternalToken({ userId: env.userId, workspaceId: env.workspaceId, role: member.role, via: env.via ?? 'session' });
  const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
  let res;
  try {
    res = await env.app.inject({ method: method as any, url: `${pathname}${search ? `?${search}` : ''}`, headers: { [INTERNAL_HEADER]: token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  } finally {
    revokeInternalToken(token);
  }
  let json: any = res.body;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* text */ }
  const okStatus = res.statusCode < 400;
  const { text, links } = describe(method, pathname, res.statusCode, json);
  return { kind: 'result', ok: okStatus, content: `HTTP ${res.statusCode}\n${truncateJson(json, MAX_RESULT)}`, label: `${label} → ${text}`, links };
}

/** One-line result for the UI plus links to whatever was created or touched. */
function describe(method: string, path: string, status: number, json: any): { text: string; links: Link[] } {
  const links: Link[] = [];
  if (status >= 400) return { text: `${status} ${String(json?.message ?? json?.error ?? '').slice(0, 140)}`.trim(), links };
  const tableId = path.match(/^\/api\/gtm\/tables\/(\d+)/)?.[1];
  const campaignId = path.match(/^\/api\/campaigns\/(?:v1\.1\/)?(\d+)/)?.[1];
  const createdTable = method === 'POST' && /^\/api\/gtm\/(tables|tables\/from-leads|find)$/.test(path) && json?.id;
  const createdCampaign = method === 'POST' && path === '/api/campaigns' && json?.data?.id;
  if (createdTable) {
    links.push({ label: `Table #${json.id}`, to: `/tables/${json.id}` });
    return { text: `created table #${json.id}${json.rows != null ? ` (${json.rows} rows)` : ''}`, links };
  }
  if (createdCampaign) {
    links.push({ label: json.data.name ? `Campaign “${json.data.name}”` : `Campaign #${json.data.id}`, to: `/campaigns/${json.data.id}` });
    return { text: `created campaign #${json.data.id}`, links };
  }
  const knowledgeDoc = /^\/api\/knowledge\/docs(\/\d+(\/duplicate)?)?$/.test(path) && method !== 'DELETE' && json?.data && typeof json.data.id === 'number' ? json.data : null;
  if (knowledgeDoc) {
    links.push({ label: `Doc “${knowledgeDoc.title}”`, to: `/knowledge?doc=${knowledgeDoc.id}` });
    return { text: method === 'POST' ? `created doc #${knowledgeDoc.id}` : method === 'PATCH' ? `updated doc #${knowledgeDoc.id}` : `doc #${knowledgeDoc.id}`, links };
  }
  if (tableId && method !== 'DELETE') links.push({ label: `Table #${tableId}`, to: `/tables/${tableId}` });
  if (campaignId && method !== 'DELETE') links.push({ label: `Campaign #${campaignId}`, to: `/campaigns/${campaignId}` });
  const bits: string[] = [];
  if (json && typeof json === 'object') {
    if (typeof json.id === 'number' && method === 'POST') bits.push(`created #${json.id}`);
    if (typeof json.queued === 'number') bits.push(`queued ${json.queued} cells`);
    if (typeof json.imported === 'number') bits.push(`imported ${json.imported} rows`);
    if (Array.isArray(json.ids)) bits.push(`${json.ids.length} rows`);
    if (Array.isArray(json)) bits.push(`${json.length} items`);
    if (Array.isArray(json.data)) bits.push(`${json.meta?.total ?? json.data.length} items`);
    if (Array.isArray(json.rows) && json.table) bits.push(`${json.rows.length} rows, ${json.columns?.length ?? 0} columns`);
  }
  return { text: bits.join(', ') || `${status} OK`, links };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated, ${s.length} chars total]` : s);

/** JSON for the model: long arrays become the first few items + a count; long strings are cut. */
export function truncateJson(value: unknown, maxChars = MAX_RESULT): string {
  if (value == null) return String(value);
  if (typeof value === 'string') return clip(value, maxChars);
  for (const [items, str] of [[20, 400], [8, 200], [3, 120], [1, 80]] as const) {
    const s = JSON.stringify(shrink(value, items, str, 0));
    if (s.length <= maxChars) return s;
  }
  return clip(JSON.stringify(shrink(value, 1, 60, 0)), maxChars);
}

function shrink(v: unknown, items: number, str: number, depth: number): unknown {
  if (typeof v === 'string') return v.length > str ? `${v.slice(0, str)}…` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, items).map((x) => shrink(x, items, str, depth + 1));
    return v.length > items ? [...head, `… ${v.length - items} more (${v.length} total)`] : head;
  }
  if (v && typeof v === 'object') {
    if (depth > 6) return '{…}';
    const entries = Object.entries(v as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, 60)) out[k] = shrink(x, items, str, depth + 1);
    if (entries.length > 60) out['…'] = `${entries.length - 60} more keys`;
    return out;
  }
  return v;
}
