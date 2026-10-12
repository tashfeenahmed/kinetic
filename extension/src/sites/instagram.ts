/**
 * Instagram content script: reads through Instagram's own web API from the logged-in page
 * (x-ig-app-id + csrftoken cookie), falling back to JSON the page itself loaded while scrolling.
 */
import type { Rec } from '../../../server/src/companion/protocol.ts';
import { parse, igShortcode } from '../../../server/src/companion/parsers/index.ts';
import { cookie } from '../lib/dom.ts';
import { registerSite, scrapePaged, type Handler, type TaskCtx } from '../lib/runner.ts';
import { checkResponse, SafetyError } from '../lib/safety.ts';

const BASE = 'https://www.instagram.com';
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

async function ig(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<any> {
  const csrf = cookie('csrftoken') ?? '';
  const headers: Record<string, string> = { 'x-ig-app-id': '936619743392459', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest', accept: '*/*' };
  if (init.form) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + path, {
    method: init.method ?? (init.form ? 'POST' : 'GET'),
    credentials: 'include',
    headers,
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  checkResponse('instagram', res, path);
  const text = await res.text();
  if (/"(checkpoint_required|challenge_required)"/.test(text)) throw new SafetyError('challenge', 'Instagram asked for a security check.', BASE + path);
  if (/"login_required"/.test(text)) throw new SafetyError('logged_out', 'Not logged in to Instagram in this browser.', BASE + path);
  if (/"spam":\s*true|Please wait a few minutes/.test(text)) throw new SafetyError('rate_limited', 'Instagram asked to wait before trying again.', BASE + path);
  if (!res.ok) throw new Error(`Instagram API ${res.status} on ${path.split('?')[0]}`);
  return text ? JSON.parse(text) : {};
}

function username(url: string): string {
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(url);
  return (m ? m[1]! : url).replace(/^@/, '').replace(/\/+$/, '');
}

/** Shortcode → numeric media id (base64url alphabet, big-endian). */
function mediaId(shortcode: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const ch of shortcode.slice(0, 11)) id = id * 64n + BigInt(alphabet.indexOf(ch));
  return id.toString();
}

const targetUrl = (ctx: TaskCtx) => str(ctx.task.target.url) || str(ctx.task.target.profileUrl) || str(ctx.task.target.postUrl);

async function profileRaw(user: string) {
  return ig(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`);
}

const handlers: Record<string, Handler> = {
  'instagram.profile_scraper': async (ctx) => {
    const raw = await profileRaw(username(targetUrl(ctx)));
    await ctx.results(parse('instagram.profile', raw).records);
    await ctx.complete({ status: 'done' });
  },

  'instagram.followers_export': async (ctx) => {
    if (!cookie('ds_user_id')) throw new SafetyError('logged_out', 'Not logged in to Instagram in this browser.', location.href);
    const url = targetUrl(ctx);
    const raw = await profileRaw(username(url));
    const id = str(raw?.data?.user?.id);
    if (!id) throw new Error(`Instagram profile not found: ${url}`);
    const which = ctx.task.params.which === 'following' ? 'following' : 'followers';
    await scrapePaged(ctx, async (cursor) => {
      const r = parse('instagram.users', await ig(`/api/v1/friendships/${id}/${which}/?count=50${which === 'followers' ? '&search_surface=follow_list_page' : ''}${cursor ? `&max_id=${encodeURIComponent(String(cursor))}` : ''}`), { sourceProfile: url });
      return { ...r, records: r.records.map((x) => ({ ...x, sourceProfile: x.sourceProfile ?? url })) };
    }, null);
  },

  'instagram.hashtag_export': async (ctx) => {
    const tag = str(ctx.task.params.hashtag).replace(/^#/, '');
    if (!tag) throw new Error('Hashtag is required');
    let page = 0;
    await scrapePaged(ctx, async (cursor) => {
      const raw = cursor == null
        ? await ig(`/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`)
        : await ig(`/api/v1/tags/${encodeURIComponent(tag)}/sections/`, { form: { max_id: String(cursor), page: String(++page), surface: 'grid', tab: 'recent' } });
      return parse('instagram.hashtag', raw);
    }, null);
  },

  'instagram.post_engagers': async (ctx) => {
    const postUrl = targetUrl(ctx);
    const code = igShortcode(postUrl);
    if (!code) throw new Error(`Not an Instagram post URL: ${postUrl}`);
    const id = mediaId(code);
    const add = (r: Rec): Rec => ({ ...r, postUrl: r.postUrl ?? postUrl });
    if (ctx.task.params.which === 'commenters') {
      await scrapePaged(ctx, async (cursor) => {
        const r = parse('instagram.comments', await ig(`/api/v1/media/${id}/comments/?can_support_threading=true&permalink_enabled=false${cursor ? `&min_id=${encodeURIComponent(String(cursor))}` : ''}`), { postUrl });
        return { ...r, records: r.records.map(add) };
      }, null);
    } else {
      const r = parse('instagram.users', await ig(`/api/v1/media/${id}/likers/`), { postUrl });
      await ctx.results(r.records.map(add));
      await ctx.complete({ status: 'done' });
    }
  },
};

registerSite('instagram', handlers);
