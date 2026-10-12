import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { researchServices } from '../src/knowledge/routes.ts';
import { pickPages, siteLinks, RESEARCH_DOCS, cleanMarkdown } from '../src/knowledge/research.ts';
import { applyEdit, inferMode } from '../src/knowledge/docAgent.ts';
import { htmlToMarkdown, markdownToHtml } from '../../web/src/pages/knowledge/markdown.ts';

// ---------- a fake company website, search engine and model ----------

const nav = ['/about', '/pricing', '/product', '/customers', '/blog', '/careers', '/contact', '/privacy', '/login', 'https://twitter.com/tillr', '/about#team', '/pricing?ref=nav']
  .map((h) => `<a href="${h}">${h}</a>`).join('');
const HOME = `<html><head><title>Tillr | Cloud POS for cafés</title><meta name="description" content="Cloud POS for independent cafés in Ireland"></head>
  <body><nav>${nav}</nav><h1>Tills that keep the queue moving</h1><p>Trusted by Café Rua and Brew Lab.</p></body></html>`;
const SITEMAP = `<?xml version="1.0"?><urlset>${['/', '/features', '/customers/cafe-rua', '/customers/brew-lab', '/blog/2026-kitchen-screens', '/blog/2025-loyalty', '/blog/2024-old-post', '/solutions/bakeries', '/de/about', '/compare/square']
  .map((p) => `<url><loc>https://tillr.ie${p}</loc></url>`).join('')}</urlset>`;
const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
const SITE: Record<string, string> = {
  'https://tillr.ie/sitemap.xml': SITEMAP,
  'https://tillr.ie/about': page('About Tillr', 'Founded in Galway in 2019, 25 people.'),
  'https://tillr.ie/pricing': page('Pricing', 'Starter €49 a month. Pro €89 a month.'),
  'https://tillr.ie/product': page('Product', 'Tills, kitchen screens, loyalty.'),
  'https://tillr.ie/features': page('Features', 'Offline mode, tap to pay.'),
  'https://tillr.ie/customers': page('Customers', 'Café Rua cut queues by 30%.'),
  'https://tillr.ie/customers/cafe-rua': page('Café Rua', 'Café Rua cut queues by 30%.'),
  'https://tillr.ie/customers/brew-lab': page('Brew Lab', 'Brew Lab opened 3 sites.'),
  'https://tillr.ie/blog': page('Blog', 'News from Tillr.'),
  'https://tillr.ie/blog/2026-kitchen-screens': page('Kitchen screens', 'New kitchen screens.'),
  'https://tillr.ie/blog/2025-loyalty': page('Loyalty', 'Loyalty launch.'),
  'https://tillr.ie/careers': page('Careers', 'Hiring a sales lead.'),
  'https://tillr.ie/contact': page('Contact', 'Galway, Ireland.'),
  'https://tillr.ie/solutions/bakeries': page('Bakeries', 'POS for bakeries.'),
  'https://tillr.ie/compare/square': page('Tillr vs Square', 'Local support vs US-centric.'),
  'https://tillr.ie': HOME,
  'https://squareup.com': page('Square POS', 'Point of sale for every business.'),
  'https://www.lightspeedhq.com': page('Lightspeed', 'Commerce platform for hospitality.'),
  'https://www.g2.com/products/tillr/reviews': page('Tillr reviews | G2', '4.7 stars from 40 reviews.'),
};

const serp = (q: string) => ({
  organic: q.includes('reviews')
    ? [{ title: 'Tillr reviews', link: 'https://www.g2.com/products/tillr/reviews', snippet: '4.7 stars' }]
    : [{ title: 'Square POS', link: 'https://squareup.com/ie', snippet: 'POS' }, { title: 'Lightspeed', link: 'https://www.lightspeedhq.com', snippet: 'Hospitality POS' }],
});

