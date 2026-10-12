/**
 * Website visitors: ingest from the tracking snippet, identify companies (IP → org)
 * and people (signed lead token from email clicks, identify calls), score intent,
 * alert, push to tables and prune raw events.
 */
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { hmacSha256, randomToken } from '../lib/crypto.ts';
import { Settings } from '../gtm/settings.ts';
import { ENRICH_KINDS } from '../gtm/providers/catalog.ts';
import { wikidataDomain } from '../gtm/providers/openData.ts';
import { slackPost } from '../gtm/providers/integrations.ts';
import { RUNNABLE, type ColumnType } from '../gtm/engine/store.ts';
import type { Ctx as ProviderCtx } from '../gtm/providers/types.ts';
import { classifyOrg, isPrivateIp, registrableDomain, resolveIp, type IntelDeps } from './ipintel.ts';

export const DEFAULT_KEY_PAGES = ['/pricing', '/demo', '/contact'];
const DAY = 86_400_000;
const SCORE_WINDOW_DAYS = 30;
const ALERT_COOLDOWN_MS = DAY;
const SESSION_PATH_CAP = 100;

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'yandex.com', 'yandex.ru', 'mail.com', 'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com', 'eircom.net']);

// ---------- background work tracking (tests await it) ----------
const pending = new Set<Promise<unknown>>();
function track(p: Promise<unknown>, ctx: Ctx, what: string) {
  const q: Promise<unknown> = p.catch((err) => ctx.log.warn({ err }, `visitors: ${what} failed`)).finally(() => pending.delete(q));
  pending.add(q);
}
/** Runs `fn` after the current request/transaction, tracked so tests can await it. */
function later(ctx: Ctx, what: string, fn: () => Promise<unknown> | unknown) {
  track(new Promise((r) => setImmediate(r)).then(fn), ctx, what);
}
/** Waits for resolutions/alerts started by collect() (tests; graceful shutdown). */
export async function settleVisitors() {
  while (pending.size) await Promise.all([...pending]);
}

/** Reverse DNS is swappable so tests never hit the network. */
let reverseDns: IntelDeps['reverse'];
export function setReverseDns(fn: IntelDeps['reverse']) {
  reverseDns = fn;
}

const gtmSettings = (ctx: Ctx) => ctx.gtm?.settings ?? new Settings(ctx.db);

// ---------- settings ----------
export interface VisitorSettings {
  respect_dnt: boolean;
  retention_days: number;
  alert_threshold: number;
  alert_on: 'targets' | 'all' | 'off';
  alert_slack: boolean;
  alert_webhook_url: string | null;
  target_domains: string[];
  auto_push_table_id: number | null;
  auto_push_score: number | null;
}

export function getVisitorSettings(ctx: Ctx, workspaceId: number): VisitorSettings {
  const r = ctx.db.get('SELECT * FROM visitor_settings WHERE workspace_id = ?', [workspaceId]);
  return {
    respect_dnt: r ? !!r.respect_dnt : true,
    retention_days: r?.retention_days ?? 180,
    alert_threshold: r?.alert_threshold ?? 60,
    alert_on: r?.alert_on ?? 'targets',
    alert_slack: !!r?.alert_slack,
    alert_webhook_url: r?.alert_webhook_url ?? null,
    target_domains: r ? JSON.parse(r.target_domains) : [],
    auto_push_table_id: r?.auto_push_table_id ?? null,
    auto_push_score: r?.auto_push_score ?? null,
  };
}

export function saveVisitorSettings(ctx: Ctx, workspaceId: number, patch: Partial<VisitorSettings>): VisitorSettings {
  const next = { ...getVisitorSettings(ctx, workspaceId), ...patch };
  next.target_domains = [...new Set(next.target_domains.map((d) => cleanDomain(d)).filter((d): d is string => !!d))];
  ctx.db.run(`INSERT INTO visitor_settings (workspace_id, respect_dnt, retention_days, alert_threshold, alert_on, alert_slack, alert_webhook_url, target_domains, auto_push_table_id, auto_push_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET respect_dnt = excluded.respect_dnt, retention_days = excluded.retention_days,
    alert_threshold = excluded.alert_threshold, alert_on = excluded.alert_on, alert_slack = excluded.alert_slack, alert_webhook_url = excluded.alert_webhook_url,
    target_domains = excluded.target_domains, auto_push_table_id = excluded.auto_push_table_id, auto_push_score = excluded.auto_push_score, updated_at = excluded.updated_at`,
  [workspaceId, next.respect_dnt ? 1 : 0, next.retention_days, next.alert_threshold, next.alert_on, next.alert_slack ? 1 : 0, next.alert_webhook_url || null, JSON.stringify(next.target_domains), next.auto_push_table_id, next.auto_push_score, ctx.now().toISOString()]);
  return getVisitorSettings(ctx, workspaceId);
}

// ---------- public URL ----------
/** Base URL browsers use for the script and collect endpoint. */
export function trackingBase(ctx: Ctx): string {
  return (gtmSettings(ctx).get('TRACKING_PUBLIC_URL') || ctx.config.publicUrl).replace(/\/+$/, '');
}

/** Whether visitors' browsers can reach the tracking URL at all. */
export function publicUrlStatus(ctx: Ctx): { url: string; reachable: boolean; https: boolean; problem: string | null } {
  const url = trackingBase(ctx);
  let host = '';
  let https = false;
  try { const u = new URL(url); host = u.hostname.replace(/^\[|\]$/g, ''); https = u.protocol === 'https:'; } catch { /* invalid */ }
  const local = !host || host === 'localhost' || /\.(local|lan|home|internal|localdomain)$/i.test(host) || !host.includes('.') && !host.includes(':')
    || (/^[\d.:a-f]+$/i.test(host) && isPrivateIp(host));
  const problem = local
    ? `${url} is only reachable on your own network, so the snippet cannot load on your public website. Expose Kinetic publicly (e.g. a Cloudflare Tunnel) and set TRACKING_PUBLIC_URL to that https address.`
    : !https ? `${url} is not HTTPS — browsers block it on HTTPS websites. Put it behind HTTPS and update TRACKING_PUBLIC_URL.` : null;
  return { url, reachable: !local, https, problem };
}

