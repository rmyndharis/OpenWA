import {
  decideReconnect,
  clampReconnectDelay,
  RECONNECT_STABILITY_RESET_MS,
  RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS,
  RECONNECT_DELAY_CAP_MS,
  type ReconnectAttemptState,
} from './reconnect-policy';

const state = (over: Partial<ReconnectAttemptState> = {}): ReconnectAttemptState => ({
  attempts: 0,
  maxAttempts: Number.POSITIVE_INFINITY,
  baseDelay: 5000,
  ...over,
});

// Jitter is injected so the delay assertions are exact rather than ranged.
const NO_JITTER = 0;

describe('decideReconnect', () => {
  describe('exponential backoff', () => {
    it('schedules the first attempt at baseDelay', () => {
      const s = state();

      const d = decideReconnect(s, 1_000, NO_JITTER);

      expect(d).toMatchObject({ kind: 'schedule', delayMs: 5000, attempt: 1 });
    });

    it('doubles the delay per consecutive attempt', () => {
      const s = state();
      const delays: number[] = [];

      for (let i = 0; i < 4; i++) {
        const d = decideReconnect(s, 1_000, NO_JITTER);
        if (d.kind === 'schedule') delays.push(d.delayMs);
      }

      expect(delays).toEqual([5000, 10000, 20000, 40000]);
    });

    it('adds the supplied jitter before clamping', () => {
      const s = state();

      const d = decideReconnect(s, 1_000, 777);

      expect(d).toMatchObject({ delayMs: 5777 });
    });

    it('parks at the cap once the exponent outgrows it (unlimited budget never overflows setTimeout)', () => {
      const s = state({ attempts: 40 });

      const d = decideReconnect(s, 1_000, NO_JITTER);

      expect(d).toMatchObject({ delayMs: RECONNECT_DELAY_CAP_MS });
    });

    it('advances the caller-owned attempt counter', () => {
      const s = state();

      decideReconnect(s, 1_000, NO_JITTER);
      decideReconnect(s, 1_000, NO_JITTER);

      expect(s.attempts).toBe(2);
    });

    it('records when the attempt was scheduled', () => {
      const s = state();

      decideReconnect(s, 12_345, NO_JITTER);

      expect(s.lastAttemptAt).toBe(12_345);
    });
  });

  describe('budget exhaustion', () => {
    it('reports exhausted once attempts reach the cap', () => {
      const s = state({ attempts: 3, maxAttempts: 3 });

      const d = decideReconnect(s, 1_000, NO_JITTER);

      expect(d).toEqual({
        kind: 'exhausted',
        reason: 'Reconnection failed after 3 attempts — restart the session.',
      });
    });

    it('distinguishes "auto-reconnect disabled" from "N attempts failed"', () => {
      const s = state({ attempts: 0, maxAttempts: 0 });

      const d = decideReconnect(s, 1_000, NO_JITTER);

      // maxAttempts:0 means disabled outright; "failed after 0 attempts" would be misleading.
      expect(d).toEqual({
        kind: 'exhausted',
        reason:
          'Auto-reconnect is disabled (max attempts set to 0); the session was left disconnected — restart it manually.',
      });
    });

    it('does not advance the counter once exhausted', () => {
      const s = state({ attempts: 3, maxAttempts: 3 });

      decideReconnect(s, 1_000, NO_JITTER);

      expect(s.attempts).toBe(3);
    });

    it('never exhausts on the default unlimited budget', () => {
      const s = state({ attempts: 10_000 });

      expect(decideReconnect(s, 1_000, NO_JITTER).kind).toBe('schedule');
    });
  });

  describe('stability reset', () => {
    it('resets the budget when the session stayed up past the stability window', () => {
      const s = state({ attempts: 4, maxAttempts: 5, lastAttemptAt: 1_000 });

      const d = decideReconnect(s, 1_000 + RECONNECT_STABILITY_RESET_MS, NO_JITTER);

      // Budget restarts, so this is attempt 1 at baseDelay rather than a 5th attempt.
      expect(d).toMatchObject({ kind: 'schedule', attempt: 1, delayMs: 5000, stabilityReset: true });
    });

    it('keeps accruing inside the stability window', () => {
      const s = state({ attempts: 4, maxAttempts: 5, lastAttemptAt: 1_000 });

      const d = decideReconnect(s, 1_000 + RECONNECT_STABILITY_RESET_MS - 1, NO_JITTER);

      expect(d).toMatchObject({ attempt: 5, stabilityReset: false });
    });

    it('rescues a session that would otherwise wedge FAILED after unrelated transient drops', () => {
      const s = state({ attempts: 5, maxAttempts: 5, lastAttemptAt: 1_000 });

      // Without the reset this is exhausted; with it the session gets a fresh budget.
      const d = decideReconnect(s, 1_000 + RECONNECT_STABILITY_RESET_MS, NO_JITTER);

      expect(d.kind).toBe('schedule');
    });

    it('does not reset on the very first attempt (no prior timestamp)', () => {
      const s = state();

      expect(decideReconnect(s, 10 ** 12, NO_JITTER)).toMatchObject({ stabilityReset: false });
    });
  });

  describe('loop alerting', () => {
    it(`flags every ${RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS}th consecutive attempt`, () => {
      const s = state();
      const alerts: number[] = [];

      for (let i = 0; i < 12; i++) {
        const d = decideReconnect(s, 1_000, NO_JITTER);
        if (d.kind === 'schedule' && d.loopAlert) alerts.push(d.attempt);
      }

      expect(alerts).toEqual([5, 10]);
    });

    it('does not alert on the first attempt of an episode', () => {
      expect(decideReconnect(state(), 1_000, NO_JITTER)).toMatchObject({ loopAlert: false });
    });

    it('re-arms from attempt 5 again after a stability reset (new episode, not a continuing cadence)', () => {
      const s = state({ attempts: 4, lastAttemptAt: 1_000 });

      // A stable stretch resets the streak, so the next attempt is #1 and must not alert.
      const first = decideReconnect(s, 1_000 + RECONNECT_STABILITY_RESET_MS, NO_JITTER);
      expect(first).toMatchObject({ attempt: 1, loopAlert: false });

      const alerts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const d = decideReconnect(s, 1_000 + RECONNECT_STABILITY_RESET_MS, NO_JITTER);
        if (d.kind === 'schedule' && d.loopAlert) alerts.push(d.attempt);
      }
      expect(alerts).toEqual([5]);
    });
  });
});

describe('clampReconnectDelay', () => {
  it('passes a normal delay through', () => {
    expect(clampReconnectDelay(8000, 5000)).toBe(8000);
  });

  it('floors a negative delay at 0', () => {
    expect(clampReconnectDelay(-1, 5000)).toBe(0);
  });

  it('caps a huge delay so setTimeout cannot overflow and fire immediately', () => {
    expect(clampReconnectDelay(Number.MAX_SAFE_INTEGER, 5000)).toBe(RECONNECT_DELAY_CAP_MS);
  });

  it('falls back to baseDelay when the computed delay is not finite', () => {
    // An operator-supplied non-numeric config would otherwise yield NaN → setTimeout fires at 0.
    // Infinity is likewise not finite, so it takes the same fallback rather than the cap.
    expect(clampReconnectDelay(NaN, 5000)).toBe(5000);
    expect(clampReconnectDelay(Number.POSITIVE_INFINITY, 5000)).toBe(5000);
  });
});
