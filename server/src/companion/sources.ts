/**
 * Server-side phantoms: Reddit (public JSON endpoints) and GitHub (REST API). No extension needed.
 * Each call fetches one page and returns its records plus a cursor for the next page (null = finished).
 */
import { getJson, HttpError } from '../gtm/lib/http.ts';
import type { Settings } from '../gtm/settings.ts';
import type { Rec } from './protocol.ts';
import { parse } from './parsers/index.ts';
import { githubRepo, redditPostId } from './parsers/util.ts';

export interface ServerRunInput {
  phantom: string;
  params: Record<string, any>;
  target: Record<string, any>;
  cursor: unknown;
  budget: number;
  settings: Settings;
}
export interface ServerRunOutput { records: Rec[]; nextCursor: unknown | null }

const REDDIT = 'https://www.reddit.com';
export const REDDIT_UA = 'kinetic-companion/0.1 (self-hosted)';

async function reddit(path: string, query: Record<string, string | number | undefined> = {}) {
  try {
    return await getJson(`${REDDIT}${path}`, { headers: { 'user-agent': REDDIT_UA, accept: 'application/json' }, query: { raw_json: 1, ...query } });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw new Error('Reddit rate limit reached — try again in a few minutes');
    if (e instanceof HttpError && (e.status === 403 || e.status === 404)) throw new Error(`Reddit ${e.status}: ${path} is private, banned or does not exist`);
    throw e;
  }
}

const subName = (s: unknown) => String(s ?? '').trim().replace(/^https?:\/\/[^/]*reddit\.com/i, '').replace(/^\/?r\//i, '').replace(/\/.*$/, '');
const userName = (s: unknown) => String(s ?? '').trim().replace(/^https?:\/\/[^/]*reddit\.com/i, '').replace(/^\/?(u|user)\//i, '').replace(/\/.*$/, '');
const pageSize = (budget: number) => Math.max(1, Math.min(100, budget));

async function runReddit(input: ServerRunInput): Promise<ServerRunOutput> {
  const { phantom, params, target, budget } = input;
  const after = typeof input.cursor === 'string' && input.cursor ? input.cursor : undefined;
  if (phantom === 'reddit.subreddit_posts') {
    const sub = subName(params.subreddit);
    if (!sub) throw new Error('Give a subreddit, e.g. "sales"');
    const sort = ['new', 'hot', 'top', 'rising'].includes(params.sort) ? params.sort : 'new';
    const d = await reddit(`/r/${encodeURIComponent(sub)}/${sort}.json`, { limit: pageSize(budget), after, t: sort === 'top' ? params.time || 'week' : undefined });
    const r = parse('reddit.listing', d);
    return { records: r.records.slice(0, budget), nextCursor: r.nextCursor ?? null };
  }
  if (phantom === 'reddit.search') {
    const q = String(params.query ?? '').trim();
    if (!q) throw new Error('Give a search query');
    const sub = subName(params.subreddit);
    const sort = ['new', 'relevance', 'top', 'comments'].includes(params.sort) ? params.sort : 'new';
    const path = sub ? `/r/${encodeURIComponent(sub)}/search.json` : '/search.json';
    const d = await reddit(path, { q, sort, limit: pageSize(budget), after, type: 'link', restrict_sr: sub ? 1 : undefined });
    const r = parse('reddit.listing', d);
    return { records: r.records.slice(0, budget), nextCursor: r.nextCursor ?? null };
  }
  if (phantom === 'reddit.post_commenters') {
    const id = redditPostId(String(target.url ?? ''));
    if (!id) throw new Error(`Not a Reddit post URL: ${target.url}`);
    const d = await reddit(`/comments/${id}.json`, { limit: 500 });
    const r = parse('reddit.comments', d, { postUrl: String(target.url) });
    return { records: r.records.slice(0, budget), nextCursor: null };
  }
  if (phantom === 'reddit.user_activity') {
    const name = userName(target.url ?? target.username);
    if (!name) throw new Error('Give a Reddit username or profile URL');
    const about = await reddit(`/user/${encodeURIComponent(name)}/about.json`);
    const overview = await reddit(`/user/${encodeURIComponent(name)}/overview.json`, { limit: 25 }).catch(() => null);
    const r = parse('reddit.user', { about, overview });
    return { records: r.records.slice(0, budget), nextCursor: null };
  }
  throw new Error(`Unknown Reddit phantom ${phantom}`);
}

const GH = 'https://api.github.com';
const GH_PAGE = 100;

async function runGithub(input: ServerRunInput): Promise<ServerRunOutput> {
  const { phantom, params, budget, settings } = input;
  const repo = githubRepo(String(params.repo ?? ''));
  if (!repo) throw new Error('Give a repository as owner/repo or a github.com URL');
  const token = settings.get('GITHUB_TOKEN');
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const gh = (path: string, extra: Record<string, string> = {}, query?: Record<string, number>) =>
    getJson<any>(`${GH}${path}`, { headers: { ...headers, ...extra }, query }).catch((e) => {
      if (e instanceof HttpError && (e.status === 403 || e.status === 429)) throw new Error('GitHub rate limit reached (60/hour without a token) — add a free GITHUB_TOKEN on the Integrations page');
      if (e instanceof HttpError && e.status === 404) throw new Error(`No GitHub repository ${repo.owner}/${repo.repo}`);
      throw e;
    });
  // Cursor = items consumed so far, so a small budget never skips people between pages.
  const offset = typeof input.cursor === 'number' && input.cursor > 0 ? input.cursor : 0;
  const page = Math.floor(offset / GH_PAGE) + 1;
  const skip = offset % GH_PAGE;
  const base = `/repos/${repo.owner}/${repo.repo}`;
  const batch: any[] = phantom === 'github.stargazers'
    ? await gh(`${base}/stargazers`, { accept: 'application/vnd.github.star+json' }, { per_page: GH_PAGE, page })
    : await gh(`${base}/contributors`, {}, { per_page: GH_PAGE, page });
  const items = (Array.isArray(batch) ? batch : []).slice(skip, skip + budget);
  const enriched: any[] = [];
  for (const item of items) {
    const login = item?.user?.login ?? item?.login;
    if (!login) continue;
    const profile = await gh(`/users/${encodeURIComponent(login)}`).catch(() => null);
    enriched.push(phantom === 'github.stargazers' ? { starred_at: item.starred_at, user: { ...(item.user ?? {}), ...(profile ?? {}) } } : { ...item, ...(profile ?? {}), contributions: item.contributions });
  }
  const r = parse('github.users', enriched);
  const consumed = offset + items.length;
  const more = items.length > 0 && (skip + items.length < batch.length || batch.length === GH_PAGE);
  return { records: r.records, nextCursor: more ? consumed : null };
}

export async function runServerTask(input: ServerRunInput): Promise<ServerRunOutput> {
  if (input.budget <= 0) return { records: [], nextCursor: input.cursor ?? null };
  if (input.phantom.startsWith('reddit.')) return runReddit(input);
  if (input.phantom.startsWith('github.')) return runGithub(input);
  throw new Error(`${input.phantom} does not run on the server`);
}
