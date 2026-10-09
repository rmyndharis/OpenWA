import type { Queue } from 'bullmq';
import { MAX_TIMER_MS, resolveNonNegativeIntEnv } from '../../config/configuration';
import {
  DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
  redisConnectionOptions,
  type RedisConnectionOptions,
} from '../../config/redis-options';

/**
 * BullMQ connection for the shared producer (`BullModule.forRootAsync` in queue.module.ts): the common
 * Redis fields plus `enableOfflineQueue: false`, so once connected, `queue.add()` fails fast when Redis
 * drops and the dispatch path can fall back to direct delivery instead of buffering forever. Before the
 * first connect that option never applies: see producerReady.
 */
export function queueConnectionOptions(): RedisConnectionOptions & { enableOfflineQueue: false } {
  return { ...redisConnectionOptions(), enableOfflineQueue: false };
}

/**
 * How long producerReady waits for a producer queue's first connect: REDIS_CONNECT_TIMEOUT_MS, or the
 * default when it is 0 (see producerReady), capped at MAX_TIMER_MS. Above that a Node timer fires after
 * 1 ms, which would bypass a healthy Redis at boot. Node truncates ioredis's socket connect timeout to
 * the same ceiling.
 */
export function producerConnectWaitMs(): number {
  return Math.min(redisConnectionOptions().connectTimeout || DEFAULT_REDIS_CONNECT_TIMEOUT_MS, MAX_TIMER_MS);
}

/** Per producer queue: whether its first connect has landed, and the shared wait for it. */
const firstConnects = new WeakMap<object, { connected: boolean; wait: Promise<void> }>();

/**
 * Resolve once a producer queue has connected; reject if its first connect has not landed within
 * REDIS_CONNECT_TIMEOUT_MS of the first call. Until that connect, BullMQ holds every queue call without
 * sending a command, and its default retry strategy never gives up, so with Redis unreachable since
 * boot a call never settles. Await this before each producer call so the caller's fallback runs
 * instead. The wait is opened once per queue and shared: calls inside that window wait for its end,
 * later calls reject at once until Redis connects (each call subscribing to BullMQ's pending connect
 * would hold memory until it lands), and any call after a connect resolves at once. A setting of 0
 * (no socket connect timeout in ioredis) still opens a window of the default: rejecting at once would
 * bypass a healthy queue during startup, and waiting forever would bring the hang back. The window's
 * timer is unref'd, so a wait still open at shutdown never holds the process alive.
 */
export async function producerReady(queue: Pick<Queue, 'waitUntilReady'>): Promise<void> {
  let first = firstConnects.get(queue);
  if (!first) {
    const timeoutMs = producerConnectWaitMs();
    const ready = queue.waitUntilReady();
    let timer: NodeJS.Timeout | undefined;
    const wait = Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis has not connected within ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
    const entry = { connected: false, wait };
    ready.then(
      () => (entry.connected = true),
      () => undefined,
    );
    firstConnects.set(queue, (first = entry));
  }
  if (!first.connected) await first.wait;
}

/**
 * BullMQ connection for the webhook and ingress Workers. It must NOT inherit the producer-only
 * fast-fail above: the Worker's blocking/internal commands (moveToActive, lock renewal) need to
 * tolerate a brief reconnect during a Redis blip/failover, and BullMQ recommends leaving the offline
 * queue enabled for Worker connections. @nestjs/bullmq would otherwise build the Worker from the shared
 * connection, so each processor passes these options instead; without the override a transient outage
 * throws "Stream isn't writeable" and stalls jobs.
 */
export function workerConnectionOptions(): RedisConnectionOptions {
  return redisConnectionOptions();
}

/** Default number of webhook deliveries the Worker processes in parallel. */
const DEFAULT_WEBHOOK_WORKER_CONCURRENCY = 10;

/**
 * Webhook Worker concurrency. BullMQ defaults a Worker to 1, which serializes ALL webhook deliveries
 * process-wide: one slow or timing-out receiver head-of-line-blocks every other session's webhooks
 * until it finishes (up to WEBHOOK_TIMEOUT + retries). Running several in parallel lets healthy
 * receivers proceed while a few slots wait on a stuck one. The pool is shared, and each attempt
 * against a dead receiver holds a slot for up to WEBHOOK_TIMEOUT, so the processor caps how many
 * jobs to failing receivers one session starts at once (WEBHOOK_DEGRADED_SESSION_CONCURRENCY,
 * default a quarter of this value; a job already running when the failure lands is not counted)
 * and returns the rest to the delayed set. Size this value above that cap times the number of
 * sessions whose receivers may fail at once, or those sessions fill the pool. Override via
 * WEBHOOK_WORKER_CONCURRENCY; unset or blank uses the default, and any other value that is not a
 * positive integer fails boot validation (env.validation.ts). (Read at module import like
 * workerConnectionOptions above.)
 */
export function webhookWorkerConcurrency(): number {
  return resolveNonNegativeIntEnv(process.env.WEBHOOK_WORKER_CONCURRENCY, 0) || DEFAULT_WEBHOOK_WORKER_CONCURRENCY;
}

/** Default number of ingress events the Worker processes in parallel. */
const DEFAULT_INGRESS_WORKER_CONCURRENCY = 10;

/**
 * Ingress Worker concurrency. Ordering within a conversation is now guaranteed by the
 * per-conversation KeyedAsyncLock in the processor, not by a single-worker queue, so raising
 * concurrency here parallelizes unrelated conversations. A job waiting on a busy key still holds a
 * slot, though: a burst on one key larger than this value blocks every other key until it drains.
 * Size it above the largest expected per-key burst; the key is the whole instance unless the route
 * declares a conversationId pointer. Override via INGRESS_WORKER_CONCURRENCY; unset or blank uses
 * the default, and any other value that is not a positive integer fails boot validation
 * (env.validation.ts).
 */
export function ingressWorkerConcurrency(): number {
  return resolveNonNegativeIntEnv(process.env.INGRESS_WORKER_CONCURRENCY, 0) || DEFAULT_INGRESS_WORKER_CONCURRENCY;
}
