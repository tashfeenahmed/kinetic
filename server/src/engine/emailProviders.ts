/**
 * Which mailbox provider hosts each lead's domain (Google, Microsoft, ...), read from MX
 * records and cached in `email_domains`. A background job resolves new domains a few at a
 * time so filters like "email provider = Microsoft" work on the Leads page.
 */
import { promises as dns } from 'node:dns';
import type { Ctx } from '../context.ts';

export const EMAIL_PROVIDERS = ['google', 'microsoft', 'yahoo', 'zoho', 'icloud', 'proofpoint', 'mimecast', 'barracuda', 'other', 'none'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
}

let resolver: MxResolver = new dns.Resolver({ timeout: 4000, tries: 2 });

/** Tests swap in a fake resolver so no real DNS is queried. */
export function setMxResolver(r: MxResolver) {
  resolver = r;
}

export function providerFromMx(hosts: string[]): EmailProvider {
  if (!hosts.length) return 'none';
  const list = hosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  const on = (...suffixes: string[]) => list.some((h) => suffixes.some((s) => h === s || h.endsWith(`.${s}`)));
  if (on('google.com', 'googlemail.com')) return 'google';
  if (on('outlook.com', 'hotmail.com', 'office365.us')) return 'microsoft';
  if (on('yahoodns.net', 'yahoo.com')) return 'yahoo';
  if (on('zoho.com', 'zoho.eu', 'zoho.in', 'zohomail.com')) return 'zoho';
  if (on('icloud.com', 'me.com', 'apple.com')) return 'icloud';
  if (on('pphosted.com', 'ppe-hosted.com')) return 'proofpoint';
  if (on('mimecast.com', 'mimecast.co.za')) return 'mimecast';
  if (on('barracudanetworks.com', 'ess.barracudanetworks.com')) return 'barracuda';
  return 'other';
}

/** Resolves and caches the provider of each domain. Errors other than "no MX" leave the domain for a later try. */
export async function resolveDomains(ctx: Ctx, domains: string[]): Promise<number> {
  let n = 0;
  const now = ctx.now().toISOString();
  await Promise.all(domains.map(async (d) => {
    const domain = d.toLowerCase();
    let hosts: string[] = [];
    try {
      hosts = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
    } catch (e: any) {
      if (!['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ESERVFAIL'].includes(e?.code)) return;
    }
    ctx.db.run('INSERT OR REPLACE INTO email_domains (domain, provider, mx, checked_at) VALUES (?, ?, ?, ?)',
      [domain, providerFromMx(hosts), hosts.slice(0, 5).join(', ') || null, now]);
    n++;
  }));
  return n;
}

/** Domains used by leads that have not been resolved yet. */
export function unresolvedDomains(ctx: Ctx, limit: number, workspaceId?: number): string[] {
  return ctx.db.all<{ d: string }>(
    `SELECT DISTINCT lower(substr(email, instr(email, '@') + 1)) AS d FROM leads
     WHERE ${workspaceId ? 'workspace_id = ? AND' : ''} instr(email, '@') > 0
       AND lower(substr(email, instr(email, '@') + 1)) NOT IN (SELECT domain FROM email_domains)
     LIMIT ?`, workspaceId ? [workspaceId, limit] : [limit]).map((r) => r.d).filter(Boolean);
}

/** Worker job: resolve a batch of new lead domains. */
export async function refreshEmailProviders(ctx: Ctx, limit = 40): Promise<{ resolved: number }> {
  const domains = unresolvedDomains(ctx, limit);
  if (!domains.length) return { resolved: 0 };
  return { resolved: await resolveDomains(ctx, domains) };
}
