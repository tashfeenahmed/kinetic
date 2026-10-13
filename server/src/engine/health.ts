/**
 * Mailbox health: a 0-100 score with plain-English reasons, and the kill switch that pauses a
 * mailbox when its bounce rate spikes or its domain lands on a public blocklist.
 *
 * Inputs: campaign bounce rate (7 days, counted only since the last manual resume), warmup inbox
 * rate, inbox placement tests (30 days), free DNS blocklists for the domain and any pinned sending
 * IP, and SPF/DKIM/DMARC. DNS answers are cached for ~12h in health_dns_cache. An hourly job
 * refreshes every mailbox; each hard bounce runs the cheap bounce check straight away.
 */
import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { emit } from '../events.ts';
import { decrypt } from '../lib/crypto.ts';
import { checkDomain, domainOf, type DnsCheck, type Resolver } from '../lib/dns.ts';
import { pauseSender } from './sequencer.ts';
import { warmupStats } from './warmup.ts';

export interface HealthResolver extends Resolver {
  resolve4(name: string): Promise<string[]>;
}

let resolver: HealthResolver = new dns.Resolver({ timeout: 4000, tries: 2 });

/** Tests swap in a fake resolver so no real DNS is queried. */
export function setHealthResolver(r: HealthResolver) {
  resolver = r;
}

const CACHE_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;
export const DOMAIN_LISTS = ['dbl.spamhaus.org', 'multi.surbl.org', 'multi.uribl.com'];
export const IP_LISTS = ['zen.spamhaus.org', 'b.barracudacentral.org', 'bl.spamcop.net'];
// Big shared providers: their own reputation is not something a user can fix, so skip DNS checks.
const SHARED_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com']);

export type ListStatus = 'listed' | 'clean' | 'unknown';
export interface ListResult { list: string; status: ListStatus; code?: string }

/**
 * What a blocklist's A record means. 127.255.255.x (Spamhaus) and 127.0.0.1 (SURBL, URIBL) say
 * the query was refused, e.g. it came through a public resolver: unknown, not listed. Anything
 * outside 127/8 is a resolver rewriting NXDOMAIN, also unknown.
 */
export function interpretAnswer(codes: string[]): { status: ListStatus; code?: string } {
  const hit = codes.find((c) => c.startsWith('127.') && c !== '127.0.0.1' && !c.startsWith('127.255.255.'));
  return hit ? { status: 'listed', code: hit } : { status: 'unknown', code: codes[0] };
}

async function queryList(name: string, list: string): Promise<ListResult> {
  try {
    return { list, ...interpretAnswer(await resolver.resolve4(`${name}.${list}`)) };
  } catch (e: any) {
    // No such name = not listed; timeouts and server failures stay unknown.
    return { list, status: e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'clean' : 'unknown' };
  }
}

function cacheRow(ctx: Ctx, key: string) {
  const row = ctx.db.get('SELECT * FROM health_dns_cache WHERE key = ?', [key]);
  const fresh = !!row && ctx.now().getTime() - Date.parse(row.checked_at) < CACHE_MS;
  return { row, fresh };
}

function saveCache(ctx: Ctx, key: string, value: unknown, listedSince: string | null = null) {
  ctx.db.run(`INSERT INTO health_dns_cache (key, value, listed_since, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, listed_since = excluded.listed_since, checked_at = excluded.checked_at`,
  [key, JSON.stringify(value), listedSince, ctx.now().toISOString()]);
}

export interface BlocklistReport { target: string; results: ListResult[]; listed: string[]; listedSince: string | null }

