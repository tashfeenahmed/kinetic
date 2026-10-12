/**
 * Conditional sequences.
 *
 * Rules hang off a step ("after this step…") and are evaluated when the lead's next step
 * becomes due, i.e. after the next step's "wait N days" (or `check_after_days` after the
 * last step). The first matching rule's action applies; otherwise the `else` action
 * (default: continue to the next step). A step without rules behaves exactly like the
 * linear sequencer: send step N+1.
 *
 * A jump/skip sends its target straight away: the wait has already been served at that point.
 * Add a "wait" action to give a branch more time.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { WEEKDAYS } from '../lib/schedule.ts';
import { domainOf } from '../lib/dns.ts';
import { cachedProvider } from './emailProvider.ts';
import { safeJson } from './compose.ts';

export const DEFAULT_MAX_VISITS = 3;
export const DEFAULT_CHECK_AFTER_DAYS = 3;

const scope = z.enum(['previous', 'any']).optional();
export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened'), negate: z.boolean().optional(), scope }),
  z.object({ type: z.literal('clicked'), negate: z.boolean().optional(), scope, url: z.string().max(2000).optional() }),
  z.object({ type: z.literal('replied'), negate: z.boolean().optional() }),
  z.object({ type: z.literal('reply_category'), value: z.enum(['interested', 'not_interested']), negate: z.boolean().optional() }),
  z.object({
    type: z.literal('lead_field'), field: z.string().trim().min(1).max(100),
    op: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'empty', 'not_empty', 'gt', 'lt']),
    value: z.union([z.string().max(1000), z.number()]).optional(),
  }),
  z.object({ type: z.literal('email_provider'), value: z.enum(['google', 'microsoft', 'other']), negate: z.boolean().optional() }),
  z.object({ type: z.literal('has_tag'), tag: z.string().trim().min(1).max(100), negate: z.boolean().optional() }),
  z.object({ type: z.literal('day_of_week'), days: z.array(z.enum(WEEKDAYS)).min(1) }),
  z.object({ type: z.literal('time_since_previous'), op: z.enum(['gt', 'lt']), days: z.number().min(0).max(365) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue') }),
  z.object({ type: z.literal('jump'), step: z.number().int().min(1).max(50) }),
  z.object({ type: z.literal('skip') }),
  z.object({ type: z.literal('wait'), days: z.number().min(0.01).max(90) }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('move'), campaign_id: z.number().int().positive() }),
  z.object({ type: z.literal('add_tag'), tag: z.string().trim().min(1).max(100) }),
]);
export type Action = z.infer<typeof actionSchema>;

export const ruleSchema = z.object({
  when: z.array(conditionSchema).min(1).max(10),
  match: z.enum(['all', 'any']).default('all'),
  then: actionSchema,
});
export const branchingSchema = z.object({
  rules: z.array(ruleSchema).max(10).default([]),
  else: actionSchema.default({ type: 'continue' }),
  /** Last step only: how long after it to check the rules. */
  check_after_days: z.number().int().min(0).max(90).optional(),
  /** Loop guard: how many times this step may be sent to one lead. */
  max_visits: z.number().int().min(1).max(20).optional(),
});
export type Branching = z.infer<typeof branchingSchema>;

const CONTINUE: Action = { type: 'continue' };

export function parseBranching(raw: unknown): Branching {
  if (!raw) return { rules: [], else: CONTINUE };
  try {
    const r = branchingSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return r.success ? r.data : { rules: [], else: CONTINUE };
  } catch {
    return { rules: [], else: CONTINUE };
  }
}

/** True when the step has rules or a non-default else (i.e. it is not a plain linear step). */
export const hasBranching = (b: Branching) => b.rules.length > 0 || b.else.type !== 'continue';

/** The step's main row (holds the rules) from a list of variant rows. */
export const mainOf = (rows: Row[] | undefined) => rows?.find((r) => !r.variant_of_step_id) ?? rows?.[0];

