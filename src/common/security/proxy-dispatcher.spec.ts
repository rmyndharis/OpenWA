import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { Dispatcher1Wrapper, fetch as undiciFetch } from 'undici';
import { createProxyDispatcher, hasUnauthenticatableSocks4Credentials, urlFetchProxy } from './proxy-dispatcher';
import { startSocks4Proxy, startSocks5Proxy, type SocksProxyServer } from '../../../test/helpers/socks-proxy-servers';

/**
 * The session proxy carries every fetch the gateway makes for a session: Baileys' media downloads
 * and version lookup through global fetch, and a caller-supplied URL through undici's own. Both are
 * exercised here against REAL proxies, so a dispatcher that merely looks right fails.
 *
 * An https destination is judged by what reaches the tunnelled socket rather than by a completed
 * handshake: the repository ships no certificate to serve, and the claim that matters is that the
 * TLS ClientHello travels through the proxy rather than around it.
 */

const listen = async <T extends net.Server>(server: T): Promise<T> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const portOf = (server: net.Server): number => (server.address() as AddressInfo).port;
const close = (server: net.Server): Promise<void> => new Promise(resolve => server.close(() => resolve()));

describe('createProxyDispatcher', () => {
  it('returns a dispatcher for every scheme the session proxy validator accepts', () => {
    for (const url of [
      'http://u:p@proxy.example:8080',
      'https://proxy.example:443',
      'socks4://proxy.example:1080',
      'socks5://proxy.example:1080',
    ]) {
      expect(createProxyDispatcher(url)).toBeInstanceOf(Dispatcher1Wrapper);
    }
  });

  it('throws on an unsupported scheme instead of answering "go direct"', () => {
    expect(() => createProxyDispatcher('ftp://proxy.example:21')).toThrow(/unsupported proxy/i);
  });

  it('routes a global fetch through an http proxy', async () => {
    const seen: string[] = [];
    const proxy = await listen(
      http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.end('via proxy');
      }),
    );
    const dispatcher = createProxyDispatcher(`http://127.0.0.1:${portOf(proxy)}`);
    try {
      const response = await fetch('http://media.example.invalid/file', { dispatcher } as RequestInit);
      expect(await response.text()).toBe('via proxy');
      expect(seen).toEqual(['GET http://media.example.invalid/file']);
    } finally {
      await dispatcher.destroy();
      proxy.closeAllConnections();
      await close(proxy);
    }
  });
});

