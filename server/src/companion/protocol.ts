/**
 * Wire contract between the Kinetic server and the Kinetic Companion browser extension.
 * Pure types and constants only — no Node imports — because the extension bundles this file.
 */

export type Site = 'linkedin' | 'instagram' | 'x' | 'facebook' | 'whatsapp' | 'reddit' | 'github';
export const EXTENSION_SITES: Site[] = ['linkedin', 'instagram', 'x', 'facebook', 'whatsapp'];

/** Home URL per site; the extension opens (or reuses) a tab here before running a task. */
export const SITE_HOME: Record<Site, string> = {
  linkedin: 'https://www.linkedin.com/feed/',
  instagram: 'https://www.instagram.com/',
  x: 'https://x.com/home',
  facebook: 'https://www.facebook.com/',
  whatsapp: 'https://web.whatsapp.com/',
  reddit: 'https://www.reddit.com/',
  github: 'https://github.com/',
};

/** A scraped/normalised record. Keys are the camelCase field keys listed in the phantom catalogue. */
export type Rec = Record<string, unknown>;

/** What every pure parser returns. `nextCursor` (when set) is passed back on the next page request. */
export interface ParseResult {
  records: Rec[];
  total?: number | null;
  nextCursor?: string | number | null;
}

/** Pacing the extension must honour while running a task (server-configured). */
export interface Pacing {
  /** Wait between two actions (connect, message, visit…), randomised in this range. */
  actionDelayMs: [number, number];
  /** Wait between two page/API requests while scraping. */
  pageDelayMs: [number, number];
  /** Hard ceiling of actions per rolling hour, across all tasks. */
  maxActionsPerHour: number;
}

/** A unit of work handed to the extension by POST /api/companion/poll. */
export interface TaskPayload {
  id: number;
  /** Handler id, e.g. "linkedin.search_export", "linkedin.connect", "linkedin.check_inbox". */
  kind: string;
  site: Site;
  /** Page to open before running (the extension reuses a tab on the same site). */
  openUrl: string;
  /** The single target this task is about (profile, post, company…), when there is one. */
  target: Rec;
  /** Phantom inputs (search URL, limits, templates…). */
  params: Rec;
  /** Resume point saved by a previous lease (pagination cursor). */
  cursor: unknown;
  /** Max records (scrapes) or actions this lease may produce before reporting back. */
  budget: number;
  pacing: Pacing;
  jobId: number | null;
  campaignId: number | null;
}

export interface PollResponse {
  task: TaskPayload | null;
  /** When no task: seconds until it's worth polling again. */
  waitSeconds: number;
  /** Why nothing was handed out (outside working hours, limits reached, paused…). */
  reason?: string;
  pausedAll?: boolean;
}

/** POST /api/companion/tasks/:id/results — a batch of records. */
export interface ResultsBatch {
  records?: Rec[];
  /** Raw captured JSON/HTML the server should parse itself: { parser: "linkedin.search", data }. */
  captures?: { parser: string; data: unknown; url?: string }[];
  cursor?: unknown;
}
export interface ResultsResponse {
  accepted: number;
  new: number;
  /** Records still allowed by today's scrape limit / the task budget. 0 means stop. */
  budgetLeft: number;
  stop?: boolean;
  reason?: string;
}

/** POST /api/companion/tasks/:id/complete */
export interface CompleteBody {
  status: 'done' | 'failed' | 'skipped';
  /** Scrape not finished (budget used up): re-queue from `cursor`. */
  more?: boolean;
  cursor?: unknown;
  /** Structured outcome, e.g. { alreadyConnected: true } or { profile: {...} }. */
  result?: Rec;
  error?: string;
  /** Actions actually performed (counted against limits). Defaults to 1 for action tasks. */
  actions?: number;
}

/** POST /api/companion/tasks/:id/error — safety stop. The server pauses the site for this browser. */
export type SafetyKind = 'rate_limited' | 'challenge' | 'logged_out' | 'restricted' | 'error';
export interface SafetyBody {
  kind: SafetyKind;
  message?: string;
  url?: string;
}

/** POST /api/companion/tasks/:id/render — personalise a note/message for a profile. */
export interface RenderBody {
  template?: string;
  profile: Rec;
}

/** Message types between the extension's service worker and its content scripts. */
export type ContentMessage =
  | { type: 'kinetic:run'; task: TaskPayload }
  | { type: 'kinetic:ping' }
  | { type: 'kinetic:abort'; taskId: number };

export type WorkerMessage =
  | { type: 'kinetic:results'; taskId: number; batch: ResultsBatch }
  | { type: 'kinetic:progress'; taskId: number; message?: string; done?: number; total?: number; cursor?: unknown }
  | { type: 'kinetic:render'; taskId: number; body: RenderBody }
  | { type: 'kinetic:complete'; taskId: number; body: CompleteBody }
  | { type: 'kinetic:safety'; taskId: number; body: SafetyBody }
  | { type: 'kinetic:captured'; url: string; data: unknown };

/** Parser ids implemented in server/src/companion/parsers (shared with the extension). */
export const PARSER_IDS = [
  // LinkedIn (Voyager JSON, normalized "included" format)
  'linkedin.search', 'linkedin.profile', 'linkedin.company', 'linkedin.reactions', 'linkedin.comments',
  'linkedin.activity', 'linkedin.group_members', 'linkedin.event_attendees', 'linkedin.browsemap',
  'linkedin.connections', 'linkedin.conversations', 'linkedin.sent_invitations',
  // LinkedIn DOM fallbacks (HTML string)
  'linkedin.search_html', 'linkedin.profile_html',
  // Sales Navigator
  'salesnav.leads', 'salesnav.accounts',
  // Instagram (web API JSON)
  'instagram.users', 'instagram.profile', 'instagram.hashtag', 'instagram.comments',
  // X / Twitter (GraphQL JSON captured from the page)
  'x.users', 'x.profile', 'x.tweets',
  // Facebook (GraphQL JSON captured from the page, or HTML)
  'facebook.members', 'facebook.page',
  // Server-side
  'reddit.listing', 'reddit.comments', 'reddit.user', 'github.users',
] as const;
export type ParserId = (typeof PARSER_IDS)[number];
