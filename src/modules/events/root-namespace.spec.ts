import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import { rejectRootNamespace } from './redis-io.adapter';

/**
 * What matters here is which peers Socket.IO's connect timeout reaps, so this runs a real server and raw
 * Engine.IO frames instead of mocks. The timers are short; the behaviour is the same at the 45 s default.
 */
describe('rejectRootNamespace', () => {
  let httpServer: HttpServer;
  let io: Server;
  let peers: WebSocket[];

  beforeEach(async () => {
    peers = [];
    httpServer = createServer();
    io = new Server(httpServer, { connectTimeout: 400, pingInterval: 150, pingTimeout: 150 });
    rejectRootNamespace(io);
    io.of('/events');
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    for (const ws of peers) ws.terminate();
    await io.close();
  });

  /** A websocket peer that answers pings like a live client and sends `connect` once the server has opened. */
  const open = (connect: string): { frames: string[]; closed: () => boolean } => {
    const { port } = httpServer.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    peers.push(ws);
    const frames: string[] = [];
    let closed = false;
    ws.on('message', (data: Buffer) => {
      const frame = data.toString();
      frames.push(frame);
      if (frame === '2') ws.send('3');
      if (frame.startsWith('0')) ws.send(connect);
    });
    ws.on('close', () => {
      closed = true;
    });
    return { frames, closed: () => closed };
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  it('refuses a CONNECT to the root namespace, so the connect timeout closes the peer', async () => {
    const peer = open('40');

    await wait(250);
    expect(peer.frames.some(frame => frame.startsWith('44') && frame.includes('Invalid namespace'))).toBe(true);
    expect(peer.closed()).toBe(false);

    await wait(500);
    expect(peer.closed()).toBe(true);
  });

  it('still admits a peer that joins /events, and keeps it past the connect timeout', async () => {
    const peer = open('40/events,');

    await wait(250);
    expect(peer.frames.some(frame => frame.startsWith('40/events,'))).toBe(true);

    await wait(500);
    expect(peer.closed()).toBe(false);
  });
});
