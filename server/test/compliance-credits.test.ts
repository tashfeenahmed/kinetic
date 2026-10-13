import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { budgetBlock, useCredits, usedThisMonth } from '../src/gtm/providers/credits.ts';
import { parsePersonLine, roleRank, wantedRoles } from '../src/gtm/providers/people.ts';
import { emailProvenance } from '../src/gtm/engine/runner.ts';

let env: TestEnv;
let calls: string[];
let apolloFree = false;
let hunterRestricted = false;

/** Fake Hunter and Apollo. */
function vendors(url: string, init: any) {
  calls.push(url);
  const u = new URL(url);
  if (u.host === 'api.hunter.io' && hunterRestricted && u.pathname !== '/v2/account') {
    return Response.json({ errors: [{ id: 'restricted_account', code: 429, details: 'Your account was restricted. Please log in to Hunter for more information.' }] }, { status: 429 });
  }
  if (u.host === 'api.hunter.io' && u.pathname === '/v2/email-finder') return Response.json({ data: { email: 'jane.doe@acme.test', score: 96, verification: { status: 'valid' } } });
  if (u.host === 'api.hunter.io' && u.pathname === '/v2/domain-search') {
    return Response.json({ data: { emails: [
      { value: 'sam.ops@acme.test', first_name: 'Sam', last_name: 'Ops', position: 'Operations Manager', confidence: 90, verification: { status: 'valid' }, sources: [] },
      { value: 'ann.boss@acme.test', first_name: 'Ann', last_name: 'Boss', position: 'Chief Executive Officer', confidence: 95, verification: { status: 'valid' }, sources: [{ uri: 'https://acme.test/team' }] },
    ] } });
  }
  if (u.host === 'api.hunter.io' && u.pathname === '/v2/account') return Response.json({ data: { plan_name: 'Free', reset_date: '2026-11-01', requests: { credits: { used: 3, available: 50 } } } });
  if (u.host === 'api.apollo.io' && apolloFree && u.pathname !== '/api/v1/organizations/enrich') {
    return Response.json({ error: `The ${u.pathname.slice(1)} API is not included in your Free plan and is not accessible, even with a master key.`, error_code: 'API_INACCESSIBLE' }, { status: 403 });
  }
  if (u.host === 'api.apollo.io' && u.pathname === '/api/v1/mixed_people/api_search') {
    expect(JSON.parse(init.body).q_organization_domains_list).toEqual(['acme.test']);
    return Response.json({ people: [{ id: 'p1', first_name: 'Lee', title: 'Head of Sales', has_email: true }, { id: 'p2', first_name: 'Ann', title: 'Founder & CEO', has_email: true }] });
  }
  if (u.host === 'api.apollo.io' && u.pathname === '/api/v1/people/match') {
    expect(u.searchParams.get('id')).toBe('p2');
    return Response.json({ person: { name: 'Ann Boss', first_name: 'Ann', last_name: 'Boss', title: 'Founder & CEO', email: 'ann@acme.test', email_status: 'verified', linkedin_url: 'https://linkedin.com/in/annboss' } });
  }
  return new Response('not found', { status: 404 });
}

beforeEach(async () => {
  calls = [];
  apolloFree = false;
  hunterRestricted = false;
  env = await makeEnv({ fetch: (async (url: any, init: any) => vendors(String(url), init)) as typeof fetch });
});
afterEach(() => env.close());

async function settle(tableId: number) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = env.ctx.gtm!.engine.stats(tableId);
    if (!s.pending && !s.running && i > 5) return;
  }
  throw new Error('engine did not settle');
}
async function cell(tableId: number, rowId: number, column: string) {
  const t = (await env.api('GET', `/api/gtm/tables/${tableId}`)).body;
  const col = t.columns.find((c: any) => c.name === column);
  return (await env.api('GET', `/api/gtm/cells/${rowId}/${col.id}`)).body;
}
async function tableWith(rows: Record<string, string>[]) {
  const t = (await env.api('POST', '/api/gtm/tables', { name: 'Prospects' })).body;
  const ids = (await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows })).body.ids as number[];
  return { tableId: t.id as number, ids };
}

