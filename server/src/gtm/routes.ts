import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as toCsv } from 'csv-stringify/sync';
import type { Ctx } from '../context.ts';
import { auth, canWrite, requireAdmin, defineRoutes, type Auth } from '../http.ts';
import { RUNNABLE, type ColumnType } from './engine/store.ts';
import { estimateRun } from './engine/estimate.ts';
import { listModels, DEFAULT_MODEL } from './engine/agent.ts';
import { ENRICH_KINDS } from './providers/catalog.ts';
import { CREDIT_PROVIDERS, creditsOverview, setBudgets } from './providers/credits.ts';
import { SIGNAL_KINDS } from './providers/signals.ts';
import * as integ from './providers/integrations.ts';
import { webSearch } from './providers/search.ts';
import { githubPeople, jobsSearch, ycSearch } from './providers/openData.ts';
import { aiCompanySearch } from './providers/aiSearch.ts';
import { SETTING_KEYS, type SettingKey } from './settings.ts';
import { SETTINGS_META } from './settingsMeta.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unwrap, stringify } from './lib/template.ts';
import { csvSafe } from '../lib/csv.ts';
import { filterExcluded } from '../sourcing/exclusions.ts';
import { isSourcingMode, sourcingFind } from '../sourcing/routes.ts';
import { appendNewRows, runSource } from '../sourcing/sources.ts';
import { actionNeeds, missingConnections, requireConnected } from './requirements.ts';

const id = z.coerce.number().int().positive();
/** Phone numbers and emails a page showed only partly: "01 286...", "j***@acme.com", "087 XXX XXXX". */
export function looksMasked(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!/\d|@/.test(t)) return false;
  return /(\.{3}|…)$/.test(t) || /\*{2,}|\bx{3,}\b/i.test(t);
}

function maskedValues(records: Record<string, unknown>[]) {
  const out: { row: number; column: string; value: string }[] = [];
  records.forEach((r, i) => { for (const [k, v] of Object.entries(r)) if (looksMasked(v)) out.push({ row: i, column: k, value: String(v) }); });
  return out.slice(0, 50);
}

const PERSON_SIGNALS = new Set(['job_change', 'outreach_status']);
const COLUMN_TYPES = ['text', 'formula', 'extract', 'enrich', 'ai', 'http', 'signal', 'action', 'lookup', 'function'] as const;

