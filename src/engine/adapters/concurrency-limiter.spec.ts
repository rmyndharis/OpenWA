import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  it('never runs more than `max` tasks at once and still runs them all', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    let done = 0;

    const tasks = Array.from({ length: 8 }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        active--;
        done++;
      }),
    );

    await Promise.all(tasks);

    expect(peak).toBe(2); // concurrency cap held across all 8
    expect(done).toBe(8); // none dropped — queued tasks still ran
  });

  it('never exceeds max when a fresh arrival races a just-woken waiter', async () => {
    // The synchronous-burst test above can't catch the over-admission race: a freeing slot wakes a
    // waiter, but a NEW run() arriving in the microtask gap (before the woken waiter increments) sees
    // the slot as free and admits too. This interleaves arrivals/completions across microtasks to hit it.
    const limiter = new ConcurrencyLimiter(1);
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const spawn = (): Promise<void> =>
      limiter.run(
        () =>
          new Promise<void>(resolve => {
            running++;
            peak = Math.max(peak, running);
            releases.push(() => {
              running--;
              resolve();
            });
          }),
      );

    const a = spawn(); // A admitted, running=1
    await Promise.resolve();
    const b = spawn(); // B queued behind A
    await Promise.resolve();

    releases[0](); // finish A: its finally frees the slot and wakes B
    await Promise.resolve(); // A's finally runs: slot free, B woken (its increment still pending)
    const c = spawn(); // C arrives in the gap — must NOT admit alongside the woken B
    await Promise.resolve();
    await Promise.resolve();

    expect(peak).toBeLessThanOrEqual(1);

    // Drain: waking a waiter makes it run and push its own release, so keep flushing until none remain.
    for (let i = 0; i < 20 && (running > 0 || releases.length); i++) {
      releases.splice(0).forEach(r => r());
      await new Promise<void>(r => setTimeout(r, 0));
    }
    await Promise.all([a, b, c]);
  });

  it('clamps a non-positive max to 1 (never deadlocks)', async () => {
    const limiter = new ConcurrencyLimiter(0);
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('frees its slot even when a task throws (no permanent leak)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('after'))).resolves.toBe('after'); // slot was released
  });
});
