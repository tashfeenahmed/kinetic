/**
 * Paid data credits: Apollo, Hunter, Prospeo and People Data Labs.
 *
 * The free steps (website + web search read with AI, pattern + SMTP check) run first in
 * every email/people waterfall; these vendors are the fallback. Each call that spends a
 * credit is metered here per calendar month, every vendor has a monthly budget (its free
 * allowance by default), and a waterfall skips a vendor once its budget is used up.
 * Hunter and Prospeo also report their live balance, shown next to the local count.
 */
import type { Db } from '../../db/db.ts';
import { getSetting, setSetting } from '../../settings.ts';
import type { Settings, SettingKey } from '../settings.ts';
import { getJson } from '../lib/http.ts';

export type CreditProvider = 'apollo' | 'hunter' | 'prospeo' | 'pdl';
export const CREDIT_PROVIDERS: CreditProvider[] = ['apollo', 'hunter', 'prospeo', 'pdl'];

export const PROVIDER_INFO: Record<CreditProvider, { label: string; key: SettingKey; freeMonthly: number; note: string }> = {
  apollo: { label: 'Apollo', key: 'APOLLO_API_KEY', freeMonthly: 100, note: 'People search is free; 1 credit per email revealed' },
  hunter: { label: 'Hunter', key: 'HUNTER_API_KEY', freeMonthly: 50, note: 'Free plan: 50 credits/month (email finder 1, verifier 0.5, domain search 1 per 10 emails)' },
  prospeo: { label: 'Prospeo', key: 'PROSPEO_API_KEY', freeMonthly: 75, note: 'Free plan: 75 credits/month (1 per email found, 1 per search page)' },
  pdl: { label: 'People Data Labs', key: 'PDL_API_KEY', freeMonthly: 100, note: 'Free plan: 100 records/month; emails and phones hidden' },
};

/** Waterfall step ids that spend a vendor's credits. */
export const STEP_PROVIDER: Record<string, CreditProvider> = { apollo: 'apollo', hunter: 'hunter', prospeo: 'prospeo', pdl: 'pdl' };

const month = (d = new Date()) => d.toISOString().slice(0, 7);

/** Record credits spent (only call when the vendor actually charged, i.e. returned data). */
export function useCredits(db: Db | undefined, provider: CreditProvider, credits: number) {
  if (!db || !(credits > 0)) return;
  db.run(`INSERT INTO provider_usage (provider, month, calls, credits, last_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(provider, month) DO UPDATE SET calls = calls + 1, credits = credits + excluded.credits, last_at = excluded.last_at`,
  [provider, month(), credits, new Date().toISOString()]);
}

export function usedThisMonth(db: Db, provider: CreditProvider): { calls: number; credits: number; last_at: string | null } {
  return db.get('SELECT calls, credits, last_at FROM provider_usage WHERE provider = ? AND month = ?', [provider, month()]) ?? { calls: 0, credits: 0, last_at: null };
}

export function budgets(db: Db): Record<CreditProvider, number> {
  let saved: Partial<Record<CreditProvider, number>> = {};
  try { saved = JSON.parse(getSetting(db, 'credit_budgets') || '{}'); } catch { /* defaults */ }
  return Object.fromEntries(CREDIT_PROVIDERS.map((p) => [p, Number.isFinite(saved[p]) ? Number(saved[p]) : PROVIDER_INFO[p].freeMonthly])) as Record<CreditProvider, number>;
}

export function setBudgets(db: Db, patch: Partial<Record<CreditProvider, number>>) {
  const next = { ...budgets(db) };
  for (const p of CREDIT_PROVIDERS) if (patch[p] != null) next[p] = Math.max(0, Math.round(Number(patch[p])));
  setSetting(db, 'credit_budgets', JSON.stringify(next));
  return next;
}

/** Why a vendor must be skipped right now (budget used up), or null. */
export function budgetBlock(db: Db, provider: CreditProvider): string | null {
  const budget = budgets(db)[provider];
  const used = usedThisMonth(db, provider).credits;
  return used >= budget ? `monthly budget reached (${fmt(used)}/${budget})` : null;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

// ---- live balances (free account endpoints), cached for 10 minutes ----
const liveCache = new Map<CreditProvider, { at: number; v: Live | null }>();
interface Live { remaining: number | null; used?: number | null; available?: number | null; resets?: string | null; plan?: string | null }

async function live(settings: Settings, p: CreditProvider): Promise<Live | null> {
  const key = settings.get(PROVIDER_INFO[p].key);
  if (!key) return null;
  const hit = liveCache.get(p);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  let v: Live | null = null;
  try {
    if (p === 'hunter') {
      const d = await getJson('https://api.hunter.io/v2/account', { query: { api_key: key }, timeoutMs: 10_000 });
      const c = d?.data?.requests?.credits;
      v = { remaining: c ? Number(c.remaining ?? Number(c.available) - Number(c.used)) : null, used: c?.used ?? null, available: c?.available ?? null, resets: d?.data?.reset_date ?? null, plan: d?.data?.plan_name ?? null };
    } else if (p === 'prospeo') {
      const d = await getJson('https://api.prospeo.io/account-information', { headers: { 'X-KEY': key }, timeoutMs: 10_000 });
      const r = d?.response ?? d;
      v = { remaining: r?.remaining_credits ?? null, used: r?.used_credits ?? null, resets: r?.next_quota_renewal_date ?? null, plan: r?.current_plan ?? null };
    }
  } catch { v = null; }
  liveCache.set(p, { at: Date.now(), v });
  return v;
}

/** Everything the Credits panel shows. */
export async function creditsOverview(settings: Settings) {
  const db = settings.db;
  const b = budgets(db);
  return Promise.all(CREDIT_PROVIDERS.map(async (p) => {
    const info = PROVIDER_INFO[p];
    const used = usedThisMonth(db, p);
    const connected = settings.has(info.key);
    return {
      id: p, label: info.label, note: info.note, connected,
      month: month(), used: Math.round(used.credits * 10) / 10, calls: used.calls, last_at: used.last_at,
      budget: b[p], free_monthly: info.freeMonthly,
      blocked: connected ? budgetBlock(db, p) : null,
      live: connected ? await live(settings, p) : null,
    };
  }));
}
