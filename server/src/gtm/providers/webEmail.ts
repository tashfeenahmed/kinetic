/**
 * Web-search email finding: look for the person's address on the open web —
 * directories, press releases, PDFs, other businesses they run — not just the
 * company website. Runs through the configured search engines (SearXNG first,
 * so it's free), reads the top result pages, and:
 *  1. returns the person's own address at the company domain when it's public
 *     (checked with SMTP so dead addresses are skipped),
 *  2. otherwise learns the company's pattern from other named addresses on the
 *     domain and tests that candidate with SMTP,
 *  3. keeps other addresses that clearly belong to the person (another company,
 *     a personal mailbox) and the company's generic inboxes in `data`.
 */
import { fetchPage, htmlToText } from '../lib/html.ts';
import { toDomain } from '../lib/sandbox.ts';
import { smtpOptions, smtpVerify } from '../lib/smtp.ts';
import { inferPattern, PATTERNS } from './freeEmail.ts';
import { webSearch } from './search.ts';
import { nameParts, type Ctx, type EnrichInput, type Hit } from './types.ts';

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const GENERIC = /^(info|hello|hi|contact|enquiries|enquiry|support|help|sales|team|office|admin|accounts|bookings|reservations|orders|press|media|jobs|careers|privacy|legal|billing|noreply|no-reply|webmaster|marketing|service|reception)$/;
/** Sites that block fetching or never show emails; their search snippets are still used. */
const SKIP_FETCH = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|google\.[a-z.]+)$/;
const JUNK_DOMAINS = /(^|\.)(example\.(com|org)|sentry\.io|wixpress\.com|domain\.com|email\.com|yourdomain\.com|png|jpg|jpeg|gif|webp|svg)$/;
const MAX_PAGES = 6;

export interface WebEmail { email: string; source: string; nearName: boolean }

export async function webSearchEmailFinder(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const domain = toDomain(input.domain);
  const { first, last, full } = nameParts(input);
  if (!domain || !first || !last) return null;
  const f = slug(first), l = slug(last);
  const company = (input.companyName ?? '').trim();

  const found = await collect([
    `"${full}" "@${domain}"`,
    `"@${domain}"`,
    `"${full}" ${company ? `"${company}"` : domain} email`,
    `"${full}" email contact`,
  ], full, ctx);
  if (!found.length) return null;

  const atDomain = found.filter((e) => e.email.endsWith(`@${domain}`));
  const isPerson = (e: WebEmail) => looksLike(e.email.split('@')[0], f, l);
  const own = atDomain.filter(isPerson).sort((a, b) => Number(b.nearName) - Number(a.nearName));
  const generic = [...new Set(atDomain.filter((e) => GENERIC.test(e.email.split('@')[0])).map((e) => e.email))];
  // Elsewhere the surname must be in the mailbox: "peter@" on some other site is too likely someone else.
  const elsewhere = dedupe(found.filter((e) => !e.email.endsWith(`@${domain}`) && isPerson(e) && e.nearName && slug(e.email.split('@')[0]!).includes(l)));
  const samples = atDomain.filter((e) => !GENERIC.test(e.email.split('@')[0]));
  const data = {
    sources: dedupe(own).slice(0, 3).map((e) => e.source),
    other_emails: elsewhere.slice(0, 5).map((e) => e.email),
    other_sources: elsewhere.slice(0, 5).map((e) => e.source),
    company_emails: generic.slice(0, 5),
    domain_samples: dedupe(samples).slice(0, 10).map((e) => e.email),
  };

  // 1. The person's own work address is public somewhere.
  for (const hit of dedupe(own).slice(0, 2)) {
    const r = await smtpVerify(hit.email, smtpOptions(ctx.settings));
    if (r.verdict === 'invalid') continue;
    const checked = r.verdict === 'valid' ? 'verified (SMTP)' : r.verdict === 'catch_all' ? 'catch-all domain' : 'unverifiable';
    return { value: hit.email, confidence: `found on the web · ${checked}`, data: { ...data, source: hit.source, smtp: r.verdict, mailProvider: r.mailProvider } };
  }

  // 2. Learn the pattern from other named addresses on the domain.
  const named = nameSamples(samples);
  const inferred = inferPattern(named);
  if (inferred) {
    const email = `${PATTERNS[inferred.pattern]!(f, l)}@${domain}`;
    const r = await smtpVerify(email, smtpOptions(ctx.settings));
    if (r.verdict === 'valid') return { value: email, confidence: `verified (SMTP) · pattern ${inferred.pattern} from ${inferred.support} address(es) on the web`, data: { ...data, pattern: inferred.pattern, smtp: r.verdict } };
    if (r.verdict !== 'invalid') return { value: email, weak: true, confidence: `pattern ${inferred.pattern} from ${inferred.support} address(es) on the web · ${r.verdict === 'catch_all' ? 'catch-all domain' : 'unverifiable'}`, data: { ...data, pattern: inferred.pattern, smtp: r.verdict } };
  }

  // 3. Nothing at the company domain, but the person's address on another site.
  if (elsewhere.length) return { value: elsewhere[0]!.email, weak: true, confidence: `found on the web · different domain (${elsewhere[0]!.email.split('@')[1]})`, data: { ...data, source: elsewhere[0]!.source } };
  return null;
}

