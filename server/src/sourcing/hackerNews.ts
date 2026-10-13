/**
 * Hacker News as a lead source (free Algolia HN API, no key):
 *  - launches: Show HN / Launch HN posts → the company behind the link
 *  - hiring:   companies posting in the monthly "Who is hiring?" thread
 *  - intent:   Ask HN posts and comments asking for a tool / alternatives / recommendations
 */
import { getJson } from '../gtm/lib/http.ts';
import { decode, htmlToText } from '../gtm/lib/html.ts';
import { ownDomain } from './normalize.ts';

const API = 'https://hn.algolia.com/api/v1';
const HN = 'https://news.ycombinator.com';
export type HnMode = 'launches' | 'hiring' | 'intent';
export const HN_MODES: HnMode[] = ['launches', 'hiring', 'intent'];

/** Phrases that mean "I'm shopping for something" (matched case-insensitively). */
export const INTENT_PHRASES = ['looking for', 'alternative to', 'alternatives to', 'recommend', 'what do you use for', 'switching from', 'replacement for'];
// Links on HN that are not the poster's own company site.
const NOT_COMPANY = /(^|\.)(github\.com|gitlab\.com|github\.io|ycombinator\.com|apple\.com|google\.com|medium\.com|substack\.com|youtu\.be|arxiv\.org|producthunt\.com|notion\.site|vercel\.app|netlify\.app|herokuapp\.com|pages\.dev)$/i;

export interface HnParams { mode?: HnMode; keywords?: string | string[]; query?: string; days?: number | string; months?: number | string; phrases?: string | string[]; min_points?: number | string }

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\n,]+/)).map((x) => x.trim()).filter(Boolean);
const user = (a: string) => `${HN}/user?id=${encodeURIComponent(a)}`;
const item = (id: string | number) => `${HN}/item?id=${id}`;
const companyDomain = (url: unknown) => { const d = ownDomain(url); return d && !NOT_COMPANY.test(d) ? d : ''; };
/** HN comment HTML → text with line breaks kept. */
export const hnText = (html: string) => htmlToText(String(html ?? '').replace(/<p>/gi, '\n'));

export async function hackerNewsSearch(p: HnParams, limit: number, log: (m: string) => void = () => {}): Promise<Record<string, unknown>[]> {
  const mode = p.mode ?? 'launches';
  const keywords = list(p.keywords ?? p.query);
  if (mode === 'hiring') return hiring(keywords, Number(p.months) || 1, limit, log);
  const since = Math.floor((Date.now() - (Number(p.days) || 30) * 86_400_000) / 1000);
  if (mode === 'intent') return intent(keywords, p.phrases ? list(p.phrases) : INTENT_PHRASES, since, limit, log);
  return launches(keywords, since, Number(p.min_points) || 0, limit, log);
}

async function search(params: Record<string, string | number>, pages: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < pages; page++) {
    const d = await getJson(`${API}/search_by_date`, { query: { ...params, page, hitsPerPage: params.hitsPerPage ?? 100 } });
    out.push(...(d.hits ?? []));
    if (page + 1 >= (d.nbPages ?? 1)) break;
  }
  return out;
}

