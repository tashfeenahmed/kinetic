/**
 * LinkedIn parsers over Voyager JSON (normalized `{data, included}` and GraphQL shapes)
 * plus regex-based HTML fallbacks. Defensive: unexpected shapes yield fewer records, never throws.
 */
import type { ParseResult, Rec } from '../protocol.ts';
import {
  type Any, arr, asJson, clean, decodeEntities, degree, first, get, isObj, iso, linkedinActivityUrn, linkedinCompanyUrl,
  linkedinProfileUrl, num, splitName, str, stripTags, uniqBy, walk,
} from './util.ts';

export interface ParseCtx { url?: string; postUrl?: string; sourceProfile?: string }

// ---- shared plumbing --------------------------------------------------------------

/** All entities by entityUrn (from `included`, and anywhere else in the tree). */
class Index {
  byUrn = new Map<string, Record<string, Any>>();
  all: Record<string, Any>[] = [];
  root: Any;
  constructor(raw: unknown) {
    this.root = asJson(raw);
    walk(this.root, (o) => {
      if (typeof o.entityUrn === 'string' || typeof o.$type === 'string' || typeof o._type === 'string') this.all.push(o);
      if (typeof o.entityUrn === 'string' && !this.byUrn.has(o.entityUrn)) this.byUrn.set(o.entityUrn, o);
    });
  }
  ofType(...suffixes: string[]): Record<string, Any>[] {
    return this.all.filter((o) => { const t = str(o.$type || o._type); return suffixes.some((s) => t.endsWith(s)); });
  }
  /** Follows `*key` / urn-string references to the entity, or returns the inline object. */
  ref(o: Any, key: string): Any {
    if (!isObj(o)) return undefined;
    const v = o[key];
    if (isObj(v)) return v;
    const urn = typeof v === 'string' ? v : typeof o[`*${key}`] === 'string' ? o[`*${key}`] : undefined;
    return urn ? this.byUrn.get(urn) : undefined;
  }
  refs(o: Any, key: string): Any[] {
    if (!isObj(o)) return [];
    const v = o[key] ?? o[`*${key}`];
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? this.byUrn.get(x) : x)).filter(Boolean);
    if (isObj(v) && Array.isArray(v.elements)) return v.elements.map((x: Any) => (typeof x === 'string' ? this.byUrn.get(x) : x)).filter(Boolean);
    if (typeof v === 'string') { const e = this.byUrn.get(v); return e ? [e] : []; }
    return [];
  }
}

/** The first paging object ({start,count,total}) in the response. */
function paging(root: Any): { start: number; count: number; total: number | null } | null {
  let found: { start: number; count: number; total: number | null } | null = null;
  walk(root, (o) => {
    if (found) return;
    const p = o.paging;
    if (isObj(p) && typeof p.start === 'number' && typeof p.count === 'number') found = { start: p.start, count: p.count, total: num(p.total) };
  });
  return found;
}

function pagedResult(root: Any, records: Rec[]): ParseResult {
  const p = paging(root);
  if (!p) return { records, total: null, nextCursor: null };
  const step = p.count || records.length;
  const next = p.start + step;
  const more = p.total != null ? next < p.total : records.length > 0;
  return { records, total: p.total, nextCursor: more && step > 0 && records.length > 0 ? next : null };
}

const text = (v: Any): string => (typeof v === 'string' ? v.trim() : first(v?.text, v?.text?.text, v?.accessibilityText));

/** "Head of Growth at Acme" → title + company. */
export function splitHeadline(headline: string): { title: string; company: string } {
  const h = headline.trim();
  const m = /^(.*?)\s+(?:at|@|bei|chez|en)\s+(.+)$/i.exec(h);
  if (!m) return { title: h, company: '' };
  return { title: m[1].trim(), company: m[2].split(/\s+[|•·]\s+/)[0].trim() };
}

function memberUrnFrom(...vals: unknown[]): string {
  for (const v of vals) {
    const m = /urn:li:fsd_profile:([A-Za-z0-9_-]+)/.exec(str(v));
    if (m) return `urn:li:fsd_profile:${m[1]}`;
  }
  for (const v of vals) {
    const m = /urn:li:fs_miniProfile:([A-Za-z0-9_-]+)/.exec(str(v));
    if (m) return `urn:li:fsd_profile:${m[1]}`;
  }
  return '';
}

