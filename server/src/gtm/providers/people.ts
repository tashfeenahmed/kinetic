/**
 * "Find decision makers + emails" for a company: who to email there, and their address.
 *
 * Waterfall (first hit wins; paid vendors only run when the free step found nobody):
 *  1. ai_read — read the company's own site (team / about / leadership / contact pages)
 *     and web search results with AI, extract the people, then find each person's email
 *     for free: published on a page, or the company's pattern checked with SMTP.
 *  2. Apollo (search free, 1 credit per email) → 3. Hunter domain search →
 *  4. Prospeo search + enrich → 5. People Data Labs person search.
 * Every result records where the person and the email came from (`found_by`,
 * `source_url`, `email_source`) so leads keep their provenance.
 */
import { getJson, HttpError } from '../lib/http.ts';
import { fetchPage, htmlToText, links } from '../lib/html.ts';
import { toDomain } from '../lib/sandbox.ts';
import { smtpOptions, smtpVerify } from '../lib/smtp.ts';
import { runAgent } from '../engine/agent.ts';
import { freeEmailFinder } from './freeEmail.ts';
import { webSearch } from './search.ts';
import { useCredits } from './credits.ts';
import type { Ctx, EnrichInput, Hit } from './types.ts';

export interface Contact {
  name: string; first_name: string; last_name: string; title: string;
  email: string | null; email_status: string; email_source: string;
  linkedin: string | null; source_url: string | null; found_by: string;
}

