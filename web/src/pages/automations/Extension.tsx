import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Chrome, Download, KeyRound, Pause, Play, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Alert, Badge, Button, Card, CopyText, EmptyState, Loading, cx, useUi } from '../../components/ui.tsx';
import { useCompanionStatus, type Device } from './shared.tsx';

/** Install + pairing page for the Kinetic Companion browser extension. */
export function Extension() {
  const status = useCompanionStatus();
  const qc = useQueryClient();
  const { toast } = useUi();
  const [code, setCode] = useState<{ code: string; expires_at: string; kinetic_url: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!code) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [code]);
  const left = code ? Math.max(0, Math.round((Date.parse(code.expires_at) - now) / 1000)) : 0;

  const pair = useMutation({
    mutationFn: () => api.post<{ data: { code: string; expires_at: string; kinetic_url: string } }>('/api/companion/pairing-code'),
    onSuccess: (r) => { setCode(r.data); setNow(Date.now()); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (status.isLoading) return <Loading />;
  const s = status.data;
  if (!s) return <Alert tone="red">Could not load the extension status.</Alert>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Card title="Install Kinetic Companion" description="A Chrome extension that runs your automations inside your own logged-in browser, at human pace. Kinetic never sees your LinkedIn password or cookies.">
          <ol className="space-y-4 text-[13.5px]">
            <Step n={1} title="Download the extension">
              {s.extension.available
                ? <a href={s.extension.download_url} download><Button variant="primary" icon={<Download className="size-4" />}>Download kinetic-companion.zip{s.extension.version ? ` (v${s.extension.version})` : ''}</Button></a>
                : <Alert tone="yellow">The extension hasn't been built on this server yet. Run <code className="rounded bg-white/70 px-1">npm run build:extension</code> and reload.</Alert>}
            </Step>
            <Step n={2} title="Load it in Chrome (or Edge, Brave, Arc)">
              Unzip the file, open <CopyText value="chrome://extensions" />, switch on <b>Developer mode</b> (top right), then click <b>Load unpacked</b> and pick the unzipped folder — or simply drag the zip onto that page.
            </Step>
            <Step n={3} title="Pair it with this workspace">
              Open the extension's options (click its icon → <i>Settings</i>), paste the Kinetic URL and the pairing code below, and press <b>Pair</b>.
              <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-zinc-400">Kinetic URL</div>
                <CopyText value={code?.kinetic_url ?? s.kinetic_url} />
                <div className="mb-1 mt-3 text-[11.5px] font-semibold uppercase tracking-wide text-zinc-400">Pairing code</div>
                {code && left > 0 ? (
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-2xl font-semibold tracking-[0.2em] text-zinc-900">{code.code}</span>
                    <CopyText value={code.code} />
                    <span className="text-[12px] text-zinc-500">expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
                  </div>
                ) : (
                  <Button icon={<KeyRound className="size-4" />} loading={pair.isPending} onClick={() => pair.mutate()}>{code ? 'Code expired — generate a new one' : 'Generate pairing code'}</Button>
                )}
                <p className="mt-2 text-[12px] text-zinc-500">Or paste an API token from Developers → Developer API instead of a code.</p>
              </div>
            </Step>
            <Step n={4} title="Stay logged in">
              Keep the browser open and logged in to LinkedIn (and Instagram, X, Facebook if you use them). The extension uses a background tab, waits between actions and stops on any warning page.
            </Step>
          </ol>
        </Card>
        <Alert tone="blue" title="How it stays safe">
          Every task is handed out by Kinetic one at a time, inside your working hours and within your daily/weekly limits, with randomised delays.
          If LinkedIn shows a captcha, a checkpoint or a rate-limit page, the extension stops, pauses that site and tells Kinetic.
        </Alert>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-zinc-900">Paired browsers</h3>
          <Badge tone={s.online ? 'green' : 'gray'} dot>{s.online ? 'Online' : 'Offline'}</Badge>
        </div>
        {!s.devices.length
          ? <div className="rounded-lg border border-dashed border-zinc-300"><EmptyState icon={<Chrome className="size-5" />} title="No browser paired" description="Install the extension and pair it to start running automations." /></div>
          : s.devices.map((d) => <DeviceCard key={d.id} d={d} onChange={() => qc.invalidateQueries({ queryKey: ['automations'] })} />)}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[12px] font-semibold text-white">{n}</span>
      <div className="min-w-0 flex-1"><div className="mb-1 font-medium text-zinc-900">{title}</div><div className="text-zinc-600">{children}</div></div>
    </li>
  );
}

const SITES = ['linkedin', 'instagram', 'x', 'facebook', 'whatsapp'];

function DeviceCard({ d, onChange }: { d: Device; onChange: () => void }) {
  const { toast, confirm } = useUi();
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/companion/devices/${d.id}`, body),
    onSuccess: () => onChange(),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const unpair = async () => {
    if (!(await confirm({ title: `Unpair ${d.name}?`, message: 'Its token is revoked and it stops taking tasks. You can pair it again any time.', confirmLabel: 'Unpair', danger: true }))) return;
    try { await api.del(`/api/companion/devices/${d.id}`); toast('Unpaired'); onChange(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const pauses = Object.entries(d.site_pauses ?? {}).filter(([, until]) => until && Date.parse(until) > Date.now());
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3.5 text-[13px]">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full', d.online ? 'bg-emerald-500' : 'bg-zinc-300')} />
        <span className="flex-1 truncate font-medium text-zinc-900">{d.name}</span>
        {d.paused && <Badge tone="yellow">Paused</Badge>}
      </div>
      <div className="mt-1 text-[12px] text-zinc-500">{d.version ? `v${d.version} · ` : ''}seen {fmtRelative(d.last_seen_at)}</div>
      {d.current_task && <div className="mt-2 rounded-md bg-blue-50 px-2 py-1 text-[12px] text-blue-800">Running: {d.current_task.job_name ?? d.current_task.kind}</div>}
      <div className="mt-2 flex flex-wrap gap-1">
        {SITES.map((site) => <Badge key={site} tone={d.accounts?.[site] ? 'green' : 'gray'}>{site}{d.accounts?.[site] ? ' ✓' : ''}</Badge>)}
      </div>
      {pauses.map(([site, until]) => (
        <div key={site} className="mt-2 flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1 text-[12px] text-amber-800">
          <span className="flex-1">{site} paused by a safety stop until {fmtRelative(until)}</span>
          <button onClick={() => patch.mutate({ clear_site_pause: site })} className="inline-flex items-center gap-0.5 font-medium hover:underline"><X className="size-3" />Clear</button>
        </div>
      ))}
      {d.last_error && <div className="mt-2 text-[12px] text-red-600">{d.last_error}</div>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" icon={d.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={() => patch.mutate({ paused: !d.paused })}>{d.paused ? 'Resume' : 'Pause'}</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={unpair}>Unpair</Button>
      </div>
    </div>
  );
}
