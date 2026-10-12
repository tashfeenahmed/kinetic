import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Globe, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Alert, Badge, Button, Card, CopyText, EmptyState, Field, Input, Loading, Modal, Select, Textarea, Toggle, useUi } from '../../components/ui.tsx';
import { BrandIcon } from '../../components/BrandIcon.tsx';
import { useGtmTables } from '../../gtm/lib/queries';
import type { Tracking } from '../Visitors.tsx';

interface Site {
  id: number; domain: string; name: string; site_key: string; key_pages: string[]; last_hit_at: string | null; verified_at: string | null;
  sessions_7d: number; script_url: string; snippet: string;
}
interface Settings {
  respect_dnt: boolean; retention_days: number; alert_threshold: number; alert_on: 'targets' | 'all' | 'off'; alert_slack: boolean;
  alert_webhook_url: string | null; target_domains: string[]; auto_push_table_id: number | null; auto_push_score: number | null;
}

export function SitesPanel({ tracking }: { tracking?: Tracking }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const sites = useQuery({ queryKey: ['visitors', 'sites'], queryFn: () => api.get<{ data: Site[] }>('/api/visitors/sites').then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['visitors'] });
  const verify = useMutation({
    mutationFn: (id: number) => api.post<{ ok: boolean; detail: string }>(`/api/visitors/sites/${id}/verify`),
    onSuccess: (r) => { toast(r.detail, r.ok ? 'success' : 'error'); void refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = async (s: Site) => {
    if (!(await confirm({ title: `Stop tracking ${s.domain}?`, message: 'Its sessions and events are deleted. Company and person totals are kept.', confirmLabel: 'Remove site', danger: true }))) return;
    try { await api.del(`/api/visitors/sites/${s.id}`); toast('Site removed'); void refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  if (sites.isLoading) return <Loading />;
  const list = sites.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-zinc-500">Add the snippet to every page of your site, inside <code>&lt;head&gt;</code>. It is ~2 KB, sets no third-party cookies and uses first-party storage only.</p>
        <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add site</Button>
      </div>
      {list.length === 0 ? (
        <Card><EmptyState icon={<Globe className="size-5" />} title="Track your first website" description="Add your domain to get an install snippet. Email links that point to it will then identify the lead who clicked." action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add site</Button>} /></Card>
      ) : list.map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-start gap-3">
            <BrandIcon domain={s.domain} fallback={<Globe className="size-3.5" />} size={30} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-zinc-900">{s.domain}</span>
                {s.last_hit_at ? <Badge tone="green" dot>Receiving events</Badge> : s.verified_at ? <Badge tone="blue" dot>Snippet found</Badge> : <Badge dot>Not installed</Badge>}
              </div>
              <div className="mt-0.5 text-[12.5px] text-zinc-500">
                {s.sessions_7d} session{s.sessions_7d === 1 ? '' : 's'} in 7 days · last event {fmtRelative(s.last_hit_at)} · key pages {s.key_pages.join(', ') || '—'}
              </div>
            </div>
            <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} loading={verify.isPending && verify.variables === s.id} onClick={() => verify.mutate(s.id)}>Verify install</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => remove(s)} aria-label="Remove"><Trash2 className="size-4" /></Button>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-[12px] font-medium text-zinc-500">Install snippet</div>
            <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-3 text-[12px] leading-relaxed text-zinc-800 ring-1 ring-zinc-200">{s.snippet}</pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyText value={s.snippet} className="max-w-[220px]" />
              <span className="text-[12px] text-zinc-500">Identify visitors on form submit: <code>kinetic.identify(email)</code>, or add <code>data-kinetic-identify</code> to the form. Tag key buttons with <code>data-kinetic="Book demo"</code>.</span>
            </div>
          </div>
        </Card>
      ))}
      {tracking && (
        <p className="text-[12.5px] text-zinc-500">Snippet and events use <code>{tracking.url}</code>{tracking.reachable && tracking.https ? '.' : ' — not publicly reachable yet, see the notice above.'} Change it with <b>Tracking public URL</b> on <Link to="/integrations" className="text-brand-600 hover:underline">Integrations</Link>.</p>
      )}
      {(adding || editing) && <SiteModal site={editing} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => void refresh()} />}
    </div>
  );
}

