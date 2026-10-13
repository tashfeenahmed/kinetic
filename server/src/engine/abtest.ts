/**
 * A/B testing of step variants with an automatic winner.
 *
 * Statistic: one-sided two-proportion z-test of the leading variant against every other
 * active variant (pooled standard error). The test is decided when every variant has at
 * least `min_sends_per_variant` *mature* sends (sent at least `reply_wait_days` ago, so
 * replies had time to arrive) and the largest p-value is at most 1 - `confidence`.
 * Exact ties never decide.
 *
 * Pool modes:
 *  - "all":     every lead is split evenly across active variants until a winner is found.
 *  - "percent": only `test_percent`% of leads (stable per lead) take part; the rest wait at
 *               this step until a winner is picked. Once the test pool has been through the
 *               step and the reply wait has passed, the leader is picked even if the result
 *               is not significant (the decision records the p-value), so the rest are never
 *               stuck. A full tie then keeps variant A.
 */
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { hashSeed } from '../lib/template.ts';
import { tryAddLearning } from '../knowledge/learnings.ts';
import { loadSteps } from './sequencer.ts';

export const METRICS = ['reply_rate', 'interested_rate', 'positive_reply_rate', 'open_rate', 'click_rate'] as const;
export type Metric = (typeof METRICS)[number];

/** Partial update (no defaults, so omitted fields keep their current value). */
export const abConfigPatchSchema = z.object({
  enabled: z.boolean(),
  metric: z.enum(METRICS),
  min_sends_per_variant: z.number().int().min(1).max(100_000),
  reply_wait_days: z.number().min(0).max(60),
  confidence: z.number().min(0.5).max(0.9999),
  pool: z.enum(['all', 'percent']),
  test_percent: z.number().int().min(1).max(100),
}).partial();

export const abConfigSchema = z.object({
  enabled: z.boolean().default(false),
  metric: z.enum(METRICS).default('reply_rate'),
  min_sends_per_variant: z.number().int().min(1).max(100_000).default(100),
  reply_wait_days: z.number().min(0).max(60).default(3),
  confidence: z.number().min(0.5).max(0.9999).default(0.95),
  pool: z.enum(['all', 'percent']).default('all'),
  test_percent: z.number().int().min(1).max(100).default(20),
});
export type AbConfig = z.infer<typeof abConfigSchema>;

export function parseAbConfig(raw: unknown): AbConfig {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const r = abConfigSchema.safeParse(v ?? {});
    return r.success ? r.data : abConfigSchema.parse({});
  } catch {
    return abConfigSchema.parse({});
  }
}

// ---- statistics ------------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** One-sided p-value that A's rate is higher than B's (two-proportion z-test, pooled SE). */
export function zTestPValue(x1: number, n1: number, x2: number, n2: number): number {
  if (!n1 || !n2) return 1;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return 1 - normCdf((p1 - p2) / se);
}

export interface VariantStats {
  id: number;
  letter: string;
  is_main: boolean;
  email_subject: string;
  active: boolean;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  interested: number;
  positive_replies: number;
  bounces: number;
  open_rate: number;
  click_rate: number;
  reply_rate: number;
  interested_rate: number;
  positive_reply_rate: number;
  bounce_rate: number;
  /** Sends old enough to count toward the decision, and successes among them. */
  mature_sent: number;
  mature_successes: number;
  metric_rate: number;
  /** Confidence that the leader beats this variant (for the leader: the lowest over all rivals). */
  confidence: number | null;
  is_leader: boolean;
  is_winner: boolean;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 100 : 0);
const letter = (i: number) => String.fromCharCode(65 + i);
const SUCCESS: Record<Metric, string> = {
  reply_rate: 'replied', interested_rate: 'interested', positive_reply_rate: 'positive', open_rate: 'opened', click_rate: 'clicked',
};

/** Variant rows of a step: the main row first (A), then variants by id (B, C…). */
export function orderedVariants(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (a.variant_of_step_id ? 1 : 0) - (b.variant_of_step_id ? 1 : 0) || a.id - b.id);
}

