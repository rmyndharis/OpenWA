/**
 * CPU time this process has used since `since`, in milliseconds. A bound on work is asserted on it and not on the
 * wall clock: a busy runner can hold the worker off the CPU for longer than the whole bound, while code that is slow
 * burns the CPU on every run.
 */
const cpuMsSince = (since: NodeJS.CpuUsage): number => {
  const { user, system } = process.cpuUsage(since);
  return (user + system) / 1000;
};

/**
 * The CPU time, in milliseconds, that `run` needs: the smallest of `runs` runs of it.
 *
 * `process.cpuUsage()` counts every thread of the process, V8's collector threads included. A jest worker holds a
 * large heap, and one major collection of it inside the window is charged to a call that needs a few milliseconds:
 * a second or more on a heap of a gigabyte. Such noise only ever adds, and a collection does not land in each of
 * three consecutive windows, so the smallest run is what the call costs by itself, while code that is super-linear
 * is slow in every run.
 *
 * Only for a call that is a pure function of its input. One that throttles, caches or deduplicates is cheaper
 * after its first run, and the minimum would then measure the shortcut and not the work.
 */
export const leastCpuMs = (run: () => unknown, runs = 3): number => {
  let least = Infinity;
  for (let attempt = 0; attempt < runs; attempt++) {
    const started = process.cpuUsage();
    run();
    least = Math.min(least, cpuMsSince(started));
  }
  return least;
};

/** {@link leastCpuMs} for a call that returns a promise: the whole of each run, to its settling, is the window. */
export const leastCpuMsAsync = async (run: () => Promise<unknown>, runs = 3): Promise<number> => {
  let least = Infinity;
  for (let attempt = 0; attempt < runs; attempt++) {
    const started = process.cpuUsage();
    await run();
    least = Math.min(least, cpuMsSince(started));
  }
  return least;
};
