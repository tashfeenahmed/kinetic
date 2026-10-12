import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { Page, PageHeader } from '../../components/Layout.tsx';
import { Badge, Button, Tabs } from '../../components/ui.tsx';
import { Overview } from './Overview.tsx';
import { Catalogue } from './Catalogue.tsx';
import { JobsList } from './Jobs.tsx';
import { LinkedInCampaignDetail, LinkedInCampaigns } from './LinkedInCampaigns.tsx';
import { Monitors } from './Monitors.tsx';
import { Approvals } from './Approvals.tsx';
import { Limits } from './Limits.tsx';
import { Extension } from './Extension.tsx';
import { useCompanionStatus } from './shared.tsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'campaigns', label: 'LinkedIn campaigns' },
  { id: 'monitors', label: 'Post monitors' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'limits', label: 'Limits & safety' },
  { id: 'extension', label: 'Extension' },
];

/** /automations/:tab and /automations/campaigns/:id — PhantomBuster-style automations run by the Companion extension. */
export function AutomationsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [tab = 'overview', sub] = (params['*'] ?? '').split('/').filter(Boolean);
  const active = TABS.some((t) => t.id === tab) ? tab : 'overview';
  const status = useCompanionStatus();
  const approvals = useQuery({
    queryKey: ['automations', 'approvals', 'pending'],
    queryFn: () => api.get<{ data: unknown[] }>('/api/automations/approvals', { status: 'pending' }).then((r) => r.data.length),
    refetchInterval: 30_000,
  });
  const devices = status.data?.devices.length ?? 0;
  const campaignId = active === 'campaigns' && sub ? Number(sub) : null;

  return (
    <Page wide>
      <PageHeader
        title="Automations"
        badge={status.data && (devices
          ? <Badge tone={status.data.online ? 'green' : 'gray'} dot>{status.data.online ? 'Extension online' : 'Extension offline'}</Badge>
          : <Badge tone="yellow">Extension not paired</Badge>)}
        subtitle="Scrape LinkedIn, Sales Navigator, Instagram, X, Facebook, Reddit and GitHub into tables, and run LinkedIn outreach from your own browser — at human pace, within safe limits."
        actions={<Button variant="primary" icon={<LayoutGrid className="size-4" />} onClick={() => navigate('/automations/catalogue')}>New automation</Button>}
      />
      <Tabs className="mb-6" value={active} onChange={(id) => navigate(id === 'overview' ? '/automations' : `/automations/${id}`)}
        items={TABS.map((t) => (t.id === 'approvals' && approvals.data ? { ...t, count: approvals.data } : t))} />
      {active === 'overview' && <Overview />}
      {active === 'catalogue' && <Catalogue />}
      {active === 'jobs' && <JobsList emptyAction={<Button variant="primary" onClick={() => navigate('/automations/catalogue')}>Browse the catalogue</Button>} />}
      {active === 'campaigns' && (campaignId ? <LinkedInCampaignDetail key={campaignId} id={campaignId} /> : <LinkedInCampaigns />)}
      {active === 'monitors' && <Monitors />}
      {active === 'approvals' && <Approvals />}
      {active === 'limits' && <Limits />}
      {active === 'extension' && <Extension />}
    </Page>
  );
}
