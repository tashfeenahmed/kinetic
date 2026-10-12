import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { Db } from '../src/db/db.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';
import { bboxAround, boxSizeKm, haversineKm, tileBox, type BBox } from '../src/sourcing/geo.ts';
import { fieldMask, overpassQuery, setPoliteDelay } from '../src/sourcing/maps.ts';
import { addValues, createList, filterExcluded, isExcluded } from '../src/sourcing/exclusions.ts';
import { dedupeKey, normCompany, normLinkedin, rowIds } from '../src/sourcing/normalize.ts';
import { buildPeopleProfile, buildProfile, parseLinkedinResult, scoreCompany, scorePerson, type CompanyFacts } from '../src/sourcing/lookalikes.ts';
import { runDueSearches } from '../src/sourcing/savedSearches.ts';

beforeAll(() => setPoliteDelay(0));

// ---------- fake upstream services ----------
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const BOX: BBox = { south: 52.0, west: 13.0, north: 52.2, east: 13.3 };

/** 100 places on a 10×10 grid inside BOX; Text Search returns at most 60 per box, 20 per page. */
const PLACES = Array.from({ length: 100 }, (_, i) => ({
  id: `ChIJ${i}`,
  displayName: { text: `Dental Studio ${i}` },
  formattedAddress: `Street ${i}, 10115 Berlin, Germany`,
  addressComponents: [{ longText: 'Berlin', types: ['locality'] }, { longText: 'Germany', types: ['country'] }],
  location: { latitude: 52.005 + (Math.floor(i / 10) * 0.019), longitude: 13.005 + ((i % 10) * 0.029) },
  primaryType: 'dentist', primaryTypeDisplayName: { text: 'Dentist' },
  googleMapsUri: `https://maps.google.com/?cid=${i}`,
  internationalPhoneNumber: `+49 30 ${1000 + i}`, websiteUri: i % 3 ? `https://www.dental${i}.de/` : 'https://www.facebook.com/dental',
  rating: 4.5, userRatingCount: 10 + i,
}));

let osmElements: any[] = [];
const busyOverpass = new Set<string>();
let ycRows: any[] = [];
let serper: any[] = [];

function fakeFetch(calls: Call[]) {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ url, method: init.method ?? 'GET', headers, body: init.body ?? '' });
    if (url.startsWith('https://places.googleapis.com/v1/places:searchText')) {
      const b = JSON.parse(init.body);
      const r = b.locationRestriction.rectangle;
      const inside = PLACES.filter((p) => p.location.latitude >= r.low.latitude && p.location.latitude <= r.high.latitude && p.location.longitude >= r.low.longitude && p.location.longitude <= r.high.longitude).slice(0, 60);
      const offset = Number(b.pageToken ?? 0);
      const page = inside.slice(offset, offset + 20);
      return Response.json({ places: page, ...(offset + 20 < inside.length ? { nextPageToken: String(offset + 20) } : {}) });
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/search')) {
      return Response.json([{ lat: '52.52', lon: '13.40', display_name: 'Berlin, Germany', boundingbox: ['52.33', '52.68', '13.08', '13.76'] }]);
    }
    if (url.includes('/api/interpreter')) {
      if (busyOverpass.has(new URL(url).host)) return new Response('rate limited', { status: 429 });
      return Response.json({ elements: osmElements });
    }
    if (url.includes('yc-oss')) return Response.json(ycRows);
    if (url.startsWith('https://query.wikidata.org')) return Response.json({ results: { bindings: [] } });
    if (url.startsWith('https://www.wikidata.org')) return Response.json({ search: [] });
    if (url.startsWith('https://google.serper.dev')) return Response.json({ organic: serper });
    if (url.startsWith('https://hooks.example')) return new Response('ok');
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const osmEl = (id: number, name: string, extra: Record<string, string> = {}) => ({
  type: 'node', id, lat: 52.5 + id / 1000, lon: 13.4, tags: { name, amenity: 'dentist', 'addr:street': 'Main St', 'addr:housenumber': String(id), 'addr:city': 'Berlin', 'addr:postcode': '10115', ...extra },
});

