import { useState } from 'react';
import { Plus, Radio } from 'lucide-react';
import { Button, Loading } from '../../components/ui.tsx';
import { JobForm } from './JobForm.tsx';
import { JobsList } from './Jobs.tsx';
import { usePhantoms } from './shared.tsx';

/** LinkedIn post monitors: scheduled jobs of the post-monitor phantom. */
export function Monitors() {
  const phantoms = usePhantoms();
  const [open, setOpen] = useState(false);
  const p = phantoms.data?.data.find((x) => x.id === 'linkedin.post_monitor') ?? null;
  if (phantoms.isLoading) return <Loading />;
  const add = <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} disabled={!p}>New post monitor</Button>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><Radio className="size-4" /></span>
          <div className="text-[13px]">
            <div className="font-medium text-zinc-900">Watch posts, people and company pages</div>
            <p className="mt-0.5 max-w-2xl text-zinc-500">Kinetic checks the posts you list — and new posts from the profiles and company pages you list — on a schedule, adds new reactors and commenters to a table, fires a “LinkedIn post engager” webhook event and can alert Slack.</p>
          </div>
        </div>
        {add}
      </div>
      <JobsList filter={{ phantom: 'linkedin.post_monitor' }} emptyAction={add} />
      <JobForm phantom={p} open={open} onClose={() => setOpen(false)} initial={{ name: 'Post monitor', schedule: 'daily' }} />
    </div>
  );
}
