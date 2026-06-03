export class PluginTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Plugin operation "${label}" exceeded ${ms}ms timeout`);
    this.name = 'PluginTimeoutError';
  }
}

/**
 * Race a promise against a timeout. The timer is always cleared so it never
 * keeps the event loop alive. On timeout the returned promise rejects with
 * PluginTimeoutError; the underlying promise is left to settle on its own.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  // Swallow a late rejection from the orphaned promise if the timeout wins the
  // race, so a slow-then-failing plugin cannot raise an unhandled rejection and
  // crash the host. This does not affect the value the race resolves/rejects with.
  promise.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeoutError(label, ms)), ms);
  });
  // Promise.race of Promise<T> and Promise<never> resolves to Promise<T>.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
