import { isIP, type Socket } from 'net';
import { lookup } from 'dns/promises';
import { SocksClient, type SocksProxy } from 'socks';
import { Agent, Dispatcher1Wrapper, ProxyAgent, buildConnector, type Dispatcher } from 'undici';

/** Ports assumed when the destination URL names none, per scheme. */
const DEFAULT_DESTINATION_PORTS: Record<string, number> = { 'https:': 443, 'http:': 80 };

/** Conventional SOCKS port (RFC 1928 section 3), used when the proxy URL names none. */
const DEFAULT_SOCKS_PORT = 1080;

export interface ProxyDispatcherOptions {
  /**
   * The destination addresses the SSRF guard already resolved and vetted, in resolver order.
   * Honoured by the SOCKS schemes, which carry the destination themselves, so the address that was
   * checked is the one connected to and a DNS rebind cannot swap it. The whole list is kept, and
   * dialled in order, because it is family-mixed: a dual-stack host commonly resolves AAAA first,
   * and neither a SOCKS4 proxy (which has no IPv6 form) nor an IPv4-only SOCKS5 proxy can reach
   * that first entry, while the direct path just falls through to the next address. An HTTP/HTTPS
   * proxy is asked for the destination by NAME in the CONNECT line and resolves it itself, so there
   * the value is ignored: pinning through such a proxy is not expressible in the protocol.
   */
  pinnedAddresses?: string[];
}

/**
 * The destination addresses to put on the wire for a SOCKS request, in the order they are tried.
 *
 * SOCKS5 keeps the HOSTNAME when nothing was vetted: the proxy resolves it, which is usually the
 * point of routing through one (the destination is resolved, and reachable, from the proxy's network
 * rather than ours). SOCKS4 has no hostname form at all (the SOCKS4a extension invented one, and a
 * strict SOCKS4 proxy rejects it), so a name is resolved here, to IPv4, the only family the protocol
 * can carry, and a vetted list is narrowed to its IPv4 entries. Note this differs from
 * `socks-proxy-agent`, which the session's WebSocket agent uses: it resolves locally for `socks5://`
 * too, keeping the name only for `socks5h://`, a spelling this gateway's proxy validator does not
 * accept.
 */
async function socksDestinations(type: 4 | 5, hostname: string, pinnedAddresses?: string[]): Promise<string[]> {
  const hosts = pinnedAddresses?.length ? pinnedAddresses : [hostname.replace(/^\[|\]$/g, '')]; // strip IPv6 brackets
  if (type === 5) {
    return hosts;
  }
  const ipv4 = hosts.filter(host => isIP(host) === 4);
  if (ipv4.length > 0) {
    return ipv4;
  }
  // Every vetted entry is an IP literal, so no IPv4 among them means they are all IPv6.
  if (isIP(hosts[0]) === 6) {
    throw new Error(`A SOCKS4 proxy cannot reach the IPv6 destination ${hosts.join(', ')}`);
  }
  return [(await lookup(hosts[0], { family: 4 })).address];
}

/**
 * Open a tunnel to the first destination the proxy can reach.
 *
 * The vetted addresses are family-mixed in resolver order, so a proxy with no route to the first
 * family would otherwise sink a request the direct path completes by trying the next address.
 */
