import { useState, type ReactNode } from 'react';
import { cx } from './ui.tsx';

/** Brand logo in a rounded tile (cached server-side); falls back to an icon or initial. */
export function BrandIcon({ domain, fallback, size = 36, className }: { domain?: string; fallback?: ReactNode; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-[9px] border border-zinc-200 bg-white text-zinc-600 shadow-sm', className)} style={{ width: size, height: size }}>
      {domain && !broken
        ? <img src={`/api/gtm/icon/${domain}`} alt="" width={size * 0.56} height={size * 0.56} className="rounded-[3px] object-contain" onError={() => setBroken(true)} loading="lazy" />
        : fallback}
    </span>
  );
}
