/** Facebook parsers: GraphQL JSON captured from the page (best effort) and page HTML basics. */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, asJson, clean, decodeEntities, first, get, isObj, num, str, stripTags, uniqBy, walk } from './util.ts';

function fbUrl(u: Any): string {
  const url = first(u.url, u.profile_url, u.uri);
  if (url && /facebook\.com/.test(url)) {
    const u = url.replace(/^https?:\/\/(m|web|mbasic)\./, 'https://www.');
    if (/profile\.php/.test(u)) {
      const id = /[?&]id=(\d+)/.exec(u)?.[1];
      return id ? `https://www.facebook.com/profile.php?id=${id}` : u;
    }
    return u.replace(/[?#].*$/, '');
  }
  const id = str(u.id);
  return /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : '';
}

/** Group members / event guests: objects with __typename User. */
export function parseMembers(raw: unknown): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  let cursor: string | null = null;
  walk(root, (o) => {
    const node = isObj(o.node) && o.node.__typename === 'User' ? o.node : null;
    if (node && node.name) {
      records.push(clean({
        name: str(node.name), profileUrl: fbUrl(node), id: str(node.id),
        bio: first(get(o, 'bio_text.text'), get(node, 'bio_text.text')),
        joined: first(get(o, 'join_status_text.text'), get(o, 'membership_text.text'), get(o, 'rsvp_status'), get(node, 'join_status_text.text')),
      }));
      return;
    }
    if (o.__typename === 'User' && o.name && (o.url || o.profile_url || o.id)) {
      records.push(clean({ name: str(o.name), profileUrl: fbUrl(o), id: str(o.id), bio: str(get(o, 'bio_text.text')) }));
    }
    if (isObj(o.page_info) && o.page_info.has_next_page && o.page_info.end_cursor) cursor = str(o.page_info.end_cursor);
  });
  const recs = uniqBy(records.filter((r) => r.profileUrl || r.id), (r) => str(r.id) || str(r.profileUrl));
  return { records: recs, nextCursor: recs.length ? cursor : null };
}

const meta = (html: string, prop: string) => {
  const re = new RegExp(`<meta[^>]*(?:property|name)="${prop}"[^>]*content="([^"]*)"`, 'i');
  const re2 = new RegExp(`<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="${prop}"`, 'i');
  const m = re.exec(html) ?? re2.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
};

/** Count like "12K" / "1.2M" / "3,456". */
function count(s: string): number | undefined {
  const m = /([\d.,]+)\s*([KkMm])?/.exec(s);
  if (!m) return undefined;
  let n = Number(m[1].replace(/,/g, ''));
  if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** A page or profile: from GraphQL JSON (Page/User objects) or the page HTML (meta tags). */
export function parsePage(raw: unknown, ctx: { url?: string } = {}): ParseResult {
  if (typeof raw === 'string' && /^\s*</.test(raw)) {
    const html = raw;
    const name = meta(html, 'og:title') || stripTags(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s*\|\s*Facebook$/, '');
    if (!name) return { records: [] };
    const desc = meta(html, 'og:description') || meta(html, 'description');
    const likes = /([\d.,]+\s*[KkMm]?)\s+likes/i.exec(desc)?.[1];
    const followers = /([\d.,]+\s*[KkMm]?)\s+followers/i.exec(desc)?.[1];
    const email = /mailto:([^"'?\s<]+)/i.exec(html)?.[1] ?? '';
    return {
      records: [clean({
        name, profileUrl: meta(html, 'og:url') || ctx.url || '',
        likes: likes ? count(likes) : undefined, followers: followers ? count(followers) : undefined,
        bio: desc.replace(/^.*?(?:talking about this|followers)\.\s*/i, '').trim() || desc,
        email: decodeEntities(email),
      })],
    };
  }
  const root = asJson(raw);
  let best: Rec | null = null;
  walk(root, (o) => {
    if (best || !(o.__typename === 'Page' || o.__typename === 'User') || !o.name) return;
    best = clean({
      name: str(o.name), profileUrl: fbUrl(o) || ctx.url || '',
      category: first(o.category_name, get(o, 'category_type'), get(o, 'page_category.name')),
      likes: num(o.page_likers?.global_likers_count) ?? num(get(o, 'likers.count')) ?? undefined,
      followers: num(get(o, 'follower_count')) ?? num(get(o, 'followers.count')) ?? undefined,
      website: first(get(o, 'websites.0'), o.website),
      email: first(get(o, 'email.text'), o.email),
      phone: first(get(o, 'phone_number.text'), o.phone),
      address: first(get(o, 'address.full_address'), get(o, 'single_line_address')),
      bio: first(get(o, 'page_about_fields.blurb'), get(o, 'about.text'), get(o, 'bio_text.text')),
    });
  });
  return { records: best ? [best] : [] };
}
