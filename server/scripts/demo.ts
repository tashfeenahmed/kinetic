/**
 * Fills a fresh Kinetic install with realistic demo data by running real campaigns
 * (and opens the main campaign's leads as a table with live outreach status)
 * through the local GreenMail server (npm run mail:up) with simulated time:
 * ~10 days of sending, lead replies of every kind, a bounce, and warmup traffic.
 *
 *   npm run demo            (from the repo root; stop the app first)
 *   then log in as demo@kinetic.test / demo-password
 */
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/db.ts';
import { setEncryptionKey } from '../src/lib/crypto.ts';
import { RealMailGateway } from '../src/mail/gateway.ts';
import { buildApp } from '../src/app.ts';
import { silentLogger, type Ctx } from '../src/context.ts';
import { dispatch, plan } from '../src/engine/sequencer.ts';
import { syncSender } from '../src/engine/inbox.ts';
import { dispatchWarmup, planWarmup } from '../src/engine/warmup.ts';
import { setSetting } from '../src/settings.ts';

const HOST = '127.0.0.1';
const DAY = 86_400_000;
const run = Math.random().toString(36).slice(2, 6);

const config = loadConfig({ workers: false });
setEncryptionKey(config.appKey);
const db = new Db(config.dbPath);
if (db.get('SELECT 1 FROM users LIMIT 1')) {
  console.error(`The database at ${config.dbPath} already has users. Point DATA_DIR at an empty folder for the demo.`);
  process.exit(1);
}

const clock = { now: new Date(Date.now() - 10 * DAY) };
const ctx: Ctx = { db, config, log: silentLogger, mail: new RealMailGateway(db), now: () => new Date(clock.now), fetch: globalThis.fetch };
const app = await buildApp(ctx);
const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });

const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { name: 'Cody Smith', email: 'demo@kinetic.test', password: 'demo-password', workspace_name: 'Main Workspace' } });
const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, headers: { cookie }, payload: payload as any });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return r.json().data;
};

console.log('Creating mailboxes…');
const senderDefs = [
  ['Cody Smith', 'cody', 'getbearmail.test'], ['Cody Smith', 'c.smith', 'bearoutreach.test'], ['Maya Chen', 'maya', 'getbearmail.test'],
  ['Maya Chen', 'm.chen', 'trybearhq.test'], ['Leo Park', 'leo', 'bearoutreach.test'], ['Leo Park', 'leo.park', 'trybearhq.test'],
];
const senders: any[] = [];
for (const [name, local, domain] of senderDefs) {
  senders.push(await call('POST', '/api/sender-emails/imap-smtp', {
    name, email: `${local}.${run}@${domain}`, password: 'x', imap_server: HOST, imap_port: 3143, imap_secure: false,
    smtp_server: HOST, smtp_port: 3025, smtp_secure: false, daily_limit: 25,
    email_signature: `${name}\nBear Labs · Growth`, warmup_enabled: true,
  }));
}

console.log('Importing leads…');
const first = ['Joshua', 'Robert', 'Lorie', 'Jason', 'Tony', 'Priya', 'Miguel', 'Hannah', 'Alex', 'Sofia', 'Daniel', 'Grace', 'Omar', 'Elena', 'Marcus', 'Chloe', 'Ivan', 'Nora', 'Samir', 'Julia', 'Ben', 'Jane', 'Dan', 'Kate', 'Ravi', 'Lena', 'Tom', 'Aisha', 'Felix', 'Zoe'];
const last = ['Saint', 'Botthof', 'Deem', 'Bourne', 'Stark', 'Shah', 'Alvarez', 'Kim', 'Carter', 'Rossi', 'Novak', 'Lee', 'Haddad', 'Petrova', 'Reed', 'Martin', 'Volkov', 'Berg', 'Nair', 'Weber', 'Ross', 'Cole', 'Smith', 'Ng', 'Iyer', 'Fischer', 'Hart', 'Bello', 'Wagner', 'Lopez'];
const companies = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Stark Industries', 'Wayne Corp', 'Gamma', 'AlphaOmega', 'Soylent', 'Wonka', 'Cyberdyne', 'Tyrell', 'Massive Dynamic'];
const titles = ['Head of Growth', 'VP Sales', 'Founder', 'Marketing Director', 'CEO', 'Revenue Ops Lead'];
const cities = ['Austin', 'London', 'Berlin', 'Toronto', 'Sydney', 'Denver'];
const leads = first.map((f, i) => {
  const company = companies[i % companies.length]!;
  return {
    email: `${f.toLowerCase()}.${last[i]!.toLowerCase().replace(/\s/g, '')}.${run}@${company.toLowerCase().replace(/[^a-z]/g, '')}.test`,
    first_name: f, last_name: last[i], company, title: titles[i % titles.length],
    custom_variables: [{ name: 'City', value: cities[i % cities.length] }, { name: 'Employees', value: String(100 + ((i * 137) % 900)) }],
  };
});
const list = await call('POST', '/api/lead-lists', { name: 'SaaS 100+ employees' });
const imported = await call('POST', '/api/leads/multiple', { leads, lead_list_id: list.id });
await call('POST', '/api/tags', { name: 'Enterprise' });
await call('POST', '/api/tags', { name: 'Warm' });

