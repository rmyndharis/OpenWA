/**
 * The adapter is the whole opt-in surface for cross-replica fan-out, so what has to hold is narrow
 * and load-bearing: it attaches the Redis adapter ONLY when Redis is enabled, never opens a
 * connection otherwise (a single-node deployment must pay nothing), survives a client-construction
 * failure by falling back rather than crashing the boot, and closes both connections on shutdown.
 */

const redisInstances: FakeRedis[] = [];

class FakeRedis {
  readonly handlers: Record<string, (err: Error) => void> = {};
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();
  status = 'ready';
  ping = jest.fn().mockResolvedValue('PONG');
  readonly sent = jest.fn().mockResolvedValue(1);
  publish(channel: string, message: string): Promise<number> {
    return this.sent(channel, message) as Promise<number>;
  }
  constructor(public readonly opts?: unknown) {
    redisInstances.push(this);
  }
  on(event: string, handler: (err: Error) => void): this {
    this.handlers[event] = handler;
    return this;
  }
}

jest.mock('ioredis', () => ({ __esModule: true, default: FakeRedis }));

// The mock's return references its args, so createAdapter(pub, sub) yields an identifiable value
// carrying both clients — proving both that it was called with the pair and that its result is
// what gets handed to server.adapter().
const createAdapterMock = jest.fn((pub: unknown, sub: unknown) => ({ tag: 'redis-adapter-fn', pub, sub }));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (pub: unknown, sub: unknown) => createAdapterMock(pub, sub),
}));

import {
  RedisIoAdapter,
  isWsRedisEnabled,
  wsRedisOptions,
  WS_REDIS_COMMAND_TIMEOUT_MS,
  WS_REDIS_MAX_UNANSWERED,
  WS_REDIS_QUIT_TIMEOUT_MS,
  WS_REDIS_SOCKET_TIMEOUT_MS,
  WS_REDIS_SUBSCRIBER_PING_MS,
  WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS,
} from './redis-io.adapter';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server } from 'socket.io';