function profileUrlFromNav(nav: string): string {
  return /linkedin\.com\/in\/|^\/in\//.test(nav) ? linkedinProfileUrl(nav.startsWith('/') ? `https://www.linkedin.com${nav}` : nav) : '';
}

function isProfile(o: Any): boolean {
  if (!isObj(o)) return false;
  const t = str(o.$type || o._type);
  if (/identity\.profile\.Profile$|identity\.shared\.MiniProfile$|MiniProfile$/.test(t)) return true;
  return typeof o.publicIdentifier === 'string' && (typeof o.firstName === 'string' || isObj(o.firstName));
}

/** A person record from a Profile / MiniProfile entity. */
export function personFromProfile(p: Any): Rec {
  const firstName = text(p.firstName);
  const lastName = text(p.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const headline = text(p.headline) || text(p.occupation);
  const hl = splitHeadline(headline);
  const location = first(get(p, 'geoLocation.geo.defaultLocalizedName'), get(p, 'geoLocation.geo.defaultLocalizedNameWithoutCountryName'), p.locationName, get(p, 'location.defaultLocalizedName'), p.geoLocationName);
  return clean({
    fullName, firstName, lastName, headline, title: hl.title, company: hl.company, location,
    profileUrl: p.publicIdentifier ? linkedinProfileUrl(p.publicIdentifier) : '',
    publicId: str(p.publicIdentifier),
    memberUrn: memberUrnFrom(p.entityUrn, p.objectUrn, p.dashEntityUrn),
    connectionDegree: degree(get(p, 'memberRelationship.memberRelationship.noConnection.memberDistance') ?? (get(p, 'memberRelationship.memberRelationship.connection') ? 1 : p.distance?.value ?? p.distance)),
  });
}

/** A person from a "lockup" (title/subtitle/navigationUrl view model). */
function personFromLockup(l: Any): Rec | null {
  const nav = first(l.navigationUrl, get(l, 'navigationContext.url'), get(l, 'navigationContext.actionTarget'));
  const profileUrl = profileUrlFromNav(nav);
  const fullName = text(l.title) || text(l.name);
  if (!profileUrl || !fullName || /^LinkedIn Member$/i.test(fullName)) return null;
  const headline = text(l.primarySubtitle) || text(l.subtitle) || text(l.caption);
  const hl = splitHeadline(headline);
  const { firstName, lastName } = splitName(fullName);
  const badge = first(get(l, 'badgeText.text'), get(l, 'badgeText.accessibilityText'), get(l, 'entityCustomTrackingInfo.memberDistance'), get(l, 'supplementaryActorInfo.text'));
  return clean({
    fullName, firstName, lastName, headline, title: hl.title, company: hl.company,
    location: text(l.secondarySubtitle), profileUrl,
    memberUrn: memberUrnFrom(l.entityUrn, l.trackingUrn, nav, l.image?.attributes?.[0]?.detailData?.['*profilePicture'], l.actorUrn),
    connectionDegree: degree(badge),
  });
}

function personKey(r: Rec) { return str(r.profileUrl).toLowerCase() || str(r.memberUrn); }

/** People from any response: Profile entities and lockups that link to /in/. */
function peopleFromAny(idx: Index): Rec[] {
  const out: Rec[] = [];
  for (const o of idx.all) {
    const t = str(o.$type || o._type);
    if (/EntityResultViewModel$/.test(t) || (o.navigationUrl && o.title)) { const p = personFromLockup(o); if (p) out.push(p); }
  }
  walk(idx.root, (o) => {
    if (!o.$type && !o._type && o.navigationUrl && isObj(o.title)) { const p = personFromLockup(o); if (p) out.push(p); }
  });
  for (const o of idx.all) if (isProfile(o)) { const p = personFromProfile(o); if (p.profileUrl && p.fullName) out.push(p); }
  return uniqBy(out, personKey);
}

// ---- search ------------------------------------------------------------------------

export function parseSearch(raw: unknown): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const results = idx.ofType('EntityResultViewModel');
  const items = results.length ? results : (() => {
    const found: Any[] = [];
    walk(idx.root, (o) => { if (o.navigationUrl && isObj(o.title) && (o.primarySubtitle || o.secondarySubtitle)) found.push(o); });
    return found;
  })();
  for (const it of items) {
    const p = personFromLockup(it);
    if (!p) continue;
    // Dash search results often reference the profile; enrich with its public id.
    records.push(p);
  }
  return pagedResult(idx.root, uniqBy(records, personKey));
}

