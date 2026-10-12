import type { Db } from './db/db.ts';
import { decrypt, encrypt } from './lib/crypto.ts';
import type { OAuthAppConfig, OAuthProvider } from './mail/oauth.ts';

/** Install-wide key/value settings. Secrets are stored encrypted with an "enc:" prefix. */
export function getSetting(db: Db, key: string): string | null {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return null;
  return row.value.startsWith('enc:') ? decrypt(row.value.slice(4)) : row.value;
}

export function setSetting(db: Db, key: string, value: string | null, opts: { secret?: boolean } = {}) {
  if (value === null || value === '') {
    db.run('DELETE FROM settings WHERE key = ?', [key]);
    return;
  }
  const stored = opts.secret ? `enc:${encrypt(value)}` : value;
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, stored]);
}

export function getOAuthApp(db: Db, provider: OAuthProvider): OAuthAppConfig | null {
  const clientId = getSetting(db, `${provider}_client_id`);
  const clientSecret = getSetting(db, `${provider}_client_secret`);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tenant: getSetting(db, `${provider}_tenant`) ?? undefined };
}

/** Phrase embedded in warmup emails so users can filter them out of their own mail clients. */
export function warmupFilterPhrase(db: Db): string {
  let phrase = getSetting(db, 'warmup_filter_phrase');
  if (!phrase) {
    const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen', 'maple', 'nectar', 'onyx', 'pebble', 'quartz', 'raven', 'sable', 'tundra'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    phrase = `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
    setSetting(db, 'warmup_filter_phrase', phrase);
  }
  return phrase;
}