export const scriptUrl = (ctx: Ctx, siteKey: string) => `${trackingBase(ctx)}/v.js?k=${siteKey}`;
export const collectUrl = (ctx: Ctx) => `${trackingBase(ctx)}/api/v/collect`;

// ---------- signed lead token (email click → website) ----------
const tokenSig = (ctx: Ctx, workspaceId: number, leadId: number) =>
  hmacSha256(ctx.config.appKey.toString('base64'), `k_vid|${workspaceId}|${leadId}`).slice(0, 12);

export function signLeadToken(ctx: Ctx, workspaceId: number, leadId: number): string {
  return `${leadId.toString(36)}.${tokenSig(ctx, workspaceId, leadId)}`;
}

export function verifyLeadToken(ctx: Ctx, workspaceId: number, token: string | undefined | null): number | null {
  const m = /^([0-9a-z]{1,12})\.([0-9a-f]{12})$/.exec(String(token ?? ''));
  if (!m) return null;
  const leadId = parseInt(m[1]!, 36);
  return tokenSig(ctx, workspaceId, leadId) === m[2] ? leadId : null;
}

const hostMatches = (host: string, domain: string) => {
  host = host.toLowerCase().replace(/^www\./, '');
  domain = domain.toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith(`.${domain}`);
};

/**
 * Appends `k_vid=<signed lead token>` when the click destination is one of the
 * workspace's tracked sites, so the snippet can tie the visit to the lead.
 */
export function withVisitorParam(ctx: Ctx, workspaceId: number, leadId: number | null | undefined, url: string): string {
  if (!leadId) return url;
  try {
    const u = new URL(url);
    const sites = ctx.db.all<{ domain: string }>('SELECT domain FROM visitor_sites WHERE workspace_id = ?', [workspaceId]);
    if (!sites.some((s) => hostMatches(u.hostname, s.domain))) return url;
    u.searchParams.set('k_vid', signLeadToken(ctx, workspaceId, leadId));
    return u.toString();
  } catch {
    return url;
  }
}

// ---------- scoring ----------
export interface ScoredSession { started_at: string; pageviews: number; key_pages: number; duration_s: number }

/**
 * Intent score 0–100 over the last 30 days: depth (pages), key pages (pricing, demo,
 * contact…), repeat visits, time on site and recency of the last visit.
 */
export function scoreVisits(sessions: ScoredSession[], now: Date): number {
  const cutoff = now.getTime() - SCORE_WINDOW_DAYS * DAY;
  const recent = sessions.filter((s) => Date.parse(s.started_at) >= cutoff);
  if (!recent.length) return 0;
  const pages = recent.reduce((n, s) => n + s.pageviews, 0);
  const key = recent.reduce((n, s) => n + s.key_pages, 0);
  const seconds = recent.reduce((n, s) => n + s.duration_s, 0);
  const lastMs = Math.max(...recent.map((s) => Date.parse(s.started_at)));
  const days = (now.getTime() - lastMs) / DAY;
  const depth = Math.min(25, pages * 3);
  const intent = Math.min(35, key * 12);
  const repeat = Math.min(20, (recent.length - 1) * 7);
  const time = Math.min(10, Math.floor(seconds / 60) * 2);
  const recency = days <= 1 ? 10 : days <= 7 ? 6 : days <= 14 ? 3 : 0;
  return Math.min(100, Math.round(depth + intent + repeat + time + recency));
}

function recomputeScore(ctx: Ctx, table: 'visitor_companies' | 'visitor_people', id: number): number {
  const col = table === 'visitor_companies' ? 'company_id' : 'person_id';
  const since = new Date(ctx.now().getTime() - SCORE_WINDOW_DAYS * DAY).toISOString();
  const sessions = ctx.db.all<ScoredSession>(`SELECT started_at, pageviews, key_pages, duration_s FROM visitor_sessions WHERE ${col} = ? AND started_at >= ?`, [id, since]);
  const score = scoreVisits(sessions, ctx.now());
  ctx.db.run(`UPDATE ${table} SET score = ? WHERE id = ?`, [score, id]);
  return score;
}

// ---------- bots & rate limiting ----------
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link|outbrain|pinterest|vkshare|w3c_validator|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget|python|java\/|go-http|okhttp|axios|node-fetch|undici|httpclient|libwww|scrapy|preview|ahrefs|semrush|mj12|dotbot|petalbot|yandex|baidu|duckduck|applebot|googleother|mediapartners/i;

export function isBot(ua: string | undefined | null): boolean {
  return !ua || ua.length < 20 || BOT_UA.test(ua);
}

export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  /** Returns false once `key` has been seen more than `limit` times in `windowMs`. */
  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset < now) { this.hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n++;
    return h.n <= limit;
  }
  reset() { this.hits.clear(); }
}
export const limiter = new RateLimiter();
export const RATE_LIMITS = { perIpPerMinute: 120, perSitePerMinute: 6000 };

