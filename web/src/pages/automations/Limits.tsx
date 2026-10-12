import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Button, Card, Field, Input, Loading, Select, Toggle, cx, useUi } from '../../components/ui.tsx';
import { usePhantoms, type CompanionSettings, type DaysMap } from './shared.tsx';

const DAYS: (keyof DaysMap)[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Limits & safety: per-action caps, working hours, pacing and the global pause switch. */
export function Limits() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const phantoms = usePhantoms();
  const settings = useQuery({ queryKey: ['automations', 'settings'], queryFn: () => api.get<{ data: CompanionSettings }>('/api/automations/settings').then((r) => r.data) });
  const [draft, setDraft] = useState<CompanionSettings | null>(null);
  useEffect(() => { if (settings.data) setDraft(structuredClone(settings.data)); }, [settings.data]);
  const timezones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; } }, []);

  const save = useMutation({
    mutationFn: (body: Partial<CompanionSettings>) => api.put<{ data: CompanionSettings }>('/api/automations/settings', body),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['automations'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const pauseAll = useMutation({
    mutationFn: (paused: boolean) => api.post('/api/companion/pause-all', { paused }),
    onSuccess: (_r, paused) => { toast(paused ? 'All automations paused' : 'Automations resumed'); void qc.invalidateQueries({ queryKey: ['automations'] }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (!draft) return <Loading />;
  const labels = phantoms.data?.limits ?? {};
  const set = (fn: (d: CompanionSettings) => void) => setDraft((d) => { const c = structuredClone(d!); fn(c); return c; });
  const num = (v: string) => (v === '' ? 0 : Math.max(0, Number(v)));
  const actions = Object.keys({ ...labels, ...draft.limits });

  return (
    <div className="space-y-6">
      <div className={cx('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-[13px]', draft.paused ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white')}>
        <ShieldCheck className="size-4 text-zinc-500" />
        <span className="flex-1 text-zinc-700">{draft.paused ? 'Everything is paused: the extension takes no new tasks until you resume.' : 'Automations are running. Pause everything instantly if something looks wrong.'}</span>
        <Button variant={draft.paused ? 'primary' : 'danger'} size="sm" icon={draft.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          loading={pauseAll.isPending} onClick={() => pauseAll.mutate(!draft.paused)}>{draft.paused ? 'Resume all' : 'Pause all'}</Button>
      </div>

      <Card title="Daily and weekly limits" description="The server never hands out more work than these. LinkedIn restricts accounts that go much higher; defaults are conservative.">
        <div className="divide-y divide-zinc-100">
          <div className="grid grid-cols-[1fr_110px_110px] gap-3 pb-2 text-[11.5px] font-semibold uppercase tracking-wide text-zinc-400"><span>Action</span><span>Per day</span><span>Per week</span></div>
          {actions.map((a) => {
            const l = draft.limits[a] ?? { daily: labels[a]?.daily ?? 0, weekly: labels[a]?.weekly ?? null };
            return (
              <div key={a} className="grid grid-cols-[1fr_110px_110px] items-center gap-3 py-2 text-[13px]">
                <span className="text-zinc-700">{labels[a]?.label ?? a}<span className="ml-2 text-[11.5px] text-zinc-400">{a}</span></span>
                <Input type="number" min={0} value={l.daily} onChange={(e) => set((d) => { d.limits[a] = { ...l, daily: num(e.target.value) }; })} />
                <Input type="number" min={0} placeholder="—" value={l.weekly ?? ''} onChange={(e) => set((d) => { d.limits[a] = { ...l, weekly: e.target.value === '' ? null : num(e.target.value) }; })} />
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Working hours" description="Actions only run inside these hours, in this timezone. Daily limits reset at local midnight.">
        <div className="space-y-4">
          <Toggle checked={draft.working_hours.enabled} onChange={(v) => set((d) => { d.working_hours.enabled = v; })} label="Only run during working hours" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Timezone">
              <Select value={draft.working_hours.timezone} onChange={(e) => set((d) => { d.working_hours.timezone = e.target.value; })}>
                {timezones.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="From"><Input type="time" value={draft.working_hours.start} onChange={(e) => set((d) => { d.working_hours.start = e.target.value; })} /></Field>
            <Field label="Until"><Input type="time" value={draft.working_hours.end} onChange={(e) => set((d) => { d.working_hours.end = e.target.value; })} /></Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((day) => (
              <button key={day} onClick={() => set((d) => { d.working_hours.days[day] = !d.working_hours.days[day]; })}
                className={cx('rounded-[7px] border px-2.5 py-1 text-[12.5px] capitalize', draft.working_hours.days[day] ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50')}>
                {day.slice(0, 3)}
              </button>
            ))}
          </div>
          <Toggle checked={draft.scrape_outside_hours} onChange={(v) => set((d) => { d.scrape_outside_hours = v; })} label="Allow scraping outside working hours"
            description="Data exports may run any time; actions (connect, message, visit, like, comment) still wait for working hours." />
        </div>
      </Card>

      <Card title="Pacing" description="Randomised delays make activity look human. The extension also scrolls and pauses like a person.">
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Between actions, min (s)"><Input type="number" min={5} value={draft.delays.action_min_sec} onChange={(e) => set((d) => { d.delays.action_min_sec = num(e.target.value); })} /></Field>
          <Field label="Between actions, max (s)"><Input type="number" min={5} value={draft.delays.action_max_sec} onChange={(e) => set((d) => { d.delays.action_max_sec = num(e.target.value); })} /></Field>
          <Field label="Between pages, min (s)"><Input type="number" min={1} value={draft.delays.page_min_sec} onChange={(e) => set((d) => { d.delays.page_min_sec = num(e.target.value); })} /></Field>
          <Field label="Between pages, max (s)"><Input type="number" min={1} value={draft.delays.page_max_sec} onChange={(e) => set((d) => { d.delays.page_max_sec = num(e.target.value); })} /></Field>
          <Field label="Max actions / hour"><Input type="number" min={1} value={draft.max_actions_per_hour} onChange={(e) => set((d) => { d.max_actions_per_hour = num(e.target.value); })} /></Field>
        </div>
        {draft.delays.action_min_sec > draft.delays.action_max_sec && <div className="mt-3"><Alert tone="yellow">The minimum delay is larger than the maximum.</Alert></div>}
      </Card>

      <div className="flex justify-end gap-2">
        <Button onClick={() => settings.data && setDraft(structuredClone(settings.data))}>Reset</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => { const { paused: _p, ...rest } = draft; save.mutate(rest); }}>Save settings</Button>
      </div>
    </div>
  );
}
