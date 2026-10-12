import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderValue, references, renameRefs, getPath } from '../src/gtm/lib/template.ts';
import { evaluate, toDomain } from '../src/gtm/lib/sandbox.ts';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Settings } from '../src/gtm/settings.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { ENRICH_KINDS } from '../src/gtm/providers/catalog.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();

describe('templates', () => {
  const row = { 'Full name': 'Ada Lovelace', 'Company info': { value: 'Analytical', data: { industry: 'Computing', size: 12 } } };
  it('renders names with spaces and wrapped values', () => {
    expect(render('Hi {{Full name}} at {{Company info}}', row)).toBe('Hi Ada Lovelace at Analytical');
  });
  it('reaches into enrichment data by path', () => {
    expect(render('{{Company info.industry}}', row)).toBe('Computing');
    expect(renderValue('{{Company info.size}}', row)).toBe(12);
  });
  it('finds and renames references', () => {
    expect(references('{{Company info.industry}} {{Nope}}', ['Company info', 'Company'])).toEqual(['Company info']);
    expect(renameRefs('{{Company info.industry}}', 'Company info', 'Org')).toBe('{{Org.industry}}');
  });
  it('getPath handles arrays', () => expect(getPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1));
});

describe('sandbox', () => {
  it('evaluates expressions over unwrapped values', () => {
    expect(evaluate('row["Email"].split("@")[1]', { Email: { value: 'a@b.com' } })).toBe('b.com');
    expect(evaluate('const x = 2; return x * row.n', { n: 21 })).toBe(42);
  });
  it('has helpers', () => {
    expect(toDomain('https://www.Stripe.com/pricing')).toBe('stripe.com');
    expect(evaluate('first(row.n) + "/" + last(row.n)', { n: 'Grace Brewster Hopper' })).toBe('Grace/Hopper');
  });
  it('times out runaway code', () => {
    expect(() => evaluate('(() => { while (true) {} })()', {})).toThrow();
  });
});