let env: TestEnv;
let calls: Call[];
beforeEach(async () => {
  calls = [];
  osmElements = [osmEl(1, 'Zahnarzt Eins', { website: 'https://zahn1.de' }), osmEl(2, 'Zahnarzt Zwei', { phone: '+49 30 2' }), osmEl(3, 'Zahnarzt Drei')];
  ycRows = [
    { name: 'Dripos', slug: 'dripos', website: 'https://dripos.com', one_liner: 'Point of sale and payroll for coffee shops', long_description: 'POS system for cafes and restaurants.', industry: 'Fintech', tags: ['Restaurant Tech', 'Payments'], team_size: 40, all_locations: 'Chicago, IL, USA' },
    { name: 'OlaClick', slug: 'olaclick', website: 'https://olaclick.com', one_liner: 'Restaurant ordering and POS', long_description: 'Online ordering and point of sale for restaurants.', industry: 'Fintech', tags: ['Restaurant Tech'], team_size: 35, all_locations: 'Lima, Peru' },
    { name: 'Positron', slug: 'positron', website: 'https://positron.ai', one_liner: 'Position tracking for robots', long_description: '', industry: 'Industrials', tags: [], team_size: 5 },
    { name: 'Ledgerly', slug: 'ledgerly', website: 'https://ledgerly.com', one_liner: 'Accounting for SMBs', long_description: '', industry: 'Fintech', tags: ['Payments'], team_size: 20 },
  ];
  serper = [];
  env = await makeEnv({ fetch: fakeFetch(calls) });
});
afterEach(() => env.close());

// ---------- geometry ----------
describe('tiling', () => {
  it('splits big areas into capped tiles and builds radius boxes', () => {
    const box = bboxAround({ lat: 52.52, lng: 13.4 }, 50); // 100 km square
    const { widthKm, heightKm } = boxSizeKm(box);
    expect(widthKm).toBeGreaterThan(98);
    expect(heightKm).toBeLessThan(102);
    expect(tileBox(box, 20)).toHaveLength(25);
    expect(tileBox(box, 20, 9)).toHaveLength(9);
    // Tiles cover the box exactly.
    const tiles = tileBox(box, 20);
    expect(Math.min(...tiles.map((t) => t.south))).toBeCloseTo(box.south);
    expect(Math.max(...tiles.map((t) => t.east))).toBeCloseTo(box.east);
    expect(haversineKm({ lat: 52.52, lng: 13.4 }, { lat: 48.14, lng: 11.58 })).toBeGreaterThan(500);
  });
});