/** Runs the searches, reads snippets and the top pages, and returns every address seen. */
async function collect(queries: string[], fullName: string, ctx: Ctx): Promise<WebEmail[]> {
  const out: WebEmail[] = [];
  const urls: string[] = [];
  const nameRe = new RegExp(fullName.split(/\s+/).map(escape).join('\\W+'), 'i');
  const scan = (text: string, source: string) => {
    for (const m of text.matchAll(EMAIL)) {
      const email = m[0].toLowerCase().replace(/\.+$/, '');
      if (JUNK_DOMAINS.test(email.split('@')[1]!)) continue;
      const near = text.slice(Math.max(0, m.index! - 160), m.index! + email.length + 160);
      out.push({ email, source, nearName: nameRe.test(near) });
    }
  };
  for (const q of queries) {
    try {
      const { results } = await webSearch(q, ctx, 8, { emptyIsAnswer: true });
      for (const r of results) {
        scan(`${r.title} ${r.snippet}`, r.url);
        const host = safeHost(r.url);
        if (host && !SKIP_FETCH.test(host) && !urls.includes(r.url)) urls.push(r.url);
      }
    } catch (e) {
      ctx.log(`web email search failed for ${q}: ${(e as Error).message}`);
    }
  }
  await Promise.all(urls.slice(0, MAX_PAGES).map(async (url) => {
    const page = await fetchPage(url, 10_000).catch(() => null);
    if (!page || page.status >= 400) return;
    // mailto: links carry addresses that the visible text may obfuscate.
    scan(`${htmlToText(page.html)} ${[...page.html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => decodeURIComponent(m[1]!)).join(' ')}`, url);
  }));
  ctx.log(`web email search: ${out.length} address(es) from ${urls.length} result page(s)`);
  return out;
}

/** first.last / first_last / first-last addresses spell out the owner's name, which is enough to vote on the pattern. */
function nameSamples(samples: WebEmail[]) {
  const named: { email: string; name?: string; source: string }[] = [];
  for (const s of dedupe(samples)) {
    const local = s.email.split('@')[0]!;
    const parts = local.split(/[._-]/).filter((p) => /^[a-z]{2,}$/.test(p));
    if (parts.length === 2) named.push({ email: s.email, name: `${parts[0]} ${parts[1]}`, source: s.source });
  }
  return named;
}

/** Whether a mailbox name plausibly belongs to first/last (j.smith, john, jsmith, john.smith…). */
export function looksLike(local: string, f: string, l: string): boolean {
  const s = local.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return false;
  return Object.values(PATTERNS).some((p) => p(f, l).replace(/[^a-z]/g, '') === s) && (s.includes(l) || s === f);
}

function dedupe(list: WebEmail[]): WebEmail[] {
  const seen = new Map<string, WebEmail>();
  for (const e of list) { const prev = seen.get(e.email); if (!prev || (!prev.nearName && e.nearName)) seen.set(e.email, e); }
  return [...seen.values()];
}
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeHost = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
