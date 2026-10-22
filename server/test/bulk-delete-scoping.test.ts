import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

const START = new Date('2026-10-12T14:00:00Z');

let env: TestEnv;
beforeEach(async () => { env = await makeEnv({ now: START }); });
afterEach(() => env.close());

const db = () => env.ctx.db;

/**
 * Bulk lead delete nulled the tag links with an unscoped
 * `DELETE FROM taggables WHERE taggable_id IN (...)`: the lead rows themselves
 * were workspace-scoped, but the taggables wipe was not. Passing ids owned by
 * ANOTHER workspace deleted nothing from `leads` and silently untagged that
 * workspace's leads. Tags of our own leads must survive only when the lead
 * survives; other tenants' rows must never be touched.
 */
describe('bulk lead delete tenant scoping', async () => {
  it('never deletes tag links belonging to another workspace', async () => {
    // Second workspace with a lead and a tag, created directly in the DB.
    const ws2 = db().insert('workspaces', { name: 'Other Co' });
    const otherLead = db().insert('leads', { workspace_id: ws2, email: 'other@other.test' });
    const otherTag = db().insert('tags', { workspace_id: ws2, name: 'hot' });
    db().run('INSERT INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)', [otherTag, 'lead', otherLead]);

    // Our workspace's lead, also tagged.
    const mine = (await env.api('POST', '/api/leads', { email: 'mine@bear.test' })).body.data;
    const myTag = (await env.api('POST', '/api/tags', { name: 'vip' })).body.data;
    await env.api('POST', '/api/tags/attach-to-leads', { tag_ids: [myTag.id], lead_ids: [mine.id] });

    // Bulk delete: one of ours + one of theirs.
    const res = await env.api('DELETE', '/api/leads/bulk', { lead_ids: [mine.id, otherLead] });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1); // only ours went

    expect(db().get('SELECT 1 x FROM leads WHERE id = ?', [mine.id])).toBeUndefined();
    expect(db().get('SELECT 1 x FROM taggables WHERE taggable_type = ? AND taggable_id = ?', ['lead', mine.id])).toBeUndefined();
    // The other workspace's lead and its tag link are untouched.
    expect(db().get('SELECT 1 x FROM leads WHERE id = ?', [otherLead])).toBeTruthy();
    expect(db().get('SELECT 1 x FROM taggables WHERE taggable_type = ? AND taggable_id = ?', ['lead', otherLead])).toBeTruthy();
  });

  it('bulk status update skips leads owned by another workspace', async () => {
    const ws2 = db().insert('workspaces', { name: 'Other Co' });
    const otherLead = db().insert('leads', { workspace_id: ws2, email: 'other2@other.test' });
    const mine = (await env.api('POST', '/api/leads', { email: 'mine2@bear.test' })).body.data;

    const res = await env.api('PATCH', '/api/leads/bulk-update-status', { lead_ids: [mine.id, otherLead], status: 'verified' });
    expect(res.status).toBe(200);
    expect(db().get<Record<string, unknown>>('SELECT status FROM leads WHERE id = ?', [mine.id])!.status).toBe('verified');
    expect(db().get<Record<string, unknown>>('SELECT status FROM leads WHERE id = ?', [otherLead])!.status).toBe('unverified');
  });
});
