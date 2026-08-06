/**
 * In-process rate limiting for the `/events` Socket.IO gateway.
 *
 * WebSocket frames never pass through the Nest enhancer pipeline, so the global
 * guards/pipes (including the HTTP throttler) do not apply here — the gateway enforces
 * its own limits:
 *   1. per-key token bucket on client frames (subscribe/unsubscribe/ping),
 *   2. pre-auth per-IP sliding window on new handshakes (gates the DB key validation),
 *   3. a cap on simultaneous sockets per API key (enforced in the gateway, which already
 *      tracks sockets per key for eviction).
 *
 * Default rationale (legitimate traffic is far below every limit):
 *   - Frames: the dashboard sends a small burst of subscribe frames at page mount
 *     (~8, one per event group) and afterwards only occasional ping/unsubscribe frames;
 *     server→client event volume is irrelevant here (only client→server frames are
 *     limited). 60 frames/s sustained is ~6x headroom over the connect burst and a
 *     120-token burst absorbs several dashboard tabs mounting at once, while still
 *     bounding a flooding key to a survivable validate/subscribe rate.
 *   - Handshakes: Socket.IO auto-reconnect backs off exponentially (~6 attempts/min
 *     per tab); 10/min per IP leaves room for a few tabs re-mounting together and stops
 *     an unauthenticated handshake flood from hitting the DB validate on every attempt.
 *   - Sockets: 16 concurrent sockets per key covers multi-tab dashboards plus SDK
 *     clients sharing one key; anything beyond it is almost certainly a leak or abuse.
 *
 * In-memory per-process, like the MCP limiters; move to Redis for multi-instance
 * deployments. Both limiter maps are capped with approximate LRU eviction so a
 * distinct-key (or spoofed-IP) flood cannot grow process memory without limit.
 */

const DEFAULT_FRAME_PER_SECOND = 60;
const DEFAULT_FRAME_BURST = 120;
const DEFAULT_HANDSHAKE_MAX = 10;
const DEFAULT_HANDSHAKE_WINDOW_MS = 60_000;
const DEFAULT_MAX_SOCKETS_PER_KEY = 16;
const DEFAULT_MAX_KEYS = 50_000;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
};

export interface WsRateLimitConfig {
  framePerSecond: number;
  frameBurst: number;
  handshakeMax: number;
  handshakeWindowMs: number;
  maxSocketsPerKey: number;
}

/**
 * Read the WebSocket rate-limit configuration from the environment.
 * Falls back to the default for any missing, blank, non-positive, or non-numeric value
 * (same rule as the MCP limiters).
 */
export function readWsRateLimitConfig(env: NodeJS.ProcessEnv = process.env): WsRateLimitConfig {
  return {
    framePerSecond: parsePositiveInt(env['WS_RATE_LIMIT_FRAME_PER_SECOND'], DEFAULT_FRAME_PER_SECOND),
    frameBurst: parsePositiveInt(env['WS_RATE_LIMIT_FRAME_BURST'], DEFAULT_FRAME_BURST),
    handshakeMax: parsePositiveInt(env['WS_RATE_LIMIT_HANDSHAKE_MAX'], DEFAULT_HANDSHAKE_MAX),
    handshakeWindowMs: parsePositiveInt(env['WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS'], DEFAULT_HANDSHAKE_WINDOW_MS),
    maxSocketsPerKey: parsePositiveInt(env['WS_MAX_SOCKETS_PER_KEY'], DEFAULT_MAX_SOCKETS_PER_KEY),
  };
}

/** Evict oldest-inserted keys once `map` exceeds `maxKeys` (approximate LRU when callers re-set on touch). */
function evictOverflow<K, V>(map: Map<K, V>, maxKeys: number): void {
  while (map.size > Math.max(1, maxKeys)) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Per-subject token bucket: `capacity` tokens, refilled at `refillPerSecond`. A subject may
 * burst up to the capacity and is then shaped to the sustained rate — no hard rejection of
 * normal connect-time bursts, no unbounded throughput for a flooding key.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly refillPerSecond = DEFAULT_FRAME_PER_SECOND,
    private readonly capacity = DEFAULT_FRAME_BURST,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {}

  /** Consume one token for `subject`; returns false (without consuming) when the bucket is empty. */
  allow(subject: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(subject);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: t };
    } else if (t > bucket.lastRefill) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + ((t - bucket.lastRefill) * this.refillPerSecond) / 1000);
      bucket.lastRefill = t;
    }
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    // Touch on every check so an active abuser cannot drift to the LRU head, be evicted,
    // and receive a fresh bucket during a distinct-subject flood.
    this.buckets.delete(subject);
    this.buckets.set(subject, bucket);
    evictOverflow(this.buckets, this.maxKeys);
    return allowed;
  }
}

/**
 * Per-subject sliding-window counter (fixed `max` events per `windowMs`). Same shape as the
 * MCP KeyRateLimiter but returns a boolean instead of throwing an HttpException, since the
 * WS surface answers with an error frame, not an HTTP status.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = DEFAULT_HANDSHAKE_MAX,
    private readonly windowMs = DEFAULT_HANDSHAKE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {}

  /** Record one attempt for `subject`; returns false when it exceeds `max` inside the window. */
  allow(subject: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(subject) ?? []).filter(ts => t - ts < this.windowMs);
    const allowed = recent.length < this.max;
    if (allowed) recent.push(t);

    this.hits.delete(subject);
    this.hits.set(subject, recent);
    evictOverflow(this.hits, this.maxKeys);
    return allowed;
  }

  /**
   * Give back the most recent attempt recorded for `subject`.
   *
   * The handshake window is consumed BEFORE authentication (that is the point — an unauthenticated
   * flood must not reach the DB key validation on every attempt), which also charges every
   * legitimate connect. Behind a NAT or a reverse proxy without TRUSTED_PROXIES every client shares
   * one subject, so a handful of dashboards re-mounting could exhaust the window between them.
   * Refunding a handshake that turned out to be authentic keeps the budget aimed at failures;
   * authenticated abuse is bounded separately by the per-key socket cap.
   */
  refund(subject: string): void {
    const recent = this.hits.get(subject);
    if (!recent?.length) return;
    recent.pop();
  }
}
