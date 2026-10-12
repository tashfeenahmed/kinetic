import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { cx } from '../../components/ui.tsx';
import type { DnsCheck, DomainReport } from './types.ts';

const ICON = {
  pass: <CheckCircle2 className="size-4 text-emerald-600" />,
  warn: <AlertTriangle className="size-4 text-amber-500" />,
  fail: <XCircle className="size-4 text-red-600" />,
};

const CHIP = {
  pass: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  fail: 'bg-red-50 text-red-700 ring-red-200',
};

/** Compact chips, one per record, for tables. */
export function DnsChips({ report }: { report: DomainReport }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {report.checks.map((c) => (
        <span key={c.name} title={c.advice} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', CHIP[c.status])}>
          {c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✕'} {c.name}
        </span>
      ))}
    </div>
  );
}

/** Full list with values and advice, for the detail drawer. */
export function DnsList({ checks }: { checks: DnsCheck[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {checks.map((c) => (
        <li key={c.name} className="flex gap-3 py-3 first:pt-0 last:pb-0">
          <div className="mt-0.5">{ICON[c.status]}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">{c.name}</div>
            {c.value && <div className="mt-0.5 break-all font-mono text-xs text-slate-500">{c.value}</div>}
            <div className={cx('mt-1 text-[13px]', c.status === 'pass' ? 'text-slate-500' : 'text-slate-700')}>{c.advice}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
