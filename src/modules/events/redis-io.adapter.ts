import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type RedisOptions } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { createLogger } from '../../common/services/logger.service';
import { redisConnectionOptions } from '../../config/redis-options';

const logger = createLogger('RedisIoAdapter');

/** Max time to await a graceful `quit()` per client on shutdown before force-disconnecting. */
export const WS_REDIS_QUIT_TIMEOUT_MS = 2000;

/**
 * How long the promise of one fan-out publish waits for its reply. Only the promise: the command stays on the
 * wire, and a Redis that was merely slow still delivers it, so this bounds nothing the client holds.
 */
export const WS_REDIS_COMMAND_TIMEOUT_MS = 2000;

/**
 * How long the publish client's socket may stay silent after a write before it is destroyed, which is what
 * stops a stalled Redis from filling the client. The timer runs on this process's own event loop, so a healthy
 * Redis looks silent whenever the loop stays blocked for that long right after a write, and the connection would
 * be dropped for nothing. That is why it sits far above any block this process runs, and above the command
 * timeout. It bounds a Redis that sends nothing: after this long the socket is destroyed and nothing more is
 * held. What was already held, at most this many seconds of events, stays until the client has reconnected. A
 * Redis that answers, however slowly, resets the timer with every reply, and is bounded by
 * WS_REDIS_MAX_UNANSWERED instead.
 */
export const WS_REDIS_SOCKET_TIMEOUT_MS = 10_000;

/**
 * How often the subscriber connection is pinged. It only receives, so a connection that stops answering without
 * being closed (a NAT or a firewall that drops the flow, a proxy that keeps its own side open) would otherwise go
 * unnoticed until TCP keepalive gives up, or for good behind such a proxy, and the node would miss what the other
 * replicas publish meanwhile. A ping arms the subscriber's socket deadline, so a connection that does not answer is
 * replaced, and its subscriptions restored, within this interval plus WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS.
 */
export const WS_REDIS_SUBSCRIBER_PING_MS = 15_000;

/**
 * How long the subscriber's socket may stay silent after a ping before it is destroyed. Above the publisher's
 * deadline on purpose: a replaced subscriber misses what Redis delivers before it has subscribed again, so through
 * a pause longer than WS_REDIS_SOCKET_TIMEOUT_MS this node still receives, late, what the others had written before
 * their own deadline, rather than losing it. Up to this long a pause costs nothing more than it did without pings.
 */
export const WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Most commands the publisher keeps written and unanswered once the backlog has lasted. A Redis that answers slower
 * than events are raised never trips the socket deadline, so without a cap the backlog grows with the load for as
 * long as the slowness lasts. The rule: frames are dropped for the other replicas while the queue holds this many
 * commands and has not been below half of it for longer than a command is given to be answered
 * (WS_REDIS_COMMAND_TIMEOUT_MS), and they go on being dropped until the queue is back below half of it. Depth alone
 * says nothing, since a burst raised in one tick is all on the queue before a reply can be read, so such a burst is
 * not cut as long as raising it past half the cap takes less than a command is given. One that takes longer, a
 * synchronous loop that cannot yield for over 2 s, is cut at the cap whatever the peer is doing, and the warning
 * names the unanswered count. Dropping starts with a warning and ends with another, with the count. The queue can
 * pass the cap by the traffic of one command deadline before dropping starts. 12,000 holds a full socket deadline
 * of traffic at 1,000 events a second with a fifth to spare, which measured about 25 MB of heap with 1 KiB frames.
 * It counts commands, not bytes: events with inline media are larger.
 */
export const WS_REDIS_MAX_UNANSWERED = 12_000;

/** The queue length below which a backlog counts as over, and dropped frames are published again. */
const WS_REDIS_RESUME_UNANSWERED = WS_REDIS_MAX_UNANSWERED / 2;

/**
 * Commands the client has written and not had answered. ioredis keeps them on an internal queue; if this version
 * does not expose it, the answer is 0 and the cap does nothing, so a change of ioredis loses the bound rather than
 * the fan-out (the socket deadline still applies).
 */
