import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { smtpVerify, pickHelo, classifyRejection, smtpOptions, _resetSmtpState, type SmtpOptions } from '../src/gtm/lib/smtp.ts';

/** A scripted fake MX on 127.0.0.1. `rcpt` decides the reply per recipient; everything is logged. */
interface Fake { port: number; log: string[]; sessions: number; maxConcurrent: number; close(): Promise<void> }

async function fakeMx(handlers: { greeting?: string; ehlo?: string; mail?: string; rcpt?: (to: string, session: number) => string } = {}): Promise<Fake> {
  const fake = { log: [] as string[], sessions: 0, maxConcurrent: 0 } as Fake;
  let open = 0;
  const server = net.createServer((sock) => {
    const session = ++fake.sessions;
    open++; fake.maxConcurrent = Math.max(fake.maxConcurrent, open);
    sock.on('close', () => { open--; });
    sock.on('error', () => {});
    sock.write(`${handlers.greeting ?? '220 fake.mx ESMTP ready'}\r\n`);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        fake.log.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write(`${handlers.ehlo ?? '250-fake.mx\r\n250 PIPELINING'}\r\n`);
        else if (up.startsWith('MAIL FROM')) sock.write(`${handlers.mail ?? '250 2.1.0 OK'}\r\n`);
        else if (up.startsWith('RCPT TO')) {
          const to = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
          sock.write(`${handlers.rcpt ? handlers.rcpt(to, session) : '250 2.1.5 OK'}\r\n`);
        } else if (up.startsWith('QUIT')) { sock.end('221 bye\r\n'); }
        else if (up.startsWith('DATA')) { sock.write('500 tests never send DATA\r\n'); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as net.AddressInfo).port;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}

let fake: Fake | undefined;
const opts = (extra: SmtpOptions = {}): SmtpOptions => ({
  port: fake!.port, greylistRetryMs: 0, timeoutMs: 3000, mxLookup: async () => ({ provider: 'Other', mx: ['127.0.0.1'] }), ...extra,
});
const isRandom = (to: string) => to.includes('-nouser@');

beforeEach(() => _resetSmtpState());
afterEach(async () => { await fake?.close(); fake = undefined; });

describe('smtpVerify against a fake MX', () => {
  it('valid mailbox: accepts the target, rejects the random address', async () => {
    fake = await fakeMx({ rcpt: (to) => (isRandom(to) ? '550 5.1.1 User unknown' : '250 2.1.5 OK') });
    const r = await smtpVerify('jane@acme.test', opts({ helo: 'mail.burner.test' }));
    expect(r).toMatchObject({ verdict: 'valid', reason: 'accepted', code: 250, catchAll: false, helo: 'mail.burner.test', family: 4 });
    expect(fake.log[0]).toBe('EHLO mail.burner.test');
    expect(fake.log[1]).toBe('MAIL FROM:<>');
    expect(fake.log).not.toContain('DATA');
  });

  it('mailbox not found', async () => {
    fake = await fakeMx({ rcpt: () => '550 5.1.1 The email account that you tried to reach does not exist' });
    const r = await smtpVerify('nobody@acme.test', opts());
    expect(r).toMatchObject({ verdict: 'invalid', reason: 'mailbox_not_found', code: 550 });
  });

  it('catch-all: random address accepted too', async () => {
    fake = await fakeMx();
    const r = await smtpVerify('anyone@acme.test', opts());
    expect(r).toMatchObject({ verdict: 'catch_all', reason: 'catch_all', catchAll: true });
  });

  it('Microsoft DBEB "5.4.1 Access denied" means the mailbox does not exist', async () => {
    fake = await fakeMx({ rcpt: () => '550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors' });
    expect(await smtpVerify('x@acme.test', opts())).toMatchObject({ verdict: 'invalid', reason: 'mailbox_not_found' });
  });

  it('blocklisted IP is "blocked", not "invalid"', async () => {
    fake = await fakeMx({ rcpt: () => '550 5.7.1 Service unavailable, Client host [86.42.160.60] blocked using Spamhaus.' });
    const r = await smtpVerify('sam@acme.test', opts());
    expect(r).toMatchObject({ verdict: 'unknown', reason: 'blocked', code: 550 });
    expect(r.reply).toMatch(/^blocked/);
  });

  it('refusal at MAIL FROM (e.g. Yahoo TSS09) is "blocked"', async () => {
    fake = await fakeMx({ mail: '553 5.7.2 [TSS09] All messages from 86.42.160.60 will be permanently deferred' });
    expect(await smtpVerify('x@acme.test', opts())).toMatchObject({ verdict: 'unknown', reason: 'blocked', code: 553 });
  });

  it('greylisting: one retry after the delay with the same identity, then valid', async () => {
    fake = await fakeMx({ rcpt: (to, session) => (session === 1 ? '451 4.7.1 Greylisted, try again later' : isRandom(to) ? '550 5.1.1 no such user' : '250 OK') });
    const r = await smtpVerify('jane@acme.test', opts({ greylistRetryMs: 50, helo: 'a.test, b.test' }));
    expect(r).toMatchObject({ verdict: 'valid', reason: 'accepted' });
    expect(fake.sessions).toBe(2);
    const ehlos = fake.log.filter((l) => l.startsWith('EHLO'));
    expect(ehlos).toEqual(['EHLO a.test', 'EHLO a.test']);
  });

  it('greylisting that persists comes back unknown with a reason', async () => {
    fake = await fakeMx({ rcpt: () => '450 4.2.0 Recipient address rejected: Greylisted' });
    const r = await smtpVerify('jane@acme.test', opts({ greylistRetryMs: 20 }));
    expect(r).toMatchObject({ verdict: 'unknown', reason: 'greylisted', code: 450 });
    expect(r.reply).toMatch(/retried once/);
    expect(fake.sessions).toBe(2);
  });

  it('mailbox full and disabled are reported', async () => {
    fake = await fakeMx({ rcpt: (to) => (to.startsWith('full') ? '552 5.2.2 Mailbox full' : '550 5.2.1 Account disabled') });
    expect(await smtpVerify('full@acme.test', opts())).toMatchObject({ verdict: 'invalid', reason: 'mailbox_full' });
    expect(await smtpVerify('gone@acme.test', opts())).toMatchObject({ verdict: 'invalid', reason: 'mailbox_disabled' });
  });

  it('MAIL FROM template uses the HELO name in use', async () => {
    fake = await fakeMx({ rcpt: (to) => (isRandom(to) ? '550 no such user' : '250 OK') });
    await smtpVerify('jane@acme.test', opts({ helo: 'mail.burner.test', from: 'check@{helo_domain}' }));
    expect(fake.log[1]).toBe('MAIL FROM:<check@mail.burner.test>');
  });

  it('never runs more than 2 sessions at once against one MX', async () => {
    fake = await fakeMx({ rcpt: (to) => (isRandom(to) ? '550 no such user' : '250 OK') });
    await Promise.all(Array.from({ length: 6 }, (_, i) => smtpVerify(`p${i}@d${i}.test`, opts())));
    expect(fake.sessions).toBe(6);
    expect(fake.maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('connection refused is connect_failed', async () => {
    fake = await fakeMx();
    const port = fake.port;
    await fake.close(); fake = undefined;
    const r = await smtpVerify('x@acme.test', { port, mxLookup: async () => ({ provider: 'Other', mx: ['127.0.0.1'] }), timeoutMs: 2000 });
    expect(r).toMatchObject({ verdict: 'unknown', reason: 'connect_failed' });
  });

  it('bad syntax and missing MX', async () => {
    expect(await smtpVerify('not-an-email')).toMatchObject({ verdict: 'invalid', reason: 'bad_syntax' });
    expect(await smtpVerify('a@nomx.test', { mxLookup: async () => null })).toMatchObject({ verdict: 'invalid', reason: 'no_mx' });
  });
});

describe('HELO rotation', () => {
  it('round-robins across MX hosts and sticks per MX', () => {
    const list = 'mail.a.test, mail.b.test,mail.c.test';
    expect(pickHelo(list, 'mx1')).toBe('mail.a.test');
    expect(pickHelo(list, 'mx2')).toBe('mail.b.test');
    expect(pickHelo(list, 'mx3')).toBe('mail.c.test');
    expect(pickHelo(list, 'mx1')).toBe('mail.a.test'); // sticky
    expect(pickHelo(list, 'mx4')).toBe('mail.a.test');
  });

  it('keeps one name for every MX host of the same mail system', () => {
    const list = 'mail.a.test, mail.b.test';
    pickHelo(list, 'gmail-smtp-in.l.google.com');
    const fm = pickHelo(list, 'in1-smtp.messagingengine.com');
    expect(pickHelo(list, 'in2-smtp.messagingengine.com')).toBe(fm);
  });

  it('a HELO rejection is reported as blocked', async () => {
    fake = await fakeMx({ ehlo: "451 4.7.1 <mail.b.test>: Helo command rejected: HELO string 'mail.b.test' does not match last HELO string" });
    expect(await smtpVerify('x@acme.test', opts({ helo: 'mail.b.test' }))).toMatchObject({ verdict: 'unknown', reason: 'blocked', code: 451 });
  });

  it('falls back to a default and drops a sticky name that was removed from the list', () => {
    expect(pickHelo(undefined, 'mx1')).toBe('mail.kineticsand.local');
    expect(pickHelo('one.test', 'mx9')).toBe('one.test');
    expect(pickHelo('two.test', 'mx9')).toBe('two.test');
  });

  it('reads settings', () => {
    const s = { get: (k: string) => ({ SMTP_HELO: 'h.test', SMTP_MAIL_FROM: 'v@{helo_domain}' } as Record<string, string>)[k] };
    expect(smtpOptions(s)).toEqual({ helo: 'h.test', from: 'v@{helo_domain}' });
  });
});

describe('classifyRejection', () => {
  it.each([
    [550, '5.1.1 <x@y>: Recipient address rejected: User unknown in local recipient table', 'mailbox_not_found'],
    [550, '5.7.1 Mail from IP 86.42.160.60 was rejected due to listing in Spamhaus PBL', 'blocked'],
    [554, '5.7.1 Client host rejected: cannot find your reverse hostname', 'blocked'],
    [554, '5.7.1 <x@y>: Relay access denied', 'rejected'],
    [550, 'Requested action not taken: mailbox unavailable', 'mailbox_not_found'],
    [550, '5.4.1 Recipient address rejected: Access denied', 'mailbox_not_found'],
  ])('%i %s → %s', (code, text, reason) => {
    expect(classifyRejection(code, text).reason).toBe(reason);
  });
});
