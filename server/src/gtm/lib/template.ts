/**
 * `{{Column}}` / `{{Column.path.to.field}}` substitution against a row's values.
 * Column names may contain spaces; the longest matching column name wins, so
 * `{{Company info.industry}}` resolves column "Company info", path "industry".
 */
export type RowValues = Record<string, unknown>;

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function render(template: string, row: RowValues): string {
  return template.replace(TOKEN, (_, ref: string) => stringify(resolveRef(ref, row)));
}

/** Like render, but a template that is exactly one token keeps the raw value (object, number…). */
export function renderValue(template: string, row: RowValues): unknown {
  const m = template.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (m) return resolveRef(m[1], row);
  return render(template, row);
}

/** Render every string inside a JSON-ish structure. */
export function renderDeep(value: unknown, row: RowValues): unknown {
  if (typeof value === 'string') return renderValue(value, row);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, row));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, row)]));
  }
  return value;
}

export function resolveRef(ref: string, row: RowValues): unknown {
  if (ref in row) return unwrap(row[ref]);
  const names = Object.keys(row).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (ref.startsWith(`${name}.`)) return getPath(row[name], ref.slice(name.length + 1));
  }
  return undefined;
}

/** Column names referenced by a template, given the table's column names. */
export function references(template: string, columnNames: string[]): string[] {
  const out = new Set<string>();
  const sorted = [...columnNames].sort((a, b) => b.length - a.length);
  for (const m of template.matchAll(TOKEN)) {
    const ref = m[1];
    const hit = sorted.find((n) => ref === n || ref.startsWith(`${n}.`));
    if (hit) out.add(hit);
  }
  return [...out];
}

/** Rewrite `{{Old…}}` tokens after a column rename. */
export function renameRefs(template: string, from: string, to: string): string {
  return template.replace(TOKEN, (whole, ref: string) => {
    if (ref === from) return `{{${to}}}`;
    if (ref.startsWith(`${from}.`)) return `{{${to}${ref.slice(from.length)}}}`;
    return whole;
  });
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    // Enriched cells wrap their payload as {value, data, ...}; let paths reach into data transparently.
    if (!(part in Object(cur)) && cur.data && typeof cur.data === 'object' && part in cur.data) cur = cur.data;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/** Cells from enrichment/signal columns are {value, ...}; templates see the headline value. */
export function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return (v as any).value;
  return v;
}

export function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
