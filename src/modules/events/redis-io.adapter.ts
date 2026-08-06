import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type RedisOptions } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { createLogger } from '../../common/services/logger.service';

const logger = createLogger('RedisIoAdapter');

/** Max time to await a graceful `quit()` per client on shutdown before force-disconnecting. */
export const WS_REDIS_QUIT_TIMEOUT_MS = 2000;

/**
 * Whether cross-replica WebSocket fan-out is switched on. Same `REDIS_ENABLED === 'true'` gate the
 * throttler and cache read at boot, so a deployment already using Redis for those gets event
 * fan-out with no extra flag, and a single-node deployment (the default) never opens a connection.
 */
export function isWsRedisEnabled(): boolean {
  return process.env.REDIS_ENABLED === 'true';
}

/** ioredis options for the pub/sub pair, mirroring the throttler/cache connection env exactly. */
export function wsRedisOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '5000', 10),
    // The adapter's SUBSCRIBE connection cannot issue ordinary commands, so a bounded retry that
    // gives up (returning null) would strand fan-out permanently after one blip. Reconnect forever
    // with capped backoff, matching the cache client.
    retryStrategy: times => Math.min(times * 500, 5000),
  };
}

/**
 * A Socket.IO server whose broadcasts reach clients connected to OTHER replicas, via the Redis
 * pub/sub adapter.
 *
 * The gateway already broadcasts to rooms (`server.to(room).emit(...)`); the default in-memory
 * adapter only reaches sockets on THIS process, so a client connected to replica A never sees an
 * event raised on replica B. Attaching the Redis adapter on the root `io` — before any namespace
 * is used — makes every namespace, including `/events`, fan its room broadcasts out through Redis.
 * No emit site changes.
 *
 * SCOPE (honest): this distributes event FAN-OUT only. Key eviction (`socketsByKeyId`), the WS
 * rate-limit buckets, and the engine registry remain process-local — a key revoked on replica A
 * still tears down only A's sockets, and per-key WS limits are counted per replica. See
 * docs/13-horizontal-scaling.md.
 *
 * Failure posture: if the pub/sub clients cannot be created the server falls back to the in-memory
 * adapter — the local node keeps working, only cross-node fan-out is lost — rather than refusing to
 * boot. A Redis outage after boot is ioredis's problem to retry; the adapter recovers on reconnect.
 */
export class RedisIoAdapter extends IoAdapter {
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (!isWsRedisEnabled()) return server;

    try {
      const pubClient = new Redis(wsRedisOptions());
      const subClient = pubClient.duplicate();
      for (const [name, client] of [
        ['pub', pubClient],
        ['sub', subClient],
      ] as const) {
        client.on('error', err => logger.warn(`Redis ${name} client error: ${err.message}`));
      }
      this.pubClient = pubClient;
      this.subClient = subClient;
      server.adapter(createAdapter(pubClient, subClient));
      logger.log('WebSocket events fan out across replicas via the Redis adapter');
    } catch (error) {
      logger.error(
        'Could not attach the Redis WebSocket adapter; falling back to single-node event delivery. ' +
          'Events raised on other replicas will not reach clients connected here.',
        error instanceof Error ? error.stack : String(error),
      );
    }
    return server;
  }

  /** Close the pub/sub connections so a shutdown does not leak them. Called by Nest on app close. */
  async close(server: Server): Promise<void> {
    // Socket.IO's adapters unsubscribe from their Redis channels as the server closes. Tearing the
    // clients down FIRST left those unsubscribes to be issued on dead clients, and each rejection
    // surfaced as an unhandled rejection — a handful of ERROR lines on every graceful shutdown, for
    // a shutdown that had in fact gone fine. Close the server first, then release the pair.
    await super.close(server);
    await Promise.allSettled([this.quitClient(this.pubClient), this.quitClient(this.subClient)]);
    this.pubClient = undefined;
    this.subClient = undefined;
  }

  /**
   * Release one client on shutdown without ever blocking. `quit()` waits for the QUIT reply, which
   * never arrives on a half-open/partitioned socket — and with the never-give-up retryStrategy and
   * ioredis's default `enableOfflineQueue:true`, quit() is queued and hangs indefinitely rather
   * than rejecting. Race it against a short deadline, then ALWAYS `disconnect()` in the finally so
   * the socket and its reconnect timer are gone regardless of connection state (mirrors
   * CacheService/RedisThrottlerStorage). disconnect() is idempotent after a clean quit.
   */
  private async quitClient(client: Redis | undefined): Promise<void> {
    if (!client) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(resolve, WS_REDIS_QUIT_TIMEOUT_MS);
      timer.unref();
    });
    try {
      await Promise.race([client.quit().catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      client.disconnect();
    }
  }
}
