/**
 * Which connections a signal, enrichment or action still needs. `requires` entries are
 * setting keys; "A|B" means either one will do. Labels come from the Integrations page.
 */
import { SETTINGS_META } from './settingsMeta.ts';
import type { Settings, SettingKey } from './settings.ts';
import { HttpError } from '../http.ts';

const label = (key: string) => SETTINGS_META.find((m) => m.key === key)?.label ?? key;

/** Human names of the connections still missing ("PDL or Apollo"), empty when ready. */
export function missingConnections(requires: readonly string[], settings: Settings): string[] {
  return requires
    .filter((group) => !group.split('|').some((k) => settings.has(k as SettingKey)))
    .map((group) => group.split('|').map(label).join(' or '));
}

/** Kinds that can't run at all until something is connected. */
const ACTION_NEEDS: Record<string, string[]> = {
  slack: ['SLACK_WEBHOOK_URL|SLACK_BOT_TOKEN'],
  hubspot_contact: ['HUBSPOT_TOKEN'],
  hubspot_company: ['HUBSPOT_TOKEN'],
  salesforce: ['SALESFORCE_CLIENT_ID'],
};
export const actionNeeds = (kind: string) => ACTION_NEEDS[kind] ?? [];

export function requireConnected(what: string, requires: readonly string[], settings: Settings) {
  const missing = missingConnections(requires, settings);
  if (missing.length) {
    throw new HttpError(422, { error: 'not_connected', message: `${what} needs ${missing.join(' and ')}. Connect it on the Integrations page first.`, missing });
  }
}
