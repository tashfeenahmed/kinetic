/** Small HTML helpers for page fetching without a browser. */
import { request } from './http.ts';

export interface Page { url: string; status: number; html: string; text: string; title: string; headers: Record<string, string> }

export async function fetchPage(url: string, timeoutMs = 20_000): Promise<Page> {
  const target = url.includes('://') ? url : `https://${url}`;
  const res = await request(target, {
    timeoutMs,
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
  });
  const html = (await res.text()).slice(0, 3_000_000);
  return {
    url: res.url || target,
    status: res.status,
    html,
    text: htmlToText(html),
    title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''),
    headers: Object.fromEntries(res.headers.entries()),
  };
}

export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function meta(html: string, name: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return decode(tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? '');
}

export function links(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try { out.add(new URL(m[1], base).toString()); } catch { /* ignore */ }
  }
  return [...out];
}

export function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Contact details a page states in machine-readable form: schema.org JSON-LD
 * (telephone, email, url, sameAs) and tel:/mailto: links. Directories often mask
 * a number on screen ("01 286...") while the full one sits in the page data.
 */
export function pageContacts(html: string): { phones: string[]; emails: string[]; websites: string[] } {
  const phones = new Set<string>(), emails = new Set<string>(), websites = new Set<string>();
  const visit = (v: any, depth = 0): void => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    for (const t of [v.telephone].flat()) if (typeof t === 'string' && /\d{5}/.test(t.replace(/\D/g, ''))) phones.add(t.trim());
    for (const e of [v.email].flat()) if (typeof e === 'string' && e.includes('@')) emails.add(e.replace(/^mailto:/i, '').trim().toLowerCase());
    if (typeof v.url === 'string' && /^https?:\/\//.test(v.url) && /Organization|Business|Agent|Store|Corporation|LocalBusiness|Service/i.test(String(v['@type'] ?? ''))) websites.add(v.url);
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') visit(v[k], depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* malformed JSON-LD */ }
  }
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) phones.add(decodeURIComponent(m[1]).trim());
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) emails.add(decodeURIComponent(m[1]).trim().toLowerCase());
  return { phones: [...phones].slice(0, 5), emails: [...emails].slice(0, 5), websites: [...websites].slice(0, 3) };
}

/** Minimal RSS/Atom item parser (Google News, blogs). */
export function parseFeed(xml: string): { title: string; link: string; date: string; source: string }[] {
  const items = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) ?? [];
  return items.map((it) => {
    const tag = (t: string) => decode((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'))?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    const link = tag('link') || it.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || '';
    return { title: tag('title'), link, date: tag('pubDate') || tag('updated') || tag('published'), source: tag('source') };
  });
}