const DEFAULT_ROLES = ['founder', 'co-founder', 'ceo', 'chief executive', 'owner', 'managing director', 'president', 'general manager', 'principal', 'partner', 'director', 'head of', 'vp', 'chief'];
const PAGE_HINT = /(team|about|leadership|management|people|founder|our-story|who-we-are|staff|board|contact|company)/i;
const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Target roles from the column's "title" input ("CEO, founder"), else sensible defaults. */
export function wantedRoles(input: EnrichInput): string[] {
  const own = String(input.title ?? '').split(/[,;|\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return own.length ? own : DEFAULT_ROLES;
}

/** Lower is better: index of the first wanted role the title contains (99 = no match). */
export function roleRank(title: string, roles: string[]): number {
  const t = ` ${title.toLowerCase()} `;
  const i = roles.findIndex((r) => t.includes(r));
  return i < 0 ? 99 : i;
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.replace(/\s+/g, ' ').trim().split(' ');
  return { first: parts[0] ?? '', last: parts.length > 1 ? parts[parts.length - 1]! : '' };
}

const clean = (s: unknown) => { const v = String(s ?? '').trim(); return !v || v === '-' || /^(n\/a|none|null|unknown)$/i.test(v) ? '' : v; };

/** "Jane Doe | CEO | jane@acme.com | https://linkedin.com/in/jane | https://acme.com/team" → contact. */
export function parsePersonLine(line: string, foundBy: string): Contact | null {
  const [name, title, email, linkedin, url] = String(line).split('|').map(clean);
  if (!name || name.split(' ').length < 2 || /[@/]/.test(name)) return null;
  const { first, last } = splitName(name);
  return {
    name, first_name: first, last_name: last, title: (title ?? '').replace(/\s*\(.*$/, '').trim().slice(0, 80),
    email: email && /@/.test(email) ? email.toLowerCase() : null, email_status: '', email_source: '',
    linkedin: linkedin && /linkedin\.com\//i.test(linkedin) ? linkedin : null, source_url: url && /^https?:\/\//.test(url) ? url : null, found_by: foundBy,
  };
}

/** Pick the best-ranked contact; contacts whose email we know come first within a rank. */
function best(contacts: Contact[], roles: string[]): Contact[] {
  return [...contacts].sort((a, b) => roleRank(a.title, roles) - roleRank(b.title, roles) || Number(!!b.email) - Number(!!a.email));
}

/** A hit from a contact (value = the email, or the name when no email was found). */
function toHit(c: Contact, people: Contact[], weak = false, confidence?: string): Hit {
  return {
    value: c.email ?? c.name,
    confidence: confidence ?? (c.email ? `${c.email_status || 'unverified'} · ${c.email_source}` : 'no email found'),
    weak,
    data: { ...c, full_name: c.name, people: people.slice(0, 10).map((p) => ({ name: p.name, title: p.title, email: p.email, linkedin: p.linkedin, source_url: p.source_url })) },
  };
}

/** Find or check the email for a named person at the domain, for free. */
export async function freeEmailFor(c: Contact, domain: string, ctx: Ctx): Promise<Contact> {
  if (c.email && c.email.endsWith(`@${domain}`)) {
    const r = await smtpVerify(c.email, smtpOptions(ctx.settings)).catch(() => null);
    const status = r?.verdict === 'valid' ? 'verified' : r?.verdict === 'invalid' ? 'invalid' : r?.verdict === 'catch_all' ? 'catch-all' : 'unverified';
    if (status !== 'invalid') return { ...c, email_status: status, email_source: `published on ${c.source_url ?? 'a web page'}` };
  }
  const hit = await freeEmailFinder({ fullName: c.name, domain }, ctx).catch(() => null);
  if (!hit?.value) return { ...c, email: null };
  const verified = /verified/.test(hit.confidence ?? '') && !hit.weak;
  const pattern = (hit.data as any)?.pattern;
  return {
    ...c, email: String(hit.value),
    email_status: verified ? 'verified' : /catch-all/.test(hit.confidence ?? '') ? 'catch-all' : 'unverified',
    email_source: /public/.test(hit.confidence ?? '') ? `public (${(hit.data as any)?.source ?? 'web'})` : `${pattern ? `pattern ${pattern}` : 'common pattern'} + SMTP check`,
  };
}

// ---------- 1. Read the website + web search with AI (free) ----------
async function gatherPages(domain: string): Promise<{ url: string; text: string; emails: string[] }[]> {
  const home = await fetchPage(`https://${domain}`, 12_000).catch(() => null);
  const urls = new Set<string>();
  if (home && home.status < 400) {
    for (const u of links(home.html, home.url)) {
      try { const x = new URL(u); if (x.hostname.replace(/^www\./, '') === domain && PAGE_HINT.test(x.pathname)) urls.add(`${x.origin}${x.pathname}`); } catch { /* skip */ }
    }
  }
  for (const p of ['/about', '/about-us', '/team', '/our-team', '/leadership', '/people', '/contact']) urls.add(`https://${domain}${p}`);
  const pages = await Promise.all([...urls].slice(0, 8).map(async (url) => {
    const pg = await fetchPage(url, 10_000).catch(() => null);
    return pg && pg.status < 400 ? { url: pg.url, html: pg.html } : null;
  }));
  const out: { url: string; text: string; emails: string[] }[] = [];
  const seen = new Set<string>();
  for (const pg of [home && home.status < 400 ? { url: home.url, html: home.html } : null, ...pages]) {
    if (!pg || seen.has(pg.url)) continue;
    seen.add(pg.url);
    const emails = [...new Set([...pg.html.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()).filter((e) => e.endsWith(`@${domain}`)))];
    out.push({ url: pg.url, text: htmlToText(pg.html).slice(0, 6000), emails });
  }
  return out;
}

export async function aiReadContacts(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  if (!ctx.settings.has('OPENROUTER_API_KEY') && !ctx.settings.has('AI_BASE_URL')) { ctx.log('AI read skipped: no AI key'); return null; }
  const company = input.companyName?.trim() || domain;
  const roles = wantedRoles(input);
  const pages = await gatherPages(domain);
  // Plain words, no OR operators (some engines' free tiers reject query syntax).
  const search = await webSearch(`"${company}" ${input.title ? roles.slice(0, 2).join(' ') : 'founder CEO owner director'}`, ctx, 8).catch(() => ({ results: [] as { title: string; url: string; snippet: string }[] }));
  const corpus = [
    ...pages.map((p) => `### Page ${p.url}\n${p.emails.length ? `Emails on page: ${p.emails.join(', ')}\n` : ''}${p.text}`),
    `### Web search results\n${search.results.map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet}`).join('\n')}`,
  ].join('\n\n').slice(0, 30_000);
  const ask = (nudge: string) => runAgent({
    prompt: `Who runs ${company} (${domain}), in these roles: ${roles.join(', ')}?
Below are pages from the company's website and web search results. List the real people the text names as working at, owning, founding or running ${company}, with their job title.
Include founders and owners even when the text doesn't say whether they are still there — list them rather than leaving them out. Never invent names or emails; include an email only if it appears in the text next to that person.
If the text names nobody, search the web and read a page or two (e.g. LinkedIn results, press, Companies House, the CRO register) — no more.${nudge}

${corpus}`,
    outputs: [{ name: 'people', type: 'list', description: 'Each exactly "Full Name | Job title | email or - | LinkedIn URL or - | URL of the page that names them". The job title as written in the source, at most 6 words, no notes or caveats. Most senior first. Max 10.' }],
    webSearch: true, fetchPages: true, maxSteps: 4,
  }, ctx);
  const parse = (out: Record<string, unknown>) => ((out.people as unknown[] | null) ?? []).map((x) => parsePersonLine(String(x), 'ai_read')).filter(Boolean) as Contact[];
  let people = parse((await ask('')).output);
  // Models sometimes play it safe and return nobody; one more pass with a nudge usually finds the owner.
  if (!people.length) people = parse((await ask('\nA first pass found nobody: look harder, e.g. search "<company> owner" or "<company> director" and read the most promising result.')).output);
  ctx.log(`AI read ${domain}: ${people.length} people from ${pages.length} pages`);
  if (!people.length) return null;

  // Free email for the best few: published address, else pattern + SMTP.
  const ranked = best(people, roles).slice(0, 3);
  let fallback: Contact | null = null;
  for (const c of ranked) {
    const withEmail = await freeEmailFor(c, domain, ctx);
    if (withEmail.email && withEmail.email_status === 'verified') return toHit(withEmail, people);
    if (withEmail.email && !fallback) fallback = withEmail;
  }
  // A published or catch-all guess is good enough to keep paid credits; nobody's email at all → let paid vendors try.
  if (fallback) return toHit(fallback, people);
  return toHit(ranked[0]!, people, true);
}

// ---------- 2. Apollo: free people search, 1 credit to reveal the email ----------
export async function apolloContacts(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const roles = wantedRoles(input);
  const headers = { 'x-api-key': ctx.settings.get('APOLLO_API_KEY')!, 'cache-control': 'no-cache' };
  const s = await getJson('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST', headers,
    json: { q_organization_domains_list: [domain], ...(input.title ? { person_titles: roles } : { person_seniorities: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'] }), per_page: 10, page: 1 },
  });
  const found: any[] = s?.people ?? [];
  const pick = [...found].sort((a, b) => roleRank(a.title ?? '', roles) - roleRank(b.title ?? '', roles) || Number(!!b.has_email) - Number(!!a.has_email))[0];
  if (!pick?.id) return null;
  const m = await getJson('https://api.apollo.io/api/v1/people/match', { method: 'POST', headers, query: { id: pick.id, reveal_personal_emails: 'false' } })
    .catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; });
  const p = m?.person;
  if (!p) return null;
  useCredits(ctx.settings.db, 'apollo', 1);
  const email = p.email && !/email_not_unlocked/.test(p.email) ? String(p.email).toLowerCase() : null;
  const c: Contact = {
    name: p.name ?? `${p.first_name} ${p.last_name}`, first_name: p.first_name ?? '', last_name: p.last_name ?? '', title: p.title ?? '',
    email, email_status: p.email_status === 'verified' ? 'verified' : p.email_status ?? '', email_source: 'Apollo',
    linkedin: p.linkedin_url ?? null, source_url: null, found_by: 'apollo',
  };
  return toHit(c, [c], !email);
}

// ---------- 3. Hunter domain search (1 credit per search with results) ----------
export async function hunterContacts(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const roles = wantedRoles(input);
  const d = await getJson('https://api.hunter.io/v2/domain-search', { query: { domain, type: 'personal', limit: 10, api_key: ctx.settings.get('HUNTER_API_KEY')! } });
  const emails: any[] = d?.data?.emails ?? [];
  if (!emails.length) return null;
  useCredits(ctx.settings.db, 'hunter', 1);
  const people: Contact[] = emails.filter((e) => e.first_name && e.last_name).map((e) => ({
    name: `${e.first_name} ${e.last_name}`, first_name: e.first_name, last_name: e.last_name, title: e.position ?? '',
    email: String(e.value).toLowerCase(), email_status: e.verification?.status === 'valid' ? 'verified' : `${e.confidence ?? '?'}% confidence`,
    email_source: `Hunter${e.sources?.[0]?.uri ? ` (seen on ${e.sources[0].uri})` : ''}`, linkedin: e.linkedin ? `https://www.linkedin.com/in/${String(e.linkedin).replace(/^.*\/in\//, '')}` : null,
    source_url: e.sources?.[0]?.uri ?? null, found_by: 'hunter',
  }));
  if (!people.length) return null;
  return toHit(best(people, roles)[0]!, people);
}

