import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ExternalLink, KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtDateTime, fmtRelative } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import {
  Alert, Badge, Button, Card, Checkbox, CopyText, Drawer, EmptyState, Field, Input, Loading, Menu, Modal, Pagination, Select, Table, Td, Th, useUi,
} from '../components/ui.tsx';

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-[12.5px] leading-relaxed text-slate-100 scroll-thin"><code>{children}</code></pre>;
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------
function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 border-b border-slate-100 pb-8">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      <div className="space-y-3 text-[14.5px] leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

const TOC = [
  ['tables', 'Tables & enrichment'],
  ['tables-outreach', 'Tables → campaigns → replies'],
  ['quick-start', 'Quick start'], ['mailboxes', 'Connecting mailboxes'], ['dns', 'Domain setup (SPF, DKIM, DMARC)'], ['warmup', 'Warmup'],
  ['sequences', 'Writing sequences'], ['variables', 'Variables & spintax'], ['scheduling', 'How sending is scheduled'], ['inbox', 'Master inbox'],
  ['deliverability', 'Deliverability checklist'], ['ips', 'Sending IPs'], ['api', 'API & webhooks'],
] as const;

export function DocsPage() {
  return (
    <Page>
      <PageHeader title="Documentation" subtitle="Everything you need to run Kinetic: tables, enrichment, signals and cold email." />
      <div className="flex gap-10">
        <nav className="sticky top-6 hidden h-fit w-56 shrink-0 lg:block">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">On this page</div>
          {TOC.map(([id, label]) => <a key={id} href={`#${id}`} className="block rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">{label}</a>)}
        </nav>
        <div className="min-w-0 max-w-3xl flex-1 space-y-8">
          <DocSection id="quick-start" title="Quick start">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li><Link className="text-brand-600 underline" to="/sender-emails">Connect your mailboxes</Link> (Google app passwords, Microsoft sign-in, or any IMAP/SMTP account).</li>
              <li>Check each domain's DNS on the mailbox detail page and fix anything red.</li>
              <li><Link className="text-brand-600 underline" to="/warmup">Enable warmup</Link> and wait 2–4 weeks before real sending on new mailboxes.</li>
              <li><Link className="text-brand-600 underline" to="/leads">Import leads</Link> from CSV and map your columns.</li>
              <li><Link className="text-brand-600 underline" to="/campaigns">Create a campaign</Link>: write the sequence, set the schedule, attach mailboxes and leads, then launch.</li>
              <li>Work replies from the <Link className="text-brand-600 underline" to="/inbox">Master Inbox</Link>.</li>
            </ol>
          </DocSection>
          <DocSection id="tables" title="Tables & enrichment">
            <p><b>Tables</b> are spreadsheets whose columns do work. Start from <Link className="text-brand-600 underline" to="/">Home</Link> — search YC companies, GitHub org people or public job boards for free, import a CSV, or POST rows to a table's webhook.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li><b>Enrichment</b> columns run a waterfall of providers (free ones first: website/GitHub email patterns + SMTP checks, Wikidata, the YC directory) and stop at the first good answer.</li>
              <li><b>AI research</b> columns run an agent with web search (OpenRouter — Claude Haiku 5.5 by default, or free models) and return typed fields with sources.</li>
              <li><b>Signals</b> watch hiring, news, Hacker News, SEC filings, government contracts, tech stack, page changes, GitHub and new subdomains on a schedule; changes appear in <Link className="text-brand-600 underline" to="/signals">Signals</Link>.</li>
              <li><b>Actions</b> post to Slack, webhooks, HubSpot, Salesforce — or into your campaigns.</li>
            </ul>
            <p>Use <span className="font-mono text-sm">{'{{Column}}'}</span> in any input. Auto-run columns re-run when their inputs change; <span className="font-mono text-sm">changed("Column")</span> in a run-if turns them into alerts. Provider keys live in <Link className="text-brand-600 underline" to="/settings/keys">Settings → Data, AI &amp; integrations</Link>.</p>
          </DocSection>
          <DocSection id="tables-outreach" title="Tables → campaigns → replies">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>In a table, click <b>Send to campaign</b>. Map email/name/company, and map AI or enrichment columns to custom variables (e.g. an “Icebreaker” column → <span className="font-mono text-sm">{'{ICEBREAKER}'}</span> in your sequence).</li>
              <li>Each row becomes (or updates) a lead and is attached to the campaign. Blacklisted, bounced and unsubscribed leads are skipped.</li>
              <li>The <b>Outreach status</b> column updates live — queued, contacted, replied, interested, bounced, unsubscribed — as emails send and replies arrive.</li>
              <li>Add an auto-run Slack action with run-if <span className="font-mono text-sm">changed("Outreach status") &amp;&amp; row["Outreach status"] === "interested"</span> to get pinged on hot replies.</li>
              <li>Going the other way, <b>Open in table</b> on the Leads page or a campaign's Leads tab turns leads into a table to enrich; the <b>Sync to lead</b> column writes results back as custom variables.</li>
            </ol>
          </DocSection>
          <DocSection id="mailboxes" title="Connecting mailboxes">
            <p><b>Google Workspace / Gmail:</b> turn on 2-Step Verification, create an app password at <span className="font-mono text-sm">myaccount.google.com/apppasswords</span>, make sure IMAP is enabled, then add the account with the Google option. No Google approval is needed.</p>
            <p><b>Microsoft 365:</b> register your own app in Microsoft Entra (Integrations page explains the steps), grant admin consent in your tenant, then use “Sign in with Microsoft”. Microsoft is turning password SMTP off by default, so OAuth is the reliable option.</p>
            <p><b>Other providers:</b> enter the IMAP and SMTP servers. Every account is tested over SMTP and IMAP before it is saved.</p>
            <p>Keep daily limits around 30–50 emails per mailbox. Spread volume across more mailboxes instead of raising limits.</p>
          </DocSection>
          <DocSection id="dns" title="Domain setup (SPF, DKIM, DMARC)">
            <p>Every sending domain needs:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li><b>MX</b> records so replies arrive.</li>
              <li><b>SPF</b>: one TXT record, e.g. <span className="font-mono text-sm">v=spf1 include:_spf.google.com ~all</span>.</li>
              <li><b>DKIM</b>: enable signing in your provider's admin console and publish the key.</li>
              <li><b>DMARC</b>: TXT at <span className="font-mono text-sm">_dmarc.yourdomain.com</span>, start with <span className="font-mono text-sm">v=DMARC1; p=none</span>.</li>
            </ul>
            <p>Use “Check DNS” on any mailbox to verify. Send from separate domains, not your main company domain.</p>
          </DocSection>
          <DocSection id="warmup" title="Warmup">
            <p>Your warmup-enabled mailboxes email each other with natural conversations. Each mailbox starts at 2 emails a day and adds 2 per day until its warmup limit. When a message lands in spam, Kinetic marks it read and moves it to the inbox — a strong positive signal. Some messages get replies, and handled messages are filed into a <b>Kinetic Warmup</b> folder so your inbox stays clean.</p>
            <p>More mailboxes across more domains and providers make a healthier pool. Keep warmup running at a low level even after you start campaigns.</p>
          </DocSection>
          <DocSection id="sequences" title="Writing sequences">
            <p>A sequence is a list of steps. Step 1 goes out when a lead starts; every later step waits the number of days you set (calendar days in the campaign's timezone). Turn on <b>Reply in same thread</b> to send a follow-up as a reply to the previous email — it keeps the subject and quotes the earlier message.</p>
            <p>Add <b>variants</b> to a step for A/B tests. Leads are split evenly and each lead always sees the same variant. Compare results on the Stats tab and switch off the losers.</p>
            <p>Leads stop receiving emails when they reply (configurable), unsubscribe, bounce, or are blacklisted.</p>
          </DocSection>
          <DocSection id="variables" title="Variables & spintax">
            <ul className="list-disc space-y-1 pl-5">
              <li><span className="font-mono text-sm">{'{FIRST_NAME}'}</span>, <span className="font-mono text-sm">{'{COMPANY}'}</span>, <span className="font-mono text-sm">{'{TITLE}'}</span>, <span className="font-mono text-sm">{'{SENDER_FIRST_NAME}'}</span>, plus any custom CSV column, e.g. <span className="font-mono text-sm">{'{CITY}'}</span>.</li>
              <li>Fallbacks: <span className="font-mono text-sm">{'{FIRST_NAME|there}'}</span> uses “there” when the name is empty.</li>
              <li>Spintax: <span className="font-mono text-sm">{'{Hi|Hello|Hey}'}</span> picks one option per lead.</li>
              <li><span className="font-mono text-sm">{'{SIGNATURE}'}</span> places the mailbox signature (otherwise it is added at the end). <span className="font-mono text-sm">{'{UNSUBSCRIBE_LINK}'}</span> inserts the opt-out link.</li>
            </ul>
          </DocSection>
          <DocSection id="scheduling" title="How sending is scheduled">
            <p>When a campaign's sending window opens, Kinetic books today's emails: it respects each mailbox's daily limit (shared across campaigns), the campaign's daily and new-lead limits, and the per-domain cap. Emails are spread evenly through the rest of the window with random gaps, and a lead always stays on the same mailbox. See everything on the <Link className="text-brand-600 underline" to="/sending-schedule">Sending Schedule</Link> page.</p>
          </DocSection>
          <DocSection id="inbox" title="Master inbox">
            <p>All mailboxes are synced over IMAP every couple of minutes. Replies are matched to the email they answer, categorised (interested, not interested, unsubscribe, auto reply, bounce) and the lead's campaign is updated. Out-of-office replies never stop a sequence. Add <Link className="text-brand-600 underline" to="/settings/ignore-phrases">ignore phrases</Link> for automated messages you want to skip.</p>
          </DocSection>
          <DocSection id="deliverability" title="Deliverability checklist">
            <ul className="list-disc space-y-1 pl-5">
              <li>SPF, DKIM and DMARC pass on every domain.</li>
              <li>30–50 emails per mailbox per day, 2–3 mailboxes per domain.</li>
              <li>Plain text, no tracking pixel, few links in the first email.</li>
              <li>Verify your lists; keep bounces under 2% and spam complaints under 0.3%.</li>
              <li>Run inbox placement tests before big launches.</li>
            </ul>
          </DocSection>
          <DocSection id="ips" title="Sending IPs">
            <p>Mail is delivered by Google or Microsoft, so their IPs do the sending. What you control is the address your server logs in from. Add a static IP or SOCKS5 proxy in <Link className="text-brand-600 underline" to="/integrations">Integrations</Link> and assign mailboxes to it (about 30 per IP). Never change a mailbox's IP once it is in use.</p>
          </DocSection>
          <DocSection id="api" title="API & webhooks">
            <p>Everything in the app is available over a REST API. Create a token on the <Link className="text-brand-600 underline" to="/developers/api">Developer API</Link> page and browse the <a className="text-brand-600 underline" href="/api/reference" target="_blank" rel="noreferrer">API reference</a>. Subscribe to events on <Link className="text-brand-600 underline" to="/developers/webhooks">Webhooks & Listeners</Link>.</p>
          </DocSection>
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Developer API
// ---------------------------------------------------------------------------
export function DeveloperApiPage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('api-user');
  const [created, setCreated] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get('/api/api-tokens').then((r) => r.data as any[]) });

  const create = useMutation({
    mutationFn: () => api.post('/api/api-tokens', { name, type }),
    onSuccess: (r) => { setCreated(r.data.plain_text_token); setCreating(false); setName(''); qc.invalidateQueries({ queryKey: ['api-tokens'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const revoke = async (t: any) => {
    if (!(await confirm({ title: `Revoke “${t.name}”?`, message: 'Apps using this token will stop working immediately.', confirmLabel: 'Revoke', danger: true }))) return;
    await api.del(`/api/api-tokens/${t.id}`);
    qc.invalidateQueries({ queryKey: ['api-tokens'] });
    toast('Token revoked');
  };
  const origin = window.location.origin;

  return (
    <Page>
      <PageHeader
        title="Developer API"
        subtitle="A REST API for leads, campaigns, replies and automation. Anything you can do in the app, you can script."
        actions={<>
          <a href="/api/reference" target="_blank" rel="noreferrer"><Button icon={<ExternalLink className="size-4" />}>API reference</Button></a>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New API token</Button>
        </>}
      />
      {created && (
        <div className="mb-6">
          <Alert tone="green" title="Copy your new token now — it won't be shown again">
            <div className="mt-2"><CopyText value={created} /></div>
          </Alert>
        </div>
      )}
      <Card title="API tokens" padded={false}>
        {tokens.isLoading ? <Loading /> : tokens.data?.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No API tokens yet" description="Create a token to connect Clay, n8n, Make or your own scripts." action={<Button variant="primary" onClick={() => setCreating(true)}>New API token</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Type</Th><Th>Token</Th><Th>Last used</Th><Th>Created</Th><Th /></tr></thead>
            <tbody>
              {tokens.data?.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium text-slate-900">{t.name}</Td>
                  <Td><Badge tone={t.type === 'super-admin' ? 'purple' : 'gray'}>{t.type}</Badge></Td>
                  <Td className="font-mono text-xs">{t.token_prefix}…</Td>
                  <Td>{t.last_used_at ? fmtRelative(t.last_used_at) : 'Never'}</Td>
                  <Td>{fmtDateTime(t.created_at)}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => revoke(t)}>Revoke</Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Authentication">
          <p className="mb-3 text-sm text-slate-600">Send the token as a Bearer header. <b>api-user</b> tokens only access the workspace they were created in; <b>super-admin</b> tokens follow your current workspace.</p>
          <Code>{`curl ${origin}/api/leads \\\n  -H "Authorization: Bearer YOUR_API_TOKEN"`}</Code>
        </Card>
        <Card title="Create a lead">
          <Code>{`curl ${origin}/api/leads \\\n  -X POST \\\n  -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"email":"jane@acme.com","first_name":"Jane",\n       "company":"Acme","custom_variables":[{"name":"City","value":"Austin"}]}'`}</Code>
        </Card>
        <Card title="Add leads to a campaign">
          <Code>{`curl ${origin}/api/campaigns/CAMPAIGN_ID/leads/attach-leads \\\n  -X POST \\\n  -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"lead_ids":[1,2,3]}'`}</Code>
        </Card>
        <Card title="Errors & limits">
          <ul className="space-y-2 text-sm text-slate-600">
            <li><Badge tone="red">401</Badge> <span className="font-mono text-xs">{'{"error":"invalid_token"}'}</span> — missing or wrong token.</li>
            <li><Badge tone="yellow">422</Badge> <span className="font-mono text-xs">{'{"error":"validation_error","fields":{…}}'}</span> — fix the listed fields.</li>
            <li><Badge tone="gray">404</Badge> <span className="font-mono text-xs">{'{"error":"not_found"}'}</span> — wrong id or another workspace's data.</li>
            <li>Paginated lists accept <span className="font-mono text-xs">page</span> and <span className="font-mono text-xs">per_page</span> (max 500) and return <span className="font-mono text-xs">meta.total</span>.</li>
          </ul>
        </Card>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="New API token" size="sm"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create token</Button></>}>
        <div className="space-y-4">
          <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Clay, n8n, CRM sync…" /></Field>
          <Field label="Type" hint={type === 'api-user' ? 'Recommended. Scoped to this workspace only.' : 'Acts as you in whichever workspace you have selected.'}>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="api-user">api-user (this workspace)</option>
              <option value="super-admin">super-admin (all your workspaces)</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
function WebhookModal({ open, onClose, hook, types }: { open: boolean; onClose: () => void; hook: any | null; types: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [events, setEvents] = useState<string[]>(hook?.events ?? ['LEAD_REPLIED', 'LEAD_INTERESTED']);
  const save = useMutation({
    mutationFn: () => (hook ? api.put(`/api/webhook-url/${hook.id}`, { name, url, events }) : api.post('/api/webhook-url', { name, url, events })),
    onSuccess: () => { toast(hook ? 'Webhook updated' : 'Webhook created'); qc.invalidateQueries({ queryKey: ['webhooks'] }); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const toggle = (id: string) => setEvents((ev) => (ev.includes(id) ? ev.filter((x) => x !== id) : [...ev, id]));
  return (
    <Modal open={open} onClose={onClose} title={hook ? 'Edit webhook' : 'New webhook'} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!name.trim() || !url.trim() || !events.length} onClick={() => save.mutate()}>{hook ? 'Save' : 'Create webhook'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Slack, CRM, n8n…" /></Field>
          <Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-app.com/webhooks/kinetic" /></Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Events</span>
            <button className="text-xs font-medium text-brand-600" onClick={() => setEvents(events.length === types.length ? [] : types.map((t) => t.id))}>{events.length === types.length ? 'Clear all' : 'Select all'}</button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {types.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                <Checkbox checked={events.includes(t.id)} onChange={() => toggle(t.id)} />
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DeliveryDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const d = useQuery({ queryKey: ['delivery', id], queryFn: () => api.get(`/api/webhook-deliveries/${id}`).then((r) => r.data), enabled: !!id });
  const retry = useMutation({
    mutationFn: () => api.post(`/api/webhook-deliveries/${id}/retry`),
    onSuccess: (r) => { toast(r.data.ok ? 'Delivered' : 'Still failing', r.data.ok ? 'success' : 'error'); qc.invalidateQueries({ queryKey: ['delivery', id] }); qc.invalidateQueries({ queryKey: ['deliveries'] }); },
  });
  return (
    <Drawer open={!!id} onClose={onClose} title={d.data ? d.data.event_type : 'Delivery'} subtitle={d.data && fmtDateTime(d.data.created_at)}
      actions={<Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>Retry now</Button>}>
      {!d.data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex gap-2"><DeliveryStatus s={d.data.status} /><Badge>{d.data.attempts} attempts</Badge>{d.data.next_attempt_at && <Badge tone="blue">Next retry {fmtRelative(d.data.next_attempt_at)}</Badge>}</div>
          <div>
            <div className="mb-2 text-sm font-medium text-slate-700">Payload</div>
            <Code>{JSON.stringify(d.data.payload, null, 2)}</Code>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium text-slate-700">Attempts</div>
            <div className="space-y-2">
              {d.data.attempts_log.map((a: any) => (
                <div key={a.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{a.response_status ? `HTTP ${a.response_status}` : 'No response'}</span>
                    <span className="text-xs text-slate-500">{fmtDateTime(a.created_at)} · {a.duration_ms} ms</span>
                  </div>
                  {(a.error || a.response_body) && <div className="mt-1 break-all font-mono text-xs text-slate-500">{a.error ?? a.response_body}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

const DeliveryStatus = ({ s }: { s: string }) => <Badge tone={s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : 'yellow'}>{s}</Badge>;

export function WebhooksPage() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [testing, setTesting] = useState<any | null>(null);
  const [testType, setTestType] = useState('LEAD_REPLIED');
  const [page, setPage] = useState(1);
  const [delivery, setDelivery] = useState<number | null>(null);
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get('/api/webhook-url').then((r) => r.data as any[]) });
  const types = useQuery({ queryKey: ['webhook-types'], queryFn: () => api.get('/api/webhook-events/event-types').then((r) => r.data as { id: string; name: string }[]) });
  const deliveries = useQuery({ queryKey: ['deliveries', page], queryFn: () => api.get('/api/webhook-deliveries', { page, per_page: 20 }), refetchInterval: 15_000 });
  const sample = useQuery({ queryKey: ['sample', testType], queryFn: () => api.get('/api/webhook-events/sample-payload', { event_type: testType }).then((r) => r.data), enabled: !!testing });
  const test = useMutation({
    mutationFn: () => api.post('/api/webhook-events/test-event', { event_type: testType, url: testing.url }),
    onSuccess: (r) => toast(r.data.ok ? `Test delivered (HTTP ${r.data.status})` : `Endpoint answered HTTP ${r.data.status}`, r.data.ok ? 'success' : 'error'),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (h: any) => {
    if (!(await confirm({ title: `Delete “${h.name}”?`, confirmLabel: 'Delete', danger: true }))) return;
    await api.del(`/api/webhook-url/${h.id}`);
    qc.invalidateQueries({ queryKey: ['webhooks'] });
  };
  const typeName = (id: string) => types.data?.find((t) => t.id === id)?.name ?? id;

  return (
    <Page>
      <PageHeader title="Webhooks & Listeners" subtitle="Get notified the moment something happens — replies, interest, bounces, unsubscribes and more."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>New webhook</Button>} />

      <Card title="Endpoints" padded={false}>
        {hooks.isLoading ? <Loading /> : hooks.data?.length === 0 ? (
          <EmptyState icon={<Webhook className="size-5" />} title="No webhooks yet" description="Send events to Slack, your CRM, n8n, Make or Zapier." action={<Button variant="primary" onClick={() => setEditing(null)}>New webhook</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>Name</Th><Th>URL</Th><Th>Events</Th><Th>Signing secret</Th><Th /></tr></thead>
            <tbody>
              {hooks.data?.map((h) => (
                <tr key={h.id}>
                  <Td className="font-medium text-slate-900">{h.name}</Td>
                  <Td className="max-w-xs truncate font-mono text-xs">{h.url}</Td>
                  <Td><div className="flex max-w-md flex-wrap gap-1">{h.events.map((e: string) => <Badge key={e}>{typeName(e)}</Badge>)}</div></Td>
                  <Td><CopyText value={h.secret} className="max-w-40" /></Td>
                  <Td className="text-right">
                    <Menu trigger={(t) => <Button size="sm" onClick={t}>Manage</Button>} items={[
                      { label: 'Send test event', icon: <Send className="size-4" />, onClick: () => setTesting(h) },
                      { label: 'Edit', onClick: () => setEditing(h) },
                      'divider',
                      { label: 'Delete', danger: true, icon: <Trash2 className="size-4" />, onClick: () => remove(h) },
                    ]} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Recent deliveries" description="Failed deliveries are retried up to five times over 24 hours." className="mt-6" padded={false}>
        {deliveries.data?.data.length === 0 ? <EmptyState title="No deliveries yet" description="Deliveries appear here as events happen." /> : (
          <>
            <Table>
              <thead><tr><Th>Event</Th><Th>Webhook</Th><Th>Status</Th><Th>Attempts</Th><Th>Created</Th></tr></thead>
              <tbody>
                {deliveries.data?.data.map((d: any) => (
                  <tr key={d.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setDelivery(d.id)}>
                    <Td className="font-medium text-slate-900">{typeName(d.event_type)}</Td>
                    <Td>{d.webhook_name}</Td>
                    <Td><DeliveryStatus s={d.status} /></Td>
                    <Td>{d.attempts}</Td>
                    <Td>{fmtRelative(d.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination meta={deliveries.data?.meta} onPage={setPage} />
          </>
        )}
      </Card>

      <Card title="Verifying requests" className="mt-6">
        <p className="mb-3 text-sm text-slate-600">Every request carries <span className="font-mono text-xs">X-Kinetic-Event</span> and an HMAC signature of the raw body using the webhook's signing secret:</p>
        <Code>{`// Node.js
import crypto from 'node:crypto';
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-kinetic-signature']));`}</Code>
        <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-500"><BookOpen className="size-4" /> Payloads look like <span className="font-mono text-xs">{'{ "event": { "type", "name", "workspace_id", … }, "data": { … } }'}</span>.</p>
      </Card>

      {editing !== undefined && <WebhookModal open hook={editing} types={types.data ?? []} onClose={() => setEditing(undefined)} />}
      <Modal open={!!testing} onClose={() => setTesting(null)} title="Send a test event" description={testing?.url} size="lg"
        footer={<><Button onClick={() => setTesting(null)}>Close</Button><Button variant="primary" icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>Send test</Button></>}>
        <div className="space-y-4">
          <Field label="Event type">
            <Select value={testType} onChange={(e) => setTestType(e.target.value)}>
              {types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          {sample.data && <Code>{JSON.stringify(sample.data, null, 2)}</Code>}
        </div>
      </Modal>
      <DeliveryDrawer id={delivery} onClose={() => setDelivery(null)} />
    </Page>
  );
}
