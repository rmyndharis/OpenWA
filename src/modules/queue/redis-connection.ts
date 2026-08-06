/**
 * BullMQ Redis connection options for the WEBHOOK queue's Worker.
 *
 * The webhook PRODUCER (the Queue) is configured on the shared `BullModule.forRootAsync` connection
 * with `enableOfflineQueue: false`, so `queue.add()` fails fast when Redis is unreachable and the
 * dispatch path can fall back to direct delivery instead of buffering forever.
 *
 * The WORKER must NOT inherit that producer-only fast-fail. Its blocking/internal commands
 * (moveToActive, lock renewal) need to tolerate a brief reconnect during a Redis blip/failover;
 * BullMQ explicitly recommends leaving the offline queue enabled for Worker connections. Because
 * @nestjs/bullmq otherwise builds the Worker from the same shared connection, the WebhookProcessor
 * overrides its connection with these options — host/port/username/password/timeout identical to the producer
 * (same env vars, same defaults as configuration.ts), but with the offline queue left at ioredis's
 * default of `true` so a transient outage no longer throws "Stream isn't writeable" and stalls jobs.
 */
export interface WorkerConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  connectTimeout: number;
}

export function workerConnectionOptions(): WorkerConnectionOptions {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '5000', 10),
  };
}

/** Default number of webhook deliveries the Worker processes in parallel. */
const DEFAULT_WEBHOOK_WORKER_CONCURRENCY = 10;

/**
 * Webhook Worker concurrency. BullMQ defaults a Worker to 1, which serializes ALL webhook deliveries
 * process-wide: one slow or timing-out receiver head-of-line-blocks every other session's webhooks
 * until it finishes (up to WEBHOOK_TIMEOUT + retries). Running several in parallel decouples healthy
 * receivers from a stuck one. Override via WEBHOOK_WORKER_CONCURRENCY; a non-positive/garbage value
 * falls back to the default. (Read at module import like workerConnectionOptions above.)
 */
export function webhookWorkerConcurrency(): number {
  const parsed = parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_WORKER_CONCURRENCY;
}

/** Default number of ingress events the Worker processes in parallel. */
const DEFAULT_INGRESS_WORKER_CONCURRENCY = 10;

/**
 * Ingress Worker concurrency. Ordering within a conversation is now guaranteed by the
 * per-conversation KeyedAsyncLock in the processor, not by a single-worker queue, so raising
 * concurrency here parallelizes unrelated conversations instead of head-of-line-blocking every
 * inbound event behind the slowest one. Override via INGRESS_WORKER_CONCURRENCY; a
 * non-positive/garbage value falls back to the default.
 */
export function ingressWorkerConcurrency(): number {
  const parsed = parseInt(process.env.INGRESS_WORKER_CONCURRENCY || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INGRESS_WORKER_CONCURRENCY;
}
