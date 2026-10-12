/**
 * Which page the worker opens before handing a task to the content script. Tasks that read
 * through the site's JSON APIs just need any page on the site; page-based ones (real profile
 * visits, X/Facebook infinite lists) need the exact page.
 */
import type { TaskPayload } from '../../../server/src/companion/protocol.ts';
import { SITE_HOME } from '../../../server/src/companion/protocol.ts';

const trim = (u: string) => u.replace(/[?#].*$/, '').replace(/\/+$/, '');
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function targetUrl(task: TaskPayload): string {
  const t = task.target ?? {};
  return str(t.url) || str(t.profileUrl) || str(t.postUrl);
}

function xUser(url: string): string {
  const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})/.exec(url);
  return m ? m[1]! : url.replace(/^@/, '');
}

export function pageFor(task: TaskPayload): string {
  const url = targetUrl(task);
  const p = task.params ?? {};
  switch (task.kind) {
    // Real visits: the person sees us in "Who viewed your profile".
    case 'linkedin.visit':
    case 'linkedin.profile_visitor':
    // Actions on a person happen from their profile page, like a person would (and the DOM
    // fallback needs the page's Connect/Message buttons).
    case 'linkedin.connect':
    case 'linkedin.auto_connect':
    case 'linkedin.message':
    case 'linkedin.message_sender':
    case 'linkedin.auto_follow':
      return url || task.openUrl;
    case 'linkedin.profile_scraper':
      return p.visit ? url : SITE_HOME.linkedin;
    case 'x.followers_export':
      return `https://x.com/${xUser(url)}/${p.which === 'following' ? 'following' : 'followers'}`;
    case 'x.profile_scraper':
      return `https://x.com/${xUser(url)}`;
    case 'x.tweet_engagers': {
      const id = /status\/(\d+)/.exec(url)?.[1];
      return id ? `https://x.com/i/status/${id}/${p.which === 'likers' ? 'likes' : 'retweets'}` : url;
    }
    case 'x.search_export':
      return `https://x.com/search?q=${encodeURIComponent(str(p.query))}&src=typed_query${p.mode === 'Top' ? '' : '&f=live'}`;
    case 'facebook.group_members':
      return `${trim(str(p.group_url))}/members`;
    case 'facebook.event_attendees':
      return trim(str(p.event_url));
    case 'facebook.page_scraper':
      return url;
    default:
      return task.site === 'linkedin' || task.site === 'instagram' ? SITE_HOME[task.site] : task.openUrl || SITE_HOME[task.site];
  }
}

/** Same page, ignoring query, hash and trailing slash. */
export function samePage(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '') && trim(x.pathname) === trim(y.pathname) && (y.search === '' || x.search === y.search);
  } catch { return false; }
}

/**
 * Whether the tab only needs to be somewhere on the site: LinkedIn and Instagram tasks read
 * through the sites' JSON APIs (except real profile visits); X and Facebook need the exact page.
 */
export function anyPageOnSite(task: TaskPayload): boolean {
  if (['linkedin.visit', 'linkedin.profile_visitor', 'linkedin.connect', 'linkedin.auto_connect', 'linkedin.message', 'linkedin.message_sender', 'linkedin.auto_follow'].includes(task.kind)) return false;
  if (task.kind === 'linkedin.profile_scraper' && task.params?.visit) return false;
  return task.site === 'linkedin' || task.site === 'instagram';
}