export interface SeqState { visits?: Record<string, number>; resolved?: string }
export function readState(cl: Row): SeqState {
  try { return JSON.parse(cl.seq_state || '{}'); } catch { return {}; }
}

// ---- describing rules in plain English (path reasons + UI parity) ----------

export function describeCondition(c: Condition): string {
  const not = 'negate' in c && c.negate ? 'not ' : '';
  switch (c.type) {
    case 'opened': return `${not}opened ${c.scope === 'any' ? 'any email' : 'the previous email'}`;
    case 'clicked': return `${not}clicked ${c.url ? `a link containing "${c.url}"` : 'a link'}${c.scope === 'any' ? ' in any email' : ''}`;
    case 'replied': return `${not}replied`;
    case 'reply_category': return `reply is ${not}${c.value.replace('_', ' ')}`;
    case 'lead_field': {
      const ops: Record<string, string> = { equals: 'equals', not_equals: 'does not equal', contains: 'contains', not_contains: 'does not contain', empty: 'is empty', not_empty: 'is not empty', gt: 'is greater than', lt: 'is less than' };
      return `${c.field} ${ops[c.op]}${['empty', 'not_empty'].includes(c.op) ? '' : ` "${c.value ?? ''}"`}`;
    }
    case 'email_provider': return `email provider is ${not}${c.value === 'google' ? 'Google' : c.value === 'microsoft' ? 'Microsoft' : 'other'}`;
    case 'has_tag': return `${not}tagged "${c.tag}"`;
    case 'day_of_week': return `today is ${c.days.join('/')}`;
    case 'time_since_previous': return `${c.op === 'gt' ? 'more' : 'less'} than ${c.days} day(s) since the previous email`;
  }
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'continue': return 'continue to the next step';
    case 'jump': return `go to step ${a.step}`;
    case 'skip': return 'skip the next step';
    case 'wait': return `wait ${a.days} more day(s), then continue`;
    case 'end': return 'end the sequence';
    case 'move': return `move to campaign #${a.campaign_id}`;
    case 'add_tag': return `add tag "${a.tag}" and continue`;
  }
}

// ---- evaluation ------------------------------------------------------------

interface EvalInput { ctx: Ctx; campaign: Row; cl: Row; lead: Row; now: Date }
type Truth = boolean | 'unknown';

function lastSent(ctx: Ctx, clId: number): Row | undefined {
  return ctx.db.get(`SELECT * FROM sent_emails WHERE campaign_lead_id = ? AND kind = 'campaign' ORDER BY id DESC LIMIT 1`, [clId]);
}

