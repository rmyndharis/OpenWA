// test/__mocks__ holds a stub of this package, which Jest applies to node modules on its own; this
// suite needs the real CONNECT negotiation.
jest.unmock('https-proxy-agent');

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { createProxyAgent } from './../src/engine/adapters/baileys-lifecycle';

/**
 * The Baileys proxy agent against a proxy that accepts TCP and never answers CONNECT, the case the
 * connecting backstop exists for, through the real https-proxy-agent the unit suites stub out.
 * Each abandoned attempt must release its proxy socket, or every reconnect leaves one more open.
 */
describe('Baileys proxy agent (e2e)', () => {
  const silentProxy = async (): Promise<{ server: net.Server; accepted: Promise<net.Socket> }> => {
    let onAccepted!: (socket: net.Socket) => void;
    const accepted = new Promise<net.Socket>(resolve => (onAccepted = resolve));
    const server = net.createServer(socket => {
      // Reading is what lets the server see the client's FIN.
      socket.resume();
      socket.on('error', () => undefined);
      onAccepted(socket);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, accepted };
  };

  const closedWithin = (socket: net.Socket, ms: number): Promise<boolean> =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), ms);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  it.each<[string, number, (req: http.ClientRequest) => void]>([
    // What ws does when Baileys ends a socket still in its handshake; the deadline is out of reach.
    ['aborted', 60_000, req => req.abort()],
    // Destroyed before it has a socket, which emits nothing: the CONNECT deadline closes it instead.
    ['destroyed', 300, req => req.destroy()],
  ])('closes the proxy socket when a request still waiting on CONNECT is %s', async (_label, deadlineMs, stop) => {
    const { server, accepted } = await silentProxy();
    const req = https.request({
      host: '127.0.0.1',
      port: 443,
      agent: createProxyAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, deadlineMs),
    });
    req.on('error', () => undefined);
    req.end();
    const socket = await accepted;
    try {
      stop(req);
      expect(await closedWithin(socket, 1000)).toBe(true);
    } finally {
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
