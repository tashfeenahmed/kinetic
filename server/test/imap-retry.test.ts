import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db.ts';
import { RealMailGateway, isLoginRejected, isTransientConnectError } from '../src/mail/gateway.ts';
import { isAuthError } from '../src/engine/sequencer.ts';
import { encrypt, setEncryptionKey } from '../src/lib/crypto.ts';

setEncryptionKey(Buffer.alloc(32, 7));

/** A tiny IMAP server that refuses every login the way Outlook does. */
function rejectingImap(): Promise<{ port: number; logins: () => number; close: () => void }> {
  let logins = 0;
  const server = net.createServer((sock) => {
    sock.write('* OK fake IMAP ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(' ');
        if (!cmd) continue;
        const c = cmd.toUpperCase();
        if (c === 'CAPABILITY') sock.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2 AUTH=PLAIN SASL-IR\r\n${tag} OK done\r\n`);
        else if (c === 'AUTHENTICATE' || c === 'LOGIN') { logins++; sock.write(`${tag} NO Login failed.\r\n`); }
        else if (c === 'LOGOUT') { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
        else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, logins: () => logins, close: () => server.close() })));
}

const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach((c) => c()); });

function sender(port: number, extra: Record<string, unknown> = {}) {
  return { id: 1, email: 'sam@north.example', imap_server: '127.0.0.1', imap_port: port, imap_secure: 0, auth_type: 'password', secret_enc: encrypt('pw'), ...extra };
}

describe('IMAP retries', () => {
  it('retries an OAuth login once with a freshly refreshed token, then gives up', async () => {
    const imap = await rejectingImap(); closers.push(imap.close);
    const gw = new RealMailGateway(new Db(':memory:'));
    const forced: boolean[] = [];
    gw.credentials = async (_s: any, force = false) => { forced.push(force); return { user: 'sam@north.example', accessToken: force ? 'fresh' : 'stale' }; };
    const err = await gw.withImap(sender(imap.port, { auth_type: 'oauth' }) as any, async () => 'never').catch((e) => e);
    expect(forced).toEqual([false, true]);
    expect(imap.logins()).toBe(2);
    expect(isLoginRejected(err)).toBe(true);
    expect(isAuthError(err)).toBe(true); // the sync then marks the mailbox Disconnected
  });

  it('does not retry a rejected password login', async () => {
    const imap = await rejectingImap(); closers.push(imap.close);
    const gw = new RealMailGateway(new Db(':memory:'));
    await gw.withImap(sender(imap.port) as any, async () => 'never').catch(() => null);
    expect(imap.logins()).toBe(1);
  });

  it('retries once when the connection fails before login', async () => {
    const free = net.createServer(); await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()));
    const port = (free.address() as net.AddressInfo).port; free.close(); // nothing listens here now
    const gw = new RealMailGateway(new Db(':memory:'));
    gw.retryDelayMs = 0;
    let calls = 0;
    const real = gw.credentials.bind(gw);
    gw.credentials = async (s: any, f?: boolean) => { calls++; return real(s, f); };
    const err = await gw.withImap(sender(port) as any, async () => 'never').catch((e) => e);
    expect(calls).toBe(2);
    expect(isTransientConnectError(err)).toBe(true);
    expect(isAuthError(err)).toBe(false);
  });
});
