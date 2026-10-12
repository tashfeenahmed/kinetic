import { describe, it, expect, vi, afterEach } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Settings } from '../src/gtm/settings.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();

afterEach(() => vi.unstubAllGlobals());

describe('signal alerts', () => {
  it('fires only when a watched value changes, with a change summary', async () => {
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body)); return new Response('ok'); });
    const db = new Db(':memory:');
    const store = new Store(db);
    const engine = new Engine(store, new Settings(db), new Bus());
    const t = store.createTable(workspace(store.db), 't');
    const src = store.createColumn(t, { name: 'Company', type: 'text' });
    const jobs = store.createColumn(t, { name: 'Openings', type: 'text' });
    // Stand-in for a signal column: derived, auto-run.
    store.createColumn(t, { name: 'Hiring', type: 'formula', config: { expression: 'Number(row.Openings)' }, auto_run: true });
    const alert = store.createColumn(t, {
      name: 'Signal alert', type: 'action', auto_run: true, run_if: 'changed("Hiring")',
      config: { kind: 'webhook', url: 'https://hooks.example/x', body: '{"text":"{{Company}}: {{_changes}}"}' },
    });
    const settle = async () => { for (let i = 0; i < 200 && (engine.stats(t).pending || engine.stats(t).running); i++) await new Promise((r) => setTimeout(r, 5)); };

    const [r] = store.addRows(t, [{ Company: 'Acme', Openings: '3' }]);
    engine.run(t, { force: true });
    await settle();
    expect(sent).toHaveLength(0); // first fill is a baseline, not a change
    expect(store.cell(r, alert)?.status).toBe('skipped');

    store.writeCell(r, jobs, { value: '7', status: 'done' });
    engine.inputsChanged(t, r, ['Openings']);
    await settle();
    expect(sent).toEqual([{ text: 'Acme: *Hiring*: 3 → 7' }]);

    store.writeCell(r, src, { value: 'Acme Inc', status: 'done' }); // unrelated edit
    engine.inputsChanged(t, r, ['Company']);
    await settle();
    expect(sent).toHaveLength(1);
  });
});
