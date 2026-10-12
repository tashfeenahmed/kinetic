import type { Db } from './db/db.ts';
import type { Config } from './config.ts';
import type { MailGateway } from './mail/gateway.ts';
import type { Gtm } from './gtm/index.ts';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

/** Shared dependencies passed to routes and background engines. */
export interface Ctx {
  db: Db;
  config: Config;
  log: Logger;
  mail: MailGateway;
  /** Injectable clock so scheduling logic can be tested deterministically. */
  now: () => Date;
  /** Optional hook for outbound HTTP (webhooks); tests replace it. */
  fetch: typeof fetch;
  /** Tables, enrichment, signals (created by buildApp when absent). */
  gtm?: Gtm;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
