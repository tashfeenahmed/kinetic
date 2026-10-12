import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Upload, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Alert, Badge, Button, Modal, Table, Td, Textarea, Th, Toggle, useUi } from '../../components/ui.tsx';

const COLUMNS = ['name', 'email', 'password', 'imap_server', 'imap_port', 'smtp_server', 'smtp_port', 'provider', 'daily_limit'];
const TEMPLATE = `${COLUMNS.join(',')}
Alex Morgan,alex@yourdomain.com,app-password-here,,,,,google,30
Sam Lee,sam@otherdomain.com,secret,imap.zoho.com,993,smtp.zoho.com,465,custom,30
`;

interface Result { email: string; ok: boolean; error?: string }

export function BulkImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [skip, setSkip] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState('');
  const qc = useQueryClient();
  const { toast } = useUi();

  const close = () => { setCsv(''); setResults(null); setError(''); onClose(); };

  const run = useMutation({
    mutationFn: () => api.post('/api/sender-emails/bulk', { csv, skip_verification: skip }),
    onSuccess: (r) => {
      setResults(r.data.results);
      qc.invalidateQueries({ queryKey: ['senders'] });
      toast(`${r.data.added} added${r.data.failed ? `, ${r.data.failed} failed` : ''}`, r.data.failed ? 'info' : 'success');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kinetic-mailboxes.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;

  return (
    <Modal open={open} onClose={close} size="lg" title="Bulk import email accounts"
      description="Paste or upload a CSV. Each mailbox is tested before it is saved."
      footer={results ? <Button variant="primary" onClick={close}>Done</Button> : (
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={rows < 1} onClick={() => { setError(''); run.mutate(); }}>
            {run.isPending ? 'Connecting…' : `Import ${rows > 0 ? rows : ''} ${rows === 1 ? 'account' : 'accounts'}`}
          </Button>
        </>
      )}>
      {results ? (
        <Table>
          <thead><tr><Th>Email</Th><Th>Result</Th></tr></thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <Td className="font-medium text-slate-800">{r.email || '—'}</Td>
                <Td>
                  {r.ok
                    ? <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="size-4" /> Connected</span>
                    : <span className="inline-flex items-start gap-1.5 text-red-700"><XCircle className="mt-0.5 size-4 shrink-0" /> <span className="text-[13px]">{r.error}</span></span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="space-y-4">
          {error && <Alert tone="red">{error}</Alert>}
          <div className="rounded-lg bg-slate-50 p-3 text-[13px] text-slate-600">
            <div className="mb-1.5 font-medium text-slate-800">Columns</div>
            <div className="flex flex-wrap gap-1.5">{COLUMNS.map((c) => <Badge key={c}>{c}</Badge>)}</div>
            <p className="mt-2">For Google and Microsoft, set <code className="rounded bg-white px-1">provider</code> to <code className="rounded bg-white px-1">google</code> or <code className="rounded bg-white px-1">microsoft</code> and leave the server columns empty — they're filled in for you.</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" icon={<Download className="size-4" />} onClick={downloadTemplate}>Download template</Button>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-[13px] font-medium text-slate-800 shadow-sm hover:bg-slate-50">
              <Upload className="size-4" /> Upload CSV
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = ''; }} />
            </label>
          </div>
          <Textarea rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={TEMPLATE} />
          <Toggle checked={skip} onChange={setSkip} label="Skip connection test" description="Faster, but broken credentials will only show up when the mailbox first syncs." />
        </div>
      )}
    </Modal>
  );
}
