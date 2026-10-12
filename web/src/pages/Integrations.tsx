import { Link } from 'react-router';
import { ArrowRight, Code2, Network, Server, Webhook } from 'lucide-react';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Card } from '../components/ui.tsx';
import { BrandIcon } from '../components/BrandIcon.tsx';
import { GtmKeysSection } from '../gtm/index.tsx';
import { OAuthApps } from './integrations/OAuthApps.tsx';
import { IpRoutes } from './integrations/IpRoutes.tsx';
import { SeedAccounts } from './integrations/SeedAccounts.tsx';

const SECTIONS = [
  { id: 'providers', label: 'Data, AI & CRM' },
  { id: 'domains', label: 'Sending domains' },
  { id: 'mailboxes', label: 'Mailbox sign-in' },
  { id: 'sending', label: 'Sending infrastructure' },
  { id: 'automation', label: 'Automation & API' },
];

const TOOLS = [
  { name: 'n8n', domain: 'n8n.io', text: 'HTTP Request node with a Bearer token; Webhook trigger subscribed to events like Lead Interested or Signal Changed.' },
  { name: 'Make', domain: 'make.com', text: 'HTTP module for API calls and a Custom Webhook trigger for replies, bounces and signal changes.' },
  { name: 'Zapier', domain: 'zapier.com', text: '“Webhooks by Zapier”: Catch Hook to receive Kinetic events, Custom Request to call the API.' },
  { name: 'Webhooks', icon: <Webhook className="size-4" />, text: '17 signed event types — sends, replies, interest, bounces, mailbox status, Signal Changed — retried for 24 hours.', to: '/developers/webhooks' },
  { name: 'REST API', icon: <Code2 className="size-4" />, text: 'Everything in the app, including tables. Workspace-scoped tokens, OpenAPI spec and interactive reference.', to: '/developers/api' },
];

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-slate-900">{title}</h2>
        <p className="mt-0.5 text-[13.5px] text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function IntegrationsPage() {
  return (
    <Page wide>
      <PageHeader title="Integrations" subtitle="Every service Kinetic connects to — data providers, AI, search, CRMs, alerts, mailboxes, sending IPs and automation tools." />
      <nav className="sticky top-0 z-10 -mx-1 mb-6 flex gap-1 overflow-x-auto bg-white/90 px-1 py-2 backdrop-blur">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="whitespace-nowrap rounded-full border border-slate-200 px-3 py-1 text-[13px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900">{s.label}</a>
        ))}
      </nav>

      <div className="space-y-10">
        <Section id="providers" title="Data, AI & CRM providers" description="Power your tables: AI research, web search, email finding and verification, company data, signals, Slack, HubSpot and Salesforce. Every key is optional and stored encrypted.">
          <GtmKeysSection />
        </Section>

        <Section id="domains" title="Sending domains" description="Connect Cloudflare (key above, under Email infrastructure) and set up each sending domain's MX, SPF, DKIM and DMARC with Add domain on the Sender Emails page.">
          <Link to="/sender-emails" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800 hover:border-slate-300">
            <BrandIcon domain="cloudflare.com" size={28} /> Open Sender Emails <ArrowRight className="size-4" />
          </Link>
        </Section>

        <Section id="mailboxes" title="Mailbox sign-in" description="Your own Google and Microsoft OAuth apps, so mailboxes can connect with “Sign in with Google/Microsoft”. App passwords and IMAP/SMTP work without this.">
          <div className="mb-3 flex items-center gap-2">
            <BrandIcon domain="google.com" size={32} /><BrandIcon domain="microsoft.com" size={32} />
          </div>
          <OAuthApps />
        </Section>

        <Section id="sending" title="Sending infrastructure" description="Pin mailboxes to fixed IPs or proxies, and keep seed inboxes for inbox placement tests.">
          <div className="space-y-6">
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700"><BrandIcon size={28} fallback={<Network className="size-4" />} /> Sending IPs & proxies</div>
              <IpRoutes />
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
                <BrandIcon size={28} fallback={<Server className="size-4" />} /> Seed inboxes
                <span className="ml-1 flex gap-1"><BrandIcon domain="gmail.com" size={22} /><BrandIcon domain="outlook.com" size={22} /><BrandIcon domain="yahoo.com" size={22} /></span>
              </div>
              <SeedAccounts />
            </div>
          </div>
        </Section>

        <Section id="automation" title="Automation & API" description="Everything else connects through API tokens and signed webhooks.">
          <Card padded>
            <div className="grid gap-4 pb-5 sm:grid-cols-2 xl:grid-cols-3">
              {TOOLS.map((t) => {
                const body = (
                  <div className="h-full rounded-xl border border-slate-200 p-4 transition-colors hover:border-slate-300">
                    <div className="flex items-center gap-2.5">
                      <BrandIcon domain={t.domain} fallback={t.icon} size={32} />
                      <div className="font-semibold text-slate-900">{t.name}</div>
                    </div>
                    <p className="mt-2 text-[13px] text-slate-600">{t.text}</p>
                  </div>
                );
                return t.to ? <Link key={t.name} to={t.to}>{body}</Link> : <div key={t.name}>{body}</div>;
              })}
              <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed border-slate-300 p-4">
                <Link to="/developers/api" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Create an API token <ArrowRight className="size-4" /></Link>
                <Link to="/developers/webhooks" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Set up webhooks <ArrowRight className="size-4" /></Link>
                <Link to="/developers/docs" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Read the docs <ArrowRight className="size-4" /></Link>
              </div>
            </div>
          </Card>
        </Section>
      </div>
    </Page>
  );
}
