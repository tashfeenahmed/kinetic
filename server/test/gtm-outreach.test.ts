import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail, makeEnv, type TestEnv } from './helpers.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { processInbound } from '../src/engine/inbox.ts';
import { parseInbound } from '../src/mail/classify.ts';

// Monday 2026-10-12, 10:00 in New York (14:00Z)
const MONDAY_10AM_NY = new Date('2026-10-12T14:00:00Z');

let env: TestEnv;
let mail: FakeMail;
let posts: { url: string; body: any }[];

beforeEach(async () => {
  mail = new FakeMail();
  posts = [];
  env = await makeEnv({
    mail,
    now: MONDAY_10AM_NY,
    fetch: (async (url: string, init: any) => { posts.push({ url: String(url), body: init?.body }); return new Response('ok'); }) as any,
  });
});
afterEach(() => env.close());

/** Waits for the GTM engine queue (and deferred outreach refreshes) to drain. */
async function settle(tableId: number) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = env.ctx.gtm!.engine.stats(tableId);
    if (!s.pending && !s.running && i > 8) return;
  }
  throw new Error('GTM engine did not settle');
}
const cellOf = async (tableId: number, rowId: number, column: string) => {
  const t = (await env.api('GET', `/api/gtm/tables/${tableId}`)).body;
  const col = t.columns.find((c: any) => c.name === column);
  return t.rows.find((r: any) => r.id === rowId).cells[col.id];
};

async function campaignWithSender() {
  const sender = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex Morgan', email: 'alex@sender.test', password: 'pw', provider: 'google', daily_limit: 30 })).body.data;
  const c = (await env.api('POST', '/api/campaigns', { name: 'Q4 outreach' })).body.data;
  await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Quick question, {FIRST_NAME}', email_body: 'Hi {FIRST_NAME},\n\n{ICEBREAKER}\n\n{UNSUBSCRIBE_LINK}' }] });
  await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [sender.id] });
  return { campaign: c, sender };
}