/** Regex fallback over the people search results page HTML. */
export function parseSearchHtml(raw: unknown): ParseResult {
  const html = typeof raw === 'string' ? raw : '';
  const records: Rec[] = [];
  const chunks = html.split(/<li\b[^>]*(?:result-container|reusable-search__result|search-result|data-chameleon-result-urn)[^>]*>/i).slice(1);
  for (const chunk of chunks) {
    const link = /href="([^"]*linkedin\.com\/in\/[^"?#]+|\/in\/[^"?#]+)[^"]*"/i.exec(chunk);
    if (!link) continue;
    const profileUrl = profileUrlFromNav(decodeEntities(link[1]));
    const nameM = /<span[^>]*aria-hidden="true"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk) ?? /<a[^>]*\/in\/[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    const fullName = nameM ? stripTags(nameM[1]) : '';
    if (!fullName || /^LinkedIn Member$/i.test(fullName)) continue;
    const cls = (c: string) => { const m = new RegExp(`<div[^>]*class="[^"]*${c}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i').exec(chunk); return m ? stripTags(m[1]) : ''; };
    const headline = cls('primary-subtitle');
    const hl = splitHeadline(headline);
    const degM = /(1st|2nd|3rd\+?)/.exec(stripTags(chunk));
    records.push(clean({ fullName, ...splitName(fullName), headline, title: hl.title, company: hl.company, location: cls('secondary-subtitle'), profileUrl, connectionDegree: degM ? degree(degM[1]) : '' }));
  }
  return { records: uniqBy(records, personKey), nextCursor: null };
}

// ---- profile -----------------------------------------------------------------------

function dateRange(d: Any): string {
  const ym = (x: Any) => (x?.year ? `${x.year}${x.month ? `-${String(x.month).padStart(2, '0')}` : ''}` : '');
  const s = ym(d?.start ?? d?.startDate);
  const e = d?.end ?? d?.endDate ? ym(d?.end ?? d?.endDate) : 'present';
  return s ? `${s}–${e}` : '';
}

export function parseProfile(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const profiles = idx.all.filter(isProfile);
  if (!profiles.length) return { records: [] };
  const wanted = ctx.url ? (/linkedin\.com\/in\/([^/?#]+)/i.exec(ctx.url)?.[1] ?? '') : '';
  let wantedId = wanted;
  try { wantedId = decodeURIComponent(wanted).toLowerCase(); } catch { /* keep */ }
  const p = profiles.find((x) => wantedId && str(x.publicIdentifier).toLowerCase() === wantedId)
    ?? profiles.find((x) => x.summary !== undefined || x.headline !== undefined && x.geoLocation)
    ?? profiles.find((x) => /identity\.profile\.Profile$/.test(str(x.$type)))
    ?? profiles[0];
  const rec: Rec = personFromProfile(p);
  rec.about = text(p.summary) || text(p.about);
  rec.industry = first(get(p, 'industry.name'), p.industryName, get(idx.ref(p, 'industry'), 'name'));

  // Positions: dash Position entities (or legacy positionView) — current first.
  const positions = idx.ofType('identity.profile.Position', 'identity.profile.PositionGroup', 'voyager.identity.profile.Position')
    .filter((x) => x.title || x.companyName);
  const posSorted = [...positions].sort((a, b) => Number(!!(a.dateRange?.end ?? a.timePeriod?.endDate)) - Number(!!(b.dateRange?.end ?? b.timePeriod?.endDate)));
  const current = posSorted.find((x) => !(x.dateRange?.end ?? x.timePeriod?.endDate)) ?? posSorted[0];
  if (current) {
    if (current.title) rec.title = str(current.title);
    if (current.companyName) rec.company = str(current.companyName);
    const co = idx.ref(current, 'company') ?? idx.byUrn.get(str(current.companyUrn));
    const uni = first(co?.universalName, get(current, 'company.universalName'));
    if (uni) rec.companyUrl = linkedinCompanyUrl(uni);
    else if (/fsd_company:(\d+)/.test(str(current.companyUrn))) rec.companyUrl = linkedinCompanyUrl(/fsd_company:(\d+)/.exec(str(current.companyUrn))![1]);
    const site = first(co?.websiteUrl, co?.companyPageUrl);
    if (site) rec.companyDomain = site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  }
  rec.experience = posSorted.slice(0, 10).map((x) => [str(x.title), str(x.companyName)].filter(Boolean).join(' @ ') + (dateRange(x.dateRange ?? x.timePeriod) ? ` (${dateRange(x.dateRange ?? x.timePeriod)})` : '')).join('; ');
  const edu = idx.ofType('identity.profile.Education').filter((x) => x.schoolName);
  rec.education = edu.slice(0, 5).map((x) => [str(x.schoolName), str(x.degreeName), str(x.fieldOfStudy)].filter(Boolean).join(', ')).join('; ');
  const skills = idx.ofType('identity.profile.Skill').map((x) => str(x.name)).filter(Boolean);
  rec.skills = [...new Set(skills)].slice(0, 30).join(', ');
  const followers = num(get(p, 'followingState.followerCount')) ?? num(idx.ofType('FollowingState', 'FollowingInfo').map((x) => x.followerCount).find((x) => x != null));
  if (followers != null) rec.followers = followers;
  const conns = num(get(p, 'connections.paging.total')) ?? num(p.connectionsCount);
  if (conns != null) rec.connections = conns;
  const contact = idx.ofType('ProfileContactInfo', 'ContactInfo')[0] ?? p;
  rec.email = first(get(contact, 'emailAddress.emailAddress'), contact?.emailAddress);
  rec.website = first(get(contact, 'websites.0.url'), get(p, 'websites.0.url'), get(p, 'creatorWebsite.url'));
  // Degree may live in a separate MemberRelationship entity.
  if (!rec.connectionDegree) {
    const rel = idx.ofType('MemberRelationship')[0];
    if (rel) rec.connectionDegree = get(rel, 'memberRelationship.connection') || get(rel, 'memberRelationshipUnion.connection') ? '1st'
      : degree(get(rel, 'memberRelationship.noConnection.memberDistance') ?? get(rel, 'memberRelationshipUnion.noConnection.memberDistance'));
  }
  const pending = idx.all.some((o) => get(o, 'memberRelationship.noConnection.invitation') || get(o, 'memberRelationshipUnion.noConnection.invitationUnion.invitation'));
  if (pending) rec.pendingInvite = true;
  return { records: [clean(rec)] };
}

/** Regex fallback over a profile page's HTML. */
export function parseProfileHtml(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const html = typeof raw === 'string' ? raw : '';
  const pick = (re: RegExp) => { const m = re.exec(html); return m ? stripTags(m[1]) : ''; };
  const fullName = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || pick(/<meta[^>]*property="og:title"[^>]*content="([^"]*?)(?:\s*[|–-]\s*LinkedIn)?"/i);
  if (!fullName) return { records: [] };
  const headline = pick(/<div[^>]*class="[^"]*text-body-medium[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const location = pick(/<span[^>]*class="[^"]*text-body-small inline[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const canon = /<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html)?.[1] ?? ctx.url ?? '';
  const about = pick(/<section[^>]*id="about"[\s\S]*?<span[^>]*aria-hidden="true"[^>]*>([\s\S]*?)<\/span>/i);
  const hl = splitHeadline(headline);
  const degM = /class="[^"]*dist-value[^"]*"[^>]*>\s*(1st|2nd|3rd)/i.exec(html);
  return { records: [clean({ fullName, ...splitName(fullName), headline, title: hl.title, company: hl.company, location, about, profileUrl: profileUrlFromNav(canon) || canon, connectionDegree: degM ? degree(degM[1]) : '' })] };
}

// ---- company -----------------------------------------------------------------------

export function parseCompany(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const companies = idx.ofType('organization.Company', 'organization.shared.Company').filter((c) => c.name);
  const fallback = !companies.length ? idx.all.filter((o) => o.universalName && o.name) : [];
  const all = companies.length ? companies : fallback;
  if (!all.length) return { records: [] };
  const wanted = ctx.url ? (/\/(?:company|school|showcase)\/([^/?#]+)/i.exec(ctx.url)?.[1] ?? '').toLowerCase() : '';
  const c = all.find((x) => wanted && (str(x.universalName).toLowerCase() === wanted || str(x.entityUrn).endsWith(`:${wanted}`)))
    ?? all.find((x) => x.description || x.websiteUrl || x.companyPageUrl) ?? all[0];
  const website = first(c.websiteUrl, c.companyPageUrl, get(c, 'callToAction.url'));
  const range = c.staffCountRange ?? c.employeeCountRange;
  const size = range ? (range.end ? `${range.start}-${range.end}` : `${range.start}+`) : '';
  const hq = c.headquarter ?? c.headquarter?.address ?? get(c, 'headquarter.address') ?? get(c, 'groupedLocations.0.headquarterLocation');
  const addr = hq?.address ?? hq;
  const headquarters = [addr?.city, addr?.geographicArea, addr?.country].map(str).filter(Boolean).join(', ');
  const industries = [...arr(c.industries).map((i: Any) => text(i?.name) || str(i?.localizedName) || str(i)), ...arr(c.companyIndustries).map((i: Any) => str(i?.localizedName))].filter(Boolean);
  const industryRefs = idx.refs(c, 'industry').map((i: Any) => str(i?.name)).filter(Boolean);
  const followers = num(get(c, 'followingInfo.followerCount')) ?? num(get(c, 'followingState.followerCount')) ?? num(idx.ofType('FollowingState', 'FollowingInfo').map((x) => x.followerCount).find((x) => x != null));
  const universal = str(c.universalName);
  const id = /(?:fsd_company|fs_normalized_company|company):(\d+)/.exec(str(c.entityUrn))?.[1];
  return {
    records: [clean({
      name: text(c.name) || str(c.name),
      companyUrl: universal ? linkedinCompanyUrl(universal) : first(c.url && /linkedin\.com\/company/.test(c.url) ? linkedinCompanyUrl(c.url) : '', id ? linkedinCompanyUrl(id) : ''),
      universalName: universal,
      companyId: id,
      website,
      domain: website ? website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').toLowerCase() : '',
      industry: industries[0] || industryRefs[0] || '',
      employeeCount: num(c.staffCount) ?? num(c.employeeCount) ?? undefined,
      size,
      headquarters,
      founded: num(get(c, 'foundedOn.year')) ?? undefined,
      followers: followers ?? undefined,
      specialties: arr(c.specialities ?? c.specialties).map(str).filter(Boolean).join(', '),
      description: text(c.description) || str(c.tagline),
    })],
  };
}

// ---- engagement --------------------------------------------------------------------

export function parseReactions(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const reactions = idx.ofType('social.Reaction', 'feed.social.Reaction', 'socialDashReaction').filter(Boolean);
  const items = reactions.length ? reactions : idx.all.filter((o) => o.reactorLockup);
  for (const r of items) {
    const lock = r.reactorLockup ?? r.reactor;
    let p: Rec | null = lock ? personFromLockup(lock) : null;
    if (!p) { const prof = idx.ref(r, 'reactor') ?? idx.ref(r, 'actor'); if (prof && isProfile(prof)) p = personFromProfile(prof); }
    if (!p?.profileUrl) continue;
    records.push(clean({ ...p, engagement: 'reaction', reactionType: str(r.reactionType), postUrl: ctx.postUrl ?? '' }));
  }
  return pagedResult(idx.root, uniqBy(records, personKey));
}

export function parseComments(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const comments = idx.ofType('social.Comment', 'feed.social.Comment').filter((c) => c.commenter || c.commentary || c.commentV2);
  for (const c of comments) {
    const commenter = c.commenter ?? {};
    let p: Rec | null = personFromLockup({ ...commenter, title: commenter.title, navigationUrl: commenter.navigationUrl ?? get(commenter, 'navigationContext.actionTarget'), primarySubtitle: commenter.subtitle });
    if (!p) {
      const prof = idx.ref(commenter, 'commenterProfile') ?? idx.ref(commenter, 'profile') ?? idx.ref(c, 'commenterProfile');
      if (prof && isProfile(prof)) p = personFromProfile(prof);
      const mini = get(commenter, 'com.linkedin.voyager.feed.MemberActor.miniProfile');
      if (!p && mini) p = personFromProfile(typeof mini === 'string' ? idx.byUrn.get(mini) ?? {} : mini);
    }
    if (!p?.profileUrl) continue;
    const at = c.createdAt ?? c.created?.time;
    records.push(clean({
      ...p, engagement: 'comment', commentText: text(c.commentary) || text(get(c, 'commentV2')) || text(get(c, 'comment.values.0.value')),
      postUrl: ctx.postUrl ?? '', engagedAt: iso(at),
    }));
  }
  return pagedResult(idx.root, uniqBy(records, (r) => `${personKey(r)}|${r.commentText}`));
}

/** Timestamp (ms) encoded in a LinkedIn activity id. */
export function activityTime(urn: string): string {
  const m = /(\d{15,22})/.exec(urn);
  if (!m) return '';
  try { return iso(Number(BigInt(m[1]) >> 22n)); } catch { return ''; }
}

export function parseActivity(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const updates = idx.ofType('feed.Update', 'feed.UpdateV2');
  for (const u of updates) {
    const urn = linkedinActivityUrn(first(get(u, 'metadata.backendUrn'), get(u, 'updateMetadata.urn'), u.entityUrn, u.urn)) ?? '';
    if (!urn) continue;
    if (u.resharedUpdate && !u.commentary) continue; // pure reposts carry no text of their own
    const actor = u.actor ?? {};
    const counts = idx.byUrn.get(`urn:li:fsd_socialActivityCounts:${urn}`)
      ?? idx.ofType('SocialActivityCounts').find((x) => str(x.entityUrn).includes(urn.split(':').pop()!))
      ?? idx.ref(idx.ref(u, 'socialDetail') ?? {}, 'totalSocialActivityCounts') ?? {};
    const authorNav = first(get(actor, 'navigationContext.actionTarget'), get(actor, 'navigationUrl'));
    const authorUrl = profileUrlFromNav(authorNav) || (/\/company\//.test(authorNav) ? linkedinCompanyUrl(authorNav) : '') || ctx.sourceProfile || '';
    records.push(clean({
      authorName: text(actor.name) || text(get(actor, 'name.text')),
      authorUrl,
      postUrl: `https://www.linkedin.com/feed/update/${urn}/`,
      postUrn: urn,
      text: text(get(u, 'commentary.text')) || text(u.commentary),
      postedAt: activityTime(urn),
      reactions: num(counts.numLikes) ?? undefined,
      comments: num(counts.numComments) ?? undefined,
      reposts: num(counts.numShares) ?? undefined,
    }));
  }
  return pagedResult(idx.root, uniqBy(records, (r) => str(r.postUrl)));
}