export interface TestResult {
  variants: VariantStats[];
  leader_id: number | null;
  p_value: number | null;
  decidable: boolean;
  forced: boolean;
  reason: string;
}

/** Computes per-variant stats and whether the test can be decided now. */
export function analyzeStep(ctx: Ctx, campaign: Row, rows: Row[], cfg: AbConfig): TestResult {
  const { db } = ctx;
  const now = ctx.now().getTime();
  const cutoff = new Date(now - cfg.reply_wait_days * 86_400_000).toISOString();
  const ordered = orderedVariants(rows);
  const main = ordered[0]!;
  const raw = ordered.map((v) => db.get(
    `SELECT COUNT(*) AS sent,
       COALESCE(SUM(first_opened_at IS NOT NULL),0) AS opened, COALESCE(SUM(clicks > 0),0) AS clicked, COALESCE(SUM(bounced),0) AS bounced,
       COALESCE(SUM(replied),0) AS replied, COALESCE(SUM(interested),0) AS interested, COALESCE(SUM(positive),0) AS positive,
       COALESCE(SUM(sent_at <= ?),0) AS mature_sent,
       COALESCE(SUM(CASE WHEN sent_at <= ? THEN ${SUCCESS[cfg.metric]} ELSE 0 END),0) AS mature_successes
     FROM (SELECT se.sent_at, se.first_opened_at, se.clicks, se.bounced,
             EXISTS (SELECT 1 FROM replies r WHERE r.sent_email_id = se.id AND r.automated = 0 AND r.folder != 'bounced' AND r.category != 'bounce') AS replied,
             EXISTS (SELECT 1 FROM replies r WHERE r.sent_email_id = se.id AND r.automated = 0 AND (r.interested = 1 OR r.category = 'interested')) AS interested,
             EXISTS (SELECT 1 FROM replies r WHERE r.sent_email_id = se.id AND r.automated = 0 AND r.folder != 'bounced' AND r.category NOT IN ('not_interested','unsubscribe','auto_reply','bounce')) AS positive,
             (se.first_opened_at IS NOT NULL) AS opened, (se.clicks > 0) AS clicked
           FROM sent_emails se WHERE se.sequence_step_id = ? AND se.kind = 'campaign')`,
    [cutoff, cutoff, v.id])!);

  const variants: VariantStats[] = ordered.map((v, i) => {
    const r = raw[i]!;
    const sent = r.sent as number;
    return {
      id: v.id, letter: letter(i), is_main: v.id === main.id, email_subject: v.email_subject, active: !!v.active,
      sent, opens: r.opened, clicks: r.clicked, replies: r.replied, interested: r.interested, positive_replies: r.positive, bounces: r.bounced,
      open_rate: pct(r.opened, sent), click_rate: pct(r.clicked, sent), reply_rate: pct(r.replied, sent),
      interested_rate: pct(r.interested, sent), positive_reply_rate: pct(r.positive, sent), bounce_rate: pct(r.bounced, sent),
      mature_sent: r.mature_sent, mature_successes: r.mature_successes, metric_rate: pct(r.mature_successes, r.mature_sent),
      confidence: null, is_leader: false, is_winner: main.ab_winner_step_id === v.id,
    };
  });

  const running = variants.filter((v) => v.active);
  const result: TestResult = { variants, leader_id: null, p_value: null, decidable: false, forced: false, reason: '' };
  // Once decided only the winner is active; keep showing confidence across every variant that was sent.
  const active = running.length >= 2 ? running : variants.filter((v) => v.active || v.sent > 0);
  if (active.length < 2) {
    result.reason = 'Needs at least two active variants.';
    return result;
  }
  // Leader by mature rate; ties keep the earlier variant (A before B).
  const rate = (v: VariantStats) => (v.mature_sent ? v.mature_successes / v.mature_sent : 0);
  const leader = active.reduce((best, v) => (rate(v) > rate(best) ? v : best), active[0]!);
  leader.is_leader = leader.mature_sent > 0;
  let pMax = 0;
  for (const v of active) {
    if (v === leader) continue;
    const p = zTestPValue(leader.mature_successes, leader.mature_sent, v.mature_successes, v.mature_sent);
    v.confidence = Math.round((1 - p) * 10_000) / 10_000;
    pMax = Math.max(pMax, p);
  }
  leader.confidence = Math.round((1 - pMax) * 10_000) / 10_000;
  result.leader_id = leader.id;
  result.p_value = Math.round(pMax * 1e6) / 1e6;

  const short = active.filter((v) => v.mature_sent < cfg.min_sends_per_variant);
  const significant = pMax <= 1 - cfg.confidence;
  const tie = active.some((v) => v !== leader && rate(v) === rate(leader));

  if (running.length < 2) {
    result.reason = 'Only one variant is active.';
    return result;
  }
  if (!short.length && significant && !tie) {
    result.decidable = true;
    result.reason = `Variant ${leader.letter} wins with ${(leader.confidence * 100).toFixed(1)}% confidence.`;
    return result;
  }
  if (cfg.pool === 'percent' && active.every((v) => v.mature_sent > 0) && poolExhausted(ctx, campaign, main, cfg)) {
    result.decidable = true;
    result.forced = true;
    result.reason = `Test pool finished: variant ${leader.letter} leads${tie ? ' (tie, keeping the first variant)' : ''} at ${(leader.confidence * 100).toFixed(1)}% confidence.`;
    return result;
  }
  if (short.length) {
    result.reason = `Waiting for ${cfg.min_sends_per_variant} sends per variant that are at least ${cfg.reply_wait_days} day(s) old (${active.map((v) => `${v.letter}: ${v.mature_sent}`).join(', ')}).`;
  } else if (tie) {
    result.reason = 'Variants are tied.';
  } else {
    result.reason = `Not significant yet: ${(leader.confidence * 100).toFixed(1)}% < ${(cfg.confidence * 100).toFixed(1)}% confidence.`;
  }
  return result;
}

