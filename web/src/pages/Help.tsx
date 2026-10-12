import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, Code2, LifeBuoy, ServerCog } from 'lucide-react';
import { api } from '../lib/api.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Card, cx } from '../components/ui.tsx';

const FAQ = [
  ['A mailbox shows “Disconnected”. What now?', 'Open Sender Emails, use the menu on that mailbox and choose Reconnect. For Google, create a new app password; for Microsoft, sign in again. Campaigns skip disconnected mailboxes and continue once they are back.'],
  ['Why are no emails going out?', 'Check that the campaign is Active, today is inside its schedule (Schedule tab, in the campaign timezone), at least one connected mailbox is attached, and mailboxes have daily capacity left. The Sending Schedule page shows exactly what is booked and any errors.'],
  ['How many emails can each mailbox send?', 'Stay around 30–50 a day per mailbox and use 2–3 mailboxes per domain. Scale by adding mailboxes, not by raising limits.'],
  ['When should I start sending from a new mailbox?', 'After 2–4 weeks of warmup, once its health score is above 90%. Keep warmup on while you send.'],
  ['Does a reply stop the sequence?', 'Yes, for that lead in that campaign (you can turn this off in campaign Settings). Out-of-office replies never stop a sequence. Unsubscribe requests stop every campaign for the lead.'],
  ['Why did a follow-up not thread?', 'Turn on “Reply in same thread” for that step. Threaded follow-ups reuse the subject and reply to the previous email from the same mailbox.'],
  ['How do Tables and Outreach connect?', 'In any table, “Send to campaign” turns rows into leads (enrichment and AI columns become custom variables you can use in sequences) and adds them to a campaign. An “Outreach status” column then updates live as emails send and replies arrive. From Leads or a campaign, “Open in table” goes the other way.'],
  ['Where do I add keys for enrichment, AI and search?', 'The Integrations page (Data, AI & CRM providers). Every key is optional — most enrichments and all core signals have free built-in sources, and keys are stored encrypted.'],
  ['Where do warmup emails go?', 'They are rescued from spam, marked read and moved into a “Kinetic Warmup” folder in each mailbox. They never appear in the Master Inbox.'],
  ['Do opens count accurately?', 'Opens are approximate — Apple Mail and security scanners load images automatically. Kinetic ignores hits in the first seconds after sending, but replies are the metric to trust. Plain text without tracking gives the best deliverability.'],
];

export function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);
  const sys = useQuery({ queryKey: ['system'], queryFn: () => api.get('/api/system').then((r) => r.data) });
  return (
    <Page>
      <PageHeader title="Help & Support" subtitle="Answers to common questions and where to look when something is off." />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { to: '/developers/docs', icon: BookOpen, title: 'Documentation', text: 'Setup, sequences, warmup and deliverability.' },
          { to: '/developers/api', icon: Code2, title: 'Developer API', text: 'Tokens, examples and the full API reference.' },
          { to: '/sending-schedule', icon: ServerCog, title: 'Sending Schedule', text: 'See what is booked, sent and failing today.' },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-brand-300 hover:bg-brand-50/40">
            <c.icon className="size-5 text-brand-600" />
            <div className="mt-3 font-medium text-slate-900">{c.title}</div>
            <div className="mt-1 text-sm text-slate-500">{c.text}</div>
          </Link>
        ))}
      </div>

      <Card title="Frequently asked questions" className="mt-6" padded={false}>
        <ul className="divide-y divide-slate-100">
          {FAQ.map(([q, a], i) => (
            <li key={q}>
              <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
                <span className="text-sm font-medium text-slate-900">{q}</span>
                <ChevronDown className={cx('size-4 shrink-0 text-slate-400 transition-transform', open === i && 'rotate-180')} />
              </button>
              {open === i && <p className="-mt-1 px-5 pb-4 text-sm leading-relaxed text-slate-600">{a}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="System" className="mt-6">
        <div className="flex items-start gap-3 text-sm text-slate-600">
          <LifeBuoy className="mt-0.5 size-4 text-slate-400" />
          <div className="space-y-1">
            <div>Version <span className="font-mono text-xs">{sys.data?.version}</span></div>
            <div>Public URL <span className="font-mono text-xs">{sys.data?.public_url}</span> — used for tracking, unsubscribe and OAuth links.</div>
            <div>Background worker: {sys.data?.workers ? 'running' : 'off'}</div>
            <div>Data folder <span className="font-mono text-xs">{sys.data?.data_dir}</span> — back this up; it holds the database and encryption key.</div>
          </div>
        </div>
      </Card>
    </Page>
  );
}