console.log('Building campaigns…');
const main = await call('POST', '/api/campaigns', { name: '[SaaS outreach] Companies with 100+ employees' });
await call('PUT', `/api/campaigns/${main.id}/sequence`, {
  steps: [
    {
      email_subject: '{Quick|Short} question, {FIRST_NAME}',
      email_body: '{Hi|Hey} {FIRST_NAME},\n\nNoticed {COMPANY} is hiring in {CITY|your area}. Teams of {EMPLOYEES|your size} usually lose a few hours a week chasing replies across inboxes.\n\nWorth a 15 minute look at how we fixed that for similar teams?',
      variants: [{ email_subject: 'Idea for {COMPANY}', email_body: 'Hi {FIRST_NAME},\n\nOne idea to help {COMPANY} book more meetings from outbound without adding headcount.\n\nOpen to a quick chat next week?' }],
    },
    { email_subject: '', email_body: 'Hi {FIRST_NAME}, just bumping this in case it got buried.', wait_in_days: 2, thread_reply: true },
    { email_subject: 'Closing the loop', email_body: "{FIRST_NAME}, I'll assume the timing isn't right. If that changes, just reply to this email.", wait_in_days: 3 },
  ],
});
await call('PUT', `/api/campaigns/${main.id}/schedule`, { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, start_time: '07:00', end_time: '22:00', timezone: 'UTC' });
await call('POST', `/api/campaigns/${main.id}/attach-sender-emails`, { sender_email_ids: senders.slice(0, 4).map((s) => s.id) });
await call('POST', `/api/campaigns/${main.id}/leads/attach-leads`, { lead_ids: imported.lead_ids.slice(0, 24) });
await call('POST', `/api/campaigns/${main.id}/launch`);

const draft = await call('POST', '/api/campaigns', { name: 'Agency partners — Q4' });
await call('PUT', `/api/campaigns/${draft.id}/sequence`, { steps: [{ email_subject: 'Partnering with {COMPANY}?', email_body: 'Hi {FIRST_NAME},\n\nWe work with agencies like {COMPANY} on outbound infrastructure. Open to swapping notes?' }] });
await call('POST', `/api/campaigns/${draft.id}/attach-sender-emails`, { sender_email_ids: senders.slice(4).map((s) => s.id) });
await call('POST', `/api/campaigns/${draft.id}/leads/attach-leads`, { lead_ids: imported.lead_ids.slice(24) });

const followup = await call('POST', '/api/campaigns', { name: 'Interested — booking follow-up', type: 'reply_followup' });
await call('PUT', `/api/campaigns/${followup.id}/sequence`, { steps: [{ email_subject: '', email_body: 'Hi {FIRST_NAME}, here is my calendar to grab a time that suits: https://cal.example/bear', thread_reply: true }] });

await call('POST', '/api/reply-templates', { name: 'Booking link', body: 'Great to hear! Grab any slot that works here: https://cal.example/bear\n\nTalk soon,' });
await call('POST', '/api/reply-templates', { name: 'Pricing', body: 'Pricing starts at $599/month for 500k emails, everything included. Happy to walk you through it on a call.' });
await call('POST', '/api/ignore-phrases', { phrase: 'this mailbox is not monitored' });
await call('POST', '/api/blacklisted-domains', { domain: 'competitor.test' });
setSetting(db, 'warmup_timezone', 'UTC');

// ---- simulate ten days -------------------------------------------------------
const REPLIES = [
  { text: "Sounds interesting — I'm free Thursday afternoon for a call. What times work?", subject: true },
  { text: 'Not interested, thanks.', subject: true },
  { text: 'Please remove me from your list.', subject: true },
  { text: 'Who else do you work with in our space? Send me a case study.', subject: true },
  { text: 'Happy to chat. Can you send over pricing?', subject: true },
  { text: "I'm out of office until Monday with limited access to email.", ooo: true },
];
const repliers = new Map<number, (typeof REPLIES)[number]>();
imported.lead_ids.slice(0, 24).forEach((id: number, i: number) => { if (i % 4 === 1) repliers.set(id, REPLIES[Math.floor(i / 4) % REPLIES.length]!); });
const bouncer = imported.lead_ids[22] as number;
const replied = new Set<number>();

