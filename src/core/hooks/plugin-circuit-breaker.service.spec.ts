import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';

describe('PluginCircuitBreaker', () => {
  let breaker: PluginCircuitBreaker;

  beforeEach(() => {
    breaker = new PluginCircuitBreaker();
    breaker.configure(3); // threshold = 3
  });

  it('does not trip before the threshold', () => {
    expect(breaker.recordFailure('p1')).toBe(false);
    expect(breaker.recordFailure('p1')).toBe(false);
    expect(breaker.isTripped('p1')).toBe(false);
  });

  it('trips exactly on the Nth consecutive failure', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    expect(breaker.recordFailure('p1')).toBe(true); // 3rd
    expect(breaker.isTripped('p1')).toBe(true);
  });

  it('returns false on subsequent failures after already tripped', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1'); // trips
    expect(breaker.recordFailure('p1')).toBe(false); // already tripped, not "just tripped"
  });

  it('resets the counter on success', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordSuccess('p1');
    expect(breaker.recordFailure('p1')).toBe(false); // counter restarted
    expect(breaker.isTripped('p1')).toBe(false);
  });

  it('tracks plugins independently', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1'); // p1 trips
    expect(breaker.isTripped('p1')).toBe(true);
    expect(breaker.isTripped('p2')).toBe(false);
  });

  it('reset() clears tripped state and counter', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.reset('p1');
    expect(breaker.isTripped('p1')).toBe(false);
    expect(breaker.recordFailure('p1')).toBe(false);
  });
});
