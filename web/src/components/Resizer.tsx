import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cx } from './ui.tsx';

/** A pane width that the user can drag, remembered per browser. */
export function usePaneWidth(key: string, initial: number, min: number, max: number) {
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem(`k:pane:${key}`)); return v ? clamp(v) : initial; } catch { return initial; }
  });
  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    try { localStorage.setItem(`k:pane:${key}`, String(next)); } catch { /* storage unavailable */ }
  }, [clamp, key]);
  const reset = useCallback(() => {
    setWidth(initial);
    try { localStorage.removeItem(`k:pane:${key}`); } catch { /* storage unavailable */ }
  }, [initial, key]);
  return { width, set, reset };
}

/**
 * Vertical divider between two panes. Drag to resize the pane on its left,
 * double-click to reset it. Arrow keys work when it has focus.
 */
export function Resizer({ pane, className }: { pane: ReturnType<typeof usePaneWidth>; className?: string }) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.width;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => pane.set(startW + ev.clientX - startX);
    const up = () => {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={pane.width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={pane.reset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') pane.set(pane.width - 16);
        if (e.key === 'ArrowRight') pane.set(pane.width + 16);
      }}
      className={cx('group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize outline-none', className)}
    >
      <div className={cx('absolute inset-y-0 left-[3px] w-px transition-colors',
        dragging ? 'bg-brand-500' : 'bg-slate-200 group-hover:bg-slate-400 group-focus-visible:bg-brand-500')} />
    </div>
  );
}
