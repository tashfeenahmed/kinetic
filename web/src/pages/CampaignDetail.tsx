import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, AtSign, BarChart3, CalendarDays, ChevronDown, CircleCheck, Circle, Copy, Inbox, ListOrdered, MessageSquare, Pause, Pencil, Play, Rocket, Settings, Trash2, Users,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { Page, PageHeader } from '../components/Layout.tsx';
import { Alert, Button, EmptyState, Field, Input, Loading, Menu, Modal, Tabs, useUi } from '../components/ui.tsx';
import { CampaignStatus } from '../components/status.tsx';
import { useCampaignActions } from './Campaigns.tsx';
import type { Campaign } from './campaign/types.ts';
import { LeadsTab } from './campaign/LeadsTab.tsx';
import { SequenceTab } from './campaign/SequenceTab.tsx';
import { ScheduleTab } from './campaign/ScheduleTab.tsx';
import { SettingsTab } from './campaign/SettingsTab.tsx';
import { StatsTab } from './campaign/StatsTab.tsx';
import { RepliesTab } from './campaign/RepliesTab.tsx';
import { SendersTab } from './campaign/SendersTab.tsx';
import { PlacementTab } from './campaign/PlacementTab.tsx';

const TABS = [
  { id: 'leads', label: 'Leads', icon: <Users className="size-4" />, subtitle: 'Manage your campaign contacts' },
  { id: 'sequence', label: 'Sequence', icon: <ListOrdered className="size-4" />, subtitle: 'Write the emails each lead receives, step by step' },
  { id: 'schedule', label: 'Schedule', icon: <CalendarDays className="size-4" />, subtitle: 'Choose the days and hours emails go out' },
  { id: 'settings', label: 'Settings', icon: <Settings className="size-4" />, subtitle: 'Sending limits, tracking and behaviour' },
  { id: 'stats', label: 'Stats', icon: <BarChart3 className="size-4" />, subtitle: 'How this campaign is performing' },
  { id: 'replies', label: 'Replies', icon: <MessageSquare className="size-4" />, subtitle: 'Replies received from leads in this campaign' },
  { id: 'sender-emails', label: 'Sender Emails', icon: <AtSign className="size-4" />, subtitle: 'Mailboxes this campaign sends from' },
  { id: 'placement', label: 'Inbox Placement Tests', icon: <Inbox className="size-4" />, subtitle: 'Check whether your emails land in the inbox or spam' },
] as const;

function LaunchChecklist({ campaign }: { campaign: Campaign }) {
  const check = useQuery({
    queryKey: ['campaign', campaign.id, 'launch-check'],
    queryFn: () => api.get(`/api/campaigns/${campaign.id}/launch-check`).then((r) => r.data.problems as string[]),
  });
  if (!check.data) return null;
  const items = [
    { label: 'Write the sequence', tab: 'sequence', done: !check.data.some((p) => /step/i.test(p)) },
    { label: 'Attach sender emails', tab: 'sender-emails', done: !check.data.some((p) => /sender/i.test(p)) },
    { label: 'Add leads', tab: 'leads', done: !check.data.some((p) => /leads/i.test(p)) },
  ];
  const ready = check.data.length === 0;
  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">{ready ? 'Ready to launch' : 'Before you launch'}</div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            {items.map((it) => (
              <Link key={it.label} to={`/campaigns/${campaign.id}/${it.tab}`} className="flex items-center gap-1.5 text-sm text-slate-700 hover:text-brand-600">
                {it.done ? <CircleCheck className="size-4 text-emerald-600" /> : <Circle className="size-4 text-slate-400" />}
                <span className={it.done ? 'text-slate-500 line-through' : ''}>{it.label}</span>
              </Link>
            ))}
          </div>
          {!ready && check.data.length > 0 && <div className="mt-2 text-xs text-slate-500">{check.data[0]}</div>}
        </div>
        {ready && <div className="text-xs text-slate-500">Also set the <Link className="text-brand-600 hover:underline" to={`/campaigns/${campaign.id}/schedule`}>schedule</Link> before launching.</div>}
      </div>
    </div>
  );
}

