import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail, makeEnv, openAllDay, type TestEnv } from './helpers.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { checkRecipientDomain, setRecipientResolver } from '../src/engine/recipientDomain.ts';

const NOW = new Date('2026-10-12T14:00:00Z');
const err = (code: string) => Object.assign(new Error(code), { code });
let env: TestEnv;
let mail: FakeMail;
let lookups: string[];

// live.test: MX. bare.test: no MX but an A record. nomail.test: null MX. parked.test: no MX/A.
// slow.test: DNS times out. Anything else: NXDOMAIN.
beforeEach(async () => {
  mail = new FakeMail();
  env = await makeEnv({ mail, now: NOW });
  lookups = [];
  setRecipientResolver({
    async resolveMx(d) {
      lookups.push(d);
      if (d === 'live.test') return [{ exchange: 'mx.live.test', priority: 10 }];
      if (d === 'nomail.test') return [{ exchange: '', priority: 0 }];
      if (d === 'slow.test') throw err('ETIMEOUT');
      if (d === 'bare.test' || d === 'parked.test') throw err('ENODATA');
      throw err('ENOTFOUND');
    },
    async resolve4(d) { if (d === 'bare.test') return ['192.0.2.7']; throw err('ENODATA'); },
    async resolve6() { throw err('ENODATA'); },
  });
});
afterEach(() => env.close());

describe('recipient domain check', () => {
  it('classifies domains and caches definite answers only', async () => {
    const v = async (e: string) => (await checkRecipientDomain(env.ctx, e)).verdict;
    expect(await v('a@live.test')).toBe('ok');
    expect(await v('a@bare.test')).toBe('ok');
    expect(await checkRecipientDomain(env.ctx, 'a@gone.test')).toEqual({ verdict: 'dead', why: 'domain does not exist' });
    expect(await checkRecipientDomain(env.ctx, 'a@nomail.test')).toEqual({ verdict: 'dead', why: 'domain does not accept email' });
    expect(await checkRecipientDomain(env.ctx, 'a@parked.test')).toEqual({ verdict: 'dead', why: 'domain has no mail server' });
    expect(await v('a@slow.test')).toBe('unknown');
    const before = lookups.length;
    await v('b@GONE.test');
    await v('b@slow.test');
    expect(lookups.length).toBe(before + 1); // gone.test cached, slow.test asked again
  });

  it('skips leads on dead domains before sending and still sends the rest', async () => {
    const sid = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Alex', email: 'alex@north.test', password: 'pw', provider: 'google', daily_limit: 30 })).body.data.id;
    const c = (await env.api('POST', '/api/campaigns', { name: 'Q4' })).body.data;
    await env.api('PUT', `/api/campaigns/${c.id}/sequence`, { steps: [{ email_subject: 'Hi', email_body: 'Hello there' }] });
    await env.api('POST', `/api/campaigns/${c.id}/attach-sender-emails`, { sender_email_ids: [sid] });
    const leads = await env.api('POST', '/api/leads/multiple', { leads: [{ email: 'ok@live.test' }, { email: 'dead@gone.test' }, { email: 'maybe@slow.test' }] });
    await env.api('POST', `/api/campaigns/${c.id}/leads/attach-leads`, { lead_ids: leads.body.data.lead_ids });
    openAllDay(env.ctx, c.id);
    await env.api('POST', `/api/campaigns/${c.id}/launch`);
    expect(plan(env.ctx).planned).toBe(3);
    env.ctx.db.run(`UPDATE scheduled_emails SET scheduled_at = ?`, [NOW.toISOString()]); // all due now

    expect(await dispatch(env.ctx)).toEqual({ sent: 2, failed: 0 });
    expect(mail.sent.map((m) => m.msg.to).sort()).toEqual(['maybe@slow.test', 'ok@live.test']);
    const dead = env.ctx.db.get(`SELECT * FROM leads WHERE email = 'dead@gone.test'`)!;
    expect(dead.status).toBe('bounced');
    expect(env.ctx.db.get('SELECT status FROM campaign_leads WHERE lead_id = ?', [dead.id])!.status).toBe('bounced');
    expect(env.ctx.db.get('SELECT status, error FROM scheduled_emails WHERE lead_id = ?', [dead.id])).toEqual({ status: 'cancelled', error: 'recipient domain does not exist' });
    expect(env.ctx.db.get(`SELECT COUNT(*) n FROM sent_emails WHERE sender_email_id = ?`, [sid])!.n).toBe(2);
  });
});
