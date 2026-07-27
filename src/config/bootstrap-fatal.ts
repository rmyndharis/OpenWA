/**
 * Fatal-bootstrap handling: log, best-effort teardown, then a real exit.
 *
 * Extracted from `main.ts` so the failure contract is unit-tested without booting the app.
 *
 * Why a real `process.exit(1)` instead of only setting `process.exitCode`: Nest's `listen()` runs the
 * FULL module init (sessions, Redis, Postgres, Chromium) before binding the port. If the bind then
 * fails (EADDRINUSE), setting `exitCode` alone leaves the event loop held open by those very handles —
 * the process becomes a zombie that serves no HTTP yet keeps the WhatsApp sessions running, and Docker's
 * `restart: unless-stopped` never fires because the container stays "running". Exiting lets the
 * orchestrator restart us onto a free port (or surface the conflict), and Puppeteer's own `exit`
 * handlers kill the browser children as the process goes down.
 */

/** Minimal structured-logger surface (satisfied by createLogger()'s result). */
export interface BootstrapFatalLogger {
  error: (message: string, detail?: string) => void;
}

export interface BootstrapFatalDeps {
  logger: BootstrapFatalLogger;
  /**
   * Best-effort teardown of whatever the app initialised before the failure (engine sessions, Redis/pg
   * connections). Bounded by `closeTimeoutMs` — a wedged teardown must never block the exit.
   */
  closeApp?: () => Promise<unknown>;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Bound on `closeApp()`. Defaults to `DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS`. */
  closeTimeoutMs?: number;
}

export const DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS = 5000;

/**
 * Run `bootstrap()`; on ANY rejection (e.g. `listen()` failing with EADDRINUSE after full init), log the
 * fatal error, run the bounded best-effort teardown, and exit non-zero. A successful boot returns
 * normally and never touches `exit`.
 *
 * Every step is guarded: a throwing logger or teardown degrades to losing that one step while the exit
 * still proceeds — the exit is the guarantee the orchestrator relies on.
 */
export async function runBootstrapOrExit(bootstrap: () => Promise<unknown>, deps: BootstrapFatalDeps): Promise<void> {
  try {
    await bootstrap();
    return;
  } catch (err) {
    try {
      deps.logger.error(
        'Fatal error during bootstrap — process will exit',
        err instanceof Error ? err.stack : String(err),
      );
    } catch {
      /* never mask the original fatal error */
    }
  }

  if (deps.closeApp) {
    try {
      const closeApp = deps.closeApp;
      await Promise.race([
        Promise.resolve().then(() => closeApp()),
        new Promise<void>(resolve => {
          setTimeout(resolve, deps.closeTimeoutMs ?? DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS).unref();
        }),
      ]);
    } catch {
      /* best-effort teardown — the exit below is what matters */
    }
  }

  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}
