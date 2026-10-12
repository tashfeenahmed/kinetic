/**
 * Content-script side of a task: receives TaskPayloads from the service worker, runs the
 * site handler, and relays results/progress/completion back (the worker talks to Kinetic).
 */
import type {
  CompleteBody, ContentMessage, ParseResult, Rec, RenderBody, ResultsBatch, ResultsResponse, SafetyBody, Site, TaskPayload, WorkerMessage,
} from '../../../server/src/companion/protocol.ts';
import { humanScroll, sleepRandom, takeActionSlot } from './pacing.ts';
import { checkPage, SafetyError, StopTask } from './safety.ts';

// ---- captured JSON (from the MAIN-world interceptor, capture.ts) -------------------

interface Captured { url: string; data: unknown; at: number }
const captured: Captured[] = [];
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data as { source?: string; url?: string; data?: unknown } | null;
  if (d?.source !== 'kinetic-capture' || typeof d.url !== 'string') return;
  captured.push({ url: d.url, data: d.data, at: Date.now() });
  if (captured.length > 400) captured.splice(0, captured.length - 400);
});

/** Removes and returns captured responses whose URL matches. */
export function drainCaptured(match: RegExp): Captured[] {
  const out: Captured[] = [];
  for (let i = 0; i < captured.length; ) {
    if (match.test(captured[i]!.url)) out.push(...captured.splice(i, 1));
    else i++;
  }
  return out;
}

/** Captured URLs seen so far (to learn GraphQL query ids the page itself uses). */
export const capturedUrls = () => captured.map((c) => c.url);

// ---- worker messaging -------------------------------------------------------------

async function send<T = any>(msg: WorkerMessage): Promise<T> {
  const r = await chrome.runtime.sendMessage<{ ok: boolean; data?: T; error?: string }>(msg);
  if (!r?.ok) throw new Error(r?.error ?? 'Kinetic Companion worker unavailable');
  return r.data as T;
}

export class TaskCtx {
  readonly task: TaskPayload;
  readonly site: Site;
  aborted = false;
  completed = false;
  /** Records accepted so far in this lease. */
  collected = 0;
  /** Actions performed in this lease. */
  actions = 0;

  constructor(task: TaskPayload, site: Site) {
    this.task = task;
    this.site = site;
  }

  get budget() { return Math.max(0, this.task.budget); }
  get remaining() { return Math.max(0, this.budget - this.collected); }

  /** Posts records; trims to the budget. Returns whether to keep going. */
  async results(records: Rec[], cursor?: unknown): Promise<{ keepGoing: boolean; res: ResultsResponse | null }> {
    const batch = records.slice(0, this.remaining);
    if (!batch.length) return { keepGoing: this.remaining > 0, res: null };
    const body: ResultsBatch = { records: batch };
    if (cursor !== undefined) body.cursor = cursor;
    const res = await send<ResultsResponse>({ type: 'kinetic:results', taskId: this.task.id, batch: body });
    this.collected += batch.length;
    const keepGoing = !res.stop && res.budgetLeft > 0 && this.remaining > 0 && !this.aborted;
    return { keepGoing, res };
  }

  /** Posts the outcome record of an action (sent/skipped/failed). Not trimmed by the record budget. */
  async actionResult(record: Rec): Promise<void> {
    await send<ResultsResponse>({ type: 'kinetic:results', taskId: this.task.id, batch: { records: [record] } });
  }

  /** Sends raw captures for the server to parse (no budget accounting here). */
  async captures(items: { parser: string; data: unknown; url?: string }[]) {
    return send<ResultsResponse>({ type: 'kinetic:results', taskId: this.task.id, batch: { captures: items } });
  }

  async progress(message?: string, done?: number, total?: number, cursor?: unknown): Promise<void> {
    const r = await send<{ ok: boolean; stop?: boolean; reason?: string }>({ type: 'kinetic:progress', taskId: this.task.id, message, done, total, cursor });
    if (r?.stop) throw new StopTask(r.reason ?? 'stopped by Kinetic');
  }

  async render(profile: Rec, template?: string): Promise<string> {
    const body: RenderBody = { profile, template };
    const r = await send<{ text: string }>({ type: 'kinetic:render', taskId: this.task.id, body });
    return r.text ?? '';
  }

  async complete(body: CompleteBody): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    await send({ type: 'kinetic:complete', taskId: this.task.id, body });
  }

  async safety(body: SafetyBody): Promise<void> {
    this.completed = true;
    await send({ type: 'kinetic:safety', taskId: this.task.id, body });
  }

  /** Between page/API requests while scraping. */
  async pageWait() {
    await sleepRandom(this.task.pacing.pageDelayMs, this);
    if (this.aborted) throw new StopTask('aborted');
  }

  /** Between two actions in one task. */
  async actionWait() {
    await sleepRandom(this.task.pacing.actionDelayMs, this);
    if (this.aborted) throw new StopTask('aborted');
  }

  /** Reserves one action under the hourly cap (waits if needed, keeping the lease alive). */
  async actionSlot() {
    if (this.actions >= this.budget) throw new StopTask('action budget used');
    await takeActionSlot(this.task.pacing.maxActionsPerHour, async (ms) => {
      await this.progress(`Hourly cap reached — waiting ${Math.ceil(ms / 60_000)} min`);
    });
    this.actions++;
  }
}

