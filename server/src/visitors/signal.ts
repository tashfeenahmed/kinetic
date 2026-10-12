/** "Website visits" signal for GTM tables: visits to your tracked sites by a company domain or a lead's email. */
import type { Ctx } from '../context.ts';
import type { OutreachBridge } from '../gtm/outreach.ts';
import type { SignalInput } from '../gtm/providers/signals.ts';
import type { Ctx as ProviderCtx, Hit } from '../gtm/providers/types.ts';
import { visitStats } from './service.ts';

// Providers only see the GTM context; the app context is found through the workspace's outreach bridge.
const apps = new WeakMap<OutreachBridge, Ctx>();
export function registerVisitorSignal(ctx: Ctx) {
  if (ctx.gtm) apps.set(ctx.gtm.outreach, ctx);
}

export async function websiteVisits(input: SignalInput, ctx: ProviderCtx): Promise<Hit | null> {
  if (!input.domain && !input.email) return null;
  const app = ctx.outreach ? apps.get(ctx.outreach) : undefined;
  if (!app || !ctx.workspaceId) throw new Error('Website visitors are not available');
  const s = visitStats(app, ctx.workspaceId, { domain: input.domain, email: input.email });
  if (!s.found) return { value: 0, data: { note: 'No visits from this company or person yet', visits30d: 0, score: 0 } };
  return {
    value: s.visits_30d,
    data: { lastVisit: s.last_visit, visits30d: s.visits_30d, pageviews30d: s.pageviews_30d, totalVisits: s.total_visits, score: s.score, pages: s.pages, matchedBy: s.kind },
  };
}
