/**
 * LinkedIn outreach campaigns (PhantomBuster's "LinkedIn Outreach" workflow), separate from the
 * email sequencer: visit → connect with note → wait for acceptance → message 1 → up to 3
 * follow-ups, stopping on reply. Acceptances and replies are detected from periodic
 * connection-list and inbox checks the extension runs.
 */
import type { Ctx } from '../context.ts';
import { HttpError } from '../http.ts';
import { emit } from '../events.ts';
import { unwrap } from '../gtm/lib/template.ts';
import { loadSettings, dayStart } from './settings.ts';
import { renderMessage, AI_TOKEN } from './render.ts';
import { normalizeUrl } from './parsers/index.ts';
import type { Rec } from './protocol.ts';

export interface CampaignSettings {
  visit_first: boolean;
  connect_note: string;
  ai_instructions: string;
  messages: { template: string; delay_days: number }[];
  withdraw_after_days: number | null;
  daily_invites: number;
  daily_messages: number;
  stop_on_reply: boolean;
  filters: { titles: string[]; exclude_titles: string[]; locations: string[]; companies: string[] };
}

export const DEFAULT_CAMPAIGN_SETTINGS: CampaignSettings = {
  visit_first: true,
  connect_note: '',
  ai_instructions: '',
  messages: [{ template: 'Thanks for connecting, {first_name}!', delay_days: 1 }],
  withdraw_after_days: 21,
  daily_invites: 15,
  daily_messages: 30,
  stop_on_reply: true,
  filters: { titles: [], exclude_titles: [], locations: [], companies: [] },
};

export type LeadState = 'pending' | 'visited' | 'invited' | 'accepted' | 'messaged' | 'replied' | 'done' | 'not_accepted' | 'failed';
export interface Lead {
  id: number; campaign_id: number; profile_url: string; public_id: string | null; member_urn: string | null;
  full_name: string | null; first_name: string | null; last_name: string | null; title: string | null; company: string | null;
  location: string | null; headline: string | null; data: Rec; excluded: boolean; state: LeadState; messages_sent: number;
  next_action_at: string | null; visited_at: string | null; invited_at: string | null; accepted_at: string | null;
  last_message_at: string | null; replied_at: string | null; error: string | null;
}

const DAY = 86_400_000;
const TERMINAL: LeadState[] = ['replied', 'done', 'not_accepted', 'failed'];

// ---- pure state machine -------------------------------------------------------------

export type StepKind = 'visit' | 'connect' | 'message';
export interface NextStep { kind: StepKind | null; at: Date | null; messageIndex?: number; expire?: boolean }

/**
 * What a lead should do next, and when. `expire` means the invite has waited longer than
 * withdraw_after_days and the lead should become not_accepted.
 */
export function nextStep(lead: Pick<Lead, 'state' | 'excluded' | 'messages_sent' | 'invited_at' | 'accepted_at' | 'last_message_at'>, s: CampaignSettings, now: Date): NextStep {
  if (lead.excluded || TERMINAL.includes(lead.state)) return { kind: null, at: null };
  switch (lead.state) {
    case 'pending': return s.visit_first ? { kind: 'visit', at: now } : { kind: 'connect', at: now };
    case 'visited': return { kind: 'connect', at: now };
    case 'invited': {
      if (s.withdraw_after_days && lead.invited_at && now.getTime() - Date.parse(lead.invited_at) > s.withdraw_after_days * DAY) return { kind: null, at: null, expire: true };
      return { kind: null, at: null }; // waiting for acceptance
    }
    case 'accepted':
    case 'messaged': {
      const i = lead.messages_sent;
      if (i >= s.messages.length) return { kind: null, at: null };
      const from = i === 0 ? lead.accepted_at : lead.last_message_at;
      const delay = Math.min(15, Math.max(0, s.messages[i]!.delay_days)) * DAY;
      return { kind: 'message', at: new Date(Date.parse(from ?? now.toISOString()) + delay), messageIndex: i };
    }
  }
  return { kind: null, at: null };
}

export type LeadPatch = Partial<Omit<Lead, 'id' | 'campaign_id' | 'excluded' | 'data'>> & { data?: Rec };

