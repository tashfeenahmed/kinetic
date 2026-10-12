/**
 * IP → organisation, from free sources: reverse DNS (PTR), RDAP from the regional
 * registries (via rdap.org) and, with a token, IPinfo Lite. ISPs, mobile carriers,
 * VPNs and cloud/hosting networks are filtered out — only company networks count.
 * Results are cached per IP and per RDAP network so each block is looked up once.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { Db } from '../db/db.ts';

export type OrgKind = 'company' | 'isp' | 'mobile' | 'hosting' | 'vpn' | 'private' | 'unknown';

export interface OrgInfo {
  kind: OrgKind;
  orgName: string | null;
  domain: string | null;
  source: string;
  detail?: Record<string, unknown>;
}

export interface IntelDeps {
  db: Db;
  fetch: typeof fetch;
  now: () => Date;
  ipinfoToken?: string;
  reverse?: (ip: string) => Promise<string[]>;
}

const IP_TTL_DAYS = 30;
const NETWORK_TTL_DAYS = 90;

// ---------- keyword lists ----------
// Matched as whole words against a normalised org name / AS name / domain.
const KEYWORDS: Record<Exclude<OrgKind, 'company' | 'private' | 'unknown'>, string[]> = {
  isp: [
    'vodafone', 'eir', 'eircom', 'virgin media', 'virginmedia', 'virginm', 'comcast', 'xfinity', 'verizon', 'at&t', 'att', 'sbcglobal', 'charter', 'spectrum',
    'cox communications', 'centurylink', 'lumen', 'frontier', 'windstream', 'mediacom', 'suddenlink', 'altice', 'optimum', 'cablevision', 'rcn',
    'british telecommunications', 'bt', 'btcentralplus', 'sky', 'talktalk', 'plusnet', 'zen internet', 'hyperoptic', 'community fibre',
    'orange', 'wanadoo', 'free sas', 'proxad', 'sfr', 'bouygues', 'iliad', 'deutsche telekom', 'telekom', 't-ipconnect', 'telefonica', 'movistar',
    'swisscom', 'proximus', 'kpn', 'ziggo', 'telenet', 'telia', 'telenor', 'tele2', 'elisa', 'fastweb', 'telecom italia', 'tim', 'wind tre', 'liberty global',
    'upc', 'chello', 'magenta', 'a1 telekom', 'digi', 'jazztel', 'pure telecom', 'imagine', 'siro', 'virgin', 'telus', 'shaw', 'rogers', 'bell canada', 'videotron', 'cogeco',
    'telstra', 'optus', 'tpg', 'iinet', 'spark new zealand', 'chinanet', 'china telecom', 'china unicom', 'kddi', 'ntt', 'softbank', 'korea telecom', 'sk broadband',
    'jio', 'reliance jio', 'airtel', 'bharti', 'bsnl', 'pldt', 'singtel', 'starhub', 'telkom', 'safaricom', 'claro', 'telmex', 'net servicos',
    'broadband', 'telecom', 'telecommunications', 'telecommunication', 'cable', 'internet service provider', 'isp', 'dsl', 'residential', 'starlink', 'spacex', 'starlinkisp',
  ],
  mobile: ['t-mobile', 'tmobile', 'sprint', 'ee limited', 'three', 'hutchison', 'o2', 'china mobile', 'ntt docomo', 'mtn', 'vivo', 'cellular', 'wireless', 'mobile', 'myvzw', 'lte', 'gprs'],
  hosting: [
    'amazon', 'aws', 'amazonaws', 'amazon technologies', 'google cloud', 'googleusercontent', 'google-cloud', 'microsoft azure', 'azure', 'digitalocean', 'ovh', 'ovhcloud',
    'hetzner', 'cloudflare', 'linode', 'akamai', 'vultr', 'choopa', 'contabo', 'scaleway', 'online s a s', 'leaseweb', 'hostinger', 'godaddy', 'bluehost', 'rackspace',
    'ionos', '1&1', 'oracle cloud', 'alibaba', 'aliyun', 'tencent cloud', 'fastly', 'm247', 'datacamp', 'cdn77', 'colocrossing', 'hostwinds', 'kamatera', 'upcloud',
    'netcup', 'ikoula', 'psychz', 'quadranet', 'zenlayer', 'hosting', 'datacenter', 'data center', 'vps', 'colocation', 'server', 'servers', 'cdn',
  ],
  vpn: ['vpn', 'nordvpn', 'expressvpn', 'mullvad', 'private internet access', 'protonvpn', 'proton ag', 'surfshark', 'cyberghost', 'ipvanish', 'windscribe', 'tunnelbear', 'purevpn', 'tor exit', 'torservers', 'icloud private relay'],
};

// Registries and generic mail domains that show up in RDAP abuse contacts but are not the org.
const NOT_ORG_DOMAINS = new Set([
  'arin.net', 'ripe.net', 'apnic.net', 'lacnic.net', 'afrinic.net', 'jpnic.ad.jp', 'nic.ad.jp', 'krnic.or.kr', 'twnic.net.tw', 'cnnic.cn', 'registro.br',
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.ru', 'qq.com', '163.com',
]);

// Second-level labels used under country codes (acme.co.uk → acme.co.uk, not co.uk).
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'ltd', 'plc', 'gv', 'nhs', 'sch', 'mil']);

const DYNAMIC_PTR = /(^|[.-])(dsl|adsl|vdsl|xdsl|dyn|dynamic|pool|dhcp|cable|broadband|ppp|pppoe|ftth|fttx|fttp|cust|customer|res|residential|client|user|subscriber|cpe|wifi|mobile|lte|3g|4g|5g)[.\d-]/i;

function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Classifies an organisation by name / AS name / domain. Anything not on a list is a company. */
export function classifyOrg(...parts: (string | null | undefined)[]): OrgKind {
  const text = normalise(parts.filter(Boolean).join(' '));
  if (!text.trim()) return 'unknown';
  // VPN and hosting first: "Amazon Technologies" is hosting, not an ISP.
  for (const kind of ['vpn', 'hosting', 'mobile', 'isp'] as const) {
    for (const kw of KEYWORDS[kind]) if (text.includes(normalise(kw))) return kind;
  }
  return 'company';
}

