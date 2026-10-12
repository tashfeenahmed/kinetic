import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { mergedSpf, plan } from '../src/domains/plan.ts';
import type { CfRecord } from '../src/domains/cloudflare.ts';

const rec = (type: string, name: string, content: string, extra: Partial<CfRecord> = {}): CfRecord => ({ id: `${type}-${name}-${content}`.slice(0, 40), type, name, content, ttl: 1, ...extra });

describe('domain DNS plan', () => {
  it('merges SPF instead of adding a second record', () => {
    expect(mergedSpf(['v=spf1 include:mailgun.org ~all'], { domain: 'a.com', provider: 'google' })).toBe('v=spf1 include:_spf.google.com include:mailgun.org ~all');
    expect(mergedSpf([], { domain: 'a.com', provider: 'microsoft' })).toBe('v=spf1 include:spf.protection.outlook.com -all');
  });

  it('plans Google records, replaces old MX, folds duplicate SPF, resolves CNAME conflicts', () => {
    const existing = [
      rec('MX', 'acme.com', 'mx.oldhost.com', { priority: 10 }),
      rec('TXT', 'acme.com', 'v=spf1 include:mailgun.org ~all'),
      rec('TXT', 'acme.com', 'v=spf1 a ~all'),
      rec('A', 'track.acme.com', '1.2.3.4'),
    ];
    const actions = plan(existing, {
      domain: 'acme.com', provider: 'google', verification: 'google-site-verification=abc',
      dkimValue: '"v=DKIM1; k=rsa; " "p=MIIBIjAN"', trackingSubdomain: 'track', trackingTarget: 'app.kinetic.example',
    });
    const summary = actions.map((a) => `${a.op} ${a.type} ${a.name} ${a.content}`);
    expect(summary).toEqual(expect.arrayContaining([
      'create MX acme.com smtp.google.com',
      'delete MX acme.com mx.oldhost.com',
      'update TXT acme.com v=spf1 include:_spf.google.com include:mailgun.org a ~all',
      'delete TXT acme.com v=spf1 a ~all',
      'create TXT google._domainkey.acme.com v=DKIM1; k=rsa; p=MIIBIjAN',
      'create TXT acme.com google-site-verification=abc',
      'create TXT _dmarc.acme.com v=DMARC1; p=none; adkim=r; aspf=r',
      'delete A track.acme.com 1.2.3.4',
      'create CNAME track.acme.com app.kinetic.example',
    ]));
  });

  it('is idempotent once applied', () => {
    const existing = [
      rec('MX', 'b.com', '-'.length ? 'b-com.mail.protection.outlook.com' : '', { priority: 0 }),
      rec('TXT', 'b.com', 'v=spf1 include:spf.protection.outlook.com -all'),
      rec('CNAME', 'autodiscover.b.com', 'autodiscover.outlook.com'),
      rec('TXT', '_dmarc.b.com', 'v=DMARC1; p=none; adkim=r; aspf=r'),
    ];
    expect(plan(existing, { domain: 'b.com', provider: 'microsoft' }).every((a) => a.op === 'keep')).toBe(true);
  });
});

/** In-memory Cloudflare API served through the app's injectable fetch. */
function fakeCloudflare() {
  const zones = [{ id: 'z1', name: 'acme.com', status: 'active', name_servers: ['ana.ns.cloudflare.com'] }];
  const records: CfRecord[] = [rec('MX', 'acme.com', 'mx.old.com', { priority: 10, id: 'old-mx' })];
  let n = 0;
  const calls: string[] = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const handler = async (url: any, init: any) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    if (u.hostname !== 'api.cloudflare.com') return new Response('ok');
    calls.push(`${method} ${u.pathname}`);
    const p = u.pathname.replace('/client/v4', '');
    if (p === '/user/tokens/verify') return ok({ id: 't', status: 'active' });
    if (p === '/zones') return ok(zones.filter((z) => !u.searchParams.get('name') || z.name === u.searchParams.get('name')));
    let m = p.match(/^\/zones\/(\w+)\/dns_records(?:\/(.+))?$/);
    if (m) {
      if (method === 'GET') return ok(records);
      if (method === 'POST') { const r = { ...body, id: `r${++n}` }; records.push(r); return ok(r); }
      const i = records.findIndex((r) => r.id === m![2]);
      if (method === 'PUT') { records[i] = { ...body, id: m[2] }; return ok(records[i]); }
      if (method === 'DELETE') { records.splice(i, 1); return ok({ id: m[2] }); }
    }
    m = p.match(/^\/zones\/\w+\/rulesets\/phases\/http_request_dynamic_redirect\/entrypoint$/);
    if (m) return ok({ id: 'rs', rules: body.rules });
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), { status: 404 });
  };
  return { handler, records, calls };
}

describe('domain setup through Cloudflare', () => {
  let env: TestEnv;
  afterEach(() => env.close());

  it('connects, previews and applies records, and stays in sync', async () => {
    const cf = fakeCloudflare();
    env = await makeEnv({ fetch: cf.handler as any });
    expect((await env.api('POST', '/api/domains/plan', { domain: 'acme.com', provider: 'google' })).status).toBe(400); // no token yet

    await env.api('PUT', '/api/gtm/keys', { CLOUDFLARE_API_TOKEN: 'cf-token' });
    const status = await env.api('GET', '/api/domains/cloudflare');
    expect(status.body.data).toMatchObject({ connected: true, zones: [{ name: 'acme.com', added: false }] });

    const setup = { domain: 'acme.com', provider: 'google', verification: 'google-site-verification=xyz', dkimValue: 'v=DKIM1; k=rsa; p=ABC', dmarcPolicy: 'quarantine', dmarcReportEmail: 'dmarc@acme.com', redirectTo: 'https://acme.io' };
    const preview = await env.api('POST', '/api/domains/plan', setup);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(cf.records).toHaveLength(1); // preview changes nothing
    expect(preview.body.data.actions.filter((a: any) => a.op !== 'keep').length).toBeGreaterThan(4);

    const applied = await env.api('POST', '/api/domains/apply', setup);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.data.results.every((r: any) => r.ok)).toBe(true);
    const contents = cf.records.map((r) => `${r.type} ${r.name} ${r.content}`);
    expect(contents).toEqual(expect.arrayContaining([
      'MX acme.com smtp.google.com',
      'TXT acme.com v=spf1 include:_spf.google.com ~all',
      'TXT google._domainkey.acme.com v=DKIM1; k=rsa; p=ABC',
      'TXT _dmarc.acme.com v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com; adkim=r; aspf=r',
      'TXT acme.com google-site-verification=xyz',
      'A acme.com 192.0.2.1',
    ]));
    expect(contents).not.toContain('MX acme.com mx.old.com');
    expect(cf.calls).toContain('PUT /client/v4/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint');

    // A second preview has nothing left to do.
    const again = await env.api('POST', '/api/domains/plan', setup);
    expect(again.body.data.actions.every((a: any) => a.op === 'keep')).toBe(true);

    const list = await env.api('GET', '/api/domains');
    expect(list.body.data).toMatchObject([{ domain: 'acme.com', provider: 'google' }]);
    expect(list.body.meta.cloudflare_connected).toBe(true);
  }, 30_000);
});