/** Outcome of a finished task → lead changes. */
export function applyTaskResult(lead: Lead, kind: StepKind, status: 'done' | 'failed' | 'skipped', result: Rec | null, error: string | null, s: CampaignSettings, now: Date): LeadPatch {
  const iso = now.toISOString();
  const r = result ?? {};
  if (status === 'failed') return { state: 'failed', error: error ?? 'failed' };
  if (kind === 'visit') {
    const p = (r.profile ?? {}) as Rec;
    const patch: LeadPatch = { visited_at: iso, ...profilePatch(p) };
    const degree = String(r.connectionDegree ?? p.connectionDegree ?? '');
    if (degree.startsWith('1')) return { ...patch, state: 'accepted', accepted_at: iso };
    if (r.pendingInvite) return { ...patch, state: 'invited', invited_at: lead.invited_at ?? iso };
    return { ...patch, state: 'visited' };
  }
  if (kind === 'connect') {
    if (r.alreadyConnected) return { state: 'accepted', accepted_at: iso };
    if (status === 'skipped' && !r.pendingInvite) return { state: 'failed', error: String(r.reason ?? error ?? 'could not invite') };
    return { state: 'invited', invited_at: iso };
  }
  // message
  if (status === 'skipped') return r.notConnected ? { state: 'invited', error: 'Not connected yet' } : { state: 'failed', error: String(r.reason ?? error ?? 'message skipped') };
  const sent = lead.messages_sent + 1;
  return { messages_sent: sent, last_message_at: iso, state: sent >= s.messages.length ? 'done' : 'messaged', error: null };
}

