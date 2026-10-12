import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { auth, badRequest, bool, canWrite, defineRoutes, HttpError, idList, idParam, notFound, pageQuery, paginate, parse } from '../http.ts';
import { cancelScheduled, campaignSchedule, loadSteps } from '../engine/sequencer.ts';
import { composeCampaignEmail } from '../engine/compose.ts';
import { buildVariables, missingVariables } from '../lib/template.ts';
import { isValidTimezone, nextWindow, timezones, WEEKDAYS } from '../lib/schedule.ts';
import { attachLeads } from './leads.ts';
import { tagsFor } from './tags.ts';
import { branchingSchema, parseBranching, validateBranching } from '../engine/branching.ts';
import { abConfigPatchSchema, abConfigSchema, parseAbConfig } from '../engine/abtest.ts';

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function campaignStats(ctx: Ctx, c: Row, range?: { start: string; end: string }) {
  const { db } = ctx;
  const timeFilter = range ? ' AND sent_at >= ? AND sent_at < ?' : '';
  const tp = range ? [range.start, range.end] : [];
  const replyFilter = c.include_auto_replies_in_stats ? '' : ' AND automated = 0';
  const s = db.get(
    `SELECT COUNT(*) AS emails_sent, COUNT(DISTINCT lead_id) AS total_leads_contacted, COALESCE(SUM(opens),0) AS opened,
       COUNT(DISTINCT CASE WHEN opens > 0 THEN lead_id END) AS unique_opens_per_contact,
       COALESCE(SUM(clicks),0) AS clicked, COUNT(DISTINCT CASE WHEN bounced = 1 THEN lead_id END) AS bounced
     FROM sent_emails WHERE campaign_id = ? AND kind = 'campaign'${timeFilter}`, [c.id, ...tp])!;
  const rTime = range ? ' AND received_at >= ? AND received_at < ?' : '';
  const replies = db.get(
    `SELECT COUNT(DISTINCT lead_id) AS unique_replies_per_contact, COUNT(*) AS total_replies
     FROM replies WHERE campaign_id = ? AND folder != 'bounced' AND category != 'bounce'${replyFilter}${rTime}`, [c.id, ...tp])!;
  const statuses = db.get(
    `SELECT COUNT(*) AS total_leads,
       SUM(CASE WHEN status = 'interested' THEN 1 ELSE 0 END) AS interested,
       SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed,
       SUM(CASE WHEN status IN ('completed','replied','interested','unsubscribed','bounced','stopped') THEN 1 ELSE 0 END) AS finished,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS not_started,
       SUM(CASE WHEN status = 'in_sequence' THEN 1 ELSE 0 END) AS in_progress
     FROM campaign_leads WHERE campaign_id = ?`, [c.id])!;
  const contacted = s.total_leads_contacted;
  return {
    emails_sent: s.emails_sent,
    total_leads: statuses.total_leads,
    total_leads_contacted: contacted,
    not_started: statuses.not_started ?? 0,
    in_progress: statuses.in_progress ?? 0,
    completed: statuses.finished ?? 0,
    progress_percentage: pct(statuses.finished ?? 0, statuses.total_leads),
    opened: s.opened,
    opened_percentage: pct(s.unique_opens_per_contact, contacted),
    unique_opens_per_contact: s.unique_opens_per_contact,
    unique_opens_per_contact_percentage: pct(s.unique_opens_per_contact, contacted),
    clicked: s.clicked,
    unique_replies_per_contact: replies.unique_replies_per_contact,
    unique_replies_per_contact_percentage: pct(replies.unique_replies_per_contact, contacted),
    total_replies: replies.total_replies,
    bounced: s.bounced,
    bounced_percentage: pct(s.bounced, contacted),
    unsubscribed: statuses.unsubscribed ?? 0,
    unsubscribed_percentage: pct(statuses.unsubscribed ?? 0, contacted),
    interested: statuses.interested ?? 0,
    interested_percentage: pct(statuses.interested ?? 0, contacted),
  };
}

function stepStats(ctx: Ctx, campaignId: number) {
  return ctx.db.all(
    `SELECT st.id AS sequence_step_id, st.step_order, st.variant_of_step_id, st.email_subject, st.active,
       COUNT(se.id) AS sent, COUNT(DISTINCT se.lead_id) AS leads_contacted,
       COUNT(DISTINCT CASE WHEN se.opens > 0 THEN se.lead_id END) AS unique_opens,
       COUNT(DISTINCT CASE WHEN se.bounced = 1 THEN se.lead_id END) AS bounced,
       (SELECT COUNT(DISTINCT r.lead_id) FROM replies r JOIN sent_emails s2 ON s2.id = r.sent_email_id WHERE s2.sequence_step_id = st.id AND r.automated = 0 AND r.folder != 'bounced') AS unique_replies,
       (SELECT COUNT(DISTINCT r.lead_id) FROM replies r JOIN sent_emails s2 ON s2.id = r.sent_email_id WHERE s2.sequence_step_id = st.id AND r.interested = 1) AS interested,
       (SELECT COUNT(DISTINCT r.lead_id) FROM replies r JOIN sent_emails s2 ON s2.id = r.sent_email_id WHERE s2.sequence_step_id = st.id AND r.category = 'unsubscribe') AS unsubscribed
     FROM sequence_steps st LEFT JOIN sent_emails se ON se.sequence_step_id = st.id AND se.kind = 'campaign'
     WHERE st.campaign_id = ? GROUP BY st.id ORDER BY st.step_order, st.id`, [campaignId]);
}

