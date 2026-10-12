/** Routes for table lookups, send-to-table and Functions (reusable enrichment recipes). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, canWrite, defineRoutes } from '../http.ts';
import { unwrap } from './lib/template.ts';
import { MATCH_MODES } from './engine/match.ts';
import { STEP_TYPES } from './engine/functions.ts';

const id = z.coerce.number().int().positive();

const definition = z.object({
  inputs: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), required: z.boolean().optional() })).default([]),
  steps: z.array(z.object({ name: z.string().min(1), type: z.enum(STEP_TYPES), config: z.record(z.string(), z.any()).default({}), run_if: z.string().nullable().optional() })).min(1),
  outputs: z.array(z.object({ name: z.string().min(1), value: z.string(), description: z.string().optional() })).min(1),
});

const sendBody = z.object({
  targetTableId: z.number().int().positive(),
  rowIds: z.array(z.number().int()).optional(),
  fields: z.array(z.object({ name: z.string().min(1), value: z.string() })).min(1),
  dedupeKey: z.string().optional(),
  dedupeMode: z.enum(MATCH_MODES).optional(),
  onMatch: z.enum(['update', 'skip']).optional(),
  explode: z.string().optional(),
  backRef: z.string().optional(),
});

const lookupBody = z.object({
  column: z.string().min(1),
  value: z.any(),
  mode: z.enum(MATCH_MODES).default('exact'),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).default(20),
});

const fnBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  definition,
});

const fromColumnsBody = z.object({
  tableId: z.number().int().positive(),
  columnIds: z.array(z.number().int()).min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Also add a function column to the source table, wired to the same inputs. */
  addColumn: z.boolean().default(false),
});

const testBody = z.object({
  inputs: z.array(z.record(z.string(), z.any())).max(25).optional(),
  tableId: z.number().int().positive().optional(),
  rowIds: z.array(z.number().int()).optional(),
  limit: z.number().int().min(1).max(25).default(5),
  /** Input name → template over the table's columns (for tableId samples). */
  mapping: z.record(z.string(), z.string()).optional(),
});

