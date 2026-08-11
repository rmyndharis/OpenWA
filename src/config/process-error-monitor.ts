/** Minimal structured-logger surface the monitor needs (satisfied by createLogger()'s result). */
interface FatalLogger {
  error: (message: string, detail?: string) => void;
}

/**
 * As FatalLogger, plus the warn level the rejection handler downgrades to.
 *
 * `warn` takes structured CONTEXT, not a trace string: unlike `error(message, trace, context)`, the
 * logger's second `warn` parameter is the context, and a string there replaces the logger name for the
 * whole line. Passing a stack positionally type-checks and then buries it where the scope should be.
 */
interface RejectionLogger extends FatalLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * The two shapes an ownerless `inject()` rejection takes (#982). One cause, so one classification.
 *
 * 1. `execution context was destroyed` — Puppeteer disposed the isolated world while an `evaluate`
 *    was still waiting for a context, i.e. the page went away underneath it.
 * 2. `window.require is not a function` — the navigation landed on a page whose WhatsApp Web bundle
 *    has not defined its module registry yet, so the evaluate reaches `window.require` before it
 *    exists. Observed at the first boot after the pinned WA Web build moved under a warm profile:
 *    twice, then the session reached READY unaided, and a restart on the same build produced none.
 *
 * Only the FIRST alternative mirrors the whatsapp-web.js adapter's `isExecutionContextDestroyedError`
 * — deliberately duplicated rather than imported, because that module pulls whatsapp-web.js in eagerly
 * and this one loads during bootstrap, where the engine must stay lazy. Keep that alternative in sync
 * with it. The second is monitor-only ON PURPOSE: the adapter uses its predicate to advise about a
 * stale browser profile (#663/#708), and a missing `window.require` is not evidence of that, so
 * teaching it there would produce a confidently wrong advisory.
 */
const PAGE_CONTEXT_LOST_REJECTION = /execution context was destroyed|window\.require is not a function/i;

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
 * One class is logged at WARN instead of ERROR: a Puppeteer rejection left behind when the page an
 * `evaluate` was waiting on goes away. whatsapp-web.js re-runs `inject()` from an async
 * `framenavigated` listener it never awaits, so a page navigation or an engine teardown turns that
 * still-pending evaluate into a rejection with no owner (#982). Either way the session recovers on its
 * own, and an ERROR with a raw Puppeteer stack reads like a crash.
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
    if (PAGE_CONTEXT_LOST_REJECTION.test(message)) {
      // The stack goes in the context object, not the second positional slot: `warn`'s second
      // parameter is the log context, and a string there becomes the line's scope name.
      logger.warn(
        'Puppeteer rejection after the page it was evaluating went away (navigation or engine ' +
          "teardown) — expected; the session recovers on its own. Check the session's own " +
          'disconnect/failure logs for the outcome.',
        { reason: detail, action: 'page_context_lost_rejection' },
      );
      return;
    }
    logger.error('Unhandled promise rejection', detail);
  });
}
