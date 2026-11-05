import { performance } from 'node:perf_hooks';

/**
 * How long after the first stop signal a repeat still counts as the same stop request. When npm or the
 * Nest CLI runs the process, one Ctrl+C or one signal to the process group reaches node twice, a
 * fraction of a millisecond apart: once from the group and once forwarded by the parent. A person
 * pressing again to force the exit is far slower than this.
 */
export const STOP_SIGNAL_REPEAT_WINDOW_MS = 1000;

/**
 * The signals that mean stop: SIGTERM (docker stop, Kubernetes, systemd), SIGINT (Ctrl+C, pm2) and SIGHUP
 * (the terminal went away). Every other signal keeps its default action on purpose:
 * - a JavaScript listener on SIGSEGV, SIGBUS, SIGILL, SIGFPE or SIGTRAP turns a crash in native code into a
 *   process that spins at full CPU, because the faulting instruction runs again once the handler returns and
 *   the event loop never gets to run the listener. V8's own fatal path ends in a trap, and a WebAssembly
 *   out-of-bounds access stops being a catchable error;
 * - with a listener, SIGQUIT and SIGABRT do nothing to a process whose event loop is blocked, which removes the
 *   core dump that is the way out of a wedged gateway;
 * - SIGUSR2 is the signal Node uses for --report-on-signal and --heapsnapshot-signal, which must not stop it.
 * Do not give Nest a signal outside this list either: it adds a listener for each one it is given, and an
 * empty list means every signal.
 */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

export interface StopSignalHandlerDeps {
  /** Begin the bounded drain (ShutdownService.shutdown). */
  shutdown: () => void;
  /** Force the exit; process.exit by default. */
  exit?: (code: number) => void;
  /** A monotonic clock in milliseconds; performance.now by default, so a wall-clock step cannot move the window. */
  now?: () => number;
  /** Where the listeners are installed; process.on by default. */
  listen?: (signal: NodeJS.Signals, listener: () => void) => void;
}

/**
 * Every stop signal starts the drain once. A repeat SIGTERM or SIGINT, measured from the FIRST signal, is
 * ignored inside STOP_SIGNAL_REPEAT_WINDOW_MS and forces exit 130 after it, the escape from a wedged
 * teardown. A SIGHUP after the first signal is always ignored: a terminal that closes while a stop runs
 * is not a request to cut its teardown short, and the force-exit budget still bounds a wedged one. The
 * gate is "a signal already arrived", not ShutdownService.isShuttingDown(), which an admin restart also
 * sets, so a first real signal during an admin-restart grace still drains. The listeners stay installed
 * for the life of the process: without one, a further stop signal would take Node's default action and
 * kill the process outright.
 */
export function installStopSignalHandlers(deps: StopSignalHandlerDeps): void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const now = deps.now ?? (() => performance.now());
  const listen = deps.listen ?? ((signal: NodeJS.Signals, listener: () => void) => void process.on(signal, listener));
  let firstAt: number | undefined;
  const onStop = (signal: NodeJS.Signals): void => {
    if (firstAt === undefined) {
      firstAt = now();
      deps.shutdown();
      return;
    }
    if (signal === 'SIGHUP') return;
    if (now() - firstAt >= STOP_SIGNAL_REPEAT_WINDOW_MS) exit(130);
  };
  for (const signal of STOP_SIGNALS) listen(signal, () => onStop(signal));
}
