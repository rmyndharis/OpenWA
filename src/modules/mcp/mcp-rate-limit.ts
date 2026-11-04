import { HttpException, HttpStatus } from '@nestjs/common';
import { positiveIntOrDefault } from '../../common/utils/env-int';
import { SlidingWindowLimiter } from '../events/ws-rate-limit';

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_MS = 60_000;
// Pre-auth per-IP budget: more generous than the per-key one so a legitimate multi-key host behind one
// IP (e.g. a shared proxy) isn't starved, while still bounding an unauthenticated key-probing flood.
const DEFAULT_IP_MAX = 120;
const DEFAULT_MAX_KEYS = 50_000;

/**
 * Read MCP rate-limit configuration from the environment.
 * Falls back to the default for any missing, blank, non-positive, or non-numeric value.
 */
export function readRateLimitConfig(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: positiveIntOrDefault(env['MCP_RATE_LIMIT_MAX'], DEFAULT_MAX),
    windowMs: positiveIntOrDefault(env['MCP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
  };
}

/**
 * Read the PRE-AUTH per-IP MCP throttle config. Independent of the per-key vars above (which must not
 * bleed in), with the same blank/non-positive/non-numeric fallback.
 */
export function readIpRateLimitConfig(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: positiveIntOrDefault(env['MCP_IP_RATE_LIMIT_MAX'], DEFAULT_IP_MAX),
    windowMs: positiveIntOrDefault(env['MCP_IP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
  };
}

/**
 * Per-API-key sliding window rate limiter.
 * The inherited IP-keyed throttler collapses all MCP calls into one 127.0.0.1 bucket,
 * so MCP needs its own per-key limiter.
 * In-memory per-process; move to Redis for multi-instance deployments. The key map is capped with
 * approximate LRU eviction so a distinct-key flood cannot grow process memory without limit.
 */
export class KeyRateLimiter {
  private readonly window: SlidingWindowLimiter;

  constructor(max = 60, windowMs = 60_000, now: () => number = () => Date.now(), maxKeys = DEFAULT_MAX_KEYS) {
    this.window = new SlidingWindowLimiter(max, windowMs, now, maxKeys);
  }

  check(key: string): void {
    if (!this.window.allow(key)) {
      throw new HttpException('MCP rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
