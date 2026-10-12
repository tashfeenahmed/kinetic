/** Kinetic server client, used by the service worker and the options page. */
import { getLocal } from './storage.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const normalizeServerUrl = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/automations.*$/, '');

/** Calls the Kinetic API with an explicit base URL/token (pairing) or the stored pairing. */
export async function kinetic<T = any>(path: string, body?: unknown, opts: { method?: string; serverUrl?: string; token?: string | null } = {}): Promise<T> {
  let base = opts.serverUrl;
  let token = opts.token;
  if (!base || token === undefined) {
    const p = (await getLocal()).pairing;
    base ??= p?.serverUrl;
    if (token === undefined) token = p?.token ?? null;
  }
  if (!base) throw new ApiError(0, 'Kinetic URL is not set — open the extension options.');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${normalizeServerUrl(base)}${path}`, {
      method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ApiError(0, `Can't reach Kinetic at ${base} (${(e as Error).message})`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && typeof data === 'object' && data.message) || `Kinetic returned ${res.status}`);
  return data as T;
}

/** Origin pattern for chrome.permissions (the Kinetic server may be on any host). */
export function originPattern(serverUrl: string): string {
  const u = new URL(normalizeServerUrl(serverUrl));
  return `${u.protocol}//${u.hostname}/*`;
}
