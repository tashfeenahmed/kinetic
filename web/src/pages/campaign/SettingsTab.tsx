import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Save } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Card, Field, Input, Select, Toggle, cx, useUi } from '../../components/ui.tsx';
import type { Campaign } from './types.ts';

type Form = Pick<Campaign,
  'name' | 'max_emails_per_day' | 'max_new_leads_per_day' | 'daily_max_sends_per_receiving_domain' | 'sequence_prioritization' |
  'plain_text' | 'open_tracking' | 'click_tracking' | 'custom_tracking_domain_id' | 'stop_on_reply' | 'can_unsubscribe' | 'include_auto_replies_in_stats'>;

const pick = (c: Campaign): Form => ({
  name: c.name, max_emails_per_day: c.max_emails_per_day, max_new_leads_per_day: c.max_new_leads_per_day,
  daily_max_sends_per_receiving_domain: c.daily_max_sends_per_receiving_domain, sequence_prioritization: c.sequence_prioritization,
  plain_text: c.plain_text, open_tracking: c.open_tracking, click_tracking: c.click_tracking, custom_tracking_domain_id: c.custom_tracking_domain_id,
  stop_on_reply: c.stop_on_reply, can_unsubscribe: c.can_unsubscribe, include_auto_replies_in_stats: c.include_auto_replies_in_stats,
});

function NumberField({ label, hint, value, onChange, min = 0 }: { label: string; hint: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} />
    </Field>
  );
}

export function SettingsTab({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [form, setForm] = useState<Form>(pick(campaign));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setForm(pick(campaign)); }, [campaign, dirty]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  const domains = useQuery({ queryKey: ['tracking-domains'], queryFn: () => api.get('/api/custom-tracking-domain').then((r) => r.data as { id: number; domain: string; status: string }[]) });

  const save = useMutation({
    mutationFn: () => api.patch(`/api/campaigns/${campaign.id}/update`, form),
    onSuccess: () => { toast('Settings saved'); setDirty(false); qc.invalidateQueries({ queryKey: ['campaign', campaign.id] }); qc.invalidateQueries({ queryKey: ['campaigns'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <div className="max-w-4xl space-y-5">
      <Card title="General">
        <Field label="Campaign name"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      </Card>

      <Card title="Sending limits" description="Mailbox daily limits always apply too — the lowest limit wins.">
        <div className="grid gap-5 sm:grid-cols-3">
          <NumberField label="Max emails per day" hint="All steps combined." min={1} value={form.max_emails_per_day} onChange={(v) => set('max_emails_per_day', v)} />
          <NumberField label="Max new leads per day" hint="How many leads start step 1 each day." value={form.max_new_leads_per_day} onChange={(v) => set('max_new_leads_per_day', v)} />
          <NumberField label="Max per receiving domain" hint="Per company domain per day. 0 = unlimited." value={form.daily_max_sends_per_receiving_domain} onChange={(v) => set('daily_max_sends_per_receiving_domain', v)} />
        </div>
      </Card>

      <Card title="Prioritization" description="When there isn't enough capacity for everyone today, who goes first?">
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ['followups', 'Follow-ups first', 'Finish conversations already started before contacting new leads. Recommended.'],
            ['new_leads', 'New leads first', 'Reach as many new leads as possible; follow-ups wait for spare capacity.'],
          ] as const).map(([id, label, desc]) => (
            <button key={id} type="button" onClick={() => set('sequence_prioritization', id)}
              className={cx('rounded-lg border p-4 text-left transition-colors', form.sequence_prioritization === id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}>
              <div className="flex items-center gap-2">
                <span className={cx('flex size-4 items-center justify-center rounded-full border', form.sequence_prioritization === id ? 'border-brand-600' : 'border-slate-300')}>
                  {form.sequence_prioritization === id && <span className="size-2 rounded-full bg-brand-600" />}
                </span>
                <span className="text-sm font-medium text-slate-900">{label}</span>
              </div>
              <div className="mt-1 pl-6 text-xs text-slate-500">{desc}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Tracking & content">
        <div className="space-y-5">
          <Toggle checked={form.plain_text} onChange={(v) => set('plain_text', v)} label="Send as plain text" description="Plain text looks like a personal email and gets the best deliverability." />
          <div className={cx('space-y-5 rounded-lg border border-slate-200 p-4', form.plain_text && 'bg-slate-50')}>
            {form.plain_text && <p className="text-xs text-slate-500">Tracking needs HTML emails — turn off plain text to enable it.</p>}
            <Toggle disabled={form.plain_text} checked={form.open_tracking && !form.plain_text} onChange={(v) => set('open_tracking', v)} label="Track opens" description="Adds an invisible image. Apple Mail and scanners make open rates unreliable." />
            <Toggle disabled={form.plain_text} checked={form.click_tracking && !form.plain_text} onChange={(v) => set('click_tracking', v)} label="Track link clicks" description="Rewrites links through your tracking domain." />
          </div>
          <Field label="Custom tracking domain" hint={<>Used for tracking and unsubscribe links. <Link to="/settings/tracking-domains" className="text-brand-600 hover:underline">Manage domains</Link></>}>
            <Select value={form.custom_tracking_domain_id ?? ''} onChange={(e) => set('custom_tracking_domain_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Default (this app's address)</option>
              {domains.data?.map((d) => <option key={d.id} value={d.id}>{d.domain}{d.status !== 'verified' ? ` (${d.status})` : ''}</option>)}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Behaviour">
        <div className="space-y-5">
          <Toggle checked={form.stop_on_reply} onChange={(v) => set('stop_on_reply', v)} label="Stop sending when a lead replies" description="Auto-replies (out of office) never stop the sequence. Interested replies always do." />
          <Toggle checked={form.can_unsubscribe} onChange={(v) => set('can_unsubscribe', v)} label="Include unsubscribe option" description="Adds one-click List-Unsubscribe headers and enables {UNSUBSCRIBE_LINK}. Required by Gmail and Yahoo for bulk senders." />
          <Toggle checked={form.include_auto_replies_in_stats} onChange={(v) => set('include_auto_replies_in_stats', v)} label="Count auto-replies in stats" description="Off by default so reply rate reflects real people." />
        </div>
      </Card>

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-gradient-to-t from-white via-white px-1 py-3">
        {dirty && <Button variant="ghost" onClick={() => { setForm(pick(campaign)); setDirty(false); }}>Discard</Button>}
        <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty || !form.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </div>
  );
}
