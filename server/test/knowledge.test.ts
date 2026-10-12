import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeEnv, type TestEnv } from './helpers.ts';
import { Db } from '../src/db/db.ts';
import { agentServices } from '../src/agent/routes.ts';
import { classifyRoute } from '../src/agent/policy.ts';
import { docsText, knowledgeContext, TEMPLATES } from '../src/knowledge/store.ts';
import { cleanDraft } from '../src/knowledge/ai.ts';
import { htmlToMarkdown, markdownToHtml } from '../../web/src/pages/knowledge/markdown.ts';

/** Scripted OpenRouter: each call returns the next step; records request bodies. */
function scriptedLlm(steps: ({ tool: string; args: unknown } | { text: string })[]) {
  const bodies: any[] = [];
  let i = 0;
  const handler = (body: any) => {
    bodies.push(body);
    const s = steps[Math.min(i++, steps.length - 1)];
    const message = 'text' in s
      ? { role: 'assistant', content: s.text }
      : { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.002 } });
  };
  return { bodies, handler };
}

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

async function setup(llm?: (body: any) => Response, pages: Record<string, string> = {}) {
  env = await makeEnv({
    fetch: (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('openrouter.ai') && llm) return llm(JSON.parse(init.body));
      for (const [k, html] of Object.entries(pages)) if (u.startsWith(k)) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  if (llm) env.ctx.gtm!.settings.set('OPENROUTER_API_KEY', 'test-key');
  return env;
}

const wsOf = (e: TestEnv) => e.ctx.db.get('SELECT id FROM workspaces LIMIT 1')!.id as number;
const titles = async (e: TestEnv) => (await e.api('GET', '/api/knowledge/docs')).body.data.map((d: any) => d.title);

describe('knowledge docs API', () => {
  it('creates, lists, edits, pins, duplicates, reorders, searches and deletes docs', async () => {
    const e = await setup();
    expect((await e.api('GET', '/api/knowledge/docs')).body.data).toEqual([]);
    expect((await e.api('GET', '/api/knowledge/context')).body.data).toEqual({ text: '', empty: true });

    const blank = (await e.api('POST', '/api/knowledge/docs', {})).body.data;
    expect(blank).toMatchObject({ title: 'Untitled', content: '', pinned: false, created_by: 'user' });
    const icp = (await e.api('POST', '/api/knowledge/docs', { template: 'icp' })).body.data;
    expect(icp.title).toBe('Ideal customer profile');
    expect(icp.content).toContain('## Firmographics');
    expect((await e.api('POST', '/api/knowledge/docs', { template: 'nope' })).status).toBe(400);
    const tone = (await e.api('POST', '/api/knowledge/docs', { title: 'Tone of voice', content: '## Rules\n\n- Short\n- No jargon' })).body.data;
    // Newest on top.
    expect(await titles(e)).toEqual(['Tone of voice', 'Ideal customer profile', 'Untitled']);

    const p = await e.api('PATCH', `/api/knowledge/docs/${blank.id}`, { title: 'Pricing notes', content: 'We charge **€49/mo**.' });
    expect(p.body.data).toMatchObject({ title: 'Pricing notes', content: 'We charge **€49/mo**.' });
    expect((await e.api('PATCH', `/api/knowledge/docs/${blank.id}`, { title: '' })).status).toBe(422);

    await e.api('PATCH', `/api/knowledge/docs/${blank.id}`, { pinned: true });
    expect(await titles(e)).toEqual(['Pricing notes', 'Tone of voice', 'Ideal customer profile']);

    const dup = (await e.api('POST', `/api/knowledge/docs/${tone.id}/duplicate`)).body.data;
    expect(dup).toMatchObject({ title: 'Tone of voice (copy)', content: tone.content });

    const r = await e.api('POST', '/api/knowledge/docs/reorder', { ids: [icp.id, tone.id, dup.id] });
    expect(r.body.data.map((d: any) => d.title)).toEqual(['Pricing notes', 'Ideal customer profile', 'Tone of voice', 'Tone of voice (copy)']);

    const list = (await e.api('GET', '/api/knowledge/docs')).body.data;
    expect(list[0]).toMatchObject({ pinned: true, excerpt: 'We charge €49/mo.' });
    expect(list[0].content).toBeUndefined();
    expect((await e.api('GET', `/api/knowledge/docs/${icp.id}`)).body.data.content).toContain('Buying triggers');
    expect((await e.api('GET', '/api/knowledge/docs?q=jargon')).body.data.map((d: any) => d.id)).toEqual([tone.id, dup.id]);

    expect((await e.api('DELETE', `/api/knowledge/docs/${dup.id}`)).status).toBe(200);
    expect((await e.api('GET', `/api/knowledge/docs/${dup.id}`)).status).toBe(404);
    expect((await e.api('GET', '/api/knowledge/templates')).body.data.map((t: any) => t.title)).toEqual(TEMPLATES.map((t) => t.title));

    const bulk = await e.api('POST', '/api/knowledge/docs/bulk', { docs: [{ title: 'A', content: 'a' }, { title: 'B', content: 'b' }], created_by: 'autofill' });
    expect(bulk.body.data.map((d: any) => [d.title, d.created_by])).toEqual([['A', 'autofill'], ['B', 'autofill']]);
    expect((await titles(e)).slice(0, 3)).toEqual(['Pricing notes', 'A', 'B']);

    // The old structured endpoints are gone.
    expect((await e.api('PUT', '/api/knowledge', { tone: 'x' })).status).toBe(404);
  });

  it('builds the context from docs: pinned first, truncated, the rest listed by title', async () => {
    const e = await setup();
    const ws = wsOf(e);
    await e.api('POST', '/api/knowledge/docs', { title: 'Empty', content: '' });
    await e.api('POST', '/api/knowledge/docs', { title: 'Competitors', content: '- **Square** — cheaper hardware\n\n\n\n- ' });
    const icp = (await e.api('POST', '/api/knowledge/docs', { title: 'ICP', content: '## Firmographics\n\n- Cafés in Ireland' })).body.data;
    await e.api('PATCH', `/api/knowledge/docs/${icp.id}`, { pinned: true });
    const text = (await e.api('GET', '/api/knowledge/context')).body.data.text as string;
    expect(text).toBe(`### ICP (doc #${icp.id})\n## Firmographics\n\n- Cafés in Ireland\n\n### Competitors (doc #${icp.id - 1})\n- **Square** — cheaper hardware`);
    expect(knowledgeContext(e.ctx, ws)).toBe(text);
    expect(knowledgeContext(e.ctx, 9999)).toBe('');

    // Truncation: a pinned doc gets the bigger share, long docs are cut, overflow is listed.
    const long = (n: number, w: string) => Array.from({ length: n }, (_, i) => `- ${w} line ${i}`).join('\n');
    const docs = [
      { id: 1, title: 'Pinned', content: long(300, 'pin'), pinned: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({ id: i + 2, title: `Doc ${i + 2}`, content: long(100, `d${i + 2}`), pinned: 0 })),
    ];
    const t = docsText(docs, 5000);
    expect(t.length).toBeLessThanOrEqual(5000);
    expect(t.startsWith('### Pinned (doc #1)\n- pin line 0')).toBe(true);
    expect(t.indexOf('### Doc 2')).toBeGreaterThan(2500); // pinned took ~60%
    expect(t).toContain(' …');
    expect(t).toMatch(/\n\n\(More docs — read with the knowledge tool: #\d+ Doc \d+; .*; \+\d+ more\)$/);
    expect(docsText([], 5000)).toBe('');
  });

  it('AI research columns can append the Knowledge Hub docs', async () => {
    const bodies: any[] = [];
    const e = await setup((b) => {
      bodies.push(b);
      return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's', type: 'function', function: { name: 'submit', arguments: '{"answer":"fit"}' } }] } }] });
    });
    await e.api('POST', '/api/knowledge/docs', { title: 'Company overview', content: 'Tillr: POS for cafés' });
    const { runAgent } = await import('../src/gtm/engine/agent.ts');
    const base = { prompt: 'Is Acme a fit?', outputs: [], webSearch: false, fetchPages: false };
    await runAgent({ ...base }, { settings: e.ctx.gtm!.settings, workspaceId: wsOf(e), log: () => {} });
    await runAgent({ ...base, useKnowledge: true }, { settings: e.ctx.gtm!.settings, workspaceId: wsOf(e), log: () => {} });
    expect(bodies[0].messages[1].content).not.toContain('Knowledge Hub');
    expect(bodies[1].messages[1].content).toContain('### Company overview');
    expect(bodies[1].messages[1].content).toContain('Tillr: POS for cafés');
  });
});