// ---------- Show HN / Launch HN ----------
async function launches(keywords: string[], since: number, minPoints: number, limit: number, log: (m: string) => void) {
  const rows = new Map<string, Record<string, unknown>>();
  const queries = keywords.length ? keywords : [''];
  for (const kw of queries) {
    const numericFilters = `created_at_i>${since}${minPoints ? `,points>=${minPoints}` : ''}`;
    const hits = [
      ...await search({ query: kw, tags: 'show_hn', numericFilters }, 3),
      ...await search({ query: `Launch HN ${kw}`.trim(), tags: 'story', numericFilters }, 2),
    ];
    for (const h of hits) {
      const title = String(h.title ?? '');
      const kind = title.match(/^(Show|Launch) HN\b/i)?.[0];
      if (!kind || rows.has(h.objectID)) continue;
      // "Launch HN: Acme (YC W24) – Payroll for…" → "Acme"
      const pitch = title.replace(/^(Show|Launch) HN\s*[:–-]\s*/i, '');
      const name = pitch.split(/\s+[–—|:-]\s+|\s*\(/)[0].trim();
      // No "Name – pitch" split and a sentence-like title ("I built…"): name it after the domain instead.
      const domain = companyDomain(h.url);
      const company = name !== pitch.trim() || name.split(/\s+/).length <= 4 ? name : domain ? domainName(domain) : '';
      rows.set(h.objectID, {
        Company: company, 'Company domain': domain, Link: h.url ?? '', Title: title, Kind: kind.replace(/\s+/, ' '),
        Author: h.author, 'Author URL': user(h.author), Points: h.points ?? 0, Comments: h.num_comments ?? 0,
        Posted: h.created_at, 'HN URL': item(h.objectID), Keyword: kw,
      });
    }
    if (rows.size >= limit) break;
  }
  log(`Hacker News launches: ${rows.size}`);
  return [...rows.values()].slice(0, limit);
}

// ---------- Who is hiring ----------
const ROLE_RE = /engineer|developer|designer|manager|scientist|\blead\b|head of|director|sales|marketing|founding|analyst|devops|\bsre\b|product|recruit|intern|support|account exec|researcher|architect|full[- ]?stack|frontend|backend|\bml\b|\bai\b/i;
const LOC_RE = /remote|on-?site|hybrid|in-office|relocat|\b(usa|us|uk|eu|europe|emea|apac|nyc|sf|bay area|london|berlin|toronto)\b/i;
const PLACE_RE = /,\s*[A-Z]{2}\b|\b[A-Z][a-z]+,\s*[A-Z]/; // "Austin, TX", "Berlin, Germany"

/** First line of a hiring post: "Acme | Senior Engineer, Designer | Remote (US) | https://acme.com". */
export function parseHiringPost(html: string): { company: string; website: string; domain: string; roles: string; location: string; remote: boolean; text: string } {
  const text = hnText(html);
  const head = text.split('\n')[0] ?? '';
  const parts = head.split(/\s+\|\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const hrefs = [...String(html).matchAll(/href="([^"]+)"/gi)].map((m) => decode(m[1]));
  const urlPart = parts.find((s) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s));
  const candidates = [urlPart, ...hrefs].filter(Boolean) as string[];
  const website = candidates.find((u) => companyDomain(u)) ?? '';
  const rest = parts.slice(1).filter((s) => s !== urlPart);
  const roles = rest.filter((s) => ROLE_RE.test(s) && !/^https?:/i.test(s));
  const location = rest.filter((s) => (LOC_RE.test(s) || PLACE_RE.test(s)) && !roles.includes(s));
  return {
    company: parts[0]?.replace(/\s*\(.*\)$/, '') ?? '', website, domain: companyDomain(website),
    roles: roles.join(' | '), location: location.join(' | '), remote: /remote/i.test(head), text,
  };
}

async function hiring(keywords: string[], months: number, limit: number, log: (m: string) => void) {
  const threads = (await search({ query: 'Ask HN: Who is hiring?', tags: 'story,author_whoishiring', hitsPerPage: 20 }, 1))
    .filter((h) => /who is hiring/i.test(h.title ?? '')).slice(0, Math.max(1, months));
  const rows = new Map<string, Record<string, unknown>>();
  for (const t of threads) {
    for (const kw of keywords.length ? keywords : ['']) {
      const hits = await search({ query: kw, tags: `comment,story_${t.objectID}`, hitsPerPage: 200 }, 5);
      for (const h of hits) {
        if (String(h.parent_id) !== String(t.objectID) || !h.comment_text || rows.has(h.objectID)) continue; // top-level posts only
        const p = parseHiringPost(h.comment_text);
        if (!p.company) continue;
        rows.set(h.objectID, {
          Company: p.company, 'Company domain': p.domain, Website: p.website, Roles: p.roles, Location: p.location, Remote: p.remote ? 'yes' : 'no',
          Post: p.text.slice(0, 1500), Author: h.author, 'Author URL': user(h.author), Thread: t.title, Posted: h.created_at, 'HN URL': item(h.objectID), Keyword: kw,
        });
        if (rows.size >= limit) break;
      }
      if (rows.size >= limit) break;
    }
  }
  log(`Hacker News hiring (${threads.map((t) => t.title).join(', ')}): ${rows.size}`);
  return [...rows.values()].slice(0, limit);
}

// ---------- buyer intent (Ask HN + comments) ----------
function near(text: string, a: string, b: string, within: number): boolean {
  for (let i = text.indexOf(a); i !== -1; i = text.indexOf(a, i + 1)) {
    const j = text.indexOf(b, Math.max(0, i - within));
    if (j !== -1 && j <= i + a.length + within) return true;
  }
  return false;
}
const domainName = (d: string) => { const l = d.split('.')[0]; return l.charAt(0).toUpperCase() + l.slice(1); };

async function intent(keywords: string[], phrases: string[], since: number, limit: number, log: (m: string) => void) {
  if (!keywords.length) throw new Error('Give keywords for Hacker News buyer intent, e.g. "crm, helpdesk"');
  const lower = phrases.map((s) => s.toLowerCase());
  const rows = new Map<string, Record<string, unknown>>();
  for (const kw of keywords) {
    // Search each phrase with the keyword ("recommend crm"), then keep hits where they sit close together.
    const hits = (await Promise.all(phrases.map((ph) => search({ query: `${ph} ${kw}`, tags: '(comment,ask_hn)', numericFilters: `created_at_i>${since}` }, 1)))).flat();
    for (const h of hits) {
      const text = h.comment_text ? hnText(h.comment_text) : [h.title, h.story_text ? hnText(h.story_text) : ''].filter(Boolean).join('\n');
      const low = text.toLowerCase();
      // The keyword must sit near the buying phrase ("looking for a CRM"), not anywhere in a long comment.
      const phrase = lower.find((ph) => near(low, ph, kw.toLowerCase(), 150));
      if (!phrase || rows.has(h.objectID)) continue;
      rows.set(h.objectID, {
        Author: h.author, 'Author URL': user(h.author), Text: text.slice(0, 1000), Phrase: phrase, Keyword: kw,
        Thread: h.story_title ?? h.title ?? '', Points: h.points ?? '', Posted: h.created_at, 'HN URL': item(h.objectID),
      });
    }
    if (rows.size >= limit) break;
  }
  log(`Hacker News buyer intent: ${rows.size}`);
  return [...rows.values()].slice(0, limit);
}
