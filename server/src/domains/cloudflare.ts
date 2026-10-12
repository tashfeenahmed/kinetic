/** Minimal Cloudflare API v4 client (DNS records, zones, redirects). */
export interface CfRecord { id: string; type: string; name: string; content: string; priority?: number; ttl: number; proxied?: boolean; comment?: string }
export interface CfZone { id: string; name: string; status: string; name_servers?: string[]; account?: { id: string; name: string } }

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Cloudflare {
  private token: string;
  private fetch: typeof fetch;
  constructor(token: string, f: typeof fetch = globalThis.fetch) {
    this.token = token;
    this.fetch = f;
  }

  private async call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const res = await this.fetch(url as any, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || data?.success === false) {
      const msg = (data?.errors ?? []).map((e: any) => `${e.message}${e.code ? ` (${e.code})` : ''}`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(res.status, `Cloudflare: ${msg}`);
    }
    return data.result as T;
  }

  verifyToken() {
    return this.call<{ id: string; status: string; expires_on?: string }>('GET', '/user/tokens/verify');
  }

  accounts() {
    return this.call<{ id: string; name: string }[]>('GET', '/accounts', undefined, { per_page: 50 });
  }

  async zones(name?: string): Promise<CfZone[]> {
    const out: CfZone[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.call<CfZone[]>('GET', '/zones', undefined, { per_page: 50, page, ...(name ? { name } : {}) });
      out.push(...batch);
      if (batch.length < 50) break;
    }
    return out;
  }

  createZone(name: string, accountId: string) {
    return this.call<CfZone>('POST', '/zones', { name, account: { id: accountId }, type: 'full' });
  }

  async records(zoneId: string): Promise<CfRecord[]> {
    const out: CfRecord[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.call<CfRecord[]>('GET', `/zones/${zoneId}/dns_records`, undefined, { per_page: 100, page });
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  createRecord(zoneId: string, r: Omit<CfRecord, 'id'>) {
    return this.call<CfRecord>('POST', `/zones/${zoneId}/dns_records`, r);
  }

  updateRecord(zoneId: string, id: string, r: Omit<CfRecord, 'id'>) {
    return this.call<CfRecord>('PUT', `/zones/${zoneId}/dns_records/${id}`, r);
  }

  deleteRecord(zoneId: string, id: string) {
    return this.call<{ id: string }>('DELETE', `/zones/${zoneId}/dns_records/${id}`);
  }

  /** Redirect every request on the domain (root + www) to a URL, via a Single Redirect rule. */
  async setRedirect(zoneId: string, domain: string, target: string) {
    const rule = {
      description: 'Kinetic: redirect sending domain to main website',
      expression: `(http.host eq "${domain}") or (http.host eq "www.${domain}")`,
      action: 'redirect',
      action_parameters: { from_value: { status_code: 301, target_url: { value: target }, preserve_query_string: false } },
    };
    return this.call('PUT', `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { rules: [rule] });
  }
}
