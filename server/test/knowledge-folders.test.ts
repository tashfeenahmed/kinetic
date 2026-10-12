import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { agentServices } from '../src/agent/routes.ts';
import { classifyRoute } from '../src/agent/policy.ts';
import { knowledgeContext } from '../src/knowledge/store.ts';
import { createFolder } from '../src/knowledge/folders.ts';
import { createDoc } from '../src/knowledge/store.ts';

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

/** The sidebar tree as indented "F name" / "D title" lines, built from the two list endpoints. */
async function tree(e: TestEnv): Promise<string[]> {
  const folders = (await e.api('GET', '/api/knowledge/folders')).body.data as any[];
  const docs = (await e.api('GET', '/api/knowledge/docs')).body.data as any[];
  const out: string[] = [];
  const visit = (parent: number | null, depth: number) => {
    const kids = [
      ...folders.filter((f) => f.parent_id === parent).map((f) => ({ k: 'F', id: f.id, label: f.name, pos: f.position })),
      ...docs.filter((d) => d.folder_id === parent).map((d) => ({ k: 'D', id: d.id, label: d.title, pos: d.position })),
    ].sort((a, b) => a.pos - b.pos || (a.k === b.k ? (a.k === 'D' ? b.id - a.id : a.id - b.id) : a.k === 'F' ? -1 : 1));
    for (const c of kids) {
      out.push(`${'  '.repeat(depth)}${c.k} ${c.label}`);
      if (c.k === 'F') visit(c.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

const doc = async (e: TestEnv, title: string, extra: Record<string, unknown> = {}) => (await e.api('POST', '/api/knowledge/docs', { title, content: `About ${title}`, ...extra })).body.data;
const folder = async (e: TestEnv, name: string, parent_id?: number) => (await e.api('POST', '/api/knowledge/folders', { name, parent_id })).body.data;

describe('knowledge folders', () => {
  it('creates, renames, nests and lists folders with paths; docs can be filed on create', async () => {
    const e = await setup();
    const company = await folder(e, 'Company');
    expect(company).toMatchObject({ name: 'Company', parent_id: null, path: 'Company', doc_count: 0 });
    const research = await folder(e, 'Research', company.id);
    expect(research.path).toBe('Company / Research');
    const deep = await folder(e, 'Deep', research.id);
    expect(deep.path).toBe('Company / Research / Deep');
    expect((await e.api('POST', '/api/knowledge/folders', { name: '  ' })).status).toBe(422);
    expect((await e.api('POST', '/api/knowledge/folders', { name: 'X', parent_id: 9999 })).status).toBe(404);

    const renamed = await e.api('PATCH', `/api/knowledge/folders/${company.id}`, { name: 'Acme' });
    expect(renamed.body.data.path).toBe('Acme');
    expect((await e.api('GET', '/api/knowledge/folders')).body.data.find((f: any) => f.id === deep.id).path).toBe('Acme / Research / Deep');

    const icp = await doc(e, 'ICP', { folder_id: research.id });
    expect(icp).toMatchObject({ folder_id: research.id, folder_path: 'Acme / Research' });
    // A folder path is created on the fly (mkdir -p), reusing existing levels case-insensitively.
    const tone = await doc(e, 'Tone', { folder: 'acme/Brand' });
    expect(tone.folder_path).toBe('Acme / Brand');
    await doc(e, 'Loose');
    expect((await e.api('POST', '/api/knowledge/docs', { title: 'x', folder_id: 9999 })).status).toBe(404);

    expect(await tree(e)).toEqual(['D Loose', 'F Acme', '  F Brand', '    D Tone', '  F Research', '    D ICP', '    F Deep']);
    expect((await e.api('GET', '/api/knowledge/folders')).body.data.find((f: any) => f.id === research.id).doc_count).toBe(1);

    // PATCH folder_id moves a doc to the top of a folder (null = top level).
    await e.api('PATCH', `/api/knowledge/docs/${icp.id}`, { folder_id: null });
    expect((await e.api('GET', `/api/knowledge/docs/${icp.id}`)).body.data).toMatchObject({ folder_id: null, folder_path: null });
    expect((await tree(e))[0]).toBe('D ICP');

    // Duplicates land right below the original, in the same folder.
    const dup = (await e.api('POST', `/api/knowledge/docs/${tone.id}/duplicate`)).body.data;
    expect(dup.folder_path).toBe('Acme / Brand');
    await doc(e, 'Voice', { folder_id: tone.folder_id });
    expect((await tree(e)).slice(2, 7)).toEqual(['F Acme', '  F Brand', '    D Voice', '    D Tone', '    D Tone (copy)']);
  });

  it('moves and reorders docs and folders in one call, including nested moves', async () => {
    const e = await setup();
    const a = await folder(e, 'A');
    const b = await folder(e, 'B');
    const d1 = await doc(e, 'One');
    const d2 = await doc(e, 'Two');
    const d3 = await doc(e, 'Three');
    expect(await tree(e)).toEqual(['D Three', 'D Two', 'D One', 'F B', 'F A']);

    // Two docs into A (at the end, in the given order).
    let r = await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d1.id }, { type: 'doc', id: d2.id }], folder_id: a.id });
    expect(r.status).toBe(200);
    expect(r.body.data.docs.find((d: any) => d.id === d1.id).folder_path).toBe('A');
    expect(await tree(e)).toEqual(['D Three', 'F B', 'F A', '  D One', '  D Two']);

    // Reorder inside A with before/after and index.
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d2.id }], folder_id: a.id, before: { type: 'doc', id: d1.id } });
    expect(await tree(e)).toEqual(['D Three', 'F B', 'F A', '  D Two', '  D One']);
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: a.id }], folder_id: null, index: 0 });
    expect(await tree(e)).toEqual(['F A', '  D Two', '  D One', 'D Three', 'F B']);
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d3.id }], folder_id: null, after: { type: 'folder', id: b.id } });
    expect(await tree(e)).toEqual(['F A', '  D Two', '  D One', 'F B', 'D Three']);

    // Folder into folder (and its contents come along), then a doc into the nested folder.
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: a.id }], folder_id: b.id });
    expect(await tree(e)).toEqual(['F B', '  F A', '    D Two', '    D One', 'D Three']);
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d3.id }], folder_id: a.id, index: 1 });
    expect(await tree(e)).toEqual(['F B', '  F A', '    D Two', '    D Three', '    D One']);
    expect((await e.api('GET', `/api/knowledge/docs/${d3.id}`)).body.data.folder_path).toBe('B / A');

    // Out again to the top level.
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: a.id }], folder_id: null, index: 0 });
    expect(await tree(e)).toEqual(['F A', '  D Two', '  D Three', '  D One', 'F B']);

    // Bad refs.
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d1.id }], folder_id: a.id, before: { type: 'folder', id: b.id } })).status).toBe(400);
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: 9999 }], folder_id: null })).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/move', { items: [], folder_id: null })).status).toBe(422);

    // The legacy reorder endpoint permutes docs within their folder and leaves folders in place.
    await e.api('POST', '/api/knowledge/docs/reorder', { ids: [d1.id, d3.id, d2.id] });
    expect(await tree(e)).toEqual(['F A', '  D One', '  D Three', '  D Two', 'F B']);
  });

  it('refuses to move a folder into itself or a descendant', async () => {
    const e = await setup();
    const a = await folder(e, 'A');
    const b = await folder(e, 'B', a.id);
    const c = await folder(e, 'C', b.id);
    for (const target of [a.id, b.id, c.id]) {
      const r = await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: a.id }], folder_id: target });
      expect(r.status).toBe(400);
      expect(r.body.message).toContain('cannot be moved into itself');
    }
    expect(await tree(e)).toEqual(['F A', '  F B', '    F C']);
    // A sibling move is fine.
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: c.id }], folder_id: a.id })).status).toBe(200);
    expect(await tree(e)).toEqual(['F A', '  F B', '  F C']);
  });

  it('deleting a folder moves its contents up a level, or deletes them', async () => {
    const e = await setup();
    const top = await folder(e, 'Top');
    const mid = await folder(e, 'Mid', top.id);
    const sub = await folder(e, 'Sub', mid.id);
    await doc(e, 'Above', { folder_id: top.id });
    await doc(e, 'In mid 1', { folder_id: mid.id });
    await doc(e, 'In mid 2', { folder_id: mid.id });
    await doc(e, 'In sub', { folder_id: sub.id });
    await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: (await doc(e, 'Below', { folder_id: top.id })).id }], folder_id: top.id });
    expect(await tree(e)).toEqual(['F Top', '  D Above', '  F Mid', '    D In mid 2', '    D In mid 1', '    F Sub', '      D In sub', '  D Below']);

    // Default: move up, in the folder's place.
    const r = await e.api('DELETE', `/api/knowledge/folders/${mid.id}`);
    expect(r.body).toEqual({ ok: true, deleted: { folders: 1, docs: 0 } });
    expect(await tree(e)).toEqual(['F Top', '  D Above', '  D In mid 2', '  D In mid 1', '  F Sub', '    D In sub', '  D Below']);

    // Delete contents: the folder, its subfolders and every doc in them.
    const d = await e.api('DELETE', `/api/knowledge/folders/${top.id}?contents=delete`);
    expect(d.body).toEqual({ ok: true, deleted: { folders: 2, docs: 5 } });
    expect(await tree(e)).toEqual([]);
    expect(e.ctx.db.get('SELECT COUNT(*) n FROM knowledge_docs')!.n).toBe(0);
    expect((await e.api('DELETE', `/api/knowledge/folders/${top.id}`)).status).toBe(404);
    expect((await e.api('DELETE', `/api/knowledge/folders/${sub.id}?contents=nope`)).status).toBe(422);
  });

  it('builds the context with folder paths, pinned first, then tree order', async () => {
    const e = await setup();
    const company = await folder(e, 'Company');
    const icp = await doc(e, 'ICP', { folder: 'Company / Targeting' });
    const tone = await doc(e, 'Tone', { folder_id: company.id });
    const loose = await doc(e, 'Notes');
    await e.api('PATCH', `/api/knowledge/docs/${tone.id}`, { pinned: true });
    const text = (await e.api('GET', '/api/knowledge/context')).body.data.text as string;
    expect(text).toBe([
      `### Company / Tone (doc #${tone.id})\nAbout Tone`,
      `### Notes (doc #${loose.id})\nAbout Notes`,
      `### Company / Targeting / ICP (doc #${icp.id})\nAbout ICP`,
    ].join('\n\n'));
    expect(knowledgeContext(e.ctx, wsOf(e))).toBe(text);
  });

  it('scopes folders and moves to the workspace', async () => {
    const e = await setup();
    const other = e.ctx.db.insert('workspaces', { name: 'Other' });
    const foreignFolder = createFolder(e.ctx.db, other, { name: 'Secret' });
    const foreignDoc = createDoc(e.ctx.db, other, { title: 'Hidden', content: 'x', folder_id: foreignFolder.id });
    const mine = await folder(e, 'Mine');
    const d = await doc(e, 'Mine doc');

    expect((await e.api('GET', '/api/knowledge/folders')).body.data.map((f: any) => f.name)).toEqual(['Mine']);
    expect((await e.api('PATCH', `/api/knowledge/folders/${foreignFolder.id}`, { name: 'x' })).status).toBe(404);
    expect((await e.api('DELETE', `/api/knowledge/folders/${foreignFolder.id}?contents=delete`)).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/folders', { name: 'x', parent_id: foreignFolder.id })).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: d.id }], folder_id: foreignFolder.id })).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'doc', id: foreignDoc.id }], folder_id: mine.id })).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/move', { items: [{ type: 'folder', id: foreignFolder.id }], folder_id: mine.id })).status).toBe(404);
    expect((await e.api('PATCH', `/api/knowledge/docs/${d.id}`, { folder_id: foreignFolder.id })).status).toBe(404);
    expect((await e.api('POST', '/api/knowledge/docs', { title: 'x', folder_id: foreignFolder.id })).status).toBe(404);
    // A folder path never resolves to another workspace's folder.
    expect((await doc(e, 'Y', { folder: 'Secret' })).folder_id).not.toBe(foreignFolder.id);
    expect(e.ctx.db.get('SELECT * FROM knowledge_docs WHERE id = ?', [foreignDoc.id])).toMatchObject({ workspace_id: other, folder_id: foreignFolder.id });
    expect(knowledgeContext(e.ctx, wsOf(e))).not.toContain('Hidden');
  });

  it('deleting a folder via the agent needs approval; creating and moving do not', () => {
    expect(classifyRoute('DELETE', '/api/knowledge/folders/3').kind).toBe('approve');
    expect(classifyRoute('POST', '/api/knowledge/folders').kind).toBe('allow');
    expect(classifyRoute('PATCH', '/api/knowledge/folders/3').kind).toBe('allow');
    expect(classifyRoute('POST', '/api/knowledge/move').kind).toBe('allow');
  });
});

