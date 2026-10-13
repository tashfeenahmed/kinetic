/**
 * Bridge between GTM tables and Outreach (leads, campaigns, inbox).
 * Table rows become leads (with enrichment/AI output as custom variables) and are
 * attached to campaigns; campaign activity flows back as a per-row status.
 */
import type { Ctx } from '../context.ts';
import { attachLeads, upsertLeads, type ExistingBehavior, type LeadSource } from '../routes/leads.ts';
import { domainOf } from '../lib/dns.ts';
import { DEAL_STATUS, type DealStage } from '../engine/deals.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LeadFields {
  email: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company?: string;
  notes?: string;
  variables?: Record<string, string>;
}

export interface PushResult {
  leadId: number;
  created: boolean;
  campaign?: { id: number; name: string; attached: boolean; reason?: string };
}

export interface LeadStatus {
  status: string;
  lead: { id: number; email: string; status: string };
  campaigns: { id: number; name: string; campaign_status: string; status: string; step: number; last_sent_at: string | null }[];
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  lastReply: { category: string; subject: string; snippet: string; at: string } | null;
  deal: { id: number; stage: string; value: number | null; currency: string | null } | null;
}

export class OutreachBridge {
  private ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Create or update the lead, then optionally attach it to a campaign and/or list. */
  pushLead(workspaceId: number, f: LeadFields, opts: { campaignId?: number | null; listId?: number | null; behavior?: ExistingBehavior; allowParallel?: boolean; source?: LeadSource } = {}): PushResult {
    const { db } = this.ctx;
    const email = f.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error(`Not a valid email: "${f.email}"`);
    if (opts.listId && !db.get('SELECT 1 FROM lead_lists WHERE id = ? AND workspace_id = ?', [opts.listId, workspaceId])) throw new Error('Lead list not found in this workspace');
    const existed = !!db.get('SELECT 1 FROM leads WHERE workspace_id = ? AND email = ?', [workspaceId, email]);
    const r = upsertLeads(this.ctx, workspaceId, [{
      email, first_name: clip(f.first_name, 200), last_name: clip(f.last_name, 200), title: clip(f.title, 300), company: clip(f.company, 300),
      notes: f.notes ? clip(f.notes, 5000) : undefined,
      custom_variables: f.variables ? Object.fromEntries(Object.entries(f.variables).map(([k, v]) => [k, clip(v, 5000) ?? ''])) : undefined,
    }], opts.behavior ?? 'patch', opts.listId ?? null, opts.source);
    const leadId = r.lead_ids[0];
    const out: PushResult = { leadId, created: !existed };
    if (opts.campaignId) {
      const c = db.get('SELECT id, name FROM campaigns WHERE id = ? AND workspace_id = ?', [opts.campaignId, workspaceId]);
      if (!c) throw new Error('Campaign not found in this workspace');
      const already = !!db.get('SELECT 1 FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [c.id, leadId]);
      const attached = attachLeads(this.ctx, workspaceId, c.id, [leadId], !!opts.allowParallel) > 0;
      let reason: string | undefined;
      if (!attached) reason = already ? 'already in campaign' : this.blockReason(workspaceId, leadId) ?? 'in another active campaign';
      else if (db.get(`SELECT 1 FROM campaign_leads WHERE campaign_id = ? AND lead_id = ? AND status = 'stopped'`, [c.id, leadId])) reason = this.blockReason(workspaceId, leadId) ?? 'stopped';
      out.campaign = { id: c.id, name: c.name, attached: attached && !reason, reason };
    }
    return out;
  }

  /** Lead state across all campaigns, newest activity first. */
  leadStatus(workspaceId: number, email: string): LeadStatus | null {
    const { db } = this.ctx;
    const lead = db.get('SELECT id, email, status FROM leads WHERE workspace_id = ? AND email = ?', [workspaceId, email.trim().toLowerCase()]);
    if (!lead) return null;
    const campaigns = db.all(`SELECT c.id, c.name, c.status AS campaign_status, cl.status, cl.current_step AS step, cl.last_sent_at
      FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? ORDER BY COALESCE(cl.last_sent_at, cl.created_at) DESC`, [lead.id]);
    const s = db.get('SELECT COUNT(*) AS sent, COALESCE(SUM(opens),0) AS opens, COALESCE(SUM(clicks),0) AS clicks FROM sent_emails WHERE lead_id = ? AND kind = \'campaign\'', [lead.id])!;
    const replies = db.get(`SELECT COUNT(*) AS n FROM replies WHERE lead_id = ? AND automated = 0 AND folder != 'bounced'`, [lead.id])!.n;
    const r = db.get(`SELECT category, subject, body_text, received_at FROM replies WHERE lead_id = ? AND folder != 'bounced' ORDER BY received_at DESC LIMIT 1`, [lead.id]);
    const deal = db.get('SELECT id, stage, value, currency FROM deals WHERE workspace_id = ? AND lead_id = ?', [workspaceId, lead.id]) ?? null;
    return {
      // A deal is further along than any campaign state ("meeting booked", "won", "lost").
      status: deal ? DEAL_STATUS[deal.stage as DealStage] : overall(lead.status, campaigns.map((c) => c.status), s.sent, replies),
      deal,
      lead,
      campaigns: campaigns as LeadStatus['campaigns'],
      sent: s.sent, opens: s.opens, clicks: s.clicks, replies,
      lastReply: r ? { category: r.category, subject: r.subject, snippet: String(r.body_text).replace(/\s+/g, ' ').slice(0, 280), at: r.received_at } : null,
    };
  }

  private blockReason(workspaceId: number, leadId: number): string | undefined {
    const { db } = this.ctx;
    const lead = db.get('SELECT email, status FROM leads WHERE id = ?', [leadId]);
    if (!lead) return 'lead missing';
    if (lead.status === 'unsubscribed') return 'unsubscribed';
    if (lead.status === 'bounced') return 'bounced';
    if (db.get('SELECT 1 FROM blacklisted_emails WHERE workspace_id = ? AND email = ?', [workspaceId, lead.email])) return 'email blacklisted';
    if (db.get('SELECT 1 FROM blacklisted_domains WHERE workspace_id = ? AND domain = ?', [workspaceId, domainOf(lead.email)])) return 'domain blacklisted';
    return undefined;
  }

  campaigns(workspaceId: number) {
    return this.ctx.db.all(`SELECT id, name, status FROM campaigns WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC`, [workspaceId]);
  }

  /** Lead rows for "Open in a table": standard fields plus every custom variable. */
  leadsForTable(workspaceId: number, sel: { leadIds?: number[]; listId?: number; campaignId?: number; all?: boolean }) {
    const { db } = this.ctx;
    let rows: any[];
    if (sel.leadIds?.length) rows = db.all(`SELECT * FROM leads WHERE workspace_id = ? AND id IN (${sel.leadIds.map(() => '?').join(',')}) ORDER BY id`, [workspaceId, ...sel.leadIds]);
    else if (sel.listId) rows = db.all('SELECT * FROM leads WHERE workspace_id = ? AND lead_list_id = ? ORDER BY id', [workspaceId, sel.listId]);
    else if (sel.campaignId) rows = db.all('SELECT l.* FROM leads l JOIN campaign_leads cl ON cl.lead_id = l.id WHERE l.workspace_id = ? AND cl.campaign_id = ? ORDER BY l.id', [workspaceId, sel.campaignId]);
    else if (sel.all) rows = db.all('SELECT * FROM leads WHERE workspace_id = ? ORDER BY id LIMIT 20000', [workspaceId]);
    else throw new Error('Choose leads, a list, a campaign or all');
    return rows.map((l) => ({
      Email: l.email, 'First name': l.first_name, 'Last name': l.last_name, 'Full name': [l.first_name, l.last_name].filter(Boolean).join(' '),
      Company: l.company, Title: l.title, 'Company domain': domainOf(l.email), 'Lead status': l.status,
      ...JSON.parse(l.custom_variables || '{}'),
    }));
  }
}

function clip(v: string | undefined, n: number) {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, n) : undefined;
}

/** One headline status for a lead across campaigns. */
function overall(leadStatus: string, campaignStatuses: string[], sent: number, replies: number): string {
  const has = (s: string) => campaignStatuses.includes(s);
  if (has('interested')) return 'interested';
  if (leadStatus === 'bounced' || has('bounced')) return 'bounced';
  if (leadStatus === 'unsubscribed' || has('unsubscribed')) return 'unsubscribed';
  if (has('replied') || replies > 0) return 'replied';
  if (has('in_sequence')) return 'in sequence';
  if (has('completed')) return 'sequence finished';
  if (has('pending')) return sent ? 'contacted' : 'queued';
  if (has('stopped') || has('paused')) return 'stopped';
  return campaignStatuses.length ? 'in campaign' : 'not in a campaign';
}