export type Handler = (ctx: TaskCtx) => Promise<void>;

/**
 * Scrapes a paged source until the source ends, the budget is used, or Kinetic says stop.
 * On a budget stop the task completes with `more: true` and the cursor to resume from.
 */
export async function scrapePaged(ctx: TaskCtx, fetchPage: (cursor: unknown) => Promise<ParseResult>, start: unknown = null): Promise<void> {
  let cursor: unknown = ctx.task.cursor ?? start;
  for (let page = 0; ; page++) {
    const r = await fetchPage(cursor);
    const recs = r.records ?? [];
    const truncated = recs.length > ctx.remaining;
    const { keepGoing } = await ctx.results(recs, r.nextCursor ?? cursor);
    await ctx.progress(`${ctx.collected} collected`, ctx.collected, r.total ?? undefined, r.nextCursor ?? cursor).catch((e) => { if (e instanceof StopTask) throw e; });
    const finished = r.nextCursor == null || !recs.length;
    if (finished && !truncated) return ctx.complete({ status: 'done' });
    if (!keepGoing || truncated) {
      // Resume from this page when it was cut short; server-side dedupe drops repeats.
      return ctx.complete({ status: 'done', more: true, cursor: truncated ? cursor : r.nextCursor });
    }
    cursor = r.nextCursor;
    await ctx.pageWait();
  }
}

const keyOf = (r: Rec) => String(r.engagerKey ?? r.profileUrl ?? r.username ?? r.tweetUrl ?? r.postUrl ?? r.id ?? JSON.stringify(r));

/**
 * Infinite-scroll scraping over captured JSON: scroll like a person, parse whatever the page
 * loaded, stop when the budget is used or nothing new appears for a few rounds.
 */
export async function scrollCollect(ctx: TaskCtx, opts: {
  match: RegExp;
  parse: (c: { url: string; data: unknown }) => Rec[];
  fallback?: () => Rec[];
  container?: () => Element | null;
  maxIdle?: number;
  maxRounds?: number;
}): Promise<void> {
  const seen = new Set<string>();
  let idle = 0;
  const maxIdle = opts.maxIdle ?? 4;
  for (let round = 0; round < (opts.maxRounds ?? 400); round++) {
    checkPage(ctx.site);
    let fresh: Rec[] = [];
    for (const c of drainCaptured(opts.match)) {
      for (const r of safeParse(() => opts.parse(c))) {
        const k = keyOf(r);
        if (!seen.has(k)) { seen.add(k); fresh.push(r); }
      }
    }
    if (!fresh.length && opts.fallback) {
      fresh = safeParse(opts.fallback).filter((r) => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    if (fresh.length) {
      idle = 0;
      const { keepGoing } = await ctx.results(fresh);
      await ctx.progress(`${ctx.collected} collected`, ctx.collected);
      if (!keepGoing) return ctx.complete({ status: 'done' });
    } else if (++idle >= maxIdle) {
      return ctx.complete({ status: 'done' });
    }
    await humanScroll({ container: opts.container?.() ?? null });
    await ctx.pageWait();
  }
  return ctx.complete({ status: 'done' });
}

function safeParse(fn: () => Rec[]): Rec[] {
  try { return fn() ?? []; } catch { return []; }
}

/** Registers the content script for a site: one task at a time, errors reported back. */
export function registerSite(site: Site, handlers: Record<string, Handler>) {
  let running: TaskCtx | null = null;
  chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
    if (msg.type === 'kinetic:ping') { sendResponse({ ok: true, site, busy: !!running, url: location.href }); return; }
    if (msg.type === 'kinetic:abort') { if (running && running.task.id === msg.taskId) running.aborted = true; sendResponse({ ok: true }); return; }
    if (msg.type !== 'kinetic:run') return;
    if (running) { sendResponse({ accepted: false, reason: 'busy' }); return; }
    const handler = handlers[msg.task.kind];
    if (!handler) { sendResponse({ accepted: false, reason: `unsupported task kind ${msg.task.kind}` }); return; }
    const ctx = new TaskCtx(msg.task, site);
    running = ctx;
    sendResponse({ accepted: true });
    void runTask(ctx, handler).finally(() => { running = null; });
  });
}

async function runTask(ctx: TaskCtx, handler: Handler) {
  try {
    checkPage(ctx.site);
    await handler(ctx);
    if (!ctx.completed) await ctx.complete({ status: 'done', actions: ctx.actions || undefined });
  } catch (e) {
    try {
      if (e instanceof SafetyError) {
        await ctx.safety({ kind: e.kind, message: e.message, url: e.url ?? location.href });
      } else if (e instanceof StopTask) {
        if (!ctx.completed) await ctx.complete({ status: 'done', actions: ctx.actions || undefined });
      } else if (!ctx.completed) {
        await ctx.complete({ status: 'failed', error: (e as Error)?.message ?? String(e), actions: ctx.actions || undefined });
      }
    } catch { /* worker gone; the server lease expires and re-queues */ }
  }
}
