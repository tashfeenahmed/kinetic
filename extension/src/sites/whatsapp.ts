/**
 * WhatsApp Web content script. The worker opens web.whatsapp.com/send?phone=…&text=… (the
 * message pre-rendered by Kinetic); here we wait for the chat to load, read it like a person
 * for a moment, then press send. "Phone number shared via url is invalid" → not_on_whatsapp.
 */
import type { Rec } from '../../../server/src/companion/protocol.ts';
import { findButton, humanClick, humanType, waitFor } from '../lib/dom.ts';
import { humanDelay, sleep } from '../lib/pacing.ts';
import { registerSite, type Handler, type TaskCtx } from '../lib/runner.ts';
import { SafetyError } from '../lib/safety.ts';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const nowIso = () => new Date().toISOString();

const composer = () => document.querySelector<HTMLElement>('footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]');
const sendButton = () =>
  document.querySelector<HTMLElement>('footer button[aria-label="Send"], footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"]')?.closest<HTMLElement>('button, [role="button"]')
  ?? findButton(/^Send$/i, document.querySelector('footer') ?? document);
const invalidNumber = () => /phone number shared via url is invalid/i.test(document.querySelector('[data-animate-modal-popup], [role="dialog"]')?.textContent ?? '');
const loggedOut = () => !!document.querySelector('canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], div[data-ref] canvas')
  || /log into whatsapp web|use whatsapp on your computer|steps to log in/i.test(document.body?.innerText?.slice(0, 3000) ?? '');

type Loaded = 'chat' | 'invalid';

/** Waits until the chat (composer) or the invalid-number popup shows; throws when logged out. */
async function chatLoaded(timeoutMs = 60_000): Promise<Loaded> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (invalidNumber()) return 'invalid';
    if (composer()) return 'chat';
    // The QR code shows briefly while the app boots; only trust it once the app has had time.
    if (Date.now() > until - timeoutMs + 15_000 && loggedOut()) throw new SafetyError('logged_out', 'WhatsApp Web is not linked in this browser: open web.whatsapp.com and scan the QR code with your phone.', location.href);
    await sleep(500);
  }
  throw new Error('WhatsApp Web did not open the chat in time');
}

async function record(ctx: TaskCtx, rec: Rec) {
  await ctx.actionResult({ at: nowIso(), phone: str(ctx.task.target.phone), name: str(ctx.task.target.name) || undefined, ...rec }).catch(() => {});
}

const sendMessage: Handler = async (ctx) => {
  const text = str(ctx.task.params.text);
  if (!text) throw new Error('Empty message');
  if ((await chatLoaded()) === 'invalid') {
    await record(ctx, { status: 'skipped', detail: 'not_on_whatsapp' });
    const ok = findButton(/^OK$/i);
    if (ok) await humanClick(ok);
    return ctx.complete({ status: 'skipped', error: 'not_on_whatsapp', result: { reason: 'not_on_whatsapp' }, actions: 0 });
  }
  // Glance at the chat like a person before sending.
  await sleep(humanDelay([2500, 6000]));
  await ctx.actionSlot();
  const box = composer();
  if (box && !(box.textContent ?? '').trim()) await humanType(box, text); // the ?text= prefill didn't take
  const send = await waitFor(sendButton, 10_000);
  if (!send) throw new Error('Send button not found');
  await humanClick(send);
  // Sent once the composer is empty again.
  await waitFor(() => (composer()?.textContent ?? '').trim() ? null : document.body, 15_000);
  await sleep(humanDelay([1500, 3000]));
  await record(ctx, { status: 'sent', sentText: text });
  await ctx.complete({ status: 'done', result: { sentText: text }, actions: 1 });
};

registerSite('whatsapp', { 'whatsapp.message_sender': sendMessage });
