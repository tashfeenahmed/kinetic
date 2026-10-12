/**
 * The phantom catalogue: every automation the Companion can run, with an input form schema
 * (so the UI and the agent create jobs generically), the limit bucket it spends, and the
 * output fields that become table columns.
 */
import type { Site } from './protocol.ts';

export type Network = 'linkedin' | 'sales_navigator' | 'instagram' | 'x' | 'facebook' | 'reddit' | 'github';
export type Category = 'data' | 'action' | 'monitor';
export type FieldType = 'text' | 'textarea' | 'url' | 'number' | 'select' | 'boolean' | 'targets' | 'template';

export interface PhantomField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}
export interface PhantomOutput { key: string; label: string }

export interface Phantom {
  id: string;
  network: Network;
  site: Site;
  category: Category;
  label: string;
  description: string;
  /** extension: runs in the user's browser; server: runs on the Kinetic server (public APIs). */
  runner: 'extension' | 'server';
  /** Limit bucket each unit of work spends (see DEFAULT_LIMITS). */
  action: string | null;
  /** One task per entry of the `targets` field (profile lists, post lists…); otherwise a single paged task. */
  perTarget: boolean;
  fields: PhantomField[];
  outputs: PhantomOutput[];
  /** Output field used to dedupe rows (and watcher "new only" detection). */
  dedupeKey: string;
  /** Can be scheduled to re-run and add only new results. */
  watchable: boolean;
  /** Actions that send, post or change something on the network. Jobs stay drafts until started. */
  sends?: boolean;
}

/** Default daily/weekly limits per bucket. All configurable on the limits page. */
export const DEFAULT_LIMITS: Record<string, { label: string; daily: number; weekly?: number }> = {
  'linkedin.connect': { label: 'LinkedIn connection requests', daily: 20, weekly: 100 },
  'linkedin.message': { label: 'LinkedIn messages', daily: 50 },
  'linkedin.visit': { label: 'LinkedIn profile visits', daily: 80 },
  'linkedin.scrape': { label: 'LinkedIn profiles scraped', daily: 1000 },
  'linkedin.follow': { label: 'LinkedIn follows', daily: 40 },
  'linkedin.like': { label: 'LinkedIn post likes', daily: 60 },
  'linkedin.comment': { label: 'LinkedIn comments', daily: 15 },
  'linkedin.withdraw': { label: 'LinkedIn invites withdrawn', daily: 40 },
  'instagram.scrape': { label: 'Instagram profiles scraped', daily: 800 },
  'x.scrape': { label: 'X profiles/posts scraped', daily: 1000 },
  'facebook.scrape': { label: 'Facebook profiles scraped', daily: 500 },
};

// ---- shared field and output sets -------------------------------------------------

const limit = (def = 100, max = 2500): PhantomField => ({ key: 'limit', label: 'Max results', type: 'number', default: def, min: 1, max, help: 'Stops after this many results. Daily scrape limits still apply.' });
const targets = (label: string, placeholder: string, help?: string): PhantomField => ({
  key: 'targets', label, type: 'targets', required: true, placeholder,
  help: help ?? 'One URL per line, or pick a table column that holds them.',
});

