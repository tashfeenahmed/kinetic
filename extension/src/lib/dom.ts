/** DOM helpers for fallbacks: waiting for elements, clicking and typing like a person. */
import { humanDelay, sleep } from './pacing.ts';

export function cookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!).replace(/^"|"$/g, '') : null;
}

export async function waitFor<T extends Element = Element>(selector: string | (() => T | null), timeoutMs = 10_000, root: ParentNode = document): Promise<T | null> {
  const find = () => (typeof selector === 'string' ? root.querySelector<T>(selector) : selector());
  const until = Date.now() + timeoutMs;
  for (;;) {
    const el = find();
    if (el) return el;
    if (Date.now() > until) return null;
    await sleep(250);
  }
}

/** A visible button/link whose text or aria-label matches. */
export function findButton(pattern: RegExp, root: ParentNode = document): HTMLElement | null {
  const els = root.querySelectorAll<HTMLElement>('button, a[role="button"], div[role="button"], span[role="button"], a');
  for (const el of els) {
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`.trim();
    if (pattern.test(label) && el.offsetParent !== null) return el;
  }
  return null;
}

export async function humanClick(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(humanDelay([300, 900]));
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width * (0.3 + Math.random() * 0.4), clientY: r.top + r.height * (0.3 + Math.random() * 0.4) };
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  await sleep(humanDelay([60, 220]));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  await sleep(humanDelay([400, 1100]));
}

/** Types into an input/textarea/contenteditable, one character at a time. */
export async function humanType(el: HTMLElement, text: string): Promise<void> {
  el.focus();
  const editable = el.isContentEditable;
  for (const ch of text) {
    if (editable) document.execCommand('insertText', false, ch);
    else {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter ? setter.call(input, input.value + ch) : (input.value += ch);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(humanDelay([25, 140]));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export const pageHtml = () => document.documentElement.outerHTML;
