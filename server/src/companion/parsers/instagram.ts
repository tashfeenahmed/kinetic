/** Instagram web API parsers (friendships, web_profile_info, tags web_info, likers, comments). */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, arr, asJson, clean, first, get, instagramProfileUrl, isObj, iso, num, str, uniqBy, walk } from './util.ts';

export interface ParseCtx { url?: string; postUrl?: string; sourceProfile?: string }

function userRec(u: Any, ctx: ParseCtx = {}): Rec | null {
  const username = str(u?.username);
  if (!username) return null;
  return clean({
    username,
    fullName: str(u.full_name),
    profileUrl: instagramProfileUrl(username),
    isPrivate: typeof u.is_private === 'boolean' ? u.is_private : undefined,
    isVerified: typeof u.is_verified === 'boolean' ? u.is_verified : undefined,
    id: str(u.pk ?? u.pk_id ?? u.id),
    sourceProfile: ctx.sourceProfile ?? '',
  });
}

/** Followers / following / likers: `{users:[...], next_max_id}` or GraphQL edge lists. */
export function parseUsers(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  for (const u of arr(root?.users)) { const r = userRec(u, ctx); if (r) records.push(r); }
  let cursor: string | null = root?.next_max_id != null ? str(root.next_max_id) : null;
  if (!records.length) {
    // GraphQL: data.user.edge_followed_by.edges[].node (+ page_info)
    walk(root, (o) => {
      if (!Array.isArray(o.edges)) return;
      for (const e of o.edges) { const r = userRec(e?.node, ctx); if (r) records.push(r); }
      if (isObj(o.page_info) && o.page_info.has_next_page) cursor = str(o.page_info.end_cursor) || cursor;
    });
  }
  return { records: uniqBy(records, (r) => str(r.username)), nextCursor: cursor || null };
}

/** One profile from web_profile_info (`data.user`) or api/v1/users/:id/info (`user`). */
export function parseProfile(raw: unknown): ParseResult {
  const root = asJson(raw);
  const u = get(root, 'data.user') ?? root?.user ?? (root?.username ? root : null);
  if (!isObj(u) || !u.username) return { records: [] };
  const username = str(u.username);
  return {
    records: [clean({
      username,
      fullName: str(u.full_name),
      profileUrl: instagramProfileUrl(username),
      bio: str(u.biography),
      followers: num(get(u, 'edge_followed_by.count')) ?? num(u.follower_count) ?? undefined,
      following: num(get(u, 'edge_follow.count')) ?? num(u.following_count) ?? undefined,
      posts: num(get(u, 'edge_owner_to_timeline_media.count')) ?? num(u.media_count) ?? undefined,
      isPrivate: typeof u.is_private === 'boolean' ? u.is_private : undefined,
      isVerified: typeof u.is_verified === 'boolean' ? u.is_verified : undefined,
      externalUrl: first(u.external_url, get(u, 'bio_links.0.url')),
      category: first(u.category_name, u.category, u.business_category_name),
      email: first(u.business_email, u.public_email),
      phone: first(u.business_phone_number, u.contact_phone_number, u.public_phone_number),
      id: str(u.id ?? u.pk),
    })],
  };
}

/** Hashtag posts from tags/web_info sections or GraphQL edge_hashtag_to_media. */
export function parseHashtag(raw: unknown): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  walk(root, (o) => {
    // v1 media
    if (typeof o.code === 'string' && isObj(o.user) && o.user.username) {
      records.push(clean({
        postUrl: `https://www.instagram.com/p/${o.code}/`,
        username: str(o.user.username),
        profileUrl: instagramProfileUrl(str(o.user.username)),
        caption: str(get(o, 'caption.text')),
        likes: num(o.like_count) ?? undefined,
        comments: num(o.comment_count) ?? undefined,
        postedAt: iso(o.taken_at),
      }));
    }
    // GraphQL node
    if (typeof o.shortcode === 'string' && isObj(o.owner)) {
      const username = str(o.owner.username);
      records.push(clean({
        postUrl: `https://www.instagram.com/p/${o.shortcode}/`,
        username,
        profileUrl: username ? instagramProfileUrl(username) : '',
        caption: str(get(o, 'edge_media_to_caption.edges.0.node.text')),
        likes: num(get(o, 'edge_liked_by.count')) ?? num(get(o, 'edge_media_preview_like.count')) ?? undefined,
        comments: num(get(o, 'edge_media_to_comment.count')) ?? undefined,
        postedAt: iso(o.taken_at_timestamp),
      }));
    }
  });
  const cursor = first(get(root, 'data.recent.next_max_id'), root?.next_max_id, get(root, 'data.hashtag.edge_hashtag_to_media.page_info.end_cursor'));
  return { records: uniqBy(records, (r) => str(r.postUrl)), nextCursor: cursor || null };
}

/** Post comments: `{comments:[...], next_min_id}`. */
export function parseComments(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  for (const c of arr(root?.comments)) {
    const username = str(c?.user?.username);
    if (!username) continue;
    records.push(clean({
      username,
      fullName: str(c.user.full_name),
      profileUrl: instagramProfileUrl(username),
      commentText: str(c.text),
      postUrl: ctx.postUrl ?? '',
      engagedAt: iso(c.created_at ?? c.created_at_utc),
    }));
  }
  const cursor = first(root?.next_min_id, root?.next_max_id);
  return { records: uniqBy(records, (r) => `${r.username}|${r.commentText}`), nextCursor: cursor || null };
}
