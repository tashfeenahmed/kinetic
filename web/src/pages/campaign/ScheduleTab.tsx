import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Button, Card, Checkbox, Field, Input, Loading, Select, cx, useUi } from '../../components/ui.tsx';
import { type Campaign, type Schedule, WEEKDAYS } from './types.ts';

const SHORT: Record<string, string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

function to12h(hm: string) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function describe(s: Schedule) {
  const days = WEEKDAYS.filter((d) => s[d]);
  let dayText: string;
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  if (days.length === 7) dayText = 'every day';
  else if (days.length === 5 && weekdays.every((d) => s[d as keyof Schedule])) dayText = 'Monday to Friday';
  else if (!days.length) dayText = 'no days';
  else dayText = days.map((d) => SHORT[d]).join(', ');
  const overnight = s.end_time <= s.start_time;
  return `Emails go out ${dayText}, between ${to12h(s.start_time)} and ${to12h(s.end_time)}${overnight ? ' (next day)' : ''} ${s.timezone.replace(/_/g, ' ')} time.`;
}

export function ScheduleTab({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [form, setForm] = useState<Schedule>(campaign.schedule);
  const [dirty, setDirty] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [tzSearch, setTzSearch] = useState('');

  useEffect(() => { if (!dirty) setForm(campaign.schedule); }, [campaign.schedule, dirty]);

  const tzs = useQuery({ queryKey: ['timezones'], queryFn: () => api.get('/api/campaigns/schedule/available-timezones').then((r) => r.data as string[]), staleTime: Infinity });
  const templates = useQuery({ queryKey: ['schedule-templates'], queryFn: () => api.get('/api/campaigns/schedule/templates').then((r) => r.data as (Schedule & { id: number; name: string })[]) });

  const set = (patch: Partial<Schedule>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };

  const save = useMutation({
    mutationFn: () => api.put(`/api/campaigns/${campaign.id}/schedule`, { ...form, save_as_template: saveTemplate, template_name: templateName || undefined }),
    onSuccess: () => {
      toast('Schedule saved');
      setDirty(false);
      setSaveTemplate(false);
      setTemplateName('');
      qc.invalidateQueries({ queryKey: ['campaign', campaign.id] });
      qc.invalidateQueries({ queryKey: ['schedule-templates'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const apply = useMutation({
    mutationFn: (id: number) => api.post(`/api/campaigns/${campaign.id}/create-schedule-from-template`, { schedule_id: id }),
    onSuccess: () => { toast('Template applied'); setDirty(false); qc.invalidateQueries({ queryKey: ['campaign', campaign.id] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const zones = useMemo(() => {
    const all = tzs.data ?? [];
    const q = tzSearch.toLowerCase().replace(/\s+/g, '_');
    const list = q ? all.filter((z) => z.toLowerCase().includes(q)) : all;
    return list.includes(form.timezone) ? list : [form.timezone, ...list];
  }, [tzs.data, tzSearch, form.timezone]);

  const noDays = !WEEKDAYS.some((d) => form[d]);
  const sameTime = form.start_time === form.end_time;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card title="Sending window" description="Emails are spread evenly through this window, respecting each mailbox's daily limit.">
        <div className="space-y-6">
          <div>
            <div className="mb-2 text-sm font-medium text-slate-700">Days</div>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => set({ [d]: !form[d] } as Partial<Schedule>)}
                  className={cx('h-9 w-14 rounded-lg border text-sm font-medium transition-colors', form[d] ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50')}
                >
                  {SHORT[d]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start time"><Input type="time" value={form.start_time} onChange={(e) => set({ start_time: e.target.value })} /></Field>
            <Field label="End time"><Input type="time" value={form.end_time} onChange={(e) => set({ end_time: e.target.value })} /></Field>
          </div>

          <Field label="Timezone" hint="Use your leads' timezone so emails arrive during their working day.">
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <Input placeholder="Filter, e.g. london" value={tzSearch} onChange={(e) => setTzSearch(e.target.value)} />
              <Select value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </Select>
            </div>
          </Field>

          {noDays ? <Alert tone="yellow">Pick at least one sending day.</Alert>
            : sameTime ? <Alert tone="yellow">Start and end time can't be the same.</Alert>
              : <Alert tone="blue">{describe(form)}</Alert>}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-700"><Checkbox checked={saveTemplate} onChange={(v) => { setSaveTemplate(v); setDirty(true); }} /> Save as template</label>
              {saveTemplate && <Input className="w-56" placeholder="Template name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />}
            </div>
            <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty || noDays || sameTime} loading={save.isPending} onClick={() => save.mutate()}>Save schedule</Button>
          </div>
        </div>
      </Card>

      <Card title="Templates" description="Reuse a schedule across campaigns.">
        {templates.isLoading ? <Loading /> : !templates.data?.length ? (
          <p className="text-sm text-slate-500">No templates yet. Tick “Save as template” when saving.</p>
        ) : (
          <ul className="space-y-2">
            {templates.data.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">{t.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {WEEKDAYS.filter((d) => t[d]).map((d) => SHORT[d]).join(' ')} · {t.start_time}–{t.end_time} · {t.timezone.replace(/_/g, ' ')}
                  </div>
                </div>
                <Button size="sm" loading={apply.isPending && apply.variables === t.id} onClick={() => apply.mutate(t.id)}>Apply</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
