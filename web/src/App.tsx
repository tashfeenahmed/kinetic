import { lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import { UiProvider, Loading } from './components/ui.tsx';
import { AppLayout } from './components/Layout.tsx';
import { isStaleBuildError, reloadForNewBuild } from './components/RouteErrorBoundary.tsx';
import { ChoosePasswordPage, LoginPage, SetupPage } from './pages/Auth.tsx';

// Pages load on demand so the first paint stays small.
// A failed chunk load means this tab is on an older build: reload once to get the new one.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })).catch((e) => {
    if (isStaleBuildError(e) && reloadForNewBuild()) return new Promise<never>(() => {});
    throw e;
  }));
const HomePage = page(() => import('./pages/Home.tsx'), 'HomePage');
const LeadsPage = page(() => import('./pages/Leads.tsx'), 'LeadsPage');
const CampaignsPage = page(() => import('./pages/Campaigns.tsx'), 'CampaignsPage');
const CampaignDetailPage = page(() => import('./pages/CampaignDetail.tsx'), 'CampaignDetailPage');
const InboxPage = page(() => import('./pages/Inbox.tsx'), 'InboxPage');
const SenderEmailsPage = page(() => import('./pages/SenderEmails.tsx'), 'SenderEmailsPage');
const WarmupPage = page(() => import('./pages/Warmup.tsx'), 'WarmupPage');
const SendingSchedulePage = page(() => import('./pages/SendingSchedule.tsx'), 'SendingSchedulePage');
const IntegrationsPage = page(() => import('./pages/Integrations.tsx'), 'IntegrationsPage');
const DocsPage = page(() => import('./pages/Developers.tsx'), 'DocsPage');
const DeveloperApiPage = page(() => import('./pages/Developers.tsx'), 'DeveloperApiPage');
const WebhooksPage = page(() => import('./pages/Developers.tsx'), 'WebhooksPage');
const SettingsPage = page(() => import('./pages/Settings.tsx'), 'SettingsPage');
const HelpPage = page(() => import('./pages/Help.tsx'), 'HelpPage');
const GtmTablePage = page(() => import('./gtm/index.tsx'), 'GtmTablePage');
const GtmSignalsPage = page(() => import('./gtm/index.tsx'), 'GtmSignalsPage');
const GtmActivityPage = page(() => import('./gtm/index.tsx'), 'GtmActivityPage');
const GtmFunctionsPage = page(() => import('./gtm/index.tsx'), 'GtmFunctionsPage');
const VisitorsPage = page(() => import('./pages/Visitors.tsx'), 'VisitorsPage');
const SearchesPage = page(() => import('./pages/Searches.tsx'), 'SearchesPage');
const AgentPage = page(() => import('./pages/Agent.tsx'), 'AgentPage');
const KnowledgePage = page(() => import('./pages/Knowledge.tsx'), 'KnowledgePage');
const AutomationsPage = page(() => import('./pages/automations/AutomationsPage.tsx'), 'AutomationsPage');

/** Redirect keeping the query string (e.g. /searches?tab=exclusions). */
function KeepQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function OldFunctions() {
  const { id } = useParams();
  return <Navigate to={id ? `/settings/functions/${id}` : '/settings/functions'} replace />;
}

function Gate() {
  const { me, loading, needsSetup } = useAuth();
  if (loading) return <Loading />;
  if (needsSetup) return <Routes><Route path="*" element={<SetupPage />} /></Routes>;
  if (!me) return <Routes><Route path="*" element={<LoginPage />} /></Routes>;
  if (me.must_change_password) return <ChoosePasswordPage />;
  return (
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="agent/:sessionId?" element={<AgentPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="tables/:id" element={<GtmTablePage />} />
        <Route path="signals" element={<GtmSignalsPage />} />
        {/* Saved searches, Functions and Activity live under Settings; the old addresses redirect. */}
        <Route path="settings/searches" element={<SearchesPage />} />
        <Route path="settings/functions/:id?" element={<GtmFunctionsPage />} />
        <Route path="settings/activity" element={<GtmActivityPage />} />
        <Route path="searches" element={<KeepQuery to="/settings/searches" />} />
        <Route path="functions/:id?" element={<OldFunctions />} />
        <Route path="activity" element={<Navigate to="/settings/activity" replace />} />
        <Route path="dashboard" element={<Navigate to="/" replace />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:id/:tab?" element={<CampaignDetailPage />} />
        <Route path="automations/*" element={<AutomationsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="domains" element={<Navigate to="/sender-emails" replace />} />
        <Route path="sender-emails" element={<SenderEmailsPage />} />
        <Route path="warmup" element={<WarmupPage />} />
        <Route path="sending-schedule" element={<SendingSchedulePage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="developers" element={<Navigate to="/developers/api" replace />} />
        <Route path="developers/docs" element={<DocsPage />} />
        <Route path="developers/api" element={<DeveloperApiPage />} />
        <Route path="developers/webhooks" element={<WebhooksPage />} />
        <Route path="settings/:section?" element={<SettingsPage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="visitors" element={<VisitorsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <UiProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </UiProvider>
    </BrowserRouter>
  );
}
