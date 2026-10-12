import vm from 'node:vm';
import { unwrap, getPath } from './template.ts';

/**
 * Evaluates user formulas / run-if conditions. `row` holds headline values
 * ("Work email" → "a@b.com"); `raw` holds full cell payloads. This isolates
 * globals and caps runtime, but it is not a security boundary: only run
 * formulas you wrote yourself.
 */
export function evaluate(expression: string, rowRaw: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  const row = Object.fromEntries(Object.entries(rowRaw).map(([k, v]) => [k, unwrap(v)]));
  const context = vm.createContext({
    row,
    raw: rowRaw,
    get: (v: unknown, path: string) => getPath(v, path),
    domain: toDomain,
    lower: (s: unknown) => String(s ?? '').toLowerCase(),
    first: (s: unknown) => String(s ?? '').trim().split(/\s+/)[0] ?? '',
    last: (s: unknown) => { const p = String(s ?? '').trim().split(/\s+/); return p.length > 1 ? p[p.length - 1] : ''; },
    ...extra,
  });
  const body = /^\s*(return\b|[\s\S]*;\s*return\b)/.test(expression) ? expression : `return (${expression});`;
  return vm.runInContext(`(() => { ${body} })()`, context, { timeout: 100 });
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

export function toDomain(input: unknown): string {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) return s.split('@').pop()!;
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return s.replace(/^www\./, '');
  }
}