describe('fill from website files the docs in a folder', () => {
  const html = `<html><head><title>Tillr | Cloud POS</title><meta name="description" content="Cloud POS for cafés"></head><body><p>Tillr runs tills.</p></body></html>`;
  const pages = { 'https://tillr.ie': html };
  const draft = { company: 'Tillr makes cloud POS.', offers: '## Tillr POS\n\n€49/mo', tone: 'Warm.', summary: 'POS.' };
  const llm = () => Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'submit', arguments: JSON.stringify(draft) } }] } }] });

  it('apply=true creates a folder named after the site; folder overrides; bulk takes a folder', async () => {
    const e = await setup(llm, pages);
    const r = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie' });
    expect(r.body.data).toMatchObject({ folder_name: 'tillr.ie', applied: false, folder: null });
    expect(await tree(e)).toEqual([]);

    const a = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie', apply: true });
    expect(a.body.data.folder).toMatchObject({ name: 'tillr.ie', path: 'tillr.ie', doc_count: 3 });
    expect(a.body.data.created.map((d: any) => d.folder_path)).toEqual(['tillr.ie', 'tillr.ie', 'tillr.ie']);
    expect(await tree(e)).toEqual(['F tillr.ie', '  D Company overview', '  D Products & offers', '  D Tone of voice']);

    // Nothing new to create -> no empty folder either.
    const again = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie', apply: true, folder: 'Company' });
    expect(again.body.data).toMatchObject({ created: [], folder: null });
    expect((await e.api('GET', '/api/knowledge/folders')).body.data.length).toBe(1);

    // The review step: the user renames the target folder, or picks an existing one.
    const b = await e.api('POST', '/api/knowledge/docs/bulk', { docs: [{ title: 'ICP', content: 'x' }], created_by: 'autofill', folder: 'Company' });
    expect(b.body.folder).toMatchObject({ name: 'Company', doc_count: 1 });
    const c = await e.api('POST', '/api/knowledge/docs/bulk', { docs: [{ title: 'Personas', content: 'y' }], folder_id: b.body.folder.id });
    expect(c.body.data[0].folder_path).toBe('Company');
    expect(await tree(e)).toEqual(['F Company', '  D Personas', '  D ICP', 'F tillr.ie', '  D Company overview', '  D Products & offers', '  D Tone of voice']);
  });

  it('apply=true honours a folder path', async () => {
    const e = await setup(llm, pages);
    const a = await e.api('POST', '/api/knowledge/autofill', { domain: 'tillr.ie', apply: true, folder: 'Company / Website' });
    expect(a.body.data.folder.path).toBe('Company / Website');
  });
});

