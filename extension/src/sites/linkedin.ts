/**
 * LinkedIn content script. Reads and acts through LinkedIn's own Voyager JSON API from inside
 * the logged-in page (csrf token = JSESSIONID cookie), with DOM fallbacks when an endpoint fails.
 * Endpoint names/decorations change from time to time; each call has a fallback path.
 */
import type { Rec, ParseResult } from '../../../server/src/companion/protocol.ts';
import { parse, linkedinActivityUrn, linkedinProfileUrl } from '../../../server/src/companion/parsers/index.ts';
import { cookie, findButton, humanClick, humanType, pageHtml, waitFor } from '../lib/dom.ts';
import { humanDelay, humanScroll, sleep } from '../lib/pacing.ts';
import { capturedUrls, registerSite, scrapePaged, type Handler, type TaskCtx } from '../lib/runner.ts';
import { checkPage, checkResponse, SafetyError } from '../lib/safety.ts';

const BASE = 'https://www.linkedin.com';
const enc = encodeURIComponent;
/** Rest.li values keep their structural characters. */
const restli = (s: string) => encodeURIComponent(s).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%28/g, '(').replace(/%29/g, ')');
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const nowIso = () => new Date().toISOString();

class VoyagerError extends Error {
  status: number;
  body: string;
  constructor(status: number, path: string, body: string) {
    super(`LinkedIn API ${status} on ${path.split('?')[0]}`);
    this.status = status;
    this.body = body;
  }
}

// ---- low-level ---------------------------------------------------------------------

async function voyager(path: string, opts: { method?: string; body?: unknown; accept?: string } = {}): Promise<any> {
  const csrf = cookie('JSESSIONID');
  if (!csrf) throw new SafetyError('logged_out', 'Not logged in to LinkedIn in this browser (no session cookie).', location.href);
  const headers: Record<string, string> = {
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    accept: opts.accept ?? 'application/vnd.linkedin.normalized+json+2.1',
  };
  if (opts.body !== undefined) headers['content-type'] = 'application/json; charset=UTF-8';
  const res = await fetch(BASE + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  checkResponse('linkedin', res, path);
  const text = await res.text();
  if (!res.ok) {
    if (/FUSE_LIMIT_EXCEEDED|CANT_RESEND_YET.*weekly|weekly invitation limit/i.test(text)) {
      throw new SafetyError('rate_limited', 'LinkedIn invitation limit reached.', BASE + path);
    }
    throw new VoyagerError(res.status, path, text.slice(0, 500));
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include', headers: { accept: 'text/html' } });
  checkResponse('linkedin', res, url);
  if (!res.ok) throw new VoyagerError(res.status, url, '');
  return res.text();
}

/** LinkedIn server-renders the page's Voyager data into <code> blocks; merge them into one normalized doc. */
function codeBlocksJson(html: string): { data: Record<string, unknown>; included: unknown[] } {
  const included: unknown[] = [];
  const data: Record<string, unknown> = {};
  for (const m of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)) {
    const raw = m[1]!.replace(/&quot;/g, '"').replace(/&#92;/g, '\\').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#61;/g, '=').replace(/&amp;/g, '&').trim();
    if (!raw.startsWith('{')) continue;
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j.included)) included.push(...j.included);
      if (j.data && typeof j.data === 'object') Object.assign(data, j.data);
    } catch { /* not JSON */ }
  }
  return { data, included };
}

const pick = (r: ParseResult) => r.records ?? [];

function publicId(url: string): string {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  if (!m) return url.replace(/^@/, '').replace(/\/+$/, '');
  try { return decodeURIComponent(m[1]!); } catch { return m[1]!; }
}