describe('RedisIoAdapter', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    redisInstances.length = 0;
    createAdapterMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  type NamespaceMiddleware = (socket: unknown, next: (error?: Error) => void) => void;

  const fakeServer = (): {
    server: Server;
    adapterFn: jest.Mock;
    namespaceOf: jest.Mock;
    rootUse: jest.Mock<void, [NamespaceMiddleware]>;
  } => {
    const adapterFn = jest.fn();
    const rootUse = jest.fn<void, [NamespaceMiddleware]>();
    const namespaceOf = jest.fn(() => ({ use: rootUse }));
    return { server: { adapter: adapterFn, of: namespaceOf } as unknown as Server, adapterFn, namespaceOf, rootUse };
  };

  /** Stub the base createIOServer so no real socket.io server is spun up. */
  const withBaseServer = (server: Server): jest.SpyInstance => {
    return jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(server);
  };

  describe('isWsRedisEnabled', () => {
    it('is true only for the exact string "true"', () => {
      process.env.REDIS_ENABLED = 'true';
      expect(isWsRedisEnabled()).toBe(true);
      for (const v of ['false', 'True', '1', '']) {
        process.env.REDIS_ENABLED = v;
        expect(isWsRedisEnabled()).toBe(false);
      }
      delete process.env.REDIS_ENABLED;
      expect(isWsRedisEnabled()).toBe(false);
    });
  });

  describe('wsRedisOptions', () => {
    it('maps the same REDIS_* env the cache/throttler read', () => {
      process.env.REDIS_HOST = 'redis.internal';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret';
      const opts = wsRedisOptions();
      expect(opts.host).toBe('redis.internal');
      expect(opts.port).toBe(6380);
      expect(opts.password).toBe('secret');
      // Reconnect-forever so a blip never strands the SUBSCRIBE connection.
      expect(typeof opts.retryStrategy).toBe('function');
      expect((opts.retryStrategy as (n: number) => number)(100)).toBe(5000);
    });

    it('connects over TLS when REDIS_TLS=true', () => {
      process.env.REDIS_TLS = 'true';
      try {
        expect(wsRedisOptions().tls).toEqual({});
      } finally {
        delete process.env.REDIS_TLS;
      }
    });
  });

  describe('createIOServer', () => {
    it('opens no Redis connection and does not touch the adapter when Redis is disabled', () => {
      delete process.env.REDIS_ENABLED;
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(adapter.createIOServer(2785)).toBe(server);
        expect(redisInstances).toHaveLength(0);
        expect(adapterFn).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it.each(['true', undefined])('refuses the root namespace whether or not Redis is enabled (%s)', enabled => {
      if (enabled === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = enabled;
      const { server, namespaceOf, rootUse } = fakeServer();
      const spy = withBaseServer(server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        expect(namespaceOf).toHaveBeenCalledWith('/');
        const [middleware] = rootUse.mock.calls[0];
        const next = jest.fn();
        middleware({}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid namespace' }));
      } finally {
        spy.mockRestore();
      }
    });

    // Gateway options such as the client frame bound reach the Socket.IO server through this call.
    it.each(['true', undefined])('hands the server options to the base server untouched (%s)', enabled => {
      if (enabled === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = enabled;
      const spy = withBaseServer(fakeServer().server);
      try {
        const options = { maxHttpBufferSize: 8192 };
        new RedisIoAdapter({} as never).createIOServer(0, options as never);
        expect(spy).toHaveBeenCalledWith(0, options);
      } finally {
        spy.mockRestore();
      }
    });

    it('attaches the Redis adapter with a pub/sub pair when Redis is enabled', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        // pub and sub = two clients, both given an error handler.
        expect(redisInstances).toHaveLength(2);
        expect(redisInstances[0].handlers.error).toBeDefined();
        expect(redisInstances[1].handlers.error).toBeDefined();
        expect(createAdapterMock).toHaveBeenCalledWith(redisInstances[0], redisInstances[1]);
        expect(adapterFn).toHaveBeenCalledWith(
          expect.objectContaining({ tag: 'redis-adapter-fn', pub: redisInstances[0], sub: redisInstances[1] }),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps the subscriber commands queued for as long as Redis is down at boot', () => {
      process.env.REDIS_ENABLED = 'true';
      const spy = withBaseServer(fakeServer().server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub, sub] = redisInstances as [FakeRedis, FakeRedis];
        // The adapter subscribes once; a flushed SUBSCRIBE is never sent again, so the sub client
        // must not give up on it. The publisher stays bounded.
        expect((sub.opts as { maxRetriesPerRequest?: unknown }).maxRetriesPerRequest).toBeNull();
        expect((pub.opts as { maxRetriesPerRequest?: unknown }).maxRetriesPerRequest).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    // A Redis that keeps the connection open and stops answering never errors the publisher's socket, so only
    // its own deadlines release what it holds. The subscriber gets a socket deadline of its own, which its pings
    // arm, and nothing else: a rejected or dropped command would strand its one-time SUBSCRIBE, while a destroyed
    // socket does not, since ioredis subscribes again on the next connection.
    it('puts the command deadlines on the publisher only, and a socket deadline on each', () => {
      process.env.REDIS_ENABLED = 'true';
      const spy = withBaseServer(fakeServer().server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub, sub] = redisInstances as [FakeRedis, FakeRedis];
        expect(pub.opts).toMatchObject({
          commandTimeout: WS_REDIS_COMMAND_TIMEOUT_MS,
          socketTimeout: WS_REDIS_SOCKET_TIMEOUT_MS,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
        });
        // Both are real deadlines, and the socket may not be cut off before a command has had its full time: the
        // socket timer runs on this process's own event loop, so a short one drops healthy connections.
        expect(Number.isFinite(WS_REDIS_COMMAND_TIMEOUT_MS)).toBe(true);
        expect(Number.isFinite(WS_REDIS_SOCKET_TIMEOUT_MS)).toBe(true);
        expect(WS_REDIS_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(WS_REDIS_COMMAND_TIMEOUT_MS);
        // The figure docs/13 and the adapter comment quote ("a pause under 10 s is delivered late", "at most 10 s of
        // events"): the other tests derive their waits from the constant and would follow it to any value.
        expect(WS_REDIS_SOCKET_TIMEOUT_MS).toBe(10_000);
        for (const option of ['commandTimeout', 'enableOfflineQueue', 'autoResendUnfulfilledCommands']) {
          expect(sub.opts).not.toHaveProperty(option);
        }
        expect(sub.opts).toMatchObject({
          maxRetriesPerRequest: null,
          socketTimeout: WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it('gives a failed publish an owner, since the adapter drops the promise it returns', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const spy = withBaseServer(server);
      try {
        new RedisIoAdapter({} as never).createIOServer(2785);
        const [pub] = redisInstances;
        // What ioredis does to every publish queued during an outage once its retries run out.
        pub.sent.mockRejectedValueOnce(new Error('Reached the max retries per request limit (which is 20).'));
        await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
        await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
        expect(pub.sent).toHaveBeenCalledWith('socket.io#/events#', 'frame');
      } finally {
        spy.mockRestore();
      }
    });

    // The cap reads the length of the client's command queue, which ioredis keeps on an internal property.
    describe('the cap on unanswered commands', () => {
      const withPublisher = async (
        queue: { length: number } | undefined,
        check: (pub: FakeRedis) => Promise<void>,
      ): Promise<void> => {
        process.env.REDIS_ENABLED = 'true';
        const spy = withBaseServer(fakeServer().server);
        try {
          new RedisIoAdapter({} as never).createIOServer(2785);
          const [pub] = redisInstances;
          if (queue) (pub as unknown as { commandQueue: { length: number } }).commandQueue = queue;
          await check(pub);
        } finally {
          spy.mockRestore();
        }
      };

      it('pins the figures docs/13 quotes, and a 10 s silence at 1000 events a second fits under them', () => {
        expect(WS_REDIS_MAX_UNANSWERED).toBe(12_000);
        expect(WS_REDIS_MAX_UNANSWERED).toBeGreaterThanOrEqual((WS_REDIS_SOCKET_TIMEOUT_MS / 1000) * 1000 * 1.2);
        // "Up to about 1,200 events a second" in docs/13: the rate at which a pause of one socket deadline fills the cap.
        expect(WS_REDIS_MAX_UNANSWERED / (WS_REDIS_SOCKET_TIMEOUT_MS / 1000)).toBe(1200);
      });

      // Slowness is judged by how long the backlog has lasted, not by its depth: a burst raised in one tick is all on the
      // queue before any reply can be read.
      it('does not cut a deep queue that is new, however large', async () => {
        const queue = { length: 0 };
        await withPublisher(queue, async pub => {
          await pub.publish('socket.io#/events#', 'frame');
          queue.length = WS_REDIS_MAX_UNANSWERED * 2;
          await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
          expect(pub.sent).toHaveBeenCalledTimes(2);
        });
      });

      it('drops frames once the queue is at the cap and has been above half of it for longer than a command is given', async () => {
        let clock = 5_000;
        const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
        const queue = { length: 0 };
        try {
          await withPublisher(queue, async pub => {
            await pub.publish('socket.io#/events#', 'frame');
            queue.length = WS_REDIS_MAX_UNANSWERED / 2;
            clock += WS_REDIS_COMMAND_TIMEOUT_MS;
            // At the cap, but only exactly as long as a command is given: not yet.
            queue.length = WS_REDIS_MAX_UNANSWERED;
            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
            clock += 1;
            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
            expect(pub.sent).toHaveBeenCalledTimes(2);
            // Dropping goes on until the queue is back below half the cap, not until it is below the cap.
            queue.length = WS_REDIS_MAX_UNANSWERED - 1;
            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
            queue.length = WS_REDIS_MAX_UNANSWERED / 2;
            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
            queue.length = WS_REDIS_MAX_UNANSWERED / 2 - 1;
            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
            expect(pub.sent).toHaveBeenCalledTimes(3);
          });
        } finally {
          now.mockRestore();
        }
      });

      // The age comes from a monotonic clock. The wall clock can step backwards (an NTP correction, a VM resumed), and
      // an age taken from it would be negative for as long as the step is large, leaving a slow Redis uncapped.
      it('is not blinded by the wall clock stepping back while the backlog ages', async () => {
        let monotonic = 5_000;
        let wall = 1_700_000_000_000;
        const mono = jest.spyOn(performance, 'now').mockImplementation(() => monotonic);
        const wallClock = jest.spyOn(Date, 'now').mockImplementation(() => wall);
        const queue = { length: 0 };
        try {
          await withPublisher(queue, async pub => {
            await pub.publish('socket.io#/events#', 'frame');
            queue.length = WS_REDIS_MAX_UNANSWERED / 2;
            monotonic += WS_REDIS_COMMAND_TIMEOUT_MS + 1;
            wall -= 60_000;
            queue.length = WS_REDIS_MAX_UNANSWERED;

            await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(0);
            expect(pub.sent).toHaveBeenCalledTimes(1);
          });
        } finally {
          mono.mockRestore();
          wallClock.mockRestore();
        }
      });

      it('warns once when an episode starts and once when it ends, each with its own count', async () => {
        let clock = 5_000;
        const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const lines = (text: string): string[] =>
          warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes(text));
        const queue = { length: 0 };
        try {
          await withPublisher(queue, async pub => {
            const episode = async (frames: number): Promise<void> => {
              queue.length = 0;
              await pub.publish('socket.io#/events#', 'frame');
              queue.length = WS_REDIS_MAX_UNANSWERED / 2;
              clock += WS_REDIS_COMMAND_TIMEOUT_MS + 1;
              queue.length = WS_REDIS_MAX_UNANSWERED;
              for (let frame = 0; frame < frames; frame++) await pub.publish('socket.io#/events#', 'frame');
              queue.length = 0;
              await pub.publish('socket.io#/events#', 'frame');
              await pub.publish('socket.io#/events#', 'frame');
            };

            await episode(5);
            await episode(2);

            expect(lines('fan-out frames are dropped')).toHaveLength(2);
            const ended = lines('were dropped');
            expect(ended).toHaveLength(2);
            expect(ended[0]).toContain('5 fan-out frames');
            expect(ended[1]).toContain('2 fan-out frames');
          });
        } finally {
          now.mockRestore();
          warn.mockRestore();
        }
      });

      it('applies no cap, and does not fail, when the client exposes no command queue', async () => {
        await withPublisher(undefined, async pub => {
          await expect(pub.publish('socket.io#/events#', 'frame')).resolves.toBe(1);
          expect(pub.sent).toHaveBeenCalledTimes(1);
        });
      });
    });

    it('falls back to the base server (no crash) if wiring the adapter throws', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      adapterFn.mockImplementation(() => {
        throw new Error('adapter boom');
      });
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(() => adapter.createIOServer(2785)).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // The subscriber only receives, so a connection that stops answering without being closed shows nothing until TCP
  // keepalive gives up, and never behind a proxy that keeps its side open. A ping arms the socket deadline that
  // replaces it.
  describe('the subscriber ping', () => {
    const withSubscriber = async (
      check: (pub: FakeRedis, sub: FakeRedis, adapter: RedisIoAdapter, server: Server) => Promise<void>,
    ): Promise<void> => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances as [FakeRedis, FakeRedis];
        await check(pub, sub, adapter, server);
      } finally {
        jest.useRealTimers();
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    };

    it('pins the figures docs/13 quotes, and keeps the subscriber through a pause the publisher gives up on', () => {
      expect(WS_REDIS_SUBSCRIBER_PING_MS).toBe(15_000);
      expect(WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS).toBe(30_000);
      expect(WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS).toBeGreaterThan(WS_REDIS_SOCKET_TIMEOUT_MS);
      // "At most about 45 s": a flow dropped right after an answered ping, the next ping, then the deadline.
      expect(WS_REDIS_SUBSCRIBER_PING_MS + WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS).toBe(45_000);
    });

    it('pings the subscriber every interval while it is ready, and never while it is not', async () => {
      await withSubscriber(async (pub, sub) => {
        await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS - 1);
        expect(sub.ping).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(sub.ping).toHaveBeenCalledTimes(1);

        // A ping issued while reconnecting would wait in the offline queue for as long as the outage lasts.
        sub.status = 'reconnecting';
        await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS * 4);
        expect(sub.ping).toHaveBeenCalledTimes(1);

        sub.status = 'ready';
        await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS);
        expect(sub.ping).toHaveBeenCalledTimes(2);
        expect(pub.ping).not.toHaveBeenCalled();
      });
    });

    it('gives a failed ping an owner', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        await withSubscriber(async (_pub, sub) => {
          sub.ping.mockRejectedValue(new Error('Connection is closed.'));
          await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS);
          await new Promise(resolve => setImmediate(resolve));
          expect(sub.ping).toHaveBeenCalledTimes(1);
        });
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('does not keep the process alive with its timer', () => {
      process.env.REDIS_ENABLED = 'true';
      const spy = withBaseServer(fakeServer().server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const timer = (adapter as unknown as { subPing: NodeJS.Timeout }).subPing;
        expect(timer.hasRef()).toBe(false);
        clearInterval(timer);
      } finally {
        spy.mockRestore();
      }
    });

    it('stops pinging once the adapter is closed', async () => {
      await withSubscriber(async (_pub, sub, adapter, server) => {
        await adapter.close(server);
        await jest.advanceTimersByTimeAsync(WS_REDIS_SUBSCRIBER_PING_MS * 3);
        expect(sub.ping).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      });
    });
  });

  describe('close', () => {
    it('quits both pub and sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;

        await adapter.close(server);

        expect(pub.quit).toHaveBeenCalledTimes(1);
        expect(sub.quit).toHaveBeenCalledTimes(1);
        // Always release the socket, so a clean quit still can't leave the reconnect timer alive.
        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    // The server must close BEFORE the clients are released: the namespace adapters unsubscribe as
    // the server closes, and issuing those on already-quit clients surfaced as a handful of
    // unhandled-rejection ERRORs on every graceful shutdown.
    it('closes the server before releasing the pub/sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const order: string[] = [];
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockImplementation(() => {
        order.push('super.close');
        return Promise.resolve();
      });
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        pub.quit.mockImplementation(() => {
          order.push('pub.quit');
          return Promise.resolve();
        });
        sub.quit.mockImplementation(() => {
          order.push('sub.quit');
          return Promise.resolve();
        });

        await adapter.close(server);

        expect(order[0]).toBe('super.close');
        expect(order).toContain('pub.quit');
        expect(order).toContain('sub.quit');
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('does not hang when quit() never resolves (Redis down at shutdown), then force-disconnects', async () => {
      jest.useFakeTimers();
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        // The exact outage shape: quit() queued to the offline queue, never settles.
        pub.quit.mockReturnValue(new Promise(() => undefined));
        sub.quit.mockReturnValue(new Promise(() => undefined));

        const closed = adapter.close(server);
        // Drive the per-client deadline; without it the await would block forever.
        await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS + 10);
        await expect(closed).resolves.toBeUndefined();

        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        jest.useRealTimers();
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('is safe to close when Redis was never enabled (no clients to quit)', async () => {
      delete process.env.REDIS_ENABLED;
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        await expect(adapter.close(server)).resolves.toBeUndefined();
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });
  });
});
