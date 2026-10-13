import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { isPrivateHost, request, setHttpFetch, setProxySource } from '../src/gtm/lib/http.ts';

let proxy: Server | null = null;
let origin: Server | null = null;
afterEach(() => { setProxySource(() => undefined); setHttpFetch((...a) => globalThis.fetch(...a)); proxy?.close(); proxy = null; origin?.close(); origin = null; });

describe('lookup proxy', () => {
  it('sends public lookups through SCRAPE_PROXY and keeps local addresses direct', async () => {
    // A fake origin, and a proxy that tunnels every CONNECT to it (like WARP would to the real site).
    const seen: string[] = [];
    origin = createServer((req, res) => res.end('via proxy'));
    await new Promise<void>((r) => origin!.listen(0, '127.0.0.1', r));
    const originPort = (origin.address() as AddressInfo).port;
    proxy = createServer();
    proxy.on('connect', (req, socket, head) => {
      seen.push(req.url ?? '');
      const up = connect(originPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up); });
      up.on('error', () => socket.destroy());
    });
    await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r));
    const port = (proxy.address() as AddressInfo).port;
    setProxySource(() => `http://127.0.0.1:${port}`);
    const direct: string[] = [];
    setHttpFetch((async (u: any) => { direct.push(String(u)); return new Response('direct'); }) as any);

    expect(await (await request('http://example.test/page')).text()).toBe('via proxy');
    expect(seen).toEqual(['example.test:80']); // tunnelled through the proxy
    expect(await (await request('http://127.0.0.1:8888/search?q=x')).text()).toBe('direct');
    expect(direct).toEqual(['http://127.0.0.1:8888/search?q=x']);

    expect(await (await request('http://example.test/page', { direct: true })).text()).toBe('direct');

    // A proxy that can't be reached falls back to a direct request.
    setProxySource(() => 'http://127.0.0.1:1');
    expect(await (await request('http://example.test/other')).text()).toBe('direct');

    setProxySource(() => undefined);
    expect(await (await request('http://example.test/page')).text()).toBe('direct');
  });

  it('knows private hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.1.50', '10.0.0.2', '172.20.1.1', '[::1]', 'printer.local']) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h), h).toBe(false);
  });
});
