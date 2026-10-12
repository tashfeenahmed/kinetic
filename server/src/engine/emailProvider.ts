/**
 * Recipient mailbox provider (Google / Microsoft / other) from the lead domain's MX records.
 * Lookups are async, so the sequencer reads a cache; this module fills it in the background.
 */
import { promises as dns } from 'node:dns';
import type { Ctx } from '../context.ts';
import { domainOf } from '../lib/dns.ts';

export type EmailProvider = 'google' | 'microsoft' | 'other';

const KNOWN: Record<string, EmailProvider> = {
  'gmail.com': 'google', 'googlemail.com': 'google',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft',
};

/** Re-check cached answers after this long. */
const TTL_MS = 30 * 86_400_000;

export interface MxResolver { resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]> }

export function providerFromMx(exchanges: string[]): EmailProvider {
  const mx = exchanges.join(' ').toLowerCase();
  if (/(google\.com|googlemail\.com|aspmx\.)/.test(mx)) return 'google';
  if (/(outlook\.com|microsoft\.com|hotmail\.com|office365)/.test(mx)) return 'microsoft';
  return 'other';
}

/** Cached provider for an email/domain, or null when it has not been looked up yet (and queues it). */
export function cachedProvider(ctx: Ctx, emailOrDomain: string): EmailProvider | null {
  const domain = emailOrDomain.includes('@') ? domainOf(emailOrDomain) : emailOrDomain.toLowerCase();
  if (!domain) return 'other';
  if (KNOWN[domain]) return KNOWN[domain]!;
  const row = ctx.db.get<{ provider: EmailProvider | null }>('SELECT provider FROM email_provider_cache WHERE domain = ?', [domain]);
  if (row?.provider) return row.provider;
  if (!row) ctx.db.run('INSERT OR IGNORE INTO email_provider_cache (domain) VALUES (?)', [domain]);
  return null;
}

/** Looks up one domain now and caches the answer. A failed lookup counts as "other". */
export async function lookupProvider(ctx: Ctx, domain: string, resolver: MxResolver = dns): Promise<{ domain: string; provider: EmailProvider; mx: string }> {
  domain = domain.toLowerCase();
  let provider: EmailProvider = KNOWN[domain] ?? 'other';
  let mx = '';
  if (!KNOWN[domain]) {
    try {
      const records = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
      mx = records.map((r) => r.exchange).join(', ');
      provider = providerFromMx(records.map((r) => r.exchange));
    } catch { /* no MX: other */ }
  }
  ctx.db.run(`INSERT INTO email_provider_cache (domain, provider, mx, checked_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(domain) DO UPDATE SET provider = excluded.provider, mx = excluded.mx, checked_at = excluded.checked_at`,
  [domain, provider, mx, ctx.now().toISOString()]);
  return { domain, provider, mx };
}

/** Background job: resolves queued and stale domains. */
export async function resolvePendingProviders(ctx: Ctx, resolver: MxResolver = dns, limit = 50): Promise<{ resolved: number }> {
  const stale = new Date(ctx.now().getTime() - TTL_MS).toISOString();
  const due = ctx.db.all<{ domain: string }>(
    'SELECT domain FROM email_provider_cache WHERE provider IS NULL OR checked_at < ? ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?', [stale, limit]);
  for (const d of due) await lookupProvider(ctx, d.domain, resolver);
  return { resolved: due.length };
}
