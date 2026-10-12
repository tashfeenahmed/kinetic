/** GitHub user list parser: full user objects, stargazer `{starred_at, user}` or `{user, contributions}`. */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, arr, asJson, clean, isObj, num, str, uniqBy } from './util.ts';

export function parseUsers(raw: unknown): ParseResult {
  const root = asJson(raw);
  const list = Array.isArray(root) ? root : arr(root?.users ?? root?.items);
  const records: Rec[] = [];
  for (const item of list) {
    if (!isObj(item)) continue;
    const u: Any = isObj(item.user) ? { ...item.user, ...(isObj(item.profile) ? item.profile : {}) } : item;
    const login = str(u.login);
    if (!login || u.type === 'Bot' || /\[bot\]$/.test(login)) continue;
    const blog = str(u.blog);
    records.push(clean({
      login,
      name: str(u.name),
      githubUrl: str(u.html_url) || `https://github.com/${login}`,
      company: str(u.company).replace(/^@/, ''),
      email: str(u.email),
      location: str(u.location),
      website: blog ? (/^https?:\/\//.test(blog) ? blog : `https://${blog}`) : '',
      twitter: u.twitter_username ? `https://x.com/${u.twitter_username}` : '',
      bio: str(u.bio),
      followers: num(u.followers) ?? undefined,
      contributions: num(item.contributions ?? u.contributions) ?? undefined,
      starredAt: str(item.starred_at),
    }));
  }
  return { records: uniqBy(records, (r) => str(r.login).toLowerCase()), nextCursor: null };
}