/** acme.com from host-1-2-3-4.eu.acme.com; acme.co.uk from x.acme.co.uk. */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1]!;
  const sld = labels[labels.length - 2]!;
  if (/^\d+$/.test(tld)) return null;
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

export interface PtrResult { host: string; domain: string; dynamic: boolean }

/** Picks the most useful PTR hostname and its registrable domain. */
export function parsePtr(hostnames: string[], ip?: string): PtrResult | null {
  for (const raw of hostnames) {
    const host = raw.toLowerCase().replace(/\.$/, '');
    const domain = registrableDomain(host);
    if (!domain || domain.endsWith('.arpa')) continue;
    const ipDigits = ip && isIP(ip) === 4 ? ip.split('.') : [];
    const embedsIp = ipDigits.length === 4 && (host.includes(ipDigits.join('-')) || host.includes(ipDigits.join('.')) || host.includes([...ipDigits].reverse().join('-')) || host.includes([...ipDigits].reverse().join('.')));
    return { host, domain, dynamic: embedsIp || DYNAMIC_PTR.test(host) };
  }
  return null;
}

export interface RdapResult {
  cidr: string | null;
  start: string | null;
  end: string | null;
  networkName: string | null;
  orgName: string | null;
  emailDomains: string[];
  country: string | null;
}

/** Extracts the network range, organisation and contact domains from an RDAP IP response. */
export function parseRdap(json: any): RdapResult {
  const entities: { roles: string[]; fn?: string; kind?: string; emails: string[] }[] = [];
  const walk = (list: any[] | undefined) => {
    for (const e of list ?? []) {
      const card: any[] = Array.isArray(e?.vcardArray?.[1]) ? e.vcardArray[1] : [];
      const prop = (name: string) => card.filter((p) => p?.[0] === name).map((p) => String(p[3] ?? '')).filter(Boolean);
      entities.push({ roles: (e.roles ?? []).map((r: string) => String(r).toLowerCase()), fn: prop('fn')[0], kind: prop('kind')[0]?.toLowerCase(), emails: prop('email') });
      walk(e.entities);
    }
  };
  walk(json?.entities);

  const isOrg = (e: (typeof entities)[number]) => e.kind === 'org' || !e.kind;
  const registrant = entities.find((e) => e.roles.includes('registrant') && e.fn && isOrg(e))
    ?? entities.find((e) => e.fn && e.kind === 'org' && !e.roles.every((r) => r === 'abuse' || r === 'technical' || r === 'noc'));
  const remarks = (json?.remarks ?? []).flatMap((r: any) => r?.description ?? []).map(String);
  const orgName = registrant?.fn ?? remarks.find((d: string) => d.length > 2 && !/^(please|this|for |abuse|see )/i.test(d)) ?? null;

  const emailDomains: string[] = [];
  // Registrant/admin contacts first, abuse contacts last.
  const ordered = [...entities].sort((a, b) => Number(a.roles.includes('abuse')) - Number(b.roles.includes('abuse')));
  for (const e of ordered) for (const em of e.emails) {
    const d = registrableDomain(em.split('@')[1] ?? '');
    if (d && !NOT_ORG_DOMAINS.has(d) && !emailDomains.includes(d)) emailDomains.push(d);
  }

  const c0 = json?.cidr0_cidrs?.[0];
  const cidr = c0 ? `${c0.v4prefix ?? c0.v6prefix}/${c0.length}` : null;
  return {
    cidr,
    start: json?.startAddress ?? null,
    end: json?.endAddress ?? null,
    networkName: json?.name ?? null,
    orgName: orgName ? String(orgName).trim() : null,
    emailDomains,
    country: json?.country ?? null,
  };
}

