import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

// Tables → Leads (in a lead list) → Campaign, plus row add/delete and CSV export.
let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

async function settle(tableId: number) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = env.ctx.gtm!.engine.stats(tableId);
    if (!s.pending && !s.running && i > 5) return;
  }
  throw new Error('engine did not settle');
}

async function table(rows: Record<string, string>[]) {
  const t = (await env.api('POST', '/api/gtm/tables', { name: 'Dublin cafés' })).body;
  const ids = (await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows })).body.ids as number[];
  return { tableId: t.id as number, ids };
}

describe('table → leads → campaign', () => {
  it('sends chosen rows to a lead list, then the list joins a campaign, without duplicates', async () => {
    const { tableId, ids } = await table([
      { Email: 'ann@cafe.test', 'First name': 'Ann', Company: 'Cafe A' },
      { Email: 'bob@cafe.test', 'First name': 'Bob', Company: 'Cafe B' },
      { Email: 'cat@cafe.test', 'First name': 'Cat', Company: 'Cafe C' },
    ]);
    const list = (await env.api('POST', '/api/lead-lists', { name: 'Dublin cafés' })).body.data;
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: '→ Leads: Dublin cafés', type: 'action', config: { kind: 'outreach_update_lead', email: '{{Email}}', firstName: '{{First name}}', company: '{{Company}}', listId: list.id, campaignId: null } })).body.id;
    // Only the selected rows.
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], rowIds: [ids[0], ids[2]], force: true });
    await settle(tableId);
    const inList = env.ctx.db.all('SELECT email, first_name, company FROM leads WHERE lead_list_id = ? ORDER BY email', [list.id]);
    expect(inList).toEqual([{ email: 'ann@cafe.test', first_name: 'Ann', company: 'Cafe A' }, { email: 'cat@cafe.test', first_name: 'Cat', company: 'Cafe C' }]);

    // Sending again (all rows) updates instead of duplicating.
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col], force: true });
    await settle(tableId);
    expect(env.ctx.db.get('SELECT COUNT(*) AS n FROM leads').n).toBe(3);

    const c = (await env.api('POST', '/api/campaigns', { name: 'Cafés Q4' })).body.data;
    const attached = (await env.api('POST', `/api/campaigns/${c.id}/leads/attach-lead-list`, { lead_list_id: list.id })).body.data.attached;
    expect(attached).toBe(3);
  });

  it('sends rows straight to a campaign and reports per row', async () => {
    const { tableId, ids } = await table([{ Email: 'dan@cafe.test' }, { Email: 'not-an-email' }]);
    const c = (await env.api('POST', '/api/campaigns', { name: 'Direct' })).body.data;
    const col = (await env.api('POST', `/api/gtm/tables/${tableId}/columns`, { name: '→ Direct', type: 'action', config: { kind: 'outreach_campaign', email: '{{Email}}', campaignId: c.id } })).body.id;
    await env.api('POST', `/api/gtm/tables/${tableId}/run`, { columnIds: [col] });
    await settle(tableId);
    const cells = (await env.api('GET', `/api/gtm/tables/${tableId}`)).body.rows.map((r: any) => r.cells[col]);
    expect(cells[0].value.value).toBe('Added to Direct');
    expect(cells[1].status).toBe('error');
    expect(env.ctx.db.get('SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ?', [c.id]).n).toBe(1);
    expect(ids).toHaveLength(2);
  });
});

describe('rows and export', () => {
  it('adds and deletes rows, and exports chosen rows in the order given', async () => {
    const { tableId, ids } = await table([{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }]);
    await env.api('POST', `/api/gtm/tables/${tableId}/rows`, { count: 1 });
    expect((await env.api('GET', `/api/gtm/tables/${tableId}`)).body.rows).toHaveLength(4);
    await env.api('DELETE', `/api/gtm/tables/${tableId}/rows`, { ids: [ids[1]] });
    expect((await env.api('GET', `/api/gtm/tables/${tableId}`)).body.rows).toHaveLength(3);

    const all = await env.api('GET', `/api/gtm/tables/${tableId}/export.csv`);
    expect(String(all.body).trim().split(/\r?\n/)).toEqual(['Name', 'A', 'C']); // the blank row trims away
    const some = await env.api('POST', `/api/gtm/tables/${tableId}/export.csv`, { ids: [ids[2], ids[0], ids[1]] }); // deleted id is ignored
    expect(String(some.body).trim().split(/\r?\n/)).toEqual(['Name', 'C', 'A']);
  });
});
