/**
 * Native matcher for the open-source Wappalyzer fingerprint database
 * (github.com/enthec/webappanalyzer, GPL-3.0). The data is downloaded at
 * runtime and cached for a week — it isn't bundled with this code.
 *
 * Supports the static fingerprint types: html, scriptSrc, scripts, meta,
 * headers, cookies, url, dns, plus `implies`. Browser-only types (js, dom)
 * are skipped since pages are fetched without a JS engine.
 */
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getJson } from './http.ts';

const BASE = 'https://raw.githubusercontent.com/enthec/webappanalyzer/main/src';
const FILES = [...'abcdefghijklmnopqrstuvwxyz'.split(''), '_'];

interface Pattern { re: RegExp; version?: string }
interface Tech {
  name: string; cats: number[]; implies: string[];
  html: Pattern[]; scriptSrc: Pattern[]; scripts: Pattern[]; url: Pattern[];
  meta: Record<string, Pattern[]>; headers: Record<string, Pattern[]>; cookies: Record<string, Pattern[]>; dns: Record<string, Pattern[]>;
  website?: string; saas?: boolean;
}
interface Db { techs: Tech[]; categories: Record<string, string> }

let db: Db | null = null;
let loading: Promise<Db> | null = null;

export async function loadFingerprints(cacheDir: string): Promise<Db> {
  if (db) return db;
  loading ??= (async () => {
    mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, 'wappalyzer.json');
    let raw: { technologies: Record<string, any>; categories: Record<string, any> } | null = null;
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 7 * 86_400_000) raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw) {
      const parts = await Promise.all(FILES.map((f) => getJson(`${BASE}/technologies/${f}.json`, { timeoutMs: 60_000 })));
      raw = { technologies: Object.assign({}, ...parts), categories: await getJson(`${BASE}/categories.json`) };
      writeFileSync(file, JSON.stringify(raw));
    }
    db = compile(raw);
    return db;
  })();
  try { return await loading; } finally { loading = null; }
}

function pats(v: unknown): Pattern[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out: Pattern[] = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    const [src, ...tags] = s.split('\;');
    try {
      out.push({ re: new RegExp(src, 'i'), version: tags.find((t) => t.startsWith('version:'))?.slice(8) });
    } catch { /* some upstream regexes are PCRE-only; skip them */ }
  }
  return out;
}

function patMap(v: unknown): Record<string, Pattern[]> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.toLowerCase(), pats(x === '' ? '.*' : x)]));
}

function compile(raw: { technologies: Record<string, any>; categories: Record<string, any> }): Db {
  const techs: Tech[] = Object.entries(raw.technologies).map(([name, t]) => ({
    name, cats: t.cats ?? [], website: t.website, saas: t.saas,
    implies: (Array.isArray(t.implies) ? t.implies : t.implies ? [t.implies] : []).map((s: string) => s.split('\;')[0]),
    html: pats(t.html), scriptSrc: pats(t.scriptSrc), scripts: pats(t.scripts), url: pats(t.url),
    meta: patMap(t.meta), headers: patMap(t.headers), cookies: patMap(t.cookies), dns: patMap(t.dns),
  }));
  const categories = Object.fromEntries(Object.entries(raw.categories).map(([id, c]: [string, any]) => [id, c.name]));
  return { techs, categories };
}

export interface PageSignals {
  url: string;
  html: string;
  headers: Record<string, string>;
  dns: Record<string, string[]>; // TXT, MX, NS, CNAME…
}

export interface Detection { name: string; categories: string[]; version?: string; website?: string; via: string }

export function detect(fp: Db, page: PageSignals): Detection[] {
  const html = page.html.slice(0, 600_000);
  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n').slice(0, 300_000);
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const name = m[0].match(/(?:name|property|http-equiv)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = m[0].match(/content=["']([^"']*)["']/i)?.[1];
    if (name && content != null) meta[name] = content;
  }
  const headers = Object.fromEntries(Object.entries(page.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const cookieNames = (headers['set-cookie'] ?? '').split(/,(?=[^;]+=)/).map((c) => c.split('=')[0].trim().toLowerCase()).filter(Boolean);
  const found = new Map<string, Detection>();
  const hit = (t: Tech, via: string, m?: RegExpMatchArray | null, p?: Pattern) => {
    if (found.has(t.name)) return;
    const version = p?.version && m ? p.version.replace(/\\(\d)/g, (_, i) => m[Number(i)] ?? '').trim() || undefined : undefined;
    found.set(t.name, { name: t.name, categories: t.cats.map((c) => fp.categories[c]).filter(Boolean), version, website: t.website, via });
  };
  const any = (list: Pattern[], values: string[]) => {
    for (const p of list) for (const v of values) { const m = v.match(p.re); if (m) return { m, p }; }
    return null;
  };

  for (const t of fp.techs) {
    let r;
    if (t.html.length && (r = any(t.html, [html]))) { hit(t, 'html', r.m, r.p); continue; }
    if (t.scriptSrc.length && (r = any(t.scriptSrc, scriptSrcs))) { hit(t, 'script', r.m, r.p); continue; }
    if (t.scripts.length && inline && (r = any(t.scripts, [inline]))) { hit(t, 'inline script', r.m, r.p); continue; }
    if (t.url.length && (r = any(t.url, [page.url]))) { hit(t, 'url', r.m, r.p); continue; }
    let matched = false;
    for (const [k, list] of Object.entries(t.meta)) if (meta[k] != null && (r = any(list, [meta[k]]))) { hit(t, `meta ${k}`, r.m, r.p); matched = true; break; }
    if (matched) continue;
    for (const [k, list] of Object.entries(t.headers)) if (headers[k] != null && (r = any(list, [headers[k]]))) { hit(t, `header ${k}`, r.m, r.p); matched = true; break; }
    if (matched) continue;
    for (const k of Object.keys(t.cookies)) if (cookieNames.includes(k)) { hit(t, `cookie ${k}`); matched = true; break; }
    if (matched) continue;
    for (const [type, list] of Object.entries(t.dns)) {
      const records = page.dns[type.toUpperCase()] ?? [];
      if (records.length && (r = any(list, records))) { hit(t, `dns ${type.toUpperCase()}`, r.m, r.p); break; }
    }
  }
  // Implied technologies (e.g. WordPress → PHP, MySQL).
  const byName = new Map(fp.techs.map((t) => [t.name, t]));
  const queue = [...found.keys()];
  while (queue.length) {
    const t = byName.get(queue.pop()!);
    for (const imp of t?.implies ?? []) {
      const it = byName.get(imp);
      if (it && !found.has(imp)) { hit(it, `implied by ${t!.name}`); queue.push(imp); }
    }
  }
  return [...found.values()];
}