const longDoc = (title: string) => {
  const table = title === 'Competitors'
    ? '\n\n## Comparison\n\n| Competitor | Website | Positioning | Pricing | Strengths | Weaknesses vs us |\n| --- | --- | --- | --- | --- | --- |\n| Square | squareup.com | POS for every business | Free + fees | Brand | US-centric support |\n| Lightspeed | lightspeedhq.com | Hospitality platform | From €69 | Features | Complex |'
    : '';
  return `# ${title}\n\n## Overview\n\n${`Tillr ${title.toLowerCase()} detail. `.repeat(30)}\n\n- **Point:** one\n- **Point:** two${table}`;
};

function fakeLlm() {
  const bodies: any[] = [];
  const handler = (body: any) => {
    bodies.push(body);
    const tool = body.tool_choice?.function?.name;
    const call = (name: string, args: unknown) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${bodies.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    let message: any;
    if (tool === 'facts') {
      message = call('facts', { company_name: 'Tillr', one_liner: 'Cloud POS for independent cafés in Ireland', category: 'cafe POS software', region: 'Ireland', customers_named: ['Café Rua', 'Brew Lab'], competitors_named: ['Square'] });
    } else if (tool === 'competitors') {
      message = call('competitors', { list: [{ name: 'Square', website: 'squareup.com', why: 'POS' }, { name: 'Lightspeed', website: 'https://www.lightspeedhq.com/ie', why: 'Hospitality' }, { name: 'Tillr', website: 'tillr.ie' }] });
    } else {
      const doc = String(body.messages.at(-1).content).match(/DOCUMENT: (.+)/)?.[1];
      message = { role: 'assistant', content: longDoc(doc ?? 'Unknown') };
    }
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 2000, completion_tokens: 800, cost: 0.004 } });
  };
  return { bodies, handler };
}

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

