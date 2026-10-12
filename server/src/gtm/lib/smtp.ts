/**
 * Free mailbox verification over SMTP (the approach used by Reacher /
 * AfterShip email-verifier): connect to the domain's MX on port 25, say
 * EHLO, MAIL FROM:<>, then RCPT TO the address and a random address on the
 * same domain to detect catch-all servers. Nothing is ever sent (we QUIT
 * before DATA).
 *
 * Works well for Google Workspace and most self-hosted/corporate servers.
 * Microsoft 365, Proofpoint and Mimecast often accept every RCPT or block
 * probes, so those come back "unknown"/"catch_all". Requires outbound port 25
 * (many ISPs and clouds block it).
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mxProvider } from '../providers/free.ts';

export type SmtpVerdict = 'valid' | 'invalid' | 'catch_all' | 'unknown';

export interface SmtpResult {
  verdict: SmtpVerdict;
  mx?: string;
  mailProvider?: string;
  code?: number;
  reply?: string;
  catchAll?: boolean;
}

const catchAllCache = new Map<string, { at: number; catchAll: boolean }>();
const perHost = new Map<string, Promise<unknown>>();

/** Serialise probes per MX host — servers throttle parallel connections from one IP. */
function queued<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = perHost.get(host) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  perHost.set(host, next.then(() => new Promise((r) => setTimeout(r, 400)), () => undefined));
  return next;
}

export async function smtpVerify(email: string, opts: { helo?: string; from?: string; timeoutMs?: number } = {}): Promise<SmtpResult> {
  const addr = email.trim().toLowerCase();
  const domain = addr.split('@')[1];
  if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { verdict: 'invalid', reply: 'bad syntax' };
  const mx = await mxProvider(domain);
  if (!mx) return { verdict: 'invalid', reply: 'no MX records' };
  const host = mx.mx[0];
  // Yahoo/AOL and consumer Outlook/Hotmail accept every RCPT, so SMTP can't tell (Reacher needs a headless browser for these).
  if (/yahoodns\.net|aol\.com$/.test(host) || /^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) {
    return { verdict: 'unknown', mx: host, mailProvider: mx.provider, reply: 'provider accepts all recipients over SMTP; cannot verify for free' };
  }
  const cached = catchAllCache.get(domain);
  const knownCatchAll = cached && Date.now() - cached.at < 86_400_000 ? cached.catchAll : undefined;

  const probe = await queued(host, () => session(host, opts, knownCatchAll === undefined ? [addr, `${randomBytes(6).toString('hex')}-nouser@${domain}`] : [addr]));
  const [target, random] = probe.replies;
  if (random) catchAllCache.set(domain, { at: Date.now(), catchAll: random.code >= 200 && random.code < 300 });
  const catchAll = catchAllCache.get(domain)?.catchAll ?? false;
  const base = { mx: host, mailProvider: mx.provider, code: target?.code, reply: target?.text?.slice(0, 200), catchAll };

  if (probe.error || !target) return { ...base, verdict: 'unknown', reply: probe.error ?? 'no reply' };
  if (target.code >= 200 && target.code < 300) return { ...base, verdict: catchAll ? 'catch_all' : 'valid' };
  // 550/551/553 + "user unknown"-style text = mailbox does not exist. Policy blocks (spam, blocked IP) are unknown.
  if (target.code >= 500 && !/block|spam|policy|reputation|blacklist|denied|not allowed|authenticat|relay|spamhaus|rbl/i.test(target.text)) {
    return { ...base, verdict: 'invalid', reply: /full|quota|over.?limit/i.test(target.text) ? `mailbox full: ${base.reply}` : /disabled|inactive|suspended/i.test(target.text) ? `mailbox disabled: ${base.reply}` : base.reply };
  }
  return { ...base, verdict: 'unknown' }; // 4xx greylisting / blocks
}

interface Reply { code: number; text: string }

function session(host: string, opts: { helo?: string; from?: string; timeoutMs?: number }, rcpts: string[]): Promise<{ replies: Reply[]; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 25 });
    const timeout = opts.timeoutMs ?? 15_000;
    socket.setTimeout(timeout);
    let buf = '';
    let step = 0;
    const replies: Reply[] = [];
    const steps = [
      () => `EHLO ${opts.helo || 'mail.kineticsand.local'}`,
      () => `MAIL FROM:<${opts.from ?? ''}>`,
      ...rcpts.map((r) => () => `RCPT TO:<${r}>`),
    ];
    const done = (error?: string) => {
      try { socket.write('QUIT\r\n'); } catch { /* closed */ }
      socket.destroy();
      resolve({ replies, error });
    };
    socket.on('timeout', () => done('timeout'));
    socket.on('error', (e) => done(e.message));
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
      if (step === 0 && code !== 220) return done(`greeting ${code} ${text}`);
      if ((step === 1 || step === 2) && code >= 400) return done(`${step === 1 ? 'EHLO' : 'MAIL FROM'} ${code} ${text}`);
      if (step - 0 >= steps.length) return done();
      socket.write(`${steps[step]()}\r\n`);
      step++;
    });
  });
}