// ---------- client IP behind proxies ----------
/** CF-Connecting-IP (Cloudflare Tunnel) first, then the leftmost X-Forwarded-For (Fastify trustProxy), then the socket. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  return first(headers['cf-connecting-ip']) || first(headers['true-client-ip']) || first(headers['x-real-ip']) || first(headers['x-forwarded-for']) || fallback;
}

// ---------- ingest ----------
export interface CollectBody {
  k: string; t: 'pv' | 'leave' | 'click' | 'id'; sid: string; vid?: string; u?: string; ti?: string; r?: string;
  d?: number; h?: string; x?: string; em?: string; kv?: string | null;
}

export interface CollectMeta { ip: string; ua?: string; origin?: string; dnt?: boolean }

export type CollectResult =
  | { status: 'ok'; sessionId: number }
  | { status: 'ignored'; reason: 'bot' | 'dnt' | 'no_session' }
  | { status: 'rejected'; code: 403 | 404 | 429; reason: string };

export function siteByKey(ctx: Ctx, key: string) {
  return ctx.db.get('SELECT * FROM visitor_sites WHERE site_key = ?', [key]);
}

export function originAllowed(site: Row, origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true; // beacons from file:// or privacy modes; UA/bot checks still apply
  try {
    const host = new URL(origin).hostname;
    return hostMatches(host, site.domain) || host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

const cleanPath = (url: string) => {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return p.slice(0, 300);
  } catch {
    return '/';
  }
};

export function isKeyPage(path: string, keyPages: string[]): boolean {
  const p = path.toLowerCase();
  return keyPages.some((k) => {
    const kp = k.trim().toLowerCase().replace(/\/+$/, '');
    if (!kp) return false;
    if (kp.endsWith('*')) return p.startsWith(kp.slice(0, -1));
    return p === kp || p.startsWith(`${kp}/`);
  });
}

function cleanDomain(d: string | null | undefined): string | null {
  const s = String(d ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/** Records one event from the snippet. Org resolution and alerts continue in the background. */
export function collect(ctx: Ctx, body: CollectBody, meta: CollectMeta): CollectResult {
  const { db } = ctx;
  const site = siteByKey(ctx, body.k);
  if (!site) return { status: 'rejected', code: 404, reason: 'Unknown site key' };
  if (!originAllowed(site, meta.origin)) return { status: 'rejected', code: 403, reason: 'Origin does not match the site domain' };
  if (isBot(meta.ua)) return { status: 'ignored', reason: 'bot' };
  const settings = getVisitorSettings(ctx, site.workspace_id);
  if (settings.respect_dnt && meta.dnt) return { status: 'ignored', reason: 'dnt' };
  const nowMs = ctx.now().getTime();
  if (!limiter.allow(`ip|${meta.ip}|${site.id}`, RATE_LIMITS.perIpPerMinute, 60_000, nowMs)
    || !limiter.allow(`site|${site.id}`, RATE_LIMITS.perSitePerMinute, 60_000, nowMs)) return { status: 'rejected', code: 429, reason: 'Too many events' };

  const now = ctx.now().toISOString();
  const ws = site.workspace_id as number;
  if (!site.last_hit_at || nowMs - Date.parse(site.last_hit_at) > 60_000) db.run('UPDATE visitor_sites SET last_hit_at = ? WHERE id = ?', [now, site.id]);

  return db.tx(() => {
    let session = db.get('SELECT * FROM visitor_sessions WHERE site_id = ? AND session_key = ?', [site.id, body.sid]);
    let isNew = false;
    if (!session) {
      if (body.t === 'leave') return { status: 'ignored', reason: 'no_session' } as const;
      const utm: Record<string, string | null> = {};
      try { const q = new URL(body.u ?? '').searchParams; for (const k of ['source', 'medium', 'campaign', 'term', 'content']) utm[`utm_${k}`] = q.get(`utm_${k}`)?.slice(0, 200) ?? null; } catch { /* no url */ }
      const id = db.insert('visitor_sessions', {
        workspace_id: ws, site_id: site.id, session_key: body.sid, visitor_id: body.vid ?? '', ip: meta.ip, user_agent: (meta.ua ?? '').slice(0, 400),
        landing_url: (body.u ?? '').slice(0, 2000), referrer: (body.r ?? '').slice(0, 2000), ...utm, started_at: now, last_seen_at: now,
      });
      session = db.get('SELECT * FROM visitor_sessions WHERE id = ?', [id]);
      isNew = true;
    }

    // Who is it? Email-click token, an earlier identify on this browser, or identify() now.
    let personId: number | null = session.person_id;
    const leadId = verifyLeadToken(ctx, ws, body.kv);
    if (leadId) {
      const lead = db.get('SELECT id, email FROM leads WHERE id = ? AND workspace_id = ?', [leadId, ws]);
      if (lead) personId = upsertPerson(ctx, ws, lead.email, 'email_click');
    }
    if (!personId && body.vid) personId = db.get('SELECT person_id FROM visitor_identities WHERE workspace_id = ? AND visitor_id = ?', [ws, body.vid])?.person_id ?? null;
    if (body.t === 'id' && body.em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.em)) personId = upsertPerson(ctx, ws, body.em, 'identify');
    if (personId && body.vid) db.run(`INSERT INTO visitor_identities (workspace_id, visitor_id, person_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, visitor_id) DO UPDATE SET person_id = excluded.person_id`, [ws, body.vid, personId, now]);
    if (personId && personId !== session.person_id) session = attachPerson(ctx, session, personId);

    // The event itself.
    if (body.t === 'pv') {
      const path = cleanPath(body.u ?? '');
      const key = isKeyPage(path, JSON.parse(site.key_pages || '[]')) ? 1 : 0;
      db.insert('visitor_events', { workspace_id: ws, session_id: session.id, type: 'pageview', url: (body.u ?? '').slice(0, 2000), path, title: (body.ti ?? '').slice(0, 300), created_at: now });
      const paths = bump(JSON.parse(session.paths || '{}'), path);
      db.run('UPDATE visitor_sessions SET pageviews = pageviews + 1, key_pages = key_pages + ?, paths = ?, last_seen_at = ? WHERE id = ?', [key, JSON.stringify(paths), now, session.id]);
      if (session.company_id) db.run('UPDATE visitor_companies SET pageviews = pageviews + 1, key_pageviews = key_pageviews + ?, last_seen_at = ? WHERE id = ?', [key, now, session.company_id]);
      if (session.person_id) {
        const p = db.get('SELECT pages FROM visitor_people WHERE id = ?', [session.person_id]);
        db.run('UPDATE visitor_people SET pageviews = pageviews + 1, pages = ?, last_seen_at = ? WHERE id = ?', [JSON.stringify(bump(JSON.parse(p?.pages || '{}'), path)), now, session.person_id]);
      }
    } else if (body.t === 'leave') {
      const sec = Math.max(0, Math.min(1800, Math.round(Number(body.d) || 0)));
      db.run('UPDATE visitor_sessions SET duration_s = duration_s + ?, last_seen_at = ? WHERE id = ?', [sec, now, session.id]);
      db.run(`UPDATE visitor_events SET duration_s = duration_s + ? WHERE id = (SELECT id FROM visitor_events WHERE session_id = ? AND type = 'pageview' ORDER BY id DESC LIMIT 1)`, [sec, session.id]);
    } else if (body.t === 'click') {
      db.insert('visitor_events', { workspace_id: ws, session_id: session.id, type: 'click', url: (body.u ?? '').slice(0, 2000), path: cleanPath(body.u ?? ''), title: (body.x ?? '').slice(0, 300), data: JSON.stringify({ href: (body.h ?? '').slice(0, 2000) }), created_at: now });
      db.run('UPDATE visitor_sessions SET last_seen_at = ? WHERE id = ?', [now, session.id]);
    } else if (body.t === 'id') {
      db.insert('visitor_events', { workspace_id: ws, session_id: session.id, type: 'identify', url: (body.u ?? '').slice(0, 2000), path: cleanPath(body.u ?? ''), title: (body.em ?? '').slice(0, 200), created_at: now });
    }

    session = db.get('SELECT * FROM visitor_sessions WHERE id = ?', [session.id]);
    db.run('UPDATE visitor_sessions SET score = ? WHERE id = ?', [scoreVisits([session], ctx.now()), session.id]);
    if (session.company_id) recomputeScore(ctx, 'visitor_companies', session.company_id);
    if (session.person_id) recomputeScore(ctx, 'visitor_people', session.person_id);
    const sid = session.id;
    if (body.t === 'pv' && (session.company_id || session.person_id)) later(ctx, 'alert', () => maybeAlert(ctx, sid));
    if (isNew) later(ctx, 'resolve', () => resolveSession(ctx, sid));
    return { status: 'ok', sessionId: session.id } as const;
  });
}

