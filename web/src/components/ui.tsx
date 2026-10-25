import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, ChevronDown, CheckCircle2, Info, Loader2, X } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-zinc-900 text-white hover:bg-zinc-800 shadow-sm disabled:bg-zinc-900/50',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 shadow-sm disabled:text-slate-400',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-600/60',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm disabled:bg-emerald-600/60',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800', className)} {...rest} />
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------
const fieldBase = 'w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, 'h-9', invalid && 'border-red-400 focus:border-red-500 focus:ring-red-500/20', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, 'py-2 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select className={cx(fieldBase, 'h-9 appearance-none pr-8')} {...rest}>{children}</select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          {label && <div className="text-sm font-medium text-slate-800">{label}</div>}
          {description && <div className="mt-0.5 text-[13px] text-slate-500">{description}</div>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand-600' : 'bg-slate-300')}
      >
        <span className={cx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

export function Checkbox({ checked, onChange, indeterminate, label, className }: { checked: boolean; onChange: (v: boolean) => void; indeterminate?: boolean; label?: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className={cx('size-4 cursor-pointer rounded border-slate-300 text-brand-600 accent-brand-600', className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
export type Tone = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'orange';
const TONES: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-emerald-100/70 text-emerald-800',
  yellow: 'bg-amber-100/80 text-amber-800',
  red: 'bg-red-50 text-red-700',
  purple: 'bg-violet-50 text-violet-700',
  orange: 'bg-orange-50 text-orange-700',
};

export function Badge({ tone = 'gray', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Card({ children, className, title, actions, description, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; description?: ReactNode; padded?: boolean }) {
  return (
    // Unpadded cards hold tables and lists edge to edge inside the border.
    <section className={cx('rounded-2xl border border-slate-200 bg-white', !padded && 'overflow-hidden', className)}>
      {(title || actions) && (
        <header className={cx('flex items-start justify-between gap-4 px-5 pt-4', padded ? 'pb-0' : 'pb-3')}>
          <div>
            {title && <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>}
            {description && <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'green' | 'red' | 'blue' }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-slate-500">{label}</div>
      {/* Only problems get colour; everything else stays neutral. */}
      <div className={cx('mt-0.5 text-2xl font-semibold tracking-tight', tone === 'red' ? 'text-red-600' : 'text-slate-900')}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-5 animate-spin text-slate-400', className)} />;
}

/** Loading text with a moving grey sweep (see `.text-shimmer` in index.css). */
export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('text-shimmer', className)} role="status">{children}</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-sm">
      <Shimmer>{label}</Shimmer>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'blue', title, children, action }: { tone?: 'blue' | 'yellow' | 'red' | 'green'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const styles = { blue: 'bg-blue-50 border-blue-200 text-blue-900', yellow: 'bg-amber-50 border-amber-200 text-amber-900', red: 'bg-red-50 border-red-200 text-red-900', green: 'bg-emerald-50 border-emerald-200 text-emerald-900' }[tone];
  const Icon = tone === 'green' ? CheckCircle2 : tone === 'blue' ? Info : AlertCircle;
  return (
    <div className={cx('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', styles)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'green' | 'red' | 'yellow' }) {
  const color = { blue: 'bg-brand-600', green: 'bg-emerald-500', red: 'bg-red-500', yellow: 'bg-amber-500' }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs (segmented, like the campaign view)
// ---------------------------------------------------------------------------
export interface TabItem { id: string; label: string; icon?: ReactNode; count?: number }

export function Tabs({ items, value, onChange, className }: { items: TabItem[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={cx('inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 scroll-thin', className)} role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            value === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] text-slate-700">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto scroll-thin', className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cx('whitespace-nowrap border-b border-slate-200 px-4 py-3 text-[13px] font-semibold text-slate-700', className)}>{children}</th>
);
export const Td = ({ children, className, onClick }: { children?: ReactNode; className?: string; onClick?: () => void }) => (
  <td onClick={onClick} className={cx('border-b border-slate-100 px-4 py-3 align-middle text-slate-700', className)}>{children}</td>
);

export function Pagination({ meta, onPage }: { meta?: { current_page: number; last_page: number; total: number; per_page: number }; onPage: (p: number) => void }) {
  if (!meta || meta.total === 0) return null;
  const from = (meta.current_page - 1) * meta.per_page + 1;
  const to = Math.min(meta.total, meta.current_page * meta.per_page);
  return (
    <div className="flex items-center justify-between px-4 py-3 text-[13px] text-slate-600">
      <span>Showing {from.toLocaleString()} to {to.toLocaleString()} of {meta.total.toLocaleString()} results</span>
      {meta.last_page > 1 && (
        <div className="flex gap-2">
          <Button size="sm" disabled={meta.current_page <= 1} onClick={() => onPage(meta.current_page - 1)}>Previous</Button>
          <Button size="sm" disabled={meta.current_page >= meta.last_page} onClick={() => onPage(meta.current_page + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------
function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, active]);
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEscape(onClose, open);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full rounded-2xl bg-white shadow-xl', width)} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, subtitle, children, actions, width = 'max-w-xl' }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; width?: string }) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={cx('flex h-full w-full flex-col bg-white shadow-2xl', width)}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 scroll-thin">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

/**
 * A floating panel anchored to an element, rendered at the top of the page (portal + fixed
 * position) so scrolling tables, cards and drawers can't clip it. Opens below the anchor,
 * or above when there isn't room, stays inside the window, and follows the anchor on scroll.
 */
export function Popover({ anchor, open, onClose, align = 'left', className, children }: {
  anchor: HTMLElement | null; open: boolean; onClose: () => void; align?: 'left' | 'right'; className?: string; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    if (!anchor || !panel.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const gap = 4, pad = 8;
    const below = a.bottom + gap + p.height <= window.innerHeight - pad || a.top - gap - p.height < pad;
    const top = below ? Math.min(a.bottom + gap, window.innerHeight - pad - p.height) : a.top - gap - p.height;
    const left = align === 'right' ? a.right - p.width : a.left;
    setPos({ top: Math.max(pad, top), left: Math.min(Math.max(pad, left), window.innerWidth - pad - p.width) });
  }, [anchor, align]);
  useEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place, anchor, onClose]);
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <div ref={panel} className={cx('fixed z-[60]', className)} style={pos ?? { top: -9999, left: -9999, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

/** Dropdown menu anchored to its trigger. */
export function Menu({ trigger, items, align = 'right' }: { trigger: (open: () => void) => ReactNode; items: ({ label: ReactNode; onClick: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean } | 'divider')[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative inline-block" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      <Popover anchor={ref.current} open={open} onClose={close} align={align} className="min-w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
        {items.map((it, i) =>
          it === 'divider' ? <div key={i} className="my-1 border-t border-slate-100" /> : (
            <button
              key={i}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-40', it.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50')}
            >
              {it.icon}
              {it.label}
            </button>
          ),
        )}
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts and confirm dialogs
// ---------------------------------------------------------------------------
interface ToastItem { id: number; message: string; tone: 'success' | 'error' | 'info' }
interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }

const UiContext = createContext<{ toast: (m: string, tone?: ToastItem['tone']) => void; confirm: (o: ConfirmOpts) => Promise<boolean> } | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);

  const toast = useCallback((message: string, tone: ToastItem['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve })), []);
  const close = (v: boolean) => { dialog?.resolve(v); setDialog(null); };

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id} className={cx('pointer-events-auto flex items-start gap-2 rounded-lg border bg-white px-4 py-3 text-sm shadow-lg', t.tone === 'error' ? 'border-red-200' : 'border-slate-200')}>
              {t.tone === 'success' ? <Check className="mt-0.5 size-4 text-emerald-600" /> : t.tone === 'error' ? <AlertCircle className="mt-0.5 size-4 text-red-600" /> : <Info className="mt-0.5 size-4 text-brand-600" />}
              <span className="text-slate-800">{t.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
      <Modal
        open={!!dialog}
        onClose={() => close(false)}
        title={dialog?.title ?? ''}
        size="sm"
        footer={<>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={dialog?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{dialog?.confirmLabel ?? 'Confirm'}</Button>
        </>}
      >
        <div className="text-sm text-slate-600">{dialog?.message}</div>
      </Modal>
    </UiContext.Provider>
  );
}

export function useUi() {
  const v = useContext(UiContext);
  if (!v) throw new Error('UiProvider missing');
  return v;
}

/** Click-to-copy text, used for tokens and DNS values. */
export function CopyText({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className={cx('inline-flex max-w-full items-center gap-2 rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700 hover:bg-slate-200', className)}
      title="Copy"
    >
      <span className="truncate">{value}</span>
      <span className="shrink-0 text-[11px] font-sans text-slate-500">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
