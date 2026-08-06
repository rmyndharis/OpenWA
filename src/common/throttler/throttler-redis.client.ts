import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/**
 * Upper bound for one throttler command. The storage fails OPEN on command error, so a bounded
 * rejection is how a slow/partitioned Redis degrades to "allow" instead of stalling the request.
 * It also settles commands ioredis drops on reconnect (autoResendUnfulfilledCommands: false below),
 * which would otherwise never resolve.
 */
export const THROTTLER_REDIS_COMMAND_TIMEOUT_MS = 2000;

/**
 * Client options for the throttler's Redis backend, tuned so the fail-open posture of
 * RedisThrottlerStorage engages IMMEDIATELY instead of after a stall:
 *
 * - enableOfflineQueue: false — a command issued while disconnected rejects at once
 *   ("Stream isn't writeable...") rather than sitting in the offline queue until reconnect.
 *   The default (queue + flush on recovery) both stalls every request for seconds and replays
 *   the non-idempotent INCR evals late, corrupting the fixed-window counts.
 * - autoResendUnfulfilledCommands: false — an eval in flight when the socket dies is NOT resent
 *   after reconnect: a resent INCR can double-count (if it already ran server-side) or land in a
 *   fresh window. Dropping it is safe because commandTimeout settles the awaiting caller.
 * - commandTimeout — per-command deadline covering the two cases above (dropped in-flight
 *   commands never settle on their own) plus a live-but-slow Redis.
 * - maxRetriesPerRequest: null — disables ioredis's periodic pending-queue flush; with the
 *   offline queue disabled there is nothing to flush, and per-command latency is bounded by
 *   commandTimeout instead of a retry counter.
 */
export function buildThrottlerRedisOptions(configService: ConfigService): RedisOptions {
  return {
    host: configService.get<string>('redis.host', 'localhost'),
    port: configService.get<number>('redis.port', 6379),
    username: configService.get<string>('redis.username'),
    password: configService.get<string>('redis.password'),
    connectTimeout: configService.get<number>('redis.connectTimeoutMs', 5000),
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    commandTimeout: THROTTLER_REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: null,
  };
}

/** Dedicated client for throttler hit-count storage — separate from cache/queue clients. */
export function createThrottlerRedisClient(configService: ConfigService): Redis {
  return new Redis(buildThrottlerRedisOptions(configService));
}