// ---------- Google Maps / OSM ----------
describe('local business search', () => {
  it('Google Places: field mask, paging and quadrant tiling past the 60-result cap', async () => {
    env.ctx.gtm!.settings.set('GOOGLE_MAPS_API_KEY', 'test-key');
    const r = await env.api('POST', '/api/sources/google-maps/search', { query: 'dentist', bbox: BOX, limit: 500 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.provider).toBe('google');
    expect(r.body.found).toBe(100); // the whole box only ever returns 60; quadrants find the rest
    expect(r.body.tiles).toBe(5);
    const places = calls.filter((c) => c.url.includes('places:searchText'));
    expect(places[0].headers['x-goog-api-key']).toBe('test-key');
    expect(places[0].headers['x-goog-fieldmask']).toBe(fieldMask('contact'));
    expect(places.some((c) => JSON.parse(c.body).pageToken === '20')).toBe(true);
    const row = r.body.rows.find((x: any) => x['Place ID'] === 'ChIJ1');
    expect(row).toMatchObject({ Company: 'Dental Studio 1', Category: 'Dentist', City: 'Berlin', Country: 'Germany', Phone: '+49 30 1001', 'Company domain': 'dental1.de', Rating: 4.5, Reviews: 11 });
    // A Facebook page is not the business's domain.
    expect(r.body.rows.find((x: any) => x['Place ID'] === 'ChIJ0')['Company domain']).toBe('');
  });

  it('basic field mask leaves out the pricier contact fields', () => {
    expect(fieldMask('basic')).not.toContain('websiteUri');
    expect(fieldMask('basic')).toContain('nextPageToken');
  });

  it('OpenStreetMap: geocodes with Nominatim, queries Overpass politely, keeps the radius', async () => {
    const r = await env.api('POST', '/api/sources/google-maps/search', { query: 'dentist', location: 'Berlin', radius_km: 100 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.provider).toBe('osm');
    expect(r.body.rows).toHaveLength(3);
    expect(r.body.rows[0]).toMatchObject({ Company: 'Zahnarzt Eins', Category: 'Dentist', Address: '1 Main St, 10115 Berlin', 'Company domain': 'zahn1.de', 'OSM ID': 'node/1', 'Maps URL': 'https://www.openstreetmap.org/node/1' });
    const nom = calls.find((c) => c.url.includes('nominatim'))!;
    expect(nom.headers['user-agent']).toMatch(/^Kinetic\//);
    const over = calls.filter((c) => c.url.includes('overpass'));
    expect(over.length).toBeGreaterThan(1); // a 200 km box is tiled
    expect(decodeURIComponent(over[0].body)).toContain('["amenity"="dentist"]');
  });

  it('OpenStreetMap: moves to a mirror when Overpass is busy, and says so clearly when all are', async () => {
    busyOverpass.add('overpass-api.de');
    const ok = await env.api('POST', '/api/sources/google-maps/search', { query: 'dentist', location: 'Berlin', radius_km: 5 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.rows).toHaveLength(3);
    expect(calls.some((c) => c.url.startsWith('https://overpass.kumi.systems'))).toBe(true);
    busyOverpass.add('overpass.kumi.systems').add('overpass.private.coffee');
    const busy = await env.api('POST', '/api/gtm/find', { mode: 'google_maps', query: 'dentist', params: { location: 'Berlin', radius_km: 5 } });
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ error: 'provider_busy' });
    expect(busy.body.message).toContain('busy');
    busyOverpass.clear();
  });

  it('builds Overpass queries from categories, raw tags and names', () => {
    const q = overpassQuery('coffee, shop=bakery', BOX, 50);
    expect(q).toContain('nwr["amenity"="cafe"]["name"](52,13,52.2,13.3);');
    expect(q).toContain('nwr["shop"="bakery"]');
    expect(q).toContain('["name"~"coffee",i]');
    expect(q).toMatch(/out center tags 50;$/);
  });

  it('find prospects → google_maps opens a table, exclusions applied', async () => {
    const list = await env.api('POST', '/api/exclusions', { name: 'Customers', values: ['zahn1.de'] });
    expect(list.body.added).toBe(1);
    const r = await env.api('POST', '/api/gtm/find', { mode: 'google_maps', query: 'dentist', params: { location: 'Berlin' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rows: 2, excluded: 1, source: 'OpenStreetMap' });
    const t = (await env.api('GET', `/api/gtm/tables/${r.body.id}`)).body;
    expect(t.table.name).toBe('Local · dentist');
    expect(t.columns.map((c: any) => c.name)).toEqual(expect.arrayContaining(['Company', 'Address', 'Phone', 'OSM ID']));
  });

  it('import/source accepts google_maps', async () => {
    const t = await env.api('POST', '/api/gtm/tables', { name: 'Local' });
    const r = await env.api('POST', `/api/gtm/tables/${t.body.id}/import/source`, { source: 'google_maps', params: { query: 'dentist', location: 'Berlin' }, limit: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ imported: 3, excluded: 0 });
  });
});

// ---------- exclusions ----------
describe('exclusions', () => {
  it('normalises identifiers', () => {
    expect(normCompany('Acme, Inc.')).toBe('acme');
    expect(normCompany('Café Müller GmbH')).toBe('cafe muller');
    expect(normLinkedin('https://de.linkedin.com/in/Jane-Doe/?trk=x')).toBe('linkedin.com/in/jane-doe');
    expect(rowIds({ Email: 'Jane@Acme.com', Company: 'ACME Ltd' })).toEqual({ email: 'jane@acme.com', company: 'acme', domain: 'acme.com' });
  });

  it('inserts 300k entries quickly and filters at scale', () => {
    gtmTestSetup();
    const db = new Db(':memory:');
    const ws = workspace(db);
    const list = createList(db, ws, 'Big list');
    const values = Array.from({ length: 300_000 }, (_, i) => `company${i}.com`);
    const t0 = performance.now();
    const res = addValues(db, ws, list, values);
    const insertMs = performance.now() - t0;
    expect(res.added).toBe(300_000);
    expect(insertMs).toBeLessThan(15_000);
    expect(addValues(db, ws, list, ['company5.com', 'https://www.company6.com/x']).duplicates).toBe(2);

    const rows = Array.from({ length: 5000 }, (_, i) => ({ Company: `Co ${i}`, 'Company domain': `company${i * 100}.com` }));
    const t1 = performance.now();
    const f = filterExcluded(db, ws, rows);
    expect(performance.now() - t1).toBeLessThan(3000);
    expect(f.excluded).toBe(3000); // company0 … company299900
    expect(f.kept).toHaveLength(2000);
    expect(f.reasons).toEqual({ domain: 3000 });

    // An email at an excluded domain is excluded; other workspaces are unaffected.
    expect(isExcluded(db, ws, { Email: 'ceo@company7.com' })).toBe(true);
    expect(isExcluded(db, workspace(db), { Email: 'ceo@company7.com' })).toBe(false);
    db.close();
  });

  it('paste, CSV upload, from a table and from outreach', async () => {
    const l = (await env.api('POST', '/api/exclusions', { name: 'DNC' })).body.id;
    const paste = await env.api('POST', `/api/exclusions/${l}/entries`, { text: 'acme.com\nbob@globex.com\nhttps://www.linkedin.com/in/jane\nInitech LLC\n\n' });
    expect(paste.body).toMatchObject({ added: 4, skipped: 0 });
    const csv = await env.api('POST', `/api/exclusions/${l}/upload`, { csv: 'Name,Website,Email\nHooli Inc,https://hooli.xyz,gavin@hooli.xyz\nPied Piper,piedpiper.com,\n' });
    expect(csv.body.added).toBe(5);

    const t = await env.api('POST', '/api/gtm/tables', { name: 'Accounts' });
    await env.api('POST', `/api/gtm/tables/${t.body.id}/rows`, { rows: [{ Company: 'Umbrella', 'Company domain': 'umbrella.com' }] });
    const ft = await env.api('POST', `/api/exclusions/${l}/from-table`, { table_id: t.body.id });
    expect(ft.body).toEqual({ rows: 1, added: 2 });

    const ws = env.ctx.db.get('SELECT id FROM workspaces LIMIT 1').id;
    env.ctx.db.insert('leads', { workspace_id: ws, email: 'lead@stark.com' });
    const fo = await env.api('POST', `/api/exclusions/${l}/from-outreach`, { scope: 'leads', include_domains: true });
    expect(fo.body).toEqual({ leads: 1, added: 2 });

    const lists = (await env.api('GET', '/api/exclusions')).body;
    expect(lists[0]).toMatchObject({ name: 'DNC', total: 13, counts: { domain: 5, email: 3, company: 4, linkedin: 1, place: 0 } });

    const check = await env.api('POST', '/api/exclusions/check', { values: ['acme.com', 'jane@acme.com', 'Initech', 'new.com'] });
    expect(check.body.results.map((x: any) => x.excluded)).toEqual([true, true, true, false]);

    const entries = await env.api('GET', `/api/exclusions/${l}/entries?kind=domain`);
    expect(entries.body.meta.total).toBe(5);
  });

  it('CSV import into a table can apply exclusions', async () => {
    await env.api('POST', '/api/exclusions', { name: 'x', values: ['acme.com'] });
    const t = await env.api('POST', '/api/gtm/tables', { name: 'Import' });
    const r = await env.api('POST', `/api/gtm/tables/${t.body.id}/import/csv`, { csv: 'Company,Email\nAcme,a@acme.com\nGlobex,b@globex.com\n', exclude: true });
    expect(r.body).toEqual({ imported: 1, excluded: 1 });
  });

  it('YC find applies exclusions', async () => {
    await env.api('POST', '/api/exclusions', { name: 'x', values: ['Dripos'] });
    const r = await env.api('POST', '/api/gtm/find', { mode: 'companies', query: 'POS' });
    expect(r.body).toMatchObject({ rows: 1, excluded: 1 });
  });
});

// ---------- saved searches ----------
describe('saved searches', () => {
  it('re-runs add only new rows, skip exclusions, record history and alert', async () => {
    const s = await env.api('POST', '/api/saved-searches', {
      name: 'Berlin dentists', source: 'google_maps', params: { query: 'dentist', location: 'Berlin' },
      schedule: 'daily', alert: { kind: 'webhook', url: 'https://hooks.example/new' }, run_now: true,
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.run).toMatchObject({ status: 'done', found: 3, new_count: 3, excluded: 0 });
    const tableId = s.body.run.table_id;
    expect(tableId).toBeTruthy();

    // Second run: one new place, one now excluded, the rest already seen.
    osmElements.push(osmEl(4, 'Zahnarzt Vier'), osmEl(5, 'Zahnarzt Fünf'));
    await env.api('POST', '/api/exclusions', { name: 'x', values: ['node/5'], kind: 'place' });
    const r2 = await env.api('POST', `/api/saved-searches/${s.body.id}/run`);
    expect(r2.body).toMatchObject({ status: 'done', found: 5, new_count: 1, excluded: 1, table_id: tableId });
    const r3 = await env.api('POST', `/api/saved-searches/${s.body.id}/run`);
    expect(r3.body).toMatchObject({ found: 5, new_count: 0 });

    const t = (await env.api('GET', `/api/gtm/tables/${tableId}`)).body;
    expect(t.rows).toHaveLength(4);
    const detail = (await env.api('GET', `/api/saved-searches/${s.body.id}`)).body;
    expect(detail.runs.map((x: any) => x.new_count)).toEqual([0, 1, 3]);
    expect(detail.seen_count).toBe(4);

    const hooks = calls.filter((c) => c.url.startsWith('https://hooks.example'));
    expect(hooks).toHaveLength(2); // only runs with new rows alert
    expect(JSON.parse(hooks[1].body)).toMatchObject({ event: 'saved_search.new_results', count: 1, rows: [{ Company: 'Zahnarzt Vier' }] });

    const list = (await env.api('GET', '/api/saved-searches')).body;
    expect(list[0]).toMatchObject({ name: 'Berlin dentists', table_name: 'Berlin dentists', seen_count: 4, last_run: { new_count: 0 } });
  });

  it('the worker runs due searches on schedule', async () => {
    const s = await env.api('POST', '/api/saved-searches', { name: 'Hourly', source: 'google_maps', params: { query: 'dentist', location: 'Berlin' }, schedule: 'hourly' });
    await runDueSearches(env.ctx);
    expect((await env.api('GET', `/api/saved-searches/${s.body.id}/runs`)).body).toHaveLength(0);
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 3_600_000);
    await runDueSearches(env.ctx);
    const runs = (await env.api('GET', `/api/saved-searches/${s.body.id}/runs`)).body;
    expect(runs).toMatchObject([{ trigger: 'schedule', status: 'done', new_count: 3 }]);
    await runDueSearches(env.ctx); // next run is an hour later
    expect((await env.api('GET', `/api/saved-searches/${s.body.id}/runs`)).body).toHaveLength(1);
  });

  it('dedupe keys depend on the source shape', () => {
    expect(dedupeKey({ Company: 'X', 'Place ID': 'ChIJabc' }, 'place')).toBe('place:ChIJabc');
    expect(dedupeKey({ Company: 'X', 'Company domain': 'x.com' }, 'company')).toBe('domain:x.com');
    expect(dedupeKey({ 'Full name': 'A', Company: 'X', 'Company domain': 'x.com', 'LinkedIn URL': 'https://linkedin.com/in/a' }, 'person')).toBe('li:linkedin.com/in/a');
    // Two people at one company are different rows.
    expect(dedupeKey({ 'Full name': 'A', 'Company domain': 'x.com' }, 'person')).not.toBe(dedupeKey({ 'Full name': 'B', 'Company domain': 'x.com' }, 'person'));
    expect(dedupeKey({ Company: 'Joe’s Pizza', City: 'NYC' }, 'place')).toBe(dedupeKey({ Company: "Joe's Pizza", City: 'nyc' }, 'place'));
  });
});

// ---------- lookalikes ----------
describe('lookalikes', () => {
  const facts = (f: Partial<CompanyFacts>): CompanyFacts => ({ domain: '', name: '', description: '', industry: '', location: '', tags: [], tech: [], ...f });

  it('scores candidates by keywords, industry, size and place', () => {
    const p = buildProfile([
      facts({ domain: 'a.com', name: 'A', description: 'Restaurant POS and payments', industry: 'Fintech', employees: 40, location: 'USA' }),
      facts({ domain: 'b.com', name: 'B', description: 'POS for restaurants and cafes', industry: 'Fintech', employees: 60, location: 'USA' }),
    ]);
    expect(p.keywords[0]).toMatchObject({ weight: 1 });
    expect(p.keywords.map((k) => k.term)).toEqual(expect.arrayContaining(['pos', 'restaurant']));
    const good = scoreCompany(p, { name: 'C', domain: 'c.com', description: 'Point of sale for restaurants', industry: 'Fintech', employees: 50, location: 'Austin, USA', source: 't' });
    const bad = scoreCompany(p, { name: 'D', domain: 'd.com', description: 'Robot arms', industry: 'Industrials', employees: 5000, location: 'Japan', source: 't' });
    expect(good.score).toBeGreaterThan(70);
    expect(bad.score).toBeLessThan(15);
    expect(good.reason).toMatch(/keywords: .*restaurant/);
    expect(good.reason).toMatch(/industry: Fintech/);
  });

  it('finds lookalike companies from the free sources, seeds removed', async () => {
    const r = await env.api('POST', '/api/sources/lookalikes/companies', { seeds: ['dripos.com'], tech: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.source).toContain('YC directory');
    const domains = r.body.rows.map((x: any) => x['Company domain']);
    expect(domains).not.toContain('dripos.com');
    expect(domains[0]).toBe('olaclick.com');
    expect(r.body.rows[0].Similarity).toBeGreaterThan(r.body.rows.at(-1).Similarity - 1);
    expect(r.body.profile.keywords.map((k: any) => k.term)).toContain('pos');
  });

  it('scores people by title, seniority and department', () => {
    const p = buildPeopleProfile([{ title: 'VP Sales' }, { title: 'Head of Sales' }]);
    expect(p.seniorities).toEqual(['vp', 'head']);
    expect(p.departments).toEqual(['sales']);
    const vp = scorePerson(p, 'VP of Sales EMEA');
    const eng = scorePerson(p, 'Software Engineer');
    expect(vp.score).toBeGreaterThan(80);
    expect(eng.score).toBeLessThan(30);
    expect(parseLinkedinResult('Jane Doe - VP Sales - Acme | LinkedIn')).toEqual({ name: 'Jane Doe', title: 'VP Sales', company: 'Acme' });
    expect(parseLinkedinResult('John Roe - Head of Sales at Globex | LinkedIn')).toEqual({ name: 'John Roe', title: 'Head of Sales', company: 'Globex' });
  });

  it('finds lookalike people with web search for LinkedIn profiles', async () => {
    env.ctx.gtm!.settings.set('SERPER_API_KEY', 'k');
    serper = [
      { title: 'Jane Doe - VP Sales - Acme | LinkedIn', link: 'https://www.linkedin.com/in/janedoe', snippet: '' },
      { title: 'Sam Lee - Software Engineer - Acme | LinkedIn', link: 'https://uk.linkedin.com/in/samlee', snippet: '' },
      { title: 'Acme careers', link: 'https://acme.com/jobs', snippet: '' },
    ];
    const r = await env.api('POST', '/api/sources/lookalikes/people', { seeds: [{ title: 'VP Sales', company: 'Globex' }], companies: ['acme.com'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows).toEqual([expect.objectContaining({ 'Full name': 'Jane Doe', Title: 'VP Sales', Company: 'Acme', 'LinkedIn URL': 'https://www.linkedin.com/in/janedoe', 'Company domain': 'acme.com' })]);
    const q = JSON.parse(calls.find((c) => c.url.includes('serper'))!.body).q;
    expect(q).toBe('site:linkedin.com/in "VP Sales" "acme"');
  });
});
