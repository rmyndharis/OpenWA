// Captured when this module loads, so a spec that fakes timers later still waits on the real clock.
const realSetTimeout = setTimeout;
const realNow = Date.now.bind(Date);

/**
 * Waits until `condition` holds, polling every 5 ms, and stops at the deadline without throwing: the assertion after
 * it reports what is missing. A count of event loop turns cannot stand in for this when the work is a database round
 * trip, a timer, a file or a child process, because how many turns those take depends on the machine.
 */
export const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
  const deadline = realNow() + timeoutMs;
  while (!(await condition()) && realNow() < deadline) await new Promise<void>(resolve => realSetTimeout(resolve, 5));
};