function SiteModal({ site, onClose, onSaved }: { site: Site | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useUi();
  const [domain, setDomain] = useState(site?.domain ?? '');
  const [keyPages, setKeyPages] = useState((site?.key_pages ?? ['/pricing', '/demo', '/contact']).join('\n'));
  const save = useMutation({
    mutationFn: () => {
      const body = { domain, key_pages: keyPages.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) };
      return site ? api.patch(`/api/visitors/sites/${site.id}`, body) : api.post('/api/visitors/sites', body);
    },
    onSuccess: () => { toast(site ? 'Site updated' : 'Site added — paste the snippet into your site'); onSaved(); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Modal open onClose={onClose} title={site ? `Edit ${site.domain}` : 'Add a website'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!domain.trim()} onClick={() => save.mutate()}>{site ? 'Save' : 'Add site'}</Button></>}>
      <div className="space-y-4">
        <Field label="Domain" hint="Subdomains (www, app, docs…) are included. Email links to this domain carry the lead token."><Input autoFocus value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" /></Field>
        <Field label="Key pages" hint="One path per line. Views of these pages raise the intent score most. A trailing * matches a prefix (e.g. /docs*)."><Textarea rows={4} value={keyPages} onChange={(e) => setKeyPages(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function SettingsPanel() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const settings = useQuery({ queryKey: ['visitors', 'settings'], queryFn: () => api.get<Settings>('/api/visitors/settings') });
  const tables = useGtmTables();
  const [s, setS] = useState<Settings | null>(null);
  const [targets, setTargets] = useState('');
  useEffect(() => { if (settings.data) { setS(settings.data); setTargets(settings.data.target_domains.join('\n')); } }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api.put<Settings>('/api/visitors/settings', { ...s!, alert_webhook_url: s!.alert_webhook_url || null, target_domains: targets.split(/[\n,\s]+/).map((t) => t.trim()).filter(Boolean) }),
    onSuccess: () => { toast('Settings saved'); void qc.invalidateQueries({ queryKey: ['visitors'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (!s) return <Loading />;
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Alerts" description="Slack or webhook when a target company or a known lead shows high intent. Also sent as the High Intent Visit webhook event.">
        <div className="space-y-4">
          <Field label="Alert on">
            <Select value={s.alert_on} onChange={(e) => set({ alert_on: e.target.value as Settings['alert_on'] })}>
              <option value="targets">Known leads and target companies</option>
              <option value="all">Any identified company</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          <Field label="High-intent score" hint="0–100. Built from pages viewed, key pages, repeat visits, time on site and recency (last 30 days).">
            <Input type="number" min={1} max={100} value={s.alert_threshold} onChange={(e) => set({ alert_threshold: Number(e.target.value) })} />
          </Field>
          <Field label="Target companies" hint="One domain per line. Companies you already have leads at count as targets automatically.">
            <Textarea rows={4} value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="acme.com" />
          </Field>
          <Toggle checked={s.alert_slack} onChange={(v) => set({ alert_slack: v })} label="Post to Slack" description={<>Uses the Slack webhook from <Link to="/integrations" className="text-brand-600 hover:underline">Integrations</Link>.</>} />
          <Field label="Webhook URL (optional)"><Input value={s.alert_webhook_url ?? ''} onChange={(e) => set({ alert_webhook_url: e.target.value })} placeholder="https://hooks.example.com/visitors" /></Field>
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Auto-push to a table" description="Companies above a score are added to a table automatically (checked every minute).">
          <div className="space-y-4">
            <Field label="Table">
              <Select value={s.auto_push_table_id ?? ''} onChange={(e) => set({ auto_push_table_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Off</option>
                {(tables.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            {s.auto_push_table_id && <Field label="Minimum score"><Input type="number" min={1} max={100} value={s.auto_push_score ?? 60} onChange={(e) => set({ auto_push_score: Number(e.target.value) })} /></Field>}
          </div>
        </Card>
        <Card title="Privacy & retention">
          <div className="space-y-4">
            <Toggle checked={s.respect_dnt} onChange={(v) => set({ respect_dnt: v })} label="Respect Do Not Track / Global Privacy Control" description="Browsers that send DNT or GPC are not tracked." />
            <Field label="Keep raw events for (days)" hint="Older pageviews and sessions are deleted; company and person totals are kept.">
              <Input type="number" min={30} max={3650} value={s.retention_days} onChange={(e) => set({ retention_days: Number(e.target.value) })} />
            </Field>
            <Alert tone="blue">Website visitor tracking may need a cookie/consent notice on your site depending on where your visitors are (e.g. GDPR/ePrivacy in the EU and UK).</Alert>
          </div>
        </Card>
        <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button></div>
      </div>
    </div>
  );
}
