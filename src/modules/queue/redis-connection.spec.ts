import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import Redis from 'ioredis';
import {
  ingressWorkerConcurrency,
  producerConnectWaitMs,
  producerReady,
  QUEUE_COMMAND_TIMEOUT_MS,
  QUEUE_SOCKET_TIMEOUT_MS,
  queueConnectionOptions,
  queuePrefix,
  queueRootOptions,
  workerConnectionOptions,
  webhookWorkerConcurrency,
} from './redis-connection';

describe('workerConnectionOptions (webhook Worker connection)', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does NOT disable the offline queue — the Worker must tolerate a brief Redis reconnect', () => {
    // The producer sets enableOfflineQueue:false for fast-fail; the Worker must keep ioredis's default
    // (true). Asserting it is absent guards against the regression where the Worker inherited the
    // producer-only fast-fail from the shared connection and threw "Stream isn't writeable" on a blip.
    const opts = workerConnectionOptions() as unknown as Record<string, unknown>;
    expect(opts.enableOfflineQueue).toBeUndefined();
  });

  it('sets no command timeout, socket timeout, or autoResend override: the Worker blocks on Redis by design', () => {
    const opts = workerConnectionOptions() as unknown as Record<string, unknown>;
    expect(opts.commandTimeout).toBeUndefined();
    expect(opts.socketTimeout).toBeUndefined();
    expect(opts.autoResendUnfulfilledCommands).toBeUndefined();
  });

  it('gives the producer socketTimeout below commandTimeout and disables autoResendUnfulfilledCommands', () => {
    expect(QUEUE_SOCKET_TIMEOUT_MS).toBe(1500);
    expect(QUEUE_SOCKET_TIMEOUT_MS).toBeLessThan(QUEUE_COMMAND_TIMEOUT_MS);

    const opts = queueConnectionOptions();
    expect(opts.enableOfflineQueue).toBe(false);
    expect(opts.commandTimeout).toBe(QUEUE_COMMAND_TIMEOUT_MS);
    expect(opts.socketTimeout).toBe(QUEUE_SOCKET_TIMEOUT_MS);
    expect(opts.autoResendUnfulfilledCommands).toBe(false);
  });

  it('reads host/port/username/password/connectTimeout from env with safe defaults', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_USERNAME;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    expect(workerConnectionOptions()).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      connectTimeout: 5000,
    });

    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_USERNAME = 'myuser';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_CONNECT_TIMEOUT_MS = '1234';
    expect(workerConnectionOptions()).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'myuser',
      password: 'secret',
      connectTimeout: 1234,
    });
  });

  it('connects the Worker and the producer over TLS when REDIS_TLS=true', () => {
    process.env = { ...ORIGINAL_ENV, REDIS_TLS: 'true' };
    expect(workerConnectionOptions().tls).toEqual({});
    expect(queueConnectionOptions()).toMatchObject({ tls: {}, enableOfflineQueue: false });
  });
});

/** Parse complete RESP arrays off the front of `buf`; `keep` receives any incomplete tail. */
function parseRespCommands(buf: Buffer, keep: (rest: Buffer) => void): string[][] {
  const commands: string[][] = [];
  let offset = 0;
  for (;;) {
    if (buf[offset] !== 0x2a) break;
    const eol = buf.indexOf('\r\n', offset);
    if (eol < 0) break;
    const count = Number.parseInt(buf.toString('utf8', offset + 1, eol), 10);
    let cursor = eol + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i++) {
      const lenEnd = buf.indexOf('\r\n', cursor);
      if (lenEnd < 0) break;
      const length = Number.parseInt(buf.toString('utf8', cursor + 1, lenEnd), 10);
      if (buf.length < lenEnd + 2 + length + 2) break;
      args.push(buf.toString('utf8', lenEnd + 2, lenEnd + 2 + length));
      cursor = lenEnd + 2 + length + 2;
    }
    if (args.length < count) break;
    commands.push(args);
    offset = cursor;
  }
  keep(buf.subarray(offset));
  return commands;
}

