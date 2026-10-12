import type { Settings, SettingKey } from '../settings.ts';
import type { OutreachBridge } from '../outreach.ts';

export interface Ctx {
  settings: Settings;
  /** Where providers may cache downloaded datasets. */
  dataDir?: string;
  /** Workspace that owns the table being run. */
  workspaceId?: number;
  /** Leads/campaigns of the same workspace (set inside the app; absent in unit tests). */
  outreach?: OutreachBridge;
  log: (message: string) => void;
  /** The cell's previous value, for change-detecting signals. */
  prev?: unknown;
}

/** Normalised inputs an enrichment column maps from row columns. */
export interface EnrichInput {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  domain?: string;
  companyName?: string;
  linkedinUrl?: string;
  title?: string;
  url?: string;
}

/** What one provider found. `value` is the headline shown in the grid. */
export interface Hit {
  value: unknown;
  data?: Record<string, unknown>;
  confidence?: string;
  /**
   * A best guess the provider couldn't confirm (e.g. catch-all domain). The waterfall
   * keeps it as a fallback and continues; it's used only if nothing better turns up.
   */
  weak?: boolean;
}

export interface ProviderStep {
  id: string;
  label: string;
  /** Settings that must be present for this step to run; steps missing keys are skipped. */
  requires: SettingKey[];
  /** Rough cost per lookup, shown in the UI. */
  cost: string;
  run: (input: EnrichInput, ctx: Ctx) => Promise<Hit | null>;
}

export interface EnrichKind {
  id: string;
  label: string;
  description: string;
  /** Inputs offered in the column editor; `needs` lists alternatives (any one group satisfied). */
  inputs: (keyof EnrichInput)[];
  needs: (keyof EnrichInput)[][];
  steps: ProviderStep[];
}

export function nameParts(input: EnrichInput): { first: string; last: string; full: string } {
  const full = (input.fullName || [input.firstName, input.lastName].filter(Boolean).join(' ')).trim();
  const parts = full.split(/\s+/).filter(Boolean);
  const first = (input.firstName || parts[0] || '').trim();
  const last = (input.lastName || (parts.length > 1 ? parts[parts.length - 1] : '') || '').trim();
  return { first, last, full };
}