async function connectThroughSocks(proxy: SocksProxy, hosts: string[], port: number): Promise<Socket> {
  let lastError = new Error('No destination address to reach through the SOCKS proxy');
  for (const host of hosts) {
    try {
      const { socket } = await SocksClient.createConnection({ proxy, command: 'connect', destination: { host, port } });
      return socket;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError;
}

/**
 * undici connector that opens each connection through a SOCKS4 or SOCKS5 proxy.
 *
 * undici has no SOCKS4 transport and ships SOCKS5 as an experimental agent that hands the proxy the
 * URL's still-percent-encoded credentials; one connector over the `socks` package covers both
 * schemes and authenticates SOCKS5 with the decoded pair. For an https destination the tunnelled
 * socket is handed to undici's own connector for the TLS upgrade: the request options pass through
 * untouched, so SNI and certificate validation still use the destination hostname, not the proxy's.
 */
function socksConnector(proxyUrl: URL, pinnedAddresses?: string[]): buildConnector.connector {
  const type = proxyUrl.protocol === 'socks4:' ? 4 : 5;
  // SOCKS4 has no authentication: `socks` sends the user id in the connect request and drops the
  // password. Credentials are decoded here because URL keeps them percent-encoded.
  const proxy: SocksProxy = {
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port) || DEFAULT_SOCKS_PORT,
    type,
    userId: decodeURIComponent(proxyUrl.username) || undefined,
    password: decodeURIComponent(proxyUrl.password) || undefined,
  };
  const upgradeTls = buildConnector({});

  return (options, callback) => {
    // undici's connect callback is a plain callback, not a promise resolver, and it is answered from
    // inside open(): a throw raised after that (by the callback itself, or by the TLS upgrade) would
    // otherwise answer it a second time, with an error, on an already-connected client.
    let answered = false;
    const answer: typeof callback = (...args: Parameters<typeof callback>) => {
      if (answered) return;
      answered = true;
      callback(...args);
    };
    const open = async (): Promise<void> => {
      const socket = await connectThroughSocks(
        proxy,
        await socksDestinations(type, options.hostname, pinnedAddresses),
        Number(options.port) || DEFAULT_DESTINATION_PORTS[options.protocol] || 80,
      );
      if (options.protocol === 'https:') {
        upgradeTls({ ...options, httpSocket: socket }, answer);
        return;
      }
      answer(null, socket.setNoDelay());
    };
    open().catch((error: Error) => answer(error, null));
  };
}

/**
 * Build a fetch dispatcher that sends every request through a session's egress proxy.
 *
 * Covers all four schemes the session proxy validator accepts. The returned dispatcher is usable by
 * both undici's own `fetch` and the global one: `Dispatcher1Wrapper` adapts the installed undici to
 * the handler API of the older undici bundled in Node, and passes a modern handler straight through.
 *
 * Throws on any other scheme rather than returning a value a caller could read as "go direct": a
 * proxied session must fail loudly instead of leaving the gateway's own address on the wire.
 */
export function createProxyDispatcher(proxyUrl: string, options: ProxyDispatcherOptions = {}): Dispatcher {
  const url = new URL(proxyUrl);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return new Dispatcher1Wrapper(new ProxyAgent(proxyUrl));
  }
  if (url.protocol === 'socks4:' || url.protocol === 'socks5:') {
    return new Dispatcher1Wrapper(new Agent({ connect: socksConnector(url, options.pinnedAddresses) }));
  }
  throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
}

/**
 * The proxy a server-side fetch of a CALLER-SUPPLIED URL must leave through, given the proxy of the
 * session the request names.
 *
 * Such a fetch belongs to the request rather than to the session, so it used to leave from the
 * gateway's own address even for a proxied session (#1626): the destination saw a different IP than
 * every other byte that session sends. Routing it through the session proxy is the default.
 * `SESSION_PROXY_URL_FETCH=false` restores the direct fetch, for a deployment whose proxy is a
 * WhatsApp-only route that cannot reach arbitrary media hosts.
 */
export function urlFetchProxy(sessionProxyUrl: string | undefined): string | undefined {
  return process.env.SESSION_PROXY_URL_FETCH === 'false' ? undefined : sessionProxyUrl;
}

/**
 * Whether a proxy URL carries credentials its scheme cannot authenticate: SOCKS4 has no
 * authentication step, so `socks4://user:pass@host` sends the user name as the connect request's
 * user id and drops the password entirely. Surfaced by the caller as a warning, the way the
 * whatsapp-web.js engine already reports SOCKS credentials Chromium cannot use (#628), so a proxy
 * that answers "request rejected" is not diagnosed as an unreachable host.
 */
export function hasUnauthenticatableSocks4Credentials(proxyUrl: string): boolean {
  const url = new URL(proxyUrl);
  return url.protocol === 'socks4:' && (url.username !== '' || url.password !== '');
}
