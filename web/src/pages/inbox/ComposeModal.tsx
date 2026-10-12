import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Field, Input, Modal, Select, Textarea, useUi } from '../../components/ui.tsx';
import { AttachmentPicker, parseEmails, useAttachments } from './shared.tsx';

export function ComposeModal({ open, onClose, defaultTo }: { open: boolean; onClose: () => void; defaultTo?: string }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const senders = useQuery({ queryKey: ['sender-emails'], queryFn: () => api.get('/api/sender-emails').then((r) => r.data as { id: number; email: string; name: string; status: string }[]), enabled: open });
  const [form, setForm] = useState({ sender: '', to: '', cc: '', bcc: '', subject: '', body: '' });
  const [showCc, setShowCc] = useState(false);
  const att = useAttachments();

  useEffect(() => {
    if (open) { setForm((f) => ({ ...f, to: defaultTo ?? '', cc: '', bcc: '', subject: '', body: '' })); setShowCc(false); att.clear(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTo]);
  useEffect(() => {
    if (!form.sender && senders.data?.length) setForm((f) => ({ ...f, sender: String(senders.data!.find((s) => s.status === 'Connected')?.id ?? senders.data![0]!.id) }));
  }, [senders.data, form.sender]);

  const send = useMutation({
    mutationFn: () => api.post('/api/replies/new', {
      sender_email_id: Number(form.sender), to_emails: parseEmails(form.to), cc_emails: parseEmails(form.cc), bcc_emails: parseEmails(form.bcc),
      subject: form.subject, message: form.body, attachments: att.payload(),
    }),
    onSuccess: () => { toast('Email sent'); qc.invalidateQueries({ queryKey: ['inbox'] }); onClose(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const ready = form.sender && parseEmails(form.to).length && form.subject.trim() && form.body.trim() && att.totalSize <= 15 * 1024 * 1024;

  return (
    <Modal open={open} onClose={onClose} title="New email" size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={send.isPending} disabled={!ready} onClick={() => send.mutate()}>Send</Button></>}>
      <div className="space-y-3">
        <Field label="From">
          <Select value={form.sender} onChange={set('sender')}>
            {senders.data?.length === 0 && <option value="">Connect a sender email first</option>}
            {senders.data?.map((s) => <option key={s.id} value={s.id} disabled={s.status !== 'Connected'}>{s.name} &lt;{s.email}&gt;{s.status !== 'Connected' ? ` (${s.status})` : ''}</option>)}
          </Select>
        </Field>
        <Field label={<span className="flex items-center justify-between">To {!showCc && <button type="button" className="text-xs font-normal text-brand-600 hover:underline" onClick={() => setShowCc(true)}>Cc / Bcc</button>}</span>}>
          <Input value={form.to} onChange={set('to')} placeholder="name@company.com, other@company.com" autoFocus />
        </Field>
        {showCc && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cc"><Input value={form.cc} onChange={set('cc')} /></Field>
            <Field label="Bcc"><Input value={form.bcc} onChange={set('bcc')} /></Field>
          </div>
        )}
        <Field label="Subject"><Input value={form.subject} onChange={set('subject')} /></Field>
        <Field label="Message" hint="Your mailbox signature is added automatically."><Textarea rows={9} value={form.body} onChange={set('body')} /></Field>
        <AttachmentPicker att={att} />
      </div>
    </Modal>
  );
}
