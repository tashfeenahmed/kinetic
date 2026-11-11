/**
 * Pre-send recipient domain check: a lead whose domain does not exist, or exists but cannot
 * receive mail, is a guaranteed hard bounce. Catching it before sending keeps those bounces off
 * the mailbox's reputation. Needs only DNS (no port 25), so it works on hosts that block SMTP probes.
 *
 * Dead = NXDOMAIN, a null MX (RFC 7505), or no MX and no A/AAAA (RFC 5321 implicit MX).
 * Timeouts and server failures are "unknown" and never stop a send. Answers are cached ~12h.
 */
import { promises as dns } from 'node:dns';
import type { Ctx } from '../context.ts';

export interface RecipientResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export type DomainVerdict = 'ok' | 'dead' | 'unknown';

let resolver: RecipientResolver = new dns.Resolver({ timeout: 4000, tries: 2 });

/** Tests swap in a fake resolver so no real DNS is queried. */
export function setRecipientResolver(r: RecipientResolver) {
  resolver = r;
}

const CACHE_MS = 12 * 3_600_000;
const missing = (e: any) => e?.code === 'ENOTFOUND' || e?.code === 'ENODATA';

async function lookup(domain: string): Promise<{ verdict: DomainVerdict; why?: string }> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length && mx.every((m) => !m.exchange || m.exchange === '.')) return { verdict: 'dead', why: 'domain does not accept email' };
    if (mx.length) return { verdict: 'ok' };
  } catch (e: any) {
    if (e?.code === 'ENOTFOUND') return { verdict: 'dead', why: 'domain does not exist' };
    if (!missing(e)) return { verdict: 'unknown' };
  }
  // No MX: mail falls back to the domain's own address.
  const results = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  if (results.some((r) => r.status === 'fulfilled' && r.value.length)) return { verdict: 'ok' };
  if (results.every((r) => r.status === 'rejected' && missing(r.reason))) return { verdict: 'dead', why: 'domain has no mail server' };
  return { verdict: 'unknown' };
}

/** Whether `email`'s domain can receive mail. `why` explains a dead verdict. */
export async function checkRecipientDomain(ctx: Ctx, email: string): Promise<{ verdict: DomainVerdict; why?: string }> {
  const domain = email.split('@')[1]?.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return { verdict: 'dead', why: 'email address has no domain' };
  const key = `rcpt:${domain}`;
  const row = ctx.db.get('SELECT * FROM health_dns_cache WHERE key = ?', [key]);
  if (row && ctx.now().getTime() - Date.parse(row.checked_at) < CACHE_MS) return JSON.parse(row.value);
  const res = await lookup(domain);
  if (res.verdict !== 'unknown') {
    ctx.db.run(`INSERT INTO health_dns_cache (key, value, listed_since, checked_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, checked_at = excluded.checked_at`,
    [key, JSON.stringify(res), ctx.now().toISOString()]);
  }
  return res;
}
