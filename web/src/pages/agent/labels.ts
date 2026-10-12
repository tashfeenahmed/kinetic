import type { AgentMessage } from './types.ts';

/** [method, path pattern, while running, once done] — the first match wins. */
type Rule = [string, RegExp, string, string];
const T = '/api/gtm/tables';
const RULES: Rule[] = [
  ['POST', /^\/api\/gtm\/find$/, 'Searching for {what}', 'Searched for {what}'],
  ['POST', /^\/api\/gtm\/find\/preview$/, 'Previewing {what}', 'Previewed {what}'],
  ['POST', /^\/api\/gtm\/tables\/from-leads$/, 'Creating a table from leads', 'Created a table from leads'],
  ['POST', /^\/api\/gtm\/tables$/, 'Creating a table', 'Created a table'],
  ['GET', /^\/api\/gtm\/tables$/, 'Looking at your tables', 'Looked at your tables'],
  ['POST', new RegExp(`^${T}/\\d+/columns$`), 'Adding column{name}', 'Added column{name}'],
  ['PATCH', new RegExp(`^${T}/\\d+/columns/\\d+$`), 'Updating a column', 'Updated a column'],
  ['PUT', new RegExp(`^${T}/\\d+/columns/\\d+$`), 'Updating a column', 'Updated a column'],
  ['DELETE', new RegExp(`^${T}/\\d+/columns/\\d+$`), 'Removing a column', 'Removed a column'],
  ['POST', new RegExp(`^${T}/\\d+/(columns/\\d+/)?run$`), 'Running cells', 'Ran cells'],
  ['POST', new RegExp(`^${T}/\\d+/rows`), 'Adding rows', 'Added rows'],
  ['POST', new RegExp(`^${T}/\\d+/import`), 'Importing rows', 'Imported rows'],
  ['GET', new RegExp(`^${T}/\\d+`), 'Reading the table', 'Read the table'],
  ['DELETE', new RegExp(`^${T}/\\d+$`), 'Deleting a table', 'Deleted a table'],
  ['POST', /^\/api\/campaigns$/, 'Creating a campaign', 'Created a campaign'],
  ['POST', /^\/api\/campaigns\/.*sequence/, 'Writing the sequence', 'Wrote the sequence'],
  ['GET', /^\/api\/campaigns/, 'Looking at campaigns', 'Looked at campaigns'],
  ['GET', /^\/api\/replies/, 'Reading your inbox', 'Read your inbox'],
  ['GET', /^\/api\/leads/, 'Looking at leads', 'Looked at leads'],
  ['GET', /^\/api\/gtm\/signals/, 'Checking signals', 'Checked signals'],
  ['GET', /^\/api\/sender-emails/, 'Checking your mailboxes', 'Checked your mailboxes'],
];

const FIND_WHAT: Record<string, string> = {
  companies: 'companies', people: 'people', jobs: 'open roles', local: 'local businesses', google_maps: 'local businesses', lookalikes: 'lookalikes',
};

/**
 * Human label for a tool step. The server labels API calls `METHOD /path` (plus ` → result`
 * once done); we turn the common ones into words and keep the result after a dot.
 */
export function stepLabel(msg: AgentMessage): string {
  const raw = msg.meta.label ?? msg.tool_name ?? 'Tool';
  if (msg.tool_name !== 'api') return raw;
  const m = raw.match(/^(GET|POST|PUT|PATCH|DELETE) (\S+)(?: (?:→|—) (.*))?$/);
  if (!m) return raw;
  const [, method, path, result] = m;
  const rule = RULES.find(([meth, re]) => meth === method && re.test(path));
  const done = msg.status === 'done' || msg.status === 'failed';
  const body = (msg.tool_args?.body ?? {}) as Record<string, unknown>;
  const what = FIND_WHAT[String(body.mode ?? '')] ?? 'prospects';
  const name = typeof body.name === 'string' && body.name ? ` “${body.name}”` : '';
  const head = rule ? (done ? rule[3] : rule[2]).replace('{what}', what).replace('{name}', name) : `${method} ${path}`;
  const tail = result && !/^\d{3} OK$/.test(result) && !/needs your approval$/.test(result) ? result : '';
  // "Created a table · created table #4" → "Created table #4"
  if (done && tail && /^Created/.test(head) && /^created /.test(tail)) return `C${tail.slice(1)}`;
  return tail ? `${head} · ${tail}` : rule && !done ? `${head}…` : head;
}