const isPost = (url: string) => /\/(posts|feed\/update|pulse)\//.test(url) || /urn:li:(activity|ugcPost|share):/.test(url);
const isCompany = (url: string) => /linkedin\.com\/(company|school|showcase)\//i.test(url);
const companySlug = (url: string) => /\/(?:company|school|showcase)\/([^/?#]+)/i.exec(url)?.[1] ?? '';

let meCache: { publicId: string; urn: string } | null = null;
/** The logged-in member (needed as the messaging mailbox). */
async function me(): Promise<{ publicId: string; urn: string }> {
  if (meCache) return meCache;
  const raw = await voyager('/voyager/api/me');
  let pid = '';
  let urn = '';
  const visit = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    if (!pid && typeof r.publicIdentifier === 'string') pid = r.publicIdentifier;
    for (const v of Object.values(r)) {
      if (!urn && typeof v === 'string' && /^urn:li:fsd_profile:/.test(v)) urn = v;
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(raw);
  if (!urn) {
    const plain = JSON.stringify(raw).match(/urn:li:fs_miniProfile:([A-Za-z0-9_-]+)/)?.[1];
    if (plain) urn = `urn:li:fsd_profile:${plain}`;
  }
  meCache = { publicId: pid, urn };
  return meCache;
}

// ---- reads -------------------------------------------------------------------------

/** Full profile of a person: dash API, legacy profileView, server-rendered HTML, then the open page. */
async function profileFor(url: string): Promise<Rec> {
  const id = publicId(url);
  const ctxP = { url: linkedinProfileUrl(id) };
  const attempts: (() => Promise<Rec[]>)[] = [
    async () => pick(parse('linkedin.profile', await voyager(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${enc(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`), ctxP)),
    async () => pick(parse('linkedin.profile', await voyager(`/voyager/api/identity/profiles/${enc(id)}/profileView`), ctxP)),
    async () => {
      const html = samePath(location.href, ctxP.url) ? pageHtml() : await fetchHtml(ctxP.url);
      const viaCode = pick(parse('linkedin.profile', codeBlocksJson(html), ctxP));
      return viaCode.length ? viaCode : pick(parse('linkedin.profile_html', html, ctxP));
    },
  ];
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      const recs = await a();
      if (recs.length && recs[0]!.fullName) return recs[0]!;
    } catch (e) {
      if (e instanceof SafetyError) throw e;
      lastErr = e;
    }
  }
  throw new Error(`Couldn't read the profile ${url}${lastErr ? ` (${(lastErr as Error).message})` : ''}`);
}

function samePath(a: string, b: string) {
  try { return new URL(a).pathname.replace(/\/+$/, '').toLowerCase() === new URL(b).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return false; }
}

async function companyFor(url: string): Promise<Rec> {
  const slug = companySlug(url);
  if (!slug) throw new Error(`Not a company page: ${url}`);
  try {
    const raw = await voyager(`/voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${enc(slug)}`);
    const r = pick(parse('linkedin.company', raw, { url }));
    if (r.length) return r[0]!;
  } catch (e) { if (e instanceof SafetyError) throw e; }
  const html = await fetchHtml(`${BASE}/company/${slug}/about/`);
  const r = pick(parse('linkedin.company', codeBlocksJson(html), { url }));
  if (!r.length) throw new Error(`Couldn't read the company page ${url}`);
  return r[0]!;
}

/** Turns a people-search URL into Voyager search queryParameters. */
function searchQuery(searchUrl: string): { keywords: string; params: string } {
  const u = new URL(searchUrl);
  const skip = new Set(['keywords', 'origin', 'page', 'sid', 'spellCorrectionEnabled', 'prevent', 'heroEntityKey']);
  const params: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (skip.has(k)) continue;
    let values: string[];
    try { const j = JSON.parse(v); values = Array.isArray(j) ? j.map(String) : [String(j)]; } catch { values = [v]; }
    params.push(`${k}:List(${values.map(restli).join(',')})`);
  }
  if (!u.searchParams.has('resultType')) params.push('resultType:List(PEOPLE)');
  return { keywords: u.searchParams.get('keywords') ?? '', params: params.join(',') };
}

/** One page (10 results) of a people search, via GraphQL (if the page taught us the query id), REST, then HTML. */
async function searchPage(searchUrl: string, start: number): Promise<ParseResult> {
  const { keywords, params } = searchQuery(searchUrl);
  const query = `(${keywords ? `keywords:${restli(keywords)},` : ''}flagshipSearchIntent:SEARCH_SRP,queryParameters:(${params}),includeFiltersInResponse:false)`;
  const learned = capturedUrls().map((u) => /queryId=(voyagerSearchDashClusters\.[0-9a-f]+)/.exec(u)?.[1]).find(Boolean);
  const attempts: (() => Promise<unknown>)[] = [];
  if (learned) attempts.push(() => voyager(`/voyager/api/graphql?variables=(start:${start},origin:FACETED_SEARCH,query:${query})&queryId=${learned}`));
  attempts.push(() => voyager(`/voyager/api/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-186&origin=FACETED_SEARCH&q=all&query=${query}&start=${start}&count=10`));
  for (const a of attempts) {
    try {
      const r = parse('linkedin.search', await a());
      if (r.records.length || r.total === 0) return r;
    } catch (e) { if (e instanceof SafetyError) throw e; }
  }
  // HTML fallback: the results page for this offset.
  const u = new URL(searchUrl);
  u.searchParams.set('page', String(Math.floor(start / 10) + 1));
  const html = await fetchHtml(u.href);
  const viaCode = parse('linkedin.search', codeBlocksJson(html));
  return viaCode.records.length ? viaCode : parse('linkedin.search_html', html);
}

/** Pages a people search 10 at a time (LinkedIn shows at most 1,000 results). */
function searchHandler(urlOf: (ctx: TaskCtx) => Promise<string> | string, decorate?: (r: Rec, ctx: TaskCtx) => Rec): Handler {
  return async (ctx) => {
    const searchUrl = await urlOf(ctx);
    await scrapePaged(ctx, async (cursor) => {
      const start = Number(cursor ?? 0) || 0;
      const r = await searchPage(searchUrl, start);
      const cap = Math.min(1000, r.total ?? 1000);
      const next = r.records.length && start + 10 < cap ? start + 10 : null;
      return { ...r, records: decorate ? r.records.map((x) => decorate(x, ctx)) : r.records, nextCursor: next };
    }, 0);
  };
}

async function activityUrn(postUrl: string): Promise<string> {
  const direct = linkedinActivityUrn(postUrl);
  if (direct) return direct;
  const html = await fetchHtml(postUrl);
  const m = /urn:li:activity:(\d+)/.exec(html);
  if (!m) throw new Error(`Couldn't find the post id in ${postUrl}`);
  return `urn:li:activity:${m[1]}`;
}

/** Recent posts of a profile or company page (newest first). */
async function postsOf(url: string, count: number, maxAgeDays?: number): Promise<Rec[]> {
  let raw: unknown;
  if (isCompany(url)) {
    raw = await voyager(`/voyager/api/feed/updatesV2?companyIdOrUniversalName=${enc(companySlug(url))}&count=${Math.min(50, count + 5)}&moduleKey=ORGANIZATION_MEMBER_FEED_DESKTOP&numComments=0&numLikes=0&q=companyFeedByUniversalName&start=0`);
  } else {
    const p = await profileFor(url);
    const urn = str(p.memberUrn);
    if (!urn) throw new Error(`No member id for ${url}`);
    raw = await voyager(`/voyager/api/identity/profileUpdatesV2?count=${Math.min(50, count + 5)}&includeLongTermHistory=true&moduleKey=member-shares:phone&numComments=0&numLikes=0&profileUrn=${enc(urn)}&q=memberShareFeed&start=0`);
  }
  let posts = parse('linkedin.activity', raw, { sourceProfile: url }).records;
  if (maxAgeDays) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    posts = posts.filter((p) => !p.postedAt || Date.parse(str(p.postedAt)) >= cutoff);
  }
  return posts.slice(0, count);
}

/** A single post's data (author, text) from its page. */
async function postData(postUrl: string): Promise<Rec> {
  const urn = await activityUrn(postUrl).catch(() => '');
  try {
    const html = await fetchHtml(postUrl);
    const recs = parse('linkedin.activity', codeBlocksJson(html), { url: postUrl }).records;
    const hit = recs.find((r) => urn && str(r.postUrn).includes(urn.split(':').pop()!)) ?? recs[0];
    if (hit) return { ...hit, postUrl: hit.postUrl ?? postUrl, postUrn: hit.postUrn ?? urn };
    const og = /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i.exec(html)?.[1] ?? '';
    const title = /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html)?.[1] ?? '';
    return { postUrl, postUrn: urn, text: og, authorName: title.split(/ on LinkedIn| \| /)[0] ?? '' };
  } catch (e) {
    if (e instanceof SafetyError) throw e;
    return { postUrl, postUrn: urn };
  }
}

async function reactionsPage(postUrl: string, urn: string, start: number): Promise<ParseResult> {
  const raw = await voyager(`/voyager/api/voyagerSocialDashReactions?decorationId=com.linkedin.voyager.dash.deco.social.ReactionsByTypeWithProfileActions-13&count=50&q=reactionType&start=${start}&threadUrn=${enc(urn)}`);
  const r = parse('linkedin.reactions', raw, { postUrl });
  return { ...r, nextCursor: r.records.length >= 10 && (r.total == null || start + 50 < r.total) ? start + 50 : null };
}

async function commentsPage(postUrl: string, urn: string, start: number): Promise<ParseResult> {
  const id = urn.split(':').pop();
  const raw = await voyager(`/voyager/api/feed/comments?count=100&q=comments&sortOrder=RELEVANCE&start=${start}&updateId=${enc(`activity:${id}`)}`);
  const r = parse('linkedin.comments', raw, { postUrl });
  return { ...r, nextCursor: r.records.length >= 20 && (r.total == null || start + 100 < r.total) ? start + 100 : null };
}

// ---- writes ------------------------------------------------------------------------

async function sendInvite(memberUrn: string, note: string): Promise<void> {
  await voyager('/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2', {
    body: { invitee: { inviteeUnion: { memberProfile: memberUrn } }, ...(note ? { customMessage: note } : {}) },
  });
}

/** DOM fallback: Connect (or More → Connect) on the open profile, optional note, Send. */
async function inviteViaDom(note: string): Promise<void> {
  let btn = findButton(/^(Invite .+ to connect|Connect)$/i, document.querySelector('main') ?? document);
  if (!btn) {
    const more = findButton(/^More( actions)?$/i, document.querySelector('main') ?? document);
    if (more) { await humanClick(more); btn = findButton(/^(Invite .+ to connect|Connect)$/i); }
  }
  if (!btn) throw new Error('No Connect button on this profile');
  await humanClick(btn);
  checkPage('linkedin');
  if (note) {
    const add = await waitFor(() => findButton(/^Add a note$/i), 6000);
    if (!add) throw new Error('The invite dialog has no "Add a note" option (LinkedIn may limit notes on free accounts)');
    await humanClick(add);
    const box = await waitFor<HTMLTextAreaElement>('textarea[name="message"], textarea#custom-message, .send-invite textarea', 6000);
    if (!box) throw new Error('Note box not found');
    await humanType(box, note);
  }
  const send = await waitFor(() => findButton(note ? /^Send( invitation| now)?$/i : /^(Send without a note|Send now|Send)$/i), 6000);
  if (!send) throw new Error('Send button not found');
  await humanClick(send);
  await sleep(humanDelay([1200, 2500]));
  checkPage('linkedin');
}

function trackingId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return String.fromCharCode(...b);
}

async function sendMessageApi(memberUrn: string, text: string): Promise<void> {
  const mine = await me();
  if (!mine.urn) throw new Error('Could not identify your own LinkedIn profile');
  await voyager('/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
    body: {
      message: { body: { attributes: [], text }, renderContentUnions: [], originToken: crypto.randomUUID() },
      mailboxUrn: mine.urn, trackingId: trackingId(), dedupeByClientGeneratedToken: false, hostRecipientUrns: [memberUrn],
    },
  });
}

async function messageViaDom(text: string): Promise<void> {
  const btn = findButton(/^Message( .+)?$/i, document.querySelector('main') ?? document);
  if (!btn) throw new Error('No Message button on this profile');
  await humanClick(btn);
  const box = await waitFor<HTMLElement>('.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]', 8000);
  if (!box) throw new Error('Message box not found');
  await humanType(box, text);
  const send = await waitFor(() => document.querySelector<HTMLElement>('.msg-form__send-button:not([disabled])') ?? findButton(/^Send$/i), 5000);
  if (!send) throw new Error('Send button not found');
  await humanClick(send);
  await sleep(humanDelay([1000, 2000]));
}

async function follow(url: string): Promise<void> {
  let urn: string;
  if (isCompany(url)) {
    const c = await companyFor(url);
    urn = `urn:li:fsd_company:${str(c.companyId)}`;
    if (!c.companyId) throw new Error('No company id');
  } else {
    urn = str((await profileFor(url)).memberUrn);
    if (!urn) throw new Error('No member id');
  }
  try {
    await voyager(`/voyager/api/feed/dash/followingStates/${enc(`urn:li:fsd_followingState:${urn}`)}`, { body: { patch: { $set: { following: true } } } });
  } catch (e) {
    if (e instanceof SafetyError) throw e;
    const btn = findButton(/^(\+ )?Follow( .+)?$/i, document.querySelector('main') ?? document);
    if (!btn) throw e;
    await humanClick(btn);
  }
}

async function react(postUrl: string, reaction: string): Promise<void> {
  const urn = await activityUrn(postUrl);
  await voyager(`/voyager/api/voyagerSocialDashReactions?threadUrn=${enc(urn)}`, { body: { reactionType: reaction || 'LIKE' } });
}

async function comment(postUrl: string, text: string): Promise<void> {
  const urn = await activityUrn(postUrl);
  await voyager('/voyager/api/voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43', {
    body: { commentary: { text, attributesV2: [], $type: 'com.linkedin.voyager.dash.common.text.TextViewModel' }, threadUrn: urn },
  });
}

// ---- task helpers ------------------------------------------------------------------

const targetUrl = (ctx: TaskCtx) => str(ctx.task.target.url) || str(ctx.task.target.profileUrl) || str(ctx.task.target.postUrl);

/** Linger on an opened profile like a reader: scroll a little, pause. */
async function dwell() {
  await sleep(humanDelay([1500, 3500]));
  checkPage('linkedin');
  await humanScroll({ steps: 2 + Math.floor(Math.random() * 3) });
  await sleep(humanDelay([2000, 6000]));
}

/** Text for a note/message: pre-rendered by Kinetic, or rendered now from the profile. */
async function textFor(ctx: TaskCtx, profile: Rec, template: unknown): Promise<string> {
  if (typeof ctx.task.params.text === 'string') return ctx.task.params.text;
  const t = str(template);
  if (!t) return '';
  return (await ctx.render(profile, t)).trim();
}

async function actionRecord(ctx: TaskCtx, rec: Rec) {
  await ctx.actionResult({ at: nowIso(), ...rec }).catch(() => {});
}

// ---- handlers ----------------------------------------------------------------------

const visit: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  await ctx.actionSlot();
  await dwell();
  const profile = await profileFor(url);
  const result = { profile, connectionDegree: str(profile.connectionDegree) || null, pendingInvite: !!profile.pendingInvite };
  if (ctx.task.kind === 'linkedin.profile_visitor') {
    await actionRecord(ctx, { profileUrl: profile.profileUrl ?? url, fullName: profile.fullName, status: 'sent', detail: 'visited' });
  }
  await ctx.complete({ status: 'done', result, actions: 1 });
};

const connect: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  const phantom = ctx.task.kind === 'linkedin.auto_connect';
  await dwell();
  const profile = await profileFor(url);
  const base = { profileUrl: profile.profileUrl ?? url, fullName: profile.fullName };
  if (profile.connectionDegree === '1st') {
    if (phantom) await actionRecord(ctx, { ...base, status: 'skipped', detail: 'already connected' });
    return ctx.complete({ status: 'skipped', result: { alreadyConnected: true, profile }, actions: 0 });
  }
  if (profile.pendingInvite) {
    if (phantom) await actionRecord(ctx, { ...base, status: 'skipped', detail: 'invitation already pending' });
    return ctx.complete({ status: 'skipped', result: { pendingInvite: true, profile }, actions: 0 });
  }
  const note = (await textFor(ctx, profile, phantom ? ctx.task.params.note : ctx.task.params.template)).slice(0, 300);
  await ctx.actionSlot();
  const urn = str(ctx.task.target.memberUrn) || str(profile.memberUrn);
  try {
    if (!urn) throw new Error('no member urn');
    await sendInvite(urn, note);
  } catch (e) {
    if (e instanceof SafetyError) throw e;
    await inviteViaDom(note);
  }
  if (phantom) await actionRecord(ctx, { ...base, status: 'sent', sentText: note });
  await ctx.complete({ status: 'done', result: { sentText: note, profile }, actions: 1 });
};

const message: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  const phantom = ctx.task.kind === 'linkedin.message_sender';
  await dwell();
  const profile = await profileFor(url);
  const base = { profileUrl: profile.profileUrl ?? url, fullName: profile.fullName };
  if (profile.connectionDegree && profile.connectionDegree !== '1st') {
    if (phantom) await actionRecord(ctx, { ...base, status: 'skipped', detail: 'not a 1st-degree connection' });
    return ctx.complete({ status: 'skipped', result: { notConnected: true }, actions: 0 });
  }
  const text = await textFor(ctx, profile, phantom ? ctx.task.params.message : ctx.task.params.template);
  if (!text) throw new Error('Empty message');
  await ctx.actionSlot();
  const urn = str(ctx.task.target.memberUrn) || str(profile.memberUrn);
  try {
    if (!urn) throw new Error('no member urn');
    await sendMessageApi(urn, text);
  } catch (e) {
    if (e instanceof SafetyError) throw e;
    await messageViaDom(text);
  }
  if (phantom) await actionRecord(ctx, { ...base, status: 'sent', sentText: text });
  await ctx.complete({ status: 'done', result: { sentText: text }, actions: 1 });
};

const autoFollow: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  await dwell();
  await ctx.actionSlot();
  try {
    await follow(url);
    await actionRecord(ctx, { profileUrl: url, status: 'sent', detail: 'followed' });
  } catch (e) {
    if (e instanceof SafetyError) throw e;
    await actionRecord(ctx, { profileUrl: url, status: 'failed', detail: (e as Error).message });
    throw e;
  }
  await ctx.complete({ status: 'done', actions: 1 });
};