/** Checks a domain (DBL/SURBL/URIBL) or an IPv4 address (ZEN/Barracuda/SpamCop), cached. */
export async function checkBlocklists(ctx: Ctx, target: string): Promise<BlocklistReport> {
  const ip = isIPv4(target);
  const key = `bl:${target}`;
  const { row, fresh } = cacheRow(ctx, key);
  let results: ListResult[];
  let listedSince: string | null;
  if (fresh) {
    results = JSON.parse(row!.value);
    listedSince = row!.listed_since;
  } else {
    const name = ip ? target.split('.').reverse().join('.') : target;
    results = await Promise.all((ip ? IP_LISTS : DOMAIN_LISTS).map((l) => queryList(name, l)));
    // A listing keeps its first-seen time while it lasts, so a manual resume can override it.
    listedSince = results.some((r) => r.status === 'listed') ? row?.listed_since ?? ctx.now().toISOString() : null;
    saveCache(ctx, key, results, listedSince);
  }
  return { target, results, listed: results.filter((r) => r.status === 'listed').map((r) => r.list), listedSince };
}

async function authChecks(ctx: Ctx, domain: string): Promise<DnsCheck[]> {
  const key = `auth:${domain}`;
  const { row, fresh } = cacheRow(ctx, key);
  if (fresh) return JSON.parse(row!.value);
  const { checks } = await checkDomain(domain, resolver);
  saveCache(ctx, key, checks);
  return checks;
}

/** The public IPv4 a mailbox is pinned to through its IP route, if any. */
function pinnedIp(ctx: Ctx, sender: Row): string | null {
  if (!sender.egress_route_id) return null;
  const route = ctx.db.get('SELECT * FROM egress_routes WHERE id = ?', [sender.egress_route_id]);
  if (!route) return null;
  let host: string | null = route.local_address ?? null;
  if (!host && route.proxy_url) {
    try {
      const url = route.proxy_url.startsWith('enc:') ? decrypt(route.proxy_url.slice(4)) : route.proxy_url;
      host = new URL(url).hostname;
    } catch { /* unreadable route */ }
  }
  return host && isIPv4(host) && !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) ? host : null;
}

/** Campaign sends and hard bounces since `ms` ago, ignoring anything sent before the last manual resume. */
function bounceWindow(ctx: Ctx, sender: Row, ms: number) {
  const since = new Date(ctx.now().getTime() - ms).toISOString();
  const from = sender.resumed_at && sender.resumed_at > since ? sender.resumed_at : since;
  const r = ctx.db.get<{ sent: number; bounced: number }>(
    `SELECT COUNT(*) AS sent, COALESCE(SUM(bounced),0) AS bounced FROM sent_emails WHERE sender_email_id = ? AND kind = 'campaign' AND sent_at >= ?`,
    [sender.id, from])!;
  return { ...r, rate: r.sent ? r.bounced / r.sent : 0 };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Why the bounce kill switch should fire, or null. */
function bounceTrigger(ctx: Ctx, sender: Row): string | null {
  const week = bounceWindow(ctx, sender, 7 * DAY_MS);
  if (week.sent >= 20 && week.rate >= 0.05) return `${pct(week.rate)} of emails bounced in the last 7 days (${week.bounced} of ${week.sent})`;
  const day = bounceWindow(ctx, sender, DAY_MS);
  if (day.bounced >= 3 && day.rate >= 0.1) return `${day.bounced} emails bounced in the last 24 hours (${pct(day.rate)} of ${day.sent})`;
  return null;
}

/** Pauses a connected mailbox on its own, records why and tells webhooks. False if not paused. */
function autoPause(ctx: Ctx, sender: Row, reason: string): boolean {
  if (sender.status !== 'Connected') return false;
  const ws = ctx.db.get('SELECT auto_pause_senders FROM workspaces WHERE id = ?', [sender.workspace_id]);
  if (!ws?.auto_pause_senders) return false;
  pauseSender(ctx, sender, reason);
  emit(ctx, sender.workspace_id, 'SENDER_AUTO_PAUSED', { sender_email_id: sender.id, sender_email: sender.email, reason }, { sender_email_id: sender.id });
  ctx.log.warn({ sender: sender.id, reason }, 'mailbox paused automatically');
  return true;
}

/** Cheap check after a hard bounce: no DNS, just the bounce thresholds. */
export function checkBounces(ctx: Ctx, senderId: number): boolean {
  const sender = ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [senderId]);
  if (!sender || sender.status !== 'Connected') return false;
  const reason = bounceTrigger(ctx, sender);
  return reason ? autoPause(ctx, sender, reason) : false;
}

