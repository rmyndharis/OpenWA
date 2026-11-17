import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import { rejectRootNamespace } from './redis-io.adapter';

/**
 * What matters here is which peers Socket.IO's connect timeout reaps, so this runs a real server and raw
 * Engine.IO frames instead of mocks. The timers are short; the behaviour is the same at the 45 s default.
 */
const CONNECT_TIMEOUT_MS = 400;

// Room past the real-time deadlines below, so a missed condition fails its expectation rather than the test.
jest.setTimeout(20_000);

describe('rejectRootNamespace', () => {
  let httpServer: HttpServer;
  let io: Server;
  let peers: WebSocket[];

  beforeEach(async () => {
    peers = [];
    httpServer = createServer();
    io = new Server(httpServer, { connectTimeout: CONNECT_TIMEOUT_MS, pingInterval: 150, pingTimeout: 150 });
    rejectRootNamespace(io);
    io.of('/events');
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    for (const ws of peers) ws.terminate();
    await io.close();
  });

  /**
   * A websocket peer that answers pings like a live client and sends `connect` once the server has opened. It
   * records when it started and when its connection closed, so a check on the order of events does not depend on
   * when a test timer happens to fire.
   */
  const open = (
    connect: string,
  ): { frames: string[]; closed: () => boolean; startedAt: number; closedAt: () => number } => {
    const { port } = httpServer.address() as AddressInfo;
    const startedAt = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    peers.push(ws);
    const frames: string[] = [];
    let closedAt = 0;
    ws.on('message', (data: Buffer) => {
      const frame = data.toString();
      frames.push(frame);
      if (frame === '2') ws.send('3');
      if (frame.startsWith('0')) ws.send(connect);
    });
    ws.on('close', () => {
      closedAt = Date.now();
    });
    return { frames, closed: () => closedAt > 0, startedAt, closedAt: () => closedAt };
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  /** Wait in real time for a condition the sockets reach on their own, up to a deadline. */
  const until = async (condition: () => boolean, deadlineMs = 5_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (!condition() && Date.now() < deadline) await wait(10);
    return condition();
  };

  it('refuses a CONNECT to the root namespace, so the connect timeout closes the peer', async () => {
    const peer = open('40');

    await until(() => peer.closed());
    expect(peer.frames.some(frame => frame.startsWith('44') && frame.includes('Invalid namespace'))).toBe(true);
    // The refusal alone left the connection open: it closed only once the connect timeout had run out.
    expect(peer.closed()).toBe(true);
    expect(peer.closedAt() - peer.startedAt).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 100);
  });

  it('still admits a peer that joins /events, and keeps it past the connect timeout', async () => {
    const peer = open('40/events,');

    await until(() => peer.frames.some(frame => frame.startsWith('40/events,')));
    expect(peer.frames.some(frame => frame.startsWith('40/events,'))).toBe(true);

    // Well past the connect timeout, which would have closed a peer that holds no namespace.
    await wait(Math.max(0, peer.startedAt + 2 * CONNECT_TIMEOUT_MS - Date.now()));
    expect(peer.closed()).toBe(false);
  });
});
