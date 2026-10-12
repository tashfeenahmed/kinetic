import type { Db } from '../db/db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { SETTINGS_META } from './settingsMeta.ts';

/**
 * Data, AI and integration keys for the GTM tools. A value set in the environment
 * (same name) wins over one saved from Settings. Saved secrets are encrypted with
 * the install's app key, like mailbox passwords.
 */
export const SETTING_KEYS = [
  'OPENROUTER_API_KEY', 'AI_MODEL', 'AI_BASE_URL',
  'SERPER_API_KEY', 'SEARXNG_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'JINA_API_KEY',
  'HUNTER_API_KEY', 'APOLLO_API_KEY', 'PDL_API_KEY', 'PROSPEO_API_KEY', 'FINDYMAIL_API_KEY',
  'LEADMAGIC_API_KEY', 'ICYPEAS_API_KEY',
  'MILLIONVERIFIER_API_KEY', 'ZEROBOUNCE_API_KEY',
  'GITHUB_TOKEN', 'SEC_USER_AGENT', 'SMTP_HELO', 'COMPANIES_HOUSE_API_KEY', 'CERTSPOTTER_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'SLACK_WEBHOOK_URL', 'SLACK_BOT_TOKEN',
  'HUBSPOT_TOKEN',
  'SALESFORCE_DOMAIN', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export class Settings {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(key: SettingKey): string | undefined {
    const env = process.env[key];
    if (env) return env;
    return getSetting(this.db, key) || undefined;
  }

  has(key: SettingKey): boolean {
    return !!this.get(key);
  }

  set(key: SettingKey, value: string | null) {
    const plain = SETTINGS_META.find((m) => m.key === key)?.secret === false;
    setSetting(this.db, key, value || null, { secret: !plain });
  }

  /** For the Settings page: metadata plus which keys are set and where from, with secrets masked. */
  describe() {
    return SETTINGS_META.map((m) => {
      const fromEnv = !!process.env[m.key];
      const value = this.get(m.key);
      const plain = m.secret === false;
      return { ...m, set: !!value, fromEnv, preview: value ? (plain ? value : mask(value)) : '' };
    });
  }
}

function mask(v: string) {
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
