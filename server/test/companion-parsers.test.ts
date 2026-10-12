import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parse, PARSERS, linkedinProfileUrl, normalizeUrl, linkedinActivityUrn, igShortcode, tweetId, redditPostId, githubRepo, activityTime,
} from '../src/companion/parsers/index.ts';
import { PARSER_IDS } from '../src/companion/protocol.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'companion');
const json = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const text = (f: string) => readFileSync(join(DIR, f), 'utf8');

describe('parser registry', () => {
  it('implements every parser id and never throws on garbage', () => {
    for (const id of PARSER_IDS) {
      expect(typeof PARSERS[id]).toBe('function');
      for (const junk of [null, undefined, 42, 'not json', '{"a":', [], { included: 'x' }, '<html></html>']) {
        expect(() => parse(id, junk)).not.toThrow();
        expect(Array.isArray(parse(id, junk).records)).toBe(true);
      }
    }
  });
  it('accepts JSON strings as well as objects', () => {
    const raw = text('linkedin-search.json');
    expect(parse('linkedin.search', raw).records).toHaveLength(2);
  });
});

describe('LinkedIn', () => {
  it('search: people, degree, headline split, paging; skips headless and duplicates', () => {
    const r = parse('linkedin.search', json('linkedin-search.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({
      fullName: 'Testa Fakename', firstName: 'Testa', lastName: 'Fakename', title: 'Head of Growth', company: 'Acme Widgets',
      location: 'Berlin, Germany', profileUrl: 'https://www.linkedin.com/in/testa-fakename-123/', connectionDegree: '2nd', memberUrn: 'urn:li:fsd_profile:ACoAAA111',
    });
    expect(r.records[1]).toMatchObject({ fullName: 'Mock Personson', title: 'VP Sales', company: 'Example Corp', connectionDegree: '3rd' });
    expect(r.total).toBe(23);
    expect(r.nextCursor).toBe(10);
  });

  it('search HTML fallback', () => {
    const r = parse('linkedin.search_html', text('linkedin-search.html'));
    expect(r.records.map((x) => x.fullName)).toEqual(['Testa Fakename', 'Mock Personson']);
    expect(r.records[0]).toMatchObject({ profileUrl: 'https://www.linkedin.com/in/testa-fakename-123/', location: 'Berlin, Germany', connectionDegree: '2nd', company: 'Acme Widgets' });
    expect(r.records[1].company).toBe('Example Corp');
    expect(r.records[1].title).toBe('VP Sales & Partnerships');
  });

  it('profile: picks the requested profile, current position, company, education, skills', () => {
    const r = parse('linkedin.profile', json('linkedin-profile.json'), { url: 'https://www.linkedin.com/in/testa-fakename-123/' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      fullName: 'Testa Fakename', title: 'Head of Growth', company: 'Acme Widgets', location: 'Berlin, Germany',
      about: 'I grow imaginary companies.', industry: 'Software Development', followers: 4321, connectionDegree: '2nd',
      companyUrl: 'https://www.linkedin.com/company/acme-widgets/', companyDomain: 'acme-widgets.example', website: 'https://testa.example',
      education: 'University of Nowhere, MSc, Marketing', skills: 'Growth Marketing, SEO', memberUrn: 'urn:li:fsd_profile:ACoAAA111',
    });
    expect(String(r.records[0].experience)).toContain('Head of Growth @ Acme Widgets (2022-03–present)');
  });

  it('profile HTML fallback', () => {
    const r = parse('linkedin.profile_html', text('linkedin-profile.html'));
    expect(r.records[0]).toMatchObject({ fullName: 'Testa Fakename', title: 'Head of Growth', company: 'Acme Widgets', location: 'Berlin, Germany', about: 'I grow imaginary companies.', profileUrl: 'https://www.linkedin.com/in/testa-fakename-123/', connectionDegree: '2nd' });
  });

  it('company page', () => {
    const r = parse('linkedin.company', json('linkedin-company.json'), { url: 'https://www.linkedin.com/company/acme-widgets/' });
    expect(r.records[0]).toMatchObject({
      name: 'Acme Widgets', companyUrl: 'https://www.linkedin.com/company/acme-widgets/', website: 'https://www.acme-widgets.example/', domain: 'acme-widgets.example',
      industry: 'Software Development', employeeCount: 142, size: '51-200', headquarters: 'Berlin, Berlin, DE', founded: 2015, followers: 9876, specialties: 'Widgets, Testing',
    });
  });

  it('post reactors and commenters', () => {
    const postUrl = 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/';
    const re = parse('linkedin.reactions', json('linkedin-reactions.json'), { postUrl });
    expect(re.records).toHaveLength(2);
    expect(re.records[1]).toMatchObject({ fullName: 'Mock Personson', engagement: 'reaction', reactionType: 'PRAISE', postUrl, profileUrl: 'https://www.linkedin.com/in/mock-personson/' });
    expect(re.nextCursor).toBe(2);
    const co = parse('linkedin.comments', json('linkedin-comments.json'), { postUrl });
    expect(co.records).toHaveLength(2);
    expect(co.records[0]).toMatchObject({ fullName: 'Mock Personson', engagement: 'comment', commentText: 'Great point about widgets!', engagedAt: new Date(1700000000000).toISOString() });
    expect(co.records[1]).toMatchObject({ fullName: 'Dummy McTest', profileUrl: 'https://www.linkedin.com/in/dummy-mctest/' });
    expect(co.nextCursor).toBeNull();
  });

  it('profile activity: posts with counts and timestamps from activity ids', () => {
    const r = parse('linkedin.activity', json('linkedin-activity.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({
      authorName: 'Testa Fakename', authorUrl: 'https://www.linkedin.com/in/testa-fakename-123/', text: 'We just shipped imaginary widgets v2.',
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/', reactions: 42, comments: 7, reposts: 3,
    });
    expect(r.records[0].postedAt).toBe(activityTime('7100000000000000001'));
    expect(String(r.records[0].postedAt)).toMatch(/^2023-/);
  });

  it('group members / event attendees / browsemap', () => {
    const g = parse('linkedin.group_members', json('linkedin-group.json'));
    expect(g.records.map((x) => x.profileUrl)).toEqual(['https://www.linkedin.com/in/group-member-one/', 'https://www.linkedin.com/in/group-member-two/']);
    expect(g.records[0]).toMatchObject({ title: 'Analyst', company: 'Fictional Bank' });
    expect(g.nextCursor).toBe(2);
    expect(parse('linkedin.event_attendees', json('linkedin-group.json')).records).toHaveLength(2);
    const b = parse('linkedin.browsemap', json('linkedin-group.json'), { sourceProfile: 'https://www.linkedin.com/in/group-member-one/' });
    expect(b.records).toHaveLength(1);
    expect(b.records[0].sourceProfile).toBe('https://www.linkedin.com/in/group-member-one/');
  });

  it('connections with connectedAt', () => {
    const r = parse('linkedin.connections', json('linkedin-connections.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ fullName: 'Mock Personson', connectionDegree: '1st', connectedAt: new Date(1717000000000).toISOString(), profileUrl: 'https://www.linkedin.com/in/mock-personson/' });
  });

  it('conversations: other participant, last sender, unread', () => {
    const r = parse('linkedin.conversations', json('linkedin-conversations.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({
      participantName: 'Mock Personson', participantUrl: 'https://www.linkedin.com/in/mock-personson/', participantHeadline: 'VP Sales',
      lastMessage: 'Sounds interesting, tell me more', lastSender: 'them', unread: true, lastMessageAt: new Date(1718000000000).toISOString(),
      conversationUrl: 'https://www.linkedin.com/messaging/thread/2-abc123==',
    });
    expect(r.records[1]).toMatchObject({ participantName: 'Dummy McTest', lastSender: 'me', unread: false, conversationUrl: 'https://www.linkedin.com/messaging/thread/2-def456==/' });
  });

  it('sent invitations', () => {
    const r = parse('linkedin.sent_invitations', json('linkedin-invitations.json'));
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      fullName: 'Pending Person', profileUrl: 'https://www.linkedin.com/in/pending-person/', invitationId: '6900000000000000001',
      invitationUrn: 'urn:li:fs_relInvitation:6900000000000000001', sharedSecret: 's3cretA', sentAt: new Date(1715000000000).toISOString(), title: 'CTO',
    });
  });
});