function profilePatch(p: Rec): LeadPatch {
  const s = (v: unknown) => (v == null || v === '' ? undefined : String(v));
  const out: LeadPatch = {};
  const set = <K extends keyof LeadPatch>(k: K, v: LeadPatch[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set('full_name', s(p.fullName));
  set('first_name', s(p.firstName));
  set('last_name', s(p.lastName));
  set('title', s(p.title));
  set('company', s(p.company));
  set('location', s(p.location));
  set('headline', s(p.headline));
  set('member_urn', s(p.memberUrn));
  set('public_id', s(p.publicId));
  return out;
}

/** Review gate: does a lead pass the campaign's title/location/company filters? */
export function passesFilters(lead: Pick<Lead, 'title' | 'headline' | 'location' | 'company'>, f: CampaignSettings['filters']): boolean {
  const has = (hay: string, needles: string[]) => needles.some((n) => n.trim() && hay.toLowerCase().includes(n.trim().toLowerCase()));
  const title = `${lead.title ?? ''} ${lead.headline ?? ''}`;
  if (f.titles.filter((x) => x.trim()).length && !has(title, f.titles)) return false;
  if (f.exclude_titles.length && has(title, f.exclude_titles)) return false;
  if (f.locations.filter((x) => x.trim()).length && !has(lead.location ?? '', f.locations)) return false;
  if (f.companies.filter((x) => x.trim()).length && !has(`${lead.company ?? ''} ${lead.headline ?? ''}`, f.companies)) return false;
  return true;
}

// ---- persistence -----------------------------------------------------------------------

const J = (s: string | null, d: any) => (s ? JSON.parse(s) : d);

export function settingsOf(raw: string | Rec | null): CampaignSettings {
  const v = typeof raw === 'string' ? J(raw, {}) : raw ?? {};
  return { ...DEFAULT_CAMPAIGN_SETTINGS, ...v, filters: { ...DEFAULT_CAMPAIGN_SETTINGS.filters, ...(v.filters ?? {}) }, messages: (v.messages ?? DEFAULT_CAMPAIGN_SETTINGS.messages).slice(0, 4) };
}

export function loadCampaign(ctx: Ctx, id: number, workspaceId?: number) {
  const c = ctx.db.get('SELECT * FROM li_campaigns WHERE id = ?', [id]);
  if (!c || (workspaceId != null && c.workspace_id !== workspaceId)) throw new HttpError(404, { error: 'not_found', message: 'LinkedIn campaign not found' });
  return { ...c, settings: settingsOf(c.settings) } as { id: number; workspace_id: number; name: string; status: string; settings: CampaignSettings; table_id: number | null; approved_at: string | null; last_check_at: string | null; created_at: string; updated_at: string };
}

export function loadLead(ctx: Ctx, id: number): Lead | undefined {
  const l = ctx.db.get('SELECT * FROM li_campaign_leads WHERE id = ?', [id]);
  return l ? { ...l, data: J(l.data, {}), excluded: !!l.excluded } : undefined;
}

function saveLead(ctx: Ctx, id: number, patch: LeadPatch) {
  const data: Record<string, unknown> = { ...patch };
  if (patch.data) data.data = JSON.stringify(patch.data);
  ctx.db.update('li_campaign_leads', id, data);
}

export interface LeadInput { profile_url: string; full_name?: string; first_name?: string; last_name?: string; title?: string; company?: string; location?: string; headline?: string; data?: Rec }

export function canonicalProfile(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const withProto = /^https?:\/\//i.test(u) ? u : /linkedin\.com\//i.test(u) ? `https://${u}` : `https://www.linkedin.com/in/${u.replace(/^\/+|\/+$/g, '')}/`;
  if (!/linkedin\.com\/(in|sales\/lead|sales\/people)\//i.test(withProto)) return null;
  try { return normalizeUrl('linkedin', withProto); } catch { return withProto; }
}

export function addLeads(ctx: Ctx, campaignId: number, leads: LeadInput[], now: Date): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  const iso = now.toISOString();
  ctx.db.tx(() => {
    for (const l of leads) {
      const url = canonicalProfile(l.profile_url ?? '');
      if (!url) { skipped++; continue; }
      const parts = (l.full_name ?? '').trim().split(/\s+/).filter(Boolean);
      const r = ctx.db.run(`INSERT OR IGNORE INTO li_campaign_leads (campaign_id, profile_url, full_name, first_name, last_name, title, company, location, headline, data, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, [
        campaignId, url, l.full_name ?? null, l.first_name ?? parts[0] ?? null, l.last_name ?? (parts.length > 1 ? parts[parts.length - 1]! : null),
        l.title ?? null, l.company ?? null, l.location ?? null, l.headline ?? null, JSON.stringify(l.data ?? {}), iso,
      ]);
      if (r.changes) added++; else skipped++;
    }
  });
  return { added, skipped };
}

/** Reads leads from a GTM table: one per row with a LinkedIn URL in the mapped column. */
export function leadsFromTable(ctx: Ctx, workspaceId: number, tableId: number, columns: Record<string, string | undefined>): LeadInput[] {
  const { store } = ctx.gtm!;
  store.tableIn(tableId, workspaceId);
  const cols = store.columns(tableId);
  if (!columns.profile_url || !cols.some((c) => c.name === columns.profile_url)) throw new HttpError(422, { error: 'validation_error', message: `Pick the column that holds LinkedIn URLs (columns.profile_url)` });
  return store.rowIds(tableId).map((rowId) => {
    const raw = store.rowValues(rowId, cols);
    const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, unwrap(v)]));
    const get = (k: string) => { const c = columns[k]; const v = c ? row[c] : undefined; return v == null || v === '' ? undefined : String(v); };
    return { profile_url: get('profile_url') ?? '', full_name: get('full_name'), first_name: get('first_name'), last_name: get('last_name'), title: get('title'), company: get('company'), location: get('location'), headline: get('headline'), data: row };
  });
}

export function applyReview(ctx: Ctx, campaignId: number, filters: CampaignSettings['filters']): { included: number; excluded: number } {
  let included = 0;
  let excluded = 0;
  ctx.db.tx(() => {
    for (const l of ctx.db.all(`SELECT id, title, headline, location, company FROM li_campaign_leads WHERE campaign_id = ? AND state = 'pending'`, [campaignId])) {
      const ok = passesFilters(l, filters);
      ctx.db.run('UPDATE li_campaign_leads SET excluded = ? WHERE id = ?', [ok ? 0 : 1, l.id]);
      if (ok) included++; else excluded++;
    }
  });
  return { included, excluded };
}

export function campaignStats(ctx: Ctx, campaignId: number) {
  const s = ctx.db.get(`SELECT COUNT(*) total,
      SUM(excluded) excluded,
      SUM(CASE WHEN excluded = 0 AND state = 'pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN visited_at IS NOT NULL THEN 1 ELSE 0 END) visited,
      SUM(CASE WHEN invited_at IS NOT NULL THEN 1 ELSE 0 END) invited,
      SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) accepted,
      SUM(CASE WHEN accepted_at IS NOT NULL AND invited_at IS NOT NULL THEN 1 ELSE 0 END) accepted_invites,
      SUM(CASE WHEN messages_sent > 0 THEN 1 ELSE 0 END) messaged,
      SUM(CASE WHEN messages_sent > 1 THEN messages_sent - 1 ELSE 0 END) followups,
      SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) replied,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN state = 'not_accepted' THEN 1 ELSE 0 END) not_accepted,
      SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) done
    FROM li_campaign_leads WHERE campaign_id = ?`, [campaignId]) as Record<string, number | null>;
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    total: n('total'), excluded: n('excluded'), pending: n('pending'), visited: n('visited'), invited: n('invited'), accepted: n('accepted'),
    messaged: n('messaged'), followups: n('followups'), replied: n('replied'), failed: n('failed'), not_accepted: n('not_accepted'), done: n('done'),
    acceptance_rate: n('invited') ? Math.round((n('accepted_invites') / n('invited')) * 1000) / 1000 : 0,
    reply_rate: n('accepted') ? Math.round((n('replied') / n('accepted')) * 1000) / 1000 : 0,
  };
}

export function campaignJson(ctx: Ctx, c: ReturnType<typeof loadCampaign>) {
  return { ...c, stats: campaignStats(ctx, c.id) };
}

export function leadJson(l: Lead) {
  return {
    id: l.id, profile_url: l.profile_url, full_name: l.full_name, title: l.title, company: l.company, location: l.location, headline: l.headline,
    excluded: l.excluded, state: l.state, messages_sent: l.messages_sent, next_action_at: l.next_action_at, invited_at: l.invited_at,
    accepted_at: l.accepted_at, last_message_at: l.last_message_at, replied_at: l.replied_at, error: l.error,
  };
}

// ---- engine --------------------------------------------------------------------------------

const KIND: Record<StepKind, { kind: string; action: string }> = {
  visit: { kind: 'linkedin.visit', action: 'linkedin.visit' },
  connect: { kind: 'linkedin.connect', action: 'linkedin.connect' },
  message: { kind: 'linkedin.message', action: 'linkedin.message' },
};
const CHECK_EVERY_MS = 3 * 3_600_000;

function leadVars(l: Lead): Rec {
  return { fullName: l.full_name, firstName: l.first_name, lastName: l.last_name, title: l.title, company: l.company, location: l.location, headline: l.headline, profileUrl: l.profile_url };
}

/**
 * One pass over active campaigns: queue due steps (within the campaign's daily caps), expire
 * stale invites, schedule acceptance/reply checks and complete finished campaigns.
 */
export async function campaignTick(ctx: Ctx, now: Date): Promise<void> {
  const iso = now.toISOString();
  for (const c0 of ctx.db.all<{ id: number }>(`SELECT id FROM li_campaigns WHERE status = 'active'`)) {
    const c = loadCampaign(ctx, c0.id);
    const ws = loadSettings(ctx.db, c.workspace_id);
    const today = dayStart(ws, now).toISOString();
    const usedToday = (kind: string) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND kind = ?
      AND (status IN ('pending', 'leased') OR (status = 'done' AND updated_at >= ?))`, [c.id, kind, today])!.n;
    let invitesLeft = c.settings.daily_invites - usedToday('linkedin.connect');
    let messagesLeft = c.settings.daily_messages - usedToday('linkedin.message');

    const leads = ctx.db.all(`SELECT l.* FROM li_campaign_leads l WHERE l.campaign_id = ? AND l.excluded = 0 AND l.state NOT IN ('replied', 'done', 'not_accepted', 'failed')
      AND NOT EXISTS (SELECT 1 FROM companion_tasks t WHERE t.campaign_lead_id = l.id AND t.status IN ('pending', 'leased')) ORDER BY l.id`, [c.id])
      .map((l) => ({ ...l, data: J(l.data, {}), excluded: !!l.excluded }) as Lead);

    for (const lead of leads) {
      const step = nextStep(lead, c.settings, now);
      if (step.expire) { saveLead(ctx, lead.id, { state: 'not_accepted', next_action_at: null }); continue; }
      if (!step.kind || !step.at) { if (lead.next_action_at) saveLead(ctx, lead.id, { next_action_at: null }); continue; }
      if (step.at > now) { if (lead.next_action_at !== step.at.toISOString()) saveLead(ctx, lead.id, { next_action_at: step.at.toISOString() }); continue; }
      if (step.kind === 'connect' && invitesLeft <= 0) continue;
      if (step.kind === 'message' && messagesLeft <= 0) continue;
      const params: Rec = {};
      const template = step.kind === 'connect' ? c.settings.connect_note : step.kind === 'message' ? c.settings.messages[step.messageIndex!]!.template : '';
      if (template) {
        // Plain templates are rendered now; {ai_message} is rendered at send time from the live profile (POST /render).
        if (AI_TOKEN.test(template)) Object.assign(params, { template, ai_instructions: c.settings.ai_instructions });
        else params.text = (await renderMessage({ template, profile: leadVars(lead), row: lead.data, settings: ctx.gtm!.settings, maxLength: step.kind === 'connect' ? 300 : 8000 })).text;
      } else if (step.kind === 'connect') params.text = '';
      if (step.kind === 'message') params.message_index = step.messageIndex;
      ctx.db.insert('companion_tasks', {
        workspace_id: c.workspace_id, campaign_id: c.id, campaign_lead_id: lead.id, kind: KIND[step.kind].kind, site: 'linkedin', runner: 'extension',
        action: KIND[step.kind].action, target: JSON.stringify({ profileUrl: lead.profile_url, memberUrn: lead.member_urn, fullName: lead.full_name }),
        params: JSON.stringify(params), status: 'pending', priority: step.kind === 'message' ? 2 : step.kind === 'connect' ? 1 : 0, created_at: iso, updated_at: iso,
      });
      saveLead(ctx, lead.id, { next_action_at: iso });
      if (step.kind === 'connect') invitesLeft--;
      if (step.kind === 'message') messagesLeft--;
    }

    // Acceptance / reply detection.
    const waiting = ctx.db.get(`SELECT SUM(CASE WHEN state = 'invited' THEN 1 ELSE 0 END) invited,
      SUM(CASE WHEN state IN ('invited', 'accepted', 'messaged') OR (state = 'done' AND last_message_at > ?) THEN 1 ELSE 0 END) open
      FROM li_campaign_leads WHERE campaign_id = ? AND excluded = 0`, [new Date(now.getTime() - 30 * DAY).toISOString(), c.id]) as { invited: number | null; open: number | null };
    const due = !c.last_check_at || now.getTime() - Date.parse(c.last_check_at) >= CHECK_EVERY_MS;
    const checkPending = ctx.db.get(`SELECT 1 FROM companion_tasks WHERE campaign_id = ? AND kind LIKE 'linkedin.check_%' AND status IN ('pending', 'leased')`, [c.id]);
    if (due && !checkPending && (waiting.open ?? 0) > 0) {
      const add = (kind: string, limit: number) => ctx.db.insert('companion_tasks', {
        workspace_id: c.workspace_id, campaign_id: c.id, kind, site: 'linkedin', runner: 'extension', action: null,
        target: '{}', params: JSON.stringify({ limit }), status: 'pending', priority: 3, created_at: iso, updated_at: iso,
      });
      if ((waiting.invited ?? 0) > 0) add('linkedin.check_connections', 80);
      add('linkedin.check_inbox', 40);
      ctx.db.update('li_campaigns', c.id, { last_check_at: iso });
    }

    const open = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM li_campaign_leads WHERE campaign_id = ? AND excluded = 0 AND state NOT IN ('replied', 'done', 'not_accepted', 'failed')`, [c.id])!.n;
    const pendingTasks = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM companion_tasks WHERE campaign_id = ? AND status IN ('pending', 'leased')`, [c.id])!.n;
    // Finished leads stay watched for replies for a while; the campaign closes once nothing is open.
    if (!open && !pendingTasks && !(waiting.open ?? 0)) ctx.db.update('li_campaigns', c.id, { status: 'completed', updated_at: iso });
  }
}