// ---- lists of people (groups, events, browsemap) ----------------------------------

export function parseGroupMembers(raw: unknown): ParseResult {
  const idx = new Index(raw);
  return pagedResult(idx.root, peopleFromAny(idx));
}
export const parseEventAttendees = parseGroupMembers;
export function parseBrowsemap(raw: unknown, ctx: ParseCtx = {}): ParseResult {
  const idx = new Index(raw);
  const src = ctx.sourceProfile ? linkedinProfileUrl(ctx.sourceProfile).toLowerCase() : '';
  const records = peopleFromAny(idx).filter((r) => str(r.profileUrl).toLowerCase() !== src).map((r) => clean({ ...r, sourceProfile: ctx.sourceProfile ?? '' }));
  return { records, nextCursor: null };
}

// ---- connections -------------------------------------------------------------------

export function parseConnections(raw: unknown): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const conns = idx.ofType('relationships.Connection', 'relationships.shared.connection.Connection').concat(idx.all.filter((o) => (o.connectedMember || o['*connectedMember'] || o.connectedMemberResolutionResult) && !str(o.$type).endsWith('Connection')));
  for (const c of conns) {
    const prof = idx.ref(c, 'connectedMemberResolutionResult') ?? idx.ref(c, 'connectedMember') ?? idx.ref(c, 'miniProfile');
    if (!prof || !isProfile(prof)) continue;
    const p = personFromProfile(prof);
    if (!p.profileUrl) continue;
    records.push(clean({ ...p, connectionDegree: '1st', connectedAt: iso(c.createdAt) }));
  }
  return pagedResult(idx.root, uniqBy(records, personKey));
}

