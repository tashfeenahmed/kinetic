/**
 * Free mailbox verification over SMTP (the approach used by Reacher /
 * AfterShip email-verifier): connect to the domain's MX on port 25, say
 * EHLO, MAIL FROM:<>, then RCPT TO the address and a random address on the
 * same domain to detect catch-all servers. Nothing is ever sent (we QUIT
 * before DATA).
 *
 * Identity: SMTP_HELO may list several hostnames (burner domains, never the
 * sending domain). Each probe takes the next one round-robin, but a receiving
 * mail system (MX domain) keeps the same name for a day: greylisting keys on
 * the identity, and some receivers (Fastmail) answer "451 Helo command
 * rejected ... use consistent HELO" when one IP changes names.
 *
 * Network: IPv6 is tried first when the MX has it. Home/residential IPv4
 * addresses sit on Spamhaus PBL, which Microsoft 365, iCloud and Yahoo refuse,
 * while their IPv6 edges usually still answer. A blocklist rejection on one
 * family is retried once on the other.
 *
 * Works well for Google Workspace and most self-hosted/corporate servers.
 * Some Microsoft 365 tenants, Proofpoint and Mimecast accept every RCPT, so
 * those come back "catch_all". Requires outbound port 25.
 */
import net from 'node:net';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { mxProvider } from '../providers/free.ts';

export type SmtpVerdict = 'valid' | 'invalid' | 'catch_all' | 'unknown';

/** Why we reached the verdict, so a table can say "blocked" rather than just "unknown". */
export type SmtpReason =
  | 'accepted' | 'catch_all' | 'mailbox_not_found' | 'mailbox_full' | 'mailbox_disabled'
  | 'bad_syntax' | 'no_mx' | 'blocked' | 'greylisted' | 'temporary_error' | 'rejected'
  | 'unverifiable_provider' | 'connect_failed' | 'timeout';

export interface SmtpResult {
  verdict: SmtpVerdict;
  reason: SmtpReason;
  mx?: string;
  mailProvider?: string;
  code?: number;
  reply?: string;
  catchAll?: boolean;
  helo?: string;
  /** Address family actually used for the answer. */
  family?: 4 | 6;
}

export interface SmtpOptions {
  /** One hostname or a comma/space separated list to rotate through. */
  helo?: string;
  /** MAIL FROM address; `{helo_domain}` is replaced with the HELO name in use. Empty = null sender `<>`. */
  from?: string;
  timeoutMs?: number;
  /** Wait before the single retry after a 4xx on RCPT (greylisting). 0 disables the retry. */
  greylistRetryMs?: number;
  /** 'auto' = IPv6 first, then IPv4. */
  family?: 'auto' | 4 | 6;
  /** Test hooks. */
  port?: number;
  mxLookup?: (domain: string) => Promise<{ provider: string; mx: string[] } | null>;
}

/** Settings → options, for the enrichment steps. */
export function smtpOptions(settings: { get(key: any): string | undefined }): SmtpOptions {
  return { helo: settings.get('SMTP_HELO'), from: settings.get('SMTP_MAIL_FROM') };
}

const DEFAULT_HELO = 'mail.kineticsand.local';
const STICKY_MS = 24 * 3_600_000;
const MAX_PER_MX = 2;
const GAP_MS = 400;

const catchAllCache = new Map<string, { at: number; catchAll: boolean }>();
const sticky = new Map<string, { helo: string; at: number }>();
let rr = 0;

