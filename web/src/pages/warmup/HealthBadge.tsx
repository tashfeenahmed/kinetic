import { Badge } from '../../components/ui.tsx';

/** Inbox placement score: >=90 healthy, 70–89 watch, <70 at risk. */
export function HealthBadge({ score, large }: { score: number | null; large?: boolean }) {
  if (score === null || score === undefined) return <span className={large ? 'text-base text-slate-400' : 'text-[13px] text-slate-400'}>No data yet</span>;
  const tone = score >= 90 ? 'green' : score >= 70 ? 'yellow' : 'red';
  return <Badge tone={tone} className={large ? 'text-sm' : undefined}>{score}%</Badge>;
}
