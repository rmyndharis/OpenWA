import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';

// Single-node, in-process keyed lock: a chain of promises per key. The ordering key is a plain
// string (no closures) so a distributed lock (e.g. Redis redlock / SET NX PX) can replace this
// verbatim once ingress runs on more than one node.
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Chain fn after prev; swallow prev's rejection so one failure doesn't poison the chain.
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    // Clean up the map entry once this is the tail and it settles, to avoid unbounded growth.
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}

/** The slice of ioredis this lock uses — also the fake seam for the spec. */
export interface OrderingRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, key: string, token: string): Promise<unknown>;
}

/** GET==token → DEL, atomically: never release a lock that expired and was re-acquired elsewhere. */
const RELEASE_IF_OWNED = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Cross-process keyed lock: Redis SET NX PX with a fenced (compare-and-del) release, wrapped
 * AROUND the in-process chain. The local chain still provides FIFO within one pod and keeps
 * same-pod contention off Redis; the Redis lock is what makes two pods' ingress workers unable to
 * interleave dispatches for one conversation — the ordering guarantee that silently vanished the
 * moment a second pod consumed the same BullMQ queue.
 *
 * Mutual exclusion, not global FIFO: cross-pod arrival order is already decided by queue delivery,
 * which BullMQ does not order across workers — what must not happen is two dispatches for the same
 * conversation RUNNING at once, and that is what this prevents.
 *
 * Degrades deliberately: a Redis error (not contention) falls back to the local chain for that call
 * and logs once — when Redis is down the BullMQ queues feeding this path are down too, so the
 * remaining traffic is single-pod-shaped and locally correct.
 */
export class DistributedKeyedLock {
  private readonly logger = createLogger('DistributedKeyedLock');
  private readonly local = new KeyedAsyncLock();
  private degradedLogged = false;

  constructor(
    private readonly scope: string,
    private readonly redis: OrderingRedis,
    private readonly options: { ttlMs?: number; retryDelayMs?: number; maxWaitMs?: number } = {},
  ) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.local.run(key, () => this.runDistributed(key, fn));
  }

  private async runDistributed<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const ttlMs = this.options.ttlMs ?? 60_000;
    const retryDelayMs = this.options.retryDelayMs ?? 50;
    const maxWaitMs = this.options.maxWaitMs ?? 60_000;
    const redisKey = `openwa:lock:${this.scope}:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + maxWaitMs;

    try {
      for (;;) {
        const acquired = await this.redis.set(redisKey, token, 'PX', ttlMs, 'NX');
        if (acquired === 'OK') break;
        if (Date.now() >= deadline) {
          // Surface as an error, not a silent unordered run: the job retries via BullMQ backoff,
          // re-entering the lock later — order within the conversation stays protected.
          throw new Error(`ordering lock wait exceeded ${maxWaitMs}ms for ${redisKey}`);
        }
        await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ordering lock wait exceeded')) throw error;
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        this.logger.warn('Redis unavailable for the ordering lock — degraded to in-process ordering', {
          scope: this.scope,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return fn(); // already inside the local chain — single-pod ordering still holds
    }

    try {
      return await fn();
    } finally {
      await Promise.resolve(this.redis.eval(RELEASE_IF_OWNED, 1, redisKey, token)).catch(() => undefined);
    }
  }
}

/**
 * The lock construction sites use: in-process by default, Redis-backed the moment REDIS_ENABLED is
 * on (the same switch that turns on the multi-pod BullMQ consumers that make cross-pod ordering a
 * real concern). The ioredis client is created lazily so single-node deployments never load it.
 */
export function createOrderingLock(scope: string): Pick<KeyedAsyncLock, 'run'> {
  if (process.env.REDIS_ENABLED !== 'true') return new KeyedAsyncLock();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const IORedis = require('ioredis') as new (options: object) => OrderingRedis;
  const client = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '5000', 10),
    // Fail fast into the degraded path instead of queueing commands while Redis is down.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  return new DistributedKeyedLock(scope, client);
}

// Key on the CONVERSATION, never the deliveryId (a delivery-unique key would serialize nothing).
// providerConversationId is populated host-side when the plugin manifest declares a conversationId
// pointer; absent it, we serialize per instance — correct (never reorders within a conversation) but
// coarse. Per-instance fallback is the lazy-correct default; the conversation key unlocks
// intra-instance parallelism once the manifest declares the pointer.
export function orderingKeyFor(job: IngressJobData): string {
  if (job.providerConversationId) return `${job.instanceId}:${job.providerConversationId}`;
  return `instance:${job.instanceId}`;
}