describe('markdown round-trip (editor storage)', () => {
  it('keeps headings, lists, tasks, links, quotes, code and dividers', () => {
    const md = [
      '## Firmographics', '',
      '- **Industries:** Hospitality, Retail', '- Geos: [Ireland](https://ie.example.com)', '  - Dublin', '  - Cork', '',
      '1. First', '2. Second', '',
      '- [ ] Todo item', '- [x] Done item', '',
      '> A quote', '',
      'Some _italic_ and `code` and ~~gone~~.', '',
      '---', '',
      '```js', 'const x = 1;', '```', '',
      '### Small heading',
    ].join('\n');
    const html = markdownToHtml(md);
    expect(html).toContain('<h2>Firmographics</h2>');
    expect(html).toContain('<ul data-type="taskList"><li data-type="taskItem" data-checked="false">');
    expect(htmlToMarkdown(html)).toBe(md);
  });

  it('turns TipTap editor HTML into tidy markdown', () => {
    const html = '<h1>Title</h1><ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul><ol><li><p>one</p></li><li><p>two</p></li></ol>'
      + '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li>'
      + '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>'
      + '<p>x <a target="_blank" rel="noopener noreferrer nofollow" href="https://a.com">link</a> <strong>b</strong> <s>s</s></p><p></p><hr><blockquote><p>q</p></blockquote>';
    expect(htmlToMarkdown(html)).toBe('# Title\n\n- a\n  - b\n- c\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo\n\nx [link](https://a.com) **b** ~~s~~\n\n---\n\n> q');
    expect(htmlToMarkdown('<p></p>')).toBe('');
  });
});

