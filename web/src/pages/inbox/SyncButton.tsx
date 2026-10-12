import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { cx, useUi } from '../../components/ui.tsx';

interface SyncResult {
  mailboxes: { email: string; name: string | null; status: 'synced' | 'error' | 'timeout'; new_messages: number; error: string | null }[];
  totals: { mailboxes: number; synced: number; new_messages: number; errors: number };
  last_synced_at: string | null;
}

/** "Fetch new email": syncs every connected mailbox now (Shift+R), with a "last synced" hint. */
export function SyncButton() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const status = useQuery({
    queryKey: ['inbox', 'sync-status'],
    queryFn: () => api.get('/api/replies/sync-status').then((r) => r.data as { last_synced_at: string | null; mailboxes: number; syncing: boolean }),
    refetchInterval: 30_000,
  });
  // Re-render every 30s so "2m ago" stays current.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  const sync = useMutation({
    mutationFn: () => api.post('/api/replies/sync', {}).then((r) => r.data as SyncResult),
    onSuccess: (d) => {
      const n = d.totals.new_messages;
      if (!d.totals.mailboxes) toast('No connected mailboxes to sync', 'info');
      else if (n || d.totals.synced) toast(n ? `${n} new message${n === 1 ? '' : 's'}` : 'Up to date');
      const failed = d.mailboxes.filter((x) => x.status !== 'synced');
      if (failed.length > 3) toast(`${failed.length} mailboxes failed to sync: ${failed.map((m) => m.name || m.email).join(', ')}`, 'error');
      else for (const m of failed) toast(`${m.name || m.email}: ${m.error ?? 'sync failed'}`, 'error');
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['unread-count'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'r') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      if (!sync.isPending) sync.mutate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sync]);

  const busy = sync.isPending || !!status.data?.syncing;
  const last = status.data?.last_synced_at;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {(last || sync.isPending) && (
        <span className={cx('hidden text-[11.5px] tabular-nums text-zinc-400 sm:inline', sync.isPending && 'text-shimmer')} title={last ? `Last synced ${new Date(last).toLocaleString()}` : undefined}>
          {sync.isPending ? 'Syncing…' : `Synced ${fmtRelative(last)}`}
        </span>
      )}
      <button type="button" onClick={() => sync.mutate()} disabled={sync.isPending} aria-label="Fetch new email" title="Fetch new email (Shift+R)"
        className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default">
        <RefreshCw className={cx('size-3.5', busy && 'animate-spin')} />
      </button>
    </div>
  );
}