const withdrawInvites: Handler = async (ctx) => {
  const olderThan = Number(ctx.task.params.older_than_days ?? 21);
  const cutoff = Date.now() - olderThan * 86_400_000;
  const old: Rec[] = [];
  for (let start = 0; start < 2000; start += 100) {
    const r = parse('linkedin.sent_invitations', await voyager(`/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=${start}`));
    old.push(...r.records.filter((i) => i.sentAt && Date.parse(str(i.sentAt)) < cutoff));
    if (r.records.length < 100) break;
    await ctx.pageWait();
  }
  // Oldest first.
  old.sort((a, b) => Date.parse(str(a.sentAt)) - Date.parse(str(b.sentAt)));
  let done = 0;
  for (const inv of old) {
    if (done >= ctx.budget) break;
    await ctx.actionSlot();
    try {
      await voyager(`/voyager/api/relationships/invitations/${enc(str(inv.invitationId))}?action=withdraw`, {
        body: { invitationId: str(inv.invitationId), invitationSharedSecret: str(inv.sharedSecret), isGenericInvitation: false },
      });
      await actionRecord(ctx, { profileUrl: inv.profileUrl, fullName: inv.fullName, status: 'sent', detail: `withdrawn (sent ${str(inv.sentAt).slice(0, 10)})` });
    } catch (e) {
      if (e instanceof SafetyError) throw e;
      await actionRecord(ctx, { profileUrl: inv.profileUrl, fullName: inv.fullName, status: 'failed', detail: (e as Error).message });
    }
    done++;
    await ctx.progress(`${done} withdrawn`, done, Math.min(old.length, ctx.budget));
    if (done < Math.min(old.length, ctx.budget)) await ctx.actionWait();
  }
  await ctx.complete({ status: 'done', actions: done, more: old.length > done && done >= ctx.budget ? true : undefined });
};