/** Round-robin over the configured names, sticky per receiving mail system for STICKY_MS. */
export function pickHelo(list: string | undefined, mxHost: string): string {
  const names = (list ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return DEFAULT_HELO;
  const key = mxKey(mxHost);
  const prev = sticky.get(key);
  if (prev && names.includes(prev.helo) && Date.now() - prev.at < STICKY_MS) {
    prev.at = Date.now();
    return prev.helo;
  }
  const helo = names[rr++ % names.length];
  sticky.set(key, { helo, at: Date.now() });
  return helo;
}

/* ---------------------------------------------------- per-MX rate limiting */

interface Slot { active: number; last: number; waiters: (() => void)[] }
const slots = new Map<string, Slot>();

/** Gmail, M365 etc. use many MX hostnames under one domain; throttle on that domain. */
function mxKey(host: string) {
  return host.split('.').slice(-2).join('.');
}

async function limited<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const key = mxKey(host);
  const slot = slots.get(key) ?? { active: 0, last: 0, waiters: [] };
  slots.set(key, slot);
  while (slot.active >= MAX_PER_MX) await new Promise<void>((r) => slot.waiters.push(r));
  slot.active++;
  const wait = slot.last + GAP_MS - Date.now();
  slot.last = Math.max(Date.now(), slot.last + GAP_MS);
  if (wait > 0) await sleep(wait);
  try {
    return await fn();
  } finally {
    slot.active--;
    slot.waiters.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reset caches and counters (tests). */
export function _resetSmtpState() {
  catchAllCache.clear(); sticky.clear(); slots.clear(); rr = 0;
}

/* ------------------------------------------------------------- classifier */

const BLOCKED = /helo command rejected|spamhaus|\bpbl\b|\bzen\b|blocklist|blacklist|block ?list|blocked using|client host .*(rejected|blocked)|\brbl\b|dnsbl|reputation|permanently deferred|\[TSS\d+\]|poor reputation|listed (at|in|on|by)|not allowed to send|banned/i;
const NOT_FOUND = /user unknown|unknown user|no such (user|mailbox|recipient|address)|does ?n[o']t exist|not exist|invalid (recipient|mailbox)|mailbox (unavailable|not found|does not)|unrouteable|no mailbox|not found|5\.1\.[01]\b/i;
const POLICY = /5\.7\.\d|policy|spam|authenticat|relay|denied|not permitted/i;

/** Classify a permanent (5xx) RCPT reply. */
export function classifyRejection(code: number, text: string): { verdict: SmtpVerdict; reason: SmtpReason } {
  if (/full|quota|over.?limit|insufficient storage/i.test(text) || code === 552) return { verdict: 'invalid', reason: 'mailbox_full' };
  if (/disabled|inactive|suspended|deactivated/i.test(text)) return { verdict: 'invalid', reason: 'mailbox_disabled' };
  // Microsoft's directory-based edge blocking answers unknown users with "5.4.1 Recipient address rejected: Access denied".
  if (/5\.4\.1/.test(text)) return { verdict: 'invalid', reason: 'mailbox_not_found' };
  if (BLOCKED.test(text)) return { verdict: 'unknown', reason: 'blocked' };
  if (NOT_FOUND.test(text)) return { verdict: 'invalid', reason: 'mailbox_not_found' };
  if (POLICY.test(text)) return { verdict: 'unknown', reason: 'rejected' };
  return { verdict: 'invalid', reason: 'mailbox_not_found' };
}

/* ------------------------------------------------------------------ verify */

export async function smtpVerify(email: string, opts: SmtpOptions = {}): Promise<SmtpResult> {
  const addr = email.trim().toLowerCase();
  const domain = addr.split('@')[1];
  if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { verdict: 'invalid', reason: 'bad_syntax', reply: 'bad syntax' };
  const mx = await (opts.mxLookup ?? mxProvider)(domain);
  if (!mx) return { verdict: 'invalid', reason: 'no_mx', reply: 'no MX records' };
  const host = mx.mx[0];
  // Yahoo/AOL and consumer Outlook/Hotmail accept every RCPT, so SMTP can't tell (Reacher needs a headless browser for these).
  if (/yahoodns\.net|aol\.com$/.test(host) || /^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) {
    return { verdict: 'unknown', reason: 'unverifiable_provider', mx: host, mailProvider: mx.provider, reply: 'provider accepts all recipients over SMTP; cannot verify for free' };
  }
  const helo = pickHelo(opts.helo, host);
  const from = (opts.from ?? '').replaceAll('{helo_domain}', helo).trim();
  const cached = catchAllCache.get(domain);
  const knownCatchAll = cached && Date.now() - cached.at < 86_400_000 ? cached.catchAll : undefined;
  const rcpts = knownCatchAll === undefined ? [addr, `${randomBytes(6).toString('hex')}-nouser@${domain}`] : [addr];
  const base = { mx: host, mailProvider: mx.provider, helo };

  const addrs = await addresses(host, opts.family ?? 'auto');
  if (!addrs.length) return { ...base, verdict: 'unknown', reason: 'connect_failed', reply: `cannot resolve ${host}` };

  // Try each address family; move on after a connection failure or a blocklist rejection.
  let probe: Probe | undefined;
  const tried = new Set<number>();
  for (const a of addrs) {
    if (tried.has(a.family)) continue;
    tried.add(a.family);
    probe = await limited(host, () => session(a.address, opts, helo, from, rcpts));
    probe.family = a.family as 4 | 6;
    const retryGreylist = (opts.greylistRetryMs ?? 30_000) > 0 && probe.replies[0] && probe.replies[0].code >= 400 && probe.replies[0].code < 500;
    if (retryGreylist && !isBlocked(probe)) {
      await sleep(opts.greylistRetryMs ?? 30_000);
      const again = await limited(host, () => session(a.address, opts, helo, from, rcpts));
      probe = { ...again, family: a.family as 4 | 6, retried: true };
    }
    if (!probe.error?.startsWith('connect') && !isBlocked(probe)) break;
  }
  return interpret(probe!, domain, base);
}

interface Reply { code: number; text: string }
interface Probe { replies: Reply[]; error?: string; stage?: string; errorCode?: number; family?: 4 | 6; retried?: boolean }

/** Refused because of who we are (IP/HELO/sender), not because of the mailbox. */
function isBlocked(p: Probe) {
  if (p.errorCode) return true; // refused before RCPT
  const r = p.replies[0];
  if (!r || r.code < 400) return false;
  return r.code < 500 ? BLOCKED.test(r.text) : classifyRejection(r.code, r.text).reason === 'blocked';
}

function interpret(probe: Probe, domain: string, base: { mx: string; mailProvider: string; helo: string }): SmtpResult {
  const [target, random] = probe.replies;
  const out = { ...base, family: probe.family };
  if (!target) {
    const err = probe.error ?? 'no reply';
    if (probe.errorCode) {
      // Refused before RCPT (greeting/EHLO/MAIL FROM): almost always the connecting IP or sender.
      return { ...out, verdict: 'unknown', reason: probe.errorCode < 500 && !BLOCKED.test(err) ? 'temporary_error' : 'blocked', code: probe.errorCode, reply: err.slice(0, 200) };
    }
    return { ...out, verdict: 'unknown', reason: /timeout/.test(err) ? 'timeout' : 'connect_failed', reply: err.slice(0, 200) };
  }
  if (random && (random.code < 400 || random.code >= 500)) catchAllCache.set(domain, { at: Date.now(), catchAll: random.code >= 200 && random.code < 300 });
  const catchAll = catchAllCache.get(domain)?.catchAll ?? false;
  const res = { ...out, code: target.code, reply: target.text.slice(0, 200), catchAll };

  if (target.code >= 200 && target.code < 300) return catchAll ? { ...res, verdict: 'catch_all', reason: 'catch_all' } : { ...res, verdict: 'valid', reason: 'accepted' };
  if (target.code >= 400 && target.code < 500) {
    const blocked = BLOCKED.test(target.text);
    return { ...res, verdict: 'unknown', reason: blocked ? 'blocked' : 'greylisted', reply: `${blocked ? '' : probe.retried ? 'greylisted (4xx, retried once): ' : 'temporary failure (4xx): '}${res.reply}` };
  }
  const c = classifyRejection(target.code, target.text);
  const prefix = c.reason === 'mailbox_full' ? 'mailbox full: ' : c.reason === 'mailbox_disabled' ? 'mailbox disabled: ' : c.reason === 'blocked' ? 'blocked (our IP/identity, not the mailbox): ' : '';
  return { ...res, ...c, reply: prefix + res.reply };
}

async function addresses(host: string, family: 'auto' | 4 | 6): Promise<{ address: string; family: number }[]> {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  const all = await dns.lookup(host, { all: true }).catch(() => []);
  const v6 = all.filter((a) => a.family === 6), v4 = all.filter((a) => a.family === 4);
  return family === 4 ? v4 : family === 6 ? v6 : [...v6, ...v4];
}

function session(address: string, opts: SmtpOptions, helo: string, from: string, rcpts: string[]): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port: opts.port ?? 25 });
    const timeout = opts.timeoutMs ?? 15_000;
    socket.setTimeout(timeout);
    let buf = '';
    let step = 0;
    let connected = false;
    let finished = false;
    const replies: Reply[] = [];
    const steps = [
      () => `EHLO ${helo}`,
      () => `MAIL FROM:<${from}>`,
      ...rcpts.map((r) => () => `RCPT TO:<${r}>`),
    ];
    const done = (error?: string, errorCode?: number, stage?: string) => {
      if (finished) return;
      finished = true;
      try { socket.end('QUIT\r\n'); } catch { /* closed */ }
      setTimeout(() => socket.destroy(), 50).unref();
      resolve({ replies, error, errorCode, stage });
    };
    socket.on('connect', () => { connected = true; });
    socket.on('timeout', () => done(connected ? 'timeout' : 'connect timeout'));
    socket.on('error', (e) => done(connected ? e.message : `connect: ${e.message}`));
    socket.on('close', () => done(connected ? 'connection closed' : 'connect: closed'));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // A complete reply ends with a line "NNN text" (no dash after the code).
      const lines = buf.split('\r\n');
      const last = lines.length >= 2 ? lines[lines.length - 2] : '';
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      const text = lines.filter(Boolean).map((l) => l.slice(4)).join(' ');
      buf = '';
      // step 0 = greeting, 1 = EHLO, 2 = MAIL FROM, 3.. = RCPTs
      if (step >= 3) replies.push({ code, text });
      if (step === 0 && code !== 220) return done(`greeting ${code} ${text}`, code, 'greeting');
      if ((step === 1 || step === 2) && code >= 400) return done(`${step === 1 ? 'EHLO' : 'MAIL FROM'} ${code} ${text}`, code, step === 1 ? 'ehlo' : 'mail');
      // Stop after a temporary failure on the target: the random address would only muddy greylisting.
      if (step === 3 && code >= 400 && code < 500) return done(undefined, undefined, 'rcpt');
      if (step >= steps.length) return done();
      socket.write(`${steps[step]()}\r\n`);
      step++;
    });
  });
}
