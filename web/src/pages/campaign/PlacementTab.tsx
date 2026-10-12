import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Inbox, Play } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, Loading, Modal, ProgressBar, Select, Table, Td, Th, cx, useUi, type Tone } from '../../components/ui.tsx';
import type { Campaign, Step } from './types.ts';

interface Summary {
  total: number; inbox: number; spam: number; missing: number; pending: number; inbox_rate: number;
  by_provider: Record<string, { inbox: number; spam: number; missing: number; pending: number }>;
  results?: { id: number; sender_email: string; seed_email: string; seed_provider: string; result: string; error: string | null }[];
}
interface PlacementTest { id: number; name: string; status: 'sending' | 'waiting' | 'completed' | 'failed'; created_at: string; completed_at: string | null; summary: Summary }

const RESULT: Record<string, [string, Tone]> = { inbox: ['Inbox', 'green'], spam: ['Spam', 'red'], missing: ['Not delivered', 'gray'], send_failed: ['Send failed', 'red'], pending: ['Checking…', 'blue'] };

function TestRow({ test }: { test: PlacementTest }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ['placement-test', test.id],
    queryFn: () => api.get(`/api/placement-tests/${test.id}`).then((r) => r.data as PlacementTest),
    enabled: open,
    refetchInterval: open && test.status === 'waiting' ? 10_000 : false,
  });
  const s = test.summary;
  const tone = s.inbox_rate >= 80 ? 'green' : s.inbox_rate >= 50 ? 'yellow' : 'red';
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen((o) => !o)}>
        <Td className="w-8 pr-0">{open ? <ChevronDown className="size-4 text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" />}</Td>
        <Td>
          <div className="font-medium text-slate-900">{test.name}</div>
          <div className="text-xs text-slate-500">{fmtDateTime(test.created_at)}</div>
        </Td>
        <Td>{test.status === 'completed' ? <Badge tone="green">Completed</Badge> : test.status === 'failed' ? <Badge tone="red">Failed</Badge> : <Badge tone="blue">Checking inboxes…</Badge>}</Td>
        <Td className="w-48">
          {s.total - s.pending > 0 ? (
            <div className="flex items-center gap-2">
              <ProgressBar value={s.inbox_rate} tone={tone} />
              <span className="w-10 text-right text-sm font-medium tabular-nums">{s.inbox_rate}%</span>
            </div>
          ) : <span className="text-sm text-slate-400">—</span>}
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(s.by_provider).map(([p, c]) => (
              <span key={p} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                <span className="font-medium capitalize">{p}</span>
                <span className="text-emerald-600">{c.inbox}✓</span>
                {c.spam > 0 && <span className="text-red-600">{c.spam} spam</span>}
                {c.missing > 0 && <span className="text-slate-500">{c.missing} missing</span>}
              </span>
            ))}
          </div>
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="border-b border-slate-100 bg-slate-50/60 px-6 py-3">
            {!detail.data ? <Loading /> : (
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {detail.data.summary.results?.map((r) => {
                  const [label, t] = RESULT[r.result] ?? [r.result, 'gray' as Tone];
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs ring-1 ring-slate-200" title={r.error ?? undefined}>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-700">{r.sender_email}</div>
                        <div className="truncate text-slate-500">→ {r.seed_email} ({r.seed_provider})</div>
                      </div>
                      <Badge tone={t}>{label}</Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RunTestModal({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [stepId, setStepId] = useState('');
  const senders = useQuery({ queryKey: ['campaign', campaign.id, 'senders'], queryFn: () => api.get(`/api/campaigns/${campaign.id}/sender-emails`).then((r) => r.data as { id: number; email: string; status: string }[]) });
  const seq = useQuery({ queryKey: ['campaign', campaign.id, 'sequence'], queryFn: () => api.get(`/api/campaigns/${campaign.id}/sequence`).then((r) => r.data as { steps: Step[] }) });
  useEffect(() => {
    if (senders.data && picked.size === 0) setPicked(new Set(senders.data.filter((s) => s.status === 'Connected').slice(0, 10).map((s) => s.id)));
  }, [senders.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: () => api.post('/api/placement-tests', { campaign_id: campaign.id, sender_email_ids: [...picked], sequence_step_id: stepId ? Number(stepId) : undefined }),
    onSuccess: () => { toast('Test emails sent — results appear over the next few minutes'); qc.invalidateQueries({ queryKey: ['placement-tests', campaign.id] }); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const stepOptions = (seq.data?.steps ?? []).flatMap((s, i) => [s, ...s.variants].map((v, vi) => ({ id: v.id, label: `Step ${i + 1}${s.variants.length ? ` · Variant ${String.fromCharCode(65 + vi)}` : ''}${v.email_subject ? ` — ${v.email_subject}` : ''}` })));

  return (
    <Modal open onClose={onClose} title="Run an inbox placement test" description="Sends the chosen step from each mailbox to every seed inbox, then checks where it landed." size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Play className="size-4" />} disabled={!picked.size} loading={run.isPending} onClick={() => run.mutate()}>Send test emails</Button></>}>
      <div className="space-y-4">
        <Field label="Email to test">
          <Select value={stepId} onChange={(e) => setStepId(e.target.value)}>
            <option value="">Step 1 (main variant)</option>
            {stepOptions.filter((o) => o.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-medium text-slate-700">Send from</div>
          {senders.isLoading ? <Loading /> : !senders.data?.length ? (
            <Alert tone="yellow">Attach sender emails to this campaign first.</Alert>
          ) : (
            <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200 scroll-thin">
              {senders.data.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-0 hover:bg-slate-50">
                  <Checkbox checked={picked.has(s.id)} onChange={(v) => setPicked((p) => { const n = new Set(p); v ? n.add(s.id) : n.delete(s.id); return n; })} />
                  <span className={cx('flex-1 truncate', s.status !== 'Connected' && 'text-slate-400')}>{s.email}</span>
                  {s.status !== 'Connected' && <Badge tone="red">{s.status}</Badge>}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function PlacementTab({ campaign }: { campaign: Campaign }) {
  const [running, setRunning] = useState(false);
  const seeds = useQuery({ queryKey: ['seed-accounts'], queryFn: () => api.get('/api/seed-accounts').then((r) => r.data as { id: number; provider: string; email: string }[]) });
  const tests = useQuery({
    queryKey: ['placement-tests', campaign.id],
    queryFn: () => api.get('/api/placement-tests', { campaign_id: campaign.id }).then((r) => r.data as PlacementTest[]),
    refetchInterval: (q) => (q.state.data?.some((t) => t.status === 'waiting' || t.status === 'sending') ? 10_000 : false),
  });
  const noSeeds = seeds.data && seeds.data.length === 0;
  const providers = [...new Set(seeds.data?.map((s) => s.provider) ?? [])];

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl text-sm text-slate-600">
            Before sending at volume, check where this campaign's email lands. Kinetic sends it from your mailboxes to seed inboxes you own
            {providers.length ? <> ({providers.map((p) => <span key={p} className="capitalize">{p}</span>).reduce((a: React.ReactNode[], b, i) => (i ? [...a, ', ', b] : [b]), [])})</> : null}
            {' '}and checks over IMAP whether each copy reached the inbox or spam. Results usually arrive within 5 minutes.
          </div>
          <Button variant="primary" icon={<Play className="size-4" />} disabled={!!noSeeds} onClick={() => setRunning(true)}>Run test</Button>
        </div>
        {noSeeds && (
          <div className="mt-4">
            <Alert tone="yellow" title="Add seed inboxes first" action={<Link to="/integrations" className="whitespace-nowrap text-sm font-medium text-amber-900 underline">Go to Integrations</Link>}>
              Seed inboxes are test mailboxes (e.g. a personal Gmail, Outlook and Yahoo account) that Kinetic can read over IMAP.
            </Alert>
          </div>
        )}
      </Card>

      <Card padded={false}>
        {tests.isLoading ? <Loading /> : !tests.data?.length ? (
          <EmptyState icon={<Inbox className="size-5" />} title="No placement tests yet" description="Run one before launching and again whenever you change your copy or add mailboxes." />
        ) : (
          <Table>
            <thead><tr><Th /><Th>Test</Th><Th>Status</Th><Th>Inbox rate</Th><Th>By provider</Th></tr></thead>
            <tbody>{tests.data.map((t) => <TestRow key={t.id} test={t} />)}</tbody>
          </Table>
        )}
      </Card>

      {running && <RunTestModal campaign={campaign} onClose={() => setRunning(false)} />}
    </div>
  );
}