const postLiker: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  const n = Number(ctx.task.params.posts_per_profile ?? 1);
  const posts = isPost(url) ? [{ postUrl: url }] : await postsOf(url, n);
  let done = 0;
  for (const p of posts) {
    if (done >= ctx.budget) break;
    await ctx.actionSlot();
    try {
      await react(str(p.postUrl), str(ctx.task.params.reaction));
      await actionRecord(ctx, { postUrl: p.postUrl, authorName: p.authorName, status: 'sent' });
    } catch (e) {
      if (e instanceof SafetyError) throw e;
      await actionRecord(ctx, { postUrl: p.postUrl, authorName: p.authorName, status: 'failed', detail: (e as Error).message });
    }
    done++;
    if (done < posts.length) await ctx.actionWait();
  }
  await ctx.complete({ status: 'done', actions: done });
};

const aiPostResponder: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  const n = Number(ctx.task.params.posts_per_profile ?? 1);
  const posts = isPost(url) ? [await postData(url)] : await postsOf(url, n);
  await ctx.results(posts.filter((p) => p.postUrl).map((p) => ({ postUrl: p.postUrl, postUrn: p.postUrn, authorName: p.authorName, authorUrl: p.authorUrl, text: p.text })));
  await ctx.complete({ status: 'done' });
};