describe('queueConnectionOptions on a Redis that stops answering', () => {
  // The socket stays open and nothing comes back, as in a network partition or a frozen Redis process.
  // Without a deadline every producer call (the queue add of a delivery, a job lookup) then never settles,
  // so the dispatch slot or the ingress request holding it never frees and the fallback never runs.
  let server: Server;
  let sockets: Socket[];
  let answering: boolean;
  let received: Array<{ socketIndex: number; args: string[] }>;
  let client: Redis;

  beforeEach(async () => {
    sockets = [];
    answering = true;
    received = [];
    server = createServer(socket => {
      const socketIndex = sockets.length;
      sockets.push(socket);
      socket.on('error', () => undefined);
      let pending: Buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        for (const args of parseRespCommands(pending, rest => (pending = rest))) {
          received.push({ socketIndex, args });
          if (!answering) continue;
          const name = (args[0] ?? '').toLowerCase();
          if (name === 'hello') {
            socket.write("-ERR unknown command 'hello'\r\n");
          } else if (name === 'info') {
            const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
            socket.write(`$${info.length}\r\n${info}\r\n`);
          } else if (name === 'client') {
            socket.write('+OK\r\n');
          } else if (name === 'ping') {
            socket.write('+PONG\r\n');
          } else {
            socket.write('$-1\r\n');
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new Redis({
      ...queueConnectionOptions(),
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      retryStrategy: () => 50,
    });
    client.on('error', () => undefined);
    // With no offline queue, a command issued before the connect rejects at once.
    await new Promise(resolve => client.once('ready', resolve));
  });

  afterEach(async () => {
    client.disconnect();
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
  });

  it('rejects a command that gets no reply, instead of holding its caller for good', async () => {
    await expect(client.get('first')).resolves.toBeNull();
    answering = false;

    const budget = (queueConnectionOptions() as { commandTimeout?: number }).commandTimeout ?? 2000;
    const outcome = await Promise.race([
      client.get('second').then(
        () => 'answered',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>(resolve => setTimeout(resolve, budget + 1500, 'still waiting')),
    ]);

    expect(outcome).toMatch(/timed out/i);
  }, 10_000);

  it('tears down the dead socket at socketTimeout and fast-fails subsequent commands immediately', async () => {
    await expect(client.get('warm')).resolves.toBeNull();
    const initialSocket = sockets[0];
    let socketClosedAt: number | undefined;
    const socketClosed = new Promise<void>(resolve =>
      initialSocket.once('close', () => {
        socketClosedAt = Date.now();
        resolve();
      }),
    );

    answering = false;
    const startedAt = Date.now();
    const firstCmd = client.get('stalled-first').catch((err: unknown) => err);

    // Dead socket must be torn down around QUEUE_SOCKET_TIMEOUT_MS (1500ms), before QUEUE_COMMAND_TIMEOUT_MS (2000ms).
    const closedOutcome = await Promise.race([
      socketClosed.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(resolve, QUEUE_COMMAND_TIMEOUT_MS + 200, 'still-open')),
    ]);
    expect(closedOutcome).toBe('closed');
    const tearDownMs = (socketClosedAt ?? Date.now()) - startedAt;
    expect(tearDownMs).toBeGreaterThanOrEqual(1300);
    expect(tearDownMs).toBeLessThan(QUEUE_COMMAND_TIMEOUT_MS + 100);

    // Wait for the first stalled command to settle via commandTimeout.
    const firstErr = await firstCmd;
    expect(firstErr).toBeInstanceOf(Error);

    // Because the dead socket was torn down and enableOfflineQueue is false, an immediate second
    // command fails fast (<50ms) instead of waiting another 2000ms commandTimeout.
    const secondStart = Date.now();
    const secondErr = await client.get('fast-fail-second').catch((err: unknown) => err);
    const secondElapsedMs = Date.now() - secondStart;
    expect(secondErr).toBeInstanceOf(Error);
    expect((secondErr as Error).message).toMatch(/enableOfflineQueue|closed/i);
    expect(secondElapsedMs).toBeLessThan(50);
  }, 10_000);

  it('does not resend the unfulfilled command after the server accepts a reconnect', async () => {
    await expect(client.get('warm')).resolves.toBeNull();
    const initialSocket = sockets[0];
    const socketClosed = new Promise<void>(resolve => initialSocket.once('close', resolve));

    answering = false;
    const stalled = client.get('do-not-resend').catch((err: unknown) => err);

    // Wait until the client tears down the stalled socket (or fail if socketTimeout never fired).
    const closedOutcome = await Promise.race([
      socketClosed.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(resolve, QUEUE_COMMAND_TIMEOUT_MS + 200, 'still-open')),
    ]);
    expect(closedOutcome).toBe('closed');

    // Bring the server back so the client reconnects and becomes ready on a fresh socket.
    const reconnected = new Promise<void>(resolve => client.once('ready', resolve));
    answering = true;
    await reconnected;

    // Issue a fresh command to verify the reconnected socket is healthy and flush any buffered pipeline.
    await expect(client.get('after-reconnect')).resolves.toBeNull();

    // Ensure the original stalled command rejected and was never resent on the new connection.
    const stalledErr = await stalled;
    expect(stalledErr).toBeInstanceOf(Error);
    const sentStalled = received.filter(
      entry => entry.args[0]?.toLowerCase() === 'get' && entry.args[1] === 'do-not-resend',
    );
    expect(sentStalled).toHaveLength(1);
    expect(sentStalled[0].socketIndex).toBe(0);
  }, 10_000);
});

describe('webhookWorkerConcurrency', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to 10 so deliveries do not serialize behind one slow receiver', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WEBHOOK_WORKER_CONCURRENCY;
    expect(webhookWorkerConcurrency()).toBe(10);
  });

  it('honors a positive override', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '25' };
    expect(webhookWorkerConcurrency()).toBe(25);
  });

  it('falls back to the default for a non-positive/garbage override', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '0' };
    expect(webhookWorkerConcurrency()).toBe(10);
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: 'abc' };
    expect(webhookWorkerConcurrency()).toBe(10);
  });

  it('does not read the leading digits of a unit-suffixed value', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '5abc' };
    expect(webhookWorkerConcurrency()).toBe(10);
    process.env = { ...ORIGINAL_ENV, INGRESS_WORKER_CONCURRENCY: '5abc' };
    expect(ingressWorkerConcurrency()).toBe(10);
  });
});

