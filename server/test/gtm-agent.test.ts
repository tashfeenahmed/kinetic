import { describe, it, expect, vi, afterEach } from 'vitest';
import { runAgent } from '../src/gtm/engine/agent.ts';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();

afterEach(() => vi.unstubAllGlobals());

describe('research agent', () => {
  it('loops through tool calls and returns the submitted fields', async () => {
    const db = new Db(':memory:');
    const settings = new Settings(db);
    settings.set('OPENROUTER_API_KEY', 'test');
    settings.set('SERPER_API_KEY', 'test');
    const bodies: any[] = [];
    let turn = 0;
    vi.stubGlobal('fetch', async (url: URL | string, init: any) => {
      const u = String(url);
      if (u.includes('serper.dev')) return Response.json({ organic: [{ title: 'Acme raises', link: 'https://news.example/acme', snippet: 'Series B' }] });
      if (u.includes('openrouter.ai')) {
        bodies.push(JSON.parse(init.body));
        turn++;
        const tool_calls = turn === 1
          ? [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Acme funding"}' } }]
          : [{ id: 'c2', type: 'function', function: { name: 'submit', arguments: '{"stage":"Series B","employees":"about 120","sources":["https://news.example/acme"]}' } }];
        return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 } });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const r = await runAgent({ prompt: 'Acme funding?', outputs: [{ name: 'stage', type: 'string' }, { name: 'employees', type: 'number' }], webSearch: true, fetchPages: true }, { settings, log: () => {} });
    expect(r.output).toEqual({ stage: 'Series B', employees: 120 });
    expect(r.sources).toEqual(['https://news.example/acme']);
    expect(r.model).toBe('anthropic/claude-haiku-5.5');
    expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['submit', 'web_search', 'fetch_page']);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(r.usage.prompt).toBe(200);
  });
});