describe('agent sees folders', () => {
  it('the knowledge tool lists folder paths and finds docs by path', async () => {
    let i = 0;
    const steps = [{ tool: 'knowledge', args: {} }, { tool: 'knowledge', args: { doc: 'Company / Tone' } }, { text: 'Done.' }];
    const bodies: any[] = [];
    const e = await setup((body) => {
      bodies.push(body);
      const s: any = steps[Math.min(i++, steps.length - 1)];
      const message = s.text ? { role: 'assistant', content: s.text } : { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
      return Response.json({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    });
    const f = await folder(e, 'Company');
    const tone = await doc(e, 'Tone', { folder_id: f.id });
    await doc(e, 'Tone', { folder: 'Archive' });
    const r = await e.api('POST', '/api/agent/sessions', { message: 'What folders do we have?' });
    await agentServices.get(e.app)!.idle(r.body.data.id);
    const s = (await e.api('GET', `/api/agent/sessions/${r.body.data.id}`)).body.data;
    const tools = s.messages.filter((m: any) => m.role === 'tool');
    expect(tools[0].content).toContain(`Folders (folder_id: path):\nfolder `);
    expect(tools[0].content).toContain(`folder ${f.id}: Company`);
    expect(tools[0].content).toContain(`#${tone.id} Company / Tone (`);
    expect(tools[1].content).toContain(`# Tone (doc #${tone.id}, in folder ${f.id} “Company”`);
    expect(bodies.at(-1).messages[0].content).toContain(`### Company / Tone (doc #${tone.id})`);
  });
});
