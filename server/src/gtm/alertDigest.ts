/**
 * The daily signal digest. When a signal alert has no Slack or ntfy to go to, it is
 * queued here (alert_digest_items) instead of being emailed straight away. Once a day,
 * when a run of alerts has settled (nothing new queued for SETTLE_MS), the queue is
 * turned into one email:
 *
 *   - noise is dropped: values that read the same, values that went blank, website
 *     "changes" with no new text or that several sites share (a bot wall), news that is
 *     old or doesn't name the company, the same headline from two news sources;
 *   - what's left is grouped by company and sorted into "Worth a look" (hiring, funding,
 *     filings, real news, site visits) and "Also changed" (site copy, tech, GitHub…);
 *   - with an AI key set, one model call re-ranks the items and writes a short
 *     "why it matters" line for each one worth a look.
 *
 * No email goes out on a day where everything was noise.
 */
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { domainOf } from '../lib/dns.ts';
import { escapeHtml } from '../lib/html.ts';
import { aiConfig, chat } from '../engine/replyAi.ts';
import { headline, sameHeadline, type CellChange } from './engine/store.ts';
import { Settings } from './settings.ts';

/** How long the queue must sit still before it is sent, so one signal run lands in one email. */
export const SETTLE_MS = 10 * 60_000;
const MAX_CHANGE_JSON = 4_000;

/** Where a queued alert came from: the row that changed and what changed in it. */
export interface AlertSource {
  tableId: number; rowId: number; row: Record<string, unknown>; changes: CellChange[];
  /** The alert text reports {{_changes}}, so it is only worth sending when something really changed. */
  aboutChanges?: boolean;
}

export interface QueuedAlert {
  title: string;
  text: string;
  tableId?: number;
  rowId?: number;
  company?: string;
  domain?: string;
  aboutChanges?: boolean;
  changes: CellChange[];
}

export type Tier = 'top' | 'minor' | 'noise';

export interface DigestEntry {
  id: number;
  kind: string;
  /** One readable sentence, e.g. "is hiring: 4 open roles". */
  what: string;
  details: string[];
  link?: string;
  tier: Tier;
  why?: string;
  /** Why it was skipped, for noise. */
  reason?: string;
}

export interface DigestGroup { key: string; name: string; domain?: string; tableId?: number; entries: DigestEntry[] }

export interface Digest { groups: DigestGroup[]; top: number; minor: number; skipped: number; skippedReasons: Record<string, number> }

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

const plainLine = (l: string) => l.replace(/:[a-z0-9_+-]+:\s*/g, '').replace(/\*([^*\n]+)\*/g, '$1').trim();

const pick = (row: Record<string, unknown>, re: RegExp) => {
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || !re.test(k)) continue;
    const s = headline(v);
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return undefined;
};

/** Drop the bulky parts of a cell value (page text, full job lists) before queueing it. */
function slim(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as { value?: unknown; data?: Record<string, unknown> };
  if (!o.data) return v;
  const { text: _text, jobs, items, articles, stories, filings, subdomains, ...rest } = o.data as Record<string, any>;
  const data: Record<string, unknown> = { ...rest };
  if (Array.isArray(jobs)) data.jobs = jobs.slice(0, 8).map((j: any) => ({ title: j.title, location: j.location }));
  if (Array.isArray(items)) data.items = items.slice(0, 3);
  if (Array.isArray(articles)) data.articles = articles.slice(0, 3);
  if (Array.isArray(stories)) data.stories = stories.slice(0, 3);
  if (Array.isArray(filings)) data.filings = filings.slice(0, 3);
  if (Array.isArray(subdomains)) data.subdomains = subdomains.slice(0, 20);
  let out: unknown = { ...o, data };
  if (JSON.stringify(out).length > MAX_CHANGE_JSON) out = { value: o.value, data: { url: (data as any).url, title: (data as any).title, added: (data as any).added } };
  return out;
}