export interface HealthResult { score: number; reasons: string[]; paused: boolean }

/** Recomputes one mailbox's score and reasons, stores them, and pauses it if the kill switch fires. */
export async function refreshSenderHealth(ctx: Ctx, sender: Row): Promise<HealthResult> {
  const { db } = ctx;
  let score = 100;
  const reasons: string[] = [];
  const hit = (points: number, reason: string) => { score -= points; reasons.push(reason); };

  const week = bounceWindow(ctx, sender, 7 * DAY_MS);
  if (week.sent >= 10 && week.rate >= 0.02) hit(week.rate >= 0.05 ? 40 : 15, `${pct(week.rate)} of campaign emails bounced in the last 7 days (${week.bounced} of ${week.sent})`);

  const w = warmupStats(ctx, sender.id);
  if (w.landed_inbox + w.landed_spam >= 5 && w.health_score! < 90) hit(w.health_score! < 70 ? 30 : 10, `Only ${w.health_score}% of warmup emails landed in the inbox in the last 7 days`);

  const since30 = new Date(ctx.now().getTime() - 30 * DAY_MS).toISOString();
  const p = db.get<{ inbox: number; spam: number }>(
    `SELECT COALESCE(SUM(r.result = 'inbox'),0) AS inbox, COALESCE(SUM(r.result = 'spam'),0) AS spam
     FROM placement_results r JOIN placement_tests t ON t.id = r.placement_test_id WHERE r.sender_email_id = ? AND t.created_at >= ?`,
    [sender.id, since30])!;
  if (p.spam) hit(p.spam * 2 >= p.inbox + p.spam ? 25 : 10, `${p.spam} of ${p.inbox + p.spam} placement test emails landed in spam in the last 30 days`);

  const domain = domainOf(sender.email);
  let domainList: BlocklistReport | null = null;
  if (domain && !SHARED_DOMAINS.has(domain)) {
    domainList = await checkBlocklists(ctx, domain);
    if (domainList.listed.length) hit(50, `${domain} is on a blocklist (${domainList.listed.join(', ')})`);
    for (const c of await authChecks(ctx, domain)) {
      if (c.status === 'fail') hit(10, `${c.name} record is missing or broken for ${domain}`);
      else if (c.status === 'warn') hit(5, `${c.name} record needs attention for ${domain}`);
    }
  }
  const ip = pinnedIp(ctx, sender);
  if (ip) {
    const ipList = await checkBlocklists(ctx, ip);
    if (ipList.listed.length) hit(30, `Sending IP ${ip} is on a blocklist (${ipList.listed.join(', ')})`);
  }

  score = Math.max(0, Math.min(100, score));
  db.update('sender_emails', sender.id, { health_score: score, health_reasons: JSON.stringify(reasons), health_checked_at: ctx.now().toISOString() });

  // Kill switch. A listing the user already resumed past does not pause again.
  const fresh = db.get('SELECT * FROM sender_emails WHERE id = ?', [sender.id])!;
  const newListing = domainList?.listed.length && !(fresh.resumed_at && domainList.listedSince && fresh.resumed_at >= domainList.listedSince);
  const reason = bounceTrigger(ctx, fresh) ?? (newListing ? `${domain} is on a blocklist (${domainList!.listed.join(', ')})` : null);
  const paused = reason ? autoPause(ctx, fresh, reason) : false;
  return { score, reasons, paused };
}

/** Hourly job: refresh every mailbox's health (DNS answers come from the 12h cache). */
export async function refreshHealth(ctx: Ctx): Promise<{ checked: number; paused: number }> {
  let checked = 0;
  let paused = 0;
  for (const s of ctx.db.all(`SELECT * FROM sender_emails ORDER BY health_checked_at IS NOT NULL, health_checked_at LIMIT 500`)) {
    try {
      if ((await refreshSenderHealth(ctx, s)).paused) paused++;
      checked++;
    } catch (err) {
      ctx.log.warn({ err, sender: s.id }, 'health check failed');
    }
  }
  return { checked, paused };
}