export function campaignJson(ctx: Ctx, c: Row, withStats = true) {
  const { db } = ctx;
  return {
    ...c,
    plain_text: !!c.plain_text,
    open_tracking: !!c.open_tracking,
    click_tracking: !!c.click_tracking,
    can_unsubscribe: !!c.can_unsubscribe,
    include_auto_replies_in_stats: !!c.include_auto_replies_in_stats,
    stop_on_reply: !!c.stop_on_reply,
    schedule: { ...JSON.parse(c.schedule_days), start_time: c.schedule_start_time, end_time: c.schedule_end_time, timezone: c.schedule_timezone },
    sequence_steps_count: db.get<{ n: number }>('SELECT COUNT(DISTINCT step_order) n FROM sequence_steps WHERE campaign_id = ?', [c.id])!.n,
    sender_emails_count: db.get<{ n: number }>('SELECT COUNT(*) n FROM campaign_sender_emails WHERE campaign_id = ?', [c.id])!.n,
    tags: tagsFor(ctx, 'campaign', c.id),
    ...(withStats ? { stats: campaignStats(ctx, c) } : {}),
  };
}

const settingsBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  max_emails_per_day: z.coerce.number().int().min(1).max(100_000).optional(),
  max_new_leads_per_day: z.coerce.number().int().min(0).max(100_000).optional(),
  daily_max_sends_per_receiving_domain: z.coerce.number().int().min(0).max(100_000).optional(),
  plain_text: bool.optional(),
  open_tracking: bool.optional(),
  click_tracking: bool.optional(),
  reputation_building: bool.optional(),
  can_unsubscribe: bool.optional(),
  include_auto_replies_in_stats: bool.optional(),
  sequence_prioritization: z.enum(['followups', 'new_leads']).optional(),
  stop_on_reply: bool.optional(),
  custom_tracking_domain_id: z.coerce.number().int().nullable().optional(),
});

const scheduleBody = z.object({
  ...Object.fromEntries(WEEKDAYS.map((d) => [d, bool])) as Record<(typeof WEEKDAYS)[number], typeof bool>,
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().refine(isValidTimezone, 'is not a valid timezone'),
  save_as_template: bool.default(false),
  template_name: z.string().optional(),
});

const variantInput = z.object({
  id: z.number().int().optional(),
  email_subject: z.string().max(1000).default(''),
  email_body: z.string().max(100_000).default(''),
  active: bool.default(true),
});
// Optional branching rules / A/B config; omitted = keep what the step has (null clears).
const branchingInput = branchingSchema.nullable().optional();
const abTestInput = abConfigPatchSchema.nullable().optional();
const stepInput = variantInput.extend({
  wait_in_days: z.coerce.number().int().min(0).max(365).default(1),
  thread_reply: bool.default(false),
  variants: z.array(variantInput).max(25).default([]),
  branching: branchingInput,
  ab_test: abTestInput,
});
const sequenceBody = z.object({ title: z.string().max(200).optional(), steps: z.array(stepInput).max(50) });

/** Replaces a campaign's sequence, keeping ids of steps/variants that still exist. */
export function saveSequence(ctx: Ctx, campaignId: number, steps: z.infer<typeof stepInput>[], title?: string) {
  const { db } = ctx;
  db.tx(() => {
    const keep = new Set<number>();
    const existing = new Set(db.all('SELECT id FROM sequence_steps WHERE campaign_id = ?', [campaignId]).map((r) => r.id as number));
    const upsert = (row: Row, id?: number) => {
      if (id && existing.has(id)) {
        db.update('sequence_steps', id, row);
        keep.add(id);
        return id;
      }
      const newId = db.insert('sequence_steps', { campaign_id: campaignId, ...row });
      keep.add(newId);
      return newId;
    };
    steps.forEach((s, i) => {
      const order = i + 1;
      const extra: Row = {};
      if (s.branching !== undefined) extra.branching = s.branching && (s.branching.rules.length || s.branching.else.type !== 'continue' || s.branching.max_visits || s.branching.check_after_days !== undefined) ? JSON.stringify(s.branching) : null;
      if (s.ab_test !== undefined) extra.ab_test = s.ab_test ? JSON.stringify(abConfigSchema.parse(s.ab_test)) : null;
      const mainId = upsert({ step_order: order, variant_of_step_id: null, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: order === 1 ? 0 : s.wait_in_days, thread_reply: order === 1 ? 0 : s.thread_reply ? 1 : 0, active: s.active ? 1 : 0, ...extra }, s.id);
      for (const v of s.variants) {
        upsert({ step_order: order, variant_of_step_id: mainId, email_subject: v.email_subject, email_body: v.email_body, wait_in_days: order === 1 ? 0 : s.wait_in_days, thread_reply: order === 1 ? 0 : s.thread_reply ? 1 : 0, active: v.active ? 1 : 0 }, v.id);
      }
    });
    for (const id of existing) if (!keep.has(id)) db.run('DELETE FROM sequence_steps WHERE id = ?', [id]);
    if (title !== undefined) db.run('UPDATE campaigns SET sequence_title = ? WHERE id = ?', [title, campaignId]);
    db.run('UPDATE campaigns SET updated_at = ? WHERE id = ?', [ctx.now().toISOString(), campaignId]);
  });
}