export function gtmLinkRoutes(app: FastifyInstance, ctx: Ctx) {
  const { store, engine, bus } = ctx.gtm!;
  const { links, functions } = engine;

  // ---------- lookups & send to table ----------
  const r = defineRoutes(app, 'Lookups & Send to table');

  r.get('/api/gtm/tables/:id/columns', "List a table's columns (names and types), e.g. to pick lookup or send-to-table fields", async (req) => {
    const a = auth(req);
    const t = store.tableIn(id.parse((req.params as any).id), a.workspaceId);
    return store.columns(t.id).map((c) => ({ id: c.id, name: c.name, type: c.type }));
  });

  r.post('/api/gtm/tables/:id/lookup', 'Find rows in a table whose column matches a value (exact, case-insensitive, domain, email or company name)', async (req) => {
    const a = auth(req);
    const t = store.tableIn(id.parse((req.params as any).id), a.workspaceId);
    const b = lookupBody.parse(req.body);
    const ids = links.match(t.id, b.column, b.value, b.mode);
    const cols = store.columns(t.id).filter((c) => !b.fields?.length || b.fields.includes(c.name));
    const rows = ids.slice(0, b.limit).map((rowId) => {
      const vals = store.rowValues(rowId, cols);
      return { rowId, ...Object.fromEntries(cols.map((c) => [c.name, unwrap(vals[c.name]) ?? null])) };
    });
    return { count: ids.length, rows };
  }, { body: lookupBody });

  r.post('/api/gtm/tables/:id/send-to-table', 'Send rows (all or selected) into another table: map fields, upsert by a dedupe key, optionally explode a list into one row per item', async (req) => {
    const a = canWrite(req);
    const source = store.tableIn(id.parse((req.params as any).id), a.workspaceId);
    const b = sendBody.parse(req.body);
    store.tableIn(b.targetTableId, a.workspaceId);
    const own = store.rowIds(source.id);
    const rowIds = b.rowIds?.length ? b.rowIds.filter((rid) => own.includes(rid)) : own;
    const cols = store.columns(source.id);
    const totals = { rows: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] as { rowId: number; error: string }[] };
    const targetRowIds = new Set<number>();
    for (const rowId of rowIds.slice(0, 5000)) {
      try {
        const out = await links.send({ tableId: b.targetTableId, fields: b.fields, dedupeKey: b.dedupeKey, dedupeMode: b.dedupeMode, onMatch: b.onMatch, explode: b.explode, backRef: b.backRef },
          store.rowValues(rowId, cols), { tableId: source.id, rowId, columnId: 0 }, a.workspaceId);
        totals.rows++;
        const d: any = (out.value as any)?.data;
        if (!d) { totals.skipped++; continue; }
        totals.created += d.created.length;
        totals.updated += d.updated.length;
        totals.unchanged += d.skipped.length;
        for (const x of d.rowIds) targetRowIds.add(x);
      } catch (e: any) {
        totals.errors.push({ rowId, error: e.message });
      }
    }
    return { ...totals, targetRowIds: [...targetRowIds] };
  }, { body: sendBody });

  // ---------- functions ----------
  const f = defineRoutes(app, 'Functions');
  const fnOf = (req: any, ws: number) => functions.get(id.parse(req.params.id), ws);
  const summary = (fn: ReturnType<typeof functions.get>, ws: number) => {
    const usage = functions.usage(fn.id, ws);
    return { ...fn, usage: { columns: usage.length, tables: new Set(usage.map((u) => u.table_id)).size, outdated: usage.filter((u) => u.version !== fn.version).length } };
  };

  f.get('/api/gtm/functions', 'List functions (reusable enrichment recipes) with version, tags and where they are used', async (req) => {
    const a = auth(req);
    const q = z.object({ tag: z.string().optional() }).parse(req.query);
    return functions.list(a.workspaceId).filter((fn) => !q.tag || fn.tags.includes(q.tag.toLowerCase())).map((fn) => summary(fn, a.workspaceId));
  });

  f.post('/api/gtm/functions', 'Create a function: named inputs, ordered steps (formula, extract, enrich, ai, http, lookup) and named outputs', async (req) => {
    const a = canWrite(req);
    const b = fnBody.parse(req.body);
    return { id: functions.create(a.workspaceId, b) };
  }, { body: fnBody });

  f.post('/api/gtm/functions/from-columns', 'Create a function from selected columns of a table (columns they read become inputs)', async (req) => {
    const a = canWrite(req);
    const b = fromColumnsBody.parse(req.body);
    const t = store.tableIn(b.tableId, a.workspaceId);
    const { definition: def, mapping } = functions.fromColumns(t.id, b.columnIds);
    const fnId = functions.create(a.workspaceId, { name: b.name, description: b.description, tags: b.tags, definition: def });
    let columnId: number | undefined;
    if (b.addColumn) {
      columnId = store.createColumn(t.id, { name: b.name, type: 'function', config: { functionId: fnId, version: 1, inputs: mapping } });
      bus.publish({ type: 'columns', tableId: t.id });
    }
    return { id: fnId, definition: def, mapping, columnId };
  }, { body: fromColumnsBody });

  f.post('/api/gtm/functions/test', 'Test an unsaved function definition on sample inputs or table rows (writes nothing)', async (req) => {
    const a = auth(req);
    const b = testBody.extend({ definition }).parse(req.body);
    return functions.test(a.workspaceId, b.definition, b);
  });

  f.get('/api/gtm/functions/:id', 'Get a function with its definition, versions, usage and stats', async (req) => {
    const a = auth(req);
    const fn = fnOf(req, a.workspaceId);
    return { ...summary(fn, a.workspaceId), versions: functions.versions(fn.id), columns: functions.usage(fn.id, a.workspaceId), stats: functions.stats(fn.id, a.workspaceId) };
  });

  f.get('/api/gtm/functions/:id/versions/:version', "Get one version of a function's definition", async (req) => {
    const a = auth(req);
    const fn = fnOf(req, a.workspaceId);
    const v = id.parse((req.params as any).version);
    return { version: v, definition: functions.definition(fn, v) };
  });

  f.patch('/api/gtm/functions/:id', 'Update a function (a changed definition creates a new version; columns keep theirs until upgraded)', async (req) => {
    const a = canWrite(req);
    const fn = fnOf(req, a.workspaceId);
    const b = fnBody.partial().parse(req.body);
    return functions.update(fn.id, a.workspaceId, b);
  }, { body: fnBody.partial() });

  f.delete('/api/gtm/functions/:id', 'Delete a function (columns using it stop running)', async (req) => {
    const a = canWrite(req);
    functions.remove(fnOf(req, a.workspaceId).id, a.workspaceId);
    return { ok: true };
  });

  f.post('/api/gtm/functions/:id/test', 'Test a saved function on sample inputs or N table rows (writes nothing)', async (req) => {
    const a = auth(req);
    const fn = fnOf(req, a.workspaceId);
    const b = testBody.extend({ version: z.number().int().optional() }).parse(req.body ?? {});
    return functions.test(a.workspaceId, functions.definition(fn, b.version), b);
  }, { body: testBody });

  f.get('/api/gtm/functions/:id/stats', 'Function run stats: rows processed, fill rate per output, average run time, error rate, tables using it', async (req) => {
    const a = auth(req);
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return functions.stats(fnOf(req, a.workspaceId).id, a.workspaceId, q.days);
  });

  f.post('/api/gtm/functions/:id/upgrade-columns', 'Move function columns (all, or the given column ids) to the latest version', async (req) => {
    const a = canWrite(req);
    const fn = fnOf(req, a.workspaceId);
    const b = z.object({ columnIds: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    const moved = functions.upgradeColumns(fn.id, a.workspaceId, b.columnIds);
    for (const t of new Set(moved.map((c) => store.column(c).table_id))) bus.publish({ type: 'columns', tableId: t });
    return { upgraded: moved.length, version: fn.version };
  });
}