describe('tables ⇄ outreach', () => {
  it('pushes rows into a campaign with enrichment as variables, then tracks replies back into the table', async () => {
    const { campaign, sender } = await campaignWithSender();
    const t = (await env.api('POST', '/api/gtm/tables', { name: 'Prospects' })).body;
    const rows = (await env.api('POST', `/api/gtm/tables/${t.id}/rows`, { rows: [
      { Email: 'jane@acme.test', 'First name': 'Jane', Company: 'Acme', Icebreaker: 'Loved your post on pricing.' },
      { Email: 'not-an-email', 'First name': 'Bad' },
    ] })).body.ids as number[];

    const push = (await env.api('POST', `/api/gtm/tables/${t.id}/columns`, {
      name: 'Push to campaign', type: 'action',
      config: { kind: 'outreach_campaign', campaignId: campaign.id, email: '{{Email}}', firstName: '{{First name}}', company: '{{Company}}', variables: [{ name: 'icebreaker', value: '{{Icebreaker}}' }] },
    })).body.id;
    await env.api('POST', `/api/gtm/tables/${t.id}/columns`, { name: 'Outreach status', type: 'signal', auto_run: true, config: { kind: 'outreach_status', inputs: { email: '{{Email}}' } } });
    await env.api('POST', `/api/gtm/tables/${t.id}/columns`, {
      name: 'Alert', type: 'action', auto_run: true,
      run_if: 'changed("Outreach status") && row["Outreach status"] === "interested"',
      config: { kind: 'webhook', url: 'https://alerts.test/hot', body: '{"text":"{{First name}} at {{Company}} is interested"}' },
    });

    await env.api('POST', `/api/gtm/tables/${t.id}/run`, { columnIds: [push] });
    await settle(t.id);
    expect((await cellOf(t.id, rows[0], 'Push to campaign')).value).toMatchObject({ value: 'Added to Q4 outreach' });
    expect((await cellOf(t.id, rows[1], 'Push to campaign')).status).toBe('error'); // invalid email

    const lead = env.ctx.db.get("SELECT * FROM leads WHERE email = 'jane@acme.test'");
    expect(JSON.parse(lead.custom_variables)).toEqual({ icebreaker: 'Loved your post on pricing.' });
    expect(env.ctx.db.get('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaign.id, lead.id]).status).toBe('pending');

    // Status column: baseline, then live updates from the outreach engine.
    await env.api('POST', `/api/gtm/tables/${t.id}/run`, { columnIds: [(await env.api('GET', `/api/gtm/tables/${t.id}`)).body.columns.find((c: any) => c.name === 'Outreach status').id], rowIds: [rows[0]] });
    await settle(t.id);
    expect((await cellOf(t.id, rows[0], 'Outreach status')).value.value).toBe('queued');

    const hook = await env.api('POST', '/api/webhook-url', { name: 'All', url: 'https://hooks.test/k', events: ['SIGNAL_CHANGED'] });
    expect(hook.status).toBe(200);
    expect((await env.api('POST', `/api/campaigns/${campaign.id}/launch`)).status).toBe(200);
    plan(env.ctx);
    env.clock.now = new Date('2026-10-12T20:00:00Z');
    await dispatch(env.ctx);
    const sent = mail.sent.find((m) => m.msg.to.includes('jane@acme.test'))!.msg;
    expect(sent.text).toContain('Loved your post on pricing.'); // AI/enrichment variable reached the email
    await settle(t.id);
    expect((await cellOf(t.id, rows[0], 'Outreach status')).value.value).toBe('sequence finished');

    const reply = [
      `Message-ID: <r1@acme.test>`, `In-Reply-To: <${sent.messageId}>`, `References: <${sent.messageId}>`,
      `From: Jane <jane@acme.test>`, `To: ${sender.email}`, `Subject: Re: ${sent.subject}`, `Date: Mon, 12 Oct 2026 20:10:00 +0000`, '',
      'Sounds interesting - are you free for a call on Thursday?',
    ].join('\r\n');
    const s = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [sender.id]);
    expect(await processInbound(env.ctx, s, await parseInbound(reply), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 })).toBe('reply');
    await settle(t.id);

    const status = await cellOf(t.id, rows[0], 'Outreach status');
    expect(status.value.value).toBe('interested');
    const alert = posts.find((p) => String(p.url) === 'https://alerts.test/hot');
    expect(alert && JSON.parse(alert.body)).toEqual({ text: 'Jane at Acme is interested' });
    expect((await cellOf(t.id, rows[1], 'Alert'))?.status).not.toBe('done'); // only the interested row alerts

    // Status changes became "Signal Changed" webhook deliveries.
    const deliveries = env.ctx.db.all("SELECT payload FROM webhook_deliveries WHERE event_type = 'SIGNAL_CHANGED'");
    expect(deliveries.map((d) => JSON.parse(d.payload).data.to)).toEqual(expect.arrayContaining(['sequence finished', 'interested']));

    // Signals feed merges table changes and outreach events.
    const feed = (await env.api('GET', '/api/gtm/signals')).body as any[];
    expect(feed.some((f) => f.source === 'outreach' && f.event === 'LEAD_INTERESTED')).toBe(true);
    expect(feed.some((f) => f.source === 'table' && f.column === 'Outreach status' && f.row === 'jane@acme.test')).toBe(true);
  });

  it('opens a campaign\'s leads as a table and syncs enrichment back to the lead', async () => {
    const { campaign } = await campaignWithSender();
    const created = await env.api('POST', '/api/leads/multiple', { leads: [{ email: 'sam@globex.test', first_name: 'Sam', company: 'Globex', custom_variables: { tier: 'A' } }] });
    await env.api('POST', `/api/campaigns/${campaign.id}/leads/attach-leads`, { lead_ids: created.body.data.lead_ids });

    const r = await env.api('POST', '/api/gtm/tables/from-leads', { campaign_id: campaign.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows).toBe(1);
    await settle(r.body.id);
    const t = (await env.api('GET', `/api/gtm/tables/${r.body.id}`)).body;
    expect(t.table.name).toBe('Leads · Q4 outreach');
    const row = t.rows[0];
    const byName = (n: string) => row.cells[t.columns.find((c: any) => c.name === n).id];
    expect(byName('Email').value).toBe('sam@globex.test');
    expect(byName('tier').value).toBe('A');
    expect(byName('Company domain').value).toBe('globex.test');
    expect(byName('Outreach status').value.value).toBe('queued');

    // Map a new enrichment column into the lead via the sync column.
    await env.api('PATCH', `/api/gtm/tables/${r.body.id}/cells`, { changes: [{ rowId: row.id, columnId: t.columns.find((c: any) => c.name === 'tier').id, value: 'A+' }] });
    const sync = t.columns.find((c: any) => c.name === 'Sync to lead');
    await env.api('PATCH', `/api/gtm/columns/${sync.id}`, { config: { ...sync.config, variables: [{ name: 'tier', value: '{{tier}}' }] } });
    await env.api('POST', `/api/gtm/tables/${r.body.id}/run`, { columnIds: [sync.id], force: true });
    await settle(r.body.id);
    expect(JSON.parse(env.ctx.db.get("SELECT custom_variables FROM leads WHERE email = 'sam@globex.test'").custom_variables)).toEqual({ tier: 'A+' });
  });

  it('keeps tables private to their workspace', async () => {
    const t = (await env.api('POST', '/api/gtm/tables', { name: 'Secret' })).body;
    const ws2 = (await env.api('POST', '/api/workspaces', { name: 'Client B' })).body.data;
    await env.api('POST', '/api/workspaces/switch-workspace', { team_id: ws2.id });
    expect((await env.api('GET', `/api/gtm/tables/${t.id}`)).status).toBe(404);
    expect((await env.api('GET', '/api/gtm/tables')).body).toEqual([]);
    expect((await env.api('POST', `/api/gtm/tables/${t.id}/run`, {})).status).toBe(404);
  });

  it('requires a login for table APIs but not for inbound table webhooks', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/gtm/tables' })).statusCode).toBe(401);
    const t = (await env.api('POST', '/api/gtm/tables', { name: 'Inbound' })).body;
    const token = (await env.api('GET', `/api/gtm/tables/${t.id}`)).body.table.webhook_token;
    const r = await env.app.inject({ method: 'POST', url: `/hooks/${token}`, payload: { Email: 'x@y.test' } });
    expect(r.json()).toEqual({ received: 1 });
  });
});