describe('engine', () => {
  let store: Store, engine: Engine, tableId: number;
  beforeEach(() => {
    const db = new Db(':memory:');
    store = new Store(db);
    engine = new Engine(store, new Settings(db), new Bus());
    tableId = store.createTable(workspace(store.db), 't');
    store.createColumn(tableId, { name: 'Full name', type: 'text' });
    store.createColumn(tableId, { name: 'Website', type: 'text' });
  });

  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const s = engine.stats(tableId);
      if (!s.pending && !s.running) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('engine did not settle');
  };
  const value = (rowId: number, name: string) => {
    const col = store.columns(tableId).find((c) => c.name === name)!;
    return store.cell(rowId, col.id);
  };

  it('runs formulas and cascades when inputs change', async () => {
    const domainCol = store.createColumn(tableId, { name: 'Domain', type: 'formula', config: { expression: 'domain(row.Website)' }, auto_run: true });
    store.createColumn(tableId, { name: 'Greeting', type: 'formula', config: { expression: '`hi ${first(row["Full name"])} @ ${row.Domain}`' }, auto_run: true });
    const [rowId] = store.addRows(tableId, [{ 'Full name': 'Ada Lovelace', Website: 'https://www.example.org/x' }]);
    engine.run(tableId, { force: true });
    await settle();
    expect(value(rowId, 'Domain')?.value).toBe('example.org');
    expect(value(rowId, 'Greeting')?.value).toBe('hi Ada @ example.org');

    const websiteCol = store.columns(tableId).find((c) => c.name === 'Website')!;
    store.writeCell(rowId, websiteCol.id, { value: 'acme.io', status: 'done' });
    engine.inputsChanged(tableId, rowId, ['Website']);
    await settle();
    expect(value(rowId, 'Greeting')?.value).toBe('hi Ada @ acme.io');
    const dom = store.cell(rowId, domainCol)!;
    expect(dom.prev_value).toBe('example.org');
    expect(dom.changed_at).toBeTruthy();
  });

  it('skips cells whose run-if is false', async () => {
    store.createColumn(tableId, { name: 'Only Ada', type: 'formula', config: { expression: '"yes"' }, run_if: 'row["Full name"].startsWith("Ada")' });
    const [a, b] = store.addRows(tableId, [{ 'Full name': 'Ada' }, { 'Full name': 'Bob' }]);
    engine.run(tableId, {});
    await settle();
    expect(value(a, 'Only Ada')?.status).toBe('done');
    expect(value(b, 'Only Ada')?.status).toBe('skipped');
  });

  it('waterfall stops at the first provider that finds something', async () => {
    const kind = ENRICH_KINDS.find((k) => k.id === 'company_domain')!;
    const saved = kind.steps;
    const calls: string[] = [];
    kind.steps = [
      { id: 'a', label: 'A', requires: [], cost: '', run: async () => { calls.push('a'); return null; } },
      { id: 'b', label: 'B', requires: [], cost: '', run: async () => { calls.push('b'); throw new Error('boom'); } },
      { id: 'c', label: 'C', requires: [], cost: '', run: async (i) => { calls.push('c'); return { value: `${i.companyName}.com` }; } },
      { id: 'd', label: 'D', requires: [], cost: '', run: async () => { calls.push('d'); return { value: 'never' }; } },
      { id: 'paid', label: 'Paid', requires: ['APOLLO_API_KEY'], cost: '', run: async () => { calls.push('paid'); return { value: 'x' }; } },
    ];
    try {
      store.createColumn(tableId, { name: 'Company domain', type: 'enrich', config: { kind: 'company_domain', providers: ['paid', 'a', 'b', 'c', 'd'], inputs: { companyName: '{{Full name}}' } } });
      const [rowId] = store.addRows(tableId, [{ 'Full name': 'acme' }]);
      engine.run(tableId, {});
      await settle();
      const cell = value(rowId, 'Company domain')!;
      expect(calls).toEqual(['a', 'b', 'c']);
      expect(cell.value).toMatchObject({ value: 'acme.com', provider: 'c' });
      expect(cell.meta.attempts.map((x: any) => x.result)).toEqual(['no key', 'not found', 'error: boom', 'found']);
    } finally {
      kind.steps = saved;
    }
  });

  it('enrich with missing inputs is skipped, not errored', async () => {
    store.createColumn(tableId, { name: 'Email', type: 'enrich', config: { kind: 'work_email', inputs: { fullName: '{{Full name}}' } } });
    const [rowId] = store.addRows(tableId, [{ 'Full name': 'Ada' }]);
    engine.run(tableId, {});
    await settle();
    expect(value(rowId, 'Email')?.status).toBe('skipped');
  });

  it('renaming a column rewrites references', () => {
    const f = store.createColumn(tableId, { name: 'F', type: 'formula', config: { expression: 'row["Website"] + "{{Website}}"' } });
    const web = store.columns(tableId).find((c) => c.name === 'Website')!;
    store.updateColumn(web.id, { name: 'Site' });
    expect(store.column(f).config.expression).toBe('row["Site"] + "{{Site}}"');
  });
});

describe('engine ordering', () => {
  it('runs a cell only after the cells it references', async () => {
    const db = new Db(':memory:');
    const store = new Store(db);
    const engine = new Engine(store, new Settings(db), new Bus());
    const t = store.createTable(workspace(store.db), 't');
    store.createColumn(t, { name: 'Email', type: 'text' });
    // Created before its input so a naive FIFO queue would run it first.
    const seen = store.createColumn(t, { name: 'Seen', type: 'formula', config: { expression: 'row.Domain' }, auto_run: true });
    store.createColumn(t, { name: 'Domain', type: 'formula', config: { expression: 'domain(row.Email)' }, auto_run: true });
    const [r] = store.addRows(t, [{ Email: 'a@acme.io' }]);
    engine.run(t, { force: true });
    for (let i = 0; i < 100 && (engine.stats(t).pending || engine.stats(t).running); i++) await new Promise((x) => setTimeout(x, 10));
    expect(store.cell(r, seen)?.value).toBe('acme.io');
    expect(store.cell(r, seen)?.prev_value ?? null).toBeNull(); // computed once, not null-then-value
  });
});

describe('engine cycles', () => {
  it('does not deadlock on circular references', async () => {
    const db = new Db(':memory:');
    const store = new Store(db);
    const engine = new Engine(store, new Settings(db), new Bus());
    const t = store.createTable(workspace(store.db), 't');
    store.createColumn(t, { name: 'A', type: 'formula', config: { expression: '(row.B ?? 0) + 1' } });
    store.createColumn(t, { name: 'B', type: 'formula', config: { expression: '(row.A ?? 0) + 1' } });
    store.addRows(t, [{}]);
    engine.run(t, { force: true });
    for (let i = 0; i < 100 && (engine.stats(t).pending || engine.stats(t).running); i++) await new Promise((x) => setTimeout(x, 10));
    expect(engine.stats(t)).toEqual({ pending: 0, running: 0 });
  });
});
