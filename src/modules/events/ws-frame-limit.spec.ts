import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import WebSocket from 'ws';
// The gateway first: auth.service imports it back, and loading that side first leaves the gateway's
// constructor metadata with an undefined AuthService.
import { EventsGateway, WS_MAX_FRAME_BYTES } from './events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { SUBSCRIBABLE_EVENTS } from './dto/ws-messages.dto';
import { RedisIoAdapter } from './redis-io.adapter';

/**
 * What matters is what a real socket does with a frame, so this boots the gateway behind the adapter the
 * application installs and talks raw Engine.IO to it. The size bound is a Socket.IO server option set on
 * the gateway, so only a booted server shows that it reaches the server and closes the connection.
 */
describe('/events client frame size', () => {
  const key = { id: 'k1', name: 'viewer', role: 'viewer', isActive: true, allowedSessions: null, allowedChats: null };
  let app: INestApplication;
  let port: number;
  let peers: WebSocket[];

  beforeEach(async () => {
    delete process.env.REDIS_ENABLED;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    peers = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsGateway,
        ChatScopeService,
        { provide: AuthService, useValue: { validateApiKey: () => Promise.resolve(key) } },
        { provide: AuditService, useValue: { logWarn: () => Promise.resolve() } },
        { provide: ConfigService, useValue: { get: (_key: string, fallback?: unknown) => fallback } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as HttpServer).address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of peers) ws.terminate();
    await app.close();
    jest.restoreAllMocks();
  });

  /** An authenticated /events peer: resolves once the namespace has accepted it. */
  const connect = async (): Promise<{ ws: WebSocket; frames: string[]; closed: Promise<number> }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    peers.push(ws);
    const frames: string[] = [];
    const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
    const joined = new Promise<void>(resolve => {
      ws.on('message', (data: Buffer) => {
        const frame = data.toString();
        frames.push(frame);
        if (frame === '2') ws.send('3');
        if (frame.startsWith('0')) ws.send('40/events,{"apiKey":"k"}');
        if (frame.startsWith('40/events,')) resolve();
      });
    });
    await joined;
    return { ws, frames, closed };
  };

  const subscribeFrame = (subscribe: Record<string, unknown>): string =>
    `42/events,${JSON.stringify(['message', { type: 'subscribe', ...subscribe }])}`;

  const waitFor = async (predicate: () => boolean): Promise<boolean> => {
    for (let waited = 0; waited < 2000 && !predicate(); waited += 20) await new Promise(r => setTimeout(r, 20));
    return predicate();
  };

  it('answers a subscribe', async () => {
    const { ws, frames } = await connect();

    ws.send(subscribeFrame({ sessionId: '*', events: ['session.status'] }));

    expect(await waitFor(() => frames.some(frame => frame.includes('"type":"subscribed"')))).toBe(true);
  });

  // The bound has to leave the longest frame a client can legitimately send untouched: the longest session id
  // and request id the gateway accepts, and every event it can subscribe to.
  it('answers the longest legal subscribe, which is a small fraction of the bound', async () => {
    const { ws, frames } = await connect();
    const frame = subscribeFrame({
      sessionId: 'a'.repeat(128),
      requestId: 'r'.repeat(128),
      events: [...SUBSCRIBABLE_EVENTS, '*'],
    });
    expect(Buffer.byteLength(frame)).toBeLessThan(WS_MAX_FRAME_BYTES / 4);

    ws.send(frame);

    expect(await waitFor(() => frames.some(f => f.includes('"type":"subscribed"')))).toBe(true);
  });

  // A polling client batches the frames it has queued into one POST, and splits the batch to the limit the server
  // advertises in its first answer. Without it a client with many subscriptions to send would exceed the bound.
  it('advertises the bound to polling clients and refuses a request body over it', async () => {
    const base = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
    const open = await (await fetch(base)).text();
    const handshake = JSON.parse(open.slice(1)) as { sid: string; maxPayload: number };
    expect(handshake.maxPayload).toBe(WS_MAX_FRAME_BYTES);

    const post = (body: string): Promise<Response> => fetch(`${base}&sid=${handshake.sid}`, { method: 'POST', body });
    expect((await post('40/events,{"apiKey":"k"}')).status).toBe(200);
    expect((await post(`42/events,["message",{"x":"${'a'.repeat(WS_MAX_FRAME_BYTES)}"}]`)).status).toBe(413);
  });

  it('closes a connection that sends a frame over the bound, without answering it', async () => {
    const { ws, frames, closed } = await connect();

    ws.send(subscribeFrame({ sessionId: '*', events: Array.from({ length: 20_000 }, (_, i) => `e${i}`) }));

    expect(await closed).toBe(1009);
    expect(frames.some(frame => frame.includes('"type":"subscribed"') || frame.includes('"type":"error"'))).toBe(false);
  });
});
