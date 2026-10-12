/**
 * Works out the DNS records a sending domain needs for its mailbox provider and
 * diffs them against what Cloudflare already has.
 */
import type { CfRecord } from './cloudflare.ts';

export type MailProvider = 'google' | 'microsoft' | 'other';

export interface DomainSetup {
  domain: string;
  provider: MailProvider;
  /** Provider's domain-verification TXT, e.g. "google-site-verification=…" or "MS=ms12345". */
  verification?: string;
  /** Google: DKIM TXT value ("v=DKIM1; k=rsa; p=…"); other: DKIM TXT value for dkimSelector. */
  dkimValue?: string;
  dkimSelector?: string;
  /** Microsoft: CNAME targets for selector1/selector2 shown in the Defender portal. */
  msDkim1?: string;
  msDkim2?: string;
  /** Other provider: MX hosts ("10 mx1.example.com") and SPF include. */
  otherMx?: string[];
  otherSpfInclude?: string;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  dmarcReportEmail?: string;
  /** CNAME this subdomain to the app for open/click tracking (e.g. "track"). */
  trackingSubdomain?: string;
  trackingTarget?: string;
  /** Redirect root/www to this URL (needs Cloudflare proxy + a redirect rule). */
  redirectTo?: string;
  /** Remove MX records that aren't the provider's (default true: a sending domain should have one provider). */
  replaceMx?: boolean;
}

export interface Desired {
  key: string;            // stable identity for diffing
  type: 'MX' | 'TXT' | 'CNAME' | 'A';
  name: string;           // FQDN
  content: string;
  priority?: number;
  proxied?: boolean;
  purpose: string;
}

export interface Action {
  op: 'create' | 'update' | 'delete' | 'keep';
  purpose: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  recordId?: string;
  before?: string;
  note?: string;
}

const PROVIDER = {
  google: { spf: '_spf.google.com', all: '~all' },
  microsoft: { spf: 'spf.protection.outlook.com', all: '-all' },
};

const fqdn = (sub: string, domain: string) => (sub === '@' || sub === '' ? domain : `${sub}.${domain}`);

/** Records the domain should have (SPF is handled separately because it merges). */
export function desiredRecords(s: DomainSetup): Desired[] {
  const d = s.domain;
  const out: Desired[] = [];
  if (s.provider === 'google') {
    out.push({ key: 'mx', type: 'MX', name: d, content: 'smtp.google.com', priority: 1, purpose: 'Receive mail (Google)' });
    if (s.dkimValue?.trim()) out.push({ key: 'dkim', type: 'TXT', name: fqdn(`${s.dkimSelector?.trim() || 'google'}._domainkey`, d), content: normaliseDkim(s.dkimValue), purpose: 'DKIM signing key' });
  } else if (s.provider === 'microsoft') {
    out.push({ key: 'mx', type: 'MX', name: d, content: `${d.replace(/\./g, '-')}.mail.protection.outlook.com`, priority: 0, purpose: 'Receive mail (Microsoft 365)' });
    out.push({ key: 'autodiscover', type: 'CNAME', name: fqdn('autodiscover', d), content: 'autodiscover.outlook.com', purpose: 'Outlook autodiscover' });
    if (s.msDkim1?.trim()) out.push({ key: 'dkim1', type: 'CNAME', name: fqdn('selector1._domainkey', d), content: s.msDkim1.trim().replace(/\.$/, ''), purpose: 'DKIM selector 1' });
    if (s.msDkim2?.trim()) out.push({ key: 'dkim2', type: 'CNAME', name: fqdn('selector2._domainkey', d), content: s.msDkim2.trim().replace(/\.$/, ''), purpose: 'DKIM selector 2' });
  } else {
    (s.otherMx ?? []).forEach((line, i) => {
      const m = line.trim().match(/^(\d+)\s+(\S+)$/) ?? [null, '10', line.trim()];
      if (m[2]) out.push({ key: `mx${i}`, type: 'MX', name: d, content: m[2].replace(/\.$/, ''), priority: Number(m[1]), purpose: 'Receive mail' });
    });
    if (s.dkimValue?.trim()) out.push({ key: 'dkim', type: 'TXT', name: fqdn(`${s.dkimSelector?.trim() || 'default'}._domainkey`, d), content: normaliseDkim(s.dkimValue), purpose: 'DKIM signing key' });
  }
  if (s.verification?.trim()) out.push({ key: 'verify', type: 'TXT', name: d, content: s.verification.trim().replace(/^"|"$/g, ''), purpose: 'Provider domain verification' });
  const policy = s.dmarcPolicy ?? 'none';
  out.push({ key: 'dmarc', type: 'TXT', name: fqdn('_dmarc', d), content: `v=DMARC1; p=${policy};${s.dmarcReportEmail?.trim() ? ` rua=mailto:${s.dmarcReportEmail.trim()};` : ''} adkim=r; aspf=r`, purpose: 'DMARC policy' });
  if (s.trackingSubdomain?.trim() && s.trackingTarget) out.push({ key: 'tracking', type: 'CNAME', name: fqdn(s.trackingSubdomain.trim(), d), content: s.trackingTarget, purpose: 'Open/click tracking domain' });
  if (s.redirectTo?.trim()) {
    // Proxied placeholders so Cloudflare can answer the redirect rule (192.0.2.1 is a reserved test address).
    out.push({ key: 'redirect-root', type: 'A', name: d, content: '192.0.2.1', proxied: true, purpose: 'Website redirect (root)' });
    out.push({ key: 'redirect-www', type: 'CNAME', name: fqdn('www', d), content: d, proxied: true, purpose: 'Website redirect (www)' });
  }
  return out;
}

