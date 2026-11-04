import * as fs from 'node:fs';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server } from 'socket.io';
import {
  RedisIoAdapter,
  WS_REDIS_COMMAND_TIMEOUT_MS,
  WS_REDIS_MAX_UNANSWERED,
  WS_REDIS_QUIT_TIMEOUT_MS,
  WS_REDIS_SOCKET_TIMEOUT_MS,
  WS_REDIS_SUBSCRIBER_PING_MS,
  WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS,
} from './redis-io.adapter';

/**
 * A Redis that keeps the connection open and stops answering never errors the socket, so the publish
 * client of the fan-out pair has to bound it itself. This runs the real adapter and the real ioredis
 * client against a peer that speaks just enough RESP to bring a client up, and can then go silent.
 */
class FakeRedis {
  /** Every PUBLISH payload that reached the peer, answered or not. */
  readonly published: string[] = [];
  /** Connections accepted so far: a client that destroys its socket and reconnects raises it. */
  connections = 0;
  readonly sockets = new Set<net.Socket>();
  /** When set, a PUBLISH is answered one at a time through answerOne(): a Redis that is slow, not silent. */
  trickle = false;
  /** PINGs answered so far. */
  pings = 0;
  /** The subscriptions each connection asked for, in the order the connections asked. */
  readonly subscriptions = new Map<net.Socket, string[]>();
  private stalled = false;
  private readonly slowReplies: Array<() => void> = [];
  /** What a stalled peer owes its clients. Sent when it comes back, as a Redis that was paused does. */
  private readonly owed: Array<() => void> = [];
  private readonly server: net.Server;

  /** Answer the oldest PUBLISH a slow peer still owes. */
  answerOne(): void {
    this.slowReplies.shift()?.();
  }

  /** Answer every PUBLISH a slow peer still owes. */
  answerAll(): void {
    for (const send of this.slowReplies.splice(0)) send();
  }

  /**
   * Stop reading every connection that has subscribed, without closing it, as behind a proxy that lost its upstream
   * or a paused Redis. New connections are served. What arrives meanwhile waits in the socket and is answered once
   * they are resumed.
   */
  pauseSubscribers(): void {
    for (const socket of this.subscriptions.keys()) socket.pause();
  }

  resumeSubscribers(): void {
    for (const socket of this.subscriptions.keys()) socket.resume();
  }

  get silent(): boolean {
    return this.stalled;
  }

  set silent(value: boolean) {
    this.stalled = value;
    if (!value) for (const send of this.owed.splice(0)) send();
  }

  constructor() {
    this.server = net.createServer(socket => {
      this.connections++;
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
      let pending: Buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        for (const command of FakeRedis.takeCommands(pending, rest => (pending = rest))) {
          if (command[0].toUpperCase() === 'PUBLISH') this.published.push(command[2]);
          if (command[0].toUpperCase() === 'PING') this.pings++;
          if (/^p?subscribe$/i.test(command[0])) {
            const asked = this.subscriptions.get(socket) ?? [];
            this.subscriptions.set(socket, [...asked, ...command.slice(1).map(channel => `${command[0]} ${channel}`)]);
          }
          // A stalled peer answers nothing the publisher or its reconnect asks until it comes back. Subscriptions
          // are exempt: the adapter issues them without a handler, when a namespace is first used, and a SUBSCRIBE
          // that no reply ever settles is rejected as an unhandled rejection when the client is closed, which ends
          // a Jest worker.
          const reply = FakeRedis.reply(command);
          if (this.trickle && !this.silent && command[0].toUpperCase() === 'PUBLISH') {
            this.slowReplies.push(() => !socket.destroyed && socket.write(reply));
          } else if (!this.silent || /^p?subscribe$/i.test(command[0])) socket.write(reply);
          else this.owed.push(() => !socket.destroyed && socket.write(reply));
        }
      });
    });
  }

  listen(): Promise<number> {
    return new Promise(resolve =>
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port)),
    );
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  /** Parse every complete `*N` array of bulk strings off the front of `buf`; the remainder goes to `keep`. */
  private static takeCommands(buf: Buffer, keep: (rest: Buffer) => void): string[][] {
    const commands: string[][] = [];
    let offset = 0;
    for (;;) {
      if (buf[offset] !== 0x2a) break;
      const eol = buf.indexOf('\r\n', offset);
      if (eol < 0) break;
      const count = parseInt(buf.toString('utf8', offset + 1, eol), 10);
      let cursor = eol + 2;
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const lineEnd = buf.indexOf('\r\n', cursor);
        if (lineEnd < 0) break;
        const length = parseInt(buf.toString('utf8', cursor + 1, lineEnd), 10);
        if (buf.length < lineEnd + 2 + length + 2) break;
        parts.push(buf.toString('utf8', lineEnd + 2, lineEnd + 2 + length));
        cursor = lineEnd + 2 + length + 2;
      }
      if (parts.length < count) break;
      commands.push(parts);
      offset = cursor;
    }
    keep(buf.subarray(offset));
    return commands;
  }

  private static reply([name, ...args]: string[]): string {
    switch (name.toUpperCase()) {
      case 'INFO': {
        const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
        return `$${info.length}\r\n${info}\r\n`;
      }
      case 'PUBLISH':
        return ':1\r\n';
      case 'PING':
        return '+PONG\r\n';
      // The client said HELLO 3, so each subscription is confirmed as a push of its own kind, as Redis 6 and
      // later do. ioredis records what a push confirms and subscribes to exactly that again after a reconnect.
      case 'SUBSCRIBE':
      case 'PSUBSCRIBE': {
        const kind = name.toLowerCase();
        return args
          .map((channel, i) => `>3\r\n$${kind.length}\r\n${kind}\r\n$${channel.length}\r\n${channel}\r\n:${i + 1}\r\n`)
          .join('');
      }
      default:
        return '+OK\r\n';
    }
  }
}