function unansweredCommands(client: Redis): number {
  const queue = (client as unknown as { commandQueue?: { length?: unknown } }).commandQueue;
  return typeof queue?.length === 'number' ? queue.length : 0;
}

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
    ...redisConnectionOptions(),
    // The adapter's SUBSCRIBE connection cannot issue ordinary commands, so a bounded retry that
    // gives up (returning null) would strand fan-out permanently after one blip. Reconnect forever
    // with capped backoff, matching the cache client.
    retryStrategy: times => Math.min(times * 500, 5000),
  };
}

/**
 * Socket.IO always creates the root namespace `/` and accepts a CONNECT to it with no middleware, while
 * everything this gateway enforces (the handshake limit, the per-key socket cap, the audit rows) lives on
 * `/events`. The 45 s connect timeout only closes a peer that joined no namespace at all, so a peer that
 * joins `/` and answers pings would stay connected for ever, outside every limit. Refusing `/` leaves such a
 * peer unjoined, and the timeout reaps it. No client of this gateway uses the root namespace.
 */
export function rejectRootNamespace(server: Server): void {
  server.of('/').use((_socket, next) => next(new Error('Invalid namespace')));
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
 * boot. A Redis outage, at boot or after it, is ioredis's problem to retry; the adapter recovers on reconnect.
 * The subscriber only listens, so a connection that stops answering without being closed errors nothing until TCP
 * keepalive gives up, and never when a proxy in the path keeps its side open: it is pinged every
 * WS_REDIS_SUBSCRIBER_PING_MS and replaced, and subscribed again, when an answer takes longer than
 * WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS.
 *
 * Delivery while Redis is away or slow: the fan-out to the other replicas is best effort and keeps no replay
 * queue. A Redis that pauses for less than WS_REDIS_SOCKET_TIMEOUT_MS answers afterwards, and every event raised
 * meanwhile reaches them late, at up to about 1,200 events a second; above that the cap below applies first, and
 * drops the frames beyond it. Silence for that long destroys the publisher's socket, and so does a restart, a
 * failover or an outage: what was written to the dropped connection may be lost with it, or may still reach the
 * other replicas late and after newer events. A subscriber whose ping waits through a silence longer than
 * WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS is replaced too, and this node then misses what the others had published
 * into it. The events this node raises while it is disconnected, plus its reconnect backoff of up to 5 s once Redis
 * is back (wsRedisOptions), are dropped for the other replicas, never delivered late and never twice. A Redis that
 * keeps answering, but slower than events are raised, never looks silent: it is bounded by WS_REDIS_MAX_UNANSWERED,
 * which drops frames for the other replicas once the backlog has outlived a command's deadline and until it is back
 * below half of it (a burst raised in one tick is not cut unless raising it past half the cap takes over 2 s).
 * Clients on this node are served by the local broadcast and webhooks do not use this path, so neither is
 * affected. What the publisher holds is bounded by one socket deadline of traffic for a silent Redis and by that
 * cap, plus the traffic of one command deadline, for a slow one.
 */
export class RedisIoAdapter extends IoAdapter {
  private pubClient?: Redis;
  private subClient?: Redis;
  private subPing?: NodeJS.Timeout;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    rejectRootNamespace(server);
    if (!isWsRedisEnabled()) return server;

    try {
      // The publisher is the only client that waits for replies, and a Redis that keeps the connection open but
      // stops answering (a frozen process, a stalled disk) never errors it: every broadcast would wait in the
      // client, payload and all, for as long as the stall lasts. So the promise of a command the peer does not
      // answer in time is rejected (the command stays on the wire, so a slow Redis still delivers it), a socket
      // that stays silent for the socket deadline is destroyed and the client reconnects, nothing is queued for
      // a connection it does not have, and nothing the old socket may already have delivered is sent again. An
      // event raised while disconnected is therefore dropped for the other replicas rather than replayed late.
      // A silent Redis holds at most one socket deadline of traffic; a slow one that keeps answering is held to
      // WS_REDIS_MAX_UNANSWERED (see there for the rule) by the wrapper below.
      const pubClient = new Redis({
        ...wsRedisOptions(),
        commandTimeout: WS_REDIS_COMMAND_TIMEOUT_MS,
        socketTimeout: WS_REDIS_SOCKET_TIMEOUT_MS,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
      });
      // The adapter issues its SUBSCRIBE/PSUBSCRIBE once, at construction. With a bounded per-request
      // retry, an outage at boot flushes them before Redis is ever reached, and ioredis only replays
      // subscriptions the server confirmed, so the replica would never subscribe. This connection
      // carries nothing else, so keep its commands queued until the first connect. Nothing waits on
      // its replies, so the publisher's command deadline and dropped queues do not apply to it. A
      // socket deadline of its own does, armed by the pings below: a destroyed socket loses no
      // subscription, since on the next ready ioredis subscribes again to what the server had
      // confirmed and resends the commands it had not answered.
      const subClient = new Redis({
        ...wsRedisOptions(),
        maxRetriesPerRequest: null,
        socketTimeout: WS_REDIS_SUBSCRIBER_SOCKET_TIMEOUT_MS,
      });
      for (const [name, client] of [
        ['pub', pubClient],
        ['sub', subClient],
      ] as const) {
        client.on('error', err => logger.warn(`Redis ${name} client error: ${err.message}`));
      }
      // The adapter fires publish() on every broadcast and drops the promise. During an outage each of
      // those commands is rejected, so every event emitted meanwhile surfaced as an unhandled
      // rejection. The 'error' listener above already reports the outage once; a fan-out frame without a
      // confirmed delivery is only worth a debug line. A timed-out command was still written, and a slow
      // Redis delivers it late; one rejected for lack of a connection was never sent.
      const publish = pubClient.publish.bind(pubClient);
      let dropping = false;
      let dropped = 0;
      // When the queue was last seen below half the cap: the backlog is as old as the time since. Read from the
      // monotonic clock: the wall clock can step back (an NTP correction, a resumed VM), and an age taken from it
      // would be negative for as long as the step is large, leaving a slow Redis uncapped.
      let lastBelowResume = 0;
      pubClient.publish = (channel: string, message: string | Buffer) => {
        const unanswered = unansweredCommands(pubClient);
        const now = performance.now();
        if (unanswered < WS_REDIS_RESUME_UNANSWERED) {
          lastBelowResume = now;
          if (dropping) {
            logger.warn(`Redis caught up; ${dropped} fan-out frames were dropped for the other replicas`);
            dropping = false;
            dropped = 0;
          }
        } else if (
          !dropping &&
          unanswered >= WS_REDIS_MAX_UNANSWERED &&
          now - lastBelowResume > WS_REDIS_COMMAND_TIMEOUT_MS
        ) {
          // Nothing else reports a Redis that answers slowly, so the start of an episode is warned about.
          dropping = true;
          logger.warn(
            `Redis has ${unanswered} fan-out frames unanswered; fan-out frames are dropped for the other replicas until it catches up`,
          );
        }
        if (dropping) {
          dropped++;
          return Promise.resolve(0);
        }
        return publish(channel, message).catch((err: Error) => {
          logger.debug(`Redis publish not confirmed: ${err.message}`);
          return 0;
        });
      };
      this.pubClient = pubClient;
      this.subClient = subClient;
      server.adapter(createAdapter(pubClient, subClient));
      // Only a ready connection is pinged: one issued while reconnecting would wait in the offline queue
      // for as long as the outage lasts. A failed ping needs nothing more, the deadline or the next ping
      // covers the connection. The timer alone does not keep the process alive.
      this.subPing = setInterval(() => {
        if (subClient.status === 'ready') subClient.ping().catch(() => undefined);
      }, WS_REDIS_SUBSCRIBER_PING_MS).unref();
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
    // a shutdown that had in fact gone fine. Close the server first, then release the pair. Under
    // forceCloseConnections Nest skips the server close when the socket.io server shares the HTTP
    // server, so only the pub/sub pair is released here and the HTTP close tears the sockets down.
    clearInterval(this.subPing);
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