// ---------- 4. Prospeo search (1 credit/page) + enrich (1 credit per email) ----------
export async function prospeoContacts(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain) return null;
  const roles = wantedRoles(input);
  const headers = { 'X-KEY': ctx.settings.get('PROSPEO_API_KEY')! };
  const s = await prospeoCall(() => getJson('https://api.prospeo.io/search-person', {
    method: 'POST', headers,
    json: { page: 1, filters: { company: { websites: { include: [domain] } }, person_job_title: { include: roles.slice(0, 10), match_mode: 'CONTAINS' } } },
  })).catch((e) => { if (e instanceof HttpError && /NO_RESULTS|NO_MATCH/i.test(e.message)) return null; throw e; });
  const results: any[] = s?.results ?? [];
  if (!results.length) return null;
  if (!s.free) useCredits(ctx.settings.db, 'prospeo', 1);
  const pick = [...results].sort((a, b) => roleRank(a.person?.current_job_title ?? '', roles) - roleRank(b.person?.current_job_title ?? '', roles))[0]?.person;
  if (!pick?.person_id) return null;
  const e = await prospeoCall(() => getJson('https://api.prospeo.io/enrich-person', { method: 'POST', headers, json: { only_verified_email: true, data: { person_id: pick.person_id } } }))
    .catch((err) => { if (err instanceof HttpError && /NO_MATCH/i.test(err.message)) return null; throw err; });
  const email = e?.person?.email?.email ? String(e.person.email.email).toLowerCase() : null;
  if (email && !e.free_enrichment) useCredits(ctx.settings.db, 'prospeo', 1);
  const c: Contact = {
    name: pick.full_name ?? `${pick.first_name} ${pick.last_name}`, first_name: pick.first_name ?? '', last_name: pick.last_name ?? '', title: pick.current_job_title ?? '',
    email, email_status: email ? 'verified' : '', email_source: 'Prospeo', linkedin: pick.linkedin_url ?? null, source_url: null, found_by: 'prospeo',
  };
  return toHit(c, [c], !email);
}

