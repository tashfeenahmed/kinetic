import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Button, Field, Input, Modal, useUi } from '../../components/ui.tsx';
import type { Sender } from './types.ts';

/** Mailbox actions shared by the table menu and the detail drawer. */
export function useSenderActions() {
  const qc = useQueryClient();
  const { toast, confirm } = useUi();
  const [reconnect, setReconnect] = useState<Sender | null>(null);
  const [sendTest, setSendTest] = useState<Sender | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['senders'] }); qc.invalidateQueries({ queryKey: ['sender'] }); qc.invalidateQueries({ queryKey: ['warmup'] }); };

  const actions = {
    testConnection: async (s: Sender) => {
      toast(`Testing ${s.email}…`, 'info');
      try {
        const r = await api.post(`/api/sender-emails/${s.id}/test-connection`);
        if (r.data.ok) toast(`${s.email}: SMTP and IMAP OK`);
        else toast(`${s.email}: ${[r.data.smtp !== 'ok' && `SMTP ${r.data.smtp}`, r.data.imap !== 'ok' && `IMAP ${r.data.imap}`].filter(Boolean).join(' · ')}`, 'error');
        refresh();
      } catch (e) { toast(errorMessage(e), 'error'); }
    },
    syncNow: async (s: Sender) => {
      try {
        const r = await api.post(`/api/sender-emails/${s.id}/sync-now`);
        const after = r.data.sender as Sender;
        if (after.last_error) toast(`Sync failed: ${after.last_error}`, 'error');
        else toast(`Synced ${s.email} · ${r.data.processed} new message${r.data.processed === 1 ? '' : 's'}`);
        refresh();
        qc.invalidateQueries({ queryKey: ['replies'] });
      } catch (e) { toast(errorMessage(e), 'error'); }
    },
    togglePause: async (s: Sender) => {
      try {
        await api.patch(`/api/sender-emails/${s.id}/${s.status === 'Paused' ? 'resume' : 'pause'}`);
        toast(s.status === 'Paused' ? `${s.email} resumed` : `${s.email} paused`);
        refresh();
      } catch (e) { toast(errorMessage(e), 'error'); }
    },
    remove: async (s: Sender, after?: () => void) => {
      const ok = await confirm({ title: 'Delete email account?', message: <>This disconnects <b>{s.email}</b> and cancels its scheduled emails. Sent history stays in your stats.</>, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api.del(`/api/sender-emails/${s.id}`);
        toast('Email account deleted');
        refresh();
        after?.();
      } catch (e) { toast(errorMessage(e), 'error'); }
    },
    reconnect: (s: Sender) => setReconnect(s),
    sendTest: (s: Sender) => setSendTest(s),
  };

  const modals = (
    <>
      <ReconnectModal sender={reconnect} onClose={() => setReconnect(null)} onDone={refresh} />
      <SendTestModal sender={sendTest} onClose={() => setSendTest(null)} />
    </>
  );
  return { actions, modals };
}

function ReconnectModal({ sender, onClose, onDone }: { sender: Sender | null; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const close = () => { setPassword(''); setError(''); onClose(); };
  const submit = async () => {
    if (!sender) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/sender-emails/${sender.id}/reconnect`, { password });
      toast(`${sender.email} reconnected`);
      onDone();
      close();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!sender} onClose={close} size="sm" title="Reconnect mailbox" description={sender?.email}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!password} onClick={submit}>Reconnect</Button></>}>
      <div className="space-y-3">
        {sender?.last_error && <Alert tone="yellow" title="Last error">{sender.last_error}</Alert>}
        {error && <Alert tone="red">{error}</Alert>}
        <Field label={sender?.provider === 'google' ? 'New app password' : 'Password'}>
          <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && submit()} />
        </Field>
      </div>
    </Modal>
  );
}

function SendTestModal({ sender, onClose }: { sender: Sender | null; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useUi();
  const close = () => { setError(''); onClose(); };
  const submit = async () => {
    if (!sender) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/sender-emails/${sender.id}/send-test`, { to_email: to });
      toast(`Test email sent to ${to}`);
      close();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!sender} onClose={close} size="sm" title="Send a test email" description={`From ${sender?.email ?? ''}`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!to.includes('@')} onClick={submit}>Send test</Button></>}>
      <div className="space-y-3">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Send to" hint="Use an inbox you can check, e.g. a personal Gmail.">
          <Input type="email" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" onKeyDown={(e) => e.key === 'Enter' && to.includes('@') && submit()} />
        </Field>
      </div>
    </Modal>
  );
}