describe('Sales Navigator', () => {
  it('lead search', () => {
    const r = parse('salesnav.leads', json('salesnav-leads.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({
      fullName: 'Testa Fakename', title: 'Head of Growth', company: 'Acme Widgets', location: 'Berlin, Germany', tenure: '2 yrs 3 mos',
      salesNavUrl: 'https://www.linkedin.com/sales/lead/ACwAAA111,NAME_SEARCH,abcd', connectionDegree: '2nd', premium: true,
      companyUrl: 'https://www.linkedin.com/company/5550001/',
    });
    expect(r.records[1]).toMatchObject({ fullName: 'Mock Personson', tenure: '7 mos', connectionDegree: '3rd' });
    expect(r.nextCursor).toBe(25);
  });
  it('account search, last page', () => {
    const r = parse('salesnav.accounts', json('salesnav-accounts.json'));
    expect(r.records[0]).toMatchObject({ name: 'Acme Widgets', employeeCount: 142, salesNavUrl: 'https://www.linkedin.com/sales/company/5550001', companyUrl: 'https://www.linkedin.com/company/5550001/' });
    expect(r.records[1].employeeCount).toBe('1001-5000');
    expect(r.nextCursor).toBeNull();
  });
});

describe('Instagram', () => {
  const f = json('instagram.json');
  it('followers with cursor, deduped', () => {
    const r = parse('instagram.users', f.followers, { sourceProfile: 'https://www.instagram.com/acme.widgets/' });
    expect(r.records).toHaveLength(2);
    expect(r.records[1]).toMatchObject({ username: 'pretend_person', fullName: 'Pretend Person', profileUrl: 'https://www.instagram.com/pretend_person/', isPrivate: true, isVerified: true, sourceProfile: 'https://www.instagram.com/acme.widgets/' });
    expect(r.nextCursor).toBe('QVFE_cursor_2');
  });
  it('profile', () => {
    const r = parse('instagram.profile', f.profile);
    expect(r.records[0]).toMatchObject({ username: 'acme.widgets', followers: 12345, following: 67, posts: 89, externalUrl: 'https://acme-widgets.example', email: 'hello@acme-widgets.example', category: 'Product/service', isVerified: true });
  });
  it('hashtag posts', () => {
    const r = parse('instagram.hashtag', f.hashtag);
    expect(r.records.map((x) => x.postUrl)).toEqual(['https://www.instagram.com/p/AbC123/', 'https://www.instagram.com/p/XyZ789/']);
    expect(r.records[0]).toMatchObject({ username: 'fake.follower', likes: 50, comments: 4, caption: '#saas is fun' });
    expect(r.nextCursor).toBe('hashtag_cursor');
  });
  it('comments', () => {
    const r = parse('instagram.comments', f.comments, { postUrl: 'https://www.instagram.com/p/AbC123/' });
    expect(r.records).toHaveLength(2);
    expect(r.records[1]).toMatchObject({ username: 'pretend_person', commentText: 'Where can I buy?', postUrl: 'https://www.instagram.com/p/AbC123/' });
  });
});

