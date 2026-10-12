/**
 * Value normalisation for table lookups and send-to-table dedupe: two values
 * match when their normalised keys are equal.
 */
import { toDomain } from '../lib/sandbox.ts';
import { unwrap } from '../lib/template.ts';

export const MATCH_MODES = ['exact', 'case_insensitive', 'domain', 'email', 'company'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/** Legal suffixes and filler words dropped when comparing company names. */
const COMPANY_NOISE = new Set([
  'the', 'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'sarl',
  'bv', 'nv', 'oy', 'ab', 'as', 'aps', 'pty', 'pte', 'srl', 'spa', 'kg', 'ug', 'group', 'holdings', 'holding',
]);

/** The comparable key for one value, or '' when it has nothing to match on. */
export function matchKey(value: unknown, mode: MatchMode = 'exact'): string {
  const v = unwrap(value);
  if (v == null) return '';
  const s = (typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
  if (!s) return '';
  switch (mode) {
    case 'case_insensitive': return s.toLowerCase().replace(/\s+/g, ' ');
    case 'domain': return toDomain(s).replace(/\/.*$/, '').replace(/\.$/, '');
    case 'email': {
      const e = s.toLowerCase().replace(/^mailto:/, '').replace(/^<|>$/g, '');
      const [local, domain] = e.split('@');
      if (!domain) return e;
      return `${local.replace(/\+.*$/, '')}@${domain}`;
    }
    case 'company': {
      const words = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/[^a-z0-9.\s]+/g, ' ').replace(/\.(?=\s|$)/g, ' ')
        .split(/\s+/).filter(Boolean);
      // A bare domain ("acme.io") compares as its name part.
      if (words.length === 1 && /\.[a-z]{2,}$/.test(words[0])) return words[0].replace(/^www\./, '').split('.')[0];
      const kept = words.filter((w) => !COMPANY_NOISE.has(w.replace(/\./g, '')));
      return (kept.length ? kept : words).join(' ').replace(/\./g, '');
    }
    default: return s;
  }
}

/** Every key a stored cell matches on: list values match on each item. */
export function cellKeys(value: unknown, mode: MatchMode): string[] {
  const v = unwrap(value);
  if (Array.isArray(v)) return v.map((x) => matchKey(x, mode)).filter(Boolean);
  const k = matchKey(v, mode);
  return k ? [k] : [];
}

/** A value meant to be a list (explode source): arrays, JSON arrays, or {value: [...]}. */
export function toList(value: unknown): unknown[] {
  let v: unknown = value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.value)) v = o.value;
    else if (o.data && typeof o.data === 'object') {
      const firstList = Object.values(o.data as object).find(Array.isArray);
      v = firstList ?? o.value ?? null;
    } else v = o.value ?? v;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { const p = JSON.parse(t); if (Array.isArray(p)) return p; } catch { /* plain text */ } }
    return t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  return v == null ? [] : [v];
}
