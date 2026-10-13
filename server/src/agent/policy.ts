/**
 * What the agent's `api` tool may call. Hard-denied routes never run (auth, tokens,
 * users/passwords, workspace delete/members, secrets, streaming endpoints, the agent's
 * own sessions). Risky routes — anything that sends, launches, deletes, touches
 * LinkedIn/social, or spends on paid enrichment for more than ~100 rows — run only with
 * an approval token the user grants by clicking Approve in the UI.
 */
import type { Db } from '../db/db.ts';
import type { Settings } from '../gtm/settings.ts';
import { ENRICH_KINDS } from '../gtm/providers/catalog.ts';

export const PAID_ROW_LIMIT = 100;

const DENY: [RegExp, RegExp, string][] = [
  [/.*/, /^\/api\/auth(\/|$)/, 'Authentication routes are off-limits to the agent.'],
  [/.*/, /^\/api\/api-tokens(\/|$)/, 'API tokens are managed by the user only.'],
  [/.*/, /^\/api\/users(\/|$)/, 'User profile and password routes are off-limits to the agent.'],
  [/^DELETE$/, /^\/api\/workspaces\/[^/]+$/, 'Deleting a workspace is not allowed from the agent.'],
  [/.*/, /^\/api\/workspaces\/(members|v1\.1\/users)(\/|$)/, 'Workspace members are managed by the user only.'],
  [/.*/, /^\/api\/workspaces\/switch-workspace$/, 'The agent works in the chat’s workspace and cannot switch.'],
  [/^(PUT|POST|PATCH|DELETE)$/, /^\/api\/gtm\/keys$/, 'API keys are managed on the Integrations page by the user.'],
  [/.*/, /^\/api\/agent\/sessions(\/|$)/, 'The agent cannot drive its own chat sessions.'],
  // Live streams (…/:id/events). GET /api/events is the activity log and stays allowed.
  [/.*/, /^\/api\/.+\/events$/, 'Streaming endpoints cannot be called by the agent.'],
  [/.*/, /^\/api\/sender-emails\/[^/]+\/reconnect$/, 'Mailbox credentials are managed by the user only.'],
  [/^POST$/, /^\/api\/sender-emails\/(imap-smtp|bulk)$/, 'Adding mailboxes needs their passwords — the user adds them on the Sender Emails page.'],
  [/^POST$/, /^\/api\/seed-accounts$/, 'Seed inboxes need their passwords — the user adds them in the app.'],
  [/^(PUT|POST|PATCH)$/, /^\/api\/settings\/integrations$/, 'OAuth app secrets are entered by the user on Settings.'],
  // The browser extension's own device protocol (pairing, polling, task results). Status/pause routes stay allowed.
  [/.*/, /^\/api\/companion\/(me|pair|pairing-code|heartbeat|poll|unpair|tasks)(\/|$)/, 'That route is the Companion extension\'s own protocol; pairing is done by the user in Chrome.'],
];

const RISKY: [RegExp, RegExp, string][] = [
  [/^POST$/, /^\/api\/campaigns\/[^/]+\/launch$/, 'Launching a campaign starts sending email.'],
  [/^PATCH$/, /^\/api\/campaigns\/[^/]+\/resume$/, 'Resuming a campaign starts sending email.'],
  [/^POST$/, /^\/api\/campaigns\/[^/]+\/leads\/resume$/, 'Resuming leads restarts emails to them.'],
  [/^POST$/, /^\/api\/replies\/[^/]+\/(reply|forward)$/, 'This sends an email.'],
  [/^POST$/, /^\/api\/replies\/new$/, 'This sends an email.'],
  [/^POST$/, /^\/api\/replies\/[^/]+\/followup-campaign\/push$/, 'This queues follow-up emails.'],
  [/^POST$/, /test-email$|send-test$/, 'This sends a test email.'],
  [/^POST$/, /^\/api\/gtm\/keys\/test\/slack$/, 'This posts a Slack message.'],
  [/^POST$/, /^\/api\/webhook-events\/test-event$/, 'This sends data to an outside URL.'],
  [/^POST$/, /^\/api\/webhook-deliveries\/[^/]+\/retry$/, 'This sends data to an outside URL.'],
  [/^POST$/, /^\/api\/sender-emails\/move-to-another-workspace-bulk$/, 'This moves mailboxes out of the workspace.'],
  [/^POST$/, /^\/api\/domains\/apply$/, 'This changes live DNS records.'],
  [/^DELETE$/, /.*/, 'This deletes data.'],
  [/^(POST|PUT|PATCH)$/, /linkedin|social|twitter|\/x\//i, 'LinkedIn/social actions need your approval.'],
  [/^(POST|PUT|PATCH)$/, /\/(send|send-now|outbound|dm|connect-request|invite|message|messages)(\/|$)/, 'This sends a message.'],
];

export type Verdict = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'approve'; reason: string };