describe('queue key prefix', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('leaves the prefix out when unset or blank, so BullMQ keeps its own and queued jobs survive an upgrade', () => {
    for (const value of [undefined, '', '   ']) {
      process.env = { ...ORIGINAL_ENV };
      if (value === undefined) delete process.env.QUEUE_PREFIX;
      else process.env.QUEUE_PREFIX = value;
      expect(queuePrefix()).toBeUndefined();
      expect(queueRootOptions()).not.toHaveProperty('prefix');
    }
  });

  it('hands the configured prefix, trimmed, to the root options next to the producer connection', () => {
    process.env = { ...ORIGINAL_ENV, QUEUE_PREFIX: ' staging ' };
    expect(queuePrefix()).toBe('staging');
    expect(queueRootOptions()).toEqual({ connection: queueConnectionOptions(), prefix: 'staging' });
  });
});

describe('producerReady', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  /** A queue whose first connect completes after `connectMs`, or never when undefined. */
  const queueReadyAfter = (connectMs?: number) => ({
    waitUntilReady: () =>
      new Promise<never>(resolve => {
        if (connectMs !== undefined) setTimeout(resolve, connectMs);
      }),
  });

  /** Settle state of `promise` once the fake clock has advanced `ms`. */
  async function settledAfter(promise: Promise<void>, ms: number): Promise<string> {
    const state = promise.then(
      () => 'resolved',
      (error: Error) => `rejected: ${error.message}`,
    );
    let result = 'pending';
    void state.then(s => (result = s));
    await jest.advanceTimersByTimeAsync(ms);
    return result;
  }

  it('waits for a first connect that lands within REDIS_CONNECT_TIMEOUT_MS', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    await expect(settledAfter(producerReady(queueReadyAfter(900)), 900)).resolves.toBe('resolved');
  });

  it('rejects once REDIS_CONNECT_TIMEOUT_MS passes without a connect', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    const ready = producerReady(queueReadyAfter());
    await expect(settledAfter(ready, 999)).resolves.toBe('pending');
    await expect(settledAfter(ready, 1)).resolves.toBe('rejected: Redis has not connected within 1000ms');
  });

  it('still waits the default for a first connect when REDIS_CONNECT_TIMEOUT_MS is 0', async () => {
    // 0 turns off the socket connect timeout; it must not skip a healthy queue that is still connecting.
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '0' };
    await expect(settledAfter(producerReady(queueReadyAfter(20)), 20)).resolves.toBe('resolved');

    const never = producerReady(queueReadyAfter());
    await expect(settledAfter(never, 4999)).resolves.toBe('pending');
    await expect(settledAfter(never, 1)).resolves.toBe('rejected: Redis has not connected within 5000ms');
  });

  it('keeps the connect window from holding the process, so a wait open at shutdown cannot delay the exit', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    const startTimer = jest.spyOn(global, 'setTimeout');

    const ready = producerReady(queueReadyAfter());
    const timers = startTimer.mock.results.map(result => result.value as NodeJS.Timeout);
    startTimer.mockRestore();

    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    const expired = expect(ready).rejects.toThrow('Redis has not connected within 1000ms');
    await jest.advanceTimersByTimeAsync(1000);
    await expired;
  });

  it('caps the wait at the Node timer ceiling instead of overflowing to 1 ms', async () => {
    // Above the ceiling a Node timer fires after 1 ms and would skip a healthy queue that is connecting.
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '3000000000' };
    expect(producerConnectWaitMs()).toBe(2147483647);
    await expect(settledAfter(producerReady(queueReadyAfter()), 1000)).resolves.toBe('pending');
  });

  // Each wait on BullMQ's pending connect holds memory until Redis connects, which may be never.
  it('shares one wait per queue: calls after an expired window reject at once until Redis connects', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    let connect!: () => void;
    const queue = { waitUntilReady: jest.fn(() => new Promise<void>(resolve => (connect = resolve))) };

    const first = producerReady(queue);
    await expect(settledAfter(first, 600)).resolves.toBe('pending');
    const inWindow = producerReady(queue);
    await expect(settledAfter(inWindow, 400)).resolves.toBe('rejected: Redis has not connected within 1000ms');
    await expect(settledAfter(first, 0)).resolves.toBe('rejected: Redis has not connected within 1000ms');

    await expect(settledAfter(producerReady(queue), 0)).resolves.toBe(
      'rejected: Redis has not connected within 1000ms',
    );
    expect(queue.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    connect();
    await jest.advanceTimersByTimeAsync(0);
    await expect(settledAfter(producerReady(queue), 0)).resolves.toBe('resolved');
    expect(queue.waitUntilReady).toHaveBeenCalledTimes(1);
  });
});