const commentTask: Handler = async (ctx) => {
  const postUrl = str(ctx.task.target.postUrl) || targetUrl(ctx);
  const text = str(ctx.task.params.text);
  if (!text) throw new Error('Empty comment');
  await ctx.actionSlot();
  await comment(postUrl, text);
  await ctx.complete({ status: 'done', result: { sentText: text }, actions: 1 });
};

const postMonitor: Handler = async (ctx) => {
  const url = targetUrl(ctx);
  const p = ctx.task.params;
  const collect = str(p.collect) || 'both';
  const posts = isPost(url) ? [await postData(url)] : await postsOf(url, Number(p.posts_per_profile ?? 3), Number(p.max_post_age_days ?? 14));
  for (const post of posts) {
    const postUrl = str(post.postUrl);
    if (!postUrl) continue;
    const urn = str(post.postUrn) || await activityUrn(postUrl);
    const decorate = (r: Rec): Rec => ({ ...r, postUrl, postAuthor: post.authorName ?? '', engagerKey: `${postUrl}|${str(r.profileUrl)}|${str(r.engagement)}` });
    const sources: ((s: number) => Promise<ParseResult>)[] = [];
    if (collect !== 'commenters') sources.push((s) => reactionsPage(postUrl, urn, s));
    if (collect !== 'reactors') sources.push((s) => commentsPage(postUrl, urn, s));
    for (const page of sources) {
      for (let cursor: unknown = 0; cursor != null; ) {
        const r = await page(Number(cursor));
        const { keepGoing } = await ctx.results(r.records.map(decorate));
        if (!keepGoing) return ctx.complete({ status: 'done' });
        cursor = r.nextCursor ?? null;
        await ctx.pageWait();
      }
    }
    await ctx.progress(`${ctx.collected} engagers`, ctx.collected);
  }
  await ctx.complete({ status: 'done' });
};