// ---- messaging ---------------------------------------------------------------------

function participantPerson(idx: Index, part: Any): Rec {
  const m = get(part, 'participantType.member') ?? get(part, 'participantType.organization') ?? {};
  const name = [text(m.firstName), text(m.lastName)].filter(Boolean).join(' ') || text(m.name);
  return clean({
    participantName: name,
    participantUrl: m.profileUrl ? linkedinProfileUrl(str(m.profileUrl)) : profileUrlFromNav(str(get(part, 'participantType.member.profileUrl'))),
    participantHeadline: text(m.headline),
    participantUrn: memberUrnFrom(part.hostIdentityUrn, part.entityUrn),
  });
}

export function parseConversations(raw: unknown): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const convs = idx.ofType('messenger.Conversation').concat(idx.all.filter((o) => !o.$type && (o.conversationParticipants || o['*conversationParticipants']) && o.entityUrn));
  for (const c of convs) {
    const me = memberUrnFrom(/msg_conversation:\((urn:li:fsd_profile:[^,]+),/.exec(str(c.entityUrn))?.[1]);
    const parts = idx.refs(c, 'conversationParticipants');
    const other = parts.find((p: Any) => memberUrnFrom(p.hostIdentityUrn, p.entityUrn) !== me) ?? parts[0];
    if (!other) continue;
    const msgs = idx.refs(c, 'messages').sort((a: Any, b: Any) => (num(b.deliveredAt) ?? 0) - (num(a.deliveredAt) ?? 0));
    const last = msgs[0];
    const sender = last ? (idx.ref(last, 'sender') ?? last.sender) : null;
    const senderUrn = memberUrnFrom(sender?.hostIdentityUrn, sender?.entityUrn, last?.['*sender']);
    const convId = /,([^)]+)\)$/.exec(str(c.entityUrn))?.[1];
    records.push(clean({
      ...participantPerson(idx, other),
      conversationUrl: first(c.conversationUrl, convId ? `https://www.linkedin.com/messaging/thread/${convId}/` : ''),
      conversationUrn: str(c.entityUrn),
      lastMessage: text(get(last, 'body')) || text(get(last, 'body.text')),
      lastSender: last ? (senderUrn && senderUrn === me ? 'me' : 'them') : '',
      lastMessageAt: iso(last?.deliveredAt ?? c.lastActivityAt),
      unread: typeof c.read === 'boolean' ? !c.read : (num(c.unreadCount) ?? 0) > 0,
    }));
  }
  return { records: uniqBy(records, (r) => str(r.conversationUrn) || str(r.conversationUrl)), nextCursor: null };
}

