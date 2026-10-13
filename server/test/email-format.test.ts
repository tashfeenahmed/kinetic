import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { FakeMail, makeEnv, type TestEnv } from './helpers.ts';
import { parseInbound, realFiles } from '../src/mail/classify.ts';
import { processInbound } from '../src/engine/inbox.ts';
import { markdownToHtml } from '../src/lib/markdown.ts';
import { htmlToText } from '../src/lib/html.ts';

let env: TestEnv;
let mail: FakeMail;
beforeEach(async () => { mail = new FakeMail(); env = await makeEnv({ mail }); });
afterEach(() => env.close());

const PDF = Buffer.from('%PDF-1.4 fake pdf');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A lead's reply with a logo shown inline in the HTML and two attached files. */
async function receiveReplyWithFiles() {
  const sender = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Box', email: 'box@acme.test', password: 'pw', provider: 'google' })).body.data;
  await env.api('PATCH', '/api/workspaces/inbox-settings', { sync_all_emails: true });
  env.ctx.db.run('UPDATE workspaces SET sync_all_emails = 1');
  const raw = await new MailComposer({
    from: 'Alex Lead <alex@lead.test>', to: 'box@acme.test', subject: 'Re: hello', messageId: '<r1@lead.test>',
    text: 'See attached.', html: '<p>See <b>attached</b>.</p><img src="cid:logo@lead">',
    attachments: [
      { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@lead' },
      { filename: 'Proposal.pdf', content: PDF, contentType: 'application/pdf' },
      { filename: 'Prix – été.csv', content: 'a,b\n1,2\n', contentType: 'text/csv' },
    ],
  }).compile().build();
  const row = env.ctx.db.get('SELECT * FROM sender_emails WHERE id = ?', [sender.id])!;
  expect(await processInbound(env.ctx, row, await parseInbound(raw), { client: null, folder: 'INBOX', kind: 'inbox', uid: 1 })).toBe('untracked');
  return env.ctx.db.get('SELECT id FROM replies')!.id as number;
}

describe('Markdown emails', () => {
  it('formats bold, links and lists, keeps line breaks, and escapes raw HTML', () => {
    const html = markdownToHtml('Hi Alex,\n\n**Bold** and [deck](https://x.test/d).\nNext line\n\n- one\n- two\n\n<script>x</script>\n\n[bad](javascript:alert(1))');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<a href="https://x.test/d">deck</a>');
    expect(html).toContain('<br>Next line');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<p>bad</p>');
    expect(htmlToText(html)).toContain('Bold and deck (https://x.test/d).\nNext line\n\n- one\n- two');
  });

  it('sends inbox emails as formatted HTML with a clean plain-text part', async () => {
    const sender = (await env.api('POST', '/api/sender-emails/imap-smtp', { name: 'Box', email: 'box@acme.test', password: 'pw', provider: 'google' })).body.data;
    const r = await env.api('POST', '/api/replies/new', { sender_email_id: sender.id, to_emails: ['alex@lead.test'], subject: 'Hi', message: 'Hello **Alex**\n\n1. first\n2. second' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const msg = mail.sent.at(-1)!.msg;
    expect(msg.html).toContain('<strong>Alex</strong>');
    expect(msg.html).toContain('<ol>');
    expect(msg.text).toBe('Hello Alex\n\n1. first\n2. second');
  });

  it('renders Markdown in campaign steps', async () => {
    const c = (await env.api('POST', '/api/campaigns', { name: 'MD' })).body.data;
    // Campaigns send plain text by default: the Markdown is dropped and only the words go out.
    const plain = await env.api('POST', `/api/campaigns/${c.id}/preview`, { email_subject: 'Hi', email_body: 'We help **{COMPANY}** grow.' });
    expect(plain.body.data).toMatchObject({ html: null, text: 'We help Acme Inc grow.' });
    await env.api('PATCH', `/api/campaigns/${c.id}/update`, { plain_text: false });
    const r = await env.api('POST', `/api/campaigns/${c.id}/preview`, { email_subject: 'Hi', email_body: 'Hi {FIRST_NAME},\n\nWe help **{COMPANY}** grow.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.html).toContain('<strong>Acme Inc</strong>');
    expect(r.body.data.text).toContain('We help Acme Inc grow.');
  });
});

describe('Attachments', () => {
  it('keeps received files, marks inline images and serves files for download or viewing', async () => {
    const id = await receiveReplyWithFiles();
    const thread = (await env.api('GET', `/api/replies/${id}/conversation-thread`)).body.data;
    const atts = thread.messages[0].attachments;
    expect(atts.map((a: any) => [a.filename, a.inline])).toEqual([['logo.png', true], ['Proposal.pdf', false], ['Prix – été.csv', false]]);
    expect(atts[0].path).toBeUndefined();

    const dl = await env.raw('GET', atts[1].url);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="Proposal.pdf"/);

    const view = await env.raw('GET', `${atts[1].url}?inline=1`);
    expect(view.headers['content-disposition']).toMatch(/^inline;/);
    expect(view.headers['content-type']).toBe('application/pdf');

    // Unicode names survive (RFC 5987), and types a browser shouldn't render always download.
    const csv = await env.raw('GET', `${atts[2].url}?inline=1`);
    expect(csv.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Prix – été.csv')}`);
    expect(csv.headers['content-disposition']).toMatch(/^attachment;/);
    expect(csv.headers['content-type']).toBe('application/octet-stream');
  });

  it('keeps files sent from the inbox and forwards the original attachments', async () => {
    const id = await receiveReplyWithFiles();
    const reply = await env.api('POST', `/api/replies/${id}/reply`, { message: 'Thanks', attachments: [{ filename: 'terms.txt', content_base64: Buffer.from('terms').toString('base64'), content_type: 'text/plain' }] });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.attachments).toEqual([expect.objectContaining({ filename: 'terms.txt', size: 5 })]);
    const thread = (await env.api('GET', `/api/replies/${id}/conversation-thread`)).body.data;
    const sent = thread.messages.find((m: any) => m.direction === 'sent');
    const file = await env.raw('GET', `${sent.attachments[0].url}?inline=1`);
    expect(file.body).toBe('terms');
    expect(file.headers['content-type']).toBe('text/plain; charset=utf-8');

    const fwd = await env.api('POST', `/api/replies/${id}/forward`, { to_emails: ['team@acme.test'], message: 'FYI' });
    expect(fwd.status, JSON.stringify(fwd.body)).toBe(200);
    expect(mail.sent.at(-1)!.msg.attachments!.map((a) => a.filename)).toEqual(['Proposal.pdf', 'Prix – été.csv']);
  });

  it('leaves out body variants and duplicate calendar parts', () => {
    const f = (filename: string, contentType: string) => ({ filename, contentType });
    expect(realFiles([f('attachment', 'text/calendar'), f('invite.ics', 'application/ics'), f('attachment', 'text/x-amp-html'), f('a.pdf', 'application/pdf')]).map((a) => a.filename))
      .toEqual(['invite.ics', 'a.pdf']);
    expect(realFiles([f('attachment', 'text/calendar')])).toEqual([f('invite.ics', 'text/calendar')]);
  });
});
