import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Db } from '../src/db/db.ts';
import { setEncryptionKey } from '../src/lib/crypto.ts';
import { buildApp } from '../src/app.ts';
import { silentLogger, type Ctx } from '../src/context.ts';
import type { Config } from '../src/config.ts';
import type { MailGateway, OutgoingMessage, SendResult } from '../src/mail/gateway.ts';
import type { Row } from '../src/db/db.ts';

/** In-memory gateway that records sends and can be told to fail. */
export class FakeMail implements MailGateway {
  sent: { sender: Row; msg: OutgoingMessage }[] = [];
  failWith: Error | null = null;
  verifyResult: { smtp: string | null; imap: string | null } = { smtp: null, imap: null };
  async send(sender: Row, msg: OutgoingMessage): Promise<SendResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ sender, msg });
    return { accepted: [msg.to], rejected: [], response: '250 OK' };
  }
  async withImap<T>(): Promise<T> {
    throw new Error('IMAP not available in FakeMail');
  }
  async verify() {
    return this.verifyResult;
  }
}

export interface TestEnv {
  ctx: Ctx;
  app: FastifyInstance;
  dir: string;
  clock: { now: Date };
  api: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Authenticated request returning the raw response (headers, bytes). */
  raw: (method: string, url: string) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function makeEnv(opts: { mail?: MailGateway | ((db: Db) => MailGateway); now?: Date; fetch?: typeof fetch } = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'kinetic-test-'));
  const key = randomBytes(32);
  setEncryptionKey(key);
  const config: Config = {
    port: 0, host: '127.0.0.1', dataDir: dir, dbPath: join(dir, 'test.db'), publicUrl: 'http://bear.test',
    appKey: key, workers: false, logLevel: 'silent', tickScale: 1,
  };
  const db = new Db(config.dbPath);
  const clock = { now: opts.now ?? new Date() };
  const ctx: Ctx = {
    db, config, log: silentLogger, mail: typeof opts.mail === 'function' ? opts.mail(db) : opts.mail ?? new FakeMail(),
    now: () => new Date(clock.now.getTime()),
    fetch: opts.fetch ?? (async () => new Response('ok', { status: 200 })),
  };
  const app = await buildApp(ctx);

  // First-run setup creates the admin user + workspace; then mint an API token.
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { name: 'Test Admin', email: 'admin@bear.test', password: 'password123' } });
  const cookie = setup.headers['set-cookie'] as string;
  const tok = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: { cookie: cookie.split(';')[0]! }, payload: { name: 'tests', type: 'super-admin' } });
  const token = tok.json().data.plain_text_token as string;

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: body as any });
    let parsed: any = null;
    try { parsed = res.json(); } catch { parsed = res.body; }
    return { status: res.statusCode, body: parsed };
  };

  return {
    ctx, app, dir, clock, api,
    raw: (method: string, url: string) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` } }),
    close: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Opens a campaign's sending window around the clock, every day (UTC). */
export function openAllDay(ctx: Ctx, campaignId: number) {
  const days = { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true };
  // Equal start/end means a 24h window in the scheduler.
  ctx.db.update('campaigns', campaignId, { schedule_days: JSON.stringify(days), schedule_start_time: '00:00', schedule_end_time: '00:00', schedule_timezone: 'UTC' });
}
