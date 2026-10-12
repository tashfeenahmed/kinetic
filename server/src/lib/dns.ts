import { promises as dns } from 'node:dns';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface DnsCheck {
  name: 'MX' | 'SPF' | 'DKIM' | 'DMARC';
  status: CheckStatus;
  value: string | null;
  advice: string;
}

export interface DomainReport {
  domain: string;
  checks: DnsCheck[];
  ok: boolean;
}

export interface Resolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(domain: string): Promise<string[][]>;
}

const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'dkim', 'mail', 'zoho', 'mxvault'];

async function txt(r: Resolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

export async function checkDomain(domain: string, resolver: Resolver = dns): Promise<DomainReport> {
  domain = domain.toLowerCase().trim();
  const checks: DnsCheck[] = [];

  let mx: { exchange: string; priority: number }[] = [];
  try { mx = await resolver.resolveMx(domain); } catch { /* none */ }
  checks.push(mx.length
    ? { name: 'MX', status: 'pass', value: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).join(', '), advice: 'Mail exchangers found.' }
    : { name: 'MX', status: 'fail', value: null, advice: 'Add MX records for your mailbox provider so replies can be received.' });

  const spf = (await txt(resolver, domain)).filter((t) => t.toLowerCase().startsWith('v=spf1'));
  if (spf.length === 1) {
    const v = spf[0]!;
    const strict = /[~-]all\b/.test(v);
    checks.push({ name: 'SPF', status: strict ? 'pass' : 'warn', value: v, advice: strict ? 'SPF record is valid.' : 'End the SPF record with ~all or -all.' });
  } else if (spf.length > 1) {
    checks.push({ name: 'SPF', status: 'fail', value: spf.join(' | '), advice: 'Only one SPF record is allowed. Merge them into one.' });
  } else {
    checks.push({ name: 'SPF', status: 'fail', value: null, advice: 'Add a TXT record like "v=spf1 include:_spf.google.com ~all" (Google) or "v=spf1 include:spf.protection.outlook.com -all" (Microsoft).' });
  }

  let dkim: string | null = null;
  for (const sel of DKIM_SELECTORS) {
    const rec = (await txt(resolver, `${sel}._domainkey.${domain}`)).find((t) => /v=DKIM1|k=rsa|p=/i.test(t));
    if (rec) { dkim = `${sel}: ${rec.slice(0, 60)}${rec.length > 60 ? '…' : ''}`; break; }
  }
  checks.push(dkim
    ? { name: 'DKIM', status: 'pass', value: dkim, advice: 'DKIM key published.' }
    : { name: 'DKIM', status: 'warn', value: null, advice: 'No DKIM key found on common selectors. Enable DKIM signing in your mailbox provider admin console.' });

  const dmarc = (await txt(resolver, `_dmarc.${domain}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  checks.push(dmarc
    ? { name: 'DMARC', status: 'pass', value: dmarc, advice: 'DMARC policy published.' }
    : { name: 'DMARC', status: 'fail', value: null, advice: `Add a TXT record at _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".` });

  return { domain, checks, ok: checks.every((c) => c.status !== 'fail') };
}

export const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';
