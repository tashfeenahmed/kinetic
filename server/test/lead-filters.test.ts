import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { providerFromMx, refreshEmailProviders, setMxResolver } from '../src/engine/emailProviders.ts';
import { resolveWhen } from '../src/routes/leadFilters.ts';

const NOW = new Date('2026-10-12T14:00:00Z');
let env: TestEnv;

beforeEach(async () => {
  env = await makeEnv({ now: NOW });
});
afterEach(() => env.close());

const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
let msg = 0;

/** Records a sent email (as the sequencer would) and returns its id. */
function sent(leadId: number, o: { opens?: number; clicks?: number; at?: string; senderId?: number | null; campaignId?: number | null; bounced?: number } = {}) {
  const ws = env.ctx.db.get('SELECT workspace_id, email FROM leads WHERE id = ?', [leadId]);
  return env.ctx.db.insert('sent_emails', {
    workspace_id: ws.workspace_id, kind: 'campaign', lead_id: leadId, campaign_id: o.campaignId ?? null, sender_email_id: o.senderId ?? null,
    message_id: `m${++msg}@x`, to_email: ws.email, subject: 's', opens: o.opens ?? 0, clicks: o.clicks ?? 0, bounced: o.bounced ?? 0, sent_at: o.at ?? days(1),
    tracking_token: `tok${msg}`,
  });
}
function replied(leadId: number, label: string, o: { automated?: number; at?: string } = {}) {
  const ws = env.ctx.db.get('SELECT workspace_id, email FROM leads WHERE id = ?', [leadId]);
  return env.ctx.db.insert('replies', {
    workspace_id: ws.workspace_id, lead_id: leadId, message_id: `r${++msg}@x`, from_email: ws.email, subject: 'Re', body_text: 'hi',
    category: ['interested', 'not_interested', 'unsubscribe', 'auto_reply'].includes(label) ? label : 'reply', label, automated: o.automated ?? 0, received_at: o.at ?? days(1),
  });
}