function bump(map: Record<string, number>, path: string) {
  if (map[path] != null || Object.keys(map).length < SESSION_PATH_CAP) map[path] = (map[path] ?? 0) + 1;
  return map;
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>) {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v;
  return a;
}

function upsertPerson(ctx: Ctx, workspaceId: number, email: string, source: string): number {
  const e = email.trim().toLowerCase();
  const now = ctx.now().toISOString();
  const lead = ctx.db.get('SELECT id FROM leads WHERE workspace_id = ? AND email = ?', [workspaceId, e]);
  const existing = ctx.db.get('SELECT id, lead_id FROM visitor_people WHERE workspace_id = ? AND email = ?', [workspaceId, e]);
  if (existing) {
    if (lead && !existing.lead_id) ctx.db.run('UPDATE visitor_people SET lead_id = ? WHERE id = ?', [lead.id, existing.id]);
    return existing.id;
  }
  return ctx.db.insert('visitor_people', { workspace_id: workspaceId, email: e, lead_id: lead?.id ?? null, source, first_seen_at: now, last_seen_at: now });
}

function upsertCompany(ctx: Ctx, workspaceId: number, c: { domain: string | null; name: string | null; source: string }): number | null {
  const domain = cleanDomain(c.domain);
  const key = domain ?? (c.name ? `org:${c.name.trim().toLowerCase()}` : null);
  if (!key) return null;
  const row = ctx.db.get('SELECT id, name FROM visitor_companies WHERE workspace_id = ? AND key = ?', [workspaceId, key]);
  if (row) {
    if (!row.name && c.name) ctx.db.run('UPDATE visitor_companies SET name = ? WHERE id = ?', [c.name, row.id]);
    return row.id;
  }
  const now = ctx.now().toISOString();
  return ctx.db.insert('visitor_companies', { workspace_id: workspaceId, key, domain, name: c.name?.trim() || domain || '', source: c.source, first_seen_at: now, last_seen_at: now });
}

const announce = (ctx: Ctx, session: Row) => {
  const company = session.company_id ? ctx.db.get('SELECT name, domain FROM visitor_companies WHERE id = ?', [session.company_id]) : null;
  const person = session.person_id ? ctx.db.get('SELECT email, lead_id FROM visitor_people WHERE id = ?', [session.person_id]) : null;
  const site = ctx.db.get('SELECT domain FROM visitor_sites WHERE id = ?', [session.site_id]);
  emit(ctx, session.workspace_id, 'WEBSITE_VISIT', {
    site: site?.domain, session_id: session.id, landing_url: session.landing_url, referrer: session.referrer || null,
    company: company ? { name: company.name, domain: company.domain } : null, lead_email: person?.email ?? null,
  }, { lead_id: person?.lead_id ?? null });
};

/** Links a session to a company: the session's counts so far roll into the company. */
function attachCompany(ctx: Ctx, session: Row, companyId: number, announceIt = !session.company_id && !session.person_id): Row {
  ctx.db.run('UPDATE visitor_sessions SET company_id = ? WHERE id = ?', [companyId, session.id]);
  ctx.db.run(`UPDATE visitor_companies SET visits = visits + 1, pageviews = pageviews + ?, key_pageviews = key_pageviews + ?,
    last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`, [session.pageviews, session.key_pages, session.last_seen_at, companyId]);
  const s = ctx.db.get('SELECT * FROM visitor_sessions WHERE id = ?', [session.id]);
  if (announceIt) announce(ctx, s);
  return s;
}

