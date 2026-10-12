/** Reddit public JSON parsers (listings, comment trees, user about/overview). */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, arr, asJson, clean, isObj, iso, num, str, uniqBy } from './util.ts';

const BASE = 'https://www.reddit.com';
export const redditUserUrl = (name: string) => (name && name !== '[deleted]' ? `${BASE}/user/${name}/` : '');

function postRec(d: Any): Rec {
  const permalink = str(d.permalink);
  const link = str(d.url_overridden_by_dest ?? d.url);
  return clean({
    title: str(d.title),
    author: str(d.author),
    authorUrl: redditUserUrl(str(d.author)),
    subreddit: str(d.subreddit),
    postUrl: permalink ? `${BASE}${permalink}` : '',
    url: link && !link.includes(permalink || '@@') && !d.is_self ? link : '',
    score: num(d.score) ?? undefined,
    comments: num(d.num_comments) ?? undefined,
    flair: str(d.link_flair_text),
    text: str(d.selftext).slice(0, 5000),
    createdAt: iso(d.created_utc),
  });
}

/** A listing of posts (subreddit, search). Cursor = listing `after`. */
export function parseListing(raw: unknown): ParseResult {
  const root = asJson(raw);
  const data = root?.data ?? {};
  const records = arr(data.children).filter((c: Any) => c?.kind === 't3' && isObj(c.data)).map((c: Any) => postRec(c.data));
  return { records: uniqBy(records, (r) => str(r.postUrl)), nextCursor: data.after ? str(data.after) : null };
}

/** A post's comment tree: `[postListing, commentListing]`. Flattens replies. */
export function parseComments(raw: unknown, ctx: { postUrl?: string } = {}): ParseResult {
  const root = asJson(raw);
  const docs = Array.isArray(root) ? root : [root];
  const post = arr(docs[0]?.data?.children).find((c: Any) => c?.kind === 't3')?.data;
  const postUrl = post?.permalink ? `${BASE}${post.permalink}` : ctx.postUrl ?? '';
  const records: Rec[] = [];
  const visit = (listing: Any) => {
    for (const c of arr(listing?.data?.children)) {
      if (c?.kind !== 't1' || !isObj(c.data)) continue;
      const d = c.data;
      const author = str(d.author);
      if (author && author !== '[deleted]') {
        records.push(clean({
          author, authorUrl: redditUserUrl(author), text: str(d.body), score: num(d.score) ?? undefined,
          permalink: d.permalink ? `${BASE}${d.permalink}` : '', postUrl, createdAt: iso(d.created_utc),
        }));
      }
      if (isObj(d.replies)) visit(d.replies);
    }
  };
  for (const doc of docs.slice(Array.isArray(root) ? 1 : 0)) visit(doc);
  return { records: uniqBy(records, (r) => str(r.permalink) || `${r.author}|${r.text}`), nextCursor: null };
}

/** A user: `{about, overview}` (or just the about document). One record. */
export function parseUser(raw: unknown): ParseResult {
  const root = asJson(raw);
  const about = root?.about ?? (root?.kind === 't2' ? root : null);
  const d = about?.data ?? {};
  const name = str(d.name);
  if (!name) return { records: [] };
  const items = arr(root?.overview?.data?.children).map((c: Any) => ({ kind: c?.kind, d: c?.data ?? {} }));
  const subCounts = new Map<string, number>();
  for (const it of items) { const s = str(it.d.subreddit); if (s) subCounts.set(s, (subCounts.get(s) ?? 0) + 1); }
  const recentSubreddits = [...subCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => `r/${s}`).join(', ');
  const recentActivity = items.slice(0, 5).map((it) => (it.kind === 't3' ? `Post: ${str(it.d.title)}` : `Comment: ${str(it.d.body).slice(0, 140)}`)).join(' | ');
  return {
    records: [clean({
      username: name,
      profileUrl: redditUserUrl(name),
      linkKarma: num(d.link_karma) ?? undefined,
      commentKarma: num(d.comment_karma) ?? undefined,
      createdAt: iso(d.created_utc),
      bio: str(d.subreddit?.public_description),
      recentSubreddits,
      recentActivity,
    })],
  };
}