function normaliseDkim(v: string) {
  // People paste the value with quotes or split into chunks; Cloudflare wants one string.
  return v.replace(/"\s*"/g, '').replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
}

/** The one SPF record the domain should have, merging any includes already there. */
export function mergedSpf(existing: string[], s: DomainSetup): string {
  const include = s.provider === 'other' ? s.otherSpfInclude?.trim() : PROVIDER[s.provider].spf;
  const all = s.provider === 'microsoft' ? '-all' : '~all';
  const mechanisms: string[] = [];
  for (const rec of existing) for (const m of rec.split(/\s+/).slice(1)) if (!/^[~?+-]?all$/i.test(m) && m && !mechanisms.includes(m)) mechanisms.push(m);
  if (include) {
    const inc = include.startsWith('include:') ? include : `include:${include}`;
    if (!mechanisms.includes(inc)) mechanisms.unshift(inc);
  }
  return ['v=spf1', ...mechanisms, all].join(' ');
}

const norm = (v: string) => v.replace(/^"|"$/g, '').replace(/\.$/, '').trim().toLowerCase();

/** Diff desired records against the zone. */
export function plan(existing: CfRecord[], s: DomainSetup): Action[] {
  const d = s.domain.toLowerCase();
  const actions: Action[] = [];
  const at = (name: string, type: string) => existing.filter((r) => r.name.toLowerCase() === name.toLowerCase() && r.type === type);
  const want = desiredRecords(s);

  // MX: exact set for the provider.
  const wantMx = want.filter((w) => w.type === 'MX');
  const haveMx = at(d, 'MX');
  for (const w of wantMx) {
    const same = haveMx.find((h) => norm(h.content) === norm(w.content));
    if (same && same.priority === w.priority) actions.push({ op: 'keep', purpose: w.purpose, type: 'MX', name: w.name, content: w.content, priority: w.priority, recordId: same.id });
    else if (same) actions.push({ op: 'update', purpose: w.purpose, type: 'MX', name: w.name, content: w.content, priority: w.priority, recordId: same.id, before: `${same.priority} ${same.content}` });
    else actions.push({ op: 'create', purpose: w.purpose, type: 'MX', name: w.name, content: w.content, priority: w.priority });
  }
  if (wantMx.length && s.replaceMx !== false) {
    for (const h of haveMx) if (!wantMx.some((w) => norm(w.content) === norm(h.content))) {
      actions.push({ op: 'delete', purpose: 'Old mail server', type: 'MX', name: h.name, content: h.content, priority: h.priority, recordId: h.id, note: 'A sending domain should point at one mailbox provider' });
    }
  }

  // SPF: one record, merged.
  const spfRecs = at(d, 'TXT').filter((r) => norm(r.content).startsWith('v=spf1'));
  const spf = mergedSpf(spfRecs.map((r) => r.content.replace(/^"|"$/g, '')), s);
  if (!spfRecs.length) actions.push({ op: 'create', purpose: 'SPF (who may send)', type: 'TXT', name: d, content: spf });
  else {
    const [first, ...dupes] = spfRecs;
    if (norm(first!.content) === norm(spf)) actions.push({ op: 'keep', purpose: 'SPF (who may send)', type: 'TXT', name: d, content: spf, recordId: first!.id });
    else actions.push({ op: 'update', purpose: 'SPF (who may send)', type: 'TXT', name: d, content: spf, recordId: first!.id, before: first!.content, note: 'Existing includes kept' });
    for (const dup of dupes) actions.push({ op: 'delete', purpose: 'Duplicate SPF', type: 'TXT', name: d, content: dup.content, recordId: dup.id, note: 'Only one SPF record is allowed; merged above' });
  }

  // Everything else: one record per name+type, created or updated.
  for (const w of want.filter((x) => x.type !== 'MX')) {
    const same = at(w.name, w.type);
    if (w.key === 'verify') {
      // Verification TXT sits next to other root TXT records: only add if missing.
      const hit = same.find((h) => norm(h.content) === norm(w.content));
      actions.push(hit ? { op: 'keep', purpose: w.purpose, type: w.type, name: w.name, content: w.content, recordId: hit.id } : { op: 'create', purpose: w.purpose, type: w.type, name: w.name, content: w.content });
      continue;
    }
    // A CNAME can't coexist with other types at the same name.
    const conflicts = w.type === 'CNAME' ? existing.filter((r) => r.name.toLowerCase() === w.name.toLowerCase() && r.type !== 'CNAME') : w.type === 'A' ? at(w.name, 'CNAME') : [];
    for (const c of conflicts) actions.push({ op: 'delete', purpose: `Conflicts with ${w.purpose.toLowerCase()}`, type: c.type, name: c.name, content: c.content, recordId: c.id });
    const relevant = w.key === 'dmarc' ? same.filter((h) => norm(h.content).startsWith('v=dmarc1')) : w.key === 'dkim' ? same.filter((h) => /v=dkim1|p=/i.test(h.content)) : same;
    const first = relevant[0];
    if (!first) actions.push({ op: 'create', purpose: w.purpose, type: w.type, name: w.name, content: w.content, proxied: w.proxied });
    else if (norm(first.content) === norm(w.content) && !!first.proxied === !!w.proxied) actions.push({ op: 'keep', purpose: w.purpose, type: w.type, name: w.name, content: w.content, recordId: first.id, proxied: w.proxied });
    else actions.push({ op: 'update', purpose: w.purpose, type: w.type, name: w.name, content: w.content, recordId: first.id, before: first.content, proxied: w.proxied });
    if (w.type === 'A') for (const extra of relevant.slice(1)) actions.push({ op: 'delete', purpose: 'Extra address record', type: 'A', name: extra.name, content: extra.content, recordId: extra.id });
  }
  return actions;
}