/** Links a session to a person (and, from their email domain, to their company). */
function attachPerson(ctx: Ctx, session: Row, personId: number): Row {
  const announceIt = !session.company_id && !session.person_id;
  ctx.db.run('UPDATE visitor_sessions SET person_id = ? WHERE id = ?', [personId, session.id]);
  const p = ctx.db.get('SELECT * FROM visitor_people WHERE id = ?', [personId]);
  ctx.db.run('UPDATE visitor_people SET visits = visits + 1, pageviews = pageviews + ?, pages = ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?',
    [session.pageviews, JSON.stringify(mergeCounts(JSON.parse(p.pages || '{}'), JSON.parse(session.paths || '{}'))), session.last_seen_at, personId]);
  let s = ctx.db.get('SELECT * FROM visitor_sessions WHERE id = ?', [session.id]);
  // Their work email says where they work, even on a home connection.
  const domain = p.email.split('@')[1];
  let companyId = s.company_id ?? p.company_id;
  if (!companyId && domain && !FREEMAIL.has(domain)) {
    const lead = p.lead_id ? ctx.db.get('SELECT company FROM leads WHERE id = ?', [p.lead_id]) : null;
    companyId = upsertCompany(ctx, s.workspace_id, { domain, name: lead?.company || null, source: 'lead' });
  }
  if (companyId && !p.company_id) ctx.db.run('UPDATE visitor_people SET company_id = ? WHERE id = ?', [companyId, personId]);
  if (companyId && !s.company_id) s = attachCompany(ctx, s, companyId, announceIt);
  else if (announceIt) announce(ctx, s);
  return s;
}

// ---------- company identification ----------
function intelDeps(ctx: Ctx): IntelDeps {
  return { db: ctx.db, fetch: ctx.fetch, now: ctx.now, ipinfoToken: gtmSettings(ctx).get('IPINFO_TOKEN'), reverse: reverseDns };
}

export const lookupIp = (ctx: Ctx, ip: string) => resolveIp(intelDeps(ctx), ip);

/** Resolves a session's IP to an organisation and links it to the company. */
export async function resolveSession(ctx: Ctx, sessionId: number): Promise<void> {
  const s = ctx.db.get(`SELECT * FROM visitor_sessions WHERE id = ? AND org_status = 'pending'`, [sessionId]);
  if (!s) return;
  const org = await resolveIp(intelDeps(ctx), s.ip);
  const fresh = ctx.db.get('SELECT * FROM visitor_sessions WHERE id = ?', [sessionId]);
  if (!fresh) return;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE visitor_sessions SET org_status = ?, org_name = ? WHERE id = ?', [org.kind, org.orgName, sessionId]);
    if (org.kind !== 'company' || fresh.company_id) return;
    const companyId = upsertCompany(ctx, fresh.workspace_id, { domain: org.domain, name: org.orgName, source: org.source });
    if (!companyId) return;
    attachCompany(ctx, fresh, companyId);
    recomputeScore(ctx, 'visitor_companies', companyId);
  });
  await maybeAlert(ctx, sessionId);
}

// ---------- alerts ----------
function isTarget(ctx: Ctx, workspaceId: number, domain: string | null, settings: VisitorSettings): boolean {
  if (!domain) return false;
  if (settings.target_domains.some((d) => hostMatches(domain, d))) return true;
  // Companies you already prospect (any lead at that domain).
  return !!ctx.db.get(`SELECT 1 FROM leads WHERE workspace_id = ? AND lower(substr(email, instr(email, '@') + 1)) = ? LIMIT 1`, [workspaceId, domain]);
}

function topPages(pages: Record<string, number>, n = 5) {
  return Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, n).map(([path, views]) => ({ path, views }));
}

/** Fires HIGH_INTENT_VISIT (+ Slack / webhook) when a target company or known lead crosses the threshold. */
export async function maybeAlert(ctx: Ctx, sessionId: number): Promise<boolean> {
  const s = ctx.db.get('SELECT * FROM visitor_sessions WHERE id = ?', [sessionId]);
  if (!s) return false;
  const settings = getVisitorSettings(ctx, s.workspace_id);
  if (settings.alert_on === 'off') return false;
  const now = ctx.now();
  const cool = new Date(now.getTime() - ALERT_COOLDOWN_MS).toISOString();
  const company = s.company_id ? ctx.db.get('SELECT * FROM visitor_companies WHERE id = ?', [s.company_id]) : null;
  const person = s.person_id ? ctx.db.get(`SELECT p.*, l.first_name, l.last_name, l.title, l.company AS lead_company FROM visitor_people p
    LEFT JOIN leads l ON l.id = p.lead_id WHERE p.id = ?`, [s.person_id]) : null;

  const personHot = person && person.lead_id && person.score >= settings.alert_threshold && (!person.alerted_at || person.alerted_at < cool);
  const companyHot = company && company.score >= settings.alert_threshold && (!company.alerted_at || company.alerted_at < cool)
    && (settings.alert_on === 'all' || isTarget(ctx, s.workspace_id, company.domain, settings));
  if (!personHot && !companyHot) return false;

  const at = now.toISOString();
  if (personHot) ctx.db.run('UPDATE visitor_people SET alerted_at = ? WHERE id = ?', [at, person.id]);
  if (company && (companyHot || personHot)) ctx.db.run('UPDATE visitor_companies SET alerted_at = ? WHERE id = ?', [at, company.id]);

  const site = ctx.db.get('SELECT domain FROM visitor_sites WHERE id = ?', [s.site_id]);
  const pages = topPages(person ? JSON.parse(person.pages || '{}') : sessionPagesFor(ctx, 'company_id', company!.id));
  const name = person ? [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email : null;
  const companyLabel = company ? company.name || company.domain : person?.lead_company || null;
  const who = name ? `${name}${companyLabel ? ` (${companyLabel})` : ''}` : companyLabel ?? 'A visitor';
  const score = Math.max(person?.score ?? 0, company?.score ?? 0);
  const pageText = pages.map((p) => `${p.path}${p.views > 1 ? ` ×${p.views}` : ''}`).join(', ');
  const text = `High-intent visit on ${site?.domain ?? 'your site'}: ${who} — score ${score} · ${person?.visits ?? company?.visits ?? 1} visit(s) · ${pageText}`;
  const data = {
    site: site?.domain ?? null, score, reason: personHot ? 'known_lead' : 'target_company', text,
    company: company ? { id: company.id, name: company.name, domain: company.domain, visits: company.visits, pageviews: company.pageviews, score: company.score } : null,
    person: person ? { email: person.email, name, lead_id: person.lead_id, visits: person.visits, score: person.score } : null,
    top_pages: pages,
  };
  emit(ctx, s.workspace_id, 'HIGH_INTENT_VISIT', data, { lead_id: person?.lead_id ?? null });

  const out: Promise<unknown>[] = [];
  if (settings.alert_slack) out.push(slackPost(gtmSettings(ctx), { text }));
  if (settings.alert_webhook_url) {
    out.push(ctx.fetch(settings.alert_webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'HIGH_INTENT_VISIT', ...data }), signal: AbortSignal.timeout(10_000) }));
  }
  const results = await Promise.allSettled(out);
  for (const r of results) if (r.status === 'rejected') ctx.log.warn({ err: r.reason }, 'visitor alert delivery failed');
  return true;
}

