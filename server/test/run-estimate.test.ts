import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { creditsPerCall } from '../src/gtm/engine/estimate.ts';
import { useCredits } from '../src/gtm/providers/credits.ts';

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

/** A people table with names + domains (so auto-run cells really ran) and a work-email column. */
async function emailTable(rows: number) {
  env = await makeEnv();
  const t = await env.api('POST', '/api/gtm/tables', { name: 'People', template: 'blank' });
  const id = t.body.id;
  const csv = ['Full name,Company domain', ...Array.from({ length: rows }, (_, i) => `Person ${i},acme${i}.test`)].join('\n');
  await env.api('POST', `/api/gtm/tables/${id}/import/csv`, { csv });
  const col = await env.api('POST', `/api/gtm/tables/${id}/columns`, { name: 'Work email', type: 'enrich', config: { kind: 'work_email', inputs: { fullName: '{{Full name}}', domain: '{{Company domain}}' } } });
  const ai = await env.api('POST', `/api/gtm/tables/${id}/columns`, { name: 'Research', type: 'ai', config: { prompt: 'About {{Company domain}}' } });
  return { id, col: col.body.id as number, ai: ai.body.id as number };
}

describe('run estimate', () => {
  it('parses catalog cost labels', () => {
    expect(creditsPerCall('1 credit')).toBe(1);
    expect(creditsPerCall('0.5 credit')).toBe(0.5);
    expect(creditsPerCall('1–2 credits')).toBe(2);
    expect(creditsPerCall('1 person credit')).toBe(1);
    expect(creditsPerCall('free (search)')).toBe(0);
    expect(creditsPerCall('~$0.0012')).toBeNull();
  });

  it('counts cells, AI tasks and worst-case credits per vendor against the monthly budget', async () => {
    const t = await emailTable(120);
    const e = env!;
    const free = await e.api('POST', `/api/gtm/tables/${t.id}/run/estimate`, {});
    expect(free.status).toBe(200);
    expect(free.body).toMatchObject({ cells: 240, aiCalls: 120, paidCells: 0, vendors: [] });
    expect(free.body.summary).toContain('Only free sources');

    e.ctx.gtm!.settings.set('APOLLO_API_KEY', 'a');
    e.ctx.gtm!.settings.set('HUNTER_API_KEY', 'h');
    e.ctx.gtm!.settings.set('ICYPEAS_API_KEY', 'i');
    useCredits(e.ctx.db, 'hunter', 20); // 30 of the 50 free Hunter credits left
    const r = await e.api('POST', `/api/gtm/tables/${t.id}/run/estimate`, { columnIds: [t.col] });
    expect(r.body).toMatchObject({ cells: 120, aiCalls: 0, paidCells: 120 });
    const by = Object.fromEntries(r.body.vendors.map((v: any) => [v.id, v]));
    expect(by.apollo).toMatchObject({ label: 'Apollo', calls: 120, credits: 120, budget: 100, used: 0, remaining: 100, exceeds: true });
    expect(by.hunter).toMatchObject({ credits: 120, used: 20, remaining: 30, exceeds: true });
    expect(by.icypeas).toMatchObject({ calls: 120, credits: null });
    expect(r.body.columns[0]).toMatchObject({ id: t.col, cells: 120, kind: 'work_email' });
    expect(r.body.summary).toContain('Apollo up to 120 credits — only 100 of 100 left this month');
    expect(r.body.summary).toContain('Free steps run first');

    // Selected rows only, and a column's own waterfall order (Hunter dropped).
    await e.api('PATCH', `/api/gtm/columns/${t.col}`, { config: { kind: 'work_email', providers: ['free_finder', 'apollo'], inputs: { fullName: '{{Full name}}', domain: '{{Company domain}}' } } });
    const rows = (await e.api('GET', `/api/gtm/tables/${t.id}`)).body.rows.slice(0, 5).map((x: any) => x.id);
    const few = await e.api('POST', `/api/gtm/tables/${t.id}/run/estimate`, { columnIds: [t.col], rowIds: [...rows, 999_999] });
    expect(few.body.vendors).toEqual([expect.objectContaining({ id: 'apollo', credits: 5, exceeds: false })]);
  });

  it('skips cells that already ran unless forced, matching what run queues', async () => {
    const t = await emailTable(3);
    const e = env!;
    const rows = (await e.api('GET', `/api/gtm/tables/${t.id}`)).body.rows.map((x: any) => x.id);
    e.ctx.gtm!.store.setStatus(rows[0], t.ai, 'done');
    const est = await e.api('POST', `/api/gtm/tables/${t.id}/run/estimate`, { columnIds: [t.ai] });
    expect(est.body.cells).toBe(2);
    expect((await e.api('POST', `/api/gtm/tables/${t.id}/run/estimate`, { columnIds: [t.ai], force: true })).body.cells).toBe(3);
    // Estimating queues nothing.
    expect(e.ctx.db.get('SELECT COUNT(*) n FROM gtm_cells WHERE column_id = ? AND status = ?', [t.ai, 'queued']).n).toBe(0);
    expect((await e.api('POST', `/api/gtm/tables/${t.id}/stop`, {})).body.cancelled).toBe(0);
  });

  it('404s for another workspace\'s table', async () => {
    env = await makeEnv();
    expect((await env.api('POST', '/api/gtm/tables/999/run/estimate', {})).status).toBe(404);
  });
});