describe('createProxyDispatcher over real SOCKS proxies', () => {
  let origin: http.Server;
  let proxy: SocksProxyServer | undefined;

  beforeAll(async () => {
    origin = await listen(http.createServer((req, res) => res.end(`origin saw ${req.url}`)));
  });
  afterAll(async () => {
    origin.closeAllConnections();
    await close(origin);
  });
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  // The proxies relay to the local origin whatever destination is asked for, so a request that went
  // around the proxy would reach nothing and fail rather than pass quietly.
  const originAnswers = async (
    proxyUrl: string,
    destination: string,
    ...pinnedAddresses: string[]
  ): Promise<string> => {
    const dispatcher = createProxyDispatcher(proxyUrl, { pinnedAddresses });
    try {
      return await (await undiciFetch(destination, { dispatcher })).text();
    } finally {
      await dispatcher.destroy();
    }
  };

  it.each(['socks4', 'socks5'] as const)('fetches an http destination through a %s proxy', async scheme => {
    const start = scheme === 'socks4' ? startSocks4Proxy : startSocks5Proxy;
    proxy = await start({ relayTo: portOf(origin) });

    expect(await originAnswers(proxy.url, 'http://203.0.113.7/file')).toBe('origin saw /file');
    expect(proxy.destinations).toHaveLength(1);
  });

  it.each(['socks4', 'socks5'] as const)('tunnels an https destination through a %s proxy', async scheme => {
    const start = scheme === 'socks4' ? startSocks4Proxy : startSocks5Proxy;
    // Relayed to a listener that speaks no TLS and hangs up on the ClientHello: completing a
    // handshake is not the claim, and the repository ships no certificate to serve one with.
    const tcpOnly = await listen(net.createServer(socket => socket.once('data', () => socket.destroy())));
    proxy = await start({ relayTo: portOf(tcpOnly) });
    try {
      await expect(originAnswers(proxy.url, 'https://203.0.113.7/file', '203.0.113.7')).rejects.toThrow();
      expect(proxy.destinations).toEqual(['203.0.113.7:443']);
      expect(proxy.firstBytes).toEqual(['160301']); // TLS 1.x ClientHello record header
    } finally {
      tcpOnly.close();
    }
  });

  // SOCKS4 has no hostname form, so the destination is resolved here before the request goes out;
  // SOCKS5 keeps the name, letting the proxy's own resolver decide.
  it('resolves the destination locally for socks4 and keeps the hostname for socks5', async () => {
    proxy = await startSocks4Proxy({ relayTo: portOf(origin) });
    await originAnswers(proxy.url, `http://localhost:${portOf(origin)}/four`);
    // The resolved address itself, not merely its shape: the SOCKS4a form a strict proxy rejects
    // also puts four IP octets on the wire (0.0.0.x, with the name trailing), so asserting "is an
    // IPv4 address" would hold even if the hostname had been handed over.
    expect(proxy.destinations).toEqual([`127.0.0.1:${portOf(origin)}`]);
    await proxy.close();

    proxy = await startSocks5Proxy({ relayTo: portOf(origin) });
    await originAnswers(proxy.url, `http://localhost:${portOf(origin)}/five`);
    expect(proxy.destinations).toEqual([`localhost:${portOf(origin)}`]);
  });

  it('refuses an IPv6 destination on socks4, which cannot carry one', async () => {
    proxy = await startSocks4Proxy({ relayTo: portOf(origin) });
    await expect(originAnswers(proxy.url, `http://[::1]:${portOf(origin)}/x`)).rejects.toThrow();
    expect(proxy.destinations).toEqual([]);
  });

  // The SSRF guard resolves and vets the destination itself; passing that address on keeps the
  // connection tied to what was checked instead of letting a second resolution choose.
  it.each(['socks4', 'socks5'] as const)('sends the vetted address as the %s destination', async scheme => {
    const start = scheme === 'socks4' ? startSocks4Proxy : startSocks5Proxy;
    proxy = await start({ relayTo: portOf(origin) });

    // The URL names one address and the guard vetted another, so only the vetted one may be dialled.
    await originAnswers(proxy.url, 'http://203.0.113.8/file', '203.0.113.7');

    expect(proxy.destinations).toEqual(['203.0.113.7:80']);
  });

  // A vetted list is family-mixed in resolver order, and a dual-stack host commonly resolves AAAA
  // first. Taking only its head left socks4 unable to reach any such host at all.
  it('dials the IPv4 entry of a vetted dual-stack list on socks4', async () => {
    proxy = await startSocks4Proxy({ relayTo: portOf(origin) });

    expect(
      await originAnswers(proxy.url, 'http://cdn.example/file', '2606:2800:220:1:248:1893:25c8:1946', '127.0.0.1'),
    ).toBe('origin saw /file');
    expect(proxy.destinations).toEqual(['127.0.0.1:80']);
  });

  // Same list, and a SOCKS5 proxy that has no IPv6 route of its own: the next vetted address is
  // tried, which is the failover the direct path gets from happy-eyeballs.
  it('falls back to the next vetted address when the proxy cannot reach the first', async () => {
    proxy = await startSocks5Proxy({ relayTo: portOf(origin), ipv4Only: true });

    expect(
      await originAnswers(proxy.url, 'http://cdn.example/file', '2606:2800:220:1:248:1893:25c8:1946', '127.0.0.1'),
    ).toBe('origin saw /file');
    expect(proxy.destinations).toEqual(['2606:2800:220:1:248:1893:25c8:1946:80', '127.0.0.1:80']);
  });

  it('authenticates a socks5 proxy with the decoded credentials', async () => {
    // URL credentials stay percent-encoded until they are decoded for the handshake.
    proxy = await startSocks5Proxy({ relayTo: portOf(origin), credentials: { username: 'us@er', password: 'p@ss:1' } });

    expect(await originAnswers(proxy.url, 'http://203.0.113.7/file')).toBe('origin saw /file');
    expect(proxy.credentials).toEqual(['us@er:p@ss:1']);
  });

  // SOCKS4 authenticates nobody: the user name travels as the connect request's user id and the
  // password is dropped, so the caller is warned rather than left with an opaque refusal.
  it('sends socks4 credentials as the user id, and reports them as unauthenticatable', async () => {
    proxy = await startSocks4Proxy({ relayTo: portOf(origin) });
    const credentialed = proxy.url.replace('socks4://', 'socks4://us%40er:p%40ss@');

    await originAnswers(credentialed, 'http://203.0.113.7/file');

    expect(proxy.credentials).toEqual(['us@er']);
    expect(hasUnauthenticatableSocks4Credentials(credentialed)).toBe(true);
    expect(hasUnauthenticatableSocks4Credentials(proxy.url)).toBe(false);
    expect(hasUnauthenticatableSocks4Credentials('socks5://us:pw@proxy.example:1080')).toBe(false);
  });
});

describe('urlFetchProxy', () => {
  afterEach(() => delete process.env.SESSION_PROXY_URL_FETCH);

  it('routes a caller-supplied URL through the session proxy by default', () => {
    expect(urlFetchProxy('socks5://proxy.example:1080')).toBe('socks5://proxy.example:1080');
    process.env.SESSION_PROXY_URL_FETCH = 'true';
    expect(urlFetchProxy('socks5://proxy.example:1080')).toBe('socks5://proxy.example:1080');
  });

  it('fetches direct when the operator switches it off', () => {
    process.env.SESSION_PROXY_URL_FETCH = 'false';
    expect(urlFetchProxy('socks5://proxy.example:1080')).toBeUndefined();
  });

  it('leaves an unproxied session alone either way', () => {
    expect(urlFetchProxy(undefined)).toBeUndefined();
    process.env.SESSION_PROXY_URL_FETCH = 'false';
    expect(urlFetchProxy(undefined)).toBeUndefined();
  });
});