function sessionPagesFor(ctx: Ctx, col: 'company_id' | 'person_id', id: number, sinceIso?: string): Record<string, number> {
  const rows = ctx.db.all<{ paths: string }>(`SELECT paths FROM visitor_sessions WHERE ${col} = ?${sinceIso ? ' AND started_at >= ?' : ''}`, sinceIso ? [id, sinceIso] : [id]);
  return rows.reduce((acc, r) => mergeCounts(acc, JSON.parse(r.paths || '{}')), {} as Record<string, number>);
}

// ---------- reading ----------
export function companySummary(ctx: Ctx, c: Row) {
  const since = new Date(ctx.now().getTime() - SCORE_WINDOW_DAYS * DAY).toISOString();
  const people = ctx.db.all(`SELECT DISTINCT p.id, p.email, l.first_name, l.last_name, l.title FROM visitor_sessions s JOIN visitor_people p ON p.id = s.person_id
    LEFT JOIN leads l ON l.id = p.lead_id WHERE s.company_id = ? UNION SELECT p.id, p.email, l.first_name, l.last_name, l.title FROM visitor_people p
    LEFT JOIN leads l ON l.id = p.lead_id WHERE p.company_id = ?`, [c.id, c.id]);
  const profile = c.profile ? JSON.parse(c.profile) : null;
  return {
    id: c.id, name: c.name, domain: c.domain, source: c.source, visits: c.visits, pageviews: c.pageviews, key_pageviews: c.key_pageviews, score: c.score,
    first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at, alerted_at: c.alerted_at, pushed_table_id: c.pushed_table_id,
    visits_30d: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM visitor_sessions WHERE company_id = ? AND started_at >= ?', [c.id, since])!.n,
    top_pages: topPages(sessionPagesFor(ctx, 'company_id', c.id, since)),
    people: people.map((p) => ({ id: p.id, email: p.email, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null, title: p.title || null })),
    profile: profile ? { industry: profile.industry ?? null, employees: profile.employees ?? profile.employee_count ?? profile.size ?? null, description: profile.description ?? null, location: profile.location ?? profile.country ?? null, linkedin: profile.linkedin ?? null } : null,
  };
}

export function personSummary(ctx: Ctx, p: Row) {
  const pages = topPages(JSON.parse(p.pages || '{}'), 8);
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
  const company = p.company_name || p.lead_company || null;
  const top = pages[0];
  return {
    id: p.id, email: p.email, name, title: p.title || null, lead_id: p.lead_id, company, company_id: p.company_id, company_domain: p.company_domain ?? null,
    source: p.source, visits: p.visits, pageviews: p.pageviews, score: p.score, first_seen_at: p.first_seen_at, last_seen_at: p.last_seen_at, top_pages: pages,
    summary: `${name ?? p.email}${company ? ` (${company})` : ''} viewed ${top ? `${top.path} ${top.views === 1 ? 'once' : `${top.views} times`}` : 'your site'}`
      + (pages.length > 1 ? ` and ${pages.length - 1} other page${pages.length > 2 ? 's' : ''}` : ''),
  };
}

export const PERSON_SELECT = `SELECT p.*, l.first_name, l.last_name, l.title, l.company AS lead_company, c.name AS company_name, c.domain AS company_domain
  FROM visitor_people p LEFT JOIN leads l ON l.id = p.lead_id LEFT JOIN visitor_companies c ON c.id = p.company_id`;

/** Website-visit numbers for a company domain or a person's email (the "Website visits" signal). */
export function visitStats(ctx: Ctx, workspaceId: number, q: { domain?: string; email?: string }) {
  const since = new Date(ctx.now().getTime() - SCORE_WINDOW_DAYS * DAY).toISOString();
  const email = q.email?.trim().toLowerCase();
  if (email) {
    const p = ctx.db.get('SELECT * FROM visitor_people WHERE workspace_id = ? AND email = ?', [workspaceId, email]);
    if (p) {
      const recent = ctx.db.get<{ n: number; pv: number }>('SELECT COUNT(*) n, COALESCE(SUM(pageviews),0) pv FROM visitor_sessions WHERE person_id = ? AND started_at >= ?', [p.id, since])!;
      return { found: true, kind: 'person' as const, last_visit: p.last_seen_at, visits_30d: recent.n, pageviews_30d: recent.pv, total_visits: p.visits, score: recomputeScore(ctx, 'visitor_people', p.id), pages: topPages(JSON.parse(p.pages || '{}')) };
    }
  }
  const domain = cleanDomain(q.domain) ?? (email ? cleanDomain(email.split('@')[1]) : null);
  if (domain) {
    const c = ctx.db.get('SELECT * FROM visitor_companies WHERE workspace_id = ? AND key = ?', [workspaceId, domain]);
    if (c) {
      const recent = ctx.db.get<{ n: number; pv: number }>('SELECT COUNT(*) n, COALESCE(SUM(pageviews),0) pv FROM visitor_sessions WHERE company_id = ? AND started_at >= ?', [c.id, since])!;
      return { found: true, kind: 'company' as const, last_visit: c.last_seen_at, visits_30d: recent.n, pageviews_30d: recent.pv, total_visits: c.visits, score: recomputeScore(ctx, 'visitor_companies', c.id), pages: topPages(sessionPagesFor(ctx, 'company_id', c.id, since)) };
    }
  }
  return { found: false, kind: null, last_visit: null, visits_30d: 0, pageviews_30d: 0, total_visits: 0, score: 0, pages: [] as { path: string; views: number }[] };
}

