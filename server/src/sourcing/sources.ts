/**
 * One entry point for every prospect source, so Find prospects, table imports and
 * saved searches all run the same code: `runSource(ctx, workspaceId, source, params, limit)`.
 */
import type { Ctx as AppCtx } from '../context.ts';
import type { Ctx } from '../gtm/providers/types.ts';
import * as integ from '../gtm/providers/integrations.ts';
import { githubPeople, jobsSearch, ycSearch } from '../gtm/providers/openData.ts';
import { aiCompanySearch } from '../gtm/providers/aiSearch.ts';
import { tableRows } from './exclusions.ts';
import { mapsSearch, type MapsQuery } from './maps.ts';
import { companyLookalikes, peopleLookalikes, type PersonSeed } from './lookalikes.ts';
import { dedupeKey, rowIds, type SourceShape } from './normalize.ts';
import { fundingRounds } from './funding/index.ts';

export const SOURCES = {
  google_maps: { label: 'Local businesses (Google Maps / OpenStreetMap)', shape: 'place' },
  funding_rounds: { label: 'Recently funded companies (official filings: US, UK, FR, ES, CH, NO)', shape: 'company' },
  company_lookalikes: { label: 'Lookalike companies', shape: 'company' },
  people_lookalikes: { label: 'Lookalike people', shape: 'person' },
  find_companies: { label: 'Companies (YC directory, then AI web search)', shape: 'company' },
  ai_companies: { label: 'Companies (AI web search)', shape: 'company' },
  yc_companies: { label: 'YC directory', shape: 'company' },
  apollo_companies: { label: 'Apollo companies', shape: 'company' },
  apollo_people: { label: 'Apollo people', shape: 'person' },
  github_people: { label: 'GitHub org members', shape: 'person' },
  jobs: { label: 'Public job boards', shape: 'job' },
  hubspot_contacts: { label: 'HubSpot contacts', shape: 'person' },
  hubspot_companies: { label: 'HubSpot companies', shape: 'company' },
} as const satisfies Record<string, { label: string; shape: SourceShape }>;

export type SourceId = keyof typeof SOURCES;
export const SOURCE_IDS = Object.keys(SOURCES) as [SourceId, ...SourceId[]];

export interface SourceRun {
  records: Record<string, unknown>[];
  /** Human label of what actually answered ("YC directory", "OpenStreetMap"…). */
  label: string;
  meta?: Record<string, unknown>;
}

export function providerCtx(app: AppCtx, workspaceId: number, log: (m: string) => void = () => {}): Ctx {
  return { settings: app.gtm!.settings, dataDir: app.config.dataDir, workspaceId, outreach: app.gtm!.outreach, log };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\n,]+/)).map((x) => x.trim()).filter(Boolean);
const aiReady = (c: Ctx) => c.settings.has('OPENROUTER_API_KEY') || c.settings.has('AI_BASE_URL');

/** Seeds for lookalikes: explicit values, or a column (or detected ids) of a table in the workspace. */
function seedsFromTable(app: AppCtx, workspaceId: number, p: Record<string, any>): Record<string, unknown>[] {
  if (!p.table_id) return [];
  app.gtm!.store.tableIn(Number(p.table_id), workspaceId);
  return tableRows(app.db, Number(p.table_id)).slice(0, Number(p.max_seeds ?? 25));
}

const headline = (v: unknown): string => (v && typeof v === 'object' && 'value' in (v as any) ? headline((v as any).value) : v == null ? '' : String(v));

