import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Row = Record<string, any>;
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ name: string }>('SELECT name FROM _migrations').map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      this.tx(() => {
        this.raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        this.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
      });
    }
  }

  private bind(params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
    if (!params) return [];
    if (Array.isArray(params)) return params.map(normalize);
    const out: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) out[k] = normalize(v);
    return [out];
  }

  get<T = any>(sql: string, params?: Params): T | undefined {
    return this.raw.prepare(sql).get(...(this.bind(params) as SQLInputValue[])) as T | undefined;
  }

  all<T = any>(sql: string, params?: Params): T[] {
    return this.raw.prepare(sql).all(...(this.bind(params) as SQLInputValue[])) as T[];
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...(this.bind(params) as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Insert a row from an object and return its id. */
  insert(table: string, data: Row): number {
    const keys = Object.keys(data);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return this.run(sql, keys.map((k) => data[k])).lastInsertRowid;
  }

  /** Update columns of one row by id. */
  update(table: string, id: number, data: Row): void {
    const keys = Object.keys(data);
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.run(sql, [...keys.map((k) => data[k]), id]);
  }

  /** Run fn in a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close() {
    this.raw.close();
  }
}

function normalize(v: unknown): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as SQLInputValue;
}

export const nowIso = () => new Date().toISOString();
