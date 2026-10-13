/** Lead sourcing API: local business search, lookalikes, saved searches and exclusion lists. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Ctx } from '../context.ts';
import { auth, canWrite, defineRoutes } from '../http.ts';
import * as ex from './exclusions.ts';
import { geocode, mapsSearch } from './maps.ts';
import { ID_KINDS, type IdKind } from './normalize.ts';
import { appendNewRows, insertRows, providerCtx, runSource, SOURCE_IDS, SOURCES, type SourceId } from './sources.ts';
import { companyProfile } from './lookalikes.ts';
import * as saved from './savedSearches.ts';

const id = z.coerce.number().int().positive();
const kindOrAuto = z.enum(['auto', ...ID_KINDS] as [string, ...string[]]).default('auto') as z.ZodType<IdKind | 'auto'>;
const bbox = z.object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() });
const mapsBody = z.object({
  query: z.string().trim().min(1, 'Say what kind of business, e.g. "dentist"'),
  location: z.string().optional(),
  center: z.object({ lat: z.number(), lng: z.number() }).optional(),
  radius_km: z.number().positive().max(200).optional(),
  bbox: bbox.optional(),
  provider: z.enum(['auto', 'google', 'osm']).default('auto'),
  fields: z.enum(['basic', 'contact']).default('contact'),
  max_tiles: z.number().int().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(2000).default(100),
  exclusions: z.boolean().default(true),
});
const alert = z.object({ kind: z.enum(['slack', 'webhook']).optional(), channel: z.string().optional(), webhookUrl: z.string().optional(), url: z.string().optional() }).default({});
const searchBody = z.object({
  name: z.string().trim().min(1),
  source: z.enum(SOURCE_IDS),
  params: z.record(z.string(), z.any()).default({}),
  max_results: z.number().int().min(1).max(2000).default(100),
  table_id: id.nullable().optional(),
  schedule: z.enum(['off', 'hourly', 'daily', 'weekly']).default('off'),
  apply_exclusions: z.boolean().default(true),
  alert,
  run_now: z.boolean().default(false),
});

/** Modes /api/gtm/find hands to this module. */
export const SOURCING_FIND_MODES = ['google_maps', 'company_lookalikes', 'people_lookalikes', 'funding_rounds'] as const;
export const isSourcingMode = (m: string): m is (typeof SOURCING_FIND_MODES)[number] => (SOURCING_FIND_MODES as readonly string[]).includes(m);

/** Find prospects for the sourcing modes: search, drop exclusions, open a new table. */
export async function sourcingFind(ctx: Ctx, workspaceId: number, b: { mode: (typeof SOURCING_FIND_MODES)[number]; query: string; limit: number; params?: Record<string, unknown>; table_name?: string; table_id?: number }, reply: FastifyReply) {
  const r = await runSource(ctx, workspaceId, b.mode, { query: b.query, ...b.params }, b.limit);
  const f = ex.filterExcluded(ctx.db, workspaceId, r.records);
  if (!f.kept.length) {
    const message = f.excluded
      ? `All ${f.excluded} results for "${b.query}" are on your exclusion lists.`
      : b.mode === 'google_maps' ? `No businesses matched "${b.query}" in that area (${r.label}). Try a broader category, a bigger area, or a different wording.`
        : b.mode === 'funding_rounds' ? `No recently funded companies matched "${b.query}"${(r.meta?.warnings as string[] | undefined)?.length ? ` (${(r.meta!.warnings as string[]).join('; ')})` : ''}. Try more days, another sector, or more countries.`
        : b.mode === 'company_lookalikes' ? `No lookalikes found for ${b.query}. Add more seed companies, or an Apollo/PDL or OpenRouter key on the Integrations page for wider search.`
          : `No similar people found for "${b.query}". Add target companies, or a search key (Serper/Brave) on the Integrations page.`;
    return reply.code(404).send({ error: 'no_results', message, excluded: f.excluded });
  }
  if (b.table_id) {
    const tableId = ctx.gtm!.store.tableIn(b.table_id, workspaceId).id;
    const { ids, duplicates } = appendNewRows(ctx, tableId, f.kept, SOURCES[b.mode].shape);
    return { id: tableId, rows: ids.length, duplicates, appended: true, source: r.label, excluded: f.excluded };
  }
  const label = b.mode === 'google_maps' ? 'Local' : b.mode === 'funding_rounds' ? 'Funded' : b.mode === 'company_lookalikes' ? 'Lookalikes' : 'People like';
  const tableId = ctx.gtm!.store.createTable(workspaceId, b.table_name ?? `${label} · ${b.query}`.slice(0, 60));
  const ids = insertRows(ctx, tableId, f.kept);
  return { id: tableId, rows: ids.length, source: r.label, excluded: f.excluded, ...(r.meta?.warnings ? { warnings: r.meta.warnings } : {}) };
}

