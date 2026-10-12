/**
 * Runs in the page's MAIN world at document_start. Wraps fetch and XHR and forwards JSON
 * responses from the site's own API calls (GraphQL, Voyager, Instagram web API) to the
 * isolated content script with window.postMessage. Read-only: requests are never changed.
 */
(() => {
  const w = window as unknown as { __kineticCapture?: boolean };
  if (w.__kineticCapture) return;
  w.__kineticCapture = true;

  const INTERESTING = /\/graphql|\/api\/graphql|\/voyager\/api\/|\/sales-api\/|\/api\/v1\/|\/i\/api\//;
  const MAX = 3_000_000;

  const post = (url: string, text: string) => {
    if (!text || text.length > MAX) return;
    const t = text.trimStart();
    if (t[0] !== '{' && t[0] !== '[' && !t.startsWith('for (;;);')) return;
    try {
      const data = JSON.parse(t.startsWith('for (;;);') ? t.slice(9) : t);
      window.postMessage({ source: 'kinetic-capture', url, data }, location.origin);
    } catch {
      // Facebook streams several JSON documents separated by newlines.
      const parts = t.split('\n').filter((l) => l.startsWith('{'));
      for (const p of parts) {
        try { window.postMessage({ source: 'kinetic-capture', url, data: JSON.parse(p) }, location.origin); } catch { /* not JSON */ }
      }
    }
  };

  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this as typeof window, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
      if (INTERESTING.test(url)) res.clone().text().then((t) => post(url, t)).catch(() => {});
    } catch { /* never break the page */ }
    return res;
  } as typeof fetch;

  const open = XMLHttpRequest.prototype.open;
  const sendX = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __k?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__k = String(url);
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __k?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__k ?? '';
    if (INTERESTING.test(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') post(new URL(url, location.href).href, this.responseText);
          else if (this.responseType === 'json' && this.response) window.postMessage({ source: 'kinetic-capture', url, data: this.response }, location.origin);
        } catch { /* ignore */ }
      });
    }
    return sendX.call(this, body);
  };
})();
