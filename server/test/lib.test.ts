import { describe, expect, it } from 'vitest';
import { buildVariables, missingVariables, render } from '../src/lib/template.ts';
import { nextWindow, openWindow, windowOnDay } from '../src/lib/schedule.ts';
import { categorize, parseInbound } from '../src/mail/classify.ts';
import { htmlToText, stripQuoted, textToHtml } from '../src/lib/html.ts';
import { checkDomain } from '../src/lib/dns.ts';
import { warmupEmail, warmupReply } from '../src/engine/warmupContent.ts';
import { seededRandom } from '../src/lib/template.ts';

const vars = buildVariables({
  lead: { email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme', custom_variables: { 'Phone Number': '555', City: '' } },
  sender: { name: 'Alex Morgan', email: 'alex@bear.test', signature: '-- Alex' },
});

describe('template rendering', () => {
  it('fills built-in and custom variables case-insensitively', () => {
    expect(render('Hi {FIRST_NAME} at {company}, call {PHONE_NUMBER}. — {SENDER_FIRST_NAME}', vars)).toBe('Hi Jane at Acme, call 555. — Alex');
  });
  it('uses fallbacks for empty variables', () => {
    expect(render('Hi {CITY|there}', vars)).toBe('Hi there');
    expect(render('Hi {FIRST_NAME|there}', vars)).toBe('Hi Jane');
  });
  it('spins options deterministically per seed', () => {
    const a = render('{Hi|Hello|Hey} {FIRST_NAME}', vars, { seed: 7 });
    expect(['Hi Jane', 'Hello Jane', 'Hey Jane']).toContain(a);
    expect(render('{Hi|Hello|Hey} {FIRST_NAME}', vars, { seed: 7 })).toBe(a);
    const outcomes = new Set(Array.from({ length: 50 }, (_, i) => render('{a|b|c}', vars, { seed: i })));
    expect(outcomes.size).toBe(3);
  });
  it('supports nested spintax and leaves unknown variables visible', () => {
    expect(['x1', 'x2', 'y']).toContain(render('{x{1|2}|y}', vars, { seed: 3 }));
    expect(render('Hello {UNKNOWN_THING}', vars)).toBe('Hello {UNKNOWN_THING}');
    expect(missingVariables('Hi {UNKNOWN_THING} {FIRST_NAME} {OTHER|ok}', vars)).toEqual(['UNKNOWN_THING']);
  });
  it('does not touch braces in non-variable text', () => {
    expect(render('code: { "a": 1 }', vars)).toBe('code: { "a": 1 }');
  });
});

describe('sending schedule', () => {
  const s = { days: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false }, start_time: '09:00', end_time: '17:00', timezone: 'America/New_York' };
  it('opens only inside local business hours', () => {
    // Monday 2026-10-12 14:00Z = 10:00 New York (EDT)
    expect(openWindow(s, new Date('2026-10-12T14:00:00Z'))).not.toBeNull();
    // 12:00Z = 08:00 New York -> closed
    expect(openWindow(s, new Date('2026-10-12T12:00:00Z'))).toBeNull();
    // Saturday -> closed
    expect(openWindow(s, new Date('2026-10-17T15:00:00Z'))).toBeNull();
  });
  it('computes window bounds in UTC across DST', () => {
    const w = windowOnDay(s, new Date('2026-10-12T15:00:00Z'))!;
    expect(w.start.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-12T21:00:00.000Z');
    const winter = windowOnDay(s, new Date('2026-12-07T15:00:00Z'))!; // EST
    expect(winter.start.toISOString()).toBe('2026-12-07T14:00:00.000Z');
  });
  it('finds the next window after a weekend', () => {
    const w = nextWindow(s, new Date('2026-10-17T15:00:00Z'))!; // Saturday
    expect(w.start.toISOString()).toBe('2026-10-19T13:00:00.000Z'); // Monday 09:00 EDT
  });
  it('handles overnight windows and 24h windows', () => {
    const night = { ...s, days: { ...s.days, saturday: true, sunday: true }, start_time: '22:00', end_time: '02:00', timezone: 'UTC' };
    expect(openWindow(night, new Date('2026-10-13T01:00:00Z'))).not.toBeNull();
    expect(openWindow(night, new Date('2026-10-13T03:00:00Z'))).toBeNull();
    const always = { ...night, start_time: '00:00', end_time: '00:00' };
    expect(openWindow(always, new Date('2026-10-13T23:59:30Z'))).not.toBeNull();
  });
});

const mime = (headers: Record<string, string>, body: string) =>
  Object.entries({ 'Message-ID': '<abc@x.test>', From: 'Jane <jane@acme.com>', To: 'alex@bear.test', Subject: 'Re: hello', Date: 'Mon, 12 Oct 2026 10:00:00 +0000', ...headers })
    .map(([k, v]) => `${k}: ${v}`).join('\r\n') + `\r\n\r\n${body}`;

describe('reply classification', () => {
  it('detects interest, rejection and unsubscribe intent', async () => {
    expect(categorize(await parseInbound(mime({}, 'Sounds good, are you free Tuesday for a call?'))).category).toBe('interested');
    expect(categorize(await parseInbound(mime({}, 'Not interested, thanks.'))).category).toBe('not_interested');
    expect(categorize(await parseInbound(mime({}, 'Please remove me from your list.'))).category).toBe('unsubscribe');
    expect(categorize(await parseInbound(mime({}, 'Who is this?'))).category).toBe('reply');
  });
  it('ignores the quoted original when classifying', async () => {
    const m = await parseInbound(mime({}, 'Who are you?\n\nOn Mon, Oct 12, 2026 at 10:00 AM Alex wrote:\n> Interested in a quick call? Let me know a time'));
    expect(categorize(m).category).toBe('reply');
  });
  it('flags auto replies by header and subject', async () => {
    expect(categorize(await parseInbound(mime({ 'Auto-Submitted': 'auto-replied' }, 'I am away'))).category).toBe('auto_reply');
    expect(categorize(await parseInbound(mime({ Subject: 'Out of Office: back Monday' }, 'Away'))).category).toBe('auto_reply');
    expect(categorize(await parseInbound(mime({ Subject: 'Automatic reply: hello' }, 'Away'))).automated).toBe(true);
  });
  it('honours ignore phrases', async () => {
    const m = await parseInbound(mime({}, 'This mailbox is not monitored. Interested parties write to info@'));
    expect(categorize(m, ['not monitored']).category).toBe('other');
  });
  it('parses delivery status notifications', async () => {
    const dsn = [
      'Message-ID: <bounce1@mx.test>', 'From: Mail Delivery Subsystem <mailer-daemon@mx.test>', 'To: alex@bear.test',
      'Subject: Delivery Status Notification (Failure)', 'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain', '', 'Your message wasn\'t delivered to nobody@acme.com.', '',
      '--b1', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.test', '', 'Final-Recipient: rfc822; nobody@acme.com', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 user unknown', '',
      '--b1', 'Content-Type: text/rfc822-headers', '', 'Message-ID: <orig123@bear.test>', 'Subject: hello', '', '--b1--', '',
    ].join('\r\n');
    const m = await parseInbound(dsn);
    expect(m.bounce).toEqual({ originalMessageId: 'orig123@bear.test', recipient: 'nobody@acme.com', permanent: true, diagnostic: 'smtp; 550 5.1.1 user unknown' });
    expect(categorize(m).category).toBe('bounce');
  });
  it('treats delayed notices as non-bounces', async () => {
    const dsn = ['Message-ID: <d@mx.test>', 'From: mailer-daemon@mx.test', 'Subject: Delivery Status Notification (Delay)', 'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', '', '--b', 'Content-Type: message/delivery-status', '', 'Final-Recipient: rfc822; x@y.test', 'Action: delayed', 'Status: 4.4.1', '', '--b--'].join('\r\n');
    expect((await parseInbound(dsn)).bounce).toBeNull();
  });
  it('survives sender addresses that are regex metacharacters when scanning for the bounced recipient', async () => {
    // The From address is interpolated into a RegExp to strip it from the body before
    // looking for the bounced address; unescaped brackets/parens used to throw and kill the sync.
    const raw = ['From: Mail Delivery Subsystem <"a[b"@mx.test>', 'To: alex@bear.test',
      'Subject: Mail delivery failed: returning message to sender', 'Message-ID: <b2@mx.test>', '',
      'Your message to bob@corp.com could not be delivered.', ''].join('\r\n');
    const m = await parseInbound(raw);
    expect(m.bounce?.recipient).toBe('bob@corp.com');
    expect(m.bounce?.permanent).toBe(true);
  });
});

describe('html helpers', () => {
  it('round-trips text and html', () => {
    const html = textToHtml('Hi Jane,\n\nSee https://acme.com/x.\nThanks');
    expect(html).toContain('<a href="https://acme.com/x">https://acme.com/x</a>');
    expect(htmlToText(html)).toBe('Hi Jane,\n\nSee https://acme.com/x.\nThanks');
  });
  it('strips quoted history', () => {
    expect(stripQuoted('Yes please\n\nOn Mon, 12 Oct 2026, Alex <a@b.c> wrote:\n> hello')).toBe('Yes please');
  });
});

describe('dns checks', () => {
  it('reports pass/fail for each record', async () => {
    const resolver = {
      resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }],
      resolveTxt: async (name: string) => {
        if (name === 'acme.com') return [['v=spf1 include:_spf.google.com ~all']];
        if (name === 'google._domainkey.acme.com') return [['v=DKIM1; k=rsa; p=MIIB']];
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      },
    };
    const r = await checkDomain('acme.com', resolver);
    expect(Object.fromEntries(r.checks.map((c) => [c.name, c.status]))).toEqual({ MX: 'pass', SPF: 'pass', DKIM: 'pass', DMARC: 'fail' });
    expect(r.ok).toBe(false);
  });
});

describe('warmup content', () => {
  it('produces varied natural emails', () => {
    const r = seededRandom(1);
    const emails = Array.from({ length: 30 }, () => warmupEmail('Alex Morgan', 'Jamie Lee', r));
    expect(new Set(emails.map((e) => e.text)).size).toBe(30);
    expect(emails[0]!.text).toMatch(/Jamie/);
    expect(emails[0]!.text).toMatch(/Alex$/);
    expect(warmupReply('Jamie Lee', 'Alex Morgan', r)).toMatch(/Alex/);
  });
});
