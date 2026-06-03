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
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