/** Static route rules. `path` is the pathname without the query string. */
export function classifyRoute(method: string, path: string): Verdict {
  const m = method.toUpperCase();
  if (!path.startsWith('/api/')) return { kind: 'deny', reason: 'Only /api/ routes can be called.' };
  for (const [mm, pp, reason] of DENY) if (mm.test(m) && pp.test(path)) return { kind: 'deny', reason };
  for (const [mm, pp, reason] of RISKY) if (mm.test(m) && pp.test(path)) return { kind: 'approve', reason };
  return { kind: 'allow' };
}

const OUTBOUND_ACTIONS = new Set(['slack', 'webhook', 'hubspot_contact', 'hubspot_company', 'salesforce']);

/**
 * Data-aware rules on top of the route table: running cells that fire outbound
 * actions (Slack, webhooks, CRM writes), or paid enrichment over ~100 rows.
 */
export function classify(method: string, path: string, body: any, env: { db: Db; settings: Settings; workspaceId: number }): Verdict {
  const v = classifyRoute(method, path);
  if (v.kind !== 'allow') return v;
  const run = method.toUpperCase() === 'POST' && path.match(/^\/api\/gtm\/tables\/(\d+)\/run$/);
  if (!run) return v;
  const tableId = Number(run[1]);
  const t = env.db.get('SELECT id FROM gtm_tables WHERE id = ? AND workspace_id = ?', [tableId, env.workspaceId]);
  if (!t) return v; // the route itself 404s
  const cols = env.db.all<{ id: number; type: string; config: string }>('SELECT id, type, config FROM gtm_columns WHERE table_id = ?', [tableId]);
  const wanted = Array.isArray(body?.columnIds) && body.columnIds.length ? cols.filter((c) => body.columnIds.includes(c.id)) : cols;
  const cfg = (c: { config: string }) => { try { return JSON.parse(c.config) ?? {}; } catch { return {}; } };
  const outbound = wanted.filter((c) => c.type === 'action' && OUTBOUND_ACTIONS.has(cfg(c).kind));
  if (outbound.length) return { kind: 'approve', reason: `Running this sends data out (${[...new Set(outbound.map((c) => cfg(c).kind))].join(', ')}).` };
  const rows = Array.isArray(body?.rowIds) && body.rowIds.length ? body.rowIds.length : env.db.get<{ n: number }>('SELECT COUNT(*) n FROM gtm_rows WHERE table_id = ?', [tableId])!.n;
  if (rows <= PAID_ROW_LIMIT) return v;
  const paid = wanted.filter((c) => c.type === 'enrich').filter((c) => {
    const kind = ENRICH_KINDS.find((k) => k.id === cfg(c).kind);
    const order: string[] = cfg(c).providers?.length ? cfg(c).providers : kind?.steps.map((s) => s.id) ?? [];
    return kind?.steps.some((s) => order.includes(s.id) && s.cost !== 'free' && s.requires.length > 0 && s.requires.every((k) => env.settings.has(k)));
  });
  if (paid.length) return { kind: 'approve', reason: `Paid enrichment (${paid.length} column${paid.length === 1 ? '' : 's'}) on ${rows} rows may spend credits.` };
  return v;
}