// ---------- address helpers ----------
export function normaliseIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

export function isPrivateIp(ip: string): boolean {
  ip = normaliseIp(ip);
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

/** Fixed-width hex for range comparisons (8 chars for IPv4, 32 for IPv6). */
export function ipHex(ip: string): { family: 4 | 6; hex: string } | null {
  ip = normaliseIp(ip);
  const v = isIP(ip);
  if (v === 4) return { family: 4, hex: ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0')).join('') };
  if (v !== 6) return null;
  let [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
  const toGroups = (s: string) => {
    if (!s) return [] as string[];
    const parts = s.split(':');
    const last = parts[parts.length - 1]!;
    if (last.includes('.')) { // embedded IPv4
      const h = ipHex(last)!.hex;
      parts.splice(parts.length - 1, 1, h.slice(0, 4), h.slice(4));
    }
    return parts;
  };
  const a = toGroups(head);
  const b = tail === undefined ? [] : toGroups(tail);
  const fill = tail === undefined ? [] : Array(8 - a.length - b.length).fill('0');
  return { family: 6, hex: [...a, ...fill, ...b].map((g) => g.padStart(4, '0')).join('') };
}

/** Range of a CIDR as fixed-width hex. */
export function cidrRange(cidr: string): { family: 4 | 6; start: string; end: string } | null {
  const [addr, lenStr] = cidr.split('/');
  const h = addr ? ipHex(addr) : null;
  if (!h) return null;
  const bits = h.family === 4 ? 32 : 128;
  const len = lenStr === undefined ? bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > bits) return null;
  const n = BigInt(`0x${h.hex}`);
  const host = (1n << BigInt(bits - len)) - 1n;
  const width = h.hex.length;
  return { family: h.family, start: (n & ~host & ((1n << BigInt(bits)) - 1n)).toString(16).padStart(width, '0'), end: (n | host).toString(16).padStart(width, '0') };
}

// ---------- resolution ----------
const defaultReverse = async (ip: string) => {
  const t = new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('PTR timeout')), 4000).unref());
  return Promise.race([dns.reverse(ip), t]);
};

async function fetchJson(deps: IntelDeps, url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'kinetic-visitors/0.1', ...headers }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface NetworkInfo { orgName: string | null; domain: string | null; kind: OrgKind; source: string }

/** RDAP for the network containing `ip`, cached per network range. */
async function networkFor(deps: IntelDeps, ip: string): Promise<(NetworkInfo & { cidr?: string }) | null> {
  const h = ipHex(ip);
  if (!h) return null;
  const fresh = new Date(deps.now().getTime() - NETWORK_TTL_DAYS * 86_400_000).toISOString();
  // The narrowest cached range containing the IP wins.
  const cached = deps.db.all(`SELECT * FROM visitor_networks WHERE family = ? AND start_hex <= ? AND end_hex >= ? AND resolved_at > ?`, [h.family, h.hex, h.hex, fresh]);
  if (cached.length) {
    const size = (r: any) => BigInt(`0x${r.end_hex}`) - BigInt(`0x${r.start_hex}`);
    const best = cached.sort((a, b) => (size(a) < size(b) ? -1 : size(a) > size(b) ? 1 : 0))[0];
    return { orgName: best.org_name, domain: best.domain, kind: best.kind, source: `${best.source} (cached)`, cidr: best.cidr };
  }
  const json = await fetchJson(deps, `https://rdap.org/ip/${encodeURIComponent(ip)}`, { accept: 'application/rdap+json, application/json' });
  if (!json) return null;
  const r = parseRdap(json);
  const kind = classifyOrg(r.orgName, r.networkName);
  const domain = kind === 'company' ? r.emailDomains.find((d) => classifyOrg(d.replace(/\./g, ' ')) === 'company') ?? null : null;
  let range = r.cidr ? cidrRange(r.cidr) : null;
  if (!range && r.start && r.end) {
    const s = ipHex(r.start), e = ipHex(r.end);
    if (s && e && s.family === e.family) range = { family: s.family, start: s.hex, end: e.hex };
  }
  const cidr = r.cidr ?? (r.start && r.end ? `${r.start}-${r.end}` : null);
  if (range && cidr) {
    deps.db.run(`INSERT INTO visitor_networks (cidr, family, start_hex, end_hex, org_name, domain, kind, source, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'rdap', ?)
      ON CONFLICT(cidr) DO UPDATE SET org_name = excluded.org_name, domain = excluded.domain, kind = excluded.kind, resolved_at = excluded.resolved_at`,
    [cidr, range.family, range.start, range.end, r.orgName, domain, kind, deps.now().toISOString()]);
  }
  return { orgName: r.orgName, domain, kind, source: 'rdap', cidr: cidr ?? undefined };
}

