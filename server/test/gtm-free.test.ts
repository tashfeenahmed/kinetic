import { describe, it, expect } from 'vitest';
import { inferPattern } from '../src/gtm/providers/freeEmail.ts';
import { detect } from '../src/gtm/lib/wappalyzer.ts';
import { Db } from '../src/db/db.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Settings } from '../src/gtm/settings.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { ENRICH_KINDS } from '../src/gtm/providers/catalog.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();

describe('email pattern inference', () => {
  it('picks the pattern that explains the most named samples', () => {
    const p = inferPattern([
      { email: 'ada.lovelace@acme.io', name: 'Ada Lovelace', source: 'github' },
      { email: 'grace.hopper@acme.io', name: 'Grace B. Hopper', source: 'github' },
      { email: 'alan@acme.io', name: 'Alan Turing', source: 'github' },
      { email: 'info@acme.io', source: 'website' },
    ]);
    expect(p).toEqual({ pattern: 'first.last', support: 2 });
  });
  it('handles accents and flast', () => {
    expect(inferPattern([{ email: 'jmuller@x.de', name: 'Jürgen Müller', source: 'g' }])).toEqual({ pattern: 'flast', support: 1 });
  });
});

describe('weak waterfall hits', () => {
  it('keeps a weak hit as fallback, prefers a later strong hit', async () => {
    const db = new Db(':memory:');
    const store = new Store(db);
    const engine = new Engine(store, new Settings(db), new Bus());
    const kind = ENRICH_KINDS.find((k) => k.id === 'company_domain')!;
    const saved = kind.steps;
    const t = store.createTable(workspace(store.db), 't');
    store.createColumn(t, { name: 'Name', type: 'text' });
    const run = async (steps: typeof saved) => {
      kind.steps = steps;
      const col = store.createColumn(t, { name: `D${Math.random()}`, type: 'enrich', config: { kind: 'company_domain', inputs: { companyName: '{{Name}}' } } });
      const [r] = store.addRows(t, [{ Name: 'acme' }]);
      engine.run(t, { columnIds: [col], rowIds: [r] });
      for (let i = 0; i < 100 && (engine.stats(t).pending || engine.stats(t).running); i++) await new Promise((x) => setTimeout(x, 5));
      return store.cell(r, col)!;
    };
    try {
      const weak = { id: 'weak', label: 'W', requires: [], cost: '', run: async () => ({ value: 'guess.com', weak: true, confidence: 'catch-all' }) };
      const strong = { id: 'strong', label: 'S', requires: [], cost: '', run: async () => ({ value: 'acme.com' }) };
      const none = { id: 'none', label: 'N', requires: [], cost: '', run: async () => null };
      expect((await run([weak, strong])).value).toMatchObject({ value: 'acme.com', provider: 'strong' });
      const fb = await run([weak, none]);
      expect(fb.value).toMatchObject({ value: 'guess.com', provider: 'weak', confidence: 'catch-all' });
      expect(fb.meta.attempts.map((a: any) => a.result)).toEqual(['weak: catch-all', 'not found']);
    } finally {
      kind.steps = saved;
    }
  });
});

describe('wappalyzer matcher', () => {
  it('matches html, scripts, headers, cookies, dns and implies', () => {
    const fp = {
      categories: { '1': 'CMS', '2': 'Programming languages', '3': 'Marketing automation' },
      techs: [
        { name: 'WordPress', cats: [1], implies: ['PHP'], html: [], scriptSrc: [], scripts: [], url: [], meta: { generator: [{ re: /WordPress ?([\d.]+)?/i, version: '\\1' }] }, headers: {}, cookies: {}, dns: {} },
        { name: 'PHP', cats: [2], implies: [], html: [], scriptSrc: [], scripts: [], url: [], meta: {}, headers: {}, cookies: {}, dns: {} },
        { name: 'HubSpot', cats: [3], implies: [], html: [], scriptSrc: [{ re: /\.hs-scripts\.com\//i }], scripts: [], url: [], meta: {}, headers: {}, cookies: {}, dns: { txt: [{ re: /hubspot/i }] } },
      ],
    } as any;
    const found = detect(fp, { url: 'https://x.com', html: '<meta name="generator" content="WordPress 6.5"><script src="https://js.hs-scripts.com/1.js"></script>', headers: {}, dns: {} });
    expect(found.map((f) => [f.name, f.version])).toEqual([['WordPress', '6.5'], ['HubSpot', undefined], ['PHP', undefined]]);
  });
});