describe('X / Twitter', () => {
  const f = json('x.json');
  it('followers timeline: new core + legacy shapes, bottom cursor', () => {
    const r = parse('x.users', f.followers);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ username: 'fake_founder', name: 'Fake Founder', profileUrl: 'https://x.com/fake_founder', followers: 1200, following: 300, location: 'Austin, TX', website: 'https://fake-founder.example', verified: true });
    expect(r.records[1]).toMatchObject({ username: 'mock_marketer', location: 'Remote', verified: false });
    expect(r.nextCursor).toBe('BOTTOM_CURSOR_ABC');
  });
  it('profile', () => {
    expect(parse('x.profile', f.profile).records[0]).toMatchObject({ username: 'fake_founder', tweets: 4500, bio: 'Building pretend things' });
  });
  it('search tweets incl. visibility wrapper and note tweets', () => {
    const r = parse('x.tweets', f.search);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ tweetUrl: 'https://x.com/mock_marketer/status/111', text: 'cold email is not dead', likes: 25, retweets: 3, replies: 4, username: 'mock_marketer' });
    expect(r.records[1]).toMatchObject({ tweetUrl: 'https://x.com/fake_founder/status/112', text: 'long version of the post' });
    expect(r.nextCursor).toBe('SEARCH_NEXT');
  });
});

describe('Facebook', () => {
  it('group members (users only) with cursor', () => {
    const r = parse('facebook.members', json('facebook-members.json'));
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ name: 'Fakey Groupmember', profileUrl: 'https://www.facebook.com/fakey.groupmember', id: '100001', bio: 'Coffee enthusiast', joined: 'Joined about a week ago' });
    expect(r.records[1].profileUrl).toBe('https://www.facebook.com/profile.php?id=100002');
    expect(r.nextCursor).toBe('FB_CURSOR_2');
  });
  it('page HTML basics', () => {
    const r = parse('facebook.page', text('facebook-page.html'));
    expect(r.records[0]).toMatchObject({ name: 'Acme Widgets', profileUrl: 'https://www.facebook.com/acmewidgets', likes: 12000, followers: 13400, email: 'hello@acme-widgets.example' });
  });
  it('page from GraphQL JSON', () => {
    const r = parse('facebook.page', { data: { page: { __typename: 'Page', name: 'Fake Bakery', url: 'https://www.facebook.com/fakebakery', category_name: 'Bakery', follower_count: 77 } } });
    expect(r.records[0]).toMatchObject({ name: 'Fake Bakery', category: 'Bakery', followers: 77 });
  });
});

