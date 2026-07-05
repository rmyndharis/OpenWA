import { HttpException, HttpStatus } from '@nestjs/common';

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_MS = 60_000;
// Pre-auth per-IP budget: more generous than the per-key one so a legitimate multi-key host behind one
// IP (e.g. a shared proxy) isn't starved, while still bounding an unauthenticated key-probing flood.
const DEFAULT_IP_MAX = 120;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
};

/**
 * Read MCP rate-limit configuration from the environment.
 * Falls back to the default for any missing, blank, non-positive, or non-numeric value.
 */
export function readRateLimitConfig(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: parsePositiveInt(env['MCP_RATE_LIMIT_MAX'], DEFAULT_MAX),
    windowMs: parsePositiveInt(env['MCP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
  };
}

/**
 * Read the PRE-AUTH per-IP MCP throttle config. Independent of the per-key vars above (which must not
 * bleed in), with the same blank/non-positive/non-numeric fallback.
 */
export function readIpRateLimitConfig(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: parsePositiveInt(env['MCP_IP_RATE_LIMIT_MAX'], DEFAULT_IP_MAX),
    windowMs: parsePositiveInt(env['MCP_IP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
  };
}

/**
 * Per-API-key sliding window rate limiter.
 * The inherited IP-keyed throttler collapses all MCP calls into one 127.0.0.1 bucket,
 * so MCP needs its own per-key limiter.
 * In-memory per-process; move to Redis for multi-instance deployments.
 */
export class KeyRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(ts => t - ts < this.windowMs);
    if (recent.length === 0) {
      // All prior hits have expired — prune the bucket rather than accumulating stale entries.
      this.hits.delete(key);
    }
    if (recent.length >= this.max) {
      throw new HttpException('MCP rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(t);
    this.hits.set(key, recent);
  }
}
