import { resolveReconnectConfig, clampReconnectDelay } from './session.service';

// F-03 — an OPERATOR-supplied session.config flows into the reconnect backoff math unchecked.
// config:{reconnectBaseDelay:'x'} makes the delay NaN -> setTimeout(fn, NaN) fires at 0 (relaunch
// storm); config:{maxReconnectAttempts:'x'} makes the terminal guard `n >= NaN` always false, so the
// loop never caps. These helpers coerce + clamp the config so the math is always finite and bounded.
describe('resolveReconnectConfig (F-03)', () => {
  it('uses the 5000ms / 5-attempt defaults for absent or empty config', () => {
    expect(resolveReconnectConfig(null)).toEqual({ baseDelay: 5000, maxAttempts: 5 });
    expect(resolveReconnectConfig({})).toEqual({ baseDelay: 5000, maxAttempts: 5 });
  });

  it('falls back to defaults for non-numeric (NaN) values', () => {
    expect(resolveReconnectConfig({ reconnectBaseDelay: 'x', maxReconnectAttempts: 'y' })).toEqual({
      baseDelay: 5000,
      maxAttempts: 5,
    });
  });

  it('clamps a huge baseDelay down to the 5-minute max (no infinite-timer wedge)', () => {
    expect(resolveReconnectConfig({ reconnectBaseDelay: 1e15 }).baseDelay).toBe(300_000);
  });

  it('clamps a negative/too-small baseDelay up to the 1s min (no immediate relaunch)', () => {
    expect(resolveReconnectConfig({ reconnectBaseDelay: -5 }).baseDelay).toBe(1000);
    expect(resolveReconnectConfig({ reconnectBaseDelay: 0 }).baseDelay).toBe(1000);
  });

  it('clamps maxAttempts to the 0..20 range and floors fractions', () => {
    expect(resolveReconnectConfig({ maxReconnectAttempts: 999 }).maxAttempts).toBe(20);
    expect(resolveReconnectConfig({ maxReconnectAttempts: -3 }).maxAttempts).toBe(0);
    expect(resolveReconnectConfig({ maxReconnectAttempts: 3.9 }).maxAttempts).toBe(3);
  });

  it('preserves a legitimate maxReconnectAttempts: 0 (disable reconnect) instead of forcing the default', () => {
    expect(resolveReconnectConfig({ maxReconnectAttempts: 0 }).maxAttempts).toBe(0);
  });
});

describe('clampReconnectDelay (F-03)', () => {
  it('passes a finite delay through, flooring at 0', () => {
    expect(clampReconnectDelay(8000, 5000)).toBe(8000);
    expect(clampReconnectDelay(-1, 5000)).toBe(0);
  });

  it('falls back to baseDelay for a non-finite delay (NaN from a poisoned config)', () => {
    expect(clampReconnectDelay(NaN, 5000)).toBe(5000);
  });

  it('caps the exponential so it never exceeds setTimeout range and fires immediately', () => {
    expect(clampReconnectDelay(1e15, 5000)).toBe(3_600_000);
  });
});