async function ipinfo(deps: IntelDeps, ip: string): Promise<NetworkInfo | null> {
  if (!deps.ipinfoToken) return null;
  const d = await fetchJson(deps, `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(deps.ipinfoToken)}`);
  if (!d || (!d.as_name && !d.as_domain)) return null;
  const kind = classifyOrg(d.as_name, d.as_domain);
  return { orgName: d.as_name ?? null, domain: kind === 'company' ? (d.as_domain ? registrableDomain(d.as_domain) : null) : null, kind, source: 'ipinfo' };
}

/** Combines PTR, IPinfo and RDAP into one verdict (pure; exported for tests). */
export function decide(ptr: PtrResult | null, info: NetworkInfo | null, net: NetworkInfo | null): OrgInfo {
  const ptrKind = ptr ? classifyOrg(ptr.domain.replace(/\./g, ' ')) : null;
  // A provider hostname or provider network settles it.
  if (ptrKind && ptrKind !== 'company') return { kind: ptrKind, orgName: net?.orgName ?? info?.orgName ?? null, domain: null, source: 'ptr' };
  const netKind = info?.kind ?? net?.kind ?? null;
  if (netKind && netKind !== 'company' && netKind !== 'unknown') {
    // A dynamic-looking PTR on a provider network is a home/mobile line, whatever its domain.
    if (!ptr || ptr.dynamic) return { kind: netKind, orgName: info?.orgName ?? net?.orgName ?? null, domain: null, source: info ? 'ipinfo' : 'rdap' };
    // Static PTR on the company's own domain (business line from an ISP): trust the PTR.
    return { kind: 'company', orgName: null, domain: ptr.domain, source: 'ptr' };
  }
  if (ptr) return { kind: 'company', orgName: info?.orgName ?? net?.orgName ?? null, domain: ptr.domain, source: 'ptr' };
  const best = info?.kind === 'company' ? info : net?.kind === 'company' ? net : null;
  if (best) return { kind: 'company', orgName: best.orgName, domain: best.domain, source: best.source };
  return { kind: 'unknown', orgName: net?.orgName ?? info?.orgName ?? null, domain: null, source: 'none' };
}

/** Resolves an IP to an organisation, using and filling the caches. */
export async function resolveIp(deps: IntelDeps, rawIp: string): Promise<OrgInfo> {
  const ip = normaliseIp(rawIp.trim());
  if (!isIP(ip) || isPrivateIp(ip)) return { kind: 'private', orgName: null, domain: null, source: 'local' };
  const fresh = new Date(deps.now().getTime() - IP_TTL_DAYS * 86_400_000).toISOString();
  const hit = deps.db.get('SELECT * FROM visitor_ip_cache WHERE ip = ? AND resolved_at > ?', [ip, fresh]);
  if (hit) return { kind: hit.kind, orgName: hit.org_name, domain: hit.domain, source: hit.source, detail: JSON.parse(hit.detail) };

  const reverse = deps.reverse ?? defaultReverse;
  const [names, info, net] = await Promise.all([
    reverse(ip).catch(() => [] as string[]),
    ipinfo(deps, ip),
    networkFor(deps, ip),
  ]);
  const ptr = parsePtr(names, ip);
  const out = decide(ptr, info, net);
  out.detail = { ptr: ptr?.host ?? null, network: net?.orgName ?? null, cidr: net?.cidr ?? null, asn: info?.orgName ?? null };
  deps.db.run(`INSERT INTO visitor_ip_cache (ip, org_name, domain, kind, source, detail, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET org_name = excluded.org_name, domain = excluded.domain, kind = excluded.kind, source = excluded.source, detail = excluded.detail, resolved_at = excluded.resolved_at`,
  [ip, out.orgName, out.domain, out.kind, out.source, JSON.stringify(out.detail), deps.now().toISOString()]);
  return out;
}