/** Whether a lead is in the test pool of a step (stable per lead). */
export function inTestPool(leadId: number, stepOrder: number, percent: number): boolean {
  return hashSeed(leadId, stepOrder, 'ab-pool') % 100 < percent;
}

/** Percent mode: every pool lead has gone past the step and the reply wait since the last send has passed. */
function poolExhausted(ctx: Ctx, campaign: Row, main: Row, cfg: AbConfig): boolean {
  const { db } = ctx;
  const order = main.step_order;
  const waiting = db.all(
    `SELECT lead_id FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','in_sequence') AND current_step < ?`, [campaign.id, order])
    .some((r) => inTestPool(r.lead_id, order, cfg.test_percent));
  if (waiting) return false;
  if (db.get(`SELECT 1 FROM scheduled_emails WHERE campaign_id = ? AND step_order = ? AND status IN ('scheduled','sending') LIMIT 1`, [campaign.id, order])) return false;
  const last = db.get<{ t: string | null }>(
    `SELECT MAX(se.sent_at) t FROM sent_emails se JOIN sequence_steps st ON st.id = se.sequence_step_id WHERE st.campaign_id = ? AND st.step_order = ?`, [campaign.id, order])?.t;
  return !!last && Date.parse(last) <= ctx.now().getTime() - cfg.reply_wait_days * 86_400_000;
}

/**
 * Planner gate: in percent mode, leads outside the test pool wait at a step whose test is
 * still running. Returns true when the lead may get this step now.
 */
export function mayEnterStep(rows: Row[], leadId: number, stepOrder: number): boolean {
  const main = rows.find((r) => !r.variant_of_step_id) ?? rows[0];
  if (!main || main.ab_winner_step_id) return true;
  const cfg = parseAbConfig(main.ab_test);
  if (!cfg.enabled || cfg.pool !== 'percent') return true;
  if (rows.filter((r) => r.active).length < 2) return true;
  return inTestPool(leadId, stepOrder, cfg.test_percent);
}

// ---- decisions -------------------------------------------------------------

