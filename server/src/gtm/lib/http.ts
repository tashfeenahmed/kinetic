/** fetch with a timeout, JSON helpers and readable errors. */
import { fetch as undiciFetch, ProxyAgent } from 'undici';
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined | null>;
  json?: unknown;
  body?: string;
  timeoutMs?: number;
}

let httpFetch: typeof fetch = (...a) => globalThis.fetch(...a);

/** The app passes its injectable fetch (tests replace it to capture outbound calls). */
export function setHttpFetch(f: typeof fetch) {
  httpFetch = f;
}

// ---- optional outbound proxy for lookups (SCRAPE_PROXY) --------------------
let proxyUrl: () => string | undefined = () => undefined;
let agent: { url: string; dispatcher: ProxyAgent } | null = null;

/** Where to read the proxy URL from (the GTM settings; read live so changes apply at once). */
export function setProxySource(fn: () => string | undefined) {
  proxyUrl = fn;
}

/** Local and private addresses (your own SearXNG, Ollama…) never go through the proxy. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

function proxyFor(u: URL): ProxyAgent | null {
  const url = proxyUrl()?.trim();
  if (!url || isPrivateHost(u.hostname)) return null;
  if (agent?.url !== url) agent = { url, dispatcher: new ProxyAgent(url) };
  return agent.dispatcher;
}

export async function request(url: string, opts: RequestOpts = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'user-agent': 'kineticsand/0.1', ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  }
  const init = {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    redirect: 'follow' as const,
  };
  const dispatcher = proxyFor(u);
  // undici's own fetch understands the proxy dispatcher; the response is a standard Response.
  if (dispatcher) return undiciFetch(u, { ...init, dispatcher }) as unknown as Promise<Response>;
  return httpFetch(u as any, init);
}

export async function getJson<T = any>(url: string, opts: RequestOpts = {}): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
    throw new HttpError(res.status, `${new URL(url).hostname} ${res.status}: ${detail}`, data);
  }
  return data as T;
}