// ---- sent invitations --------------------------------------------------------------

export function parseSentInvitations(raw: unknown): ParseResult {
  const idx = new Index(raw);
  const records: Rec[] = [];
  const seen = new Set<Any>();
  walk(idx.root, (o) => {
    const inv = isObj(o.invitation) ? o.invitation : (typeof o['*invitation'] === 'string' ? idx.byUrn.get(o['*invitation']) : (o.sharedSecret ? o : null));
    if (!inv || seen.has(inv) || !inv.sharedSecret) return;
    seen.add(inv);
    // The invitee: inline profile, urn ref, or a lockup (title/navigationUrl) on the view.
    let person: Rec | null = null;
    for (const key of ['inviteeMemberResolutionResult', 'inviteeMember', 'toMember', 'invitee']) {
      const ref = idx.ref(inv, key);
      const prof = ref && (isProfile(ref) ? ref : (ref.miniProfile ? (idx.ref(ref, 'miniProfile') ?? ref.miniProfile) : null) ?? (ref['com.linkedin.voyager.relationships.invitation.ProfileInvitee'] ? idx.ref(ref['com.linkedin.voyager.relationships.invitation.ProfileInvitee'], 'miniProfile') : null));
      if (prof && isProfile(prof)) { person = personFromProfile(prof); break; }
    }
    if (!person && o !== inv) person = personFromLockup(o) ?? null;
    if (!person) walk(inv, (x) => { if (!person && isProfile(x)) person = personFromProfile(x); });
    const id = /(?:fs_relInvitation|fsd_invitation|invitation):(\d+)/.exec(str(inv.entityUrn))?.[1] ?? str(inv.invitationId);
    records.push(clean({
      ...(person ?? {}),
      sentAt: iso(inv.sentTime ?? inv.sentAt),
      invitationId: id,
      invitationUrn: str(inv.entityUrn),
      sharedSecret: str(inv.sharedSecret),
    }));
  });
  return pagedResult(idx.root, uniqBy(records, (r) => str(r.invitationUrn) || str(r.invitationId)));
}
