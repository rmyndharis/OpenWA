import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { SocksClient } from 'socks';
import { createProxyDispatcher, SOCKS_CONNECT_TIMEOUT_MS } from './proxy-dispatcher';
import { startSocks5Proxy, type SocksProxyServer } from '../../../test/helpers/socks-proxy-servers';
import { waitUntil } from '../../../test/helpers/wait-until';

type Connect = (
  options: Record<string, unknown>,
  callback: (error: Error | null, socket: net.Socket | null) => void,
) => void;

// The connector is private to the dispatcher: undici's Agent receives it as its `connect` option, so the
// Agent is replaced by a recorder that keeps that option and the connector can be called directly.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return {
    ...actual,
    Agent: jest.fn((options: { connect: Connect }) => ({ connect: options.connect })),
    Dispatcher1Wrapper: jest.fn((dispatcher: unknown) => dispatcher),
  };
});

describe('SOCKS connector callback', () => {
  let origin: http.Server;
  let proxy: SocksProxyServer | undefined;

  beforeAll(async () => {
    origin = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  });
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  const connectorFor = (url: string): Connect =>
    (createProxyDispatcher(url) as unknown as { connect: Connect }).connect;
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100));
  // The first answer comes after a real handshake with a local proxy, which takes as long as the machine needs. Wait for
  // it with a deadline, and only then settle for a second answer, the failure this spec pins.
  const answered = (callback: { mock: { calls: unknown[] } }): Promise<void> =>
    waitUntil(() => callback.mock.calls.length > 0);

  // open() answers undici's callback from inside itself, so a throw out of that callback lands in the
  // catch handler of the same promise. Undici's connect callback must still be answered once.
  it('answers once with the socket when the callback throws after it was handed one', async () => {
    proxy = await startSocks5Proxy({ relayTo: (origin.address() as AddressInfo).port });
    const callback = jest.fn<void, Parameters<Parameters<Connect>[1]>>(() => {
      throw new Error('callback failed after the socket was handed over');
    });

    connectorFor(proxy.url)({ hostname: '203.0.113.7', protocol: 'http:', port: '80' }, callback);
    await answered(callback);
    await settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeNull();
    callback.mock.calls[0][1]?.destroy();
    // The wait for the first answer may use five seconds, more than jest gives a case by default.
  }, 60_000);

  it('answers once with the error when no address can be dialled', async () => {
    const callback = jest.fn<void, Parameters<Parameters<Connect>[1]>>();

    // A SOCKS4 request has no IPv6 form, so this fails before any connection is made.
    connectorFor('socks4://127.0.0.1:1')({ hostname: '[::1]', protocol: 'http:', port: '80' }, callback);
    await settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(callback.mock.calls[0][1]).toBeNull();
  });

  it('passes explicit timeout: SOCKS_CONNECT_TIMEOUT_MS to SocksClient.createConnection', async () => {
    const createConn = jest.spyOn(SocksClient, 'createConnection').mockRejectedValueOnce(new Error('nope'));
    try {
      const callback = jest.fn<void, Parameters<Parameters<Connect>[1]>>();
      connectorFor('socks5://127.0.0.1:1080')({ hostname: '203.0.113.7', protocol: 'http:', port: '80' }, callback);
      await waitUntil(() => callback.mock.calls.length > 0);
      expect(createConn).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: SOCKS_CONNECT_TIMEOUT_MS,
          destination: { host: '203.0.113.7', port: 80 },
        }),
      );
      expect(SOCKS_CONNECT_TIMEOUT_MS).toBe(10_000);
    } finally {
      createConn.mockRestore();
    }
  });

  it('stops iterating remaining pinned IPs on AbortSignal and destroys any late socket', async () => {
    let resolvePending!: (value: { socket: net.Socket }) => void;
    const destroy = jest.fn();
    const lateSocket = { destroy, setNoDelay: jest.fn() } as unknown as net.Socket;
    const createConn = jest.spyOn(SocksClient, 'createConnection').mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePending = resolve;
        }),
    );
    try {
      const ac = new AbortController();
      const dispatcher = createProxyDispatcher('socks5://127.0.0.1:1080', {
        pinnedAddresses: ['203.0.113.1', '203.0.113.2', '203.0.113.3'],
        signal: ac.signal,
      }) as unknown as { connect: Connect };
      const callback = jest.fn<void, Parameters<Parameters<Connect>[1]>>();
      dispatcher.connect({ hostname: 'example.com', protocol: 'http:', port: '80' }, callback);
      await waitUntil(() => createConn.mock.calls.length === 1);

      ac.abort(new Error('request cancelled'));
      await waitUntil(() => callback.mock.calls.length > 0);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(callback.mock.calls[0][1]).toBeNull();
      // Never dialled the remaining pinned IPs after abort.
      expect(createConn).toHaveBeenCalledTimes(1);

      // A late-resolving socket from the aborted attempt is destroyed immediately.
      resolvePending({ socket: lateSocket });
      await settle();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      createConn.mockRestore();
    }
  });

  it('rejects immediately when signal is already aborted and tolerates late rejection after abort', async () => {
    const preAborted = new AbortController();
    preAborted.abort('already aborted');
    const preCb = jest.fn<void, Parameters<Parameters<Connect>[1]>>();
    const dispatcherPre = createProxyDispatcher('socks5://127.0.0.1:1080', {
      pinnedAddresses: ['203.0.113.1'],
      signal: preAborted.signal,
    }) as unknown as { connect: Connect };
    dispatcherPre.connect({ hostname: 'example.com', protocol: 'http:', port: '80' }, preCb);
    await waitUntil(() => preCb.mock.calls.length > 0);
    expect(preCb.mock.calls[0][0]).toBeInstanceOf(DOMException);
    expect(preCb.mock.calls[0][1]).toBeNull();

    let rejectPending!: (err: unknown) => void;
    const createConn = jest.spyOn(SocksClient, 'createConnection').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    try {
      const ac = new AbortController();
      const dispatcher = createProxyDispatcher('socks5://127.0.0.1:1080', {
        pinnedAddresses: ['203.0.113.1', '203.0.113.2'],
        signal: ac.signal,
      }) as unknown as { connect: Connect };
      const cb = jest.fn<void, Parameters<Parameters<Connect>[1]>>();
      dispatcher.connect({ hostname: 'example.com', protocol: 'http:', port: '80' }, cb);
      await waitUntil(() => createConn.mock.calls.length === 1);
      ac.abort('cancelled');
      await waitUntil(() => cb.mock.calls.length > 0);
      rejectPending('late failure');
      await settle();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(createConn).toHaveBeenCalledTimes(1);
    } finally {
      createConn.mockRestore();
    }
  });

  it('destroys tunnel socket when request AbortSignal fires during HTTPS TLS upgrade', async () => {
    const sinkSockets: net.Socket[] = [];
    const sink = net.createServer(sock => {
      sinkSockets.push(sock);
      sock.on('error', () => undefined);
    });
    await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
    const sinkPort = (sink.address() as AddressInfo).port;
    const reqAc = new AbortController();
    const dispAc = new AbortController();
    try {
      proxy = await startSocks5Proxy({ relayTo: sinkPort });
      const dispatcher = createProxyDispatcher(proxy.url, {
        pinnedAddresses: ['203.0.113.7'],
        signal: dispAc.signal,
      }) as unknown as { connect: Connect };
      const cb = jest.fn<void, Parameters<Parameters<Connect>[1]>>();
      dispatcher.connect(
        { hostname: 'example.com', servername: 'example.com', protocol: 'https:', port: '443', signal: reqAc.signal },
        cb,
      );
      await settle();
      reqAc.abort('tls cancelled');
      await waitUntil(() => cb.mock.calls.length > 0);
      expect(cb.mock.calls[0][0]).toBeInstanceOf(DOMException);
      expect(cb.mock.calls[0][1]).toBeNull();
    } finally {
      for (const sock of sinkSockets) sock.destroy();
      await new Promise<void>(resolve => sink.close(() => resolve()));
    }
  });
});