/** A campaign step finished in the extension. */
export function onCampaignTaskComplete(ctx: Ctx, task: { campaign_lead_id: number | null; campaign_id: number | null; kind: string }, status: 'done' | 'failed' | 'skipped', result: Rec | null, error: string | null, now: Date) {
  if (!task.campaign_lead_id || !task.campaign_id) return;
  const lead = loadLead(ctx, task.campaign_lead_id);
  if (!lead) return;
  const c = loadCampaign(ctx, task.campaign_id);
  const kind = (Object.keys(KIND) as StepKind[]).find((k) => KIND[k].kind === task.kind);
  if (!kind) return;
  const patch = applyTaskResult(lead, kind, status, result, error, c.settings, now);
  saveLead(ctx, lead.id, { ...patch, next_action_at: null });
  if (patch.state === 'accepted' && lead.state !== 'accepted') emitAccepted(ctx, c, { ...lead, ...patch } as Lead);
}

function emitAccepted(ctx: Ctx, c: { id: number; workspace_id: number; name: string }, lead: Lead) {
  emit(ctx, c.workspace_id, 'LINKEDIN_CONNECTION_ACCEPTED', { linkedin_campaign: { id: c.id, name: c.name }, lead: leadJson(lead) });
}

const sameProfile = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return false;
  const k = (u: string) => (canonicalProfile(u) ?? u).toLowerCase().replace(/\/+$/, '');
  return k(a) === k(b);
};