const syncAll = async () => { for (const s of senders) await syncSender(ctx, db.get('SELECT * FROM sender_emails WHERE id = ?', [s.id])!); };

for (let d = 9; d >= 0; d--) {
  const day = new Date(Date.now() - d * DAY);
  day.setUTCHours(8, 0, 0, 0);
  clock.now = day;
  plan(ctx);
  planWarmup(ctx);
  // Walk through the day in two-hour steps so sends land at realistic times.
  for (let h = 0; h < 14; h += 2) {
    clock.now = new Date(day.getTime() + h * 3_600_000);
    if (clock.now.getTime() > Date.now()) break;
    plan(ctx);
    while ((await dispatch(ctx, 200)).sent > 0) { /* drain */ }
    await dispatchWarmup(ctx, 200);
  }
  // Leads answer a few hours after their first email.
  for (const [leadId, r] of repliers) {
    if (replied.has(leadId)) continue;
    const sent = db.get(`SELECT s.*, se.email AS from_mailbox FROM sent_emails s JOIN sender_emails se ON se.id = s.sender_email_id WHERE s.lead_id = ? AND s.sent_at <= ? ORDER BY s.id LIMIT 1`, [leadId, clock.now.toISOString()]);
    if (!sent) continue;
    replied.add(leadId);
    const lead = db.get('SELECT * FROM leads WHERE id = ?', [leadId]);
    await smtp.sendMail({
      from: { name: `${lead.first_name} ${lead.last_name}`, address: lead.email }, to: sent.from_mailbox,
      subject: r.ooo ? `Automatic reply: ${sent.subject}` : `Re: ${sent.subject}`,
      inReplyTo: `<${sent.message_id}>`, references: [`<${sent.message_id}>`],
      headers: r.ooo ? { 'Auto-Submitted': 'auto-replied' } : {},
      date: new Date(clock.now.getTime() - 60 * 60_000),
      text: `${r.text}\n\n${lead.first_name}\n\nOn ${new Date(sent.sent_at).toUTCString()}, ${sent.from_mailbox} wrote:\n> ${sent.body_text.split('\n')[0]}`,
    });
  }
  const bounced = db.get('SELECT s.*, se.email AS from_mailbox FROM sent_emails s JOIN sender_emails se ON se.id = s.sender_email_id WHERE s.lead_id = ? LIMIT 1', [bouncer]);
  if (bounced && !db.get(`SELECT 1 FROM replies WHERE category = 'bounce'`)) {
    await smtp.sendMail({
      envelope: { from: 'mailer-daemon@mx.test', to: bounced.from_mailbox },
      raw: [
        'From: Mail Delivery Subsystem <mailer-daemon@mx.test>', `To: ${bounced.from_mailbox}`, 'Subject: Delivery Status Notification (Failure)',
        `Message-ID: <dsn-${run}@mx.test>`, `Date: ${clock.now.toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', '',
        '--b', 'Content-Type: text/plain', '', `Your message to ${bounced.to_email} could not be delivered. The address does not exist.`, '',
        '--b', 'Content-Type: message/delivery-status', '', `Final-Recipient: rfc822; ${bounced.to_email}`, 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 User unknown', '',
        '--b', 'Content-Type: text/rfc822-headers', '', `Message-ID: <${bounced.message_id}>`, '', '--b--', '',
      ].join('\r\n'),
    });
  }
  clock.now = new Date(Math.min(Date.now(), day.getTime() + 13 * 3_600_000));
  await new Promise((r) => setTimeout(r, 500));
  await syncAll();
  process.stdout.write(`  day -${d}: ${db.get('SELECT COUNT(*) n FROM sent_emails').n} sent, ${db.get('SELECT COUNT(*) n FROM replies').n} inbound, ${db.get(`SELECT COUNT(*) n FROM warmup_emails WHERE status='sent'`).n} warmup\n`);
}

clock.now = new Date();
await syncAll();

// Tables: the main campaign's leads as a table, with live outreach status.
const gtm = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, headers: { cookie }, payload: payload as any });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return r.json();
};
const table = await gtm('POST', '/api/gtm/tables/from-leads', { campaign_id: main.id, name: 'SaaS prospects' });
await gtm('POST', `/api/gtm/tables/${table.id}/columns`, { name: 'Greeting', type: 'formula', config: { expression: '`Hi ${row["First name"] || "there"}`' } });
await new Promise((r) => setTimeout(r, 1500)); // let status cells fill
console.log(`  table "SaaS prospects": ${table.rows} rows with Outreach status`);
await app.close();
db.close();
smtp.close();
console.log('\nDemo ready. Start the app (npm start) and log in as demo@kinetic.test / demo-password');
