/** Minimal structured-logger surface the monitor needs (satisfied by createLogger()'s result). */
interface FatalLogger {
  error: (message: string, detail?: string) => void;
}

/** As FatalLogger, plus the warn level the rejection handler downgrades to. */
interface RejectionLogger extends FatalLogger {
  warn: (message: string, detail?: string) => void;
}

/**
 * Puppeteer raises this when an isolated world is disposed while an `evaluate` is still waiting for an
 * execution context — i.e. the browser was closed underneath it.
 */
const ENGINE_TEARDOWN_REJECTION = /execution context was destroyed/i;

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

/**
 * Backstop for promise rejections that escaped a local handler. Node terminates the process on an
 * unhandled rejection by default; for a long-running self-hosted gateway we log it and stay up rather
 * than let one stray rejection kill every session.
 *
 * One class is logged at WARN instead of ERROR: a Puppeteer context-disposal raised while an engine is
 * being torn down. whatsapp-web.js re-runs `inject()` from an async `framenavigated` listener it never
 * awaits, so after a LOGOUT — which navigates the page, then re-injects on the SAME browser — the
 * lifecycle's teardown turns that still-pending page evaluate into a rejection with no owner (#982).
 * It is expected and self-healing, and an ERROR with a raw Puppeteer stack reads like a crash.
 *
 * Deliberately scoped so nothing actionable is muted: the ACTIONABLE variant of the same message — a
 * browser profile left stale by an upgrade that changed the Chromium binary (#663/#708) — is thrown
 * from inside `engine.initialize()`, where the adapter catches it and logs its own advisory, so it
 * never reaches this handler. And only the severity changes: the full reason is still logged.
 */
export function registerUnhandledRejectionHandler(logger: RejectionLogger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const detail = reason instanceof Error ? reason.stack : String(reason);
    if (ENGINE_TEARDOWN_REJECTION.test(message)) {
      logger.warn(
        'Puppeteer rejection during an engine teardown — expected; the session recovers on its own. ' +
          "Check the session's own disconnect/failure logs for the outcome.",
        detail,
      );
      return;
    }
    logger.error('Unhandled promise rejection', detail);
  });
}