export async function runSource(app: AppCtx, workspaceId: number, source: SourceId, params: Record<string, any>, limit: number, log?: (m: string) => void): Promise<SourceRun> {
  const ctx = providerCtx(app, workspaceId, log);
  const settings = ctx.settings;
  switch (source) {
    case 'google_maps': {
      const r = await mapsSearch({ ...(params as MapsQuery), radiusKm: params.radiusKm ?? params.radius_km, maxTiles: params.maxTiles ?? params.max_tiles, limit }, { settings, log: ctx.log });
      return { records: r.rows, label: r.provider === 'google' ? 'Google Maps' : 'OpenStreetMap', meta: { provider: r.provider, area: r.area, tiles: r.tiles, requests: r.requests, capped: r.capped } };
    }
    case 'funding_rounds': {
      const r = await fundingRounds({ ...ctx, db: app.db }, params, limit);
      const countries = Object.entries(r.perCountry).map(([c, n]) => `${c.toUpperCase()} ${n}`).join(', ');
      return { records: r.rows, label: `official filings (${countries})`, meta: { perCountry: r.perCountry, warnings: r.warnings } };
    }
    case 'company_lookalikes': {
      const fromTable = seedsFromTable(app, workspaceId, params).map((row) => (params.column ? headline(row[params.column]) : rowIds(row).domain ?? '')).filter(Boolean);
      const seeds = [...list(params.seeds ?? params.domains ?? params.query), ...fromTable];
      const r = await companyLookalikes(seeds, ctx, { limit, minScore: params.min_score, tech: params.tech, useAi: params.ai });
      return { records: r.rows, label: r.sources.join(' + ') || 'lookalikes', meta: { profile: { ...r.profile, seeds: r.profile.seeds.map((s) => ({ domain: s.domain, name: s.name, industry: s.industry, employees: s.employees })) } } };
    }
    case 'people_lookalikes': {
      let seeds: PersonSeed[] = Array.isArray(params.seeds) ? params.seeds.map((s: any) => (typeof s === 'string' ? { title: s } : s)) : list(params.titles ?? params.query).map((title) => ({ title }));
      const rows = seedsFromTable(app, workspaceId, params);
      if (rows.length) {
        const get = (row: Record<string, unknown>, ...names: string[]) => { for (const [k, v] of Object.entries(row)) if (names.includes(k.toLowerCase())) return headline(v); return ''; };
        seeds = [...seeds, ...rows.map((row) => ({ title: params.column ? headline(row[params.column]) : get(row, 'title', 'job title', 'position'), company: get(row, 'company') }))].filter((s) => s.title);
      }
      const r = await peopleLookalikes(seeds, ctx, { companies: list(params.companies), location: params.location, limit, minScore: params.min_score, maxQueries: params.max_queries });
      return { records: r.rows, label: r.sources.join(' + ') || 'web search', meta: { profile: r.profile } };
    }
    case 'find_companies': {
      let records: Record<string, unknown>[] = [];
      let label = '';
      if (!params.ai) { records = await ycSearch({ query: params.query, limit }); label = 'YC directory'; }
      if (!records.length && aiReady(ctx)) { records = await aiCompanySearch(String(params.query ?? ''), ctx, Math.min(limit, 40)); label = 'AI web search'; }
      return { records, label };
    }
    case 'ai_companies':
      if (!aiReady(ctx)) throw new Error('Add an OpenRouter key (or AI base URL) on the Integrations page for AI web search');
      return { records: await aiCompanySearch(String(params.query ?? ''), ctx, Math.min(limit, 40)), label: 'AI web search' };
    case 'yc_companies': return { records: await ycSearch({ ...params, limit }), label: 'YC directory' };
    case 'apollo_companies': return { records: await integ.apolloCompanySearch(settings, { ...params, limit }), label: 'Apollo' };
    case 'apollo_people': return { records: await integ.apolloPeopleSearch(settings, { ...params, limit }), label: 'Apollo' };
    case 'github_people': {
      const q = String(params.query ?? '');
      const p = params.org || params.domain ? params : q.includes('.') ? { domain: q } : { org: q };
      return { records: await githubPeople(settings.get('GITHUB_TOKEN'), { ...p, limit: Math.min(limit, 200) }), label: 'GitHub org members' };
    }
    case 'jobs': return { records: await jobsSearch(settings, { domains: params.domains ?? params.query, keywords: params.keywords, limit }), label: 'public job boards' };
    case 'hubspot_contacts': return { records: await integ.hubspotImport(settings, 'contacts', ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'website', 'phone', 'lifecyclestage'], limit), label: 'HubSpot' };
    case 'hubspot_companies': return { records: await integ.hubspotImport(settings, 'companies', ['name', 'domain', 'industry', 'numberofemployees', 'city', 'country'], limit), label: 'HubSpot' };
  }
}

/** Rows into a table, then every auto-run column runs on them (same as the tables API). */
/** Adds only records not already in the table (same dedupe key as saved searches). */
export function appendNewRows(app: AppCtx, tableId: number, records: Record<string, unknown>[], shape: SourceShape): { ids: number[]; duplicates: number } {
  const seen = new Set(tableRows(app.db, tableId).map((r) => dedupeKey(r, shape)));
  const fresh = records.filter((r) => { const k = dedupeKey(r, shape); if (seen.has(k)) return false; seen.add(k); return true; });
  return { ids: fresh.length ? insertRows(app, tableId, fresh) : [], duplicates: records.length - fresh.length };
}

export function insertRows(app: AppCtx, tableId: number, records: Record<string, unknown>[]): number[] {
  const { store, engine, bus } = app.gtm!;
  const ids = store.addRows(tableId, records);
  bus.publish({ type: 'rows', tableId });
  bus.publish({ type: 'columns', tableId });
  const auto = store.columns(tableId).filter((c) => c.auto_run && c.type !== 'text').map((c) => c.id);
  if (auto.length && ids.length) engine.run(tableId, { columnIds: auto, rowIds: ids });
  return ids;
}
