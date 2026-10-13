/**
 * WhatsApp messages through the Companion (the user's own WhatsApp Web, no API): targets are
 * normalised to E.164 and checked against opt-outs before any task is queued. The extension
 * opens web.whatsapp.com/send?phone=…&text=… and presses send (see extension/src/sites/whatsapp.ts).
 */
import type { Ctx } from '../context.ts';
import { unwrap } from '../gtm/lib/template.ts';
import { isExcluded } from '../sourcing/exclusions.ts';
import { normPhone, rowIds } from '../sourcing/normalize.ts';
import type { Target } from './jobs.ts';
import type { Rec } from './protocol.ts';

export type WhatsappSkip = 'invalid_phone' | 'opted_out' | 'duplicate';
export interface WhatsappTarget { target: Rec; skip?: WhatsappSkip }

/** web.whatsapp.com wants the number as digits only, with the country code. */
export const sendUrl = (phone: string, text = '') =>
  `https://web.whatsapp.com/send?phone=${phone.replace(/\D/g, '')}${text ? `&text=${encodeURIComponent(text)}` : ''}`;

const NAME_COLS = ['full name', 'name', 'contact', 'first name'];
function nameOf(row: Record<string, unknown> = {}): string {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), String(unwrap(v) ?? '').trim()]));
  for (const k of NAME_COLS) if (lower.get(k)) return lower.get(k)!;
  return '';
}

/** Opted out: on an exclusion list (phone, email, domain…), the email/domain blacklist, or an unsubscribed lead. */
export function optedOut(ctx: Ctx, workspaceId: number, phone: string, row: Record<string, unknown> = {}): boolean {
  if (isExcluded(ctx.db, workspaceId, { ...row, phone })) return true;
  const email = rowIds(row).email;
  if (!email) return false;
  const domain = email.split('@')[1]!;
  return !!ctx.db.get(`SELECT 1 FROM blacklisted_emails WHERE workspace_id = ? AND email = ?
    UNION ALL SELECT 1 FROM blacklisted_domains WHERE workspace_id = ? AND domain = ?
    UNION ALL SELECT 1 FROM leads WHERE workspace_id = ? AND email = ? AND status = 'unsubscribed'`, [workspaceId, email, workspaceId, domain, workspaceId, email]);
}

/** One entry per target: the normalised task target, or why it is skipped. */
export function whatsappTargets(ctx: Ctx, workspaceId: number, targets: Target[], countryCode?: string): WhatsappTarget[] {
  const seen = new Set<string>();
  return targets.map((t) => {
    const phone = normPhone(t.url, countryCode);
    const target: Rec = { url: phone || t.url, phone: phone || t.url, name: nameOf(t.row), ...(t.row ? { row: t.row } : {}) };
    if (!phone) return { target, skip: 'invalid_phone' };
    if (seen.has(phone)) return { target, skip: 'duplicate' };
    seen.add(phone);
    return optedOut(ctx, workspaceId, phone, t.row) ? { target, skip: 'opted_out' } : { target };
  });
}

export const SKIP_TEXT: Record<WhatsappSkip, string> = {
  invalid_phone: 'Not a valid phone number (add the country code)',
  opted_out: 'Opted out (blacklist, exclusion list or unsubscribed)',
  duplicate: 'Same number earlier in the list',
};
