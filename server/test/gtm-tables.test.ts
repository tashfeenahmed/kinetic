import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Settings } from '../src/gtm/settings.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { matchKey, toList } from '../src/gtm/engine/match.ts';
import { ENRICH_KINDS } from '../src/gtm/providers/catalog.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';
import { makeEnv, type TestEnv } from './helpers.ts';

gtmTestSetup();

let store: Store, engine: Engine, ws: number;
beforeEach(() => {
  const db = new Db(':memory:');
  store = new Store(db);
  engine = new Engine(store, new Settings(db), new Bus());
  engine.links.debounceMs = 20;
  ws = workspace(db);
});
afterEach(() => engine.stop());

const settle = async () => {
  for (let i = 0; i < 300; i++) {
    const busy = (engine as any).queue.length + (engine as any).running.size + (engine.links as any).pending.size;
    if (!busy) { await new Promise((r) => setTimeout(r, 30)); if (!((engine as any).queue.length + (engine as any).running.size + (engine.links as any).pending.size)) return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('engine did not settle');
};
const col = (t: number, name: string) => store.columns(t).find((c) => c.name === name)!;
const cell = (t: number, rowId: number, name: string) => store.cell(rowId, col(t, name).id);
const textCols = (t: number, ...names: string[]) => names.forEach((name) => store.createColumn(t, { name, type: 'text' }));

describe('match keys', () => {
  it('normalises per mode', () => {
    expect(matchKey(' Acme ', 'exact')).toBe('Acme');
    expect(matchKey('Acme', 'exact')).not.toBe(matchKey('acme', 'exact'));
    expect(matchKey('ACME  Corp', 'case_insensitive')).toBe('acme corp');
    expect(matchKey('https://www.Acme.io/pricing', 'domain')).toBe('acme.io');
    expect(matchKey('jane@acme.io', 'domain')).toBe('acme.io');
    expect(matchKey('Mailto:Jane+news@Acme.io', 'email')).toBe('jane@acme.io');
    expect(matchKey('Acme, Inc.', 'company')).toBe(matchKey('ACME', 'company'));
    expect(matchKey('Acme GmbH', 'company')).toBe('acme');
    expect(matchKey('acme.io', 'company')).toBe('acme');
    expect(matchKey({ value: 'X' }, 'exact')).toBe('X');
  });
  it('turns cells into lists', () => {
    expect(toList('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(toList({ value: 'x', data: { people: [1, 2] } })).toEqual([1, 2]);
    expect(toList('a\nb')).toEqual(['a', 'b']);
  });
});

describe('lookup column', () => {
  let companies: number, people: number;
  beforeEach(() => {
    companies = store.createTable(ws, 'Companies');
    textCols(companies, 'Name', 'Website', 'Industry');
    store.addRows(companies, [
      { Name: 'Acme, Inc.', Website: 'https://www.acme.io', Industry: 'Rockets' },
      { Name: 'Globex', Website: 'globex.com', Industry: 'Chemicals' },
      { Name: 'Acme Labs', Website: 'acme.io/labs', Industry: 'Research' },
    ]);
    people = store.createTable(ws, 'People');
    textCols(people, 'Email', 'Company');
  });

  it('matches by domain and returns first, all and count', async () => {
    store.createColumn(people, { name: 'Co', type: 'lookup', config: { tableId: companies, matchColumn: 'Website', value: '{{Email}}', mode: 'domain', return: 'first', fields: ['Industry', 'Name'] } });
    store.createColumn(people, { name: 'All', type: 'lookup', config: { tableId: companies, matchColumn: 'Website', value: '{{Email}}', mode: 'domain', return: 'all', fields: ['Name'] } });
    store.createColumn(people, { name: 'N', type: 'lookup', config: { tableId: companies, matchColumn: 'Website', value: '{{Email}}', mode: 'domain', return: 'count' } });
    store.createColumn(people, { name: 'Industry', type: 'extract', config: { source: 'Co', path: 'Industry' } });
    const [jane, bob] = store.addRows(people, [{ Email: 'jane@acme.io' }, { Email: 'bob@nowhere.dev' }]);
    engine.run(people, { force: true });
    await settle();
    expect(cell(people, jane, 'Co')?.value).toMatchObject({ value: 'Rockets', data: { Name: 'Acme, Inc.', Industry: 'Rockets', count: 2 } });
    expect((cell(people, jane, 'All')?.value as any).value).toEqual(['Acme, Inc.', 'Acme Labs']);
    expect((cell(people, jane, 'N')?.value as any).value).toBe(2);
    expect(cell(people, jane, 'Industry')?.value).toBe('Rockets');
    expect(cell(people, bob, 'Co')?.status).toBe('empty');
    expect((cell(people, bob, 'N')?.value as any).value).toBe(0);
  });

  it('matches company names and case-insensitive text', async () => {
    store.createColumn(people, { name: 'ByName', type: 'lookup', config: { tableId: companies, matchColumn: 'Name', value: '{{Company}}', mode: 'company', fields: ['Industry'] } });
    store.createColumn(people, { name: 'Exact', type: 'lookup', config: { tableId: companies, matchColumn: 'Name', value: '{{Company}}', mode: 'exact', fields: ['Industry'] } });
    store.createColumn(people, { name: 'CI', type: 'lookup', config: { tableId: companies, matchColumn: 'Name', value: '{{Company}}', mode: 'case_insensitive', fields: ['Industry'] } });
    const [r1, r2] = store.addRows(people, [{ Company: 'ACME' }, { Company: 'globex' }]);
    engine.run(people, { force: true });
    await settle();
    expect((cell(people, r1, 'ByName')?.value as any).value).toBe('Rockets');
    expect(cell(people, r1, 'Exact')?.status).toBe('empty');
    expect((cell(people, r2, 'CI')?.value as any).value).toBe('Chemicals');
    expect((cell(people, r2, 'Exact'))?.status).toBe('empty');
  });

  it('re-runs when the target table changes', async () => {
    store.createColumn(people, { name: 'Co', type: 'lookup', auto_run: true, config: { tableId: companies, matchColumn: 'Website', value: '{{Email}}', mode: 'domain', fields: ['Industry'] } });
    const [r] = store.addRows(people, [{ Email: 'x@initech.com' }]);
    engine.run(people, { force: true });
    await settle();
    expect(cell(people, r, 'Co')?.status).toBe('empty');

    // A new row in the target table: the lookup goes stale and re-runs.
    store.addRows(companies, [{ Name: 'Initech', Website: 'initech.com', Industry: 'Software' }]);
    engine['bus'].publish({ type: 'rows', tableId: companies });
    expect(cell(people, r, 'Co')?.status).toBe('stale');
    await settle();
    expect((cell(people, r, 'Co')?.value as any).value).toBe('Software');

    // Editing a returned field re-runs too; editing an unrelated column does not.
    const init = store.rowIds(companies).at(-1)!;
    store.writeCell(init, col(companies, 'Industry').id, { value: 'Paper', status: 'done' });
    engine.inputsChanged(companies, init, ['Industry']);
    await settle();
    expect((cell(people, r, 'Co')?.value as any).value).toBe('Paper');
    const before = cell(people, r, 'Co')!.updated_at;
    engine.inputsChanged(companies, init, ['Name']);
    await settle();
    expect(cell(people, r, 'Co')!.updated_at).toBe(before);
  });

  it('does not loop when two tables look each other up', async () => {
    store.createColumn(people, { name: 'Count', type: 'lookup', auto_run: true, config: { tableId: companies, matchColumn: 'Website', value: '{{Email}}', mode: 'domain', return: 'count' } });
    store.createColumn(companies, { name: 'People', type: 'lookup', auto_run: true, config: { tableId: people, matchColumn: 'Email', value: '{{Website}}', mode: 'domain' } });
    store.addRows(people, [{ Email: 'a@acme.io' }]);
    engine.run(people, { force: true });
    engine.run(companies, { force: true });
    await settle();
    let runs = 0;
    const orig = engine.run.bind(engine);
    engine.run = (...args: Parameters<Engine['run']>) => { runs++; return orig(...args); };
    store.addRows(people, [{ Email: 'b@acme.io' }]);
    engine['bus'].publish({ type: 'rows', tableId: people });
    await settle();
    expect(runs).toBeLessThan(4);
    expect(engine.stats(people)).toEqual({ pending: 0, running: 0 });
  });
});

describe('send to table', () => {
  it('explodes a list into one row per item, deduped, with a back-reference', async () => {
    const companies = store.createTable(ws, 'Companies');
    textCols(companies, 'Company', 'People');
    const people = store.createTable(ws, 'People');
    textCols(people, 'Email');
    store.createColumn(people, { name: 'Domain', type: 'formula', auto_run: true, config: { expression: 'domain(row.Email)' } });
    const team = [{ name: 'Jane', email: 'jane@acme.io' }, { name: 'Bob', email: 'BOB@acme.io' }, { name: 'Bob again', email: 'bob@acme.io' }];
    const [acme] = store.addRows(companies, [{ Company: 'Acme', People: JSON.stringify(team) }]);
    const send = store.createColumn(companies, {
      name: 'To people', type: 'action',
      config: { kind: 'send_to_table', tableId: people, explode: '{{People}}', fields: [{ name: 'Name', value: '{{item.name}}' }, { name: 'Email', value: '{{item.email}}' }, { name: 'Company', value: '{{Company}}' }], dedupeKey: 'Email', dedupeMode: 'email', backRef: 'Company row' },
    });
    engine.run(companies, { columnIds: [send], force: true });
    await settle();
    const out = store.cell(acme, send)!;
    expect(out.status).toBe('done');
    expect((out.value as any).data.created).toHaveLength(2);
    expect((out.value as any).data.rowIds).toHaveLength(3);
    expect(store.rowIds(people)).toHaveLength(2);
    const [jane, bob] = store.rowIds(people);
    expect(cell(people, bob, 'Name')?.value).toBe('Bob again'); // the duplicate updated the first
    expect(cell(people, jane, 'Company row')?.value).toMatchObject({ value: 'Acme', tableId: companies, rowId: acme });
    expect(cell(people, jane, 'Domain')?.value).toBe('acme.io'); // auto-run columns ran on new rows

    // Running again creates nothing new.
    engine.run(companies, { columnIds: [send], force: true });
    await settle();
    expect(store.rowIds(people)).toHaveLength(2);
    expect((store.cell(acme, send)!.value as any).data.created).toHaveLength(0);
  });

  it('refuses to send a row back to the table it came from', async () => {
    const a = store.createTable(ws, 'A');
    const b = store.createTable(ws, 'B');
    textCols(a, 'Key');
    textCols(b, 'Key');
    store.createColumn(a, { name: 'To B', type: 'action', config: { kind: 'send_to_table', tableId: b, fields: [{ name: 'Key', value: '{{Key}}' }] } });
    const back = store.createColumn(b, { name: 'To A', type: 'action', auto_run: true, config: { kind: 'send_to_table', tableId: a, fields: [{ name: 'Key', value: '{{Key}}' }] } });
    store.addRows(a, [{ Key: 'k1' }]);
    engine.run(a, { columnIds: [col(a, 'To B').id], force: true });
    await settle();
    const [bRow] = store.rowIds(b);
    expect(store.cell(bRow, back)?.status).toBe('skipped');
    expect(store.cell(bRow, back)?.error).toMatch(/Loop prevented/);
    expect(store.rowIds(a)).toHaveLength(1);
  });
});

describe('functions', () => {
  it('creates a function from selected columns', () => {
    const t = store.createTable(ws, 't');
    textCols(t, 'Website', 'Full name');
    store.createColumn(t, { name: 'Domain', type: 'formula', config: { expression: 'domain(row.Website)' } });
    store.createColumn(t, { name: 'Greeting', type: 'formula', config: { expression: '`${first(row["Full name"])} @ ${row.Domain}`' }, run_if: 'row["Full name"]' });
    store.createColumn(t, { name: 'Unrelated', type: 'formula', config: { expression: '1' } });
    const { definition, mapping } = engine.functions.fromColumns(t, [col(t, 'Greeting').id, col(t, 'Domain').id]);
    expect(definition.inputs.map((i) => i.name)).toEqual(['website', 'full_name']);
    expect(definition.steps.map((s) => s.name)).toEqual(['Domain', 'Greeting']);
    expect(definition.steps[0].config.expression).toBe('domain(row["website"])');
    expect(definition.steps[1].config.expression).toContain('row["full_name"]');
    expect(definition.steps[1].run_if).toBe('row["full_name"]');
    expect(definition.outputs).toEqual([{ name: 'greeting', value: '{{Greeting}}' }]);
    expect(mapping).toEqual({ website: '{{Website}}', full_name: '{{Full name}}' });
  });

  describe('function column', () => {
    const kind = ENRICH_KINDS.find((k) => k.id === 'company_domain')!;
    const saved = kind.steps;
    const calls: string[] = [];
    beforeEach(() => {
      calls.length = 0;
      kind.steps = [{ id: 'mock', label: 'Mock', requires: [], cost: '', run: async (i) => { calls.push(String(i.companyName)); return i.companyName === 'none' ? null : { value: `${String(i.companyName).toLowerCase()}.com`, data: { source: 'mock' } }; } }];
    });
    afterEach(() => { kind.steps = saved; });

    const def = {
      inputs: [{ name: 'company', required: true }],
      steps: [
        { name: 'Domain', type: 'enrich' as const, config: { kind: 'company_domain', inputs: { companyName: '{{company}}' } } },
        { name: 'Shout', type: 'formula' as const, config: { expression: 'row.Domain.toUpperCase()' }, run_if: 'row.Domain' },
      ],
      outputs: [{ name: 'domain', value: '{{Domain}}' }, { name: 'shout', value: '{{Shout}}' }],
    };

    it('runs steps per row, records stats, and test mode writes nothing', async () => {
      const fnId = engine.functions.create(ws, { name: 'Domain finder', tags: ['Company', 'company'], definition: def });
      const t = store.createTable(ws, 't');
      textCols(t, 'Company');
      const fcol = store.createColumn(t, { name: 'Fn', type: 'function', config: { functionId: fnId, version: 1, inputs: { company: '{{Company}}' } } });
      store.createColumn(t, { name: 'Shouted', type: 'extract', config: { source: 'Fn', path: 'shout' } });
      const [acme, none, blank] = store.addRows(t, [{ Company: 'Acme' }, { Company: 'none' }, {}]);

      // Sandbox first: nothing is written to the table or the stats.
      const test = await engine.functions.test(ws, def, { tableId: t, limit: 2, mapping: { company: '{{Company}}' } });
      expect(test.results.map((r) => r.outputs.domain)).toEqual(['acme.com', null]);
      expect(test.results[0].steps.map((s) => s.status)).toEqual(['done', 'done']);
      expect(test.results[1].steps[1].status).toBe('skipped');
      expect(store.cell(acme, fcol)).toBeUndefined();
      expect(store.db.get('SELECT COUNT(*) AS n FROM gtm_function_runs')!.n).toBe(0);
      const sample = await engine.functions.test(ws, def, { inputs: [{ company: 'Initech' }] });
      expect(sample.results[0].outputs).toEqual({ domain: 'initech.com', shout: 'INITECH.COM' });

      engine.run(t, { force: true });
      await settle();
      const c = store.cell(acme, fcol)!;
      expect(c.value).toEqual({ value: { domain: 'acme.com', shout: 'ACME.COM' }, data: { domain: 'acme.com', shout: 'ACME.COM' } });
      expect(c.meta.functionSteps.map((s: any) => s.name)).toEqual(['Domain', 'Shout']);
      expect(c.meta.version).toBe(1);
      expect(cell(t, acme, 'Shouted')?.value).toBe('ACME.COM');
      expect(store.cell(none, fcol)?.status).toBe('empty');
      expect(store.cell(blank, fcol)?.status).toBe('skipped');

      const stats = engine.functions.stats(fnId, ws);
      expect(stats.rowsProcessed).toBe(2);
      expect(stats.fillRate).toEqual({ domain: 50, shout: 50 });
      expect(stats.errorRate).toBe(0);
      expect(stats.tables.map((x) => x.column)).toEqual(['Fn']);
      expect(engine.functions.get(fnId, ws).tags).toEqual(['company']);
    });

    it('versions definitions; columns keep theirs until upgraded', async () => {
      const fnId = engine.functions.create(ws, { name: 'f', definition: def });
      const t = store.createTable(ws, 't');
      textCols(t, 'Company');
      const fcol = store.createColumn(t, { name: 'Fn', type: 'function', config: { functionId: fnId, version: 1, inputs: { company: '{{Company}}' } } });
      const [r] = store.addRows(t, [{ Company: 'Acme' }]);
      expect(engine.functions.update(fnId, ws, { tags: ['x'] })).toEqual({ version: 1, bumped: false });
      const v2 = { ...def, outputs: [{ name: 'domain', value: '{{Domain}}' }] };
      expect(engine.functions.update(fnId, ws, { definition: v2 })).toEqual({ version: 2, bumped: true });
      engine.run(t, { force: true });
      await settle();
      expect(Object.keys((store.cell(r, fcol)!.value as any).data)).toEqual(['domain', 'shout']);
      expect(engine.functions.upgradeColumns(fnId, ws)).toEqual([fcol]);
      engine.run(t, { force: true });
      await settle();
      expect(store.cell(r, fcol)!.value).toEqual({ value: 'acme.com', data: { domain: 'acme.com' } });
    });

    it('rejects steps that read later steps', () => {
      expect(() => engine.functions.create(ws, { name: 'bad', definition: { ...def, steps: [...def.steps].reverse() } })).toThrow(/runs later/);
    });
  });
});

describe('HTTP API', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await makeEnv(); });
  afterEach(async () => { await env.close(); });

  it('lookups, one-shot send and functions from columns', async () => {
    const { api } = env;
    const src = (await api('POST', '/api/gtm/tables', { name: 'Companies', template: 'companies' })).body.id;
    const dst = (await api('POST', '/api/gtm/tables', { name: 'Accounts' })).body.id;
    await api('POST', `/api/gtm/tables/${src}/rows`, { rows: [{ Company: 'Acme', 'Company domain': 'acme.io' }, { Company: 'Globex', 'Company domain': 'globex.com' }] });
    const sent = await api('POST', `/api/gtm/tables/${src}/send-to-table`, { targetTableId: dst, fields: [{ name: 'Domain', value: '{{Company domain}}' }, { name: 'Name', value: '{{Company}}' }], dedupeKey: 'Domain', dedupeMode: 'domain' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ rows: 2, created: 2 });
    const again = await api('POST', `/api/gtm/tables/${src}/send-to-table`, { targetTableId: dst, fields: [{ name: 'Domain', value: 'https://www.{{Company domain}}' }], dedupeKey: 'Domain', dedupeMode: 'domain' });
    expect(again.body).toMatchObject({ created: 0 });

    const found = await api('POST', `/api/gtm/tables/${dst}/lookup`, { column: 'Domain', value: 'jane@ACME.io', mode: 'domain' });
    expect(found.body.count).toBe(1);
    expect(found.body.rows[0].Name).toBe('Acme');

    const cols = (await api('GET', `/api/gtm/tables/${src}/columns`)).body;
    const fcol = await api('POST', `/api/gtm/tables/${src}/columns`, { name: 'Slug', type: 'formula', config: { expression: 'row["Company domain"].split(".")[0]' } });
    const made = await api('POST', '/api/gtm/functions/from-columns', { tableId: src, columnIds: [fcol.body.id], name: 'Slugger', tags: ['util'], addColumn: true });
    expect(made.status).toBe(200);
    expect(made.body.mapping).toEqual({ company_domain: '{{Company domain}}' });
    expect(made.body.columnId).toBeTruthy();
    expect(cols.map((c: any) => c.name)).toContain('Company domain');

    const test = await api('POST', `/api/gtm/functions/${made.body.id}/test`, { inputs: [{ company_domain: 'initech.com' }] });
    expect(test.body.results[0].outputs).toEqual({ slug: 'initech' });
    const list = await api('GET', '/api/gtm/functions?tag=util');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].usage).toMatchObject({ columns: 1, tables: 1 });
    const detail = await api('GET', `/api/gtm/functions/${made.body.id}`);
    expect(detail.body.versions).toHaveLength(1);
    expect(detail.body.stats.rowsProcessed).toBe(0);
    const catalog = await api('GET', '/api/gtm/catalog');
    expect(catalog.body.actions.map((x: any) => x.id)).toContain('send_to_table');
  });
});