/** Connections list from the extension → invited leads that now appear there are accepted. */
export function onConnections(ctx: Ctx, campaignId: number, records: Rec[], now: Date): number {
  const c = loadCampaign(ctx, campaignId);
  let n = 0;
  const invited = ctx.db.all(`SELECT * FROM li_campaign_leads WHERE campaign_id = ? AND state IN ('invited', 'visited', 'pending', 'not_accepted')`, [campaignId])
    .map((l) => ({ ...l, data: J(l.data, {}), excluded: !!l.excluded }) as Lead);
  for (const lead of invited) {
    const hit = records.find((r) => sameProfile(String(r.profileUrl ?? ''), lead.profile_url) || (lead.member_urn && r.memberUrn === lead.member_urn));
    if (!hit) continue;
    // Only invites we sent count; someone already connected before the campaign is picked up at visit time.
    if (lead.state !== 'invited' && lead.state !== 'not_accepted') continue;
    const at = typeof hit.connectedAt === 'string' && !Number.isNaN(Date.parse(hit.connectedAt)) ? new Date(hit.connectedAt) : now;
    const patch: LeadPatch = { state: 'accepted', accepted_at: (at > now ? now : at).toISOString(), error: null };
    saveLead(ctx, lead.id, patch);
    emitAccepted(ctx, c, { ...lead, ...patch } as Lead);
    n++;
  }
  return n;
}

