import * as net from 'net';
import type { AddressInfo } from 'net';

/**
 * Minimal, real SOCKS4 and SOCKS5 servers for the specs that exercise the session-proxy fetch path.
 *
 * They speak enough of RFC 1928 / RFC 1929 (and the SOCKS4 connect request) for a client to complete
 * a real handshake, record what the client asked for, and then relay the tunnel to ONE fixed local
 * port whatever destination was named. That last part is what makes a proxied fetch observable: a
 * spec can aim a request at a public-looking address and still have a local origin answer it, so a
 * request that leaked around the proxy fails instead of quietly reaching nothing.
 */
export interface SocksProxyServer {
  /** Proxy URL to hand to the code under test, credentials included when asked for. */
  url: string;
  /** `host:port` of every connect request received, in order. */
  destinations: string[];
  /** `user:pass` of every SOCKS5 username/password authentication, in order. */
  credentials: string[];
  /** First bytes each tunnelled connection carried, hex-encoded (a TLS ClientHello starts 160301). */
  firstBytes: string[];
  close(): Promise<void>;
}

/** What a running proxy recorded, shared by reference with the object the spec holds. */
type Recorded = Pick<SocksProxyServer, 'destinations' | 'credentials' | 'firstBytes'>;

interface Options {
  /** Local port every tunnel is relayed to, whatever destination the client named. */
  relayTo?: number;
  /** SOCKS5 only: demand username/password authentication (RFC 1929). */
  credentials?: { username: string; password: string };
  /**
   * SOCKS5 only: answer "host unreachable" for an IPv6 destination, the way a proxy with no IPv6
   * route of its own does. The destination is still recorded, so a spec can see what was attempted.
   */
  ipv4Only?: boolean;
}

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

/**
 * Read exactly `size` bytes. Pull-based (`readable` + `read(size)`) rather than a 'data' listener:
 * a handshake field can arrive in the same packet as the next one, and the stream's own buffer keeps
 * the remainder for the next call. Flowing mode would hand over whole packets and lose the tail.
 */
function read(socket: net.Socket, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void): void => {
      socket.off('readable', attempt);
      socket.off('error', onError);
      socket.off('end', onEnd);
      finish();
    };
    const attempt = (): void => {
      const chunk = socket.read(size) as Buffer | null;
      if (chunk) settle(() => resolve(chunk));
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onEnd = (): void => settle(() => reject(new Error('socks client closed mid-handshake')));
    socket.on('readable', attempt);
    socket.once('error', onError);
    socket.once('end', onEnd);
    attempt();
  });
}

/** Read a length-prefixed byte string (one length octet, then that many bytes). */
async function readLengthPrefixed(socket: net.Socket): Promise<string> {
  const [length] = await read(socket, 1);
  return length === 0 ? '' : (await read(socket, length)).toString();
}

/** Read a NUL-terminated string one byte at a time (the SOCKS4 user id). */
async function readNulTerminated(socket: net.Socket): Promise<string> {
  const bytes: number[] = [];
  for (;;) {
    const [byte] = await read(socket, 1);
    if (byte === 0) return Buffer.from(bytes).toString();
    bytes.push(byte);
  }
}

function relay(socket: net.Socket, state: Recorded, relayTo?: number): void {
  if (relayTo === undefined) {
    socket.end();
    return;
  }
  const upstream = net.connect(relayTo, '127.0.0.1', () => {
    let first = true;
    socket.on('data', chunk => {
      if (!first) return;
      first = false;
      state.firstBytes.push(chunk.subarray(0, 3).toString('hex'));
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
}

function serve(handshake: (socket: net.Socket, state: Recorded) => Promise<void>): {
  server: net.Server;
  state: Recorded;
} {
  const state: Recorded = { destinations: [], credentials: [], firstBytes: [] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    void handshake(socket, state).catch(() => socket.destroy());
  });
  // Destroy live tunnels on close so a spec cannot hang on a half-open relay.
  const close = server.close.bind(server);
  server.close = (cb?: (err?: Error) => void) => {
    sockets.forEach(socket => socket.destroy());
    return close(cb);
  };
  return { server, state };
}

const finish = async (
  server: net.Server,
  state: Recorded,
  url: (port: number) => string,
): Promise<SocksProxyServer> => {
  const port = await listen(server);
  return {
    url: url(port),
    ...state,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

/** A SOCKS5 proxy, optionally demanding username/password authentication. */
export async function startSocks5Proxy(options: Options = {}): Promise<SocksProxyServer> {
  const { server, state } = serve(async (socket, recorded) => {
    const [, methodCount] = await read(socket, 2);
    await read(socket, methodCount);
    if (options.credentials) {
      socket.write(Buffer.from([0x05, 0x02])); // username/password
      await read(socket, 1); // auth version
      const username = await readLengthPrefixed(socket);
      const password = await readLengthPrefixed(socket);
      recorded.credentials.push(`${username}:${password}`);
      const ok = username === options.credentials.username && password === options.credentials.password;
      socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
      if (!ok) {
        socket.end();
        return;
      }
    } else {
      socket.write(Buffer.from([0x05, 0x00])); // no authentication required
    }

    const request = await read(socket, 4); // ver, cmd, rsv, atyp
    const atyp = request[3];
    let host: string;
    if (atyp === 0x01) {
      host = [...(await read(socket, 4))].join('.');
    } else if (atyp === 0x03) {
      host = await readLengthPrefixed(socket);
    } else {
      const raw = await read(socket, 16);
      host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
    }
    const port = (await read(socket, 2)).readUInt16BE(0);
    recorded.destinations.push(`${host}:${port}`);
    if (options.ipv4Only && atyp === 0x04) {
      socket.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // host unreachable
      return;
    }
    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    relay(socket, recorded, options.relayTo);
  });

  const scheme = options.credentials
    ? `socks5://${encodeURIComponent(options.credentials.username)}:${encodeURIComponent(options.credentials.password)}@127.0.0.1:`
    : 'socks5://127.0.0.1:';
  return finish(server, state, port => `${scheme}${port}`);
}

/** A strict SOCKS4 proxy: an IPv4 destination only, and no authentication step at all. */
export async function startSocks4Proxy(options: Options = {}): Promise<SocksProxyServer> {
  const { server, state } = serve(async (socket, recorded) => {
    const request = await read(socket, 8); // ver, cmd, port(2), ip(4)
    const port = request.readUInt16BE(2);
    const host = [...request.subarray(4, 8)].join('.');
    recorded.credentials.push(await readNulTerminated(socket)); // user id, the only identity SOCKS4 has
    recorded.destinations.push(`${host}:${port}`);
    socket.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0])); // request granted
    relay(socket, recorded, options.relayTo);
  });
  return finish(server, state, port => `socks4://127.0.0.1:${port}`);
}
