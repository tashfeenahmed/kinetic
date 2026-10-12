import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { queryTerms } from '../src/gtm/providers/openData.ts';

// A tiny stand-in for the YC directory (yc-oss/api), served through the app's injectable fetch.
const YC = [
  { name: 'Dripos', slug: 'dripos', website: 'https://dripos.com', one_liner: 'Point of sale for coffee shops', long_description: 'Modern POS system and payroll for cafes.', industry: 'Fintech', tags: ['Restaurant Tech'] },
  { name: 'OlaClick', slug: 'olaclick', website: 'https://olaclick.com', one_liner: 'Restaurant ordering and POS', long_description: '', industry: 'B2B', tags: ['Restaurant Tech'] },
  { name: 'Positron', slug: 'positron', website: 'https://positron.ai', one_liner: 'Position tracking for robots', long_description: 'A positioning system.', industry: 'Industrials', tags: [] },
  { name: 'Ledgerly', slug: 'ledgerly', website: 'https://ledgerly.com', one_liner: 'Accounting system for SMBs', long_description: '', industry: 'Fintech', tags: [] },
];

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv({
    fetch: (async (url: any) => (String(url).includes('yc-oss') ? Response.json(YC) : new Response('ok'))) as any,
  });
});
afterEach(() => env.close());

describe('find prospects', () => {
  it('understands the query: drops filler words, keeps abbreviations', () => {
    expect(queryTerms('POS System Companies')).toEqual(['pos', 'system']);
    expect(queryTerms('restaurants using point of sale')).toEqual(['point of sale', 'restaurant', 'using']);
  });

  it('matches POS by meaning and ranks the specific word above the generic one', async () => {
    const r = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'POS System Companies' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rows: 2, source: 'YC directory' });
    const t = (await env.api('GET', `/api/gtm/tables/${r.body.id}`)).body;
    expect(t.table.name).toBe('Companies · POS System Companies');
    const company = t.columns.find((c: any) => c.name === 'Company').id;
    expect(t.rows.map((row: any) => row.cells[company].value)).toEqual(['Dripos', 'OlaClick']); // not "Positron" or "Ledgerly"
    expect(t.columns.some((c: any) => c.name === 'Name')).toBe(false); // no empty placeholder column
  });

  it('adds further searches to the same table, skipping rows already there', async () => {
    const first = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'POS', table_name: 'Irish POS' });
    expect(first.body).toMatchObject({ rows: 2 });
    const tables = () => env.api('GET', '/api/gtm/tables').then((r) => (r.body.data ?? r.body).length);
    const before = await tables();
    const again = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'restaurant', table_id: first.body.id });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, rows: 0, duplicates: 2, appended: true });
    const more = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'accounting', table_id: first.body.id });
    expect(more.body).toMatchObject({ id: first.body.id, rows: 1, duplicates: 0 });
    expect(await tables()).toBe(before);
    expect((await env.api('GET', `/api/gtm/tables/${first.body.id}`)).body.rows).toHaveLength(3);
  });

  it('explains a miss instead of creating an empty table', async () => {
    const r = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'underwater basket weaving' });
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/No companies matched .*Y Combinator.*OpenRouter key/);
    expect((await env.api('GET', '/api/gtm/tables')).body).toEqual([]);
  });
});
