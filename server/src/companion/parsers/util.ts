/** Small defensive helpers shared by the pure parsers (no Node imports: the extension bundles these). */
import type { Rec, Site } from '../protocol.ts';

export type Any = any;

export const isObj = (v: unknown): v is Record<string, Any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const arr = (v: unknown): Any[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
export const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Safe deep get: get(o, 'a.b.0.c'). */
export function get(o: unknown, path: string): Any {
  let cur: Any = o;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** First non-empty string among candidate values. */
export function first(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return '';
}

/** Parses JSON strings; passes objects through; returns null on garbage. */
export function asJson(raw: unknown): Any {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    // Some endpoints prefix with "for (;;);" (Facebook) or ")]}'" anti-hijacking guards.
    const cleaned = t.replace(/^for\s*\(;;\);\s*/, '').replace(/^\)\]\}',?\s*/, '');
    try { return JSON.parse(cleaned); } catch {
      // Facebook streams several JSON documents separated by newlines.
      const docs: Any[] = [];
      for (const line of cleaned.split(/\n/)) { try { docs.push(JSON.parse(line)); } catch { /* skip */ } }
      return docs.length ? docs : null;
    }
  }
  return raw ?? null;
}

/** Walks every object in a JSON tree (depth-first), calling fn; bounded for safety. */
export function walk(root: unknown, fn: (o: Record<string, Any>) => void, limit = 200_000) {
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  let n = 0;
  while (stack.length && n < limit) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    n++;
    if (Array.isArray(cur)) { for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]); continue; }
    fn(cur as Record<string, Any>);
    const vals = Object.values(cur as object);
    for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
  }
}

/** ISO string from epoch ms/seconds or a date string; '' when unknown. */
export function iso(v: unknown): string {
  if (v == null || v === '') return '';
  let d: Date;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === 'string' && /^\d+$/.test(v)) { const n = Number(v); d = new Date(n < 1e12 ? n * 1000 : n); }
  else d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Removes empty values so table rows stay tidy. */
export function clean(r: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Dedupe records by a key function, keeping the first. */
export function uniqBy(records: Rec[], key: (r: Rec) => string): Rec[] {
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const r of records) {
    const k = key(r);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(r);
  }
  return out;
}

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : '' };
}

/** Basic HTML entity decoding for regex-based HTML fallbacks. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "1st" / "2nd" / "3rd" from LinkedIn distance values (DISTANCE_1, "• 2nd", 2…). */
export function degree(v: unknown): string {
  const s = str(v);
  if (!s && typeof v !== 'number') return '';
  const m = /(?:DISTANCE_)?([123])/.exec(String(v));
  if (!m) return /OUT_OF_NETWORK|3\+/i.test(s) ? '3rd' : '';
  return ({ 1: '1st', 2: '2nd', 3: '3rd' } as Record<string, string>)[m[1]];
}

// ---- URL helpers -------------------------------------------------------------------

function tryUrl(u: string): URL | null {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, '')}`); } catch { return null; }
}

export function linkedinProfileUrl(publicIdOrUrl: string): string {
  const s = str(publicIdOrUrl);
  if (!s) return '';
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(s);
  const id = m ? m[1] : (/^[\w%.-]+$/.test(s) ? s : '');
  if (!id) return s;
  let decoded = id;
  try { decoded = decodeURIComponent(id); } catch { /* keep */ }
  return `https://www.linkedin.com/in/${encodeURIComponent(decoded).replace(/%2D/gi, '-')}/`;
}

export function linkedinCompanyUrl(slugOrUrl: string): string {
  const s = str(slugOrUrl);
  if (!s) return '';
  const m = /linkedin\.com\/(company|school|showcase)\/([^/?#]+)/i.exec(s);
  if (m) return `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}/`;
  return /^[\w%.-]+$/.test(s) ? `https://www.linkedin.com/company/${s}/` : s;
}

/** Canonical URL used for dedupe across scrapes. */
export function normalizeUrl(site: Site, url: string): string {
  const raw = str(url);
  if (!raw) return '';
  if (site === 'linkedin') {
    if (/linkedin\.com\/in\//i.test(raw)) return linkedinProfileUrl(raw).toLowerCase();
    if (/linkedin\.com\/(company|school|showcase)\//i.test(raw)) return linkedinCompanyUrl(raw).toLowerCase();
    const urn = linkedinActivityUrn(raw);
    if (urn) return `https://www.linkedin.com/feed/update/${urn}/`;
  }
  const u = tryUrl(raw);
  if (!u) return raw.toLowerCase();
  let host = u.hostname.toLowerCase().replace(/^(m|mobile|old|np|mbasic|web|www)\./, '');
  if (site === 'x') host = host.replace(/^twitter\.com$/, 'x.com');
  else if (site !== 'github' && host.split('.').length === 2) host = `www.${host}`;
  let path = u.pathname.replace(/\/+$/, '');
  if (site === 'facebook' && /profile\.php$/.test(path) && u.searchParams.get('id')) return `https://${host}${path}?id=${u.searchParams.get('id')}`;
  if (site === 'instagram' || site === 'x' || site === 'reddit' || site === 'github') path = path.toLowerCase();
  if (site === 'x') { const m = /^\/[^/]+\/status\/(\d+)/.exec(path); if (m) path = path.slice(0, m[0].length); }
  return `https://${host}${path}${site === 'x' || site === 'github' ? '' : '/'}`;
}

export function linkedinActivityUrn(postUrl: string): string | null {
  const s = str(postUrl);
  if (!s) return null;
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { /* keep */ }
  let m = /urn:li:(activity|share|ugcPost):(\d+)/.exec(decoded);
  if (m) return m[1] === 'activity' ? `urn:li:activity:${m[2]}` : `urn:li:${m[1]}:${m[2]}`;
  m = /activity[-:](\d{15,22})/.exec(decoded);
  if (m) return `urn:li:activity:${m[1]}`;
  return null;
}

export function igShortcode(url: string): string | null {
  const m = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(str(url));
  return m ? m[1] : null;
}

export function tweetId(url: string): string | null {
  const m = /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i.exec(str(url));
  return m ? m[1] : (/^\d{5,25}$/.test(str(url)) ? str(url) : null);
}

export function redditPostId(url: string): string | null {
  const s = str(url);
  let m = /reddit\.com\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i.exec(s);
  if (m) return m[1].toLowerCase();
  m = /redd\.it\/([a-z0-9]+)/i.exec(s);
  if (m) return m[1].toLowerCase();
  m = /^t3_([a-z0-9]+)$/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export function githubRepo(input: string): { owner: string; repo: string } | null {
  const s = str(input).replace(/\.git$/, '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+)/i.exec(s) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function instagramProfileUrl(username: string): string {
  return username ? `https://www.instagram.com/${username}/` : '';
}
export function xProfileUrl(username: string): string {
  return username ? `https://x.com/${username}` : '';
}
