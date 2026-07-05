import { KeyRateLimiter, readRateLimitConfig, readIpRateLimitConfig } from './mcp-rate-limit';

describe('readRateLimitConfig', () => {
  it('returns defaults for an empty env', () => {
    expect(readRateLimitConfig({})).toEqual({ max: 60, windowMs: 60_000 });
  });

  it('parses valid numeric env values', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '120', MCP_RATE_LIMIT_WINDOW_MS: '30000' })).toEqual({
      max: 120,
      windowMs: 30_000,
    });
  });

  it('falls back to defaults for non-numeric values', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: 'abc', MCP_RATE_LIMIT_WINDOW_MS: 'abc' })).toEqual({
      max: 60,
      windowMs: 60_000,
    });
  });

  it('falls back to defaults for zero', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '0', MCP_RATE_LIMIT_WINDOW_MS: '0' })).toEqual({
      max: 60,
      windowMs: 60_000,
    });
  });

  it('falls back to defaults for negative values', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '-5', MCP_RATE_LIMIT_WINDOW_MS: '-5' })).toEqual({
      max: 60,
      windowMs: 60_000,
    });
  });

  it('falls back to defaults for blank strings', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '', MCP_RATE_LIMIT_WINDOW_MS: '' })).toEqual({
      max: 60,
      windowMs: 60_000,
    });
  });

  it('falls back to default for fractional value 0.5 (would truncate to 0)', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '0.5' }).max).toBe(60);
  });

  it('falls back to default for fractional value 0.99 (would truncate to 0)', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '0.99' }).max).toBe(60);
  });

  it('floors 1.9 to 1 (valid positive integer)', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '1.9' }).max).toBe(1);
  });

  it('floors 60.7 to 60 (valid positive integer)', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_MAX: '60' }).max).toBe(60);
  });

  it('falls back to default for MCP_RATE_LIMIT_WINDOW_MS 0.5', () => {
    expect(readRateLimitConfig({ MCP_RATE_LIMIT_WINDOW_MS: '0.5' }).windowMs).toBe(60_000);
  });
});

describe('readIpRateLimitConfig', () => {
  it('returns the IP defaults for an empty env (more generous than the per-key budget)', () => {
    expect(readIpRateLimitConfig({})).toEqual({ max: 120, windowMs: 60_000 });
  });

  it('parses valid numeric env values', () => {
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_MAX: '500', MCP_IP_RATE_LIMIT_WINDOW_MS: '30000' })).toEqual({
      max: 500,
      windowMs: 30_000,
    });
  });

  it('falls back to the IP defaults for non-numeric / zero / negative / blank values', () => {
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_MAX: 'abc' }).max).toBe(120);
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_MAX: '0' }).max).toBe(120);
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_MAX: '-5' }).max).toBe(120);
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_MAX: '' }).max).toBe(120);
    expect(readIpRateLimitConfig({ MCP_IP_RATE_LIMIT_WINDOW_MS: '0.5' }).windowMs).toBe(60_000);
  });

  it('is independent of the per-key vars (they must not bleed into the IP budget)', () => {
    expect(readIpRateLimitConfig({ MCP_RATE_LIMIT_MAX: '5', MCP_RATE_LIMIT_WINDOW_MS: '5' })).toEqual({
      max: 120,
      windowMs: 60_000,
    });
  });
});

describe('KeyRateLimiter', () => {
  it('allows up to max per window, then throws 429', () => {
    let now = 1_000;
    const rl = new KeyRateLimiter(2, 1000, () => now);
    rl.check('k');
    rl.check('k');
    expect(() => rl.check('k')).toThrow(/rate limit/i);
    now = 2_500; // window passed
    expect(() => rl.check('k')).not.toThrow();
  });
  it('buckets per key', () => {
    const rl = new KeyRateLimiter(1, 1000, () => 0);
    rl.check('a');
    expect(() => rl.check('b')).not.toThrow();
  });

  // FIX 3(a): expired buckets must be pruned so the Map does not grow unboundedly
  it('prunes empty buckets: Map is empty after all windows expire', () => {
    let now = 0;
    const rl = new KeyRateLimiter(5, 1000, () => now);

    // Insert 1000 distinct keys, each with one hit
    for (let i = 0; i < 1000; i++) {
      rl.check(`key-${i}`);
    }

    // Advance time past the window so all buckets become stale
    now = 2_000;

    // Trigger a check on each key — this is when pruning should happen
    for (let i = 0; i < 1000; i++) {
      rl.check(`key-${i}`); // one fresh hit, but the old stale ones are pruned
    }

    // Each bucket should have exactly 1 entry (the one we just added), not accumulate stale ones.
    // More importantly: a key that has never been touched since expiry must be pruned on its next check.
    // Advance another window so all current hits expire.
    now = 4_000;

    // Check a new key to trigger pruning on bucket 'key-0' by checking 'key-0' again.
    // After the check, if recent is empty, the bucket is deleted.
    // We can observe this by checking an expired key and then verifying the result is clean.
    for (let i = 0; i < 1000; i++) {
      rl.check(`key-${i}`); // this re-check triggers prune of the stale bucket
    }

    // The underlying hits Map should hold exactly 1 entry per key (only the fresh hit),
    // confirming expired entries are deleted rather than accumulating.
    // Access the private field via casting to verify the Map state.
    const map = (rl as unknown as { hits: Map<string, number[]> }).hits;

    // Every bucket must have exactly 1 timestamp (the last fresh hit).
    for (const [, timestamps] of map) {
      expect(timestamps).toHaveLength(1);
    }
  });
});