function RenameModal({ campaign, open, onClose }: { campaign: Campaign; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(campaign.name);
  const qc = useQueryClient();
  const { toast } = useUi();
  const save = useMutation({
    mutationFn: () => api.patch(`/api/campaigns/${campaign.id}/update`, { name: name.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaign', campaign.id] }); qc.invalidateQueries({ queryKey: ['campaigns'] }); toast('Campaign renamed'); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Rename campaign" size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && save.mutate()} /></Field>
    </Modal>
  );
}

export function CampaignDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const tab = (TABS.find((t) => t.id === params.tab)?.id ?? 'leads') as (typeof TABS)[number]['id'];
  const navigate = useNavigate();
  const actions = useCampaignActions();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launchProblems, setLaunchProblems] = useState<string[]>([]);
  const qc = useQueryClient();
  const { toast } = useUi();

  const q = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get(`/api/campaigns/${id}`).then((r) => r.data as Campaign),
    refetchInterval: 30_000,
  });

  if (q.isLoading) return <Page><Loading /></Page>;
  if (!q.data) {
    return (
      <Page>
        <EmptyState title="Campaign not found" description="It may have been deleted." action={<Button onClick={() => navigate('/campaigns')}>Back to campaigns</Button>} />
      </Page>
    );
  }
  const c = q.data;
  const current = TABS.find((t) => t.id === tab)!;

  const primary = async () => {
    setBusy(true);
    setLaunchProblems([]);
    try {
      if (c.status === 'active') await actions.pause(c);
      else if (c.status === 'draft') {
        try {
          await api.post(`/api/campaigns/${c.id}/launch`);
          toast('Campaign launched — sending starts in the next window');
          qc.invalidateQueries({ queryKey: ['campaign', c.id] });
          qc.invalidateQueries({ queryKey: ['campaigns'] });
        } catch (e: any) {
          setLaunchProblems(e?.problems?.length ? e.problems : [errorMessage(e)]);
        }
      } else await actions.resume(c);
    } finally {
      setBusy(false);
    }
  };

  const primaryButton = c.status === 'active'
    ? <Button icon={<Pause className="size-4" />} loading={busy} onClick={primary}>Pause campaign</Button>
    : c.status === 'draft'
      ? <Button variant="primary" icon={<Rocket className="size-4" />} loading={busy} onClick={primary}>Launch campaign</Button>
      : c.status === 'archived' ? null
        : <Button variant="primary" icon={<Play className="size-4" />} loading={busy} onClick={primary}>{c.status === 'completed' ? 'Reactivate campaign' : 'Resume Campaign'}</Button>;

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Campaigns', to: '/campaigns' }, { label: c.name }]}
        title={c.name}
        badge={<CampaignStatus status={c.status} />}
        subtitle={current.subtitle}
        actions={<>
          {primaryButton}
          <Menu
            trigger={(toggle) => <Button onClick={toggle}>Actions <ChevronDown className="size-4" /></Button>}
            items={[
              { label: 'Rename', icon: <Pencil className="size-4" />, onClick: () => setRenaming(true) },
              { label: 'Duplicate', icon: <Copy className="size-4" />, onClick: async () => { const d = await actions.duplicate(c); if (d) navigate(`/campaigns/${d.id}/sequence`); } },
              { label: 'Archive', icon: <Archive className="size-4" />, onClick: () => actions.archive(c), disabled: c.status === 'archived' },
              'divider',
              { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onClick: async () => { if (await actions.remove(c)) navigate('/campaigns'); } },
            ]}
          />
        </>}
      />

      {launchProblems.length > 0 && (
        <div className="mb-4">
          <Alert tone="red" title="This campaign can't launch yet">
            <ul className="mt-1 list-disc space-y-0.5 pl-4">{launchProblems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Alert>
        </div>
      )}
      {c.status === 'draft' && <LaunchChecklist campaign={c} />}
      {c.status === 'active' && c.next_window && Date.parse(c.next_window.start) > Date.now() && (
        <div className="mb-4">
          <Alert tone="blue">Outside sending hours — the next window opens {fmtDateTime(c.next_window.start)}.</Alert>
        </div>
      )}

      <Tabs className="mb-6" items={TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))} value={tab} onChange={(t) => navigate(`/campaigns/${c.id}/${t}`)} />

      {tab === 'leads' && <LeadsTab campaign={c} />}
      {tab === 'sequence' && <SequenceTab campaign={c} />}
      {tab === 'schedule' && <ScheduleTab campaign={c} />}
      {tab === 'settings' && <SettingsTab campaign={c} />}
      {tab === 'stats' && <StatsTab campaign={c} />}
      {tab === 'replies' && <RepliesTab campaign={c} />}
      {tab === 'sender-emails' && <SendersTab campaign={c} />}
      {tab === 'placement' && <PlacementTab campaign={c} />}

      {renaming && <RenameModal campaign={c} open onClose={() => setRenaming(false)} />}
    </Page>
  );
}