/** "https://www.acme.ie/about", "acme.ie" or "jo@acme.ie" → "acme.ie". */
const hostOf = (s: string) => (s.includes('@') ? domainOf(s) : s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0]) || undefined;

export function toQueued(text: string, source?: AlertSource): QueuedAlert {
  const lines = text.split('\n').map(plainLine).filter(Boolean);
  const company = source ? pick(source.row, /^(company|company name|organi[sz]ation|account|name)$/i) ?? pick(source.row, /company|name/i) : undefined;
  const site = source ? pick(source.row, /domain|website|url|site/i) : undefined;
  const fromTitle = lines[0] && !lines[0].includes('→') ? lines[0] : undefined;
  const domain = (site ? hostOf(site) : undefined)
    || fromTitle?.match(/\(([a-z0-9.-]+\.[a-z]{2,})\)/i)?.[1]?.toLowerCase();
  return {
    title: fromTitle?.replace(/\s*\(\s*\)$/, '') || company || lines[0] || 'Signal alert',
    text: lines.join('\n'),
    tableId: source?.tableId,
    rowId: source?.rowId,
    company,
    domain: domain || undefined,
    aboutChanges: source?.aboutChanges,
    changes: (source?.changes ?? []).map((c) => ({ ...c, from: slim(c.from), to: slim(c.to) })),
  };
}

export function queueAlert(ctx: Ctx, workspaceId: number, text: string, source?: AlertSource) {
  ctx.db.insert('alert_digest_items', { workspace_id: workspaceId, item: JSON.stringify(toQueued(text, source)), created_at: ctx.now().toISOString() });
}

// ---------------------------------------------------------------------------
// Building the digest
// ---------------------------------------------------------------------------

const TOP_KINDS = new Set(['funding_sec', 'sec_filings', 'gov_contracts', 'uk_filings', 'job_change', 'website_visits']);
const NEWS_KINDS = new Set(['news', 'gdelt', 'hacker_news']);
const GENERIC_WORDS = new Set(['the', 'and', 'of', 'co', 'company', 'ltd', 'limited', 'inc', 'llc', 'plc', 'group', 'holdings', 'services', 'service',
  'auctioneer', 'auctioneers', 'property', 'properties', 'estate', 'estates', 'real', 'realty', 'advisors', 'advisers', 'agents', 'agency', 'homes', 'lettings', 'sales']);
const NEWS_MAX_AGE_DAYS = 7;

const str = (v: unknown): string => {
  const h = headline(v);
  if (h == null) return '';
  return typeof h === 'string' ? h : Array.isArray(h) ? h.map(String).join(', ') : typeof h === 'object' ? JSON.stringify(h) : String(h);
};
const dataOf = (v: unknown): any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any).data ?? {} : {});
const num = (v: unknown) => { const n = Number(headline(v)); return Number.isFinite(n) ? n : null; };
const asList = (v: unknown) => { const h = headline(v); return Array.isArray(h) ? h.map(String) : []; };
const quote = (s: string, max = 160) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

