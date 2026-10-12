export class ApiError extends Error {
  status: number;
  fields: Record<string, string[]>;
  problems: string[];
  constructor(status: number, body: any) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.fields = body?.fields ?? {};
    this.problems = body?.problems ?? [];
  }
}

export interface Paginated<T> {
  data: T[];
  meta: { current_page: number; per_page: number; total: number; last_page: number };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('kinetic:unauthorized'));
    throw new ApiError(res.status, json);
  }
  return json as T;
}

export const api = {
  get: <T = any>(url: string, params?: Record<string, unknown>) => request<T>('GET', withQuery(url, params)),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T = any>(url: string, body?: unknown) => request<T>('DELETE', url, body),
};

export function withQuery(url: string, params?: Record<string, unknown>) {
  if (!params) return url;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${url}${url.includes('?') ? '&' : '?'}${s}` : url;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const firstField = Object.entries(e.fields)[0];
    if (firstField && e.message === 'The given data was invalid.') return `${firstField[0].replace(/_/g, ' ')} ${firstField[1][0]}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