/** Switches off every other variant, records the decision and emits AB_TEST_WINNER. */
export function applyWinner(ctx: Ctx, campaign: Row, main: Row, winnerId: number, by: 'auto' | 'manual', result: TestResult | null, note = ''): number {
  const { db } = ctx;
  const rows = db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND step_order = ?', [campaign.id, main.step_order]);
  const winner = rows.find((r) => r.id === winnerId);
  if (!winner) throw new Error('winner is not a variant of this step');
  const cfg = parseAbConfig(main.ab_test);
  const decisionId = db.tx(() => {
    const losers = rows.filter((r) => r.id !== winnerId && r.active).map((r) => r.id as number);
    const now = ctx.now().toISOString();
    if (losers.length) {
      db.run(`UPDATE sequence_steps SET active = 0 WHERE id IN (${losers.map(() => '?').join(',')})`, losers);
      // Booked but unsent slots of losing variants are re-planned with the winner.
      db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'A/B test decided' WHERE status = 'scheduled' AND sequence_step_id IN (${losers.map(() => '?').join(',')})`, losers);
    }
    db.run('UPDATE sequence_steps SET active = 1 WHERE id = ?', [winnerId]);
    db.update('sequence_steps', main.id, { ab_winner_step_id: winnerId, ab_decided_at: now });
    const winStats = result?.variants.find((v) => v.id === winnerId);
    const decisionId = db.insert('ab_test_decisions', {
      workspace_id: campaign.workspace_id, campaign_id: campaign.id, step_id: main.id, step_order: main.step_order, winner_step_id: winnerId,
      decided_by: by, metric: cfg.metric, p_value: result?.p_value ?? null, confidence: winStats?.confidence ?? null,
      stats: JSON.stringify(result?.variants ?? []), deactivated_ids: JSON.stringify(losers), note: note || result?.reason || '', created_at: now,
    });
    emit(ctx, campaign.workspace_id, 'AB_TEST_WINNER', {
      decision_id: decisionId, campaign_id: campaign.id, campaign_name: campaign.name, step_order: main.step_order,
      winner_step_id: winnerId, winner_variant: winStats?.letter ?? null, decided_by: by, metric: cfg.metric,
      p_value: result?.p_value ?? null, confidence: winStats?.confidence ?? null, deactivated_step_ids: losers,
      variants: result?.variants.map((v) => ({ id: v.id, variant: v.letter, sent: v.sent, metric_rate: v.metric_rate })) ?? [],
    }, { campaign_id: campaign.id });
    return decisionId;
  });
  tryAddLearning(ctx, campaign.workspace_id, abLearning(campaign, rows, winnerId, cfg, result, by));
  return decisionId;
}

/** One line for the Knowledge Hub's Learnings doc, e.g. `Campaign X step 1: subject "A" beat "B" on reply rate (4.1% vs 1.9%, …)`. */
export function abLearning(campaign: Row, rows: Row[], winnerId: number, cfg: AbConfig, result: TestResult | null, by: 'auto' | 'manual'): string {
  const ordered = orderedVariants(rows);
  const win = ordered.find((r) => r.id === winnerId)!;
  const stats = new Map(result?.variants.map((v) => [v.id, v]) ?? []);
  const rivals = ordered.filter((r) => r.id !== winnerId && (stats.get(r.id)?.sent ?? 1) > 0);
  // The strongest loser is the fairest comparison.
  const loser = rivals.reduce<Row | undefined>((best, r) => (!best || (stats.get(r.id)?.metric_rate ?? 0) > (stats.get(best.id)?.metric_rate ?? 0) ? r : best), undefined);
  const bySubject = !!win.email_subject && !!loser?.email_subject && win.email_subject !== loser.email_subject;
  const clip = (t: string) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > 70 ? `${s.slice(0, 70)}…` : s; };
  const what = (r: Row) => `"${clip(bySubject ? r.email_subject : r.email_body)}"`;
  const head = `Campaign ${campaign.name} step ${win.step_order}: ${bySubject ? 'subject' : 'email'} ${what(win)}`;
  if (!loser) return `${head} was kept as the winner (${by === 'manual' ? 'picked by hand' : 'picked automatically'}).`;
  const ws = stats.get(win.id);
  const ls = stats.get(loser.id);
  const n = [...stats.values()].reduce((sum, v) => sum + v.mature_sent, 0);
  const nums = ws && ls
    ? ` (${ws.metric_rate}% vs ${ls.metric_rate}%, n=${n}${ws.confidence != null ? `, ${Math.round(ws.confidence * 100)}% confidence` : ''}${by === 'manual' ? ', picked by hand' : ''})`
    : by === 'manual' ? ' (picked by hand)' : '';
  return `${head} beat ${what(loser)} on ${cfg.metric.replace(/_/g, ' ')}${nums}.`;
}

/** Undoes the current decision: re-activates the variants it switched off. */
export function resetTest(ctx: Ctx, campaign: Row, main: Row) {
  const { db } = ctx;
  db.tx(() => {
    const d = db.get('SELECT * FROM ab_test_decisions WHERE step_id = ? AND reset_at IS NULL ORDER BY id DESC LIMIT 1', [main.id]);
    if (d) {
      const ids = (JSON.parse(d.deactivated_ids) as number[]);
      if (ids.length) db.run(`UPDATE sequence_steps SET active = 1 WHERE campaign_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [campaign.id, ...ids]);
      db.update('ab_test_decisions', d.id, { reset_at: ctx.now().toISOString() });
    }
    db.update('sequence_steps', main.id, { ab_winner_step_id: null, ab_decided_at: null });
  });
}

