/**
 * Facebook content script: opens the group/event/page, scrolls like a person and parses the
 * GraphQL responses the page loads (captured by capture.ts), with the rendered HTML as a fallback.
 */
import type { Rec } from '../../../server/src/companion/protocol.ts';
import { parse } from '../../../server/src/companion/parsers/index.ts';
import { findButton, humanClick, pageHtml, waitFor } from '../lib/dom.ts';
import { humanDelay, humanScroll, sleep } from '../lib/pacing.ts';
import { drainCaptured, registerSite, scrollCollect, type Handler, type TaskCtx } from '../lib/runner.ts';
import { checkPage } from '../lib/safety.ts';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const GRAPHQL = /\/api\/graphql|\/graphql\//;

async function settle() {
  await waitFor('[role="main"], #content', 15_000);
  await sleep(humanDelay([2000, 4000]));
  checkPage('facebook');
}

const members = (urlOf: (ctx: TaskCtx) => string, before?: () => Promise<void>): Handler => async (ctx) => {
  await settle();
  await before?.();
  const url = urlOf(ctx);
  await scrollCollect(ctx, {
    match: GRAPHQL,
    parse: (c) => parse('facebook.members', c.data, { url }).records,
    fallback: () => parse('facebook.members', pageHtml(), { url }).records,
    container: () => document.querySelector('[role="dialog"] [style*="overflow"], [role="dialog"]'),
    maxIdle: 5,
  });
};

const handlers: Record<string, Handler> = {
  'facebook.group_members': members((ctx) => str(ctx.task.params.group_url)),

  'facebook.event_attendees': members((ctx) => str(ctx.task.params.event_url), async () => {
    // The guest list opens from the "Going" / "Interested" counters.
    const btn = findButton(/^(\d[\d,.KkMm]*\s+)?(going|interested|went)\b/i, document.querySelector('[role="main"]') ?? document);
    if (btn) { await humanClick(btn); await sleep(humanDelay([1500, 3000])); }
  }),

  'facebook.page_scraper': async (ctx) => {
    await settle();
    const url = str(ctx.task.target.url);
    // About sections load lazily; give the page a scroll first.
    await humanScroll({ steps: 3 });
    let recs: Rec[] = [];
    for (const c of drainCaptured(GRAPHQL)) {
      recs = parse('facebook.page', c.data, { url }).records;
      if (recs.length && recs[0]!.name) break;
    }
    const fromHtml = parse('facebook.page', pageHtml(), { url }).records[0];
    const rec = { ...(fromHtml ?? {}), ...(recs[0] ?? {}) } as Rec;
    if (!rec.name) throw new Error(`Couldn't read the Facebook page ${url}`);
    await ctx.results([{ ...rec, profileUrl: rec.profileUrl ?? url }]);
    await ctx.complete({ status: 'done' });
  },
};

registerSite('facebook', handlers);