/** Paged list endpoints: `path(start)` returns the URL for that offset. */
function pagedList(parser: Parameters<typeof parse>[0], path: (start: number, ctx: TaskCtx) => string, pageSize: number, decorate?: (r: Rec, ctx: TaskCtx) => Rec | null): Handler {
  return (ctx) => scrapePaged(ctx, async (cursor) => {
    const start = Number(cursor ?? 0) || 0;
    const r = parse(parser, await voyager(path(start, ctx)), { url: targetUrl(ctx), sourceProfile: targetUrl(ctx) });
    const recs = decorate ? r.records.map((x) => decorate(x, ctx)).filter((x): x is Rec => !!x) : r.records;
    const next = r.records.length >= Math.min(pageSize, 10) && (r.total == null || start + pageSize < r.total) ? start + pageSize : null;
    return { records: recs, total: r.total, nextCursor: next };
  }, 0);
}

const groupId = (url: string) => /\/groups\/(\d+)/.exec(url)?.[1] ?? '';
const eventId = (url: string) => /\/events\/(?:[^/]*?-)?(\d{6,})/.exec(url)?.[1] ?? /(\d{10,})/.exec(url)?.[1] ?? '';

/** Conversations, newest first; cursor = the oldest lastActivityAt seen (ms). */
const conversations = (opts: { unreadOnly?: (ctx: TaskCtx) => boolean }): Handler => (ctx) => scrapePaged(ctx, async (cursor) => {
  const before = Number(cursor ?? 0);
  const raw = await voyager(`/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX${before ? `&createdBefore=${before}` : ''}`);
  const r = parse('linkedin.conversations', raw);
  const times = r.records.map((x) => Date.parse(str(x.lastMessageAt))).filter((t) => Number.isFinite(t));
  const oldest = times.length ? Math.min(...times) : 0;
  const recs = opts.unreadOnly?.(ctx) ? r.records.filter((x) => x.unread) : r.records;
  return { records: recs, nextCursor: r.records.length >= 10 && oldest && oldest !== before ? oldest : null };
}, 0);

