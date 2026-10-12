import { Link } from 'react-router';
import { ArrowRight, Blocks, Database, Workflow, Zap, Webhook } from 'lucide-react';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Card } from '../components/ui.tsx';
import { OAuthApps } from './integrations/OAuthApps.tsx';
import { IpRoutes } from './integrations/IpRoutes.tsx';
import { SeedAccounts } from './integrations/SeedAccounts.tsx';

const TOOLS = [
  { name: 'Tables (built in)', icon: Database, text: 'Enrich, research and watch signals in Tables, then push rows straight into campaigns with “Send to campaign”. Replies and interest flow back as an Outreach status column — no Clay needed.' },
  { name: 'n8n', icon: Workflow, text: 'Use the HTTP Request node with a Bearer token, and a Webhook trigger subscribed to events like Lead Interested.' },
  { name: 'Make', icon: Blocks, text: 'Add an HTTP module for API calls and a Custom Webhook as the trigger for reply and bounce events.' },
  { name: 'Zapier', icon: Zap, text: 'Use "Webhooks by Zapier": Catch Hook to receive Kinetic events, Custom Request to call the API.' },
  { name: 'HubSpot / Salesforce', icon: Webhook, text: 'Native from Tables: action columns upsert HubSpot contacts/companies and Salesforce records (keys in Settings → Data, AI & integrations). Webhooks cover anything else.' },
];

export function IntegrationsPage() {
  return (
    <Page wide>
      <PageHeader title="Integrations" subtitle="Mailbox sign-in, sending IPs, placement testing, data providers and the tools you connect." />
      <div className="space-y-6">
        <Card title="Data, AI & CRM providers" description="OpenRouter, search, email finders & verifiers, People Data Labs, Apollo, Slack, HubSpot, Salesforce and more power your Tables. Most have free built-in fallbacks.">
          <Link to="/settings/keys" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Manage providers and keys <ArrowRight className="size-4" /></Link>
        </Card>
        <OAuthApps />
        <IpRoutes />
        <SeedAccounts />
        <Card title="Connect your tools" description="Everything else connects through API tokens and webhooks — including “Signal Changed” events from your tables.">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {TOOLS.map((t) => (
              <div key={t.name} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-700"><t.icon className="size-4" /></div>
                  <div className="font-semibold text-slate-900">{t.name}</div>
                </div>
                <p className="mt-2 text-[13px] text-slate-600">{t.text}</p>
              </div>
            ))}
            <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed border-slate-300 p-4">
              <Link to="/developers/api" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Create an API token <ArrowRight className="size-4" /></Link>
              <Link to="/developers/webhooks" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Set up webhooks <ArrowRight className="size-4" /></Link>
              <Link to="/developers/docs" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline">Read the API docs <ArrowRight className="size-4" /></Link>
            </div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