async function setup(opts: { llm?: (body: any) => Response; search?: boolean } = {}) {
  const fetched: string[] = [];
  env = await makeEnv({
    fetch: (async (url: any, init: any) => {
      const u = String(url);
      fetched.push(u);
      if (u.includes('openrouter.ai') && opts.llm) return opts.llm(JSON.parse(init.body));
      if (u.startsWith('https://google.serper.dev')) return Response.json(serp(JSON.parse(init.body).q));
      const key = u.replace(/\/$/, '');
      if (SITE[key]) return new Response(SITE[key], { status: 200, headers: { 'content-type': 'text/html' } });
      if (key === 'https://squareup.com/ie') return new Response(SITE['https://squareup.com'], { status: 200 });
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });
  if (opts.llm) env.ctx.gtm!.settings.set('OPENROUTER_API_KEY', 'test-key');
  if (opts.search !== false) env.ctx.gtm!.settings.set('SERPER_API_KEY', 'serper-key');
  return { e: env, fetched };
}

const wsOf = (e: TestEnv) => e.ctx.db.get('SELECT id FROM workspaces LIMIT 1')!.id as number;
const titles = async (e: TestEnv) => (await e.api('GET', '/api/knowledge/docs')).body.data.map((d: any) => d.title);

describe('fill from website: multi-step research', () => {
  it('picks the important pages from links and the sitemap', () => {
    const base = new URL('https://tillr.ie');
    const links = siteLinks(HOME, base);
    expect(links).toContain('https://tillr.ie/pricing');
    expect(links.some((l) => l.includes('twitter'))).toBe(false);
    const picked = pickPages([...links, ...[...SITEMAP.matchAll(/<loc>([^<]+)/g)].map((m) => m[1])], base, 30);
    const paths = picked.map((p) => new URL(p.url).pathname);
    expect(paths).toEqual(expect.arrayContaining(['/about', '/pricing', '/product', '/features', '/customers', '/customers/cafe-rua', '/blog', '/blog/2026-kitchen-screens', '/careers', '/contact', '/solutions/bakeries', '/compare/square']));
    expect(paths).not.toContain('/privacy');
    expect(paths).not.toContain('/login');
    expect(paths).not.toContain('/de/about');
    expect(paths).not.toContain('/blog/2024-old-post'); // only the most recent posts
    expect(new Set(paths).size).toBe(paths.length);
    expect(pickPages(links, base, 3)).toHaveLength(3);
  });

  it('crawls, searches, checks competitors and writes every document with substance', async () => {
    const llm = fakeLlm();
    const { e, fetched } = await setup({ llm: llm.handler });
    const start = await e.api('POST', '/api/knowledge/research', { domain: 'tillr.ie' });
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe('running');
    await researchServices.get(e.app)!.wait(start.body.data.id);
    const run = (await e.api('GET', `/api/knowledge/research/${start.body.data.id}`)).body.data;
    expect(run.status).toBe('done');
    const res = run.result;

    // Many pages crawled (home + nav + sitemap), deduped.
    expect(res.pages.length).toBeGreaterThanOrEqual(12);
    expect(res.pages).toEqual(expect.arrayContaining(['https://tillr.ie/pricing', 'https://tillr.ie/customers/cafe-rua', 'https://tillr.ie/blog/2026-kitchen-screens']));
    expect(fetched).toContain('https://tillr.ie/sitemap.xml');
    // Outside research: competitors, alternatives, category, reviews, LinkedIn, press, customers.
    expect(res.searches).toEqual(expect.arrayContaining(['Tillr competitors', 'Tillr alternatives', 'best cafe POS software Ireland', 'Tillr reviews', 'Café Rua company']));
    expect(fetched).toContain('https://www.g2.com/products/tillr/reviews');
    // Competitors picked (not the company itself) and their sites read.
    expect(res.competitors.map((c: any) => [c.name, c.website])).toEqual([['Square', 'squareup.com'], ['Lightspeed', 'www.lightspeedhq.com']]);
    expect(fetched.map((u) => u.replace(/\/$/, ''))).toContain('https://squareup.com');
    expect(fetched.map((u) => u.replace(/\/$/, ''))).toContain('https://www.lightspeedhq.com');

    // Every document, substantial, with a table in Competitors.
    expect(res.drafts.map((d: any) => d.title)).toEqual(RESEARCH_DOCS.map((d) => d.title));
    for (const d of res.drafts) {
      expect(d.content.length).toBeGreaterThan(600);
      expect(d.content.startsWith('# ')).toBe(false);
      expect(d.exists).toBe(false);
    }
    const comp = res.drafts.find((d: any) => d.key === 'competitors').content;
    expect(comp).toContain('| Competitor | Website |');
    expect(comp).toMatch(/\n\| --- \| --- \|/);
    expect(res.ai).toBe(true);
    expect(res.usage).toMatchObject({ calls: 2 + RESEARCH_DOCS.length, cost_usd: 0.044 });

    // The writers see the site, the search results and the competitors.
    const personaCall = llm.bodies.find((b) => String(b.messages.at(-1).content).includes('DOCUMENT: Buyer personas'));
    const brief = personaCall.messages.at(-1).content as string;
    expect(brief).toContain('Starter €49 a month');
    expect(brief).toContain('### Search: Tillr competitors');
    expect(brief).toContain('### Square (squareup.com)');
    expect(brief).toContain('Example opening line');
    expect(personaCall.model).toBe('anthropic/claude-haiku-5.5');

    // Live steps the UI shows.
    const labels = run.steps.map((s: any) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Reading /pricing…', 'Searching competitors…', 'Checking competitor Square…', 'Writing buyer personas…', 'Writing competitors…']));
    expect(run.steps.every((s: any) => s.status !== 'running')).toBe(true);
    expect(await titles(e)).toEqual([]); // nothing saved until review
  });

  it('autofill (one call) runs the research; apply=true files the docs in a folder and never overwrites', async () => {
    const { e } = await setup({ llm: fakeLlm().handler });
    await e.api('POST', '/api/knowledge/docs', { title: 'Tone of voice', content: 'Mine.' });
    const r = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie', apply: true });
    expect(r.status).toBe(200);
    expect(r.body.data.applied).toBe(true);
    expect(r.body.data.drafts.find((d: any) => d.key === 'tone').exists).toBe(true);
    expect(r.body.data.created).toHaveLength(RESEARCH_DOCS.length - 1);
    expect(r.body.data.folder.name).toBe('tillr.ie');
    expect(r.body.data.created.every((d: any) => d.created_by === 'autofill' && d.folder_path === 'tillr.ie')).toBe(true);
    const tone = e.ctx.db.get(`SELECT content FROM knowledge_docs WHERE title = 'Tone of voice' AND folder_id IS NULL`);
    expect(tone.content).toBe('Mine.');
  });

  it('keeps going without web search, and says so', async () => {
    const { e } = await setup({ llm: fakeLlm().handler, search: false });
    // No search keys: DuckDuckGo is the last resort; make it fail fast.
    const r = await e.api('POST', '/api/knowledge/research', { domain: 'tillr.ie' });
    const svc = researchServices.get(e.app)!;
    await svc.wait(r.body.data.id);
    const run = (await e.api('GET', `/api/knowledge/research/${r.body.data.id}`)).body.data;
    expect(run.status).toBe('done');
    expect(run.result.searches).toEqual([]);
    expect(run.result.notes.join(' ')).toContain('Web search is unavailable');
    expect(run.result.drafts.length).toBe(RESEARCH_DOCS.length);
  }, 120_000);

  it('without an AI key crawls and drafts a company overview, with clear messaging', async () => {
    const { e } = await setup();
    const r = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie' });
    expect(r.body.data.ai).toBe(false);
    expect(r.body.data.drafts).toHaveLength(1);
    expect(r.body.data.drafts[0].content).toContain('**Company:** Tillr');
    expect(r.body.data.drafts[0].content).toContain('| [/pricing](https://tillr.ie/pricing) | Pricing |');
    expect(r.body.data.notes[0]).toContain('No AI model is set up');
    expect((await e.api('POST', '/api/knowledge/autofill', { domain: 'nope.example' })).status).toBe(400);
  });

  it('runs are scoped to their workspace and can be stopped', async () => {
    const { e } = await setup({ llm: fakeLlm().handler });
    const svc = researchServices.get(e.app)!;
    const other = e.ctx.db.insert('workspaces', { name: 'Other' });
    const foreign = svc.start(other, 'tillr.ie');
    expect((await e.api('GET', `/api/knowledge/research/${foreign.id}`)).status).toBe(404);
    expect((await e.api('POST', `/api/knowledge/research/${foreign.id}/stop`)).body.data.stopped).toBe(false);
    const mine = (await e.api('POST', '/api/knowledge/research', { domain: 'tillr.ie' })).body.data;
    expect((await e.api('POST', `/api/knowledge/research/${mine.id}/stop`)).body.data.stopped).toBe(true);
    await svc.wait(mine.id);
    await svc.wait(foreign.id);
    expect((await e.api('GET', `/api/knowledge/research/${mine.id}`)).body.data).toMatchObject({ status: 'stopped', result: null });
    expect(svc.get(wsOf(e), foreign.id)).toBeUndefined();
  });

  it('cleanMarkdown strips fences and a top-level title', () => {
    expect(cleanMarkdown('```markdown\n# Title\n\n## A\n\n\n\ntext\n```')).toBe('## A\n\ntext');
  });
});

describe('tables in the editor (markdown round-trip)', () => {
  it('round-trips a GFM table with inline formatting', () => {
    const md = [
      '## Competitors', '',
      '| Competitor | Website | Notes |',
      '| --- | --- | --- |',
      '| **Square** | [squareup.com](https://squareup.com) | _US-centric_, `fees` |',
      '| Lightspeed | lightspeedhq.com | a \\| pipe |',
      '| Empty |  | x |', '',
      'After the table.',
    ].join('\n');
    const html = markdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Competitor</th>');
    expect(htmlToMarkdown(html)).toBe(md);
  });

  it('turns TipTap table HTML (paragraphs in cells, colwidth) into a GFM table', () => {
    const html = '<table style="min-width: 75px"><colgroup><col><col></colgroup><tbody>'
      + '<tr><th colspan="1" rowspan="1"><p>Plan</p></th><th colspan="1" rowspan="1"><p>Price</p></th></tr>'
      + '<tr><td colspan="1" rowspan="1"><p><strong>Starter</strong></p></td><td colspan="1" rowspan="1"><p>€49</p><p>per month</p></td></tr>'
      + '<tr><td colspan="1" rowspan="1"><p></p></td><td colspan="1" rowspan="1"><p>x|y</p></td></tr>'
      + '</tbody></table><p>Next</p>';
    expect(htmlToMarkdown(html)).toBe('| Plan | Price |\n| --- | --- |\n| **Starter** | €49<br>per month |\n|  | x\\|y |\n\nNext');
    // And back: the <br> stays a line break inside the cell.
    expect(markdownToHtml('| Plan | Price |\n| --- | --- |\n| **Starter** | €49<br>per month |')).toContain('<td>€49<br>per month</td>');
  });

  it('a table without a header row still gets one (markdown needs it)', () => {
    const html = '<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>';
    expect(htmlToMarkdown(html)).toBe('| a | b |\n| --- | --- |\n| c | d |');
  });
});

describe('@Agent in a document', () => {
  function docLlm(write: { markdown: string; mode?: string }, research = false) {
    const bodies: any[] = [];
    let i = 0;
    const handler = (body: any) => {
      bodies.push(body);
      i++;
      const call = (name: string, args: unknown) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const message = research && i === 1 ? call('web_search', { query: 'tillr pricing' }) : call('write', { ...write, note: 'Added it.' });
      return Response.json({ choices: [{ message }], usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.001 } });
    };
    return { bodies, handler };
  }

  it('returns markdown to insert, with the doc, cursor and hub as context; researches when needed', async () => {
    const llm = docLlm({ markdown: '## Pricing\n\n| Plan | Price |\n| --- | --- |\n| Starter | €49 |' }, true);
    const { e } = await setup({ llm: llm.handler });
    const folder = (await e.api('POST', '/api/knowledge/folders', { name: 'tillr.ie' })).body.data;
    await e.api('POST', '/api/knowledge/docs', { title: 'Ideal customer profile', content: 'Cafés in Ireland.' });
    const doc = (await e.api('POST', '/api/knowledge/docs', { title: 'Company overview', content: '## Intro\n\nTillr makes tills.\n\n## Team\n\n25 people.', folder_id: folder.id })).body.data;
    const r = await e.api('POST', `/api/knowledge/docs/${doc.id}/agent`, { instruction: 'research their pricing and add it here', before: '## Intro\n\nTillr makes tills.', after: '## Team\n\n25 people.' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ mode: 'insert', markdown: '## Pricing\n\n| Plan | Price |\n| --- | --- |\n| Starter | €49 |', applied: false, note: 'Added it.' });
    expect(r.body.data.steps).toContain('Searching the web for “tillr pricing”…');
    const sys = llm.bodies[0].messages[0].content as string;
    expect(sys).toContain('Document: "Company overview" in folder "tillr.ie"');
    expect(sys).toContain('25 people.');
    expect(sys).toContain('BEFORE CURSOR');
    expect(sys).toContain('Ideal customer profile');
    expect(llm.bodies[0].tools.map((t: any) => t.function.name)).toEqual(['web_search', 'fetch_page', 'read_doc', 'write']);
    expect(llm.bodies[1].messages.find((m: any) => m.role === 'tool').content).toContain('squareup.com');
    // Not saved unless apply=true.
    expect((await e.api('GET', `/api/knowledge/docs/${doc.id}`)).body.data.content).not.toContain('Pricing');
  });

  it('apply=true inserts at the cursor, replaces a selection, appends, or rewrites', async () => {
    const content = '## Intro\n\nTillr makes tills.\n\n## Team\n\n25 people.';
    const cases: [any, any, string][] = [
      [{ markdown: '## Pricing\n\n€49' }, { cursor: content.indexOf('tills.') + 6 }, '## Intro\n\nTillr makes tills.\n\n## Pricing\n\n€49\n\n## Team\n\n25 people.'],
      [{ markdown: 'Tillr builds **cloud POS** for cafés.' }, { selection: 'Tillr makes tills.' }, '## Intro\n\nTillr builds **cloud POS** for cafés.\n\n## Team\n\n25 people.'],
      [{ markdown: '## Next steps\n\n- Call' }, { mode: 'append' }, `${content}\n\n## Next steps\n\n- Call`],
      [{ markdown: '## New\n\nAll new.' }, { mode: 'rewrite' }, '## New\n\nAll new.'],
    ];
    for (const [write, extra, want] of cases) {
      const llm = docLlm(write);
      const { e } = await setup({ llm: llm.handler });
      const doc = (await e.api('POST', '/api/knowledge/docs', { title: 'Doc', content })).body.data;
      const r = await e.api('POST', `/api/knowledge/docs/${doc.id}/agent`, { instruction: 'do it', apply: true, ...extra });
      expect(r.status).toBe(200);
      expect(r.body.data.doc.content).toBe(want);
      if (extra.selection) expect(r.body.data.mode).toBe('replace');
      await env!.close(); env = null;
    }
  });

  it('a stale selection is not replaced (409); other workspaces\' docs are not reachable; no key is a clear 400', async () => {
    const { e } = await setup({ llm: docLlm({ markdown: 'x', mode: 'replace' }).handler });
    const doc = (await e.api('POST', '/api/knowledge/docs', { title: 'Doc', content: 'Hello.' })).body.data;
    const r = await e.api('POST', `/api/knowledge/docs/${doc.id}/agent`, { instruction: 'fix', selection: 'Gone text', apply: true });
    expect(r.status).toBe(409);
    expect((await e.api('GET', `/api/knowledge/docs/${doc.id}`)).body.data.content).toBe('Hello.');

    const other = e.ctx.db.insert('workspaces', { name: 'Other' });
    const foreign = e.ctx.db.insert('knowledge_docs', { workspace_id: other, title: 'Secret', content: 's', position: 0, created_by: 'user', created_at: 'x', updated_at: 'x' });
    expect((await e.api('POST', `/api/knowledge/docs/${foreign}/agent`, { instruction: 'expand' })).status).toBe(404);

    e.ctx.gtm!.settings.set('OPENROUTER_API_KEY', '');
    const noKey = await e.api('POST', `/api/knowledge/docs/${doc.id}/agent`, { instruction: 'expand' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.message).toContain('OPENROUTER_API_KEY');
  });

  it('streams steps and the result as server-sent events', async () => {
    const { e } = await setup({ llm: docLlm({ markdown: 'More text.' }, true).handler });
    const doc = (await e.api('POST', '/api/knowledge/docs', { title: 'Doc', content: 'Hello.' })).body.data;
    const r = await e.api('POST', `/api/knowledge/docs/${doc.id}/agent`, { instruction: 'expand', stream: true });
    const events = String(r.body).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(events.filter((x) => x.type === 'step').map((x) => x.label)).toContain('Searching the web for “tillr pricing”…');
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { markdown: 'More text.', mode: 'insert' } });
  });

  it('infers the placement from the instruction', () => {
    expect(inferMode('rewrite the whole document in a friendlier tone', false)).toBe('rewrite');
    expect(inferMode('shorten this', true)).toBe('replace');
    expect(inferMode('add a section on pricing', false)).toBe('append');
    expect(inferMode('expand this section with examples', false)).toBe(null);
    expect(applyEdit('a', { markdown: 'b', mode: 'insert' })).toBe('a\n\nb');
    expect(applyEdit('a\n\nc', { markdown: 'b', mode: 'insert', cursor: 0 })).toBe('b\n\na\n\nc');
  });
});