export function sourcingRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Lead sourcing');
  const gtm = () => ctx.gtm!;
  const aiReady = () => gtm().settings.has('OPENROUTER_API_KEY') || gtm().settings.has('AI_BASE_URL');

  // ---------- sources ----------
  r.get('/api/sources', 'Prospect sources (for saved searches and imports) and which are ready', async () => {
    const s = gtm().settings;
    const ready: Partial<Record<SourceId, boolean>> = { apollo_people: s.has('APOLLO_API_KEY'), apollo_companies: s.has('APOLLO_API_KEY'), hubspot_contacts: s.has('HUBSPOT_TOKEN'), hubspot_companies: s.has('HUBSPOT_TOKEN'), ai_companies: aiReady() };
    return {
      sources: SOURCE_IDS.map((sid) => ({ id: sid, label: SOURCES[sid].label, shape: SOURCES[sid].shape, ready: ready[sid] ?? true })),
      google_maps: { provider: s.has('GOOGLE_MAPS_API_KEY') ? 'google' : 'osm' },
      ai_ready: aiReady(),
    };
  });

  r.post('/api/sources/geocode', 'Geocode a city or address (OpenStreetMap Nominatim)', async (req) => {
    auth(req);
    const b = z.object({ q: z.string().trim().min(1) }).parse(req.body);
    const g = await geocode(b.q, gtm().settings);
    if (!g) throw Object.assign(new Error(`Couldn't find "${b.q}"`), { statusCode: 404 });
    return g;
  }, { body: z.object({ q: z.string() }) });

  r.post('/api/sources/google-maps/search', 'Preview local businesses (Google Maps or OpenStreetMap) in an area, exclusions applied', async (req) => {
    const a = auth(req);
    const b = mapsBody.parse(req.body);
    const res = await mapsSearch({ query: b.query, location: b.location, center: b.center, radiusKm: b.radius_km, bbox: b.bbox, provider: b.provider, fields: b.fields, maxTiles: b.max_tiles, limit: b.limit }, { settings: gtm().settings });
    const f = b.exclusions ? ex.filterExcluded(ctx.db, a.workspaceId, res.rows) : { kept: res.rows, excluded: 0, reasons: {} };
    return { provider: res.provider, area: res.area, tiles: res.tiles, requests: res.requests, capped: res.capped, found: res.rows.length, excluded: f.excluded, rows: f.kept };
  }, { body: mapsBody });

  const companyLook = z.object({
    seeds: z.union([z.array(z.string()), z.string()]).optional(),
    table_id: id.optional(), column: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50), min_score: z.number().min(0).max(100).optional(),
    tech: z.boolean().optional(), ai: z.boolean().optional(), exclusions: z.boolean().default(true),
  });
  r.post('/api/sources/lookalikes/companies', 'Preview companies similar to seed domains (scored 0–100 with reasons)', async (req) => {
    const a = auth(req);
    const b = companyLook.parse(req.body);
    const run = await runSource(ctx, a.workspaceId, 'company_lookalikes', b, b.limit);
    const f = b.exclusions ? ex.filterExcluded(ctx.db, a.workspaceId, run.records) : { kept: run.records, excluded: 0 };
    return { source: run.label, profile: run.meta?.profile, found: run.records.length, excluded: f.excluded, rows: f.kept };
  }, { body: companyLook });

  const peopleLook = z.object({
    seeds: z.array(z.union([z.string(), z.object({ title: z.string().optional(), company: z.string().optional(), seniority: z.string().optional(), department: z.string().optional() })])).optional(),
    titles: z.string().optional(), table_id: id.optional(), column: z.string().optional(),
    companies: z.union([z.array(z.string()), z.string()]).optional(), location: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50), min_score: z.number().min(0).max(100).optional(),
    max_queries: z.number().int().min(1).max(50).optional(), exclusions: z.boolean().default(true),
  });
  r.post('/api/sources/lookalikes/people', 'Preview people similar to seed people (titles), at target companies or anywhere', async (req) => {
    const a = auth(req);
    const b = peopleLook.parse(req.body);
    const run = await runSource(ctx, a.workspaceId, 'people_lookalikes', b, b.limit);
    const f = b.exclusions ? ex.filterExcluded(ctx.db, a.workspaceId, run.records) : { kept: run.records, excluded: 0 };
    return { source: run.label, profile: run.meta?.profile, found: run.records.length, excluded: f.excluded, rows: f.kept };
  }, { body: peopleLook });

  const preview = z.object({ source: z.enum(SOURCE_IDS), params: z.record(z.string(), z.any()).default({}), limit: z.number().int().min(1).max(2000).default(50), exclusions: z.boolean().default(true) });
  r.post('/api/sources/preview', 'Preview any prospect source without creating a table', async (req) => {
    const a = auth(req);
    const b = preview.parse(req.body);
    const run = await runSource(ctx, a.workspaceId, b.source, b.params, b.limit);
    const f = b.exclusions ? ex.filterExcluded(ctx.db, a.workspaceId, run.records) : { kept: run.records, excluded: 0 };
    return { source: run.label, meta: run.meta, found: run.records.length, excluded: f.excluded, rows: f.kept };
  }, { body: preview });

  const toTable = z.object({ name: z.string().trim().min(1).optional(), table_id: id.optional(), rows: z.array(z.record(z.string(), z.any())).min(1).max(20_000), exclusions: z.boolean().default(true) });
  r.post('/api/sources/to-table', 'Add previewed rows to a new or existing table (exclusions applied)', async (req) => {
    const a = canWrite(req);
    const b = toTable.parse(req.body);
    const f = b.exclusions ? ex.filterExcluded(ctx.db, a.workspaceId, b.rows) : { kept: b.rows, excluded: 0 };
    const tableId = b.table_id ? gtm().store.tableIn(b.table_id, a.workspaceId).id : gtm().store.createTable(a.workspaceId, (b.name ?? 'Prospects').slice(0, 60));
    const ids = insertRows(ctx, tableId, f.kept);
    return { id: tableId, rows: ids.length, excluded: f.excluded };
  }, { body: toTable });

  // ---------- saved searches ----------
  r.get('/api/saved-searches', 'List saved searches with their last run', async (req) => saved.listSearches(ctx, auth(req).workspaceId));

  r.post('/api/saved-searches', 'Save a search (source + params) with a target table and optional schedule/alert', async (req) => {
    const a = canWrite(req);
    const b = searchBody.parse(req.body);
    const sid = saved.createSearch(ctx, a.workspaceId, { ...b, table_id: b.table_id ?? null });
    const run = b.run_now ? await saved.runSavedSearch(ctx, sid, 'api') : undefined;
    return { id: sid, run };
  }, { body: searchBody });

  r.get('/api/saved-searches/:id', 'Get a saved search with its run history', async (req) => {
    const a = auth(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    const seen = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_search_seen WHERE search_id = ?', [s.id])!.n;
    return { ...s, source_label: SOURCES[s.source]?.label, seen_count: seen, runs: saved.runs(ctx, s.id) };
  });

  const patchBody = searchBody.omit({ source: true, run_now: true }).partial();
  r.patch('/api/saved-searches/:id', 'Update a saved search (name, params, schedule, target table, alert)', async (req) => {
    const a = canWrite(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    saved.updateSearch(ctx, s, patchBody.parse(req.body ?? {}));
    return { ok: true };
  }, { body: patchBody });

  r.delete('/api/saved-searches/:id', 'Delete a saved search (its table is kept)', async (req) => {
    const a = canWrite(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    ctx.db.run('DELETE FROM saved_searches WHERE id = ?', [s.id]);
    return { ok: true };
  });

  r.post('/api/saved-searches/:id/run', 'Run a saved search now; only new rows are added to its table', async (req) => {
    const a = canWrite(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    return saved.runSavedSearch(ctx, s.id, 'manual');
  });

  r.get('/api/saved-searches/:id/runs', 'Run history of a saved search (found, new, excluded)', async (req) => {
    const a = auth(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    return saved.runs(ctx, s.id, z.coerce.number().int().min(1).max(500).default(50).parse((req.query as any).limit));
  });

  r.delete('/api/saved-searches/:id/seen', 'Forget what a saved search delivered, so the next run adds everything again', async (req) => {
    const a = canWrite(req);
    const s = saved.searchIn(ctx, id.parse((req.params as any).id), a.workspaceId);
    return { removed: ctx.db.run('DELETE FROM saved_search_seen WHERE search_id = ?', [s.id]).changes };
  });

  // ---------- exclusions ----------
  const listOf = (req: any, workspaceId: number) => ex.listIn(ctx.db, id.parse(req.params.id), workspaceId);

  r.get('/api/exclusions', 'Exclusion lists with entry counts by kind', async (req) => ex.listSummaries(ctx.db, auth(req).workspaceId));

  const createBody = z.object({ name: z.string().trim().min(1), values: z.array(z.string()).optional(), text: z.string().optional(), kind: kindOrAuto });
  r.post('/api/exclusions', 'Create an exclusion list (optionally with values)', async (req) => {
    const a = canWrite(req);
    const b = createBody.parse(req.body);
    const listId = ex.createList(ctx.db, a.workspaceId, b.name);
    const added = ex.addValues(ctx.db, a.workspaceId, listId, [...(b.values ?? []), ...splitText(b.text)], b.kind);
    return { id: listId, ...added };
  }, { body: createBody });

  r.patch('/api/exclusions/:id', 'Rename an exclusion list', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    ctx.db.update('exclusion_lists', l.id, { name: b.name, updated_at: new Date().toISOString() });
    return { ok: true };
  });

  r.delete('/api/exclusions/:id', 'Delete an exclusion list and its entries', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    ctx.db.run('DELETE FROM exclusion_lists WHERE id = ?', [l.id]);
    return { ok: true };
  });

  r.get('/api/exclusions/:id/entries', 'Browse entries of an exclusion list', async (req) => {
    const a = auth(req);
    const l = listOf(req, a.workspaceId);
    const q = z.object({ kind: z.enum(ID_KINDS as [IdKind, ...IdKind[]]).optional(), q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), per_page: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r2 = ex.listEntries(ctx.db, a.workspaceId, l.id, { kind: q.kind, search: q.q, limit: q.per_page, offset: (q.page - 1) * q.per_page });
    return { data: r2.data, meta: { current_page: q.page, per_page: q.per_page, total: r2.total, last_page: Math.max(1, Math.ceil(r2.total / q.per_page)) } };
  });

  const addBody = z.object({ values: z.array(z.string()).optional(), text: z.string().optional(), kind: kindOrAuto });
  r.post('/api/exclusions/:id/entries', 'Add values to an exclusion list (paste: one per line; kind auto-detected)', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = addBody.parse(req.body);
    return ex.addValues(ctx.db, a.workspaceId, l.id, [...(b.values ?? []), ...splitText(b.text)], b.kind);
  }, { body: addBody });

  r.delete('/api/exclusions/:id/entries', 'Remove values from an exclusion list', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = z.object({ values: z.array(z.string()).min(1), kind: kindOrAuto }).parse(req.body);
    return { removed: ex.removeValues(ctx.db, a.workspaceId, l.id, b.values, b.kind) };
  });

  const uploadBody = z.object({ csv: z.string().min(1), column: z.string().optional(), kind: kindOrAuto });
  r.post('/api/exclusions/:id/upload', 'Upload a CSV to an exclusion list (a chosen column, or every domain/email/company/LinkedIn column)', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = uploadBody.parse(req.body);
    const rows: string[][] = parseCsv(b.csv, { skip_empty_lines: true, bom: true, relax_column_count: true, trim: true });
    if (!rows.length) return { received: 0, added: 0, duplicates: 0, skipped: 0 };
    const header = rows[0].map((h) => h.toLowerCase());
    const pick = (re: RegExp) => header.findIndex((h) => re.test(h));
    const cols: { i: number; kind: IdKind | 'auto' }[] = [];
    if (b.column) {
      const i = header.indexOf(b.column.toLowerCase());
      if (i < 0) throw Object.assign(new Error(`No column "${b.column}" in the CSV`), { statusCode: 400 });
      cols.push({ i, kind: b.kind });
    } else {
      for (const [kind, re] of [['email', /e-?mail/], ['linkedin', /linkedin/], ['domain', /domain|website|url/], ['company', /^(company|company name|organi[sz]ation|account|name)$/], ['place', /place.?id|osm/]] as [IdKind, RegExp][]) {
        const i = pick(re);
        if (i >= 0) cols.push({ i, kind });
      }
    }
    // No recognisable header: treat it as a plain list (first column, header row included).
    const body = cols.length ? rows.slice(1) : rows;
    if (!cols.length) cols.push({ i: 0, kind: b.kind });
    const totals = { received: 0, added: 0, duplicates: 0, skipped: 0 };
    for (const c of cols) {
      const res = ex.addValues(ctx.db, a.workspaceId, l.id, body.map((row) => row[c.i] ?? ''), c.kind);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += res[k];
    }
    return { ...totals, columns: cols.map((c) => ({ column: rows[0][c.i], kind: c.kind })) };
  }, { body: uploadBody });

  const fromTable = z.object({ table_id: id, kinds: z.array(z.enum(ID_KINDS as [IdKind, ...IdKind[]])).optional() });
  r.post('/api/exclusions/:id/from-table', 'Add every company/person (domain, email, name, LinkedIn, place id) from a table', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = fromTable.parse(req.body);
    gtm().store.tableIn(b.table_id, a.workspaceId);
    return ex.addFromTable(ctx.db, a.workspaceId, l.id, b.table_id, b.kinds);
  }, { body: fromTable });

  const fromOutreach = z.object({ scope: z.enum(['leads', 'campaigns']).default('campaigns'), include_domains: z.boolean().default(false), include_companies: z.boolean().default(false) });
  r.post('/api/exclusions/:id/from-outreach', 'Exclude everyone already in Outreach (all leads, or leads in any campaign)', async (req) => {
    const a = canWrite(req);
    const l = listOf(req, a.workspaceId);
    const b = fromOutreach.parse(req.body ?? {});
    return ex.addFromOutreach(ctx.db, a.workspaceId, l.id, { scope: b.scope, includeDomains: b.include_domains, includeCompanies: b.include_companies });
  }, { body: fromOutreach });

  const checkBody = z.object({ rows: z.array(z.record(z.string(), z.any())).optional(), values: z.array(z.string()).optional() });
  r.post('/api/exclusions/check', 'Check rows or values against all exclusion lists', async (req) => {
    const a = auth(req);
    const b = checkBody.parse(req.body);
    const { detectKind } = await import('./normalize.ts');
    const rows = [...(b.rows ?? []), ...(b.values ?? []).map((v) => {
      const k = detectKind(v);
      return k === 'domain' ? { Domain: v } : k === 'email' ? { Email: v } : k === 'linkedin' ? { 'LinkedIn URL': v } : k === 'place' ? { 'Place ID': v } : { Company: v };
    })];
    const f = ex.filterExcluded(ctx.db, a.workspaceId, rows);
    const kept = new Set(f.kept);
    return { checked: rows.length, excluded: f.excluded, reasons: f.reasons, results: rows.map((row, i) => ({ index: i, excluded: !kept.has(row) })) };
  }, { body: checkBody });

  // Lookalikes as a one-shot helper for the agent ("who looks like these customers?").
  r.post('/api/sources/lookalikes/profile', 'Build the shared profile (keywords, industry, size, tech) of seed companies', async (req) => {
    const a = auth(req);
    const b = z.object({ seeds: z.array(z.string()).min(1).max(10), tech: z.boolean().optional() }).parse(req.body);
    return companyProfile(b.seeds, providerCtx(ctx, a.workspaceId), { tech: b.tech });
  }, { body: z.object({ seeds: z.array(z.string()), tech: z.boolean().optional() }) });
}

/** Pasted text → values: one per line (or tab/semicolon); "a.com, b.com" lines split on commas too. */
function splitText(text?: string): string[] {
  if (!text) return [];
  return text.split(/[\r\n;\t]+/).flatMap((line) => {
    const parts = line.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length > 1 && parts.every((p) => !/\s/.test(p)) ? parts : [line.trim()];
  }).filter(Boolean);
}
