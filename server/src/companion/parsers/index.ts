/**
 * Pure parsers over captured JSON/HTML, shared by the server and the Companion extension.
 * `parse(id, raw, ctx)` never throws: a bad payload returns `{ records: [] }`.
 */
import type { ParseResult, ParserId } from '../protocol.ts';
import * as li from './linkedin.ts';
import * as sn from './salesnav.ts';
import * as ig from './instagram.ts';
import * as x from './x.ts';
import * as fb from './facebook.ts';
import * as rd from './reddit.ts';
import * as gh from './github.ts';

export type ParseCtx = { url?: string; postUrl?: string; sourceProfile?: string };

export const PARSERS: Record<ParserId, (raw: unknown, ctx?: ParseCtx) => ParseResult> = {
  'linkedin.search': (r) => li.parseSearch(r),
  'linkedin.profile': (r, c) => li.parseProfile(r, c),
  'linkedin.company': (r, c) => li.parseCompany(r, c),
  'linkedin.reactions': (r, c) => li.parseReactions(r, c),
  'linkedin.comments': (r, c) => li.parseComments(r, c),
  'linkedin.activity': (r, c) => li.parseActivity(r, c),
  'linkedin.group_members': (r) => li.parseGroupMembers(r),
  'linkedin.event_attendees': (r) => li.parseEventAttendees(r),
  'linkedin.browsemap': (r, c) => li.parseBrowsemap(r, c),
  'linkedin.connections': (r) => li.parseConnections(r),
  'linkedin.conversations': (r) => li.parseConversations(r),
  'linkedin.sent_invitations': (r) => li.parseSentInvitations(r),
  'linkedin.search_html': (r) => li.parseSearchHtml(r),
  'linkedin.profile_html': (r, c) => li.parseProfileHtml(r, c),
  'salesnav.leads': (r) => sn.parseLeads(r),
  'salesnav.accounts': (r) => sn.parseAccounts(r),
  'instagram.users': (r, c) => ig.parseUsers(r, c),
  'instagram.profile': (r) => ig.parseProfile(r),
  'instagram.hashtag': (r) => ig.parseHashtag(r),
  'instagram.comments': (r, c) => ig.parseComments(r, c),
  'x.users': (r, c) => x.parseUsers(r, c),
  'x.profile': (r) => x.parseProfile(r),
  'x.tweets': (r) => x.parseTweets(r),
  'facebook.members': (r) => fb.parseMembers(r),
  'facebook.page': (r, c) => fb.parsePage(r, c),
  'reddit.listing': (r) => rd.parseListing(r),
  'reddit.comments': (r, c) => rd.parseComments(r, c),
  'reddit.user': (r) => rd.parseUser(r),
  'github.users': (r) => gh.parseUsers(r),
};

export function parse(id: ParserId, raw: unknown, ctx?: ParseCtx): ParseResult {
  const fn = PARSERS[id];
  if (!fn) return { records: [] };
  try {
    return fn(raw, ctx);
  } catch {
    return { records: [] };
  }
}

export function isParserId(id: string): id is ParserId {
  return Object.prototype.hasOwnProperty.call(PARSERS, id);
}

export {
  linkedinProfileUrl, linkedinCompanyUrl, normalizeUrl, linkedinActivityUrn, igShortcode, tweetId, redditPostId, githubRepo,
} from './util.ts';
export { splitHeadline, activityTime } from './linkedin.ts';