// ---------- sites ----------
export function newSiteKey() {
  return `ks_${randomToken(12)}`;
}

export function siteView(ctx: Ctx, s: Row) {
  const url = scriptUrl(ctx, s.site_key);
  const hits = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM visitor_sessions WHERE site_id = ? AND started_at >= ?`, [s.id, new Date(ctx.now().getTime() - 7 * DAY).toISOString()])!.n;
  return {
    id: s.id, domain: s.domain, name: s.name, site_key: s.site_key, key_pages: JSON.parse(s.key_pages || '[]'), last_hit_at: s.last_hit_at, verified_at: s.verified_at,
    created_at: s.created_at, sessions_7d: hits, script_url: url, snippet: `<script>window.kinetic=window.kinetic||[];</script>\n<script async src="${url}"></script>`,
  };
}

/** Install check: a recent hit from the snippet, or the snippet found in the page HTML. */
export async function verifySite(ctx: Ctx, site: Row): Promise<{ ok: boolean; method: string; detail: string }> {
  const recent = site.last_hit_at && ctx.now().getTime() - Date.parse(site.last_hit_at) < 7 * DAY;
  const ok = (method: string, detail: string) => {
    ctx.db.run('UPDATE visitor_sites SET verified_at = ? WHERE id = ?', [ctx.now().toISOString(), site.id]);
    return { ok: true, method, detail };
  };
  if (recent) return ok('hit', `Last event received ${site.last_hit_at}.`);
  for (const url of [`https://${site.domain}/`, `https://www.${site.domain}/`]) {
    try {
      const res = await ctx.fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; KineticInstallCheck/1.0)' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      const html = await res.text();
      if (html.includes(site.site_key)) return ok('html', `Snippet found on ${url}. Events appear once a real browser visits.`);
    } catch { /* try the next one */ }
  }
  return { ok: false, method: 'none', detail: `No events yet and the snippet (key ${site.site_key}) was not found in the HTML of ${site.domain}. Paste it into <head>, publish, then open the site in a browser. Pages rendered only by JavaScript or tag managers will show up once the first event arrives.` };
}

// ---------- push to a table ----------
export interface PushOpts { companyIds?: number[]; minScore?: number; days?: number; tableId?: number | null; tableName?: string; limit?: number }

/** Adds visiting companies to a GTM table (new or existing), skipping domains already there. */
export function pushCompanies(ctx: Ctx, workspaceId: number, opts: PushOpts): { table_id: number; added: number; skipped: number } {
  const gtm = ctx.gtm;
  if (!gtm) throw new Error('Tables are not available');
  const { store, engine, bus } = gtm;
  const params: any[] = [workspaceId];
  let where = 'workspace_id = ? AND domain IS NOT NULL';
  if (opts.companyIds?.length) { where += ` AND id IN (${opts.companyIds.map(() => '?').join(',')})`; params.push(...opts.companyIds); }
  if (opts.minScore != null) { where += ' AND score >= ?'; params.push(opts.minScore); }
  if (opts.days) { where += ' AND last_seen_at >= ?'; params.push(new Date(ctx.now().getTime() - opts.days * DAY).toISOString()); }
  const companies = ctx.db.all(`SELECT * FROM visitor_companies WHERE ${where} ORDER BY score DESC, last_seen_at DESC LIMIT ?`, [...params, opts.limit ?? 500]);

  let tableId: number;
  if (opts.tableId) tableId = store.tableIn(opts.tableId, workspaceId).id;
  else {
    tableId = store.createTable(workspaceId, opts.tableName?.trim() || 'Website visitors');
    for (const name of ['Company', 'Company domain', 'Visits', 'Pageviews', 'Intent score', 'Last visit', 'Top pages', 'Identified people']) store.createColumn(tableId, { name, type: 'text' });
    store.createColumn(tableId, { name: 'Website visits', type: 'signal', auto_run: true, config: { kind: 'website_visits', inputs: { domain: '{{Company domain}}' } } });
  }
  const domainCol = store.columns(tableId).find((c) => c.name === 'Company domain');
  const existing = new Set<string>();
  if (domainCol) for (const r of ctx.db.all<{ value: string }>('SELECT c.value FROM gtm_cells c JOIN gtm_rows r ON r.id = c.row_id WHERE r.table_id = ? AND c.column_id = ?', [tableId, domainCol.id])) {
    try { existing.add(String(JSON.parse(r.value)).toLowerCase()); } catch { /* ignore */ }
  }
  const fresh = companies.filter((c) => !existing.has(c.domain));
  const records = fresh.map((c) => {
    const s = companySummary(ctx, c);
    return {
      Company: c.name || c.domain, 'Company domain': c.domain, Visits: c.visits, Pageviews: c.pageviews, 'Intent score': c.score, 'Last visit': c.last_seen_at,
      'Top pages': s.top_pages.map((p) => `${p.path} (${p.views})`).join(', '), 'Identified people': s.people.map((p) => p.name ? `${p.name} <${p.email}>` : p.email).join(', '),
    };
  });
  const ids = records.length ? store.addRows(tableId, records) : [];
  for (const c of fresh) ctx.db.run('UPDATE visitor_companies SET pushed_table_id = ? WHERE id = ?', [tableId, c.id]);
  bus.publish({ type: 'rows', tableId });
  bus.publish({ type: 'columns', tableId });
  const auto = store.columns(tableId).filter((c) => c.auto_run && RUNNABLE.includes(c.type as ColumnType)).map((c) => c.id);
  if (auto.length && ids.length) engine.run(tableId, { columnIds: auto, rowIds: ids });
  return { table_id: tableId, added: ids.length, skipped: companies.length - fresh.length };
}

