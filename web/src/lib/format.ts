export const fmtNumber = (n: number | null | undefined) => (n ?? 0).toLocaleString();

export const fmtPct = (n: number | null | undefined) => `${(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

export function fmtDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, opts);
}

export function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "3m ago", "Aug 19" style labels for lists. */
export function fmtRelative(iso?: string | null) {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 3_600_000) return `in ${Math.max(1, Math.round(ahead / 60_000))}m`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`;
    return fmtDateTime(iso);
  }
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return fmtDate(iso);
}

export const fullName = (l: { first_name?: string; last_name?: string; email?: string }) =>
  `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || l.email || '';

export const initials = (name: string) =>
  name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

const AVATAR_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-rose-500', 'bg-amber-500', 'bg-cyan-500', 'bg-fuchsia-500', 'bg-teal-500'];
export const avatarColor = (seed: string) => AVATAR_COLORS[[...seed].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length]!;

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${fmtNumber(n)} ${n === 1 ? word : pluralWord}`;