/** Inbox snapshot from the extension → a message from the lead after our first touch is a reply. */
export function onInbox(ctx: Ctx, campaignId: number, records: Rec[], now: Date): number {
  const c = loadCampaign(ctx, campaignId);
  let n = 0;
  const open = ctx.db.all(`SELECT * FROM li_campaign_leads WHERE campaign_id = ? AND state IN ('invited', 'accepted', 'messaged', 'done')`, [campaignId])
    .map((l) => ({ ...l, data: J(l.data, {}), excluded: !!l.excluded }) as Lead);
  for (const lead of open) {
    const conv = records.find((r) => sameProfile(String(r.participantUrl ?? ''), lead.profile_url));
    if (!conv || conv.lastSender !== 'them') continue;
    const at = typeof conv.lastMessageAt === 'string' && !Number.isNaN(Date.parse(conv.lastMessageAt)) ? new Date(conv.lastMessageAt) : now;
    const since = lead.last_message_at ?? lead.invited_at ?? lead.accepted_at;
    if (since && at.getTime() <= Date.parse(since)) continue;
    const patch: LeadPatch = { replied_at: (at > now ? now : at).toISOString(), error: null };
    if (c.settings.stop_on_reply) {
      patch.state = 'replied';
      patch.next_action_at = null;
      ctx.db.run(`UPDATE companion_tasks SET status = 'cancelled', updated_at = ? WHERE campaign_lead_id = ? AND status = 'pending'`, [now.toISOString(), lead.id]);
    }
    if (lead.state === 'invited') { patch.accepted_at = lead.accepted_at ?? patch.replied_at; if (!c.settings.stop_on_reply) patch.state = 'accepted'; }
    saveLead(ctx, lead.id, patch);
    emit(ctx, c.workspace_id, 'LINKEDIN_REPLY_RECEIVED', { linkedin_campaign: { id: c.id, name: c.name }, lead: leadJson({ ...lead, ...patch } as Lead), message: conv.lastMessage ?? null, conversation_url: conv.conversationUrl ?? null });
    n++;
  }
  return n;
}
