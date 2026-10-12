import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { signUrl } from '../src/engine/compose.ts';
import { classifyOrg, cidrRange, decide, ipHex, parsePtr, parseRdap, registrableDomain, resolveIp } from '../src/visitors/ipintel.ts';
import {
  clientIp, isBot, limiter, pruneVisitorData, RATE_LIMITS, scoreVisits, settleVisitors, setReverseDns, signLeadToken, verifyLeadToken, publicUrlStatus,
} from '../src/visitors/service.ts';
import { signalKind } from '../src/gtm/providers/signals.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

const ARIN_ACME = {
  objectClassName: 'ip network', handle: 'NET-203-0-113-0-1', startAddress: '203.0.113.0', endAddress: '203.0.113.255', name: 'ACME-NET',
  cidr0_cidrs: [{ v4prefix: '203.0.113.0', length: 24 }], country: 'US',
  entities: [
    { roles: ['registrant'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Acme Corporation'], ['kind', {}, 'text', 'org']]],
      entities: [{ roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Acme NOC'], ['kind', {}, 'text', 'group'], ['email', {}, 'text', 'noc@acme.com']]] }] },
  ],
};
const RIPE_VODAFONE = {
  handle: '198.51.100.0 - 198.51.100.255', startAddress: '198.51.100.0', endAddress: '198.51.100.255', name: 'VODAFONE-IE-DSL', country: 'IE',
  remarks: [{ description: ['Vodafone Ireland broadband customers'] }],
  entities: [
    { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Vodafone Ireland Limited'], ['kind', {}, 'text', 'org']]] },
    { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse'], ['email', {}, 'text', 'abuse@vodafone.ie']]] },
  ],
};

function rdapFetch(calls: string[], extra?: (url: string, init: any) => Response | undefined): typeof fetch {
  return (async (input: any, init: any) => {
    const url = String(input);
    calls.push(url);
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.startsWith('https://rdap.org/ip/203.0.113.')) return Response.json(ARIN_ACME);
    if (url.startsWith('https://rdap.org/ip/198.51.100.')) return Response.json(RIPE_VODAFONE);
    if (url.startsWith('https://rdap.org/')) return new Response('not found', { status: 404 });
    return new Response('ok');
  }) as typeof fetch;
}

describe('IP intelligence parsing', () => {
  it('parses RDAP org, range and contact domains', () => {
    const a = parseRdap(ARIN_ACME);
    expect(a).toMatchObject({ cidr: '203.0.113.0/24', orgName: 'Acme Corporation', emailDomains: ['acme.com'], country: 'US' });
    const v = parseRdap(RIPE_VODAFONE);
    expect(v.orgName).toBe('Vodafone Ireland Limited');
    expect(v.cidr).toBeNull();
    expect(v.start).toBe('198.51.100.0');
  });

  it('parses PTR hostnames into registrable domains and flags dynamic ones', () => {
    expect(parsePtr(['host-1-2-3-4.acme.com.'], '1.2.3.4')).toEqual({ host: 'host-1-2-3-4.acme.com', domain: 'acme.com', dynamic: true });
    expect(parsePtr(['gw.office.acme.co.uk'], '5.6.7.8')).toEqual({ host: 'gw.office.acme.co.uk', domain: 'acme.co.uk', dynamic: false });
    expect(parsePtr([], '1.2.3.4')).toBeNull();
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
  });

  it('filters ISPs, mobile carriers, VPNs and cloud providers', () => {
    expect(classifyOrg('Vodafone Ireland Limited')).toBe('isp');
    expect(classifyOrg('Eir Broadband')).toBe('isp');
    expect(classifyOrg('Virgin Media Limited')).toBe('isp');
    expect(classifyOrg('Comcast Cable Communications, LLC')).toBe('isp');
    expect(classifyOrg('Amazon Technologies Inc.')).toBe('hosting');
    expect(classifyOrg('DigitalOcean, LLC')).toBe('hosting');
    expect(classifyOrg('Hetzner Online GmbH')).toBe('hosting');
    expect(classifyOrg('SpaceX Services, Inc.', 'starlinkisp.net')).toBe('isp');
    expect(classifyOrg('T-Mobile USA, Inc.')).toBe('mobile');
    expect(classifyOrg('Mullvad VPN AB')).toBe('vpn');
    expect(classifyOrg('Acme Corporation')).toBe('company');
    expect(classifyOrg('Stripe, Inc.')).toBe('company');
  });

  it('combines PTR, IPinfo and RDAP verdicts', () => {
    const company = { kind: 'company' as const, orgName: 'Acme Corporation', domain: 'acme.com', source: 'rdap' };
    const isp = { kind: 'isp' as const, orgName: 'Vodafone Ireland', domain: null, source: 'rdap' };
    expect(decide({ host: 'x.comcast.net', domain: 'comcast.net', dynamic: true }, null, company).kind).toBe('isp');
    expect(decide({ host: 'cust-1.vf.ie', domain: 'vf.ie', dynamic: true }, null, isp).kind).toBe('isp');
    expect(decide({ host: 'gw.acme.com', domain: 'acme.com', dynamic: false }, null, isp)).toMatchObject({ kind: 'company', domain: 'acme.com', source: 'ptr' });
    expect(decide(null, null, company)).toMatchObject({ kind: 'company', domain: 'acme.com', orgName: 'Acme Corporation' });
    expect(decide(null, null, null).kind).toBe('unknown');
  });

  it('handles IPv4/IPv6 ranges', () => {
    expect(ipHex('10.0.0.1')).toEqual({ family: 4, hex: '0a000001' });
    expect(ipHex('2001:db8::1')!.hex).toBe('20010db8000000000000000000000001');
    expect(cidrRange('203.0.113.0/24')).toEqual({ family: 4, start: 'cb007100', end: 'cb0071ff' });
  });
});

describe('website visitors', () => {
  let env: TestEnv;
  let ws: number;
  let calls: string[];
  let posted: { url: string; body: any }[];
  let site: any;

  const collect = (body: Record<string, unknown>, headers: Record<string, string> = {}) => env.app.inject({
    method: 'POST', url: '/api/v/collect',
    headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://www.mysite.com', 'user-agent': UA, 'cf-connecting-ip': '203.0.113.7', ...headers },
    payload: JSON.stringify({ k: site.site_key, sid: 'sess-1', vid: 'vis-1', ...body }),
  });

  beforeEach(async () => {
    calls = [];
    posted = [];
    limiter.reset();
    setReverseDns(async (ip) => (ip === '203.0.113.7' ? ['host-203-0-113-7.acme.com'] : []));
    env = await makeEnv({
      fetch: rdapFetch(calls, (url, init) => {
        if (url.startsWith('https://hooks.test/')) { posted.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); }
        return undefined;
      }),
    });
    ws = env.ctx.db.get('SELECT id FROM workspaces').id;
    site = (await env.api('POST', '/api/visitors/sites', { domain: 'https://www.MySite.com/', key_pages: ['/pricing', '/demo'] })).body;
  });
  afterEach(async () => {
    await settleVisitors();
    setReverseDns(undefined);
    await env.close();
  });

  it('creates sites with an install snippet and serves the script', async () => {
    expect(site.domain).toBe('mysite.com');
    expect(site.snippet).toContain(`/v.js?k=${site.site_key}`);
    const js = await env.app.inject({ method: 'GET', url: `/v.js?k=${site.site_key}` });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.body).toContain('http://bear.test/api/v/collect');
    expect(js.body).toContain('k_vid');
    expect((await env.app.inject({ method: 'GET', url: '/v.js?k=nope' })).statusCode).toBe(404);
  });

  it('collects pageviews with CORS, behind a proxy, and resolves the company', async () => {
    const pre = await env.app.inject({ method: 'OPTIONS', url: '/api/v/collect', headers: { origin: 'https://www.mysite.com', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://www.mysite.com');

    const res = await collect({ t: 'pv', u: 'https://www.mysite.com/pricing?utm_source=newsletter', ti: 'Pricing' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://www.mysite.com');
    await settleVisitors();

    const s = env.ctx.db.get('SELECT * FROM visitor_sessions');
    expect(s).toMatchObject({ ip: '203.0.113.7', pageviews: 1, key_pages: 1, utm_source: 'newsletter', org_status: 'company' });
    const c = env.ctx.db.get('SELECT * FROM visitor_companies');
    expect(c).toMatchObject({ domain: 'acme.com', visits: 1, pageviews: 1, key_pageviews: 1 });

    await collect({ t: 'pv', u: 'https://www.mysite.com/demo' });
    await collect({ t: 'leave', d: 42 });
    const list = (await env.api('GET', '/api/visitors/companies')).body;
    expect(list.data[0]).toMatchObject({ domain: 'acme.com', visits: 1, pageviews: 2, key_pageviews: 2 });
    expect(list.data[0].score).toBeGreaterThan(0);
    const detail = (await env.api('GET', `/api/visitors/companies/${c.id}`)).body;
    expect(detail.sessions[0].events.map((e: any) => e.path)).toEqual(['/pricing', '/demo']);
    expect(detail.sessions[0].duration_s).toBe(42);
    const feed = (await env.api('GET', '/api/visitors/feed')).body.data;
    expect(feed[0]).toMatchObject({ path: '/demo', company: { domain: 'acme.com' } });
    // X-Forwarded-For is used when there is no CF header.
    expect(clientIp({ 'x-forwarded-for': '198.51.100.9, 10.0.0.2' }, '127.0.0.1')).toBe('198.51.100.9');
    expect(clientIp({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1')).toBe('203.0.113.7');
  });

  it('caches IP and network lookups and filters ISP visitors', async () => {
    const deps = { db: env.ctx.db, fetch: env.ctx.fetch, now: env.ctx.now, reverse: async () => [] as string[] };
    expect((await resolveIp(deps, '198.51.100.20')).kind).toBe('isp');
    expect((await resolveIp(deps, '198.51.100.20')).kind).toBe('isp');
    expect((await resolveIp(deps, '198.51.100.21')).kind).toBe('isp'); // same network, cached range
    expect(calls.filter((u) => u.includes('rdap.org'))).toHaveLength(1);
    expect((await resolveIp(deps, '192.168.1.5')).kind).toBe('private');

    await collect({ t: 'pv', u: 'https://mysite.com/' }, { 'cf-connecting-ip': '198.51.100.30' });
    await settleVisitors();
    expect(env.ctx.db.get('SELECT org_status, company_id FROM visitor_sessions')).toEqual({ org_status: 'isp', company_id: null });
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM visitor_companies').n).toBe(0);
  });

  it('rejects foreign origins and unknown keys, ignores bots and Do-Not-Track', async () => {
    expect((await collect({ t: 'pv', u: 'https://evil.com/' }, { origin: 'https://evil.com' })).statusCode).toBe(403);
    expect((await collect({ t: 'pv', k: 'ks_unknown' })).statusCode).toBe(404);
    expect((await collect({ t: 'pv', u: 'https://mysite.com/' }, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).statusCode).toBe(204);
    expect((await collect({ t: 'pv', u: 'https://mysite.com/' }, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36' })).statusCode).toBe(204);
    expect((await collect({ t: 'pv', u: 'https://mysite.com/' }, { dnt: '1' })).statusCode).toBe(204);
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM visitor_sessions').n).toBe(0);
    expect(isBot('curl/8.4.0')).toBe(true);
    expect(isBot(UA)).toBe(false);

    await env.api('PUT', '/api/visitors/settings', { respect_dnt: false });
    expect((await collect({ t: 'pv', u: 'https://mysite.com/' }, { dnt: '1' })).statusCode).toBe(204);
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM visitor_sessions').n).toBe(1);
  });

  it('rate-limits per IP and site', async () => {
    let last = 0;
    for (let i = 0; i <= RATE_LIMITS.perIpPerMinute; i++) last = (await collect({ t: 'click', x: `b${i}`, u: 'https://mysite.com/' })).statusCode;
    expect(last).toBe(429);
    // Another IP is unaffected.
    expect((await collect({ t: 'pv', u: 'https://mysite.com/' }, { 'cf-connecting-ip': '203.0.113.8' })).statusCode).toBe(204);
  });

  it('carries a signed lead token through the click redirect and identifies the lead', async () => {
    const leadId = env.ctx.db.insert('leads', { workspace_id: ws, email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme' });
    env.ctx.db.insert('sent_emails', { workspace_id: ws, lead_id: leadId, message_id: 'm1@x', to_email: 'jane@acme.com', subject: 'Hi', tracking_token: 'tok1', sent_at: '2020-01-01T00:00:00.000Z' });
    const click = (u: string) => env.app.inject({ method: 'GET', url: `/t/c/tok1?u=${encodeURIComponent(u)}&s=${signUrl(env.ctx, 'tok1', u)}`, headers: { 'user-agent': UA } });

    const ours = await click('https://www.mysite.com/pricing?x=1');
    expect(ours.statusCode).toBe(302);
    const loc = new URL(ours.headers.location as string);
    const token = loc.searchParams.get('k_vid')!;
    expect(loc.searchParams.get('x')).toBe('1');
    expect(verifyLeadToken(env.ctx, ws, token)).toBe(leadId);
    expect(verifyLeadToken(env.ctx, ws + 1, token)).toBeNull();
    expect(verifyLeadToken(env.ctx, ws, token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBeNull();
    expect(token).toBe(signLeadToken(env.ctx, ws, leadId));
    const other = await click('https://other.com/page');
    expect(other.headers.location).toBe('https://other.com/page');

    setReverseDns(async () => ['cpe-1-2-3-4.home.example-isp.net']);
    for (let i = 0; i < 3; i++) await collect({ t: 'pv', sid: `sess-${i}`, u: 'https://www.mysite.com/pricing', kv: i === 0 ? token : null });
    await collect({ t: 'pv', sid: 'sess-3', vid: 'other-browser', u: 'https://www.mysite.com/blog' });
    await collect({ t: 'id', sid: 'sess-3', vid: 'other-browser', em: 'bob@acme.com', u: 'https://www.mysite.com/blog' });
    await settleVisitors();

    const people = (await env.api('GET', '/api/visitors/people')).body.data;
    const jane = people.find((p: any) => p.email === 'jane@acme.com');
    expect(jane).toMatchObject({ lead_id: leadId, visits: 3, pageviews: 3, source: 'email_click' });
    expect(jane.summary).toBe('Jane Doe (Acme) viewed /pricing 3 times');
    expect(people.find((p: any) => p.email === 'bob@acme.com')).toMatchObject({ source: 'identify', lead_id: null, pageviews: 1 });
    // Home ISP connection, but the work email puts Jane at acme.com.
    const c = env.ctx.db.get(`SELECT * FROM visitor_companies WHERE domain = 'acme.com'`);
    expect(c.visits).toBe(4);

    const link = (await env.api('POST', '/api/visitors/lead-link', { lead_id: leadId, url: 'https://mysite.com/demo' })).body;
    expect(link.url).toBe(`https://mysite.com/demo?k_vid=${encodeURIComponent(token)}`);
  });

  it('scores depth, key pages, repeat visits and recency', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const s = (daysAgo: number, pageviews: number, key_pages: number, duration_s = 0) => ({ started_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), pageviews, key_pages, duration_s });
    expect(scoreVisits([], now)).toBe(0);
    const one = scoreVisits([s(0, 1, 0)], now);
    expect(one).toBe(3 + 10);
    expect(scoreVisits([s(0, 1, 1)], now)).toBeGreaterThan(one);
    expect(scoreVisits([s(0, 3, 1), s(2, 2, 1), s(5, 4, 2, 300)], now)).toBeGreaterThanOrEqual(60);
    expect(scoreVisits([s(20, 1, 0)], now)).toBeLessThan(one);
    expect(scoreVisits([s(40, 9, 9)], now)).toBe(0);
    expect(scoreVisits(Array.from({ length: 20 }, () => s(0, 20, 10, 9000)), now)).toBe(100);
  });

  it('emits website-visit and high-intent alerts for a known lead, once per day', async () => {
    const leadId = env.ctx.db.insert('leads', { workspace_id: ws, email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme' });
    await env.api('PUT', '/api/visitors/settings', { alert_threshold: 50, alert_webhook_url: 'https://hooks.test/visits' });
    const token = signLeadToken(env.ctx, ws, leadId);
    for (const [sid, path] of [['sess-a', '/pricing'], ['sess-a', '/demo'], ['sess-b', '/pricing'], ['sess-c', '/pricing'], ['sess-c', '/demo']]) {
      await collect({ t: 'pv', sid, u: `https://mysite.com${path}`, kv: token });
      await settleVisitors();
    }
    const types = env.ctx.db.all(`SELECT type FROM events WHERE type IN ('WEBSITE_VISIT','HIGH_INTENT_VISIT')`).map((e) => e.type);
    expect(types.filter((t) => t === 'WEBSITE_VISIT')).toHaveLength(3);
    expect(types.filter((t) => t === 'HIGH_INTENT_VISIT')).toHaveLength(1);
    const hi = JSON.parse(env.ctx.db.get(`SELECT data FROM events WHERE type = 'HIGH_INTENT_VISIT'`).data);
    expect(hi).toMatchObject({ reason: 'known_lead', person: { email: 'jane@acme.com', name: 'Jane Doe' }, company: { domain: 'acme.com' } });
    expect(hi.score).toBeGreaterThanOrEqual(50);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ event: 'HIGH_INTENT_VISIT', person: { email: 'jane@acme.com' } });
  });

  it('alerts on target companies only when they are targets', async () => {
    await env.api('PUT', '/api/visitors/settings', { alert_threshold: 30, target_domains: [] });
    for (const p of ['/pricing', '/demo', '/pricing']) { await collect({ t: 'pv', u: `https://mysite.com${p}` }); await settleVisitors(); }
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM events WHERE type = 'HIGH_INTENT_VISIT'`).n).toBe(0);
    await env.api('PUT', '/api/visitors/settings', { target_domains: ['acme.com'] });
    await collect({ t: 'pv', u: 'https://mysite.com/contact' });
    await settleVisitors();
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM events WHERE type = 'HIGH_INTENT_VISIT'`).n).toBe(1);
  });

  it('prunes raw events past retention and keeps the aggregates', async () => {
    env.clock.now = new Date('2026-01-01T00:00:00Z');
    await collect({ t: 'pv', u: 'https://mysite.com/pricing' });
    await settleVisitors();
    env.clock.now = new Date('2026-06-01T00:00:00Z');
    await collect({ t: 'pv', sid: 'sess-new', u: 'https://mysite.com/pricing' });
    await settleVisitors();
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM visitor_events').n).toBe(2);

    await env.api('PUT', '/api/visitors/settings', { retention_days: 90 });
    expect(pruneVisitorData(env.ctx)).toEqual({ events: 1, sessions: 1 });
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM visitor_events').n).toBe(1);
    expect(env.ctx.db.get(`SELECT visits, pageviews FROM visitor_companies WHERE domain = 'acme.com'`)).toEqual({ visits: 2, pageviews: 2 });
  });

  it('feeds the Website visits signal and pushes companies to a table', async () => {
    await collect({ t: 'pv', u: 'https://mysite.com/pricing' });
    await settleVisitors();
    const kind = signalKind('website_visits');
    const hit = await kind.run({ domain: 'acme.com' }, { settings: env.ctx.gtm!.settings, workspaceId: ws, outreach: env.ctx.gtm!.outreach, log: () => {} });
    expect(hit).toMatchObject({ value: 1, data: { visits30d: 1, pages: [{ path: '/pricing', views: 1 }] } });
    const none = await kind.run({ domain: 'nobody.com' }, { settings: env.ctx.gtm!.settings, workspaceId: ws, outreach: env.ctx.gtm!.outreach, log: () => {} });
    expect(none?.value).toBe(0);
    const look = (await env.api('GET', '/api/visitors/lookup?domain=acme.com')).body;
    expect(look).toMatchObject({ found: true, visits_30d: 1 });

    const pushed = (await env.api('POST', '/api/visitors/push', { min_score: 0, table_name: 'Hot visitors' })).body;
    expect(pushed).toMatchObject({ added: 1, skipped: 0 });
    const again = (await env.api('POST', '/api/visitors/push', { min_score: 0, table_id: pushed.table_id })).body;
    expect(again).toMatchObject({ added: 0, skipped: 1 });
    const table = (await env.api('GET', `/api/gtm/tables/${pushed.table_id}`)).body;
    expect(table.columns.map((c: any) => c.name)).toContain('Website visits');
  });

  it('reports when the tracking URL is not publicly reachable', async () => {
    expect(publicUrlStatus(env.ctx)).toMatchObject({ reachable: true, https: false });
    env.ctx.gtm!.settings.set('TRACKING_PUBLIC_URL', 'http://localhost:4400');
    expect(publicUrlStatus(env.ctx)).toMatchObject({ reachable: false });
    env.ctx.gtm!.settings.set('TRACKING_PUBLIC_URL', 'http://192.168.1.20:4400');
    expect(publicUrlStatus(env.ctx).reachable).toBe(false);
    env.ctx.gtm!.settings.set('TRACKING_PUBLIC_URL', 'https://kinetic.example.com');
    expect(publicUrlStatus(env.ctx)).toMatchObject({ reachable: true, https: true, problem: null });
    const js = await env.app.inject({ method: 'GET', url: `/v.js?k=${site.site_key}` });
    expect(js.body).toContain('https://kinetic.example.com/api/v/collect');
  });
});