describe('Reddit', () => {
  const f = json('reddit.json');
  it('listing with after cursor', () => {
    const r = parse('reddit.listing', f.listing_page1);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ title: 'Which CRM do you use?', author: 'fake_redditor', authorUrl: 'https://www.reddit.com/user/fake_redditor/', subreddit: 'sales', postUrl: 'https://www.reddit.com/r/sales/comments/aaa111/which_crm_do_you_use/', score: 12, comments: 2, flair: 'Tools', text: 'Looking for a cheap CRM.' });
    expect(r.records[0].url).toBeUndefined();
    expect(r.records[1].url).toBe('https://example.com/benchmarks');
    expect(r.nextCursor).toBe('t3_bbb222');
    expect(parse('reddit.listing', f.listing_page2).nextCursor).toBeNull();
  });
  it('comment tree flattened, deleted skipped', () => {
    const r = parse('reddit.comments', f.comments);
    expect(r.records.map((x) => x.author)).toEqual(['mock_seller', 'fake_redditor']);
    expect(r.records[1]).toMatchObject({ text: 'Ha, thanks', postUrl: 'https://www.reddit.com/r/sales/comments/aaa111/which_crm_do_you_use/', permalink: 'https://www.reddit.com/r/sales/comments/aaa111/which_crm_do_you_use/c2/' });
  });
  it('user about + overview', () => {
    const r = parse('reddit.user', { about: f.about, overview: f.overview });
    expect(r.records[0]).toMatchObject({ username: 'fake_redditor', linkKarma: 120, commentKarma: 3400, bio: 'I post about pretend CRMs', recentSubreddits: 'r/sales, r/startups' });
    expect(String(r.records[0].recentActivity)).toContain('Post: My first post');
  });
});

describe('GitHub', () => {
  it('users from stargazers + profiles, bots skipped', () => {
    const f = json('github.json');
    const merged = f.stargazers.map((s: any) => ({ ...s, user: { ...s.user, ...(f.users[s.user.login] ?? {}) } }));
    const r = parse('github.users', merged);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ login: 'fakedev', name: 'Fake Developer', company: 'acme-widgets', website: 'https://fakedev.example', twitter: 'https://x.com/fakedev', followers: 321, starredAt: '2024-06-01T10:00:00Z' });
    const c = parse('github.users', f.contributors);
    expect(c.records[0].contributions).toBe(120);
  });
});

describe('URL helpers', () => {
  it('linkedin', () => {
    expect(linkedinProfileUrl('jane-doe')).toBe('https://www.linkedin.com/in/jane-doe/');
    expect(linkedinProfileUrl('https://de.linkedin.com/in/jane-doe?trk=abc')).toBe('https://www.linkedin.com/in/jane-doe/');
    expect(normalizeUrl('linkedin', 'https://www.linkedin.com/in/Jane-Doe/?x=1')).toBe('https://www.linkedin.com/in/jane-doe/');
    expect(normalizeUrl('linkedin', 'https://www.linkedin.com/company/acme/about/')).toBe('https://www.linkedin.com/company/acme/');
    expect(linkedinActivityUrn('https://www.linkedin.com/posts/jane-doe_growth-activity-7100000000000000001-AbCd')).toBe('urn:li:activity:7100000000000000001');
    expect(linkedinActivityUrn('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000002/')).toBe('urn:li:activity:7100000000000000002');
    expect(linkedinActivityUrn('https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7100000000000000003')).toBe('urn:li:ugcPost:7100000000000000003');
    expect(normalizeUrl('linkedin', 'https://www.linkedin.com/posts/x-activity-7100000000000000001-zz')).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/');
  });
  it('other networks', () => {
    expect(igShortcode('https://www.instagram.com/p/AbC123/?img_index=1')).toBe('AbC123');
    expect(igShortcode('https://www.instagram.com/someone/reel/XyZ/')).toBe('XyZ');
    expect(tweetId('https://twitter.com/user/status/1234567890')).toBe('1234567890');
    expect(redditPostId('https://www.reddit.com/r/sales/comments/AAA111/title/')).toBe('aaa111');
    expect(redditPostId('https://redd.it/bbb222')).toBe('bbb222');
    expect(githubRepo('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(githubRepo('acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(githubRepo('nope')).toBeNull();
    expect(normalizeUrl('x', 'https://twitter.com/Fake_Founder/status/111?s=20')).toBe('https://x.com/fake_founder/status/111');
    expect(normalizeUrl('instagram', 'https://instagram.com/Acme.Widgets')).toBe('https://www.instagram.com/acme.widgets/');
    expect(normalizeUrl('facebook', 'https://m.facebook.com/profile.php?id=42&ref=x')).toBe('https://www.facebook.com/profile.php?id=42');
    expect(normalizeUrl('reddit', 'https://old.reddit.com/r/Sales/comments/abc/x/?utm=1')).toBe('https://www.reddit.com/r/sales/comments/abc/x/');
  });
});