describe('paid credits', () => {
  it('meters credits, shows them with the live balance, and skips a vendor at its monthly budget', async () => {
    await env.api('PUT', '/api/gtm/keys', { HUNTER_API_KEY: 'hk' });
    const { tableId, ids } = await tableWith([{ 'Full name': 'Jane Doe', Domain: 'acme.test' }, { 'Full name': 'John Roe', Domain: 'acme.test' }]);
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'Work email', type: 'enrich', config: { kind: 'work_email', providers: ['hunter'], inputs: { fullName: '{{Full name}}', domain: '{{Domain}}' } } })).body.id;

    await env.api('PUT', '/api/gtm/credits/budgets', { hunter: 1 });
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[0]] });
    await settle(tableId);
    expect((await cell(tableId, ids[0], 'Work email')).value.value).toBe('jane.doe@acme.test');
    expect(usedThisMonth(env.ctx.db, 'hunter')).toMatchObject({ calls: 1, credits: 1 });

    // Budget of 1 is used up: the next row skips Hunter instead of spending.
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[1]] });
    await settle(tableId);
    const second = await cell(tableId, ids[1], 'Work email');
    expect(second.meta.attempts).toEqual([{ provider: 'hunter', result: 'skipped: monthly budget reached (1/1)', ms: 0 }]);
    expect(calls.filter((u) => u.includes('email-finder'))).toHaveLength(1);

    const credits = (await env.api('GET', '/api/gtm/credits')).body.data;
    const hunter = credits.find((c: any) => c.id === 'hunter');
    expect(hunter).toMatchObject({ connected: true, used: 1, budget: 1, blocked: 'monthly budget reached (1/1)', live: { remaining: 47, plan: 'Free' } });
    expect(credits.find((c: any) => c.id === 'apollo')).toMatchObject({ connected: false, used: 0, budget: 100 });
  });

  it('remembers endpoints the vendor plan refuses (Apollo free) and skips them until the key changes', async () => {
    apolloFree = true;
    await env.api('PUT', '/api/gtm/keys', { APOLLO_API_KEY: 'free-key', HUNTER_API_KEY: 'hk' });
    const { tableId, ids } = await tableWith([{ 'Full name': 'Jane Doe', Domain: 'acme.test' }, { 'Full name': 'John Roe', Domain: 'acme.test' }]);
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'Work email', type: 'enrich', config: { kind: 'work_email', providers: ['apollo', 'hunter'], inputs: { fullName: '{{Full name}}', domain: '{{Domain}}' } } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[0]] });
    await settle(tableId);
    expect((await cell(tableId, ids[0], 'Work email')).value.provider).toBe('hunter');
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[1]] });
    await settle(tableId);
    expect((await cell(tableId, ids[1], 'Work email')).meta.attempts[0]).toEqual({ provider: 'apollo', result: 'skipped: not on your plan', ms: 0 });
    expect(calls.filter((u) => u.includes('people/match'))).toHaveLength(1);
    const apollo = (await env.api('GET', '/api/gtm/credits')).body.data.find((c: any) => c.id === 'apollo');
    expect(apollo).toMatchObject({ plan_blocked: ['work_email'], used: 0 });

    // A new key (e.g. after upgrading) is tried again.
    await env.api('PUT', '/api/gtm/keys', { APOLLO_API_KEY: 'paid-key-2' });
    expect((await env.api('GET', '/api/gtm/credits')).body.data.find((c: any) => c.id === 'apollo').plan_blocked).toEqual([]);
  });

  it('stops calling a vendor that restricted the account, and says why in Credits', async () => {
    hunterRestricted = true;
    await env.api('PUT', '/api/gtm/keys', { HUNTER_API_KEY: 'hk' });
    const { tableId, ids } = await tableWith([{ 'Full name': 'Jane Doe', Domain: 'acme.test' }, { 'Full name': 'John Roe', Domain: 'acme.test' }]);
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'Work email', type: 'enrich', config: { kind: 'work_email', providers: ['hunter'], inputs: { fullName: '{{Full name}}', domain: '{{Domain}}' } } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[0]] });
    await settle(tableId);
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[1]] });
    await settle(tableId);
    expect((await cell(tableId, ids[1], 'Work email')).meta.attempts[0]).toEqual({ provider: 'hunter', result: 'skipped: account restricted', ms: 0 });
    expect(calls.filter((u) => u.includes('email-finder'))).toHaveLength(1);
    const hunter = (await env.api('GET', '/api/gtm/credits')).body.data.find((c: any) => c.id === 'hunter');
    expect(hunter).toMatchObject({ plan_blocked: ['work_email'], plan_reason: expect.stringContaining('restricted') });
  });

  it('budget helpers', () => {
    expect(budgetBlock(env.ctx.db, 'pdl')).toBeNull();
    useCredits(env.ctx.db, 'pdl', 100);
    expect(budgetBlock(env.ctx.db, 'pdl')).toBe('monthly budget reached (100/100)');
    useCredits(env.ctx.db, 'pdl', 0); // nothing charged → not counted
    expect(usedThisMonth(env.ctx.db, 'pdl').calls).toBe(1);
  });
});