const PERSON: PhantomOutput[] = [
  { key: 'fullName', label: 'Full name' }, { key: 'firstName', label: 'First name' }, { key: 'lastName', label: 'Last name' },
  { key: 'headline', label: 'Headline' }, { key: 'title', label: 'Title' }, { key: 'company', label: 'Company' },
  { key: 'location', label: 'Location' }, { key: 'profileUrl', label: 'LinkedIn URL' }, { key: 'connectionDegree', label: 'Degree' },
];
const PROFILE: PhantomOutput[] = [
  ...PERSON,
  { key: 'about', label: 'About' }, { key: 'industry', label: 'Industry' }, { key: 'companyUrl', label: 'Company LinkedIn' },
  { key: 'companyDomain', label: 'Company domain' }, { key: 'experience', label: 'Experience' }, { key: 'education', label: 'Education' },
  { key: 'skills', label: 'Skills' }, { key: 'followers', label: 'Followers' }, { key: 'connections', label: 'Connections' },
  { key: 'email', label: 'Email' }, { key: 'website', label: 'Website' },
];
const COMPANY: PhantomOutput[] = [
  { key: 'name', label: 'Company' }, { key: 'companyUrl', label: 'Company LinkedIn' }, { key: 'website', label: 'Website' },
  { key: 'domain', label: 'Company domain' }, { key: 'industry', label: 'Industry' }, { key: 'employeeCount', label: 'Employees on LinkedIn' },
  { key: 'size', label: 'Company size' }, { key: 'headquarters', label: 'Headquarters' }, { key: 'founded', label: 'Founded' },
  { key: 'followers', label: 'Followers' }, { key: 'specialties', label: 'Specialties' }, { key: 'description', label: 'Description' },
];
const ENGAGER: PhantomOutput[] = [
  { key: 'fullName', label: 'Full name' }, { key: 'headline', label: 'Headline' }, { key: 'profileUrl', label: 'LinkedIn URL' },
  { key: 'connectionDegree', label: 'Degree' }, { key: 'engagement', label: 'Engagement' }, { key: 'reactionType', label: 'Reaction' },
  { key: 'commentText', label: 'Comment' }, { key: 'postUrl', label: 'Post URL' }, { key: 'engagedAt', label: 'Engaged at' },
];
const POST: PhantomOutput[] = [
  { key: 'authorName', label: 'Author' }, { key: 'authorUrl', label: 'Author URL' }, { key: 'postUrl', label: 'Post URL' },
  { key: 'text', label: 'Text' }, { key: 'postedAt', label: 'Posted' }, { key: 'reactions', label: 'Reactions' },
  { key: 'comments', label: 'Comments' }, { key: 'reposts', label: 'Reposts' },
];
const ACTION_RESULT: PhantomOutput[] = [
  { key: 'profileUrl', label: 'LinkedIn URL' }, { key: 'fullName', label: 'Full name' }, { key: 'status', label: 'Status' },
  { key: 'detail', label: 'Detail' }, { key: 'sentText', label: 'Sent text' }, { key: 'at', label: 'At' },
];
const SALESNAV_LEAD: PhantomOutput[] = [
  { key: 'fullName', label: 'Full name' }, { key: 'firstName', label: 'First name' }, { key: 'lastName', label: 'Last name' },
  { key: 'title', label: 'Title' }, { key: 'company', label: 'Company' }, { key: 'location', label: 'Location' },
  { key: 'tenure', label: 'Time in role' }, { key: 'salesNavUrl', label: 'Sales Navigator URL' }, { key: 'profileUrl', label: 'LinkedIn URL' },
  { key: 'connectionDegree', label: 'Degree' }, { key: 'premium', label: 'Premium' },
];
const SALESNAV_ACCOUNT: PhantomOutput[] = [
  { key: 'name', label: 'Company' }, { key: 'industry', label: 'Industry' }, { key: 'employeeCount', label: 'Employees' },
  { key: 'location', label: 'Location' }, { key: 'salesNavUrl', label: 'Sales Navigator URL' }, { key: 'companyUrl', label: 'Company LinkedIn' },
  { key: 'description', label: 'Description' },
];
const IG_USER: PhantomOutput[] = [
  { key: 'username', label: 'Username' }, { key: 'fullName', label: 'Full name' }, { key: 'profileUrl', label: 'Instagram URL' },
  { key: 'bio', label: 'Bio' }, { key: 'followers', label: 'Followers' }, { key: 'following', label: 'Following' },
  { key: 'posts', label: 'Posts' }, { key: 'isPrivate', label: 'Private' }, { key: 'isVerified', label: 'Verified' },
  { key: 'externalUrl', label: 'Website' }, { key: 'category', label: 'Category' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
];
const X_USER: PhantomOutput[] = [
  { key: 'username', label: 'Username' }, { key: 'name', label: 'Name' }, { key: 'profileUrl', label: 'X URL' },
  { key: 'bio', label: 'Bio' }, { key: 'followers', label: 'Followers' }, { key: 'following', label: 'Following' },
  { key: 'tweets', label: 'Posts' }, { key: 'location', label: 'Location' }, { key: 'website', label: 'Website' },
  { key: 'verified', label: 'Verified' }, { key: 'createdAt', label: 'Joined' },
];
const FB_MEMBER: PhantomOutput[] = [
  { key: 'name', label: 'Name' }, { key: 'profileUrl', label: 'Facebook URL' }, { key: 'id', label: 'Facebook ID' },
  { key: 'bio', label: 'Bio' }, { key: 'joined', label: 'Joined / status' },
];
const REDDIT_POST: PhantomOutput[] = [
  { key: 'title', label: 'Title' }, { key: 'author', label: 'Author' }, { key: 'authorUrl', label: 'Author URL' },
  { key: 'subreddit', label: 'Subreddit' }, { key: 'postUrl', label: 'Post URL' }, { key: 'url', label: 'Link' },
  { key: 'score', label: 'Score' }, { key: 'comments', label: 'Comments' }, { key: 'flair', label: 'Flair' },
  { key: 'text', label: 'Text' }, { key: 'createdAt', label: 'Posted' },
];
const REDDIT_COMMENT: PhantomOutput[] = [
  { key: 'author', label: 'Author' }, { key: 'authorUrl', label: 'Author URL' }, { key: 'text', label: 'Comment' },
  { key: 'score', label: 'Score' }, { key: 'permalink', label: 'Comment URL' }, { key: 'postUrl', label: 'Post URL' }, { key: 'createdAt', label: 'Posted' },
];
const REDDIT_USER: PhantomOutput[] = [
  { key: 'username', label: 'Username' }, { key: 'profileUrl', label: 'Reddit URL' }, { key: 'linkKarma', label: 'Post karma' },
  { key: 'commentKarma', label: 'Comment karma' }, { key: 'createdAt', label: 'Joined' }, { key: 'bio', label: 'Bio' },
  { key: 'recentSubreddits', label: 'Active in' }, { key: 'recentActivity', label: 'Recent activity' },
];
const GITHUB_USER: PhantomOutput[] = [
  { key: 'login', label: 'GitHub username' }, { key: 'name', label: 'Full name' }, { key: 'githubUrl', label: 'GitHub' },
  { key: 'company', label: 'Company' }, { key: 'email', label: 'Email' }, { key: 'location', label: 'Location' },
  { key: 'website', label: 'Website' }, { key: 'twitter', label: 'X / Twitter' }, { key: 'bio', label: 'Bio' },
  { key: 'followers', label: 'Followers' }, { key: 'contributions', label: 'Contributions' },
];

const noteTemplate: PhantomField = {
  key: 'note', label: 'Invitation note', type: 'template', max: 300,
  placeholder: '{Hi|Hello} {first_name}, {ai_message}',
  help: 'Optional, max 300 characters. Variables: {first_name} {last_name} {company} {title} {location} {headline}, any input-table column as {Column name}, spintax {a|b|c}, and {ai_message} for an AI-written line. Leave empty to invite without a note.',
};
const aiInstructions: PhantomField = {
  key: 'ai_instructions', label: 'AI message instructions', type: 'textarea',
  placeholder: 'One friendly sentence referencing their role or a recent post. No pitch. Max 200 characters.',
  help: 'Used to write {ai_message} per profile with your OpenRouter model.',
};

// ---- the catalogue -----------------------------------------------------------------

const li = (p: Omit<Phantom, 'network' | 'site' | 'runner'> & Partial<Pick<Phantom, 'network'>>): Phantom => ({ network: 'linkedin', site: 'linkedin', runner: 'extension', ...p });

export const PHANTOMS: Phantom[] = [
  // LinkedIn data
  li({ id: 'linkedin.search_export', category: 'data', label: 'LinkedIn Search Export', description: 'Export every person from a LinkedIn people search URL.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [{ key: 'search_url', label: 'People search URL', type: 'url', required: true, placeholder: 'https://www.linkedin.com/search/results/people/?keywords=head%20of%20growth' }, limit(250, 1000)], outputs: PERSON }),
  li({ id: 'sales_navigator.lead_search_export', network: 'sales_navigator', category: 'data', label: 'Sales Navigator Lead Export', description: 'Export leads from a Sales Navigator lead search (needs a Sales Navigator seat).', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'salesNavUrl', watchable: true,
    fields: [{ key: 'search_url', label: 'Lead search URL', type: 'url', required: true, placeholder: 'https://www.linkedin.com/sales/search/people?query=…' }, limit(250, 2500)], outputs: SALESNAV_LEAD }),
  li({ id: 'sales_navigator.account_search_export', network: 'sales_navigator', category: 'data', label: 'Sales Navigator Account Export', description: 'Export companies from a Sales Navigator account search.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'salesNavUrl', watchable: true,
    fields: [{ key: 'search_url', label: 'Account search URL', type: 'url', required: true, placeholder: 'https://www.linkedin.com/sales/search/company?query=…' }, limit(250, 2500)], outputs: SALESNAV_ACCOUNT }),
  li({ id: 'linkedin.profile_scraper', category: 'data', label: 'LinkedIn Profile Scraper', description: 'Full profile data (experience, education, skills, about) for a list of profiles.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: false,
    fields: [targets('Profiles', 'https://www.linkedin.com/in/…'), { key: 'visit', label: 'Count as a profile visit', type: 'boolean', default: false, help: 'Open each profile page (they see your visit) instead of reading data silently.' }], outputs: PROFILE }),
  li({ id: 'linkedin.company_scraper', category: 'data', label: 'LinkedIn Company Scraper', description: 'Company page data: website, industry, size, headquarters, followers.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'companyUrl', watchable: false,
    fields: [targets('Company pages', 'https://www.linkedin.com/company/…')], outputs: COMPANY }),
  li({ id: 'linkedin.company_employees', category: 'data', label: 'LinkedIn Company Employees', description: 'Export people who currently work at a company, optionally filtered by title keywords.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: true,
    fields: [targets('Company pages', 'https://www.linkedin.com/company/…'), { key: 'title_keywords', label: 'Title keywords', type: 'text', placeholder: 'marketing OR growth' }, limit(100, 1000)], outputs: [...PERSON, { key: 'sourceCompany', label: 'Source company' }] }),
  li({ id: 'linkedin.post_reactors', category: 'data', label: 'LinkedIn Post Likers', description: 'Everyone who reacted to a post.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: true,
    fields: [targets('Posts', 'https://www.linkedin.com/posts/… or /feed/update/urn:li:activity:…'), limit(500, 3000)], outputs: ENGAGER }),
  li({ id: 'linkedin.post_commenters', category: 'data', label: 'LinkedIn Post Commenters', description: 'Everyone who commented on a post, with their comment.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: true,
    fields: [targets('Posts', 'https://www.linkedin.com/posts/…'), limit(500, 3000)], outputs: ENGAGER }),
  li({ id: 'linkedin.profile_activity', category: 'data', label: 'LinkedIn Activity Extractor', description: 'Recent posts of profiles or company pages, with engagement counts.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'postUrl', watchable: true,
    fields: [targets('Profiles or company pages', 'https://www.linkedin.com/in/…'), { key: 'posts_per_profile', label: 'Posts per profile', type: 'number', default: 10, min: 1, max: 100 }], outputs: POST }),
  li({ id: 'linkedin.group_members', category: 'data', label: 'LinkedIn Group Members', description: 'Export members of a group you belong to.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [{ key: 'group_url', label: 'Group URL', type: 'url', required: true, placeholder: 'https://www.linkedin.com/groups/1234567/' }, limit(500, 2500)], outputs: PERSON }),
  li({ id: 'linkedin.event_attendees', category: 'data', label: 'LinkedIn Event Attendees', description: 'Export attendees of a LinkedIn event you are attending.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [{ key: 'event_url', label: 'Event URL', type: 'url', required: true, placeholder: 'https://www.linkedin.com/events/…' }, limit(500, 2500)], outputs: PERSON }),
  li({ id: 'linkedin.people_also_viewed', category: 'data', label: 'LinkedIn "People Also Viewed"', description: 'Lookalike profiles from the "People also viewed" box of each profile.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: false,
    fields: [targets('Profiles', 'https://www.linkedin.com/in/…')], outputs: [...PERSON, { key: 'sourceProfile', label: 'Seen on' }] }),
  li({ id: 'linkedin.connections_export', category: 'data', label: 'LinkedIn Connections Export', description: 'Export your 1st-degree connections, newest first.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [limit(1000, 30000)], outputs: [...PERSON, { key: 'connectedAt', label: 'Connected at' }] }),
  li({ id: 'linkedin.inbox_export', category: 'data', label: 'LinkedIn Inbox Export', description: 'Export your conversations with the last message of each.', action: 'linkedin.scrape', perTarget: false, dedupeKey: 'conversationUrl', watchable: true,
    fields: [limit(200, 2000), { key: 'unread_only', label: 'Unread only', type: 'boolean', default: false }],
    outputs: [{ key: 'participantName', label: 'With' }, { key: 'participantUrl', label: 'LinkedIn URL' }, { key: 'participantHeadline', label: 'Headline' }, { key: 'lastMessage', label: 'Last message' }, { key: 'lastSender', label: 'Last sender' }, { key: 'lastMessageAt', label: 'Last message at' }, { key: 'unread', label: 'Unread' }, { key: 'conversationUrl', label: 'Conversation' }] }),

  // LinkedIn actions
  li({ id: 'linkedin.profile_visitor', category: 'action', label: 'LinkedIn Profile Visitor', description: 'Visit profiles so they see you in "Who viewed your profile".', action: 'linkedin.visit', perTarget: true, dedupeKey: 'profileUrl', watchable: false, sends: true,
    fields: [targets('Profiles', 'https://www.linkedin.com/in/…')], outputs: ACTION_RESULT }),
  li({ id: 'linkedin.auto_connect', category: 'action', label: 'LinkedIn Auto Connect', description: 'Send connection requests with a personalised note (variables, spintax, AI-written line).', action: 'linkedin.connect', perTarget: true, dedupeKey: 'profileUrl', watchable: false, sends: true,
    fields: [targets('Profiles', 'https://www.linkedin.com/in/…'), noteTemplate, aiInstructions], outputs: ACTION_RESULT }),
  li({ id: 'linkedin.message_sender', category: 'action', label: 'LinkedIn Message Sender', description: 'Message your 1st-degree connections. Non-connections are skipped.', action: 'linkedin.message', perTarget: true, dedupeKey: 'profileUrl', watchable: false, sends: true,
    fields: [targets('Profiles', 'https://www.linkedin.com/in/…'), { key: 'message', label: 'Message', type: 'template', required: true, max: 8000, placeholder: 'Hi {first_name}, …', help: 'Variables, spintax and {ai_message} as in the connect note.' }, aiInstructions], outputs: ACTION_RESULT }),
  li({ id: 'linkedin.auto_follow', category: 'action', label: 'LinkedIn Auto Follow', description: 'Follow profiles or company pages.', action: 'linkedin.follow', perTarget: true, dedupeKey: 'profileUrl', watchable: false, sends: true,
    fields: [targets('Profiles or companies', 'https://www.linkedin.com/in/…')], outputs: ACTION_RESULT }),
  li({ id: 'linkedin.withdraw_invites', category: 'action', label: 'LinkedIn Invitation Withdrawer', description: 'Withdraw pending invitations older than N days (keeps you under LinkedIn\'s pending cap).', action: 'linkedin.withdraw', perTarget: false, dedupeKey: 'profileUrl', watchable: true, sends: true,
    fields: [{ key: 'older_than_days', label: 'Older than (days)', type: 'number', default: 21, min: 7, max: 365 }, { key: 'limit', label: 'Max to withdraw', type: 'number', default: 40, min: 1, max: 500 }], outputs: ACTION_RESULT }),
  li({ id: 'linkedin.post_liker', category: 'action', label: 'LinkedIn Auto Liker', description: 'React to posts (or the latest posts of profiles).', action: 'linkedin.like', perTarget: true, dedupeKey: 'postUrl', watchable: true, sends: true,
    fields: [targets('Posts or profiles', 'https://www.linkedin.com/posts/… or /in/…'),
      { key: 'reaction', label: 'Reaction', type: 'select', default: 'LIKE', options: [{ value: 'LIKE', label: 'Like' }, { value: 'PRAISE', label: 'Celebrate' }, { value: 'EMPATHY', label: 'Love' }, { value: 'INTEREST', label: 'Insightful' }, { value: 'APPRECIATION', label: 'Support' }] },
      { key: 'posts_per_profile', label: 'Latest posts per profile', type: 'number', default: 1, min: 1, max: 5 }],
    outputs: [{ key: 'postUrl', label: 'Post URL' }, { key: 'authorName', label: 'Author' }, { key: 'status', label: 'Status' }, { key: 'at', label: 'At' }] }),
  li({ id: 'linkedin.ai_post_responder', category: 'action', label: 'LinkedIn AI Post Responder', description: 'AI drafts a comment for each post; you approve every comment before it is posted.', action: 'linkedin.comment', perTarget: true, dedupeKey: 'postUrl', watchable: true, sends: true,
    fields: [targets('Posts or profiles', 'https://www.linkedin.com/posts/… or /in/…'),
      { key: 'instructions', label: 'How to comment', type: 'textarea', required: true, placeholder: 'Add a thoughtful, specific point that builds on the post. 1-2 sentences. No emojis, no pitch.' },
      { key: 'posts_per_profile', label: 'Latest posts per profile', type: 'number', default: 1, min: 1, max: 5 }],
    outputs: [{ key: 'postUrl', label: 'Post URL' }, { key: 'authorName', label: 'Author' }, { key: 'text', label: 'Post' }, { key: 'draft', label: 'Draft comment' }, { key: 'status', label: 'Status' }] }),

  // LinkedIn post monitoring
  li({ id: 'linkedin.post_monitor', category: 'monitor', label: 'LinkedIn Post Monitor', description: 'Watch posts, and the new posts of profiles or company pages; collect new reactors and commenters on a schedule.', action: 'linkedin.scrape', perTarget: true, dedupeKey: 'engagerKey', watchable: true,
    fields: [targets('Posts, profiles or company pages', 'https://www.linkedin.com/posts/… · /in/… · /company/…'),
      { key: 'collect', label: 'Collect', type: 'select', default: 'both', options: [{ value: 'both', label: 'Reactors and commenters' }, { value: 'reactors', label: 'Reactors only' }, { value: 'commenters', label: 'Commenters only' }] },
      { key: 'posts_per_profile', label: 'Recent posts to watch per profile', type: 'number', default: 3, min: 1, max: 20 },
      { key: 'max_post_age_days', label: 'Ignore posts older than (days)', type: 'number', default: 14, min: 1, max: 90 }],
    outputs: [...ENGAGER, { key: 'postAuthor', label: 'Post author' }, { key: 'engagerKey', label: 'Engager key' }] }),

  // Instagram
  { id: 'instagram.followers_export', network: 'instagram', site: 'instagram', runner: 'extension', category: 'data', label: 'Instagram Followers Export', description: 'Followers or following of a public (or followed) account.', action: 'instagram.scrape', perTarget: true, dedupeKey: 'username', watchable: true,
    fields: [targets('Profiles', 'https://www.instagram.com/username/'), { key: 'which', label: 'Export', type: 'select', default: 'followers', options: [{ value: 'followers', label: 'Followers' }, { value: 'following', label: 'Following' }] }, limit(500, 5000)],
    outputs: [...IG_USER.slice(0, 3), { key: 'isPrivate', label: 'Private' }, { key: 'isVerified', label: 'Verified' }, { key: 'sourceProfile', label: 'Source profile' }] },
  { id: 'instagram.profile_scraper', network: 'instagram', site: 'instagram', runner: 'extension', category: 'data', label: 'Instagram Profile Scraper', description: 'Bio, followers, website and public business contact of profiles.', action: 'instagram.scrape', perTarget: true, dedupeKey: 'username', watchable: false,
    fields: [targets('Profiles', 'https://www.instagram.com/username/')], outputs: IG_USER },
  { id: 'instagram.hashtag_export', network: 'instagram', site: 'instagram', runner: 'extension', category: 'data', label: 'Instagram Hashtag Search Export', description: 'Recent and top posts for a hashtag, with their authors.', action: 'instagram.scrape', perTarget: false, dedupeKey: 'postUrl', watchable: true,
    fields: [{ key: 'hashtag', label: 'Hashtag', type: 'text', required: true, placeholder: 'saas' }, limit(200, 1000)],
    outputs: [{ key: 'postUrl', label: 'Post URL' }, { key: 'username', label: 'Author' }, { key: 'profileUrl', label: 'Author URL' }, { key: 'caption', label: 'Caption' }, { key: 'likes', label: 'Likes' }, { key: 'comments', label: 'Comments' }, { key: 'postedAt', label: 'Posted' }] },
  { id: 'instagram.post_engagers', network: 'instagram', site: 'instagram', runner: 'extension', category: 'data', label: 'Instagram Post Likers & Commenters', description: 'People who liked or commented on posts.', action: 'instagram.scrape', perTarget: true, dedupeKey: 'username', watchable: true,
    fields: [targets('Posts', 'https://www.instagram.com/p/…'), { key: 'which', label: 'Export', type: 'select', default: 'likers', options: [{ value: 'likers', label: 'Likers' }, { value: 'commenters', label: 'Commenters' }] }, limit(500, 5000)],
    outputs: [{ key: 'username', label: 'Username' }, { key: 'fullName', label: 'Full name' }, { key: 'profileUrl', label: 'Instagram URL' }, { key: 'commentText', label: 'Comment' }, { key: 'postUrl', label: 'Post URL' }] },

  // X / Twitter
  { id: 'x.followers_export', network: 'x', site: 'x', runner: 'extension', category: 'data', label: 'X Followers Export', description: 'Followers or following of an X account.', action: 'x.scrape', perTarget: true, dedupeKey: 'username', watchable: true,
    fields: [targets('Profiles', 'https://x.com/username'), { key: 'which', label: 'Export', type: 'select', default: 'followers', options: [{ value: 'followers', label: 'Followers' }, { value: 'following', label: 'Following' }] }, limit(500, 5000)],
    outputs: [...X_USER, { key: 'sourceProfile', label: 'Source profile' }] },
  { id: 'x.profile_scraper', network: 'x', site: 'x', runner: 'extension', category: 'data', label: 'X Profile Scraper', description: 'Bio, location, website and audience of X profiles.', action: 'x.scrape', perTarget: true, dedupeKey: 'username', watchable: false,
    fields: [targets('Profiles', 'https://x.com/username')], outputs: X_USER },
  { id: 'x.tweet_engagers', network: 'x', site: 'x', runner: 'extension', category: 'data', label: 'X Post Likers & Reposters', description: 'People who liked or reposted a post (likes are only visible on your own posts).', action: 'x.scrape', perTarget: true, dedupeKey: 'username', watchable: true,
    fields: [targets('Posts', 'https://x.com/user/status/…'), { key: 'which', label: 'Export', type: 'select', default: 'retweeters', options: [{ value: 'likers', label: 'Likers' }, { value: 'retweeters', label: 'Reposters' }] }, limit(500, 3000)],
    outputs: [...X_USER.slice(0, 6), { key: 'tweetUrl', label: 'Post URL' }] },
  { id: 'x.search_export', network: 'x', site: 'x', runner: 'extension', category: 'data', label: 'X Search Export', description: 'Posts matching an X search query, with their authors.', action: 'x.scrape', perTarget: false, dedupeKey: 'tweetUrl', watchable: true,
    fields: [{ key: 'query', label: 'Search query', type: 'text', required: true, placeholder: '"cold email" min_faves:20' }, { key: 'mode', label: 'Tab', type: 'select', default: 'Latest', options: [{ value: 'Latest', label: 'Latest' }, { value: 'Top', label: 'Top' }] }, limit(200, 2000)],
    outputs: [{ key: 'tweetUrl', label: 'Post URL' }, { key: 'text', label: 'Text' }, { key: 'username', label: 'Author' }, { key: 'name', label: 'Name' }, { key: 'profileUrl', label: 'Author URL' }, { key: 'likes', label: 'Likes' }, { key: 'retweets', label: 'Reposts' }, { key: 'replies', label: 'Replies' }, { key: 'createdAt', label: 'Posted' }] },

  // Facebook
  { id: 'facebook.group_members', network: 'facebook', site: 'facebook', runner: 'extension', category: 'data', label: 'Facebook Group Members', description: 'Members of a group you belong to.', action: 'facebook.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [{ key: 'group_url', label: 'Group URL', type: 'url', required: true, placeholder: 'https://www.facebook.com/groups/…' }, limit(500, 5000)], outputs: FB_MEMBER },
  { id: 'facebook.event_attendees', network: 'facebook', site: 'facebook', runner: 'extension', category: 'data', label: 'Facebook Event Attendees', description: 'Going/interested guests of an event, where the guest list is visible.', action: 'facebook.scrape', perTarget: false, dedupeKey: 'profileUrl', watchable: true,
    fields: [{ key: 'event_url', label: 'Event URL', type: 'url', required: true, placeholder: 'https://www.facebook.com/events/…' }, limit(500, 5000)], outputs: FB_MEMBER },
  { id: 'facebook.page_scraper', network: 'facebook', site: 'facebook', runner: 'extension', category: 'data', label: 'Facebook Page / Profile Scraper', description: 'Basic public data of pages or profiles: name, category, likes, followers, website.', action: 'facebook.scrape', perTarget: true, dedupeKey: 'profileUrl', watchable: false,
    fields: [targets('Pages or profiles', 'https://www.facebook.com/…')],
    outputs: [{ key: 'name', label: 'Name' }, { key: 'profileUrl', label: 'Facebook URL' }, { key: 'category', label: 'Category' }, { key: 'likes', label: 'Likes' }, { key: 'followers', label: 'Followers' }, { key: 'website', label: 'Website' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address' }, { key: 'bio', label: 'About' }] },

  // Reddit (server-side, public JSON — no extension needed)
  { id: 'reddit.subreddit_posts', network: 'reddit', site: 'reddit', runner: 'server', category: 'data', label: 'Reddit Subreddit Posts', description: 'Posts from a subreddit (new, hot or top).', action: null, perTarget: false, dedupeKey: 'postUrl', watchable: true,
    fields: [{ key: 'subreddit', label: 'Subreddit', type: 'text', required: true, placeholder: 'sales' },
      { key: 'sort', label: 'Sort', type: 'select', default: 'new', options: ['new', 'hot', 'top', 'rising'].map((v) => ({ value: v, label: v })) },
      { key: 'time', label: 'Top of', type: 'select', default: 'week', options: ['day', 'week', 'month', 'year', 'all'].map((v) => ({ value: v, label: v })) }, limit(100, 1000)], outputs: REDDIT_POST },
  { id: 'reddit.post_commenters', network: 'reddit', site: 'reddit', runner: 'server', category: 'data', label: 'Reddit Post Commenters', description: 'Everyone who commented on a post, with their comment.', action: null, perTarget: true, dedupeKey: 'permalink', watchable: true,
    fields: [targets('Posts', 'https://www.reddit.com/r/…/comments/…')], outputs: REDDIT_COMMENT },
  { id: 'reddit.user_activity', network: 'reddit', site: 'reddit', runner: 'server', category: 'data', label: 'Reddit User Profile & Activity', description: 'Karma, age and recent posts/comments of users.', action: null, perTarget: true, dedupeKey: 'username', watchable: false,
    fields: [targets('Users', 'https://www.reddit.com/user/… or a username')], outputs: REDDIT_USER },
  { id: 'reddit.search', network: 'reddit', site: 'reddit', runner: 'server', category: 'data', label: 'Reddit Search Export', description: 'Posts matching a search, across Reddit or one subreddit.', action: null, perTarget: false, dedupeKey: 'postUrl', watchable: true,
    fields: [{ key: 'query', label: 'Search', type: 'text', required: true, placeholder: '"looking for" crm' }, { key: 'subreddit', label: 'Subreddit (optional)', type: 'text' },
      { key: 'sort', label: 'Sort', type: 'select', default: 'new', options: ['new', 'relevance', 'top', 'comments'].map((v) => ({ value: v, label: v })) }, limit(100, 1000)], outputs: REDDIT_POST },

  // GitHub (server-side)
  { id: 'github.stargazers', network: 'github', site: 'github', runner: 'server', category: 'data', label: 'GitHub Stargazers', description: 'People who starred a repository (newest first), with public profile data.', action: null, perTarget: false, dedupeKey: 'login', watchable: true,
    fields: [{ key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repo or https://github.com/owner/repo' }, limit(100, 2000)], outputs: GITHUB_USER },
  { id: 'github.contributors', network: 'github', site: 'github', runner: 'server', category: 'data', label: 'GitHub Contributors', description: 'Contributors of a repository by commit count, with public profile data.', action: null, perTarget: false, dedupeKey: 'login', watchable: true,
    fields: [{ key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repo' }, limit(100, 1000)], outputs: GITHUB_USER },
];

export function phantom(id: string): Phantom | undefined {
  return PHANTOMS.find((p) => p.id === id);
}

export const NETWORK_LABELS: Record<Network, string> = {
  linkedin: 'LinkedIn', sales_navigator: 'Sales Navigator', instagram: 'Instagram', x: 'X / Twitter', facebook: 'Facebook', reddit: 'Reddit', github: 'GitHub',
};
