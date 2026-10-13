import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { SocksClient } from 'socks';
import type { Db, Row } from '../db/db.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { refreshAccessToken, type OAuthProvider } from './oauth.ts';
import { getOAuthApp } from '../settings.ts';

export interface OutgoingMessage {
  from: { name: string; email: string };
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;          // without angle brackets
  inReplyTo?: string | null;  // without angle brackets
  references?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  response: string;
}

/** Everything the engines need from a mailbox. Swappable in tests. */
export interface MailGateway {
  send(sender: Row, msg: OutgoingMessage): Promise<SendResult>;
  withImap<T>(sender: Row, fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  verify(sender: Row): Promise<{ smtp: string | null; imap: string | null }>;
}

/** Connection settings for an IMAP-only account (seed accounts for placement tests). */
export interface ImapAccount {
  imap_server: string;
  imap_port: number;
  imap_secure: number | boolean;
  username: string;
  secret_enc: string;
}

const bracket = (id: string) => `<${id.replace(/^<|>$/g, '')}>`;

export class RealMailGateway implements MailGateway {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private egress(sender: Row): { proxy?: string; localAddress?: string } {
    if (!sender.egress_route_id) return {};
    const r = this.db.get('SELECT proxy_url, local_address FROM egress_routes WHERE id = ?', [sender.egress_route_id]);
    const proxy = r?.proxy_url ? (String(r.proxy_url).startsWith('enc:') ? decrypt(String(r.proxy_url).slice(4)) : r.proxy_url) : undefined;
    return { proxy: proxy || undefined, localAddress: r?.local_address || undefined };
  }

  /**
   * Returns credentials, refreshing the OAuth access token when it is about to expire
   * (or always, with `force`: the provider rejected a token that hasn't expired yet).
   */
  async credentials(sender: Row, force = false): Promise<{ user: string; pass?: string; accessToken?: string }> {
    const user = sender.username || sender.email;
    if (sender.auth_type !== 'oauth') return { user, pass: decrypt(sender.secret_enc) };

    const expires = sender.oauth_expires_at ? Date.parse(sender.oauth_expires_at) : 0;
    if (!force && sender.oauth_access_token_enc && expires - Date.now() > 120_000) {
      return { user, accessToken: decrypt(sender.oauth_access_token_enc) };
    }
    const provider = sender.provider as OAuthProvider;
    const app = getOAuthApp(this.db, provider);
    if (!app) throw new Error(`${provider} OAuth app is not configured (Settings → Integrations)`);
    const tokens = await refreshAccessToken(provider, app, decrypt(sender.secret_enc));
    const update: Row = {
      oauth_access_token_enc: encrypt(tokens.access_token),
      oauth_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };
    if (tokens.refresh_token) update.secret_enc = encrypt(tokens.refresh_token);
    this.db.update('sender_emails', sender.id, update);
    Object.assign(sender, update);
    return { user, accessToken: tokens.access_token };
  }

  private async transport(sender: Row) {
    const creds = await this.credentials(sender);
    const { proxy, localAddress } = this.egress(sender);
    const transporter = nodemailer.createTransport({
      host: sender.smtp_server,
      port: sender.smtp_port,
      secure: !!sender.smtp_secure,
      auth: creds.accessToken ? { type: 'OAuth2', user: creds.user, accessToken: creds.accessToken } : { user: creds.user, pass: creds.pass },
      proxy,
      localAddress,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    } as any);
    if (proxy?.startsWith('socks')) transporter.set('proxy_socks_module', { SocksClient } as any);
    return transporter;
  }

  async send(sender: Row, msg: OutgoingMessage): Promise<SendResult> {
    const transporter = await this.transport(sender);
    try {
      const info = await transporter.sendMail({
        from: { name: msg.from.name, address: msg.from.email },
        to: msg.to,
        cc: msg.cc || undefined,
        bcc: msg.bcc || undefined,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        messageId: bracket(msg.messageId),
        inReplyTo: msg.inReplyTo ? bracket(msg.inReplyTo) : undefined,
        references: msg.references?.length ? msg.references.map(bracket) : undefined,
        headers: msg.headers,
        attachments: msg.attachments,
      });
      return {
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        response: info.response ?? '',
      };
    } finally {
      transporter.close();
    }
  }

  /**
   * Runs `fn` on a logged-in IMAP connection. Retries once when the connection times out or
   * drops before login (Outlook does this now and then), and once with a freshly refreshed
   * token when an OAuth login is rejected (e.g. the access token was revoked early).
   */
  async withImap<T>(sender: Row, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const { proxy } = this.egress(sender);
    const attempt = async (force: boolean) => {
      const creds = await this.credentials(sender, force);
      return runImap(
        { host: sender.imap_server, port: sender.imap_port, secure: !!sender.imap_secure, auth: creds.accessToken ? { user: creds.user, accessToken: creds.accessToken } : { user: creds.user, pass: creds.pass! }, proxy },
        fn,
      );
    };
    try {
      return await attempt(false);
    } catch (e: any) {
      if (sender.auth_type === 'oauth' && isLoginRejected(e)) return attempt(true);
      if (isTransientConnectError(e)) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
        return attempt(false);
      }
      throw e;
    }
  }

  /** Pause before retrying a connection that timed out (tests set it to 0). */
  retryDelayMs = 3000;

  async verify(sender: Row) {
    let smtp: string | null = null;
    let imap: string | null = null;
    try {
      const t = await this.transport(sender);
      try { await t.verify(); } finally { t.close(); }
    } catch (e: any) {
      smtp = e?.message ?? String(e);
    }
    try {
      await this.withImap(sender, async () => undefined);
    } catch (e: any) {
      imap = e?.responseText ?? e?.message ?? String(e);
    }
    return { smtp, imap };
  }
}

interface ImapOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass?: string; accessToken?: string };
  proxy?: string;
}

export async function runImap<T>(opts: ImapOptions, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: opts.auth as any,
    proxy: opts.proxy,
    logger: false,
    emitLogs: false,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  } as any);
  client.on('error', () => { /* surfaced through the awaited calls */ });
  try {
    await client.connect();
  } catch (e: any) {
    e.stage = 'connect';
    throw e;
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** The server refused the login (as opposed to a network problem). */
export function isLoginRejected(e: any): boolean {
  if (e?.authenticationFailed) return true;
  return /AUTHENTICATIONFAILED|AUTHENTICATE failed|Login failed|Invalid credentials/i.test(`${e?.responseText ?? ''} ${e?.message ?? ''}`);
}

/** A connection that timed out or dropped before we got going — worth one more try. */
export function isTransientConnectError(e: any): boolean {
  if (e?.stage !== 'connect' || isLoginRejected(e)) return false;
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|timed? ?out|required time|Connection closed|socket hang up/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
}

export function withSeedImap<T>(seed: ImapAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return runImap({ host: seed.imap_server, port: seed.imap_port, secure: !!seed.imap_secure, auth: { user: seed.username, pass: decrypt(seed.secret_enc) } }, fn);
}
