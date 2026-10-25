import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Monitor, Search, Server } from 'lucide-react';
import { Alert, Input, Loading, cx } from '../../components/ui.tsx';
import { JobForm } from './JobForm.tsx';
import { CATEGORY_LABEL, CategoryChip, NETWORK_LABEL, NetworkIcon, useCompanionStatus, usePhantoms, type Category, type Network, type Phantom } from './shared.tsx';

const ORDER: Network[] = ['linkedin', 'sales_navigator', 'instagram', 'x', 'facebook', 'whatsapp', 'reddit', 'github'];

/** Phantom catalogue: a card grid grouped by network. */
export function Catalogue() {
  const phantoms = usePhantoms();
  const status = useCompanionStatus();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [open, setOpen] = useState<Phantom | null>(null);
  const paired = (status.data?.devices.length ?? 0) > 0;

  const groups = useMemo(() => {
    const list = (phantoms.data?.data ?? []).filter((p) =>
      (cat === 'all' || p.category === cat) && (!q || `${p.label} ${p.description} ${p.network}`.toLowerCase().includes(q.toLowerCase())));
    return ORDER.map((n) => ({ network: n, items: list.filter((p) => p.network === n) })).filter((g) => g.items.length);
  }, [phantoms.data, q, cat]);

  if (phantoms.isLoading) return <Loading />;
  return (
    <div className="space-y-6">
      {!paired && status.isSuccess && (
        <Alert tone="yellow" title="Install the Kinetic Companion extension"
          action={<Link to="/automations/extension" className="shrink-0 text-[13px] font-medium underline">Set it up</Link>}>
          LinkedIn, Instagram, X and Facebook automations run inside your own browser. Reddit and GitHub work without it.
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search automations" className="pl-8" />
        </div>
        {(['all', 'data', 'action', 'monitor'] as const).map((c) => (
          <button key={c} onClick={() => setCat(c)}
            className={cx('rounded-[7px] px-2.5 py-1 text-[13px]', cat === c ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>
            {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {groups.map((g) => (
        <section key={g.network}>
          <div className="mb-2 flex items-center gap-2">
            <NetworkIcon network={g.network} size={20} />
            <h3 className="text-[13.5px] font-semibold text-zinc-900">{NETWORK_LABEL[g.network]}</h3>
            <span className="text-[12px] text-zinc-400">{g.items.length}</span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((p) => {
              const dim = p.needs_extension && !paired;
              return (
                <button key={p.id} onClick={() => setOpen(p)}
                  className={cx('group flex flex-col rounded-2xl border border-zinc-200 bg-white p-3.5 text-left transition hover:border-zinc-300 hover:shadow-sm', dim && 'opacity-60 hover:opacity-100')}>
                  <div className="flex items-start gap-2.5">
                    <NetworkIcon network={p.network} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium text-zinc-900">{p.label}</div>
                      <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-zinc-500">{p.description}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-[11.5px] text-zinc-400">
                    <CategoryChip category={p.category} />
                    {p.runner === 'extension'
                      ? <span className="inline-flex items-center gap-1"><Monitor className="size-3" />Runs in your browser</span>
                      : <span className="inline-flex items-center gap-1"><Server className="size-3" />Runs on server</span>}
                    {p.watchable && <span className="ml-auto">Watcher</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {!groups.length && <p className="py-10 text-center text-[13px] text-zinc-500">No automations match.</p>}
      <JobForm phantom={open} open={!!open} onClose={() => setOpen(null)} />
    </div>
  );
}