/** Name words that identify the company in a headline ("DNG Thornton Properties" → dng, thornton). */
export function nameTokens(company?: string, domain?: string): string[] {
  const words = (company ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  const stem = domain?.split('.')[0]?.toLowerCase();
  return [...new Set([...words, ...(stem && stem.length >= 3 ? [stem] : [])])];
}

/** Turns one change into a readable entry with a first-guess tier (the AI may re-rank it). */
export function describe(c: CellChange, q: QueuedAlert, now: Date): Omit<DigestEntry, 'id'> {
  const kind = c.kind ?? c.type;
  const d = dataOf(c.to);
  const to = str(c.to), from = str(c.from);
  if (sameHeadline(c.from, c.to)) return { kind, what: c.name, details: [], tier: 'noise', reason: 'nothing really changed' };
  if (!to) return { kind, what: `${c.name} went blank`, details: [], tier: 'noise', reason: 'value went blank' };
  switch (kind) {
    case 'hiring': {
      const n = num(c.to) ?? 0, was = num(c.from);
      const roles = (d.jobs ?? []).map((j: any) => j.title).filter(Boolean).slice(0, 5);
      if (was != null && n < was) return { kind, what: `has fewer open roles: ${n}, down from ${was}`, details: roles, tier: 'minor' };
      return { kind, what: `is hiring: ${n} open role${n === 1 ? '' : 's'}${was ? `, up from ${was}` : ''}`, details: roles, tier: 'top' };
    }
    case 'news':
    case 'gdelt':
    case 'hacker_news': {
      const date = d.latestDate ?? d.articles?.[0]?.seendate ?? d.stories?.[0]?.created_at;
      const age = date ? (now.getTime() - Date.parse(date)) / 86_400_000 : 0;
      if (age > NEWS_MAX_AGE_DAYS) return { kind, what: quote(to), details: [], tier: 'noise', reason: 'old news' };
      const tokens = nameTokens(q.company ?? q.title, q.domain);
      const named = tokens.some((t) => to.toLowerCase().includes(t));
      return { kind, what: `in the news: ${quote(to)}`, details: [], link: d.url ?? d.articles?.[0]?.url, tier: named ? 'top' : 'noise', reason: named ? undefined : 'news not about this company' };
    }
    case 'website_change': {
      const added: string[] = (d.added ?? []).filter((s: string) => s.length > 20);
      if (!added.length) return { kind, what: 'website changed', details: [], tier: 'noise', reason: 'website changed with no new text' };
      return { kind, what: 'updated their website', details: added.slice(0, 2).map((s) => quote(s, 200)), link: d.url, tier: 'minor' };
    }
    case 'new_subdomains': {
      const was = new Set(asList(c.from));
      const fresh = asList(c.to).filter((s) => !was.has(s));
      if (!fresh.length) return { kind, what: 'subdomains', details: [], tier: 'noise', reason: 'nothing new' };
      return { kind, what: `set up ${fresh.length === 1 ? 'a new subdomain' : `${fresh.length} new subdomains`}: ${fresh.slice(0, 3).join(', ')}`, details: [], tier: 'minor' };
    }
    case 'tech_stack': {
      const was = new Set(asList(c.from)), now = asList(c.to);
      const add = now.filter((t) => !was.has(t)), gone = [...was].filter((t) => !now.includes(t));
      if (!add.length && !gone.length) return { kind, what: 'tech stack', details: [], tier: 'noise', reason: 'nothing new' };
      return { kind, what: `changed their tech stack${add.length ? `: added ${add.slice(0, 4).join(', ')}` : ''}${gone.length ? `${add.length ? ';' : ':'} dropped ${gone.slice(0, 4).join(', ')}` : ''}`, details: [], tier: 'minor' };
    }
    case 'github':
      return { kind, what: 'pushed code on GitHub', details: [], link: d.org ? `https://github.com/${d.org}` : undefined, tier: 'minor' };
    default: {
      const tier: Tier = TOP_KINDS.has(kind) ? 'top' : 'minor';
      return { kind, what: from ? `${c.name}: ${quote(to, 120)} (was ${quote(from, 60)})` : `${c.name}: ${quote(to, 120)}`, details: [], tier };
    }
  }
}

const WHY: Record<string, string> = {
  hiring: 'A growing team usually means a busier business and new budget. A good moment to get in touch.',
  news: 'A timely, specific reason to reach out.',
  gdelt: 'A timely, specific reason to reach out.',
  hacker_news: 'A timely, specific reason to reach out.',
  funding_sec: 'Fresh money usually comes with new spending decisions.',
  uk_filings: 'Company changes often come with new priorities.',
  sec_filings: 'Company changes often come with new priorities.',
  gov_contracts: 'A new contract usually means growth and new needs.',
  job_change: 'A new person in the role often reviews their suppliers.',
  website_visits: 'They have been looking at your site.',
};

export function buildDigest(items: { id: number; item: QueuedAlert }[], now: Date): Digest {
  const groups = new Map<string, DigestGroup>();
  const skippedReasons: Record<string, number> = {};
  const skip = (reason: string) => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
  // A page "changed to" the same content on two different sites is a shared error or bot page.
  const pageHashes = new Map<string, Set<string>>();
  for (const { item } of items) for (const c of item.changes) {
    if ((c.kind ?? c.type) !== 'website_change') continue;
    const h = str(c.to);
    if (h) (pageHashes.get(h) ?? pageHashes.set(h, new Set()).get(h)!).add(item.domain ?? item.title);
  }
  let seq = 0;
  for (const { item } of items) {
    const key = (item.domain ?? item.title).toLowerCase();
    const g = groups.get(key) ?? { key, name: item.company ?? item.title.replace(/\s*\([^)]*\)\s*$/, ''), domain: item.domain, tableId: item.tableId, entries: [] };
    groups.set(key, g);
    // Different rows (offices) of the same company.
    const name = item.company ?? item.title.replace(/\s*\([^)]*\)\s*$/, '');
    if (!g.name.split(', ').includes(name)) g.name = `${g.name}, ${name}`;
    if (!item.changes.length) {
      // A change report with nothing left to report; any other alert the user set up always counts.
      const body = item.text.split('\n').slice(item.text.split('\n')[0] === item.title ? 1 : 0).join(' ').trim();
      g.entries.push(item.aboutChanges
        ? { id: ++seq, kind: 'alert', what: body || item.title, details: [], tier: 'noise', reason: 'nothing really changed' }
        : { id: ++seq, kind: 'alert', what: body || item.title, details: [], tier: 'top' });
      continue;
    }
    for (const c of item.changes) {
      const e: DigestEntry = { id: ++seq, ...describe(c, item, now) };
      if (e.kind === 'website_change' && e.tier !== 'noise' && (pageHashes.get(str(c.to))?.size ?? 0) > 1) { e.tier = 'noise'; e.reason = 'page looked like an error or bot check'; }
      // The same headline from Google News and GDELT, or the same text on two office rows.
      if (e.tier !== 'noise' && g.entries.some((x) => x.tier !== 'noise' && x.what.replace(/^in the news: /, '') === e.what.replace(/^in the news: /, '') && x.details.join() === e.details.join())) { e.tier = 'noise'; e.reason = 'duplicate'; }
      g.entries.push(e);
    }
  }
  let top = 0, minor = 0, skipped = 0;
  for (const g of groups.values()) for (const e of g.entries) {
    if (e.tier === 'top') { top++; e.why ??= WHY[e.kind]; } else if (e.tier === 'minor') minor++; else { skipped++; skip(e.reason ?? 'noise'); }
  }
  return { groups: [...groups.values()], top, minor, skipped, skippedReasons };
}