/** Prospeo's free plan rate-limits back-to-back calls (429): wait a moment and try once more. */
async function prospeoCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 429 || /restricted/i.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, prospeoRetryMs));
    return fn();
  }
}
/** Exposed for tests. */
export let prospeoRetryMs = 4000;
export function setProspeoRetryMs(ms: number) { prospeoRetryMs = ms; }

// ---------- 5. People Data Labs person search (1 credit per record) ----------
export async function pdlContacts(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) return null;
  const roles = wantedRoles(input);
  const d = await getJson('https://api.peopledatalabs.com/v5/person/search', {
    method: 'POST', headers: { 'X-Api-Key': ctx.settings.get('PDL_API_KEY')! },
    json: { sql: `SELECT * FROM person WHERE job_company_website='${domain}' AND job_title_levels IN ('owner','cxo','partner','vp','director')`, size: 3, titlecase: true },
  }).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; });
  const data: any[] = d?.data ?? [];
  if (!data.length) return null;
  useCredits(ctx.settings.db, 'pdl', data.length);
  const people: Contact[] = data.filter((p) => p.full_name).map((p) => ({
    name: p.full_name, first_name: p.first_name ?? splitName(p.full_name).first, last_name: p.last_name ?? splitName(p.full_name).last, title: p.job_title ?? '',
    email: typeof p.work_email === 'string' ? p.work_email.toLowerCase() : null, email_status: typeof p.work_email === 'string' ? 'unverified' : '', email_source: 'People Data Labs',
    linkedin: p.linkedin_url ? `https://${String(p.linkedin_url).replace(/^https?:\/\//, '')}` : null, source_url: null, found_by: 'pdl',
  }));
  if (!people.length) return null;
  const pick = best(people, roles)[0]!;
  if (pick.email) return toHit(pick, people);
  // PDL's free plan hides emails: find the best person's address for free (pattern + SMTP).
  const top = await freeEmailFor(pick, domain, ctx);
  if (top.email) top.email_source = `person from People Data Labs · email by ${top.email_source}`;
  return toHit(top, people, !top.email);
}
