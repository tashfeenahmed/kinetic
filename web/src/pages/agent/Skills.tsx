import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Lock, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Badge, Button, EmptyState, Field, Input, Loading, Textarea, cx, useUi } from '../../components/ui.tsx';
import { Markdown } from './Markdown.tsx';
import type { AgentSkill } from './types.ts';

const TEMPLATE = `# Title

When to use this, in one line.

## Steps
1. Call \`POST /api/...\` with:
\`\`\`json
{ }
\`\`\`
2. Read the response and …

## Confirm with the user first
- anything that sends, spends, deletes or touches LinkedIn

## Pitfalls
- …`;

/** Built-in skills (read-only) and custom skills the agent picks up immediately. */
export function AgentSkills() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const skills = useQuery({ queryKey: ['agent-skills'], queryFn: () => api.get('/api/agent/skills').then((r) => r.data as AgentSkill[]) });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentSkill | 'new' | null>(null);
  const list = skills.data ?? [];
  const current = list.find((s) => s.name === selected) ?? list[0];

  const remove = async (s: AgentSkill) => {
    if (!(await confirm({ title: `Delete skill “${s.name}”?`, message: 'The agent stops using it straight away.', confirmLabel: 'Delete skill', danger: true }))) return;
    try {
      await api.del(`/api/agent/skills/${s.id}`);
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ['agent-skills'] });
      toast('Skill deleted');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };

  if (skills.isLoading) return <Loading />;
  const custom = list.filter((s) => !s.builtin);
  const builtin = list.filter((s) => s.builtin);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-zinc-200/80 bg-[#fafafa]">
        <div className="flex h-11 items-center px-2">
          <button onClick={() => setEditing('new')} className="flex h-8 flex-1 items-center gap-2 rounded-[7px] px-2.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-200/50">
            <Plus className="size-4" /> New skill
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin">
          <SkillGroup label="Your skills" skills={custom} current={current} onSelect={(n) => { setSelected(n); setEditing(null); }} empty="None yet — teach the agent your own playbooks." />
          <SkillGroup label="Built-in" skills={builtin} current={current} onSelect={(n) => { setSelected(n); setEditing(null); }} />
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-[820px] px-6 py-6">
          {editing ? (
            <SkillForm skill={editing === 'new' ? null : editing} onDone={(name) => { setEditing(null); if (name) setSelected(name); }} />
          ) : current ? (
            <>
              <div className="mb-4 flex items-start justify-between gap-4 border-b border-zinc-100 pb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-mono text-[15px] font-semibold text-zinc-900">{current.name}</h2>
                    {current.builtin ? <Badge><Lock className="mr-1 inline size-3" />Built-in</Badge> : <Badge tone="blue">Custom</Badge>}
                  </div>
                  <p className="mt-1 text-[13px] text-zinc-500">{current.description}</p>
                  {current.updated_at && <p className="mt-0.5 text-[11.5px] text-zinc-400">Updated {fmtRelative(current.updated_at)}</p>}
                </div>
                {!current.builtin && (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(current)}>Edit</Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => remove(current)}>Delete</Button>
                  </div>
                )}
              </div>
              <Markdown text={current.body || '_No instructions yet._'} />
            </>
          ) : (
            <EmptyState icon={<BookOpen className="size-6" />} title="No skills" description="Skills are markdown playbooks the agent loads when a task needs them." />
          )}
        </div>
      </div>
    </div>
  );
}

function SkillGroup({ label, skills, current, onSelect, empty }: { label: string; skills: AgentSkill[]; current?: AgentSkill; onSelect: (name: string) => void; empty?: string }) {
  return (
    <div className="mb-3">
      <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[.06em] text-zinc-400">{label}</div>
      {!skills.length && empty && <p className="px-2.5 py-1 text-[12.5px] text-zinc-400">{empty}</p>}
      {skills.map((s) => (
        <button key={s.name} onClick={() => onSelect(s.name)}
          className={cx('block w-full rounded-[7px] px-2.5 py-1.5 text-left', current?.name === s.name ? 'bg-white shadow-sm ring-1 ring-zinc-200' : 'hover:bg-zinc-200/50')}>
          <div className="truncate font-mono text-[12.5px] text-zinc-800">{s.name}</div>
          <div className="line-clamp-2 text-[11.5px] leading-snug text-zinc-500">{s.description}</div>
        </button>
      ))}
    </div>
  );
}

function SkillForm({ skill, onDone }: { skill: AgentSkill | null; onDone: (name?: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const payload = { name: name.trim().toLowerCase(), description, body };
      if (skill?.id) await api.put(`/api/agent/skills/${skill.id}`, payload);
      else await api.post('/api/agent/skills', payload);
      await qc.invalidateQueries({ queryKey: ['agent-skills'] });
      toast(skill ? 'Skill saved' : 'Skill created — the agent can use it now');
      onDone(payload.name);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Wand2 className="size-4 text-zinc-500" />
        <h2 className="text-[15px] font-semibold text-zinc-900">{skill ? `Edit ${skill.name}` : 'New skill'}</h2>
      </div>
      <div className="space-y-4">
        <Field label="Name" hint="Lowercase with dashes, e.g. irish-hospitality-outreach">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="my-playbook" className="font-mono" />
        </Field>
        <Field label="When should the agent use it?" hint="This one line is all the agent sees until it loads the skill — make it specific.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when the user asks for … " />
        </Field>
        <Field label="Instructions (markdown)" hint="Endpoints to call with example bodies, order, what to confirm first, pitfalls.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={22} className="font-mono text-[12.5px]" />
        </Field>
        {err && <p className="text-[13px] text-red-600">{err}</p>}
        <div className="flex gap-2">
          <Button variant="primary" loading={busy} disabled={!name.trim() || !description.trim()} onClick={save}>{skill ? 'Save skill' : 'Create skill'}</Button>
          <Button onClick={() => onDone()}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