export function gtmRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, engine, settings, bus } = ctx.gtm!;
  const config = ctx.config;
  const r = defineRoutes(app, 'Tables & Enrichment');
  /** The table id from the URL, verified to belong to the caller's workspace. */
  const tableOf = (req: any, a: Auth) => store.tableIn(id.parse(req.params.id), a.workspaceId).id;
  const columnOf = (req: any, a: Auth) => { const c = store.column(id.parse(req.params.id)); store.tableIn(c.table_id, a.workspaceId); return c; };
  // ---------- catalog (drives the column editor) ----------
  // ---------- paid data credits ----------
  r.get('/api/gtm/credits', 'Paid data credits (Apollo, Hunter, Prospeo, People Data Labs): used this month, monthly budget, live balance', async (req) => {
    auth(req);
    return { data: await creditsOverview(settings) };
  });
  const budgetBody = z.object(Object.fromEntries(CREDIT_PROVIDERS.map((p) => [p, z.number().int().min(0).max(1_000_000).optional()])) as Record<string, z.ZodOptional<z.ZodNumber>>);
  r.put('/api/gtm/credits/budgets', 'Set the monthly credit budget per paid data vendor (0 = never use it); waterfalls skip a vendor once its budget is used', async (req) => {
    requireAdmin(req);
    const b = budgetBody.parse(req.body ?? {});
    setBudgets(settings.db, b as any);
    return { data: await creditsOverview(settings) };
  }, { body: budgetBody });

  r.get('/api/gtm/catalog', 'Enrichments, signals, actions and AI models', async () => ({
    enrich: ENRICH_KINDS.map((k) => ({ id: k.id, label: k.label, description: k.description, inputs: k.inputs, needs: k.needs, steps: k.steps.map((s) => ({ id: s.id, label: s.label, cost: s.cost, requires: s.requires, ready: s.requires.every((r) => settings.has(r)) })) })),
    signals: SIGNAL_KINDS.map((k) => ({ id: k.id, label: k.label, description: k.description, inputs: k.inputs, requires: k.requires, missing: missingConnections(k.requires, settings) })),
    actions: [
      { id: 'outreach_campaign', label: 'Add to campaign', ready: true },
      { id: 'outreach_update_lead', label: 'Create or update lead', ready: true },
      { id: 'slack', label: 'Send Slack message', ready: settings.has('SLACK_WEBHOOK_URL') || settings.has('SLACK_BOT_TOKEN'), missing: missingConnections(actionNeeds('slack'), settings) },
      { id: 'webhook', label: 'Send webhook / HTTP request', ready: true },
      { id: 'hubspot_contact', label: 'HubSpot: upsert contact', ready: settings.has('HUBSPOT_TOKEN'), missing: missingConnections(actionNeeds('hubspot_contact'), settings) },
      { id: 'hubspot_company', label: 'HubSpot: upsert company', ready: settings.has('HUBSPOT_TOKEN'), missing: missingConnections(actionNeeds('hubspot_company'), settings) },
      { id: 'salesforce', label: 'Salesforce: upsert record', ready: settings.has('SALESFORCE_CLIENT_ID'), missing: missingConnections(actionNeeds('salesforce'), settings) },
      { id: 'send_to_table', label: 'Send to another table', ready: true },
    ],
    models: await listModels(),
    defaultModel: settings.get('AI_MODEL') || DEFAULT_MODEL,
    aiReady: settings.has('OPENROUTER_API_KEY') || settings.has('AI_BASE_URL'),
  }));

  // ---------- tables ----------
  r.get('/api/gtm/tables', 'List tables', async (req) => store.listTables(auth(req).workspaceId));

  r.post('/api/gtm/tables', 'Create a table (optionally from a template)', async (req) => {
    const a = canWrite(req);
    const body = z.object({ name: z.string().min(1).default('Untitled table'), template: z.enum(['blank', 'people', 'companies', 'company_research', 'find_emails', 'signals']).default('blank') }).parse(req.body ?? {});
    const tableId = store.createTable(a.workspaceId, body.name);
    const text = (...names: string[]) => names.forEach((name) => store.createColumn(tableId, { name, type: 'text' }));
    switch (body.template) {
      case 'people': text('Full name', 'Company', 'Company domain', 'Title', 'LinkedIn URL'); break;
      case 'companies': case 'signals': text('Company', 'Company domain'); break;
      case 'company_research':
        text('Company', 'Company domain');
        store.createColumn(tableId, { name: 'Company info', type: 'enrich', auto_run: true, config: { kind: 'company_profile', inputs: { domain: '{{Company domain}}', companyName: '{{Company}}' } } });
        store.createColumn(tableId, { name: 'Employees', type: 'extract', auto_run: true, config: { source: 'Company info', path: 'employees' } });
        store.createColumn(tableId, { name: 'Tech stack', type: 'signal', auto_run: true, config: { kind: 'tech_stack', inputs: { domain: '{{Company domain}}' } } });
        store.createColumn(tableId, { name: 'Open roles', type: 'signal', auto_run: true, config: { kind: 'hiring', inputs: { domain: '{{Company domain}}', companyName: '{{Company}}' } } });
        store.createColumn(tableId, { name: 'Research', type: 'ai', config: { prompt: 'Research {{Company}} ({{Company domain}}). What do they sell, to whom, and what changed recently?', outputs: [{ name: 'summary', type: 'string', description: 'two sentences' }, { name: 'icp', type: 'string', description: 'who they sell to' }], webSearch: true, fetchPages: true, maxSteps: 6 } });
        store.createColumn(tableId, { name: 'Fit score', type: 'enrich', config: { kind: 'fit_score', inputs: { companyName: '{{Company}}', domain: '{{Company domain}}', context: '{{Research.summary}}' } } });
        break;
      case 'find_emails':
        text('Full name', 'Company domain');
        store.createColumn(tableId, { name: 'Work email', type: 'enrich', auto_run: true, config: { kind: 'work_email', inputs: { fullName: '{{Full name}}', domain: '{{Company domain}}' } } });
        store.createColumn(tableId, { name: 'Email status', type: 'enrich', auto_run: true, config: { kind: 'verify_email', inputs: { email: '{{Work email}}' } } });
        store.createColumn(tableId, { name: 'LinkedIn', type: 'enrich', config: { kind: 'linkedin_url', inputs: { fullName: '{{Full name}}', companyName: '{{Company domain}}' } } });
        break;
      default: text('Name');
    }
    return { id: tableId };
  });

  r.get('/api/gtm/tables/:id', 'Get a table with columns, rows and cells', async (req) => {
    const a = auth(req);
    const tableId = tableOf(req, a);
    const table = store.table(tableId);
    return {
      table: { ...table, webhookUrl: `${config.publicUrl}/hooks/${table.webhook_token}` },
      columns: store.columns(tableId),
      rows: store.grid(tableId),
      queue: engine.stats(tableId),
    };
  });

  r.patch('/api/gtm/tables/:id', 'Rename a table or set its refresh schedule', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({ name: z.string().min(1).optional(), schedule: z.object({ enabled: z.boolean(), everyMinutes: z.number().int().min(5), columnIds: z.array(z.number()) }).optional() }).parse(req.body);
    store.updateTable(tableId, { name: body.name, schedule: body.schedule ? { ...store.table(tableId).schedule, ...body.schedule, lastRunAt: undefined } : undefined });
    if (body.name) bus.publish({ type: 'columns', tableId }); // open table pages refresh their title
    return { ok: true };
  });

  r.delete('/api/gtm/tables/:id', 'Delete a table', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    engine.cancel(tableId);
    store.deleteTable(tableId);
    return { ok: true };
  });

  /**
   * Home "Find new prospects": search first, create a table only when something was found.
   * Companies: YC directory (free), falling back to an AI web search when it has no match.
   */
  const findBody = z.object({
    mode: z.enum(['companies', 'people', 'jobs', 'google_maps', 'company_lookalikes', 'people_lookalikes', 'funding_rounds']),
    params: z.record(z.string(), z.any()).optional(), // google_maps: location/radius_km/bbox…; lookalikes: companies, location…
    query: z.string().trim().min(1, 'Type what you are looking for'),
    limit: z.number().int().min(1).max(500).default(100),
    ai: z.boolean().optional(), // force the AI web search for companies
    table_name: z.string().trim().min(1).max(120).optional(), // name for the new table (default: "<Kind> · <query>")
    table_id: z.number().int().positive().optional(), // add to this existing table instead (skips rows already in it)
  });
  r.post('/api/gtm/find', 'Find prospects and open them in a new table (or add them to an existing one with table_id, skipping duplicates)', async (req, reply) => {
    const a = canWrite(req);
    const b = findBody.parse(req.body ?? {});
    if (isSourcingMode(b.mode)) return sourcingFind(ctx, a.workspaceId, { ...b, mode: b.mode }, reply);
    const aiReady = settings.has('OPENROUTER_API_KEY') || settings.has('AI_BASE_URL');
    let records: Record<string, unknown>[] = [];
    let source = '';
    if (b.mode === 'companies') {
      if (!b.ai) { records = await ycSearch({ query: b.query, limit: b.limit }); source = 'YC directory'; }
      if (!records.length && aiReady) {
        records = await aiCompanySearch(b.query, { settings, log: () => {}, workspaceId: a.workspaceId }, Math.min(b.limit, 40));
        source = 'AI web search';
      }
    } else if (b.mode === 'people') {
      const q = b.query;
      records = await githubPeople(settings.get('GITHUB_TOKEN'), { ...(q.includes('.') ? { domain: q } : { org: q }), limit: Math.min(b.limit, 50) });
      source = 'GitHub org members';
    } else {
      records = await jobsSearch(settings, { domains: b.query, limit: b.limit });
      source = 'public job boards';
    }
    const excl = filterExcluded(store.db, a.workspaceId, records);
    if (excl.excluded && !excl.kept.length) return reply.code(404).send({ error: 'no_results', message: `All ${excl.excluded} results for "${b.query}" are on your exclusion lists.`, excluded: excl.excluded });
    records = excl.kept;
    if (!records.length) {
      const why = b.mode === 'companies'
        ? `No companies matched "${b.query}". The free Companies search covers the ~6,000 Y Combinator startups${aiReady ? ', and the AI web search found nothing either' : ''}. Try simpler keywords (e.g. "point of sale", "payments", "restaurant software")${aiReady ? '' : ', or add an OpenRouter key on the Integrations page to search the whole web with AI'}.`
        : b.mode === 'people'
          ? `No public members found for "${b.query}" on GitHub. Many companies keep membership private — try their GitHub org name (e.g. "vercel").`
          : `No open roles found for "${b.query}" on public job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio).`;
      return reply.code(404).send({ error: 'no_results', message: why, ai_available: aiReady });
    }
    if (b.table_id) {
      const tableId = store.tableIn(b.table_id, a.workspaceId).id;
      const { ids, duplicates } = appendNewRows(ctx, tableId, records, b.mode === 'companies' ? 'company' : b.mode === 'people' ? 'person' : 'job');
      return { id: tableId, rows: ids.length, duplicates, appended: true, source, excluded: excl.excluded };
    }
    const label = b.mode === 'companies' ? 'Companies' : b.mode === 'people' ? 'People' : 'Jobs';
    const tableId = store.createTable(a.workspaceId, b.table_name ?? `${label} · ${b.query}`.slice(0, 60));
    const ids = store.addRows(tableId, records);
    afterInsert(tableId, ids);
    return { id: tableId, rows: ids.length, source, excluded: excl.excluded };
  }, { body: findBody });

  /** Outreach → tables: open leads (selected, a list, a campaign's, or all) as a table to enrich. */
  const fromLeads = z.object({
    name: z.string().min(1).optional(),
    lead_ids: z.array(z.number().int().positive()).optional(),
    list_id: z.number().int().positive().optional(),
    campaign_id: z.number().int().positive().optional(),
    all: z.boolean().optional(),
    sync_back: z.boolean().default(true),
  });
  r.post('/api/gtm/tables/from-leads', 'Open leads in a new table', async (req) => {
    const a = canWrite(req);
    const b = fromLeads.parse(req.body ?? {});
    const ctxDb = store.db;
    const records = ctx.gtm!.outreach.leadsForTable(a.workspaceId, { leadIds: b.lead_ids, listId: b.list_id, campaignId: b.campaign_id, all: b.all });
    const name = b.name
      ?? (b.campaign_id ? `Leads · ${ctxDb.get<{ name: string }>('SELECT name FROM campaigns WHERE id = ?', [b.campaign_id])?.name ?? 'campaign'}`
        : b.list_id ? `Leads · ${ctxDb.get<{ name: string }>('SELECT name FROM lead_lists WHERE id = ?', [b.list_id])?.name ?? 'list'}`
        : `Leads · ${records.length}`);
    const tableId = store.createTable(a.workspaceId, name);
    for (const col of ['Email', 'First name', 'Last name', 'Full name', 'Company', 'Title', 'Company domain', 'Lead status']) store.createColumn(tableId, { name: col, type: 'text' });
    store.createColumn(tableId, { name: 'Outreach status', type: 'signal', auto_run: true, config: { kind: 'outreach_status', inputs: { email: '{{Email}}' } } });
    if (b.sync_back) {
      // Enrichment columns added later can be mapped here so leads pick them up as custom variables.
      store.createColumn(tableId, {
        name: 'Sync to lead', type: 'action', auto_run: false,
        config: { kind: 'outreach_update_lead', email: '{{Email}}', firstName: '{{First name}}', lastName: '{{Last name}}', company: '{{Company}}', title: '{{Title}}', variables: [] },
      });
    }
    const ids = store.addRows(tableId, records);
    afterInsert(tableId, ids);
    return { id: tableId, rows: ids.length };
  }, { body: fromLeads });

  // ---------- columns ----------
  const columnBody = z.object({
    name: z.string().min(1),
    type: z.enum(COLUMN_TYPES),
    config: z.record(z.string(), z.any()).default({}),
    auto_run: z.boolean().optional(),
    run_if: z.string().nullable().optional(),
    width: z.number().optional(),
  });

  r.post('/api/gtm/tables/:id/columns', 'Add a column', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = columnBody.parse(req.body);
    const kind = (body.config as any)?.kind as string | undefined;
    if (body.type === 'signal' && kind) { const k = SIGNAL_KINDS.find((x) => x.id === kind); if (k) requireConnected(k.label, k.requires, settings); }
    if (body.type === 'action' && kind) requireConnected('This action', actionNeeds(kind), settings);
    if (body.type === 'enrich' && kind) {
      const k = ENRICH_KINDS.find((x) => x.id === kind);
      // A waterfall is usable when at least one of its steps can run.
      if (k && !k.steps.some((st) => !missingConnections(st.requires, settings).length)) requireConnected(k.label, [k.steps.map((st) => st.requires.join('|')).join('|')], settings);
    }
    const autoDefault = body.type === 'formula' || body.type === 'extract';
    const colId = store.createColumn(tableId, { ...body, auto_run: body.auto_run ?? autoDefault });
    bus.publish({ type: 'columns', tableId });
    // Derived columns fill in immediately.
    if (autoDefault) engine.run(tableId, { columnIds: [colId], force: true });
    return { id: colId };
  });

  r.patch('/api/gtm/columns/:id', 'Update a column', async (req) => {
    const a = canWrite(req);
    const colId = columnOf(req, a).id;
    const body = columnBody.partial().omit({ type: true }).extend({ position: z.number().optional() }).parse(req.body);
    store.updateColumn(colId, body);
    const col = store.column(colId);
    bus.publish({ type: 'columns', tableId: col.table_id });
    if ((col.type === 'formula' || col.type === 'extract') && (body.config || body.run_if !== undefined)) engine.run(col.table_id, { columnIds: [colId], force: true });
    return { ok: true };
  });

  r.delete('/api/gtm/columns/:id', 'Delete a column', async (req) => {
    const a = canWrite(req);
    const col = columnOf(req, a);
    store.deleteColumn(col.id);
    bus.publish({ type: 'columns', tableId: col.table_id });
    return { ok: true };
  });

  // ---------- rows ----------
  const rowsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    q: z.string().trim().max(200).optional(),
    columns: z.string().max(2000).optional(),
  });
  r.get('/api/gtm/tables/:id/rows', 'List rows by column name, a page at a time (limit, offset), optionally only rows whose values contain q; columns = comma-separated names to return. → { total, rows: [{ id, values, errors? }] }', async (req) => {
    const tableId = tableOf(req, auth(req));
    const b = rowsQuery.parse(req.query ?? {});
    const cols = store.columns(tableId);
    const want = b.columns ? new Set(b.columns.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) : null;
    const shown = want ? cols.filter((c) => want.has(c.name.toLowerCase())) : cols;
    const text = (v: unknown) => { const u = unwrap(v); return u == null ? '' : typeof u === 'object' ? JSON.stringify(u) : String(u); };
    let rows = store.grid(tableId).map((r) => {
      const cells = r.cells as Record<number, { value: unknown; status: string; error: string | null }>;
      const values: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      for (const c of shown) {
        const cell = cells[c.id];
        values[c.name] = cell ? unwrap(cell.value) ?? null : null;
        if (cell?.status === 'error' && cell.error) errors[c.name] = cell.error;
      }
      return { id: r.id, values, ...(Object.keys(errors).length ? { errors } : {}), _all: cols.map((c) => text(cells[c.id]?.value)).join(' ').toLowerCase() };
    });
    if (b.q) { const q = b.q.toLowerCase(); rows = rows.filter((r) => r._all.includes(q)); }
    return { total: rows.length, offset: b.offset, rows: rows.slice(b.offset, b.offset + b.limit).map(({ _all, ...r }) => r) };
  }, { query: rowsQuery });

  r.post('/api/gtm/tables/:id/rows', 'Add rows', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({ rows: z.array(z.record(z.string(), z.any())).default([{}]), count: z.number().int().min(1).max(1000).optional() }).parse(req.body ?? {});
    const records = body.count ? Array.from({ length: body.count }, () => ({})) : body.rows;
    const ids = store.addRows(tableId, records);
    afterInsert(tableId, ids);
    const masked = maskedValues(records);
    if (!masked.length) return { ids };
    return {
      ids,
      warnings: [`${masked.length} value(s) look masked or cut off, e.g. ${masked.slice(0, 3).map((m) => `${m.column} "${m.value}"`).join(', ')}. ` +
        'Sites often hide the end of a phone or email until clicked. Open each item\'s own page (the full value is usually in its page data) or add a "Find company phone" / "Find company domain" column, then replace them. Never present cut-off values as real.'],
      masked,
    };
  });

  r.delete('/api/gtm/tables/:id/rows', 'Delete rows', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({ ids: z.array(z.number()) }).parse(req.body);
    store.deleteRows(body.ids.filter((rid) => store.rowTable(rid) === tableId));
    bus.publish({ type: 'rows', tableId });
    return { ok: true };
  });

  /** Edit input cells: [{rowId, columnId, value}]. */
  r.patch('/api/gtm/tables/:id/cells', 'Edit input cells', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({ changes: z.array(z.object({ rowId: z.number(), columnId: z.number(), value: z.any() })) }).parse(req.body);
    const cols = new Map(store.columns(tableId).map((c) => [c.id, c]));
    const rowIds = new Set(store.rowIds(tableId));
    const changedByRow = new Map<number, string[]>();
    store.db.tx(() => {
      for (const ch of body.changes) {
        const col = cols.get(ch.columnId);
        if (!col || col.type !== 'text' || !rowIds.has(ch.rowId)) continue;
        const v = ch.value === '' ? null : ch.value;
        if (store.writeCell(ch.rowId, ch.columnId, { value: v, status: v == null ? 'idle' : 'done' })) {
          changedByRow.set(ch.rowId, [...(changedByRow.get(ch.rowId) ?? []), col.name]);
        }
      }
    });
    for (const [rowId, names] of changedByRow) engine.inputsChanged(tableId, rowId, names);
    return { ok: true };
  });

  /**
   * One click "signal pack": adds signal columns fed by the company name/domain columns,
   * schedules them, and adds a Slack alert that fires only when one of them changes.
   */
  r.post('/api/gtm/tables/:id/signal-pack', 'Add signal monitors, a schedule and change alerts', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({
      nameColumn: z.string().min(1),
      domainColumn: z.string().optional(),
      signals: z.array(z.string()).min(1),
      everyMinutes: z.number().int().min(60).default(1440),
      alert: z.enum(['none', 'slack', 'webhook']).default('slack'),
      slackChannel: z.string().optional(),
      webhookUrl: z.string().optional(),
    }).parse(req.body);
    const existing = new Map(store.columns(tableId).map((c) => [c.name, c]));
    const name = `{{${body.nameColumn}}}`;
    const domain = body.domainColumn ? `{{${body.domainColumn}}}` : '';
    const created: { id: number; name: string }[] = [];
    // Check every signal before adding any, so a missing connection doesn't leave half a pack.
    for (const kindId of body.signals) { const k = SIGNAL_KINDS.find((x) => x.id === kindId); if (k) requireConnected(k.label, k.requires, settings); }
    for (const kindId of body.signals) {
      const kind = SIGNAL_KINDS.find((k) => k.id === kindId);
      // Person signals have nobody to follow on a company row.
      if (!kind || PERSON_SIGNALS.has(kind.id)) continue;
      const col = existing.get(kind.label);
      if (col) { created.push({ id: col.id, name: col.name }); continue; }
      const inputs: Record<string, string> = {};
      if (kind.inputs.includes('companyName')) inputs.companyName = name;
      if (kind.inputs.includes('domain') && domain) inputs.domain = domain;
      const colId = store.createColumn(tableId, { name: kind.label, type: 'signal', config: { kind: kind.id, inputs } });
      created.push({ id: colId, name: kind.label });
    }
    if (body.alert !== 'none' && created.length) {
      const text = `:satellite_antenna: *${name}*${domain ? ` (${domain})` : ''}\n{{_changes}}`;
      const config = body.alert === 'slack'
        ? { kind: 'slack', text, channel: body.slackChannel || '' }
        : { kind: 'webhook', url: body.webhookUrl ?? '', method: 'POST', body: JSON.stringify({ company: name, domain, changes: '{{_changes}}' }) };
      const runIf = created.map((c) => `changed(${JSON.stringify(c.name)})`).join(' || ');
      const alertName = 'Signal alert';
      const prev = existing.get(alertName);
      if (prev) store.updateColumn(prev.id, { config, run_if: runIf, auto_run: true });
      else store.createColumn(tableId, { name: alertName, type: 'action', config, auto_run: true, run_if: runIf });
    }
    const schedule = store.table(tableId).schedule ?? {};
    const columnIds = [...new Set([...(schedule.columnIds ?? []), ...created.map((c) => c.id)])];
    store.updateTable(tableId, { schedule: { ...schedule, enabled: true, everyMinutes: body.everyMinutes, columnIds, lastRunAt: new Date().toISOString() } });
    bus.publish({ type: 'columns', tableId });
    // Baseline run now; alerts only fire on later changes.
    const queued = engine.run(tableId, { columnIds: created.map((c) => c.id) });
    return { columns: created.length, queued };
  });

  // ---------- running ----------
  const runBody = z.object({ columnIds: z.array(z.number()).optional(), rowIds: z.array(z.number()).optional(), force: z.boolean().optional() });
  r.post('/api/gtm/tables/:id/run', 'Run cells', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = runBody.parse(req.body ?? {});
    const own = new Set(store.rowIds(tableId));
    return { queued: engine.run(tableId, { ...body, rowIds: body.rowIds?.filter((rid) => own.has(rid)) }) };
  }, { body: runBody });

  r.post('/api/gtm/tables/:id/run/estimate', 'Estimate a run before starting it (same body as run): cells, AI tasks, worst-case paid credits per vendor vs. the monthly budget', async (req) => {
    const tableId = tableOf(req, auth(req));
    return estimateRun(store, settings, tableId, runBody.parse(req.body ?? {}));
  }, { body: runBody });

  r.post('/api/gtm/tables/:id/stop', 'Cancel queued cells', async (req) => ({ cancelled: engine.cancel(tableOf(req, canWrite(req))) }));

  r.get('/api/gtm/cells/:rowId/:columnId', 'Get one cell with provider details', async (req) => {
    const a = auth(req);
    const p = req.params as any;
    const rowId = id.parse(p.rowId);
    store.tableIn(store.rowTable(rowId), a.workspaceId);
    const cell = store.cell(rowId, id.parse(p.columnId));
    return cell ?? { status: 'idle', value: null };
  });

  // ---------- live updates ----------
  app.get('/api/gtm/tables/:id/events', (req, reply) => {
    const a = auth(req);
    const tableId = tableOf(req, a);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const listener = (e: unknown) => send(e);
    bus.on(`table:${tableId}`, listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { clearInterval(ping); bus.off(`table:${tableId}`, listener); });
  });

  // ---------- import / export ----------
  r.post('/api/gtm/tables/:id/import/csv', 'Import rows from CSV text', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({ csv: z.string().min(1), exclude: z.boolean().optional() }).parse(req.body);
    let records: Record<string, string>[] = parseCsv(body.csv, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, bom: true, relax_column_count: true, trim: true });
    const excl = body.exclude ? filterExcluded(store.db, a.workspaceId, records) : { kept: records, excluded: 0 };
    records = excl.kept;
    const ids = store.addRows(tableId, records);
    afterInsert(tableId, ids);
    return { imported: ids.length, excluded: excl.excluded };
  });

  const exportCsv = (tableId: number, ids?: number[]) => {
    const cols = store.columns(tableId);
    let rows = store.grid(tableId);
    if (ids) {
      // Keep the order the user sees (filters and sorting applied in the grid).
      const byId = new Map(rows.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r);
    }
    const records = rows.map((r) => cols.map((c) => {
      const cell: any = r.cells[c.id];
      return csvSafe(cell ? stringify(unwrap(cell.value)) : '');
    }));
    return toCsv([cols.map((c) => c.name), ...records]);
  };
  const csvName = (tableId: number) => `${store.table(tableId).name.replace(/[^\w.-]+/g, '_')}.csv`;

  r.get('/api/gtm/tables/:id/export.csv', 'Export a table as CSV', async (req, reply) => {
    const a = auth(req);
    const tableId = tableOf(req, a);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${csvName(tableId)}"`);
    return exportCsv(tableId);
  });

  r.post('/api/gtm/tables/:id/export.csv', 'Export chosen rows as CSV, in the order given (e.g. the rows left after filters, or the selected rows)', async (req, reply) => {
    const a = auth(req);
    const tableId = tableOf(req, a);
    const body = z.object({ ids: z.array(z.number().int()).max(100_000) }).parse(req.body ?? {});
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${csvName(tableId)}"`);
    return exportCsv(tableId, body.ids);
  });

  /** Pull prospects from a source into the table. */
  r.post('/api/gtm/tables/:id/import/source', 'Import rows from YC, GitHub, job boards, Hacker News, HubSpot, Apollo, Google Maps or lookalikes (exclusions applied)', async (req) => {
    const a = canWrite(req);
    const tableId = tableOf(req, a);
    const body = z.object({
      source: z.enum(['hubspot_contacts', 'hubspot_companies', 'apollo_people', 'apollo_companies', 'yc_companies', 'github_people', 'jobs', 'hacker_news', 'google_maps', 'company_lookalikes', 'people_lookalikes']),
      exclude: z.boolean().default(true),
      params: z.record(z.string(), z.any()).default({}),
      limit: z.number().int().min(1).max(2000).default(100),
    }).parse(req.body);
    let records: Record<string, unknown>[];
    switch (body.source) {
      case 'hubspot_contacts': records = await integ.hubspotImport(settings, 'contacts', ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'website', 'phone', 'lifecyclestage'], body.limit); break;
      case 'hubspot_companies': records = await integ.hubspotImport(settings, 'companies', ['name', 'domain', 'industry', 'numberofemployees', 'city', 'country'], body.limit); break;
      case 'apollo_people': records = await integ.apolloPeopleSearch(settings, { ...body.params, limit: body.limit }); break;
      case 'apollo_companies': records = await integ.apolloCompanySearch(settings, { ...body.params, limit: body.limit }); break;
      case 'yc_companies': records = await ycSearch({ ...body.params, limit: body.limit }); break;
      case 'jobs': records = await jobsSearch(settings, { domains: body.params.domains, keywords: body.params.keywords, limit: body.limit }); break;
      case 'github_people': records = await githubPeople(settings.get('GITHUB_TOKEN'), { ...body.params, limit: body.limit }); break;
      default: records = (await runSource(ctx, a.workspaceId, body.source, body.params, body.limit)).records;
    }
    const excl = body.exclude ? filterExcluded(store.db, a.workspaceId, records) : { kept: records, excluded: 0 };
    records = excl.kept;
    const ids = store.addRows(tableId, records);
    afterInsert(tableId, ids);
    return { imported: ids.length, excluded: excl.excluded };
  });

  // ---------- settings ----------
  r.get('/api/gtm/keys', 'Data, AI and integration keys (masked)', async () => settings.describe());

  r.put('/api/gtm/keys', 'Save data, AI and integration keys', async (req) => {
    requireAdmin(req);
    const body = z.record(z.string(), z.string().nullable()).parse(req.body);
    for (const [k, v] of Object.entries(body)) {
      if (!(SETTING_KEYS as readonly string[]).includes(k)) continue;
      settings.set(k as SettingKey, v?.trim() || null);
    }
    return settings.describe();
  });

  r.post('/api/gtm/keys/test/:what', 'Test a connection (openrouter, search, smtp, slack, hubspot)', async (req) => {
    const what = (req.params as any).what as string;
    try {
      if (what === 'search') { const r = await webSearch('kineticsand test', { settings, log: () => {} }, 3); return { ok: true, detail: `${r.engine}: ${r.results.length} results` }; }
      if (what === 'openrouter') {
        const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${settings.get('OPENROUTER_API_KEY')}` } });
        const d: any = await res.json();
        return res.ok ? { ok: true, detail: `usage $${d.data?.usage ?? '?'}${d.data?.limit ? ` / limit $${d.data.limit}` : ''}` } : { ok: false, detail: JSON.stringify(d).slice(0, 200) };
      }
      if (what === 'smtp') {
        const { smtpVerify } = await import('./lib/smtp.ts');
        const r = await smtpVerify(`kineticsand-port-check-${Date.now()}@gmail.com`, { helo: settings.get('SMTP_HELO'), timeoutMs: 10_000 });
        return r.verdict === 'invalid' ? { ok: true, detail: 'port 25 open — free SMTP verification works' } : { ok: false, detail: `port 25 check inconclusive (${r.reply ?? r.verdict}); your network may block outbound SMTP` };
      }
      if (what === 'cloudflare') {
        const { Cloudflare } = await import('../domains/cloudflare.ts');
        const cf = new Cloudflare(settings.get('CLOUDFLARE_API_TOKEN') ?? '', ctx.fetch);
        const t = await cf.verifyToken();
        const zones = await cf.zones();
        return { ok: t.status === 'active', detail: `token ${t.status} · ${zones.length} domain${zones.length === 1 ? '' : 's'} visible` };
      }
      if (what === 'slack') { await integ.slackPost(settings, { text: ':wave: Kinetic test message' }); return { ok: true, detail: 'sent' }; }
      if (what === 'hubspot') { const r = await integ.hubspotImport(settings, 'contacts', ['email'], 1); return { ok: true, detail: `reachable (${r.length} sample)` }; }
      return { ok: false, detail: 'unknown test' };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  });

  /** Signals feed: values that changed from a previous value, newest first. */
  r.get('/api/gtm/signals', 'Signals feed: table changes and outreach events', async (req) => {
    const a = auth(req);
    const q = z.object({ limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    const rows = store.db.all(`SELECT c.row_id, c.column_id, c.value, c.prev_value, c.changed_at, col.name AS column_name, col.type, t.id AS table_id, t.name AS table_name
      FROM gtm_cells c JOIN gtm_columns col ON col.id = c.column_id JOIN gtm_tables t ON t.id = col.table_id
      WHERE t.workspace_id = ? AND c.prev_value IS NOT NULL AND c.changed_at IS NOT NULL AND col.type IN ('signal', 'enrich', 'ai', 'http')
      ORDER BY c.changed_at DESC LIMIT ?`, [a.workspaceId, q.limit]);
    // Label each row by its first non-empty text cell (usually the company, person or email).
    const tableItems = rows.map((r) => {
      const label = store.db.get<{ value: string }>(`SELECT c.value FROM gtm_cells c JOIN gtm_columns col ON col.id = c.column_id
        WHERE c.row_id = ? AND col.type = 'text' AND c.value IS NOT NULL AND c.value != '""' ORDER BY col.position LIMIT 1`, [r.row_id])?.value;
      return { source: 'table', tableId: r.table_id, table: r.table_name, rowId: r.row_id, row: label ? JSON.parse(label) : `Row ${r.row_id}`, column: r.column_name, type: r.type, from: unwrap(JSON.parse(r.prev_value)), to: unwrap(JSON.parse(r.value)), at: r.changed_at };
    });
    // Outreach moments that matter: replies, interest, bounces, unsubscribes, first contact.
    const OUTREACH = { LEAD_REPLIED: 'Replied', LEAD_INTERESTED: 'Interested', EMAIL_BOUNCED: 'Bounced', LEAD_UNSUBSCRIBED: 'Unsubscribed', LEAD_FIRST_CONTACTED: 'First contacted' } as Record<string, string>;
    const events = store.db.all(`SELECT e.type, e.data, e.created_at, e.lead_id, e.campaign_id, e.reply_id, l.email, l.first_name, l.last_name, l.company, c.name AS campaign
      FROM events e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN campaigns c ON c.id = e.campaign_id
      WHERE e.workspace_id = ? AND e.type IN (${Object.keys(OUTREACH).map(() => '?').join(',')}) ORDER BY e.created_at DESC LIMIT ?`, [a.workspaceId, ...Object.keys(OUTREACH), q.limit]);
    const outreach = events.map((e) => {
      const d = JSON.parse(e.data || '{}');
      const who = [e.first_name, e.last_name].filter(Boolean).join(' ') || e.email || d.from_email || d.lead_email || 'Unknown';
      return { source: 'outreach', type: 'outreach', event: e.type, label: OUTREACH[e.type], row: e.company ? `${who} · ${e.company}` : who, column: OUTREACH[e.type], table: e.campaign ?? 'Outreach', campaignId: e.campaign_id, leadId: e.lead_id, replyId: e.reply_id, from: null, to: d.subject ?? d.diagnostic ?? e.campaign ?? '', at: e.created_at };
    });
    return [...tableItems, ...outreach].sort((x: any, y: any) => String(y.at).localeCompare(String(x.at))).slice(0, q.limit);
  });

  /** Integration logos: fetched once from Google's favicon service, then served from disk. */
  // Provider logos plus the other brands shown on the Integrations page.
  const EXTRA_ICONS = ['google.com', 'microsoft.com', 'gmail.com', 'outlook.com', 'yahoo.com', 'n8n.io', 'make.com', 'zapier.com', 'ycombinator.com', 'wikidata.org', 'news.google.com', 'cloudflare.com'];
  const iconDomains = new Set([...SETTINGS_META.map((m) => m.domain).filter(Boolean) as string[], ...EXTRA_ICONS]);
  r.get('/api/gtm/icon/:domain', 'Integration logo', async (req, reply) => {
    const domain = String((req.params as any).domain).toLowerCase();
    if (!iconDomains.has(domain)) return reply.code(404).send({ error: 'unknown integration' });
    const dir = join(config.dataDir, 'icons');
    const file = join(dir, `${domain}.png`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!res?.ok) return reply.code(404).send({ error: 'icon unavailable' });
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=604800');
    return reply.send(readFileSync(file));
  });

  r.get('/api/gtm/activity', 'Activity log', async (req) => {
    const a = auth(req);
    const q = z.object({ tableId: id.optional(), limit: z.coerce.number().max(1000).default(200) }).parse(req.query);
    if (q.tableId) store.tableIn(q.tableId, a.workspaceId);
    return store.logs(q.limit, q.tableId, a.workspaceId);
  });

  function afterInsert(tableId: number, rowIds: number[]) {
    bus.publish({ type: 'rows', tableId });
    bus.publish({ type: 'columns', tableId });
    // New rows flow through every auto-run column (formulas, auto enrichments…).
    const auto = store.columns(tableId).filter((c) => c.auto_run && RUNNABLE.includes(c.type as ColumnType)).map((c) => c.id);
    if (auto.length && rowIds.length) engine.run(tableId, { columnIds: auto, rowIds });
  }
}

export function gtmHookRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, engine, bus } = ctx.gtm!;
  /** Inbound webhook: POST a JSON object or array of objects; keys become columns. */
  app.post('/hooks/:token', async (req, reply) => {
    const table = store.tableByToken((req.params as any).token);
    if (!table) return reply.code(404).send({ error: 'unknown webhook' });
    const body = req.body as unknown;
    const list = (Array.isArray(body) ? body : [body]).filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    const flat = list.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v != null && typeof v === 'object' ? JSON.stringify(v) : v])));
    const ids = store.addRows(table.id, flat);
    bus.publish({ type: 'rows', tableId: table.id });
    bus.publish({ type: 'columns', tableId: table.id });
    const auto = store.columns(table.id).filter((c) => c.auto_run && RUNNABLE.includes(c.type)).map((c) => c.id);
    if (auto.length) engine.run(table.id, { columnIds: auto, rowIds: ids });
    store.log('info', 'webhook', `Received ${ids.length} row(s)`, { tableId: table.id });
    return { received: ids.length };
  });
}
