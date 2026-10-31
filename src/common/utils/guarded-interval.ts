/**
 * Run a maintenance task now and then every `intervalMs`, one run at a time: a tick that finds the
 * previous run still going is skipped rather than stacked on top of it, so a pass that outlasts its
 * interval (a large bucket, a slow database) never multiplies its own load. A failed run is handed to
 * `onError` and does not stop the schedule. The timer does not keep the process alive.
 *
 * Returns the function that stops the schedule; a run already in progress finishes.
 */
export function startGuardedInterval(
  task: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    // An async wrapper, so a task that throws before its first await is a failed run like any other,
    // and still starts synchronously.
    void (async () => task())()
      .catch(onError)
      .finally(() => (running = false));
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
