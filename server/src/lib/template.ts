/**
 * Email template rendering.
 *
 *   {FIRST_NAME}            lead variable (built-in or custom, case-insensitive)
 *   {FIRST_NAME|there}      variable with fallback when empty
 *   {Hi|Hello|Hey}          spintax: one option picked per lead
 *
 * A brace group is a variable when its first option is a known variable name,
 * otherwise it is spintax. Spintax choices are seeded so a lead always sees the
 * same text for a given step (stable previews, stable threading).
 */

export interface TemplateContext {
  lead: {
    email: string;
    first_name?: string;
    last_name?: string;
    title?: string;
    company?: string;
    custom_variables?: Record<string, string>;
  };
  sender?: { name: string; email: string; signature?: string };
  extra?: Record<string, string>;
}

export const BUILTIN_VARIABLES = [
  'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE',
  'SENDER_NAME', 'SENDER_FIRST_NAME', 'SENDER_EMAIL', 'SIGNATURE', 'UNSUBSCRIBE_LINK',
] as const;

export const varKey = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export function buildVariables(ctx: TemplateContext): Map<string, string> {
  const v = new Map<string, string>();
  const l = ctx.lead;
  v.set('FIRST_NAME', l.first_name ?? '');
  v.set('LAST_NAME', l.last_name ?? '');
  v.set('EMAIL', l.email);
  v.set('COMPANY', l.company ?? '');
  v.set('TITLE', l.title ?? '');
  for (const [k, val] of Object.entries(l.custom_variables ?? {})) v.set(varKey(k), String(val ?? ''));
  if (ctx.sender) {
    v.set('SENDER_NAME', ctx.sender.name);
    v.set('SENDER_FIRST_NAME', ctx.sender.name.split(/\s+/)[0] ?? '');
    v.set('SENDER_EMAIL', ctx.sender.email);
    v.set('SIGNATURE', ctx.sender.signature ?? '');
  }
  for (const [k, val] of Object.entries(ctx.extra ?? {})) v.set(varKey(k), val);
  return v;
}

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join(':')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export interface RenderOptions {
  seed?: number;
  /** Called for unknown variables; default leaves the braces untouched. */
  onUnknown?: (name: string) => string;
}

export function render(template: string, vars: Map<string, string>, opts: RenderOptions = {}): string {
  const rand = seededRandom(opts.seed ?? 1);
  // Innermost groups first so nested spintax works: {a|{b|c}}
  const group = /\{([^{}]*)\}/g;
  let out = template;
  for (let guard = 0; guard < 20 && group.test(out); guard++) {
    group.lastIndex = 0;
    out = out.replace(group, (whole, inner: string) => {
      const options = inner.split('|');
      const key = varKey(options[0]!);
      if (key && vars.has(key)) {
        const value = vars.get(key)!;
        return value !== '' ? value : (options[1] ?? '').trim();
      }
      if (options.length > 1) return options[Math.floor(rand() * options.length)]!;
      if (/^[A-Za-z][A-Za-z0-9_ ]*$/.test(inner)) return opts.onUnknown ? opts.onUnknown(inner) : `\u0000${inner}\u0001`;
      return `\u0000${inner}\u0001`;
    });
  }
  return out.replace(/\u0000/g, '{').replace(/\u0001/g, '}');
}

/** Variables used in a template that the context cannot fill. */
export function missingVariables(template: string, vars: Map<string, string>): string[] {
  const missing = new Set<string>();
  for (const m of template.matchAll(/\{([A-Za-z][A-Za-z0-9_ ]*)(\|[^{}]*)?\}/g)) {
    const key = varKey(m[1]!);
    if (!vars.has(key) && !m[2]) missing.add(key);
  }
  return [...missing];
}