const handlers: Record<string, Handler> = {
  // data
  'linkedin.search_export': searchHandler((ctx) => str(ctx.task.params.search_url)),
  'linkedin.company_employees': searchHandler(async (ctx) => {
    const c = await companyFor(targetUrl(ctx));
    if (!c.companyId) throw new Error('Could not find the company id');
    const kw = str(ctx.task.params.title_keywords);
    return `${BASE}/search/results/people/?currentCompany=${enc(JSON.stringify([str(c.companyId)]))}&origin=COMPANY_PAGE_CANNED_SEARCH${kw ? `&titleFreeText=${enc(kw)}` : ''}`;
  }, (r, ctx) => ({ ...r, sourceCompany: targetUrl(ctx) })),
  'linkedin.event_attendees': searchHandler((ctx) => {
    const id = eventId(str(ctx.task.params.event_url));
    if (!id) throw new Error('Could not read the event id from the URL');
    return `${BASE}/search/results/people/?eventAttending=${enc(JSON.stringify([id]))}&origin=EVENT_PAGE_CANNED_SEARCH`;
  }),
  'sales_navigator.lead_search_export': salesNav('leads'),
  'sales_navigator.account_search_export': salesNav('accounts'),
  'linkedin.profile_scraper': async (ctx) => {
    if (ctx.task.params.visit) await dwell();
    const p = await profileFor(targetUrl(ctx));
    await ctx.results([p]);
    await ctx.complete({ status: 'done' });
  },
  'linkedin.company_scraper': async (ctx) => {
    await ctx.results([await companyFor(targetUrl(ctx))]);
    await ctx.complete({ status: 'done' });
  },
  'linkedin.post_reactors': async (ctx) => {
    const postUrl = targetUrl(ctx);
    const urn = await activityUrn(postUrl);
    await scrapePaged(ctx, (c) => reactionsPage(postUrl, urn, Number(c ?? 0)), 0);
  },
  'linkedin.post_commenters': async (ctx) => {
    const postUrl = targetUrl(ctx);
    const urn = await activityUrn(postUrl);
    await scrapePaged(ctx, (c) => commentsPage(postUrl, urn, Number(c ?? 0)), 0);
  },
  'linkedin.profile_activity': async (ctx) => {
    const posts = await postsOf(targetUrl(ctx), Number(ctx.task.params.posts_per_profile ?? 10));
    await ctx.results(posts);
    await ctx.complete({ status: 'done' });
  },
  'linkedin.group_members': pagedList('linkedin.group_members', (s, ctx) => {
    const id = groupId(str(ctx.task.params.group_url));
    if (!id) throw new Error('Could not read the group id from the URL');
    return `/voyager/api/voyagerGroupsDashGroupMemberships?decorationId=com.linkedin.voyager.dash.deco.groups.GroupMembership-12&count=50&groupUrn=${enc(`urn:li:fsd_group:${id}`)}&membershipStatuses=List(OWNER,MANAGER,MEMBER)&q=groupMemberships&start=${s}`;
  }, 50),
  'linkedin.people_also_viewed': async (ctx) => {
    const url = targetUrl(ctx);
    let recs: Rec[] = [];
    try {
      recs = parse('linkedin.browsemap', await voyager(`/voyager/api/identity/profiles/${enc(publicId(url))}/browsemapWithDistance`), { sourceProfile: url }).records;
    } catch (e) { if (e instanceof SafetyError) throw e; }
    if (!recs.length) recs = parse('linkedin.browsemap', codeBlocksJson(await fetchHtml(linkedinProfileUrl(publicId(url)))), { sourceProfile: url }).records;
    await ctx.results(recs.map((r) => ({ ...r, sourceProfile: r.sourceProfile ?? url })));
    await ctx.complete({ status: 'done' });
  },
  'linkedin.connections_export': pagedList('linkedin.connections', (s) => `/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED&start=${s}`, 40),
  'linkedin.inbox_export': conversations({ unreadOnly: (ctx) => !!ctx.task.params.unread_only }),

  // actions
  'linkedin.profile_visitor': visit,
  'linkedin.auto_connect': connect,
  'linkedin.message_sender': message,
  'linkedin.auto_follow': autoFollow,
  'linkedin.withdraw_invites': withdrawInvites,
  'linkedin.post_liker': postLiker,
  'linkedin.ai_post_responder': aiPostResponder,
  'linkedin.post_monitor': postMonitor,

  // internal (campaigns, approvals)
  'linkedin.visit': visit,
  'linkedin.connect': connect,
  'linkedin.message': message,
  'linkedin.comment': commentTask,
  'linkedin.check_connections': async (ctx) => {
    const limit = Number(ctx.task.params.limit ?? 80);
    const all: Rec[] = [];
    for (let s = 0; s < limit; s += 40) {
      const r = parse('linkedin.connections', await voyager(`/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED&start=${s}`));
      all.push(...r.records);
      if (r.records.length < 40) break;
      await ctx.pageWait();
    }
    if (all.length) await ctx.results(all.slice(0, limit));
    await ctx.complete({ status: 'done' });
  },
  'linkedin.check_inbox': async (ctx) => {
    const limit = Number(ctx.task.params.limit ?? 40);
    const all: Rec[] = [];
    let before = 0;
    while (all.length < limit) {
      const r = parse('linkedin.conversations', await voyager(`/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX${before ? `&createdBefore=${before}` : ''}`));
      all.push(...r.records);
      const times = r.records.map((x) => Date.parse(str(x.lastMessageAt))).filter(Number.isFinite);
      const oldest = times.length ? Math.min(...times) : 0;
      if (r.records.length < 10 || !oldest || oldest === before) break;
      before = oldest;
      await ctx.pageWait();
    }
    if (all.length) await ctx.results(all.slice(0, limit));
    await ctx.complete({ status: 'done' });
  },
};

