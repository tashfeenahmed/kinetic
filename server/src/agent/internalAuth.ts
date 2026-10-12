/**
 * Short-lived, single-use, in-memory credentials that let the Kinetic Agent call
 * `/api/*` routes in-process (app.inject) as the chatting user. Tokens never leave
 * the process: they are minted right before an inject and consumed by it, so the
 * header is useless to anyone outside. Normal session/API-token auth is untouched.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError, type Auth } from '../http.ts';

export const INTERNAL_HEADER = 'x-kinetic-agent-token';
const TTL_MS = 60_000;

const tokens = new Map<string, { auth: Auth; expires: number }>();

export function mintInternalToken(a: Auth): string {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { auth: a, expires: now + TTL_MS });
  return token;
}

export function revokeInternalToken(token: string) {
  tokens.delete(token);
}

/**
 * undefined when the request carries no agent header (normal auth applies);
 * the agent's Auth when the token is valid; 401 otherwise. Only in-process
 * injected requests are accepted, so a forwarded header from the network never works.
 */
export function internalAuth(req: FastifyRequest): Auth | undefined {
  const token = req.headers[INTERNAL_HEADER];
  if (token === undefined) return undefined;
  const entry = typeof token === 'string' ? tokens.get(token) : undefined;
  // app.inject (light-my-request) uses a MockSocket; real connections are net.Socket.
  const injected = (req.raw as any).socket?.constructor?.name === 'MockSocket';
  if (!entry || entry.expires < Date.now() || !injected) throw new HttpError(401, { error: 'invalid_token', message: 'Invalid agent token.' });
  tokens.delete(token as string); // single use
  return entry.auth;
}
