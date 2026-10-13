import { useEffect, useRef } from 'react';

/**
 * A live EventSource that is only connected while the tab is visible.
 *
 * Browsers allow ~6 connections per host over HTTP/1.1, and every EventSource holds one
 * for as long as it is open. With several Kinetic tabs open, background tabs used to use
 * up the pool and new pages hung until a refresh. Hidden tabs now disconnect; when the
 * tab comes back the stream reconnects and `onResume` refetches whatever was missed.
 */
export function useEventStream(url: string | null, onMessage: (data: any) => void, onResume?: () => void) {
  const handlers = useRef({ onMessage, onResume });
  handlers.current = { onMessage, onResume };

  useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let wasHidden = false;
    const open = () => {
      if (es) return;
      es = new EventSource(url);
      es.onmessage = (m) => {
        let data: unknown;
        try { data = JSON.parse(m.data); } catch { return; }
        handlers.current.onMessage(data);
      };
      // EventSource reconnects by itself; refetch to catch anything missed meanwhile.
      es.onerror = () => handlers.current.onResume?.();
    };
    const close = () => { es?.close(); es = null; };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { close(); wasHidden = true; return; }
      open();
      if (wasHidden) { wasHidden = false; handlers.current.onResume?.(); }
    };
    if (document.visibilityState !== 'hidden') open(); else wasHidden = true;
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); close(); };
  }, [url]);
}