// ---------- background job ----------
let lastPrune = 0;

/** Resolves pending sessions, enriches new companies, auto-pushes and prunes. Runs from the worker. */
export async function visitorsJob(ctx: Ctx) {
  for (const s of ctx.db.all<{ id: number }>(`SELECT id FROM visitor_sessions WHERE org_status = 'pending' ORDER BY id LIMIT 25`)) {
    try { await resolveSession(ctx, s.id); } catch (err) {
      ctx.log.warn({ err }, 'visitor session resolve failed');
      ctx.db.run(`UPDATE visitor_sessions SET org_status = 'unknown' WHERE id = ?`, [s.id]);
    }
  }
  await enrichCompanies(ctx, 3);
  for (const st of ctx.db.all('SELECT * FROM visitor_settings WHERE auto_push_table_id IS NOT NULL AND auto_push_score IS NOT NULL')) {
    try {
      const due = ctx.db.all<{ id: number }>('SELECT id FROM visitor_companies WHERE workspace_id = ? AND domain IS NOT NULL AND score >= ? AND (pushed_table_id IS NULL OR pushed_table_id != ?)',
        [st.workspace_id, st.auto_push_score, st.auto_push_table_id]);
      if (due.length) pushCompanies(ctx, st.workspace_id, { companyIds: due.map((d) => d.id), tableId: st.auto_push_table_id });
    } catch (err) {
      ctx.log.warn({ err, workspace: st.workspace_id }, 'visitor auto-push failed');
    }
  }
  if (ctx.now().getTime() - lastPrune > 6 * 3_600_000) {
    lastPrune = ctx.now().getTime();
    pruneVisitorData(ctx);
  }
}

/** Company profile (free sources first) for newly identified companies; org-only rows get a domain lookup. */
export async function enrichCompanies(ctx: Ctx, limit = 3) {
  const kind = ENRICH_KINDS.find((k) => k.id === 'company_profile');
  const settings = gtmSettings(ctx);
  const rows = ctx.db.all('SELECT * FROM visitor_companies WHERE enriched_at IS NULL ORDER BY score DESC, last_seen_at DESC LIMIT ?', [limit]);
  for (const c of rows) {
    const pctx: ProviderCtx = { settings, dataDir: ctx.config.dataDir, workspaceId: c.workspace_id, outreach: ctx.gtm?.outreach, log: () => {} };
    let domain: string | null = c.domain;
    if (!domain && c.name) {
      const hit = await wikidataDomain({ companyName: c.name }, pctx).catch(() => null);
      domain = cleanDomain(hit?.value as string);
      if (domain && classifyOrg(domain.replace(/\./g, ' ')) !== 'company') domain = null;
      if (domain) domain = mergeIntoDomain(ctx, c, registrableDomain(domain) ?? domain);
    }
    let profile: Record<string, unknown> | null = null;
    if (domain && kind) {
      for (const step of kind.steps) {
        if (!step.requires.every((k) => settings.has(k))) continue;
        try {
          const hit = await step.run({ domain, companyName: c.name || undefined }, pctx);
          if (hit) { profile = { ...(hit.data ?? {}), source: step.id }; break; }
        } catch { /* next provider */ }
      }
    }
    const target = ctx.db.get('SELECT id, name, domain FROM visitor_companies WHERE id = ?', [c.id]) ?? c;
    const betterName = profile && typeof profile.name === 'string' && (!target.name || target.name === target.domain) ? profile.name : null;
    ctx.db.run('UPDATE visitor_companies SET profile = ?, enriched_at = ?, name = COALESCE(?, name) WHERE id = ?', [profile ? JSON.stringify(profile) : null, ctx.now().toISOString(), betterName, target.id]);
  }
}

/** An org-name-only company found its domain: fold it into the domain row if one exists. */
function mergeIntoDomain(ctx: Ctx, c: Row, domain: string): string {
  const other = ctx.db.get('SELECT id FROM visitor_companies WHERE workspace_id = ? AND key = ? AND id != ?', [c.workspace_id, domain, c.id]);
  if (!other) {
    ctx.db.run('UPDATE visitor_companies SET key = ?, domain = ? WHERE id = ?', [domain, domain, c.id]);
    return domain;
  }
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE visitor_companies SET visits = visits + ?, pageviews = pageviews + ?, key_pageviews = key_pageviews + ?, first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`,
      [c.visits, c.pageviews, c.key_pageviews, c.first_seen_at, c.last_seen_at, other.id]);
    ctx.db.run('UPDATE visitor_sessions SET company_id = ? WHERE company_id = ?', [other.id, c.id]);
    ctx.db.run('UPDATE visitor_people SET company_id = ? WHERE company_id = ?', [other.id, c.id]);
    ctx.db.run('DELETE FROM visitor_companies WHERE id = ?', [c.id]);
  });
  recomputeScore(ctx, 'visitor_companies', other.id);
  return domain;
}

/** Deletes raw events and sessions past each workspace's retention; company/person totals are kept. */
export function pruneVisitorData(ctx: Ctx): { events: number; sessions: number } {
  let events = 0, sessions = 0;
  for (const w of ctx.db.all<{ id: number }>('SELECT id FROM workspaces')) {
    const days = Math.max(1, getVisitorSettings(ctx, w.id).retention_days);
    const cutoff = new Date(ctx.now().getTime() - days * DAY).toISOString();
    events += ctx.db.run('DELETE FROM visitor_events WHERE workspace_id = ? AND created_at < ?', [w.id, cutoff]).changes;
    sessions += ctx.db.run('DELETE FROM visitor_sessions WHERE workspace_id = ? AND last_seen_at < ?', [w.id, cutoff]).changes;
  }
  ctx.db.run('DELETE FROM visitor_ip_cache WHERE resolved_at < ?', [new Date(ctx.now().getTime() - 60 * DAY).toISOString()]);
  return { events, sessions };
}
