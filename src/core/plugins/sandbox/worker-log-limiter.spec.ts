import { performance } from 'perf_hooks';
import { SANDBOX_LOG_MAX_LINES_PER_WINDOW, WorkerLogLimiter } from './worker-log-limiter';
import { SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_LOG_WINDOW_MS } from './protocol';

describe('WorkerLogLimiter', () => {
  let clock: number;
  let notes: string[];
  let limiter: WorkerLogLimiter;

  beforeEach(() => {
    clock = 5_000_000; // the clock is monotonic and its origin is not zero
    notes = [];
    limiter = new WorkerLogLimiter(
      message => notes.push(message),
      () => clock,
    );
  });

  const admitted = (calls: number): number => {
    let count = 0;
    for (let i = 0; i < calls; i++) if (limiter.admit()) count++;
    return count;
  };

  it('admits the first lines of a window up to the bound and drops the rest', () => {
    expect(admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW)).toBe(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
    expect(limiter.admit()).toBe(false);
    expect(admitted(10_000)).toBe(0);
  });

  it('says so once at the first drop of a window, not for every dropped line', () => {
    admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
    expect(notes).toEqual([]);
    admitted(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/log rate limit reached/i);
    expect(notes[0]).toContain(`${SANDBOX_LOG_MAX_LINES_PER_WINDOW} per ${SANDBOX_LOG_WINDOW_MS / 1000} s`);
    admitted(5_000);
    expect(notes).toHaveLength(1);
  });

  it('reports how many lines the window dropped when the next window opens, and admits again', () => {
    admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW + 700);
    notes.length = 0;
    clock += SANDBOX_LOG_WINDOW_MS;

    expect(limiter.admit()).toBe(true);
    expect(notes).toEqual(['Dropped 700 log messages (log rate limit)']);
    expect(admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW - 1)).toBe(SANDBOX_LOG_MAX_LINES_PER_WINDOW - 1);
    expect(limiter.admit()).toBe(false);
  });

  it('keeps the window it opened until the full length has passed', () => {
    admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW + 1);
    clock += SANDBOX_LOG_WINDOW_MS - 1;
    expect(limiter.admit()).toBe(false);
    clock += 1;
    expect(limiter.admit()).toBe(true);
  });

  it('keeps the lines and its own notes of every window within what the relay admits', () => {
    for (let window = 0; window < 3; window++) {
      notes.length = 0;
      const lines = admitted(SANDBOX_LOG_MAX_PER_WINDOW * 3);

      expect(lines).toBe(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
      expect(lines + notes.length).toBeLessThanOrEqual(SANDBOX_LOG_MAX_PER_WINDOW);
      clock += SANDBOX_LOG_WINDOW_MS;
    }
  });

  it('writes no note for a window that dropped nothing', () => {
    admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
    clock += SANDBOX_LOG_WINDOW_MS;
    admitted(1);
    expect(notes).toEqual([]);
  });

  it('leaves a plugin that logs at an honest rate alone', () => {
    // One line a second for ten minutes: far under the bound in every window.
    let count = 0;
    for (let second = 0; second < 600; second++) {
      clock += 1000;
      if (limiter.admit()) count++;
    }
    expect(count).toBe(600);
    expect(notes).toEqual([]);
  });

  it('leaves the lines of a burst that fits the bound alone, window after window', () => {
    for (let window = 0; window < 5; window++) {
      expect(admitted(SANDBOX_LOG_MAX_LINES_PER_WINDOW)).toBe(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
      clock += SANDBOX_LOG_WINDOW_MS;
    }
    expect(notes).toEqual([]);
  });

  it('reads the monotonic clock by default, so a step of the wall clock opens no window', () => {
    const monotonic = jest.spyOn(performance, 'now').mockReturnValue(1_000);
    const wall = jest.spyOn(Date, 'now');
    try {
      const real = new WorkerLogLimiter(message => notes.push(message));
      for (let i = 0; i < SANDBOX_LOG_MAX_LINES_PER_WINDOW; i++) real.admit();

      wall.mockReturnValue(Date.now() + 24 * 3600 * 1000);
      expect(real.admit()).toBe(false);

      monotonic.mockReturnValue(1_000 + SANDBOX_LOG_WINDOW_MS);
      expect(real.admit()).toBe(true);
    } finally {
      monotonic.mockRestore();
      wall.mockRestore();
    }
  });
});