export function sequenceJson(ctx: Ctx, campaignId: number) {
  const steps = loadSteps(ctx, campaignId);
  const out = [];
  for (const [order, rows] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    const main = rows.find((r) => !r.variant_of_step_id) ?? rows[0]!;
    out.push({
      id: main.id, step_order: order, email_subject: main.email_subject, email_body: main.email_body,
      wait_in_days: main.wait_in_days, thread_reply: !!main.thread_reply, active: !!main.active,
      variants: rows.filter((r) => r.id !== main.id).map((v) => ({ id: v.id, email_subject: v.email_subject, email_body: v.email_body, active: !!v.active })),
      branching: main.branching ? parseBranching(main.branching) : null,
      ab_test: main.ab_test ? parseAbConfig(main.ab_test) : null,
      ab_winner_step_id: main.ab_winner_step_id ?? null,
    });
  }
  return out;
}

export function campaignRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Campaigns');
  const { db } = ctx;

  const getCampaign = (ws: number, id: number) => {
    const c = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [id, ws]);
    if (!c) throw notFound('campaign');
    return c;
  };

  const listQ = pageQuery.extend({ search: z.string().optional(), status: z.string().optional(), tag_id: z.coerce.number().int().optional() });
  r.get('/api/campaigns', 'List campaigns', (req) => {
    const a = auth(req);
    const q = parse(listQ, req.query);
    const where = ['workspace_id = ?'];
    const params: any[] = [a.workspaceId];
    if (q.search) { where.push('name LIKE ?'); params.push(`%${q.search}%`); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    else where.push(`status != 'archived'`);
    if (q.tag_id) { where.push(`EXISTS (SELECT 1 FROM taggables t WHERE t.taggable_type = 'campaign' AND t.taggable_id = campaigns.id AND t.tag_id = ?)`); params.push(q.tag_id); }
    return paginate(ctx, `SELECT * FROM campaigns WHERE ${where.join(' AND ')} ORDER BY id DESC`, params, q, (c) => campaignJson(ctx, c));
  }, { query: listQ });

  const createBody = z.object({ name: z.string().trim().min(1).max(200), type: z.enum(['outbound', 'reply_followup']).default('outbound') });
  r.post('/api/campaigns', 'Create campaign', (req) => {
    const a = canWrite(req);
    const b = parse(createBody, req.body);
    const tz = db.get('SELECT timezone FROM schedule_templates WHERE workspace_id = ? ORDER BY id LIMIT 1', [a.workspaceId])?.timezone ?? 'America/New_York';
    const id = db.insert('campaigns', { workspace_id: a.workspaceId, name: b.name, type: b.type, schedule_timezone: tz });
    db.insert('sequence_steps', { campaign_id: id, step_order: 1, email_subject: '', email_body: '', wait_in_days: 0 });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, id)) };
  }, { body: createBody });

  r.get('/api/campaigns/schedule/templates', 'Schedule templates', (req) => ({
    data: db.all('SELECT * FROM schedule_templates WHERE workspace_id = ? ORDER BY id', [auth(req).workspaceId]).map((t) => ({ ...t, ...JSON.parse(t.days) })),
  }));
  r.delete('/api/campaigns/schedule/templates/:id', 'Delete schedule template', (req) => {
    const a = canWrite(req);
    if (!db.run('DELETE FROM schedule_templates WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes) throw notFound('template');
    return { data: { success: true } };
  });
  r.get('/api/campaigns/schedule/available-timezones', 'Available timezones', () => ({ data: timezones() }));

  r.get('/api/campaigns/:id', 'Campaign details', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const next = c.status === 'active' ? nextWindow(campaignSchedule(c), ctx.now()) : null;
    return { data: { ...campaignJson(ctx, c), next_window: next } };
  });

  r.patch('/api/campaigns/:id/update', 'Update campaign settings', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(settingsBody, req.body);
    delete (b as any).reputation_building;
    if (b.custom_tracking_domain_id && !db.get('SELECT 1 FROM custom_tracking_domains WHERE id = ? AND workspace_id = ?', [b.custom_tracking_domain_id, a.workspaceId])) throw notFound('tracking domain');
    db.update('campaigns', c.id, { ...b, updated_at: ctx.now().toISOString() });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, c.id)) };
  }, { body: settingsBody });

  // ---- lifecycle ----
  r.post('/api/campaigns/:id/launch', 'Launch campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const problems = launchProblems(ctx, c);
    if (problems.length) throw new HttpError(422, { error: 'validation_error', message: problems[0], problems });
    db.update('campaigns', c.id, { status: 'active', launched_at: c.launched_at ?? ctx.now().toISOString(), updated_at: ctx.now().toISOString() });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, c.id)) };
  });
  r.get('/api/campaigns/:id/launch-check', 'What still needs doing before launch', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    return { data: { problems: launchProblems(ctx, c), warnings: validateBranching(ctx, c, loadSteps(ctx, c.id)).warnings } };
  });

  r.patch('/api/campaigns/:id/pause', 'Pause campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    db.tx(() => {
      db.update('campaigns', c.id, { status: 'paused', updated_at: ctx.now().toISOString() });
      cancelScheduled(ctx, { campaignId: c.id }, 'campaign paused');
    });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, c.id)) };
  });
  r.patch('/api/campaigns/:id/resume', 'Resume campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    if (c.status === 'draft') {
      const problems = launchProblems(ctx, c);
      if (problems.length) throw new HttpError(422, { error: 'validation_error', message: problems[0], problems });
    }
    db.update('campaigns', c.id, { status: 'active', launched_at: c.launched_at ?? ctx.now().toISOString(), updated_at: ctx.now().toISOString() });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, c.id)) };
  });
  r.patch('/api/campaigns/:id/archive', 'Archive campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    db.tx(() => {
      db.update('campaigns', c.id, { status: 'archived', updated_at: ctx.now().toISOString() });
      cancelScheduled(ctx, { campaignId: c.id }, 'campaign archived');
    });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, c.id)) };
  });

  r.post('/api/campaigns/:id/duplicate', 'Duplicate campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const id = db.tx(() => {
      const { id: _id, status: _s, launched_at: _l, created_at: _c, updated_at: _u, ...rest } = c;
      const newId = db.insert('campaigns', { ...rest, name: `${c.name} (copy)`, status: 'draft' });
      saveSequence(ctx, newId, sequenceJson(ctx, c.id).map(({ id: _i, variants, ...s }) => ({ ...s, variants: variants.map(({ id: _v, ...v }) => v) })));
      db.run('INSERT INTO campaign_sender_emails (campaign_id, sender_email_id) SELECT ?, sender_email_id FROM campaign_sender_emails WHERE campaign_id = ?', [newId, c.id]);
      return newId;
    });
    return { data: campaignJson(ctx, getCampaign(a.workspaceId, id)) };
  });

  r.delete('/api/campaigns/:id', 'Delete campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    db.run('DELETE FROM campaigns WHERE id = ?', [c.id]);
    db.run(`DELETE FROM taggables WHERE taggable_type = 'campaign' AND taggable_id = ?`, [c.id]);
    return { data: { success: true } };
  });

  const bulkDel = z.object({ campaign_ids: idList });
  r.delete('/api/campaigns/bulk', 'Bulk delete campaigns', (req) => {
    const a = canWrite(req);
    const b = parse(bulkDel, req.body);
    const n = db.run(`DELETE FROM campaigns WHERE workspace_id = ? AND id IN (${b.campaign_ids.map(() => '?').join(',')})`, [a.workspaceId, ...b.campaign_ids]).changes;
    return { data: { deleted: n } };
  }, { body: bulkDel });

  // ---- schedule ----
  const scheduleJson = (c: Row) => ({ ...JSON.parse(c.schedule_days), start_time: c.schedule_start_time, end_time: c.schedule_end_time, timezone: c.schedule_timezone });
  r.get('/api/campaigns/:id/schedule', 'View campaign schedule', (req) => ({ data: scheduleJson(getCampaign(auth(req).workspaceId, idParam(req))) }));
  const saveSchedule = (req: any) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(scheduleBody, req.body);
    const days = Object.fromEntries(WEEKDAYS.map((d) => [d, !!b[d]]));
    if (!Object.values(days).some(Boolean)) throw new HttpError(422, { error: 'validation_error', message: 'Pick at least one sending day.' });
    if (b.start_time === b.end_time) throw new HttpError(422, { error: 'validation_error', message: 'Start and end time cannot be the same.' });
    db.tx(() => {
      db.update('campaigns', c.id, { schedule_days: JSON.stringify(days), schedule_start_time: b.start_time, schedule_end_time: b.end_time, schedule_timezone: b.timezone, updated_at: ctx.now().toISOString() });
      // Re-plan with the new hours.
      cancelScheduled(ctx, { campaignId: c.id }, 'schedule changed');
      if (b.save_as_template) db.insert('schedule_templates', { workspace_id: a.workspaceId, name: b.template_name || `${b.start_time}–${b.end_time} ${b.timezone}`, days: JSON.stringify(days), start_time: b.start_time, end_time: b.end_time, timezone: b.timezone });
    });
    return { data: scheduleJson(getCampaign(a.workspaceId, c.id)) };
  };
  r.post('/api/campaigns/:id/schedule', 'Create campaign schedule', saveSchedule, { body: scheduleBody });
  r.put('/api/campaigns/:id/schedule', 'Update campaign schedule', saveSchedule, { body: scheduleBody });
  const fromTpl = z.object({ schedule_id: z.coerce.number().int() });
  r.post('/api/campaigns/:id/create-schedule-from-template', 'Apply schedule template', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const t = db.get('SELECT * FROM schedule_templates WHERE id = ? AND workspace_id = ?', [parse(fromTpl, req.body).schedule_id, a.workspaceId]);
    if (!t) throw notFound('template');
    db.update('campaigns', c.id, { schedule_days: t.days, schedule_start_time: t.start_time, schedule_end_time: t.end_time, schedule_timezone: t.timezone });
    cancelScheduled(ctx, { campaignId: c.id }, 'schedule changed');
    return { data: scheduleJson(getCampaign(a.workspaceId, c.id)) };
  }, { body: fromTpl });

  // ---- sequence ----
  const sr = defineRoutes(app, 'Sequence Steps');
  sr.get('/api/campaigns/:id/sequence', 'Get campaign sequence (steps with variants)', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return { data: { title: c.sequence_title, steps: sequenceJson(ctx, c.id) } };
  });
  sr.put('/api/campaigns/:id/sequence', 'Save campaign sequence', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(sequenceBody, req.body);
    saveSequence(ctx, c.id, b.steps, b.title);
    return { data: { title: b.title ?? c.sequence_title, steps: sequenceJson(ctx, c.id) } };
  }, { body: sequenceBody });

  // EmailBison-compatible v1.1 shape: flat list with variant flags.
  const v11Step = z.object({
    email_subject: z.string(), email_body: z.string(), wait_in_days: z.coerce.number().int().min(0), order: z.number().int().optional(),
    variant: bool.optional(), variant_from_step: z.number().int().optional(), variant_from_step_id: z.number().int().optional(), thread_reply: bool.optional(),
    branching: branchingInput, ab_test: abTestInput,
  });
  const v11Body = z.object({ title: z.string(), sequence_steps: z.array(v11Step).min(1) });
  const fromV11 = (steps: z.infer<typeof v11Step>[]) => {
    const mains = steps.filter((s) => !s.variant);
    return mains.map((m, i) => ({
      email_subject: m.email_subject, email_body: m.email_body, wait_in_days: m.wait_in_days, thread_reply: !!m.thread_reply, active: true,
      branching: m.branching, ab_test: m.ab_test,
      variants: steps.filter((s) => s.variant && s.variant_from_step === (m.order ?? i + 1)).map((v) => ({ email_subject: v.email_subject, email_body: v.email_body, active: true })),
    }));
  };
  const toV11 = (campaignId: number) => db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY step_order, id', [campaignId]).map((s) => ({
    id: s.id, email_subject: s.email_subject, email_body: s.email_body, order: s.step_order, wait_in_days: s.wait_in_days,
    variant: !!s.variant_of_step_id, variant_from_step_id: s.variant_of_step_id, thread_reply: !!s.thread_reply, active: !!s.active,
    ...(s.variant_of_step_id ? {} : { branching: s.branching ? parseBranching(s.branching) : null, ab_test: s.ab_test ? parseAbConfig(s.ab_test) : null }),
  }));
  sr.get('/api/campaigns/v1.1/:id/sequence-steps', 'View sequence steps (v1.1)', (req) => {
    const c = getCampaign(auth(req).workspaceId, idParam(req));
    return { data: { id: c.id, title: c.sequence_title, sequence_steps: toV11(c.id) } };
  });
  sr.post('/api/campaigns/v1.1/:id/sequence-steps', 'Create sequence steps (v1.1)', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(v11Body, req.body);
    saveSequence(ctx, c.id, fromV11(b.sequence_steps) as any, b.title);
    return { data: { id: c.id, title: b.title, sequence_steps: toV11(c.id) } };
  }, { body: v11Body });

  const activeBody = z.object({ active: bool });
  sr.patch('/api/campaigns/sequence-steps/:id/activate-or-deactivate', 'Activate or deactivate a step variant', (req) => {
    const a = canWrite(req);
    const step = db.get('SELECT s.* FROM sequence_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ? AND c.workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!step) throw notFound('step');
    db.update('sequence_steps', step.id, { active: parse(activeBody, req.body).active ? 1 : 0 });
    return { data: { success: true } };
  }, { body: activeBody });
  sr.delete('/api/campaigns/sequence-steps/:id', 'Delete sequence step', (req) => {
    const a = canWrite(req);
    const step = db.get('SELECT s.* FROM sequence_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ? AND c.workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!step) throw notFound('step');
    const seq = sequenceJson(ctx, step.campaign_id)
      .filter((s) => s.id !== step.id)
      .map((s) => ({ ...s, variants: s.variants.filter((v) => v.id !== step.id) }));
    saveSequence(ctx, step.campaign_id, seq as any);
    return { data: { success: true } };
  });

  const testBody = z.object({ sender_email_id: z.coerce.number().int(), to_email: z.email(), lead_id: z.coerce.number().int().optional() });
  sr.post('/api/campaigns/sequence-steps/:id/test-email', 'Send a test email of a step', async (req) => {
    const a = canWrite(req);
    const step = db.get('SELECT s.* FROM sequence_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE s.id = ? AND c.workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!step) throw notFound('step');
    const b = parse(testBody, req.body);
    const sender = db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [b.sender_email_id, a.workspaceId]);
    if (!sender) throw notFound('email account');
    const campaign = db.get('SELECT * FROM campaigns WHERE id = ?', [step.campaign_id])!;
    const lead = (b.lead_id && db.get('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [b.lead_id, a.workspaceId]))
      || { id: 0, email: b.to_email, first_name: 'Alex', last_name: 'Taylor', company: 'Acme Inc', title: 'Head of Growth', custom_variables: '{}' };
    const { message } = composeCampaignEmail(ctx, { campaign, step, lead, sender, previous: null });
    try {
      await ctx.mail.send(sender, { ...message, to: b.to_email, subject: `[Test] ${message.subject}` });
    } catch (e: any) {
      throw new HttpError(422, { error: 'send_failed', message: e.message });
    }
    return { data: { success: true } };
  }, { body: testBody });

  const previewBody = z.object({ email_subject: z.string(), email_body: z.string(), lead_id: z.coerce.number().int().optional(), sender_email_id: z.coerce.number().int().optional() });
  sr.post('/api/campaigns/:id/preview', 'Render a step for a lead', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(previewBody, req.body);
    const lead = (b.lead_id && db.get('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [b.lead_id, a.workspaceId]))
      || db.get('SELECT l.* FROM leads l JOIN campaign_leads cl ON cl.lead_id = l.id WHERE cl.campaign_id = ? ORDER BY cl.id LIMIT 1', [c.id])
      || { id: 0, email: 'alex@example.com', first_name: 'Alex', last_name: 'Taylor', company: 'Acme Inc', title: 'Head of Growth', custom_variables: '{}' };
    const sender = (b.sender_email_id && db.get('SELECT * FROM sender_emails WHERE id = ? AND workspace_id = ?', [b.sender_email_id, a.workspaceId]))
      || db.get('SELECT s.* FROM sender_emails s JOIN campaign_sender_emails cs ON cs.sender_email_id = s.id WHERE cs.campaign_id = ? LIMIT 1', [c.id])
      || { id: 0, name: 'Your Name', email: 'you@yourdomain.com', email_signature: '' };
    const step = { id: 0, step_order: 1, email_subject: b.email_subject, email_body: b.email_body, thread_reply: 0 };
    const { message } = composeCampaignEmail(ctx, { campaign: { ...c, open_tracking: 0, click_tracking: 0 }, step, lead, sender, previous: null });
    const vars = buildVariables({ lead: { ...lead, email: lead.email, custom_variables: JSON.parse(lead.custom_variables || '{}') }, sender: { name: sender.name, email: sender.email, signature: sender.email_signature }, extra: { UNSUBSCRIBE_LINK: 'x' } });
    return { data: { subject: message.subject, text: message.text, html: message.html ?? null, lead: { id: lead.id, email: lead.email }, missing_variables: [...new Set([...missingVariables(b.email_subject, vars), ...missingVariables(b.email_body, vars)])] } };
  }, { body: previewBody });

  // ---- leads in campaign ----
  const cl = defineRoutes(app, 'Campaign Leads');
  const leadsQ = pageQuery.extend({ status: z.string().optional(), search: z.string().optional() });
  cl.get('/api/campaigns/:id/leads', 'Get all leads for campaign', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const q = parse(leadsQ, req.query);
    const where = ['cl.campaign_id = ?'];
    const params: any[] = [c.id];
    if (q.status) { where.push('cl.status = ?'); params.push(q.status); }
    if (q.search) { where.push(`(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.company LIKE ?)`); params.push(...Array(4).fill(`%${q.search}%`)); }
    return paginate(ctx,
      `SELECT l.id, l.email, l.first_name, l.last_name, l.company, l.title, l.status AS lead_status,
         cl.id AS campaign_lead_id, cl.status, cl.current_step, cl.last_sent_at, cl.next_due_at, cl.sender_email_id,
         se.email AS sender_email,
         (SELECT COUNT(*) FROM sent_emails s WHERE s.campaign_lead_id = cl.id) AS emails_sent,
         (SELECT COALESCE(SUM(opens),0) FROM sent_emails s WHERE s.campaign_lead_id = cl.id) AS opens,
         (SELECT COUNT(*) FROM replies r WHERE r.lead_id = l.id AND r.campaign_id = cl.campaign_id AND r.automated = 0 AND r.folder != 'bounced') AS replies,
         (SELECT MIN(scheduled_at) FROM scheduled_emails x WHERE x.campaign_lead_id = cl.id AND x.status = 'scheduled') AS next_scheduled_at
       FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN sender_emails se ON se.id = cl.sender_email_id
       WHERE ${where.join(' AND ')} ORDER BY cl.id`, params, q,
      (row) => ({ ...row, tags: tagsFor(ctx, 'lead', row.id) }));
  }, { query: leadsQ });

  const attachBody = z.object({ lead_ids: idList, allow_parallel_sending: bool.default(false) });
  cl.post('/api/campaigns/:id/leads/attach-leads', 'Add leads by ID', (req) => {
    const a = canWrite(req);
    const b = parse(attachBody, req.body);
    return { data: { attached: attachLeads(ctx, a.workspaceId, idParam(req), b.lead_ids, b.allow_parallel_sending) } };
  }, { body: attachBody });

  const listBody = z.object({ lead_list_id: z.coerce.number().int(), allow_parallel_sending: bool.default(false) });
  cl.post('/api/campaigns/:id/leads/attach-lead-list', 'Add leads from a list', (req) => {
    const a = canWrite(req);
    const b = parse(listBody, req.body);
    const ids = db.all('SELECT id FROM leads WHERE workspace_id = ? AND lead_list_id = ?', [a.workspaceId, b.lead_list_id]).map((r) => r.id as number);
    return { data: { attached: ids.length ? attachLeads(ctx, a.workspaceId, idParam(req), ids, b.allow_parallel_sending) : 0 } };
  }, { body: listBody });

  const leadIds = z.object({ lead_ids: idList });
  cl.delete('/api/campaigns/:id/leads', 'Remove leads from campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(leadIds, req.body);
    const ph = b.lead_ids.map(() => '?').join(',');
    const n = db.tx(() => {
      db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'removed' WHERE campaign_id = ? AND lead_id IN (${ph}) AND status = 'scheduled'`, [c.id, ...b.lead_ids]);
      return db.run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id IN (${ph})`, [c.id, ...b.lead_ids]).changes;
    });
    return { data: { removed: n } };
  }, { body: leadIds });

  cl.post('/api/campaigns/:id/leads/stop-future-emails', 'Stop future emails for leads', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(leadIds, req.body);
    db.tx(() => {
      for (const id of b.lead_ids) {
        db.run(`UPDATE campaign_leads SET status = 'stopped', next_due_at = NULL WHERE campaign_id = ? AND lead_id = ? AND status IN ('pending','in_sequence')`, [c.id, id]);
        db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'stopped' WHERE campaign_id = ? AND lead_id = ? AND status = 'scheduled'`, [c.id, id]);
      }
    });
    return { data: { success: true } };
  }, { body: leadIds });

  cl.post('/api/campaigns/:id/leads/resume', 'Resume stopped leads', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(leadIds, req.body);
    const ph = b.lead_ids.map(() => '?').join(',');
    const n = db.run(`UPDATE campaign_leads SET status = CASE WHEN current_step = 0 THEN 'pending' ELSE 'in_sequence' END, next_due_at = NULL
      WHERE campaign_id = ? AND lead_id IN (${ph}) AND status IN ('stopped','paused','replied')`, [c.id, ...b.lead_ids]).changes;
    return { data: { resumed: n } };
  }, { body: leadIds });

  const moveBody = z.object({ target_campaign_id: z.coerce.number().int(), lead_ids: idList, include_bounced_and_unsubscribed: bool.default(false), allow_parallel_sending: bool.default(false) });
  cl.post('/api/campaigns/:id/leads/move-to-another-campaign', 'Move leads to another campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(moveBody, req.body);
    getCampaign(a.workspaceId, b.target_campaign_id);
    let ids = b.lead_ids;
    if (!b.include_bounced_and_unsubscribed) {
      ids = db.all(`SELECT id FROM leads WHERE id IN (${ids.map(() => '?').join(',')}) AND status NOT IN ('bounced','unsubscribed')`, ids).map((r) => r.id as number);
    }
    const moved = db.tx(() => {
      const ph = b.lead_ids.map(() => '?').join(',');
      db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'moved' WHERE campaign_id = ? AND lead_id IN (${ph}) AND status = 'scheduled'`, [c.id, ...b.lead_ids]);
      db.run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id IN (${ph})`, [c.id, ...b.lead_ids]);
      return ids.length ? attachLeads(ctx, a.workspaceId, b.target_campaign_id, ids, true) : 0;
    });
    return { data: { moved } };
  }, { body: moveBody });

  // ---- sender emails in campaign ----
  cl.get('/api/campaigns/:id/sender-emails', 'Campaign email accounts', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    return {
      data: db.all(
        `SELECT s.id, s.name, s.email, s.status, s.daily_limit, s.provider, s.warmup_enabled,
           (SELECT COUNT(*) FROM sent_emails x WHERE x.sender_email_id = s.id AND x.campaign_id = ?) AS sent_in_campaign
         FROM sender_emails s JOIN campaign_sender_emails cs ON cs.sender_email_id = s.id WHERE cs.campaign_id = ? ORDER BY s.email`, [c.id, c.id]),
    };
  });
  const senderIds = z.object({ sender_email_ids: idList });
  cl.post('/api/campaigns/:id/attach-sender-emails', 'Add email accounts to campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(senderIds, req.body);
    let n = 0;
    for (const id of b.sender_email_ids) {
      if (!db.get('SELECT 1 FROM sender_emails WHERE id = ? AND workspace_id = ?', [id, a.workspaceId])) continue;
      n += db.run('INSERT OR IGNORE INTO campaign_sender_emails (campaign_id, sender_email_id) VALUES (?, ?)', [c.id, id]).changes;
    }
    return { data: { attached: n } };
  }, { body: senderIds });
  cl.delete('/api/campaigns/:id/remove-sender-emails', 'Remove email accounts from campaign', (req) => {
    const a = canWrite(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(senderIds, req.body);
    const ph = b.sender_email_ids.map(() => '?').join(',');
    db.tx(() => {
      db.run(`DELETE FROM campaign_sender_emails WHERE campaign_id = ? AND sender_email_id IN (${ph})`, [c.id, ...b.sender_email_ids]);
      db.run(`UPDATE scheduled_emails SET status = 'cancelled', error = 'sender removed' WHERE campaign_id = ? AND sender_email_id IN (${ph}) AND status = 'scheduled'`, [c.id, ...b.sender_email_ids]);
      // Leads that were assigned to a removed mailbox get reassigned at their next step.
      db.run(`UPDATE campaign_leads SET sender_email_id = NULL WHERE campaign_id = ? AND sender_email_id IN (${ph})`, [c.id, ...b.sender_email_ids]);
    });
    return { data: { success: true } };
  }, { body: senderIds });

  // ---- stats ----
  const st = defineRoutes(app, 'Campaign Stats');
  const rangeBody = z.object({ start_date: z.string().optional(), end_date: z.string().optional() });
  st.post('/api/campaigns/:id/stats', 'Campaign stats summary', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const b = parse(rangeBody, req.body);
    const range = b.start_date && b.end_date ? { start: new Date(b.start_date).toISOString(), end: new Date(Date.parse(b.end_date) + 86_400_000).toISOString() } : undefined;
    return { data: { ...campaignStats(ctx, c, range), sequence_step_stats: stepStats(ctx, c.id) } };
  }, { body: rangeBody });

  const chartQ = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
  st.get('/api/campaigns/:id/line-area-chart-stats', 'Daily stats for charts', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    return { data: dailySeries(ctx, { campaignId: c.id }, parse(chartQ, req.query).days) };
  }, { query: chartQ });

  st.get('/api/campaigns/:id/scheduled-emails', 'Scheduled emails for campaign', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const q = parse(pageQuery.extend({ status: z.string().optional() }), req.query);
    const where = ['se.campaign_id = ?'];
    const params: any[] = [c.id];
    if (q.status) { where.push('se.status = ?'); params.push(q.status); }
    return paginate(ctx,
      `SELECT se.*, l.email AS lead_email, s.email AS sender_email FROM scheduled_emails se
       JOIN leads l ON l.id = se.lead_id JOIN sender_emails s ON s.id = se.sender_email_id
       WHERE ${where.join(' AND ')} ORDER BY se.scheduled_at DESC`, params, q);
  });

  st.get('/api/campaigns/:id/replies', 'Replies for campaign', (req) => {
    const a = auth(req);
    const c = getCampaign(a.workspaceId, idParam(req));
    const q = parse(pageQuery, req.query);
    return paginate(ctx, `SELECT * FROM replies WHERE campaign_id = ? AND folder != 'bounced' ORDER BY received_at DESC`, [c.id], q);
  });
}

/** Problems that block a launch, in the order a user should fix them. */
export function launchProblems(ctx: Ctx, c: Row): string[] {
  const { db } = ctx;
  const problems: string[] = [];
  const steps = db.all('SELECT * FROM sequence_steps WHERE campaign_id = ? AND active = 1', [c.id]);
  if (!steps.length) problems.push('Add at least one sequence step.');
  for (const s of steps) {
    if (!s.email_body.trim()) { problems.push(`Step ${s.step_order} has an empty body.`); break; }
    if (!s.email_subject.trim() && !(s.thread_reply && s.step_order > 1)) { problems.push(`Step ${s.step_order} needs a subject (or turn on "reply in thread").`); break; }
  }
  const senders = db.get<{ n: number }>(`SELECT COUNT(*) n FROM campaign_sender_emails cs JOIN sender_emails s ON s.id = cs.sender_email_id WHERE cs.campaign_id = ? AND s.status = 'Connected'`, [c.id])!.n;
  if (!senders) problems.push('Add at least one connected sender email.');
  const leads = db.get<{ n: number }>(`SELECT COUNT(*) n FROM campaign_leads WHERE campaign_id = ? AND status IN ('pending','in_sequence')`, [c.id])!.n;
  if (!leads) problems.push('Add leads to the campaign.');
  // Branch targets must exist; A/B metrics need their tracking switched on.
  problems.push(...validateBranching(ctx, c, loadSteps(ctx, c.id)).problems);
  for (const s of db.all('SELECT step_order, ab_test FROM sequence_steps WHERE campaign_id = ? AND variant_of_step_id IS NULL AND ab_test IS NOT NULL', [c.id])) {
    const cfg = parseAbConfig(s.ab_test);
    if (cfg.enabled && cfg.metric === 'open_rate' && !c.open_tracking) problems.push(`Step ${s.step_order}'s A/B test picks by open rate, but open tracking is off.`);
    if (cfg.enabled && cfg.metric === 'click_rate' && !c.click_tracking) problems.push(`Step ${s.step_order}'s A/B test picks by click rate, but click tracking is off.`);
  }
  return problems;
}

/** Day-by-day counts for charts (UTC days). */
export function dailySeries(ctx: Ctx, scope: { campaignId?: number; workspaceId?: number }, days: number) {
  const { db } = ctx;
  const end = DateTime.fromJSDate(ctx.now()).toUTC().startOf('day').plus({ days: 1 });
  const start = end.minus({ days });
  const where = scope.campaignId ? 'campaign_id = ?' : 'workspace_id = ?';
  const id = scope.campaignId ?? scope.workspaceId!;
  const bucket = (sql: string) => new Map(db.all(sql, [id, start.toISO()!]).map((r) => [r.day as string, r.n as number]));
  const sent = bucket(`SELECT substr(sent_at,1,10) day, COUNT(*) n FROM sent_emails WHERE ${where} AND kind = 'campaign' AND sent_at >= ? GROUP BY day`);
  const opens = bucket(`SELECT substr(first_opened_at,1,10) day, COUNT(*) n FROM sent_emails WHERE ${where} AND first_opened_at >= ? GROUP BY day`);
  const replies = bucket(`SELECT substr(received_at,1,10) day, COUNT(*) n FROM replies WHERE ${where} AND automated = 0 AND folder != 'bounced' AND received_at >= ? GROUP BY day`);
  const interested = bucket(`SELECT substr(received_at,1,10) day, COUNT(*) n FROM replies WHERE ${where} AND interested = 1 AND received_at >= ? GROUP BY day`);
  const bounced = bucket(`SELECT substr(created_at,1,10) day, COUNT(*) n FROM events WHERE ${where} AND type = 'EMAIL_BOUNCED' AND created_at >= ? GROUP BY day`);
  const unsub = bucket(`SELECT substr(created_at,1,10) day, COUNT(*) n FROM events WHERE ${scope.campaignId ? 'lead_id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)' : 'workspace_id = ?'} AND type = 'LEAD_UNSUBSCRIBED' AND created_at >= ? GROUP BY day`);
  const out = [];
  for (let d = start; d < end; d = d.plus({ days: 1 })) {
    const key = d.toISODate()!;
    out.push({ date: key, sent: sent.get(key) ?? 0, opened: opens.get(key) ?? 0, replied: replies.get(key) ?? 0, interested: interested.get(key) ?? 0, bounced: bounced.get(key) ?? 0, unsubscribed: unsub.get(key) ?? 0 });
  }
  return out;
}