type Queue = { length: number };
type PublishClient = {
  status: string;
  commandQueue: Queue;
  offlineQueue: Queue;
  prevCommandQueue?: Queue | null;
  publish: (channel: string, message: string) => Promise<number>;
};

describe('RedisIoAdapter publish client against a Redis that stops answering', () => {
  const prevEnv = { ...process.env };
  let redis: FakeRedis;
  let adapter: RedisIoAdapter;
  let io: Server;
  let pub: PublishClient;
  let warn: jest.SpyInstance;

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  /**
   * Everything the client holds for a reply or for a connection: the three places ioredis keeps a command. Between
   * a destroyed socket and the next connect the command queue and the previous one are the same object.
   */
  const held = (): number => {
    const queues = new Set<Queue>([pub.commandQueue, pub.offlineQueue]);
    if (pub.prevCommandQueue) queues.add(pub.prevCommandQueue);
    return [...queues].reduce((total, queue) => total + queue.length, 0);
  };
  const broadcast = (count: number): void => {
    for (let i = 0; i < count; i++)
      io.of('/events')
        .to('room')
        .emit('message', { body: 'x'.repeat(1024) });
  };
  const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
      if (await condition()) return true;
      await sleep(50);
    }
    return false;
  };

  beforeEach(async () => {
    redis = new FakeRedis();
    const port = await redis.listen();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(port);
    io = new Server();
    jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(io);
    jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    adapter = new RedisIoAdapter({} as never);
    adapter.createIOServer(0);
    pub = (adapter as unknown as { pubClient: PublishClient }).pubClient;
    expect(await waitUntil(() => pub.status === 'ready', 3000)).toBe(true);
  });

  afterEach(async () => {
    redis.silent = false;
    await adapter.close(io);
    await redis.close();
    jest.restoreAllMocks();
    process.env = { ...prevEnv };
  });

  it('still publishes to a healthy peer and holds nothing afterwards', async () => {
    broadcast(20);

    await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
    expect(held()).toBe(0);
  });

  // ioredis arms the socket timer on the write, on this process's own event loop. A loop that stays busy for longer
  // than the deadline right after a write expires that timer before the reply already waiting in the socket is
  // read, so a healthy peer would look stalled and the client would drop its connection. The block runs in an I/O
  // callback, as the engine and database callbacks do; inside a timer callback the loop clock is stale and the same
  // block would not show it.
  it('does not treat a healthy peer as stalled when this process blocks its loop right after a publish', async () => {
    const connections = redis.connections;

    await new Promise<void>(resolve =>
      fs.readFile(__filename, () => {
        broadcast(1);
        for (const until = Date.now() + 2000; Date.now() < until;) {
          // hold the loop
        }
        resolve();
      }),
    );
    // Long enough for a destroyed socket to have been replaced.
    await sleep(1500);

    expect(redis.published.length).toBe(1);
    expect(redis.connections).toBe(connections);
    expect(pub.status).toBe('ready');
    expect(held()).toBe(0);
    expect(warn.mock.calls.flat().some(line => String(line).includes('Socket timeout'))).toBe(false);
  }, 15_000);

  // The pause of a busy Redis (a snapshot fork, an fsync) ends. Everything raised meanwhile is on the wire, so it
  // arrives once the peer is back, provided the client has not given up on the connection first.
  it('loses no event when the peer stays silent for longer than the command deadline but less than the socket deadline', async () => {
    const connections = redis.connections;
    let sent = 0;

    redis.silent = true;
    for (let batch = 0; batch < 25; batch++) {
      broadcast(4);
      sent += 4;
      await sleep(100);
    }
    redis.silent = false;

    expect(await waitUntil(() => held() === 0, 3000)).toBe(true);
    expect(redis.published.length).toBe(sent);
    expect(redis.connections).toBe(connections);
    expect(pub.status).toBe('ready');
  }, 15_000);

  const warned = (text: string): string[] =>
    warn.mock.calls
      .flat()
      .map(line => String(line))
      .filter(line => line.includes(text));

  // Every frame of a burst raised in one tick is on the queue before the first reply can be read, however healthy the
  // peer is, so the depth of the queue alone says nothing about a Redis that is behind. The clock is moved by hand, and
  // only between publishes, so the test does not depend on how long the loop takes on the machine running it.
  it('publishes every frame of a burst larger than the cap raised in one tick to a peer that answers', async () => {
    const burst = WS_REDIS_MAX_UNANSWERED + 3000;
    jest.spyOn(performance, 'now').mockReturnValue(5_000);

    broadcast(burst);

    expect(await waitUntil(() => redis.published.length === burst && held() === 0, 15_000)).toBe(true);
    expect(warned('fan-out frames are dropped')).toHaveLength(0);
    expect(warned('were dropped')).toHaveLength(0);
  }, 30_000);

  // The limit of that guarantee: a burst that takes longer than a command is given to raise, past its half-cap mark, looks
  // like a backlog, however healthy the peer. A synchronous loop cannot advance the age, so the time is simulated.
  it('cuts a burst at the cap when raising it past half the cap takes longer than a command is given', async () => {
    const burst = WS_REDIS_MAX_UNANSWERED + 3000;
    const perFrameMs = (WS_REDIS_COMMAND_TIMEOUT_MS * 2) / (WS_REDIS_MAX_UNANSWERED / 2);
    let clock = 5_000;
    jest.spyOn(performance, 'now').mockImplementation(() => (clock += perFrameMs));

    broadcast(burst);

    expect(await waitUntil(() => redis.published.length >= WS_REDIS_MAX_UNANSWERED && held() === 0, 15_000)).toBe(true);
    expect(redis.published.length).toBe(WS_REDIS_MAX_UNANSWERED);
    const started = warned('fan-out frames are dropped');
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(`${WS_REDIS_MAX_UNANSWERED} fan-out frames unanswered`);
  }, 30_000);

  // A Redis that answers, but slower than events are raised, resets the socket timer with every reply, so the socket
  // deadline never fires and the client would hold the whole backlog. Only the cap on unanswered commands bounds it,
  // once the backlog has outlived a command's own deadline. The clock is moved by hand: the rule is about elapsed time.
  it('holds a slow peer to the cap, warning once when dropping starts and once when it ends, however often it answers', async () => {
    let clock = 5_000;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const connections = redis.connections;
    redis.trickle = true;

    // The queue is half full, which is the last moment it counted as being on top of its work...
    broadcast(WS_REDIS_MAX_UNANSWERED / 2);
    // ...and it stays above that for longer than a command is given to be answered.
    clock += WS_REDIS_COMMAND_TIMEOUT_MS + 100;
    broadcast(WS_REDIS_MAX_UNANSWERED);

    expect(held()).toBe(WS_REDIS_MAX_UNANSWERED);
    expect(await waitUntil(() => redis.published.length >= WS_REDIS_MAX_UNANSWERED, 10_000)).toBe(true);
    expect(redis.published.length).toBe(WS_REDIS_MAX_UNANSWERED);
    expect(redis.connections).toBe(connections);
    expect(pub.status).toBe('ready');
    expect(warned('fan-out frames are dropped')).toHaveLength(1);

    // Each reply frees one slot and the next frame arrives: that must not end the episode, or every reply would
    // log two lines and let one frame through. It ends when the queue is back below half the cap.
    for (let reply = 0; reply < 30; reply++) {
      const before = held();
      redis.answerOne();
      expect(await waitUntil(() => held() < before, 3000)).toBe(true);
      broadcast(1);
    }
    expect(held()).toBe(WS_REDIS_MAX_UNANSWERED - 30);
    expect(warned('fan-out frames are dropped')).toHaveLength(1);
    expect(warned('were dropped')).toHaveLength(0);

    // The peer catches up: everything it owed is answered, and events are published again.
    redis.trickle = false;
    redis.answerAll();
    expect(await waitUntil(() => held() === 0, 5000)).toBe(true);
    const published = redis.published.length;
    broadcast(2);
    expect(await waitUntil(() => redis.published.length === published + 2, 5000)).toBe(true);
    // One line for the whole episode, with its count: 6,000 dropped by the burst and 30 while it was answering.
    const ended = warned('were dropped');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain(`${WS_REDIS_MAX_UNANSWERED / 2 + 30} fan-out frames`);
  }, 30_000);

  it('settles a publish within its deadline, then drops the connection after the socket deadline, holds nothing more, and recovers', async () => {
    redis.silent = true;

    // The peer is silent but the connection stays open: nothing errors, so the deadline is the only thing
    // that settles the command.
    const started = Date.now();
    const outcome = await Promise.race([
      pub.publish('socket.io#/events#', 'stalled-frame'),
      sleep(WS_REDIS_COMMAND_TIMEOUT_MS * 2).then(() => 'still pending'),
    ]);
    expect(outcome).toBe(0);
    expect(Date.now() - started).toBeLessThan(WS_REDIS_COMMAND_TIMEOUT_MS + 1000);

    // Events keep arriving at a steady rate. The client holds them until its socket deadline destroys the
    // connection, and that is all it holds.
    const connections = redis.connections;
    let heldAtDestroy = 0;
    const destroyed = await waitUntil(() => {
      broadcast(10);
      heldAtDestroy = held();
      return pub.status !== 'ready';
    }, WS_REDIS_SOCKET_TIMEOUT_MS + 3000);
    expect(destroyed).toBe(true);
    expect(heldAtDestroy).toBeLessThan((WS_REDIS_SOCKET_TIMEOUT_MS / 1000 + 2) * 200);

    // From here the client is reconnecting: nothing is queued for a connection it does not have, however many
    // events are raised. (Each batch of the wait above was 10 events per 50 ms.) The window outlasts the command
    // deadline, so the timers of what the abandoned socket still owes are gone before the test ends.
    for (let waited = 0; waited < WS_REDIS_COMMAND_TIMEOUT_MS + 500; waited += 50) {
      broadcast(10);
      await sleep(50);
    }
    expect(held() - heldAtDestroy).toBeLessThan(20);

    // The peer answers again: the client comes back without a restart, and does not send again what the
    // abandoned socket had already put on the wire, which the peer may have delivered.
    redis.silent = false;
    expect(await waitUntil(async () => (await pub.publish('socket.io#/events#', 'probe')) === 1, 10_000)).toBe(true);
    expect(held()).toBe(0);
    expect(redis.connections).toBeGreaterThan(connections);
    expect(redis.published.filter(payload => payload === 'stalled-frame')).toHaveLength(1);
  }, 60_000);
});

