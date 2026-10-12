/** A/B tests (auto-winner), conditional sequence branches, lead paths and recipient-provider lookups. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, canWrite, defineRoutes, HttpError, idParam, notFound, parse } from '../http.ts';
import { loadSteps } from '../engine/sequencer.ts';
import { abConfigPatchSchema, abConfigSchema, abTestsJson, analyzeStep, applyWinner, evaluateAbTests, orderedVariants, parseAbConfig, resetTest } from '../engine/abtest.ts';
import { actionSchema, branchingSchema, describeAction, mainOf, readState, validateBranching } from '../engine/branching.ts';
import { cachedProvider, lookupProvider } from '../engine/emailProvider.ts';
import { domainOf } from '../lib/dns.ts';

export function sequenceRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const r = defineRoutes(app, 'Sequence A/B Tests & Branching');

  const getCampaign = (ws: number, id: number) => {
    const c = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!c) throw notFound('campaign');
    return c;
  };
  /** Main step row for a step id that may be the main row or one of its variants. */
  const getMain = (c: Row, stepId: number) => {
    const s = db.get('SELECT * FROM sequence_steps WHERE id = ? AND campaign_id = ?', [stepId, c.id]);
    if (!s) throw notFound('step');
    return mainOf(db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND step_order = ?', [c.id, s.step_order]))!;
  };
  const checkMetric = (c: Row, metric: string) => {
    if (metric === 'open_rate' && !c.open_tracking) throw new HttpError(422, { error: 'validation_error', message: 'Open rate needs open tracking: turn it on in the campaign settings first.' });
    if (metric === 'click_rate' && !c.click_tracking) throw new HttpError(422, { error: 'validation_error', message: 'Click rate needs click tracking: turn it on in the campaign settings first.' });
  };

  // ---- A/B tests ----
  r.get('/api/campaigns/:id/ab-tests', 'A/B tests of a campaign: per-variant sent/opens/clicks/replies/interested/bounces with rates, confidence, leader and winner', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return { data: abTestsJson(ctx, c) };
  });

  const cfgBody = abConfigPatchSchema;
  r.put('/api/campaigns/:id/ab-tests/:stepId', 'Configure the A/B test (auto-winner) of a step: metric, minimum sends, reply wait, confidence, test pool', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const main = getMain(c, idParam(req, 'stepId'));
    const b = parse(cfgBody, req.body);
    const cfg = abConfigSchema.parse({ ...(main.ab_test ? parseAbConfig(main.ab_test) : {}), ...b });
    if (cfg.enabled) checkMetric(c, cfg.metric);
    db.update('sequence_steps', main.id, { ab_test: JSON.stringify(cfg) });
    return { data: abTestsJson(ctx, c).find((t) => t.step_id === main.id) ?? { step_id: main.id, config: cfg } };
  }, { body: cfgBody });

  const pickBody = z.object({ variant_id: z.coerce.number().int().positive() });
  r.post('/api/campaigns/:id/ab-tests/:stepId/pick-winner', 'Manually pick the winning variant of a step (deactivates the other variants)', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const main = getMain(c, idParam(req, 'stepId'));
    const b = parse(pickBody, req.body);
    const rows = db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND step_order = ?', [c.id, main.step_order]);
    if (!rows.some((x) => x.id === b.variant_id)) throw notFound('variant');
    if (main.ab_winner_step_id) resetTest(ctx, c, main);
    const fresh = db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND step_order = ?', [c.id, main.step_order]);
    const res = analyzeStep(ctx, c, fresh, parseAbConfig(main.ab_test));
    const letter = orderedVariants(fresh).findIndex((x) => x.id === b.variant_id);
    applyWinner(ctx, c, mainOf(fresh)!, b.variant_id, 'manual', res, `Variant ${String.fromCharCode(65 + letter)} picked manually.`);
    return { data: abTestsJson(ctx, c).find((t) => t.step_id === main.id) };
  }, { body: pickBody });

  r.post('/api/campaigns/:id/ab-tests/:stepId/reset', 'Reset a step\'s A/B test: re-activate the variants the winner switched off and start testing again', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const main = getMain(c, idParam(req, 'stepId'));
    resetTest(ctx, c, main);
    return { data: abTestsJson(ctx, c).find((t) => t.step_id === main.id) ?? null };
  });

  r.post('/api/campaigns/:id/ab-tests/evaluate', 'Check the campaign\'s running A/B tests now and pick winners that are ready', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const res = evaluateAbTests(ctx, c.id);
    return { data: { ...res, tests: abTestsJson(ctx, c) } };
  });

  r.get('/api/campaigns/:id/ab-tests/decisions', 'History of A/B test decisions (auto and manual) with the stats and p-value behind each', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return {
      data: db.all('SELECT * FROM ab_test_decisions WHERE campaign_id = ? ORDER BY id DESC', [c.id])
        .map((d) => ({ ...d, stats: JSON.parse(d.stats), deactivated_ids: JSON.parse(d.deactivated_ids) })),
    };
  });

  // ---- branching ----
  r.get('/api/sequence-conditions', 'Catalogue of sequence branch condition and action types (for building step rules)', () => ({
    data: {
      conditions: [
        { type: 'opened', fields: { negate: 'boolean', scope: "'previous' (default) | 'any'" }, example: { type: 'opened', negate: true } },
        { type: 'clicked', fields: { negate: 'boolean', scope: "'previous' | 'any'", url: 'optional text the clicked URL contains' }, example: { type: 'clicked', url: 'pricing' } },
        { type: 'replied', fields: { negate: 'boolean' }, example: { type: 'replied' } },
        { type: 'reply_category', fields: { value: "'interested' | 'not_interested'", negate: 'boolean' }, example: { type: 'reply_category', value: 'interested' } },
        { type: 'lead_field', fields: { field: 'email|first_name|last_name|title|company|notes|domain|<custom variable>', op: 'equals|not_equals|contains|not_contains|empty|not_empty|gt|lt', value: 'string or number' }, example: { type: 'lead_field', field: 'title', op: 'contains', value: 'CEO' } },
        { type: 'email_provider', fields: { value: "'google' | 'microsoft' | 'other'", negate: 'boolean' }, example: { type: 'email_provider', value: 'microsoft' } },
        { type: 'has_tag', fields: { tag: 'tag name or id', negate: 'boolean' }, example: { type: 'has_tag', tag: 'VIP' } },
        { type: 'day_of_week', fields: { days: 'monday..sunday[] in the campaign timezone' }, example: { type: 'day_of_week', days: ['friday'] } },
        { type: 'time_since_previous', fields: { op: "'gt' | 'lt'", days: 'number' }, example: { type: 'time_since_previous', op: 'gt', days: 5 } },
      ],
      actions: [
        { type: 'continue', example: { type: 'continue' } },
        { type: 'jump', example: { type: 'jump', step: 3 } },
        { type: 'skip', example: { type: 'skip' } },
        { type: 'wait', example: { type: 'wait', days: 2 } },
        { type: 'end', example: { type: 'end' } },
        { type: 'move', example: { type: 'move', campaign_id: 12 } },
        { type: 'add_tag', example: { type: 'add_tag', tag: 'Clicked pricing' } },
      ].map((a) => ({ ...a, description: describeAction(actionSchema.parse(a.example)) })),
    },
  }));

  r.put('/api/campaigns/:id/sequence/steps/:order/branching', 'Set the branch rules of one sequence step (by step number); null/empty rules = linear', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const order = idParam(req, 'order');
    const main = mainOf(loadSteps(ctx, c.id).get(order));
    if (!main) throw notFound('step');
    const b = parse(branchingSchema, req.body);
    const empty = !b.rules.length && b.else.type === 'continue' && !b.max_visits && b.check_after_days === undefined;
    db.update('sequence_steps', main.id, { branching: empty ? null : JSON.stringify(b) });
    return { data: { step_order: order, branching: empty ? null : b, ...validateBranching(ctx, c, loadSteps(ctx, c.id)) } };
  }, { body: branchingSchema });

  r.get('/api/campaigns/:id/branching/check', 'Validate a campaign\'s branches: dangling targets (problems) and unreachable steps (warnings)', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return { data: validateBranching(ctx, c, loadSteps(ctx, c.id)) };
  });

  r.get('/api/campaigns/:id/branching/stats', 'How many leads took each branch rule of each step', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return {
      data: db.all(
        `SELECT from_step, rule_index, target_step, json_extract(action, '$.type') AS action, COUNT(*) AS n, COUNT(DISTINCT lead_id) AS leads
         FROM sequence_path_events WHERE campaign_id = ? GROUP BY from_step, rule_index, target_step, action ORDER BY from_step, rule_index`, [c.id]),
    };
  });

  r.get('/api/campaigns/:id/leads/:leadId/path', 'A lead\'s path through a campaign: emails sent (variant, opens, clicks, replies) and every branch taken and why', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    const leadId = idParam(req, 'leadId');
    const cl = db.get('SELECT cl.*, l.email FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? AND cl.lead_id = ?', [c.id, leadId]);
    if (!cl) throw notFound('lead in campaign');
    const letters = new Map<number, string>();
    for (const rows of loadSteps(ctx, c.id).values()) orderedVariants(rows).forEach((v, i) => letters.set(v.id, String.fromCharCode(65 + i)));
    const sent = db.all(
      `SELECT se.id, se.sent_at AS at, se.step_order, se.sequence_step_id, se.subject, se.opens, se.clicks, se.bounced,
         (SELECT COUNT(*) FROM replies r WHERE r.sent_email_id = se.id AND r.automated = 0 AND r.folder != 'bounced') AS replies
       FROM sent_emails se WHERE se.campaign_lead_id = ? AND se.kind = 'campaign'`, [cl.id])
      .map((s) => ({ type: 'sent' as const, ...s, variant: letters.get(s.sequence_step_id) ?? null }));
    const branches = db.all('SELECT * FROM sequence_path_events WHERE campaign_lead_id = ?', [cl.id])
      .map((p) => {
        const action = JSON.parse(p.action);
        return { type: 'branch' as const, id: p.id, at: p.created_at, from_step: p.from_step, rule_index: p.rule_index, action, target_step: p.target_step, reason: p.reason, description: describeAction(action) };
      });
    const replies = db.all(`SELECT id, received_at AS at, category, interested, subject FROM replies WHERE lead_id = ? AND campaign_id = ? AND automated = 0 AND folder != 'bounced'`, [leadId, c.id])
      .map((x) => ({ type: 'reply' as const, ...x }));
    const timeline = [...sent, ...branches, ...replies].sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.type === 'branch' ? -1 : 1));
    return {
      data: {
        lead: { id: leadId, email: cl.email }, status: cl.status, current_step: cl.current_step,
        next_step: cl.next_step ?? (['pending', 'in_sequence'].includes(cl.status) ? cl.current_step + 1 : null),
        next_due_at: cl.next_due_at, visits: readState(cl).visits ?? {}, email_provider: cachedProvider(ctx, cl.email), timeline,
      },
    };
  });

  // ---- recipient provider ----
  const lookupBody = z.object({ emails: z.array(z.string()).max(100).default([]), domains: z.array(z.string()).max(100).default([]) });
  r.post('/api/email-provider/lookup', 'Detect recipient mailbox providers (Google / Microsoft / other) from MX records; results are cached', async (req) => {
    canWrite(req);
    const b = parse(lookupBody, req.body);
    const domains = [...new Set([...b.emails.map(domainOf), ...b.domains.map((d) => d.toLowerCase().trim())].filter(Boolean))];
    const out = [];
    for (const d of domains) out.push(await lookupProvider(ctx, d));
    return { data: out };
  }, { body: lookupBody });
}
