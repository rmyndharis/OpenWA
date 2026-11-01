/**
 * Unit-test stub for `socks-proxy-agent` (ESM-only since v9). ts-jest runs in CommonJS mode, so any
 * source file that imports it — directly (baileys-lifecycle) or transitively (anything that pulls in
 * the engine adapters) — fails to load without this stub once the package lands in the unit test
 * graph. Jest applies this stub in the e2e lane too (test/ is that config's rootDir, so test/__mocks__
 * stubs node modules there automatically), and no e2e suite calls jest.unmock('socks-proxy-agent'),
 * so neither jest lane runs the real module; `npm run test:engine-real` does, from the compiled build,
 * through a real SOCKS5 handshake. No jest suite opens a connection through this module (the specs that
 * open real SOCKS connections go through the `socks` package in proxy-dispatcher), so a class that
 * records the proxy URL and satisfies the `Agent` return type of createProxyAgent is sufficient, and
 * because the spec's `instanceof` checks import the same mapped module, they run against this very
 * class. `proxy` mirrors the library's parsed object (parseSocksURL: `host` is URL.hostname, brackets
 * included for an IPv6 literal).
 */
import { Agent } from 'node:https';

export class SocksProxyAgent extends Agent {
  readonly proxy: { host?: string; port: number; type: 4 | 5 };
  readonly proxyUrl: string;

  constructor(proxy: string | URL) {
    super();
    const url = typeof proxy === 'string' ? new URL(proxy) : proxy;
    this.proxy = { host: url.hostname, port: Number(url.port) || 1080, type: url.protocol === 'socks4:' ? 4 : 5 };
    this.proxyUrl = url.href;
  }
}
