import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** Project root (the folder containing server/ and web/). .env and data/ live here by default. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  publicUrl: string;
  appKey: Buffer;
  workers: boolean;
  logLevel: string;
  /** Multiplier for worker intervals; tests use small values to run fast. */
  tickScale: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;

  const dataDir = overrides.dataDir ?? resolve(ROOT, env.DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const port = Number(env.PORT ?? 4200);

  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    dbPath: join(dataDir, 'kinetic.db'),
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    appKey: loadAppKey(dataDir, env.APP_KEY),
    workers: env.WORKERS !== 'off',
    logLevel: env.LOG_LEVEL ?? 'info',
    tickScale: Number(env.TICK_SCALE ?? 1),
    ...overrides,
  };
}

/** 32-byte key used to encrypt mailbox passwords. Generated once and kept in the data dir. */
function loadAppKey(dataDir: string, fromEnv?: string): Buffer {
  if (fromEnv) return Buffer.from(fromEnv, 'base64');
  const file = join(dataDir, 'app.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}
