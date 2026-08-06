import { readWsRateLimitConfig, TokenBucketLimiter, SlidingWindowLimiter } from './ws-rate-limit';

describe('readWsRateLimitConfig', () => {
  it('returns the documented defaults when no env vars are set', () => {
    expect(readWsRateLimitConfig({})).toEqual({
      framePerSecond: 60,
      frameBurst: 120,
      handshakeMax: 10,
      handshakeWindowMs: 60_000,
      maxSocketsPerKey: 16,
    });
  });

  it('reads every override from the environment', () => {
    expect(
      readWsRateLimitConfig({
        WS_RATE_LIMIT_FRAME_PER_SECOND: '5',
        WS_RATE_LIMIT_FRAME_BURST: '9',
        WS_RATE_LIMIT_HANDSHAKE_MAX: '3',
        WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS: '15000',
        WS_MAX_SOCKETS_PER_KEY: '4',
      }),
    ).toEqual({
      framePerSecond: 5,
      frameBurst: 9,
      handshakeMax: 3,
      handshakeWindowMs: 15_000,
      maxSocketsPerKey: 4,
    });
  });

  it('falls back to the default for blank, non-numeric, or non-positive values', () => {
    const bogus = ['', '   ', 'abc', '0', '-3', '1.5x'];
    for (const raw of bogus) {
      const cfg = readWsRateLimitConfig({ WS_RATE_LIMIT_FRAME_PER_SECOND: raw, WS_MAX_SOCKETS_PER_KEY: raw });
      expect(cfg.framePerSecond).toBe(60);
      expect(cfg.maxSocketsPerKey).toBe(16);
    }
  });
});

describe('TokenBucketLimiter (per-key frame budget)', () => {
  let nowMs: number;
  const now = () => nowMs;
  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('allows a burst up to the capacity, then rejects the frame above the bucket', () => {
    const limiter = new TokenBucketLimiter(60, 4, now);
    for (let i = 0; i < 4; i++) {
      expect(limiter.allow('k1')).toBe(true);
    }
    expect(limiter.allow('k1')).toBe(false);
    // A rejected frame consumes nothing: still rejected on the immediate retry.
    expect(limiter.allow('k1')).toBe(false);
  });

  it('refills at the sustained per-second rate (recovery after the burst)', () => {
    const limiter = new TokenBucketLimiter(2, 3, now);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(false);

    nowMs += 1_000; // 2 tokens refill at 2/s
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(false);
  });

  it('never refills beyond the burst capacity', () => {
    const limiter = new TokenBucketLimiter(10, 2, now);
    expect(limiter.allow('k1')).toBe(true);
    nowMs += 60_000; // idle long enough to refill hundreds of tokens
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(false);
  });

  it('meters subjects independently', () => {
    const limiter = new TokenBucketLimiter(1, 1, now);
    expect(limiter.allow('k1')).toBe(true);
    expect(limiter.allow('k1')).toBe(false);
    expect(limiter.allow('k2')).toBe(true);
  });

  it('caps the subject map so a distinct-subject flood cannot grow memory without limit', () => {
    const limiter = new TokenBucketLimiter(1, 1, now, 100);
    for (let i = 0; i < 500; i++) {
      limiter.allow(`flood-${i}`);
    }
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});

describe('SlidingWindowLimiter (pre-auth per-IP handshake budget)', () => {
  let nowMs: number;
  const now = () => nowMs;
  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('allows up to max attempts inside the window and rejects the next one', () => {
    const limiter = new SlidingWindowLimiter(3, 60_000, now);
    expect(limiter.allow('203.0.113.5')).toBe(true);
    expect(limiter.allow('203.0.113.5')).toBe(true);
    expect(limiter.allow('203.0.113.5')).toBe(true);
    expect(limiter.allow('203.0.113.5')).toBe(false);
  });

  it('does not count rejected attempts against the window', () => {
    const limiter = new SlidingWindowLimiter(1, 1_000, now);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false); // rejected: must not extend the lockout
    nowMs += 1_001;
    expect(limiter.allow('ip')).toBe(true);
  });

  it('recovers once the window slides past the oldest attempt', () => {
    const limiter = new SlidingWindowLimiter(2, 1_000, now);
    expect(limiter.allow('ip')).toBe(true);
    nowMs += 500;
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
    nowMs += 501; // first attempt aged out; second still inside
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
  });

  it('caps the subject map so a spoofed-IP flood cannot grow memory without limit', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, now, 100);
    for (let i = 0; i < 500; i++) {
      limiter.allow(`10.0.0.${i % 256}.${i}`);
    }
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(100);
  });
});

describe('SlidingWindowLimiter.refund', () => {
  it('returns a consumed slot so an authenticated handshake does not spend the pre-auth budget', () => {
    const now = 0;
    const limiter = new SlidingWindowLimiter(2, 1000, () => now);
    expect(limiter.allow('ip')).toBe(true);
    limiter.refund('ip'); // handshake turned out to be authentic
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    // Only the two un-refunded attempts count, so the third is shed.
    expect(limiter.allow('ip')).toBe(false);
  });

  it('still sheds a flood of FAILED handshakes (nothing is refunded for those)', () => {
    const now = 0;
    const limiter = new SlidingWindowLimiter(3, 1000, () => now);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
  });

  it('is a no-op for an unknown or already-empty subject', () => {
    const limiter = new SlidingWindowLimiter(1, 1000, () => 0);
    expect(() => limiter.refund('never-seen')).not.toThrow();
    expect(limiter.allow('never-seen')).toBe(true);
    limiter.refund('never-seen');
    limiter.refund('never-seen');
    expect(limiter.allow('never-seen')).toBe(true);
  });
});
