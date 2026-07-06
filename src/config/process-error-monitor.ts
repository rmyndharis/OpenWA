/** Minimal structured-logger surface the monitor needs (satisfied by createLogger()'s result). */
interface FatalLogger {
  error: (message: string, detail?: string) => void;
}

/**
 * Register an `uncaughtExceptionMonitor` that routes an otherwise-fatal uncaught exception through the
 * structured logger BEFORE Node's default handling.
 *
 * `uncaughtExceptionMonitor` (unlike `uncaughtException`) does NOT install a swallowing handler: Node
 * still prints its default message and exits with code 1. So the crash posture is unchanged — the
 * container's restart policy still fires and we never continue running on corrupted post-exception
 * in-memory state (the `engines`/`reconnectStates`/limiter maps could be mid-mutation) — we only add
 * the fatal stack to the log pipeline, which `console.error`-to-stderr misses.
 *
 * The body is guarded so a throw inside the monitor (a poisoned error whose `.stack` getter throws, a
 * `String()`-incompatible value, or a downed logger) can never mask the original fatal error or change
 * the exit code — the worst case degrades to losing this one log line while Node's default print + exit
 * proceed untouched.
 */
export function registerUncaughtExceptionMonitor(logger: FatalLogger): void {
  process.on('uncaughtExceptionMonitor', (err: unknown, origin: string) => {
    try {
      logger.error(
        `Uncaught exception (${origin}) — process will exit`,
        err instanceof Error ? err.stack : String(err),
      );
    } catch {
      /* never mask the original fatal error */
    }
  });
}
