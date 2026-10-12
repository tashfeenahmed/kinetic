/**
 * X / Twitter content script. X's GraphQL query ids rotate, so instead of calling them we open
 * the right page (the worker navigates), scroll like a person and parse the GraphQL responses
 * the page loads itself (captured by capture.ts).
 */
import type { Rec } from '../../../server/src/companion/protocol.ts';
import { parse } from '../../../server/src/companion/parsers/index.ts';
import { waitFor } from '../lib/dom.ts';
import { humanDelay, sleep } from '../lib/pacing.ts';
import { drainCaptured, registerSite, scrollCollect, type Handler, type TaskCtx } from '../lib/runner.ts';
import { checkPage } from '../lib/safety.ts';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const targetUrl = (ctx: TaskCtx) => str(ctx.task.target.url) || str(ctx.task.target.profileUrl);
const dialog = () => document.querySelector('[role="dialog"] [data-testid="primaryColumn"], [aria-labelledby="modal-header"]');

async function settle() {
  await waitFor('[data-testid="primaryColumn"], main', 15_000);
  await sleep(humanDelay([1500, 3000]));
  checkPage('x');
}

const users = (op: RegExp, extra?: (r: Rec, ctx: TaskCtx) => Rec): Handler => async (ctx) => {
  await settle();
  await scrollCollect(ctx, {
    match: op,
    parse: (c) => parse('x.users', c.data, { sourceProfile: targetUrl(ctx), postUrl: targetUrl(ctx) }).records.map((r) => (extra ? extra(r, ctx) : r)),
    container: dialog,
  });
};

const handlers: Record<string, Handler> = {
  'x.followers_export': users(/\/graphql\/[^/]+\/(Followers|Following|BlueVerifiedFollowers|FollowersYouKnow)\b/, (r, ctx) => ({ ...r, sourceProfile: r.sourceProfile ?? targetUrl(ctx) })),
  'x.tweet_engagers': users(/\/graphql\/[^/]+\/(Retweeters|Favoriters)\b/, (r, ctx) => ({ ...r, tweetUrl: r.tweetUrl ?? targetUrl(ctx) })),

  'x.profile_scraper': async (ctx) => {
    await settle();
    let recs: Rec[] = [];
    for (let i = 0; i < 10 && !recs.length; i++) {
      for (const c of drainCaptured(/\/graphql\/[^/]+\/(UserByScreenName|UserByRestId)\b/)) recs.push(...parse('x.profile', c.data).records);
      if (!recs.length) await sleep(800);
    }
    if (!recs.length) throw new Error(`Couldn't read the X profile ${targetUrl(ctx)} (it may not exist or the page changed)`);
    await ctx.results(recs.slice(0, 1));
    await ctx.complete({ status: 'done' });
  },

  'x.search_export': async (ctx) => {
    await settle();
    await scrollCollect(ctx, { match: /\/graphql\/[^/]+\/SearchTimeline\b/, parse: (c) => parse('x.tweets', c.data).records, maxIdle: 5 });
  },
};

registerSite('x', handlers);
