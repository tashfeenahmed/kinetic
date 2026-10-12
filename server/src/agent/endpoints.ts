/** `find_endpoints`: keyword search over the route registry (summaries feed the API docs too). */
import { z, type ZodType } from 'zod';
import { routeDocs, type RouteDoc } from '../http.ts';
import { classifyRoute } from './policy.ts';

/** A zod schema as short JSON-ish text, e.g. `{name: string, limit?: number = 100, mode: "a"|"b"}`. */
export function compactSchema(schema: ZodType | undefined): string | undefined {
  if (!schema) return undefined;
  try {
    const js = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as any;
    return render(js, js, 0);
  } catch {
    return undefined;
  }
}

function render(s: any, root: any, depth: number): string {
  if (!s || typeof s !== 'object') return 'any';
  if (s.$ref) {
    const key = String(s.$ref).split('/').pop()!;
    const def = root.$defs?.[key] ?? root.definitions?.[key];
    return depth > 3 || !def ? key : render(def, root, depth + 1);
  }
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join('|');
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map((x: any) => render(x, root, depth)))].join('|');
  if (s.allOf) return s.allOf.map((x: any) => render(x, root, depth)).join(' & ');
  const t = Array.isArray(s.type) ? s.type.join('|') : s.type;
  if (t === 'object' || s.properties) {
    if (depth > 4) return 'object';
    const req = new Set<string>(s.required ?? []);
    const props = Object.entries(s.properties ?? {}).map(([k, v]: [string, any]) => {
      const dflt = v?.default !== undefined ? ` = ${JSON.stringify(v.default)}` : '';
      return `${k}${req.has(k) ? '' : '?'}: ${render(v, root, depth + 1)}${dflt}`;
    });
    if (!props.length && s.additionalProperties) return `{[key]: ${render(s.additionalProperties, root, depth + 1)}}`;
    return `{${props.join(', ')}}`;
  }
  if (t === 'array') return `${render(s.items, root, depth + 1)}[]`;
  if (t === 'integer') return 'number';
  return t ?? 'any';
}

function score(r: RouteDoc, terms: string[]): number {
  const hay = `${r.method} ${r.url} ${r.tag} ${r.summary}`.toLowerCase();
  let n = 0;
  for (const t of terms) {
    if (!hay.includes(t)) continue;
    n += r.summary.toLowerCase().includes(t) ? 3 : 0;
    n += r.url.toLowerCase().includes(t) ? 2 : 0;
    n += r.tag.toLowerCase().includes(t) ? 1 : 0;
    n += 1;
  }
  return n;
}

export function findEndpoints(query: string, limit = 12) {
  const terms = query.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 1).map((t) => t.replace(/s$/, ''));
  const docs = routeDocs.filter((r) => !r.public && classifyRoute(r.method, r.url.replace(/:[^/]+/g, '1')).kind !== 'deny');
  const ranked = terms.length ? docs.map((r) => ({ r, s: score(r, terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s) : docs.map((r) => ({ r, s: 0 }));
  return ranked.slice(0, limit).map(({ r }) => {
    const verdict = classifyRoute(r.method, r.url.replace(/:[^/]+/g, '1'));
    return {
      method: r.method, path: r.url, summary: r.summary, tag: r.tag,
      ...(r.body ? { body: compactSchema(r.body) } : {}),
      ...(r.query ? { query: compactSchema(r.query) } : {}),
      ...(verdict.kind === 'approve' ? { needs_approval: true } : {}),
    };
  });
}