/**
 * The subscriber only receives, so a connection that stops answering while the far side keeps it open, as a proxy
 * does, errors nothing: the client stays ready and the replica misses what the others publish. Real adapter and real
 * ioredis against the same peer, on fake timers so the ping interval and the socket deadline cost no wall time;
 * socket I/O stays real and is read between steps.
 */
describe('RedisIoAdapter subscriber against a connection that goes quiet while idle', () => {
  const prevEnv = { ...process.env };
  let redis: FakeRedis;
  let adapter: RedisIoAdapter;
  let io: Server;
  let sub: { status: string; commandQueue: Queue };
  let warn: jest.SpyInstance;

  /** Let real socket I/O run until the condition holds, for up to `ms` of wall time. */
  const settle = async (condition: () => boolean, ms = 3000): Promise<boolean> => {
    const until = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
    while (!condition() && process.hrtime.bigint() < until) await new Promise(resolve => setImmediate(resolve));
    return condition();
  };
  const idle = (): boolean => sub.status === 'ready' && sub.commandQueue.length === 0;
  const warned = (text: string): number =>
    warn.mock.calls
      .flat()
      .map(line => String(line))
      .filter(line => line.includes(text)).length;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'hrtime'] });
    redis = new FakeRedis();
    const port = await redis.listen();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = String(port);
    io = new Server();
    jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(io);
    jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    adapter = new RedisIoAdapter({} as never);
    adapter.createIOServer(0);
    io.of('/events');
    sub = (adapter as unknown as { subClient: typeof sub }).subClient;
    expect(await settle(() => idle() && redis.subscriptions.size === 1)).toBe(true);
  });

  afterEach(async () => {
    const closed = adapter.close(io);
    await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS);
    await closed;
    jest.useRealTimers();
    await redis.close();
    jest.restoreAllMocks();
    process.env = { ...prevEnv };
  });

  it('replaces a subscriber connection that stops answering, and subscribes again on the new one', async () => {
    const [first] = redis.subscriptions.keys();
    const connections = redis.connections;
    redis.pauseSubscribers();

    // The next ping goes unanswered. Until the deadline the client still looks ready.
    await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS);
    expect(await settle(() => sub.commandQueue.length === 1)).toBe(true);
    await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS - 1);
    expect(await settle(() => sub.status !== 'ready', 500)).toBe(false);

    // At the deadline the socket is destroyed, and after the first reconnect delay a new connection subscribes.
    await jest.advanceTimersByTimeAsync(1);
    expect(await settle(() => sub.status === 'reconnecting')).toBe(true);
    expect(warned('Redis sub client error: Socket timeout')).toBe(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(await settle(() => idle() && redis.subscriptions.size === 2)).toBe(true);
    expect(redis.connections).toBe(connections + 1);
    const [, second] = redis.subscriptions.keys();
    expect([...redis.subscriptions.get(second)!].sort()).toEqual([...redis.subscriptions.get(first)!].sort());
  }, 20_000);

  it('keeps an idle subscriber connection that answers its pings', async () => {
    const connections = redis.connections;

    // Each step lets the answer be read before the clock moves on, as it is in real time. The six intervals span the
    // socket deadline several times over, so a deadline the answers did not clear would have fired.
    for (let ping = 1; ping <= 6; ping++) {
      await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS);
      expect(await settle(() => redis.pings === ping && idle())).toBe(true);
    }
    expect(WS_REDIS_SUBSCRIBER_PING_MS * 6).toBeGreaterThan(WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS * 2);

    expect(redis.connections).toBe(connections);
    expect(sub.status).toBe('ready');
    expect(warned('Socket timeout')).toBe(0);
  }, 20_000);

  // A Redis that pauses (a snapshot fork, a slow disk) for longer than the publisher's deadline still delivers, once
  // it resumes, what the others had written before giving up. The subscriber keeps its connection to receive it.
  it('keeps a subscriber connection whose ping is answered after a pause longer than the publish deadline', async () => {
    const connections = redis.connections;
    redis.pauseSubscribers();

    await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS);
    expect(await settle(() => sub.commandQueue.length === 1)).toBe(true);
    await jest.advanceTimersByTimeAsync(WS_REDIS_SOCKET_TIMEOUT_MS + 3000);
    redis.resumeSubscribers();
    expect(await settle(() => idle() && redis.pings === 1)).toBe(true);
    await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS);

    expect(await settle(() => sub.status !== 'ready', 500)).toBe(false);
    expect(redis.connections).toBe(connections);
    expect(warned('Socket timeout')).toBe(0);
  }, 20_000);
});