/** Sales Navigator lead/account searches through the sales-api (needs a Sales Navigator seat). */
function salesNav(which: 'leads' | 'accounts'): Handler {
  return (ctx) => {
    const u = new URL(str(ctx.task.params.search_url));
    const saved = u.searchParams.get('savedSearchId');
    const query = u.searchParams.get('query');
    if (!saved && !query) throw new Error('Paste the full Sales Navigator search URL (it contains ?query=… or savedSearchId=…)');
    const endpoint = which === 'leads' ? 'salesApiLeadSearch' : 'salesApiAccountSearch';
    const deco = which === 'leads' ? 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14' : 'com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4';
    const q = saved ? `q=savedSearchId&savedSearchId=${enc(saved)}` : `q=searchQuery&query=${restli(query!)}`;
    return scrapePaged(ctx, async (cursor) => {
      const start = Number(cursor ?? 0) || 0;
      const raw = await voyager(`/sales-api/${endpoint}?${q}&start=${start}&count=25&decorationId=${deco}`, { accept: 'application/json' });
      const r = parse(which === 'leads' ? 'salesnav.leads' : 'salesnav.accounts', raw);
      const cap = Math.min(2500, r.total ?? 2500);
      return { ...r, nextCursor: r.records.length && start + 25 < cap ? start + 25 : null };
    }, 0);
  };
}

registerSite('linkedin', handlers);