/** Background job: decides every running test that is ready. */
export function evaluateAbTests(ctx: Ctx, campaignId?: number): { decided: number } {
  const { db } = ctx;
  const mains = db.all(
    `SELECT st.* FROM sequence_steps st JOIN campaigns c ON c.id = st.campaign_id
     WHERE st.variant_of_step_id IS NULL AND st.ab_winner_step_id IS NULL AND st.ab_test IS NOT NULL
       AND c.status IN ('active','paused','completed')${campaignId ? ' AND c.id = ?' : ''}`, campaignId ? [campaignId] : []);
  let decided = 0;
  for (const main of mains) {
    const cfg = parseAbConfig(main.ab_test);
    if (!cfg.enabled) continue;
    try {
      const campaign = db.get('SELECT * FROM campaigns WHERE id = ?', [main.campaign_id])!;
      const rows = db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND step_order = ?', [campaign.id, main.step_order]);
      if (rows.filter((r) => r.active).length < 2) continue;
      const res = analyzeStep(ctx, campaign, rows, cfg);
      if (res.decidable && res.leader_id) {
        applyWinner(ctx, campaign, main, res.leader_id, 'auto', res);
        decided++;
      }
    } catch (err) {
      ctx.log.error({ err, step: main.id }, 'A/B evaluation failed');
    }
  }
  return { decided };
}

/** Everything the UI/API shows about a campaign's A/B tests. */
export function abTestsJson(ctx: Ctx, campaign: Row) {
  const steps = loadSteps(ctx, campaign.id);
  const out = [];
  for (const [order, rows] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    if (rows.length < 2) continue;
    const main = orderedVariants(rows)[0]!;
    const cfg = parseAbConfig(main.ab_test);
    const res = analyzeStep(ctx, campaign, rows, cfg);
    const decision = ctx.db.get('SELECT * FROM ab_test_decisions WHERE step_id = ? AND reset_at IS NULL ORDER BY id DESC LIMIT 1', [main.id]);
    out.push({
      step_id: main.id,
      step_order: order,
      config: cfg,
      status: main.ab_winner_step_id ? 'decided' : cfg.enabled ? 'running' : 'manual',
      winner_step_id: main.ab_winner_step_id ?? null,
      decided_at: main.ab_decided_at ?? null,
      leader_step_id: res.leader_id,
      p_value: res.p_value,
      reason: main.ab_winner_step_id ? (decision?.note ?? 'Winner picked.') : res.reason,
      open_tracking_off: cfg.metric === 'open_rate' && !campaign.open_tracking,
      click_tracking_off: cfg.metric === 'click_rate' && !campaign.click_tracking,
      variants: res.variants,
      decision: decision ? { ...decision, stats: JSON.parse(decision.stats), deactivated_ids: JSON.parse(decision.deactivated_ids) } : null,
    });
  }
  return out;
}