describe('decision makers', () => {
  it('parses people and ranks roles', () => {
    expect(parsePersonLine('Jane Doe | CEO | jane@acme.test | https://www.linkedin.com/in/jane | https://acme.test/team', 'ai_read'))
      .toMatchObject({ name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', title: 'CEO', email: 'jane@acme.test', linkedin: 'https://www.linkedin.com/in/jane', source_url: 'https://acme.test/team' });
    expect(parsePersonLine('Acme | - | - | - | -', 'ai_read')).toBeNull();
    expect(parsePersonLine('Jane Doe | Founder | - | - | -', 'x')!.email).toBeNull();
    const roles = wantedRoles({ title: 'CEO, founder' });
    expect(roles).toEqual(['ceo', 'founder']);
    expect(roleRank('Co-founder & CEO', roles)).toBe(0);
    expect(roleRank('Sales Manager', roles)).toBe(99);
  });

  it('falls back to paid vendors in order when the free AI step finds nobody, recording who found it', async () => {
    // No AI key → the free step finds nobody; Apollo is next and wins (search free, 1 credit for the email).
    await env.api('PUT', '/api/gtm/keys', { APOLLO_API_KEY: 'ak', HUNTER_API_KEY: 'hk' });
    const { tableId, ids } = await tableWith([{ Company: 'Acme', Domain: 'acme.test' }]);
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'Contact', type: 'enrich', config: { kind: 'decision_makers', inputs: { domain: '{{Domain}}', companyName: '{{Company}}' } } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col] });
    await settle(tableId);
    const c = await cell(tableId, ids[0], 'Contact');
    expect(c.value).toMatchObject({ value: 'ann@acme.test', provider: 'apollo', data: { name: 'Ann Boss', title: 'Founder & CEO', found_by: 'apollo', email_source: 'Apollo', email_status: 'verified' } });
    expect(c.meta.attempts.map((a: any) => [a.provider, a.result])).toEqual([['ai_read', 'not found'], ['apollo', 'found']]);
    expect(usedThisMonth(env.ctx.db, 'apollo').credits).toBe(1);
    expect(usedThisMonth(env.ctx.db, 'hunter').credits).toBe(0); // never reached

    // Apollo out of budget → Hunter's domain search, best role first.
    await env.api('PUT', '/api/gtm/credits/budgets', { apollo: 0 });
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], force: true });
    await settle(tableId);
    const h = await cell(tableId, ids[0], 'Contact');
    expect(h.value).toMatchObject({ value: 'ann.boss@acme.test', provider: 'hunter', data: { title: 'Chief Executive Officer', source_url: 'https://acme.test/team', found_by: 'hunter' } });
  });
});

describe('compliance', () => {
  it('unsubscribes are permanent: they survive deleting and re-importing the lead', async () => {
    const lead = (await env.api('POST', '/api/leads', { email: 'Ann@Acme.test', first_name: 'Ann' })).body.data;
    expect(lead.source).toBe('API'); // the test client uses an API token (the app UI records "Added by hand")
    await env.api('PATCH', `/api/leads/${lead.id}/unsubscribe`);
    expect(env.ctx.db.get("SELECT reason, source FROM blacklisted_emails WHERE email = 'ann@acme.test'")).toEqual({ reason: 'unsubscribed', source: 'manual' });

    await env.api('DELETE', `/api/leads/${lead.id}`);
    const again = (await env.api('POST', '/api/leads/bulk/csv', { csv: 'Email,First\nann@acme.test,Ann', mapping: { email: 'Email', first_name: 'First' } })).body.data;
    const fresh = (await env.api('GET', `/api/leads/${again.lead_ids[0]}`)).body.data;
    expect(fresh).toMatchObject({ source: 'CSV import', suppressed: { reason: 'unsubscribed' } });

    const camp = (await env.api('POST', '/api/campaigns', { name: 'C' })).body.data;
    const attach = await env.api('POST', `/api/campaigns/${camp.id}/leads/attach-leads`, { lead_ids: [fresh.id] });
    expect(attach.status).toBeLessThan(300);
    const cl = env.ctx.db.get('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [camp.id, fresh.id]);
    expect(cl == null || cl.status === 'stopped').toBe(true); // never queued for sending
  });

  it('migration moved existing unsubscribes into the permanent list', () => {
    const cols = env.ctx.db.all("SELECT name FROM pragma_table_info('blacklisted_emails')").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['reason', 'source']));
  });

  it('records where a lead\'s email came from when a table row is pushed', async () => {
    await env.api('PUT', '/api/gtm/keys', { HUNTER_API_KEY: 'hk' });
    const { tableId, ids } = await tableWith([{ 'Full name': 'Jane Doe', Domain: 'acme.test' }]);
    const email = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'Work email', type: 'enrich', config: { kind: 'work_email', providers: ['hunter'], inputs: { fullName: '{{Full name}}', domain: '{{Domain}}' } } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [email] });
    await settle(tableId);
    const push = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: 'To leads', type: 'action', config: { kind: 'outreach_update_lead', email: '{{Work email}}', firstName: '{{Full name}}' } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [push], rowIds: ids });
    await settle(tableId);
    const lead = env.ctx.db.get("SELECT source, source_detail FROM leads WHERE email = 'jane.doe@acme.test'");
    expect(lead.source).toBe('Table "Prospects" · found by hunter · 96% · valid');
    expect(JSON.parse(lead.source_detail)).toMatchObject({ table: 'Prospects', column: 'Work email', provider: 'hunter', confidence: '96% · valid' });
  });

  it('provenance for typed-in emails names the table column', () => {
    const store = { table: () => ({ name: 'T' }) };
    expect(emailProvenance('{{Email}}', { Email: 'a@b.test' }, 3, store)).toEqual({ label: 'Table "T" · column Email', detail: { table_id: 3, table: 'T', column: 'Email' } });
  });
});