describe('migration 011', () => {
  it('converts the structured hub into one markdown doc per non-empty section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetic-mig-'));
    try {
      const path = join(dir, 'k.db');
      const migDir = join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
      const raw = new DatabaseSync(path);
      raw.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql') && x < '011').sort()) {
        raw.exec(readFileSync(join(migDir, f), 'utf8'));
        raw.prepare('INSERT INTO _migrations VALUES (?, ?)').run(f, 'x');
      }
      raw.exec("INSERT INTO workspaces (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')");
      const hub = {
        company: { name: 'Tillr', website: 'tillr.ie', overview: 'Cloud POS for cafés.' },
        offers: [{ name: 'Tillr POS', description: 'Tills', pricing: '€49/mo' }, { name: '', description: 'skip', pricing: '' }],
        icp: { industries: ['Hospitality', 'Retail'], sizes: [], geos: ['Ireland'], tech: [], triggers: ['New site'], notes: 'Owner-run.' },
        personas: [{ title: 'Café owner', pains: 'Queues', goals: '', objections: 'Price' }],
        positioning: '', competitors: [{ name: 'Square', domain: 'squareup.com', notes: 'US-centric' }],
        proof: [{ title: 'Café X', summary: 'Cut queues 30%', url: 'https://tillr.ie/x' }], tone: 'Friendly.', exclusions: '',
      };
      const ins = raw.prepare('INSERT INTO knowledge_hub (workspace_id, data, updated_at) VALUES (?, ?, ?)');
      ins.run(1, JSON.stringify(hub), '2026-01-01T00:00:00.000Z');
      ins.run(2, '{}', '2026-01-01T00:00:00.000Z');
      ins.run(3, 'not json', '2026-01-01T00:00:00.000Z');
      raw.prepare("INSERT INTO knowledge_docs (workspace_id, title, content, created_at, updated_at) VALUES (1, 'Website: tillr.ie', 'crawl', 'x', 'x')").run();
      raw.close();

      const db = new Db(path); // applies 011
      try {
        const docs = db.all('SELECT title, content, created_by FROM knowledge_docs WHERE workspace_id = 1 ORDER BY pinned DESC, position ASC, id DESC');
        expect(docs.map((d) => d.title)).toEqual(['Company overview', 'Products & offers', 'Ideal customer profile', 'Buyer personas', 'Competitors', 'Case studies', 'Tone of voice', 'Website: tillr.ie']);
        const by = Object.fromEntries(docs.map((d) => [d.title, d.content]));
        expect(by['Company overview']).toBe('**Company:** Tillr\n**Website:** tillr.ie\n\nCloud POS for cafés.');
        expect(by['Products & offers']).toBe('## Tillr POS\n\nTills\n\n**Pricing:** €49/mo');
        expect(by['Ideal customer profile']).toBe('- **Industries:** Hospitality, Retail\n- **Geographies:** Ireland\n- **Buying triggers:** New site\n\nOwner-run.');
        expect(by['Buyer personas']).toBe('## Café owner\n\n**Pains:** Queues\n\n**Objections:** Price');
        expect(by.Competitors).toBe('- **Square** (squareup.com) — US-centric');
        expect(by['Case studies']).toBe('## Café X\n\nCut queues 30%\n\n[Source](https://tillr.ie/x)');
        expect(by['Tone of voice']).toBe('Friendly.');
        expect(docs.find((d) => d.title === 'Website: tillr.ie')!.created_by).toBe('autofill');
        expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM knowledge_docs WHERE workspace_id IN (2, 3)')!.n).toBe(0);
        // The converted docs render as context.
        expect(knowledgeContext({ db }, 1)).toContain('### Company overview');
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('drafting from text (the multi-step website research is in knowledge-agent.test.ts)', () => {
  it('cleanDraft drops empty docs and keeps display order', () => {
    expect(cleanDraft({ tone: 'T', company: 'C', bogus: 'x', personas: ['Owner', { title: 'GM', pains: 'time' }] }).map((d) => [d.key, d.content]))
      .toEqual([['company', 'C'], ['personas', '- Owner\n- GM — time'], ['tone', 'T']]);
    expect(cleanDraft(null)).toEqual([]);
  });
});

describe('agent manages the knowledge hub', () => {
  it('creates a doc through the api tool, then reads and searches it with the knowledge tool', async () => {
    const llm = scriptedLlm([
      { tool: 'load_skill', args: { name: 'knowledge-hub' } },
      { tool: 'api', args: { method: 'POST', path: '/api/knowledge/docs', body: { title: 'Ideal customer profile', content: '## Firmographics\n\n- **Industries:** Cafés\n- **Geographies:** Ireland' } } },
      { tool: 'knowledge', args: { doc: 'ideal customer' } },
      { tool: 'knowledge', args: { query: 'ireland' } },
      { tool: 'knowledge', args: {} },
      { text: 'Wrote your ICP doc.' },
    ]);
    const e = await setup(llm.handler);
    const r = await e.api('POST', '/api/agent/sessions', { message: 'Write our ICP doc from what you know' });
    await agentServices.get(e.app)!.idle(r.body.data.id);
    const s = (await e.api('GET', `/api/agent/sessions/${r.body.data.id}`)).body.data;
    expect(s.status).toBe('idle');
    const tools = s.messages.filter((m: any) => m.role === 'tool');
    expect(tools.map((m: any) => [m.tool_name, m.status])).toEqual([['load_skill', 'done'], ['api', 'done'], ['knowledge', 'done'], ['knowledge', 'done'], ['knowledge', 'done']]);
    expect(tools[0].content).toContain('POST /api/knowledge/docs');

    const doc = e.ctx.db.get(`SELECT * FROM knowledge_docs WHERE title = 'Ideal customer profile'`);
    expect(doc).toMatchObject({ created_by: 'agent', content: '## Firmographics\n\n- **Industries:** Cafés\n- **Geographies:** Ireland' });
    expect(tools[1].meta.label).toBe(`POST /api/knowledge/docs → created doc #${doc.id}`);
    expect(tools[1].meta.links).toEqual([{ label: 'Doc “Ideal customer profile”', to: `/knowledge?doc=${doc.id}` }]);
    expect(tools[2].content).toContain(`# Ideal customer profile (doc #${doc.id}`);
    expect(tools[2].content).toContain('- **Geographies:** Ireland');
    expect(tools[3].content).toBe(`#${doc.id} Ideal customer profile\n  [Firmographics] - **Geographies:** Ireland`);
    expect(tools[4].content).toContain(`#${doc.id} Ideal customer profile (`);
    expect(tools[4].meta.label).toBe('Read Knowledge Hub (1 doc)');

    // The next model call sees the doc in its system prompt.
    expect(llm.bodies.at(-1).messages[0].content).toContain(`### Ideal customer profile (doc #${doc.id})`);
  });

  it('deleting a doc needs approval; reading and writing do not', () => {
    expect(classifyRoute('DELETE', '/api/knowledge/docs/3').kind).toBe('approve');
    expect(classifyRoute('POST', '/api/knowledge/docs').kind).toBe('allow');
    expect(classifyRoute('PATCH', '/api/knowledge/docs/3').kind).toBe('allow');
    expect(classifyRoute('POST', '/api/knowledge/autofill').kind).toBe('allow');
  });

  it('the knowledge tool says when the hub is empty', async () => {
    const llm = scriptedLlm([{ tool: 'knowledge', args: {} }, { text: 'Empty.' }]);
    const e = await setup(llm.handler);
    const r = await e.api('POST', '/api/agent/sessions', { message: 'What do we sell?' });
    await agentServices.get(e.app)!.idle(r.body.data.id);
    const s = (await e.api('GET', `/api/agent/sessions/${r.body.data.id}`)).body.data;
    expect(s.messages.find((m: any) => m.role === 'tool').content).toContain('no documents yet');
    expect(llm.bodies[0].messages[0].content).toContain('(no documents yet');
  });
});
