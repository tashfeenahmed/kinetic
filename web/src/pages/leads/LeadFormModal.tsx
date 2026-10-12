import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { Button, Field, IconButton, Input, Modal, Textarea, useUi } from '../../components/ui.tsx';
import type { Lead } from './types.ts';

const EMPTY = { email: '', first_name: '', last_name: '', company: '', title: '', notes: '' };

export function LeadFormModal({ open, onClose, lead, onSaved }: { open: boolean; onClose: () => void; lead?: Lead | null; onSaved?: (lead: Lead) => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [form, setForm] = useState(EMPTY);
  const [vars, setVars] = useState<{ name: string; value: string }[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!open) return;
    setFieldErrors({});
    if (lead) {
      setForm({ email: lead.email, first_name: lead.first_name, last_name: lead.last_name, company: lead.company, title: lead.title, notes: lead.notes });
      setVars(lead.custom_variables.map((v) => ({ name: v.name, value: String(v.value ?? '') })));
    } else {
      setForm(EMPTY);
      setVars([]);
    }
  }, [open, lead]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, custom_variables: vars.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), value: v.value })) };
      return lead ? api.put(`/api/leads/${lead.id}`, body) : api.post('/api/leads', body);
    },
    onSuccess: (r) => {
      toast(lead ? 'Lead updated' : 'Lead added');
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      onSaved?.(r.data);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError) setFieldErrors(e.fields);
      toast(errorMessage(e), 'error');
    },
  });

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={lead ? 'Edit lead' : 'Add lead'}
      size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!form.email.trim()} onClick={() => save.mutate()}>{lead ? 'Save changes' : 'Add lead'}</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" className="sm:col-span-2" error={fieldErrors.email?.[0]}>
          <Input type="email" autoFocus value={form.email} onChange={set('email')} invalid={!!fieldErrors.email} placeholder="jane@acme.com" />
        </Field>
        <Field label="First name"><Input value={form.first_name} onChange={set('first_name')} /></Field>
        <Field label="Last name"><Input value={form.last_name} onChange={set('last_name')} /></Field>
        <Field label="Company"><Input value={form.company} onChange={set('company')} /></Field>
        <Field label="Title"><Input value={form.title} onChange={set('title')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>
      </div>
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">Custom variables</span>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setVars((v) => [...v, { name: '', value: '' }])}>Add variable</Button>
        </div>
        {vars.length === 0 && <p className="text-[13px] text-slate-500">Use custom variables in emails, e.g. a variable named “Phone” becomes {'{PHONE}'}.</p>}
        <div className="space-y-2">
          {vars.map((v, i) => (
            <div key={i} className="flex gap-2">
              <Input placeholder="Name" value={v.name} onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input placeholder="Value" value={v.value} onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <IconButton label="Remove" onClick={() => setVars((all) => all.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
