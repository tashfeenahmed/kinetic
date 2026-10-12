import { randomBytes } from 'node:crypto';
import type { Db } from '../src/db/db.ts';
import { setEncryptionKey } from '../src/lib/crypto.ts';

/** GTM unit tests run against the full schema; saved keys are encrypted, so a key must be set. */
export function gtmTestSetup() {
  setEncryptionKey(randomBytes(32));
}

/** Tables belong to a workspace. */
export function workspace(db: Db): number {
  return db.insert('workspaces', { name: 'Test workspace' });
}
