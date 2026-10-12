/**
 * Safety stops: rate-limit responses, login walls, checkpoints and captchas. Any of these
 * throws SafetyError; the runner reports it to Kinetic, which pauses the site for this browser.
 */
import type { SafetyKind, Site } from '../../../server/src/companion/protocol.ts';

export class SafetyError extends Error {
  kind: SafetyKind;
  url?: string;
  constructor(kind: SafetyKind, message: string, url?: string) {
    super(message);
    this.kind = kind;
    this.url = url;
  }
}

/** Thrown to stop a task cleanly (budget used up, server said stop, aborted). */
export class StopTask extends Error {}

const LOGIN_PATHS: Record<Site, RegExp> = {
  linkedin: /\/(authwall|login|uas\/login|signup)/,
  instagram: /\/accounts\/login/,
  x: /\/(i\/flow\/login|login)/,
  facebook: /\/login(\.php)?/,
  reddit: /\/login/,
  github: /\/login/,
};
const CHALLENGE_PATHS: Record<Site, RegExp> = {
  linkedin: /\/checkpoint\//,
  instagram: /\/challenge\//,
  x: /\/account\/access/,
  facebook: /\/checkpoint\//,
  reddit: /$^/,
  github: /$^/,
};

export function checkUrl(site: Site, url: string) {
  let path = '';
  try { path = new URL(url).pathname; } catch { return; }
  if (CHALLENGE_PATHS[site].test(path)) throw new SafetyError('challenge', 'The site asked for a security check (checkpoint/captcha).', url);
  if (LOGIN_PATHS[site].test(path)) throw new SafetyError('logged_out', `You are not logged in to ${site} in this browser.`, url);
}

/** Inspects an HTTP response made from the page context. */
export function checkResponse(site: Site, res: Response, reqUrl: string) {
  if (res.status === 429 || res.status === 999) throw new SafetyError('rate_limited', `${site} rate-limited this browser (HTTP ${res.status}).`, reqUrl);
  if (res.redirected) checkUrl(site, res.url);
  if (res.status === 401) throw new SafetyError('logged_out', `${site} says this browser is not logged in (HTTP 401).`, reqUrl);
}

/** Inspects the rendered page for captchas, checkpoints and restriction notices. */
export function checkPage(site: Site, doc: Document = document) {
  checkUrl(site, doc.location?.href ?? '');
  const captcha = doc.querySelector('iframe[src*="captcha" i], #captcha-internal, [id*="captcha" i], iframe[src*="arkoselabs"], iframe[title*="challenge" i]');
  if (captcha) throw new SafetyError('challenge', 'A captcha/challenge is showing on the page.', doc.location?.href);
  const text = (doc.body?.innerText ?? '').slice(0, 20_000).toLowerCase();
  if (/your account (has been|is) (temporarily )?restricted|we've restricted your account|account restricted/.test(text)) {
    throw new SafetyError('restricted', 'The site shows an account restriction notice.', doc.location?.href);
  }
  if (site === 'linkedin' && /you('|’)ve reached the weekly invitation limit|weekly invitation limit/.test(text)) {
    throw new SafetyError('rate_limited', 'LinkedIn weekly invitation limit reached.', doc.location?.href);
  }
  if (/try again later|rate limit exceeded|too many requests/.test(text) && text.length < 4000) {
    throw new SafetyError('rate_limited', 'The site asked to try again later.', doc.location?.href);
  }
}
