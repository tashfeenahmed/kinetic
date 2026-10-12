/** fetch with a timeout, JSON helpers and readable errors. */
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

export async function request(url: string, opts: RequestOpts = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'user-agent': 'kineticsand/0.1', ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  }
  return httpFetch(u as any, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    redirect: 'follow',
  });
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
