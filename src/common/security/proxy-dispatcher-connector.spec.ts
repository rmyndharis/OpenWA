import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { createProxyDispatcher } from './proxy-dispatcher';
import { startSocks5Proxy, type SocksProxyServer } from '../../../test/helpers/socks-proxy-servers';

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
  // it, up to five seconds, and only then settle for a second answer, the failure this spec pins.
  const answered = async (callback: { mock: { calls: unknown[] } }): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (callback.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

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
  }, 15_000);

  it('answers once with the error when no address can be dialled', async () => {
    const callback = jest.fn<void, Parameters<Parameters<Connect>[1]>>();

    // A SOCKS4 request has no IPv6 form, so this fails before any connection is made.
    connectorFor('socks4://127.0.0.1:1')({ hostname: '[::1]', protocol: 'http:', port: '80' }, callback);
    await settle();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(callback.mock.calls[0][1]).toBeNull();
  });
});
