import {
  decideReconnect,
  clampReconnectDelay,
  RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS,
  RECONNECT_DELAY_CAP_MS,
  type ReconnectAttemptState,
  type ReconnectDecision,
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

      const d = decideReconnect(s, NO_JITTER);

      expect(d).toMatchObject({ kind: 'schedule', delayMs: 5000, attempt: 1 });
    });

    it('doubles the delay per consecutive attempt', () => {
      const s = state();
      const delays: number[] = [];

      for (let i = 0; i < 4; i++) {
        const d = decideReconnect(s, NO_JITTER);
        if (d.kind === 'schedule') delays.push(d.delayMs);
      }

      expect(delays).toEqual([5000, 10000, 20000, 40000]);
    });

    it('adds the supplied jitter before clamping', () => {
      const s = state();

      const d = decideReconnect(s, 777);

      expect(d).toMatchObject({ delayMs: 5777 });
    });

    it('parks at the cap once the exponent outgrows it (unlimited budget never overflows setTimeout)', () => {
      const s = state({ attempts: 40 });

      const d = decideReconnect(s, NO_JITTER);

      expect(d).toMatchObject({ delayMs: RECONNECT_DELAY_CAP_MS });
    });

    it('advances the caller-owned attempt counter', () => {
      const s = state();

      decideReconnect(s, NO_JITTER);
      decideReconnect(s, NO_JITTER);

      expect(s.attempts).toBe(2);
    });
  });

  describe('budget exhaustion', () => {
    it('reports exhausted once attempts reach the cap', () => {
      const s = state({ attempts: 3, maxAttempts: 3 });

      const d = decideReconnect(s, NO_JITTER);

      expect(d).toEqual({
        kind: 'exhausted',
        reason: 'Reconnection failed after 3 attempts — restart the session.',
      });
    });

    it('distinguishes "auto-reconnect disabled" from "N attempts failed"', () => {
      const s = state({ attempts: 0, maxAttempts: 0 });

      const d = decideReconnect(s, NO_JITTER);

      // maxAttempts:0 means disabled outright; "failed after 0 attempts" would be misleading.
      expect(d).toEqual({
        kind: 'exhausted',
        reason:
          'Auto-reconnect is disabled (max attempts set to 0); the session was left disconnected — restart it manually.',
      });
    });

    it('does not advance the counter once exhausted', () => {
      const s = state({ attempts: 3, maxAttempts: 3 });

      decideReconnect(s, NO_JITTER);

      expect(s.attempts).toBe(3);
    });

    it('never exhausts on the default unlimited budget', () => {
      const s = state({ attempts: 10_000 });

      expect(decideReconnect(s, NO_JITTER).kind).toBe('schedule');
    });
  });

  describe('over real elapsed time', () => {
    beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
    afterEach(() => jest.useRealTimers());

    // Each decision lands once the previous delay has elapsed plus a ~2 s failed connect, as in production.
    const drive = (s: ReconnectAttemptState, decisions: number): ReconnectDecision[] => {
      const out: ReconnectDecision[] = [];
      for (let k = 0; k < decisions; k++) {
        const d = decideReconnect(s, NO_JITTER);
        out.push(d);
        if (d.kind === 'schedule') jest.advanceTimersByTime(d.delayMs + 2000);
      }
      return out;
    };

    it.each([7, 20])('exhausts an explicit budget of %i on the next decision', max => {
      const s = state({ maxAttempts: max });

      const out = drive(s, max + 1);

      const scheduled = out.slice(0, max).map(d => (d.kind === 'schedule' ? d.attempt : d.kind));
      expect(scheduled).toEqual(Array.from({ length: max }, (_, k) => k + 1));
      const last = out[max];
      expect(last.kind === 'exhausted' && last.reason).toContain(`failed after ${max} attempts`);
    });

    it('parks an unlimited budget at the 5-minute cap and never resets the streak', () => {
      expect(RECONNECT_DELAY_CAP_MS).toBe(300_000);

      const s = state();

      const out = drive(s, 30);

      const delays = out.map(d => (d.kind === 'schedule' ? d.delayMs : -1));
      // 5000 * 2^6 = 320 s is the first computed delay past the cap, so attempt 7 onward parks there.
      expect(delays.slice(0, 6)).toEqual([5000, 10000, 20000, 40000, 80000, 160000]);
      expect(delays.slice(6).every(ms => ms === RECONNECT_DELAY_CAP_MS)).toBe(true);
      expect(out[29]).toMatchObject({ kind: 'schedule', attempt: 30 });
      expect(s.attempts).toBe(30);
    });
  });

  describe('loop alerting', () => {
    it(`flags every ${RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS}th consecutive attempt`, () => {
      const s = state();
      const alerts: number[] = [];

      for (let i = 0; i < 12; i++) {
        const d = decideReconnect(s, NO_JITTER);
        if (d.kind === 'schedule' && d.loopAlert) alerts.push(d.attempt);
      }

      expect(alerts).toEqual([5, 10]);
    });

    it('does not alert on the first attempt of an episode', () => {
      expect(decideReconnect(state(), NO_JITTER)).toMatchObject({ loopAlert: false });
    });

    it('re-arms from attempt 5 again once READY clears the streak', () => {
      const s = state({ attempts: 4 });

      // What the lifecycle does on READY.
      s.attempts = 0;
      const first = decideReconnect(s, NO_JITTER);
      expect(first).toMatchObject({ attempt: 1, loopAlert: false });

      const alerts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const d = decideReconnect(s, NO_JITTER);
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
