/**
 * Human-like pacing: randomised waits with gaussian jitter, natural scrolling and a
 * rolling hourly cap on actions (shared by every tab through chrome.storage).
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Normal sample via Box–Muller. */
export function gaussian(mean = 0, sd = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A delay inside [min, max], clustered around the middle like a person's rhythm, not uniform. */
export function humanDelay([min, max]: [number, number]): number {
  const mid = (min + max) / 2;
  const v = gaussian(mid, (max - min) / 5);
  return Math.round(Math.min(max, Math.max(min, v)));
}

export async function sleepRandom(range: [number, number], signal?: { aborted: boolean }): Promise<void> {
  const total = humanDelay(range);
  const until = Date.now() + total;
  while (Date.now() < until) {
    if (signal?.aborted) return;
    await sleep(Math.min(1000, until - Date.now()));
  }
}

/** Scrolls the page in uneven steps, with short reading pauses and an occasional scroll back. */
export async function humanScroll(opts: { steps?: number; container?: Element | null } = {}): Promise<void> {
  const steps = opts.steps ?? 3 + Math.floor(Math.random() * 4);
  const el = opts.container ?? document.scrollingElement ?? document.documentElement;
  for (let i = 0; i < steps; i++) {
    const back = Math.random() < 0.12;
    const dy = (back ? -1 : 1) * Math.round(gaussian(window.innerHeight * 0.55, window.innerHeight * 0.15));
    el.scrollBy({ top: dy, behavior: 'smooth' });
    await sleep(humanDelay([350, 1400]));
  }
}

/** Scroll to the bottom of a container (lazy lists), human style. */
export async function scrollToEnd(container?: Element | null): Promise<void> {
  const el = container ?? document.scrollingElement ?? document.documentElement;
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  await sleep(humanDelay([900, 2200]));
}

const HOUR = 3_600_000;

/** Actions done in the last hour (all tabs). */
export async function actionsLastHour(now = Date.now()): Promise<number[]> {
  const { actionLog = [] } = await chrome.storage.local.get('actionLog');
  return (actionLog as number[]).filter((t) => now - t < HOUR);
}

/**
 * Waits until one more action fits under `maxPerHour`, then records it. Calls `keepAlive`
 * every minute while waiting so the server lease doesn't expire.
 */
export async function takeActionSlot(maxPerHour: number, keepAlive?: (waitMs: number) => Promise<void>): Promise<void> {
  for (;;) {
    const now = Date.now();
    const recent = await actionsLastHour(now);
    if (recent.length < Math.max(1, maxPerHour)) {
      await chrome.storage.local.set({ actionLog: [...recent, now] });
      return;
    }
    const waitMs = recent[0]! + HOUR - now + humanDelay([5_000, 30_000]);
    await keepAlive?.(waitMs);
    await sleep(Math.min(60_000, waitMs));
  }
}