/** Value of a lead field or custom variable by (case-insensitive) name. */
export function leadField(lead: Row, field: string): string {
  const key = field.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const builtin: Record<string, unknown> = {
    email: lead.email, first_name: lead.first_name, last_name: lead.last_name, title: lead.title, company: lead.company,
    notes: lead.notes, status: lead.status, domain: domainOf(String(lead.email ?? '')),
  };
  if (key in builtin) return String(builtin[key] ?? '');
  for (const [k, v] of Object.entries(safeJson(lead.custom_variables))) {
    if (k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') === key) return String(v ?? '');
  }
  return '';
}

export function evalCondition(c: Condition, x: EvalInput): Truth {
  const { ctx, cl, lead, now, campaign } = x;
  const { db } = ctx;
  const flip = (v: boolean) => ('negate' in c && c.negate ? !v : v);
  switch (c.type) {
    case 'opened': {
      const v = c.scope === 'any'
        ? !!db.get(`SELECT 1 FROM sent_emails WHERE campaign_lead_id = ? AND first_opened_at IS NOT NULL LIMIT 1`, [cl.id])
        : !!lastSent(ctx, cl.id)?.first_opened_at;
      return flip(v);
    }
    case 'clicked': {
      const ids = c.scope === 'any'
        ? db.all(`SELECT id, clicks FROM sent_emails WHERE campaign_lead_id = ?`, [cl.id])
        : [lastSent(ctx, cl.id)].filter(Boolean) as Row[];
      let v = ids.some((s) => s.clicks > 0);
      if (v && c.url) {
        v = ids.some((s) => !!db.get(`SELECT 1 FROM events WHERE sent_email_id = ? AND type = 'LINK_CLICKED' AND instr(lower(json_extract(data, '$.url')), lower(?)) > 0 LIMIT 1`, [s.id, c.url]));
      }
      return flip(v);
    }
    case 'replied': {
      const v = !!db.get(`SELECT 1 FROM replies WHERE lead_id = ? AND campaign_id = ? AND automated = 0 AND folder != 'bounced' LIMIT 1`, [cl.lead_id, cl.campaign_id]);
      return flip(v);
    }
    case 'reply_category': {
      // Latest human reply in this campaign, or the reply a reply-follow-up campaign answers.
      const r = db.get(
        `SELECT * FROM replies WHERE (id = ? OR (lead_id = ? AND campaign_id = ?)) AND automated = 0 AND folder != 'bounced' ORDER BY received_at DESC, id DESC LIMIT 1`,
        [cl.anchor_reply_id ?? 0, cl.lead_id, cl.campaign_id]);
      const v = !!r && (c.value === 'interested' ? (r.interested === 1 || r.category === 'interested') : r.category === 'not_interested');
      return flip(v);
    }
    case 'lead_field': {
      const raw = leadField(lead, c.field);
      const val = String(c.value ?? '');
      switch (c.op) {
        case 'equals': return raw.trim().toLowerCase() === val.trim().toLowerCase();
        case 'not_equals': return raw.trim().toLowerCase() !== val.trim().toLowerCase();
        case 'contains': return raw.toLowerCase().includes(val.toLowerCase());
        case 'not_contains': return !raw.toLowerCase().includes(val.toLowerCase());
        case 'empty': return raw.trim() === '';
        case 'not_empty': return raw.trim() !== '';
        case 'gt':
        case 'lt': {
          const a = Number(raw.replace(/[^0-9.-]/g, ''));
          const b = Number(val);
          if (raw.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
          return c.op === 'gt' ? a > b : a < b;
        }
      }
      return false;
    }
    case 'email_provider': {
      const p = cachedProvider(ctx, lead.email);
      if (!p) return 'unknown';
      return flip(p === c.value);
    }
    case 'has_tag': {
      const v = !!db.get(
        `SELECT 1 FROM taggables x JOIN tags t ON t.id = x.tag_id WHERE x.taggable_type = 'lead' AND x.taggable_id = ? AND (lower(t.name) = lower(?) OR CAST(t.id AS TEXT) = ?) LIMIT 1`,
        [lead.id, c.tag, c.tag]);
      return flip(v);
    }
    case 'day_of_week': {
      const day = DateTime.fromJSDate(now).setZone(campaign.schedule_timezone).toFormat('cccc').toLowerCase();
      return (c.days as string[]).includes(day);
    }
    case 'time_since_previous': {
      if (!cl.last_sent_at) return false;
      const days = (now.getTime() - Date.parse(cl.last_sent_at)) / 86_400_000;
      return c.op === 'gt' ? days > c.days : days < c.days;
    }
  }
}

function evalRule(rule: Branching['rules'][number], x: EvalInput): Truth {
  const results = rule.when.map((c) => evalCondition(c, x));
  if (rule.match === 'any') {
    if (results.some((r) => r === true)) return true;
    return results.some((r) => r === 'unknown') ? 'unknown' : false;
  }
  if (results.some((r) => r === false)) return false;
  return results.some((r) => r === 'unknown') ? 'unknown' : true;
}

// ---- resolving the next step for a due lead --------------------------------

export type NextStep = { kind: 'send'; order: number } | { kind: 'hold' } | { kind: 'done' };

function logPath(ctx: Ctx, campaign: Row, cl: Row, from: number, ruleIndex: number | null, action: Action, target: number | null, reason: string) {
  ctx.db.insert('sequence_path_events', {
    workspace_id: campaign.workspace_id, campaign_id: campaign.id, campaign_lead_id: cl.id, lead_id: cl.lead_id,
    from_step: from, rule_index: ruleIndex, action: JSON.stringify(action), target_step: target, reason, created_at: ctx.now().toISOString(),
  });
}

/**
 * Decides which step a due lead gets next. Steps without rules return the linear next step
 * without touching the database, so linear sequences behave exactly as before.
 */
export function resolveNextStep(ctx: Ctx, campaign: Row, cl: Row, steps: Map<number, Row[]>, now: Date): NextStep {
  const S = cl.current_step as number;
  const linearNext = (cl.next_step as number | null) ?? S + 1;
  if (S === 0) return { kind: 'send', order: linearNext };
  const br = parseBranching(mainOf(steps.get(S))?.branching);
  if (!hasBranching(br)) return { kind: 'send', order: linearNext };

  const state = readState(cl);
  const visitKey = `${S}@${cl.last_sent_at ?? ''}`;
  if (state.resolved === visitKey) return { kind: 'send', order: linearNext };

  const lead = ctx.db.get('SELECT * FROM leads WHERE id = ?', [cl.lead_id])!;
  const x: EvalInput = { ctx, campaign, cl, lead, now };
  let action: Action = br.else;
  let ruleIndex: number | null = null;
  let reason = br.rules.length ? 'no rule matched' : 'default branch';
  for (let i = 0; i < br.rules.length; i++) {
    const rule = br.rules[i]!;
    const t = evalRule(rule, x);
    if (t === 'unknown') return { kind: 'hold' }; // e.g. MX lookup still pending
    if (t) {
      action = rule.then;
      ruleIndex = i;
      reason = `${rule.when.map(describeCondition).join(rule.match === 'any' ? ' or ' : ' and ')}`;
      break;
    }
  }

  const db = ctx.db;
  const persist = (patch: Row) => db.update('campaign_leads', cl.id, { ...patch, seq_state: JSON.stringify({ ...state, resolved: visitKey }) });
  const finish = (why: string, target: number | null = null, a: Action = action) => {
    persist({ status: 'completed', next_due_at: null, next_step: null });
    logPath(ctx, campaign, cl, S, ruleIndex, a, target, why);
    return { kind: 'done' } as const;
  };

  let target: number;
  switch (action.type) {
    case 'continue': target = S + 1; break;
    case 'add_tag': addLeadTag(ctx, campaign.workspace_id, lead.id, action.tag); target = S + 1; break;
    case 'jump': target = action.step; break;
    case 'skip': target = S + 2; break;
    case 'wait': {
      const due = new Date(now.getTime() + action.days * 86_400_000).toISOString();
      persist({ next_step: S + 1, next_due_at: due });
      logPath(ctx, campaign, cl, S, ruleIndex, action, S + 1, reason);
      return { kind: 'done' };
    }
    case 'end': return finish(reason);
    case 'move': {
      const moved = moveLead(ctx, campaign, cl, action.campaign_id);
      return finish(moved ? reason : `${reason} (target campaign #${action.campaign_id} not found, sequence ended)`);
    }
  }

  const maxStep = Math.max(0, ...steps.keys());
  if (target > maxStep) return finish(`${reason}; no step ${target}, sequence complete`, null);
  const maxVisits = parseBranching(mainOf(steps.get(target))?.branching).max_visits ?? DEFAULT_MAX_VISITS;
  const visits = state.visits?.[String(target)] ?? 0;
  if (visits >= maxVisits) return finish(`${reason}; loop guard: step ${target} already sent ${visits} time(s)`, null, { type: 'end' });

  persist({ next_step: target });
  logPath(ctx, campaign, cl, S, ruleIndex, action, target, reason);
  return { kind: 'send', order: target };
}

/** Next due time after sending `order`: next step's wait, or check_after_days for a last step with rules. */
export function dueAfterSend(steps: Map<number, Row[]>, order: number): { wait: number } | null {
  const next = steps.get(order + 1)?.[0];
  if (next) return { wait: next.wait_in_days };
  const br = parseBranching(mainOf(steps.get(order))?.branching);
  if (hasBranching(br)) return { wait: br.check_after_days ?? DEFAULT_CHECK_AFTER_DAYS };
  return null;
}

export function bumpVisits(cl: Row, order: number): string {
  const state = readState(cl);
  const visits = { ...(state.visits ?? {}) };
  visits[String(order)] = (visits[String(order)] ?? 0) + 1;
  return JSON.stringify({ ...state, visits });
}

function addLeadTag(ctx: Ctx, workspaceId: number, leadId: number, name: string) {
  const { db } = ctx;
  let tag = db.get('SELECT * FROM tags WHERE workspace_id = ? AND lower(name) = lower(?)', [workspaceId, name]);
  if (!tag) tag = db.get('SELECT * FROM tags WHERE id = ?', [db.insert('tags', { workspace_id: workspaceId, name })])!;
  db.run('INSERT OR IGNORE INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)', [tag.id, 'lead', leadId]);
}

function moveLead(ctx: Ctx, campaign: Row, cl: Row, targetId: number): boolean {
  const { db } = ctx;
  const target = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [targetId, campaign.workspace_id]);
  if (!target || target.id === campaign.id) return false;
  db.run('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, ?)', [target.id, cl.lead_id, 'pending']);
  if (target.status === 'completed') db.update('campaigns', target.id, { status: 'active' });
  return true;
}

// ---- validation (launch check) -------------------------------------------

/** Dangling targets block a launch; unreachable steps only warn. */
export function validateBranching(ctx: Ctx, campaign: Row, steps: Map<number, Row[]>): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const maxStep = Math.max(0, ...steps.keys());
  const edges = new Map<number, number[]>();
  for (let s = 1; s <= maxStep; s++) {
    const br = parseBranching(mainOf(steps.get(s))?.branching);
    const actions = [...br.rules.map((r) => r.then), br.else];
    const out: number[] = [];
    for (const a of actions) {
      if (a.type === 'jump') {
        if (!steps.has(a.step)) problems.push(`Step ${s} has a rule that goes to step ${a.step}, which does not exist.`);
        else if (a.step === s) warnings.push(`Step ${s} has a rule that sends step ${s} again; the loop guard stops it after ${br.max_visits ?? DEFAULT_MAX_VISITS} sends.`);
        out.push(a.step);
      } else if (a.type === 'skip') out.push(s + 2);
      else if (a.type === 'move') {
        if (a.campaign_id === campaign.id || !ctx.db.get('SELECT 1 FROM campaigns WHERE id = ? AND workspace_id = ?', [a.campaign_id, campaign.workspace_id])) {
          problems.push(`Step ${s} moves leads to campaign #${a.campaign_id}, which does not exist.`);
        }
      } else if (a.type !== 'end') out.push(s + 1);
    }
    for (const r of br.rules) {
      for (const c of r.when) {
        if (c.type === 'opened' && !campaign.open_tracking) warnings.push(`Step ${s} checks opens, but open tracking is off: nobody will count as opened.`);
        if (c.type === 'clicked' && !campaign.click_tracking) warnings.push(`Step ${s} checks clicks, but click tracking is off: nobody will count as clicked.`);
        if (c.type === 'replied' && !c.negate && campaign.stop_on_reply) warnings.push(`Step ${s} checks for replies, but "stop on reply" ends the sequence as soon as a lead replies.`);
      }
    }
    edges.set(s, out);
  }
  const seen = new Set<number>();
  const queue = maxStep ? [1] : [];
  while (queue.length) {
    const s = queue.shift()!;
    if (seen.has(s) || !steps.has(s)) continue;
    seen.add(s);
    queue.push(...(edges.get(s) ?? []));
  }
  for (let s = 1; s <= maxStep; s++) if (steps.has(s) && !seen.has(s)) warnings.push(`Step ${s} is unreachable: no branch leads to it.`);
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}