async function emails(query: Record<string, string | number | boolean>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const r = await env.api('GET', `/api/leads?per_page=500&${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.data as any[]).map((l) => l.email).sort();
}

describe('lead filters by email stats', () => {
  it('keeps lead_stats current through sends, opens, clicks, replies and deletes', async () => {
    const lead = (await env.api('POST', '/api/leads', { email: 'jane@acme.com' })).body.data;
    const s1 = sent(lead.id, { at: days(10) });
    sent(lead.id, { at: days(3), opens: 2 });
    // A tracking pixel hit updates opens -> stats + last opened.
    env.clock.now = new Date(NOW.getTime() + 60_000);
    await env.app.inject({ method: 'GET', url: `/t/o/tok${msg}`, headers: { 'user-agent': 'Mozilla/5.0' } });
    env.ctx.db.run('UPDATE sent_emails SET clicks = clicks + 1 WHERE id = ?', [s1]);
    replied(lead.id, 'interested');
    replied(lead.id, 'auto_reply', { automated: 1 });
    let st = env.ctx.db.get('SELECT * FROM lead_stats WHERE lead_id = ?', [lead.id]);
    expect(st).toMatchObject({ emails_sent: 2, opens: 3, clicks: 1, replies: 1, last_sent_at: days(3) });
    expect(st.last_opened_at).toBeTruthy();
    expect(st.last_clicked_at).toBeTruthy();
    const got = (await env.api('GET', `/api/leads/${lead.id}`)).body.data.email_stats;
    expect(got).toMatchObject({ emails_sent: 2, opens: 3, clicks: 1, replies: 1 });

    env.ctx.db.run('DELETE FROM sent_emails WHERE id = ?', [s1]);
    env.ctx.db.run(`UPDATE replies SET automated = 1 WHERE label = 'interested'`);
    st = env.ctx.db.get('SELECT * FROM lead_stats WHERE lead_id = ?', [lead.id]);
    expect(st).toMatchObject({ emails_sent: 1, opens: 3, clicks: 0, replies: 0 });
    await env.api('DELETE', `/api/leads/${lead.id}`);
    expect(env.ctx.db.get('SELECT COUNT(*) n FROM lead_stats').n).toBe(0);
  });

  it('returns the right sets for each filter and preset', async () => {
    const mk = async (email: string) => (await env.api('POST', '/api/leads', { email })).body.data.id as number;
    const senderA = env.ctx.db.insert('sender_emails', { workspace_id: 1, name: 'A', email: 'a@us.test' });
    const senderB = env.ctx.db.insert('sender_emails', { workspace_id: 1, name: 'B', email: 'b@us.test' });
    const camp = (await env.api('POST', '/api/campaigns', { name: 'C1' })).body.data.id;
    const camp2 = (await env.api('POST', '/api/campaigns', { name: 'C2' })).body.data.id;

    const opener = await mk('opener@gmail.com');      // opened 4x, no reply, contacted 20d ago
    sent(opener, { opens: 1, at: days(30), senderId: senderA, campaignId: camp });
    sent(opener, { opens: 3, at: days(20), senderId: senderA, campaignId: camp });
    const clicker = await mk('clicker@corp.test');    // clicked, no reply
    sent(clicker, { clicks: 2, opens: 1, at: days(2), senderId: senderB });
    const ghost = await mk('ghost@corp.test');        // sent, never opened
    sent(ghost, { at: days(5), senderId: senderB });
    const fan = await mk('fan@corp.test');            // opened and replied interested
    sent(fan, { opens: 5, at: days(4), senderId: senderA, campaignId: camp2 });
    replied(fan, 'meeting_request');
    const bounce = await mk('bounce@gone.test');
    sent(bounce, { bounced: 1, at: days(6) });
    const unsub = await mk('unsub@corp.test');
    sent(unsub, { at: days(8) });
    await env.api('PATCH', `/api/leads/${unsub}/unsubscribe`);
    await mk('fresh@new.test');                       // never contacted
    for (const [cid, ids] of [[camp, [opener]], [camp2, [fan]]] as const) await env.api('POST', `/api/campaigns/${cid}/leads/attach-leads`, { lead_ids: ids });

    expect(await emails({ opens_min: 3, replied: false })).toEqual(['opener@gmail.com']);
    expect(await emails({ clicks_min: 1, replied: false })).toEqual(['clicker@corp.test']);
    expect(await emails({ sent_min: 1, opens_max: 0 })).toEqual(['bounce@gone.test', 'ghost@corp.test', 'unsub@corp.test']);
    expect(await emails({ bounced: true })).toEqual(['bounce@gone.test']);
    expect(await emails({ unsubscribed: true })).toEqual(['unsub@corp.test']);
    expect(await emails({ reply_category: 'interested,meeting_request' })).toEqual(['fan@corp.test']);
    expect(await emails({ replied: true })).toEqual(['fan@corp.test']);
    expect(await emails({ sent_max: 0 })).toEqual(['fresh@new.test']);
    expect(await emails({ last_contacted_before: '14d' })).toEqual(['opener@gmail.com']);
    expect(await emails({ last_contacted_after: '5d' })).toEqual(['clicker@corp.test', 'fan@corp.test', 'ghost@corp.test']);
    expect(await emails({ last_contacted_after: days(6).slice(0, 10), last_contacted_before: days(3).slice(0, 10) })).toEqual(['bounce@gone.test', 'fan@corp.test', 'ghost@corp.test']);
    expect(await emails({ in_campaign_ids: `${camp},${camp2}` })).toEqual(['fan@corp.test', 'opener@gmail.com']);
    expect(await emails({ not_in_campaign_ids: camp, sent_min: 1, opens_min: 1 })).toEqual(['clicker@corp.test', 'fan@corp.test']);
    expect(await emails({ without_campaign: true, opens_min: 1 })).toEqual(['clicker@corp.test']);
    expect(await emails({ sender_email_ids: senderB })).toEqual(['clicker@corp.test', 'ghost@corp.test']);
    expect(await emails({ opens_min: 2, opens_max: 4, search: 'gmail' })).toEqual(['opener@gmail.com']);
    expect((await env.api('GET', '/api/leads?opens_min=x')).status).toBe(422);

    // Sorting by stats
    const sorted = (await env.api('GET', '/api/leads?sort=opens&per_page=3')).body.data.map((l: any) => l.email);
    expect(sorted).toEqual(['fan@corp.test', 'opener@gmail.com', 'clicker@corp.test']);

    // Presets are plain filters.
    const presets = (await env.api('GET', '/api/leads/filter-presets')).body.data;
    const p = (id: string) => Object.fromEntries(Object.entries(presets.find((x: any) => x.id === id).filters).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])) as any;
    expect(await emails(p('opened_no_reply'))).toEqual(['opener@gmail.com']);
    expect(await emails(p('interested'))).toEqual(['fan@corp.test']);
    expect(await emails(p('never_opened'))).toEqual(['bounce@gone.test', 'ghost@corp.test', 'unsub@corp.test']);

    // Email provider via (mocked) MX lookups.
    setMxResolver({
      resolveMx: async (d: string) => {
        if (d === 'gmail.com') return [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }];
        if (d === 'corp.test') return [{ exchange: 'corp-test.mail.protection.outlook.com', priority: 0 }];
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
    });
    expect((await refreshEmailProviders(env.ctx)).resolved).toBe(4);
    expect(await emails({ email_provider: 'google' })).toEqual(['opener@gmail.com']);
    expect(await emails({ email_provider: 'microsoft', replied: false })).toEqual(['clicker@corp.test', 'ghost@corp.test', 'unsub@corp.test']);
    expect(await emails({ email_provider: 'none' })).toEqual(['bounce@gone.test', 'fresh@new.test']);
    const providers = (await env.api('GET', '/api/leads/email-providers')).body.data;
    expect(providers.find((x: any) => x.provider === 'microsoft').leads).toBe(4);

    // ids, bulk actions, CSV export and saved views use the same filters.
    const ids = (await env.api('GET', '/api/leads/ids?opens_min=1')).body.data;
    expect(ids.total).toBe(3);
    const tag = (await env.api('POST', '/api/tags', { name: 'Warm' })).body.data;
    const tagged = await env.api('POST', '/api/leads/bulk-by-filter', { filters: { opens_min: 1, replied: false }, action: 'attach_tags', tag_ids: [tag.id] });
    expect(tagged.body.data.matched).toBe(2);
    expect(await emails({ tag_id: tag.id })).toEqual(['clicker@corp.test', 'opener@gmail.com']);
    const added = await env.api('POST', '/api/leads/bulk-by-filter', { filters: { clicks_min: 1 }, action: 'add_to_campaign', campaign_id: camp2 });
    expect(added.body.data).toEqual({ matched: 1, attached: 1 });

    const csv = await env.app.inject({ method: 'GET', url: '/api/leads/export?opens_min=3', headers: { authorization: (await tokenHeader()) } });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toContain('email,first_name');
    expect(lines).toHaveLength(3);
    expect(csv.body).toContain('opener@gmail.com');

    const view = await env.api('POST', '/api/lead-views', { name: 'Hot, no reply', filters: { opens_min: 3, replied: false } });
    expect(view.status).toBe(200);
    expect((await env.api('GET', '/api/lead-views')).body.data[0]).toMatchObject({ name: 'Hot, no reply', filters: { opens_min: 3, replied: false } });
    expect((await env.api('POST', '/api/lead-views', { name: 'Bad', filters: { opens_min: 'lots' } })).status).toBe(422);
    expect((await env.api('PUT', `/api/lead-views/${view.body.data.id}`, { name: 'Renamed' })).body.data.name).toBe('Renamed');
    expect((await env.api('DELETE', `/api/lead-views/${view.body.data.id}`)).status).toBe(200);
  });

  it('classifies MX hosts and relative dates', () => {
    expect(providerFromMx(['aspmx.l.google.com'])).toBe('google');
    expect(providerFromMx(['acme-com.mail.protection.outlook.com'])).toBe('microsoft');
    expect(providerFromMx(['mx0a-001.pphosted.com'])).toBe('proofpoint');
    expect(providerFromMx(['mx.acme.com'])).toBe('other');
    expect(providerFromMx([])).toBe('none');
    expect(resolveWhen('14d', NOW)).toBe(days(14));
    expect(resolveWhen('2026-10-01', NOW)).toBe('2026-10-01T00:00:00.000Z');
  });

  it('filters 100k leads quickly', async () => {
    const { db } = env.ctx;
    const N = 100_000;
    const rnd = mulberry32(42);
    const expected = { hotNoReply: 0, neverOpened: 0, recentClick: 0 };
    db.tx(() => {
      const insLead = db.raw.prepare('INSERT INTO leads (workspace_id, email, first_name) VALUES (1, ?, ?)');
      const insSent = db.raw.prepare(`INSERT INTO sent_emails (workspace_id, kind, lead_id, message_id, to_email, subject, opens, clicks, sent_at) VALUES (1, 'campaign', ?, ?, ?, 's', ?, ?, ?)`);
      const insReply = db.raw.prepare(`INSERT INTO replies (workspace_id, lead_id, message_id, from_email, category, label, received_at) VALUES (1, ?, ?, ?, 'reply', ?, ?)`);
      for (let i = 0; i < N; i++) {
        const email = `p${i}@d${i % 5000}.test`;
        const id = Number(insLead.run(email, `P${i}`).lastInsertRowid);
        const sends = Math.floor(rnd() * 4); // 0..3 emails
        let opens = 0; let clicks = 0; let lastSent = '';
        for (let k = 0; k < sends; k++) {
          const o = rnd() < 0.4 ? Math.floor(rnd() * 3) : 0;
          const c = rnd() < 0.05 ? 1 : 0;
          const at = days(Math.floor(rnd() * 60));
          opens += o; clicks += c; if (at > lastSent) lastSent = at;
          insSent.run(id, `b${i}-${k}@x`, email, o, c, at);
        }
        const didReply = sends > 0 && rnd() < 0.05;
        if (didReply) insReply.run(id, `rb${i}@x`, email, rnd() < 0.3 ? 'interested' : 'more_info', days(1));
        if (opens >= 3 && !didReply) expected.hotNoReply++;
        if (sends > 0 && opens === 0) expected.neverOpened++;
        if (clicks > 0 && lastSent >= days(14)) expected.recentClick++;
      }
    });
    expect(db.get('SELECT COUNT(*) n FROM lead_stats').n).toBe(N);

    const time = async (qs: string) => {
      const t = performance.now();
      const r = await env.api('GET', `/api/leads?per_page=50&${qs}`);
      const ms = performance.now() - t;
      expect(r.status).toBe(200);
      return { total: r.body.meta.total as number, ms };
    };
    const a = await time('opens_min=3&replied=false');
    expect(a.total).toBe(expected.hotNoReply);
    const b = await time('sent_min=1&opens_max=0');
    expect(b.total).toBe(expected.neverOpened);
    const c = await time('clicks_min=1&last_contacted_after=14d');
    expect(c.total).toBe(expected.recentClick);
    const d = await time('reply_category=interested&sort=opens');
    const e = await time('opens_min=1&not_in_campaign_ids=1&search=p12');
    const f = await time('replied=false&sent_min=2&last_contacted_before=7d&email_provider=unknown');
    const slowest = Math.max(a.ms, b.ms, c.ms, d.ms, e.ms, f.ms);
    console.log(`100k leads: filter queries took ${[a, b, c, d, e, f].map((x) => `${x.ms.toFixed(0)}ms`).join(', ')}`);
    // ~130ms alone; the margin covers the rest of the suite running in parallel. A missing index is seconds.
    expect(slowest).toBeLessThan(4000);
  }, 120_000);
});

async function tokenHeader() {
  // The API helper's token isn't exposed; mint another one for a raw inject.
  const r = await env.api('POST', '/api/api-tokens', { name: 'csv' });
  return `Bearer ${r.body.data.plain_text_token}`;
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