/** Lets the model re-rank what's left and write "why it matters" lines. Leaves the digest as it is on any failure. */
export async function refineWithAi(ctx: Ctx, digest: Digest, workspaceName: string): Promise<boolean> {
  const live = digest.groups.flatMap((g) => g.entries.filter((e) => e.tier !== 'noise').map((e) => ({ g, e })));
  if (!live.length || !aiConfig(ctx).configured) return false;
  const list = live.map(({ g, e }) => ({ id: e.id, company: g.name, domain: g.domain, change: e.what, details: e.details, guess: e.tier }));
  const system = `You help a B2B sales team (workspace "${workspaceName}") decide which overnight changes at their prospect companies are worth acting on today.
For each item answer with a tier:
- "top": a real reason to contact this company now (hiring, growth, funding, new office, award, leadership change, real news about them).
- "minor": a real change but not a reason to reach out on its own.
- "noise": not about this company, routine, or meaningless.
For "top" items write "why": one plain sentence (max 22 words) a salesperson can act on. No hype, no emojis.
Reply with JSON only: [{"id":1,"tier":"top","why":"..."}]`;
  try {
    const { content } = await chat(ctx, { model: aiConfig(ctx).defaultModel, system, user: JSON.stringify(list), maxTokens: 1500 });
    const parsed = JSON.parse(content.slice(content.indexOf('['), content.lastIndexOf(']') + 1)) as { id: number; tier: Tier; why?: string }[];
    const byId = new Map(parsed.map((p) => [p.id, p]));
    for (const { e } of live) {
      const p = byId.get(e.id);
      if (!p || !['top', 'minor', 'noise'].includes(p.tier)) continue;
      e.tier = p.tier;
      e.why = p.tier === 'top' ? (p.why?.trim() || e.why || WHY[e.kind]) : undefined;
      if (p.tier === 'noise') e.reason = 'judged not worth a look';
    }
  } catch (err) {
    ctx.log.warn({ err }, 'alert digest: AI ranking failed, using rule-based ranking');
    return false;
  }
  let top = 0, minor = 0, skipped = 0;
  const skippedReasons: Record<string, number> = {};
  for (const g of digest.groups) for (const e of g.entries) {
    if (e.tier === 'top') top++; else if (e.tier === 'minor') minor++; else { skipped++; skippedReasons[e.reason ?? 'noise'] = (skippedReasons[e.reason ?? 'noise'] ?? 0) + 1; }
  }
  Object.assign(digest, { top, minor, skipped, skippedReasons });
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const displayName = (g: DigestGroup) => {
  const names = g.name.split(', ');
  return names.length > 1 ? `${names[0]} (+${names.length - 1} more office${names.length > 2 ? 's' : ''})` : names[0];
};

/** "DNG Greystones is hiring…"; a user's own alert text already names its subject. */
const sentence = (g: DigestGroup, e: DigestEntry) => (e.kind === 'alert' ? e.what : `${displayName(g)} ${e.what}`);

export function renderDigest(digest: Digest, opts: { publicUrl: string; workspaceName: string }) {
  const tableUrl = (g: DigestGroup) => (g.tableId ? `${opts.publicUrl}/tables/${g.tableId}` : undefined);
  const top = digest.groups.flatMap((g) => g.entries.filter((e) => e.tier === 'top').map((e) => ({ g, e })));
  const minor = digest.groups.flatMap((g) => g.entries.filter((e) => e.tier === 'minor').map((e) => ({ g, e })));
  const first = top[0] ?? minor[0];
  const rest = top.length + minor.length - 1;
  const subject = first
    ? sentence(first.g, first.e).replace(/\s+/g, ' ').slice(0, 110) + (rest > 0 ? `, plus ${rest} more` : '')
    : 'Nothing changed today';
  const skippedLine = digest.skipped
    ? `Kinetic also skipped ${digest.skipped} change${digest.skipped === 1 ? '' : 's'} that looked like noise (${Object.entries(digest.skippedReasons).map(([r, n]) => `${n} ${r}`).join(', ')}).`
    : '';

  const intro = top.length
    ? `${top.length === 1 ? '1 company' : `${top.length} companies`} did something worth a look.`
    : `Nothing urgent, but ${minor.length === 1 ? '1 thing' : `${minor.length} things`} changed at your prospects.`;
  const t: string[] = [intro, ''];
  if (top.length) t.push('WORTH A LOOK', '');
  top.forEach(({ g, e }, i) => {
    t.push(`${i + 1}. ${e.kind === 'alert' ? e.what : `${displayName(g)}${g.domain ? ` (${g.domain})` : ''} ${e.what}`}`);
    for (const d of e.details) t.push(`   ${d}`);
    if (e.why) t.push(`   Why it matters: ${e.why}`);
    const links = [e.link, tableUrl(g)].filter(Boolean);
    if (links.length) t.push(`   ${links.join('  ·  ')}`);
    t.push('');
  });
  if (minor.length) {
    t.push('ALSO CHANGED', '');
    for (const { g, e } of minor) t.push(`• ${sentence(g, e)}${e.details.length ? `: ${e.details.join(' ')}` : ''}`);
    t.push('');
  }
  if (skippedLine) t.push(skippedLine, '');
  t.push(`Sent once a day by Kinetic (${opts.workspaceName}) because no Slack or ntfy is set up for alerts. Add one under Integrations to get alerts there as they happen.`);

  const a = (href: string | undefined, label: string) => (href ? `<a href="${escapeHtml(href)}" style="color:#2563eb;text-decoration:none">${label}</a>` : '');
  const h: string[] = [`<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:600px">`,
    `<p>${escapeHtml(intro)}</p>`];
  if (top.length) h.push(`<h3 style="font-size:13px;letter-spacing:.06em;color:#64748b;margin:24px 0 8px">WORTH A LOOK</h3>`);
  for (const { g, e } of top) {
    h.push(`<div style="margin:0 0 18px"><div>${e.kind === 'alert' ? escapeHtml(e.what) : `<b>${escapeHtml(displayName(g))}</b>${g.domain ? ` <span style="color:#64748b">${escapeHtml(g.domain)}</span>` : ''} ${escapeHtml(e.what)}`}</div>`);
    for (const d of e.details) h.push(`<div style="color:#334155;font-size:14px">${escapeHtml(d)}</div>`);
    if (e.why) h.push(`<div style="color:#475569;font-size:14px;margin-top:2px"><i>Why it matters:</i> ${escapeHtml(e.why)}</div>`);
    const links = [a(e.link, 'Read more'), a(tableUrl(g), 'Open in Kinetic')].filter(Boolean);
    if (links.length) h.push(`<div style="font-size:14px;margin-top:2px">${links.join(' &nbsp;·&nbsp; ')}</div>`);
    h.push('</div>');
  }
  if (minor.length) {
    h.push(`<h3 style="font-size:13px;letter-spacing:.06em;color:#64748b;margin:24px 0 8px">ALSO CHANGED</h3><ul style="padding-left:18px;margin:0;color:#334155;font-size:14px">`);
    for (const { g, e } of minor) h.push(`<li style="margin-bottom:4px">${e.kind === 'alert' ? escapeHtml(e.what) : `<b>${escapeHtml(displayName(g))}</b> ${escapeHtml(e.what)}`}${e.details.length ? `: ${escapeHtml(e.details.join(' '))}` : ''}</li>`);
    h.push('</ul>');
  }
  if (skippedLine) h.push(`<p style="color:#64748b;font-size:13px;margin-top:24px">${escapeHtml(skippedLine)}</p>`);
  h.push(`<p style="color:#94a3b8;font-size:12px;margin-top:24px">Sent once a day by Kinetic (${escapeHtml(opts.workspaceName)}) because no Slack or ntfy is set up for alerts. Add one under Integrations to get alerts there as they happen.</p></div>`);
  return { subject, text: t.join('\n'), html: h.join('\n') };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const validZone = (tz?: string | null) => { try { return !!tz && !!new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return false; } };

/** ALERT_DIGEST_TIMEZONE (Integrations), else the zone most of the workspace's campaigns send in, else UTC. */
export function workspaceTimeZone(ctx: Ctx, workspaceId: number): string {
  const set = (ctx.gtm?.settings ?? new Settings(ctx.db)).get('ALERT_DIGEST_TIMEZONE')?.trim();
  if (validZone(set)) return set!;
  const r = ctx.db.get<{ tz: string }>(`SELECT schedule_timezone tz FROM campaigns WHERE workspace_id = ? GROUP BY schedule_timezone ORDER BY COUNT(*) DESC LIMIT 1`, [workspaceId]);
  return validZone(r?.tz) ? r!.tz : 'UTC';
}

export function localDayHour(now: Date, timeZone: string): { day: string; hour: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function alertRecipients(ctx: Ctx, workspaceId: number): string[] {
  return ctx.db.all<{ email: string }>(`SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'admin' ORDER BY u.id`, [workspaceId]).map((u) => u.email);
}

/** A connected mailbox to send alerts from, preferring one no active campaign is sending from. */
export function alertSender(ctx: Ctx, workspaceId: number): Row | undefined {
  return ctx.db.get(`SELECT s.* FROM sender_emails s WHERE s.workspace_id = ? AND s.status = 'Connected'
    ORDER BY EXISTS (SELECT 1 FROM campaign_sender_emails cs JOIN campaigns c ON c.id = cs.campaign_id WHERE cs.sender_email_id = s.id AND c.status = 'active'), s.id LIMIT 1`, [workspaceId]);
}

/** Worker job: send each workspace's digest once a day, as soon as its queue has settled. */
export async function runAlertDigests(ctx: Ctx, opts: { useAi?: boolean } = {}) {
  const now = ctx.now();
  const pending = ctx.db.all<{ workspace_id: number; last: string }>('SELECT workspace_id, MAX(created_at) last FROM alert_digest_items WHERE digest_day IS NULL GROUP BY workspace_id');
  for (const { workspace_id: ws, last } of pending) {
    if (now.getTime() - Date.parse(last) < SETTLE_MS) continue;
    const { day } = localDayHour(now, workspaceTimeZone(ctx, ws));
    if (ctx.db.get('SELECT 1 FROM alert_digest_runs WHERE workspace_id = ? AND day = ?', [ws, day])) continue;
    await sendDigest(ctx, ws, day, opts).catch((err) => ctx.log.warn({ err, workspaceId: ws }, 'alert digest failed'));
  }
}

export async function sendDigest(ctx: Ctx, workspaceId: number, day: string, opts: { useAi?: boolean } = {}) {
  const rows = ctx.db.all<{ id: number; item: string }>('SELECT id, item FROM alert_digest_items WHERE workspace_id = ? AND digest_day IS NULL ORDER BY id', [workspaceId]);
  if (!rows.length) return null;
  const ws = ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
  const digest = buildDigest(rows.map((r) => ({ id: r.id, item: JSON.parse(r.item) })), ctx.now());
  if (opts.useAi !== false) await refineWithAi(ctx, digest, ws?.name ?? 'Kinetic');
  const mail = renderDigest(digest, { publicUrl: ctx.config.publicUrl ?? '', workspaceName: ws?.name ?? 'Kinetic' });
  const record = (status: string, error?: string) => {
    ctx.db.tx(() => {
      ctx.db.run(`INSERT OR REPLACE INTO alert_digest_runs (workspace_id, day, status, subject, items, worth_a_look, also_changed, skipped, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [workspaceId, day, status, status === 'sent' ? mail.subject : null, rows.length, digest.top, digest.minor, digest.skipped, error ?? null, ctx.now().toISOString()]);
      ctx.db.run(`UPDATE alert_digest_items SET digest_day = ? WHERE id IN (${rows.map(() => '?').join(',')})`, [day, ...rows.map((r) => r.id)]);
    });
  };
  if (!digest.top && !digest.minor) { record('quiet'); return { status: 'quiet' as const, digest, mail }; }
  const to = alertRecipients(ctx, workspaceId);
  const sender = alertSender(ctx, workspaceId);
  if (!to.length || !sender) { record('failed', 'No admin or connected mailbox to send from'); return { status: 'failed' as const, digest, mail }; }
  try {
    await ctx.mail.send(sender, {
      from: { name: 'Kinetic', email: sender.email }, to: to.join(', '), subject: mail.subject, text: mail.text, html: mail.html,
      messageId: `${randomUUID()}@${domainOf(sender.email)}`,
    });
  } catch (e: any) { record('failed', String(e.message ?? e).slice(0, 500)); throw e; }
  record('sent');
  return { status: 'sent' as const, digest, mail };
}
