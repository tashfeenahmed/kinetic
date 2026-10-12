/** X / Twitter parsers over GraphQL timeline JSON captured from the page. */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, asJson, clean, first, get, isObj, iso, num, str, uniqBy, walk, xProfileUrl } from './util.ts';

export interface ParseCtx { url?: string; postUrl?: string; sourceProfile?: string }

/** A user record from a GraphQL User result (legacy and newer `core` shapes). */
export function userRec(u: Any, ctx: ParseCtx = {}): Rec | null {
  if (!isObj(u)) return null;
  if (u.__typename === 'UserUnavailable') return null;
  const legacy = u.legacy ?? {};
  const username = first(get(u, 'core.screen_name'), legacy.screen_name);
  if (!username) return null;
  const website = first(get(legacy, 'entities.url.urls.0.expanded_url'), legacy.url);
  return clean({
    username,
    name: first(get(u, 'core.name'), legacy.name),
    profileUrl: xProfileUrl(username),
    bio: first(get(u, 'profile_bio.description'), legacy.description),
    followers: num(legacy.followers_count) ?? num(get(u, 'relationship_counts.followers')) ?? undefined,
    following: num(legacy.friends_count) ?? num(get(u, 'relationship_counts.following')) ?? undefined,
    tweets: num(legacy.statuses_count) ?? undefined,
    location: first(get(u, 'location.location'), legacy.location),
    website,
    verified: !!(u.is_blue_verified || legacy.verified || get(u, 'verification.verified')),
    createdAt: iso(first(get(u, 'core.created_at'), legacy.created_at)),
    id: str(u.rest_id),
    sourceProfile: ctx.sourceProfile ?? '',
  });
}

function bottomCursor(root: Any): string | null {
  let cursor: string | null = null;
  walk(root, (o) => {
    if (o.cursorType === 'Bottom' && typeof o.value === 'string') cursor = o.value;
    else if (typeof o.entryId === 'string' && o.entryId.startsWith('cursor-bottom') && typeof get(o, 'content.value') === 'string') cursor = get(o, 'content.value');
  });
  return cursor;
}

/** Users in a timeline (followers, following, likers, retweeters). */
export function parseUsers(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  walk(root, (o) => {
    if (isObj(o.user_results) && !o.tweet_results) {
      const r = userRec(o.user_results.result, ctx);
      if (r) records.push(r);
    }
  });
  const recs = uniqBy(records, (r) => str(r.username).toLowerCase());
  return { records: recs, nextCursor: recs.length ? bottomCursor(root) : null };
}

/** One profile (UserByScreenName: data.user.result). */
export function parseProfile(raw: unknown): ParseResult {
  const root = asJson(raw);
  const u = get(root, 'data.user.result') ?? get(root, 'data.user_result.result');
  const r = userRec(u);
  if (r) return { records: [r] };
  return parseUsers(root);
}

function unwrapTweet(t: Any): Any {
  if (!isObj(t)) return null;
  if (t.__typename === 'TweetWithVisibilityResults') return t.tweet;
  return t;
}

/** Tweets in a timeline/search result. */
export function parseTweets(raw: unknown): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  walk(root, (o) => {
    if (!isObj(o.tweet_results)) return;
    const t = unwrapTweet(o.tweet_results.result);
    if (!t || !t.legacy) return;
    const author = userRec(get(t, 'core.user_results.result'));
    const id = str(t.rest_id ?? t.legacy.id_str);
    if (!id) return;
    const username = str(author?.username);
    records.push(clean({
      tweetUrl: username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`,
      text: first(get(t, 'note_tweet.note_tweet_results.result.text'), t.legacy.full_text, t.legacy.text),
      username,
      name: author?.name,
      profileUrl: author?.profileUrl,
      likes: num(t.legacy.favorite_count) ?? undefined,
      retweets: num(t.legacy.retweet_count) ?? undefined,
      replies: num(t.legacy.reply_count) ?? undefined,
      createdAt: iso(t.legacy.created_at),
    }));
  });
  const recs = uniqBy(records, (r) => str(r.tweetUrl));
  return { records: recs, nextCursor: recs.length ? bottomCursor(root) : null };
}
