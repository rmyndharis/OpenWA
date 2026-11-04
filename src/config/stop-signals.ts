import { performance } from 'node:perf_hooks';

/**
 * How long after the first stop signal a repeat still counts as the same stop request. When npm or the
 * Nest CLI runs the process, one Ctrl+C or one signal to the process group reaches node twice, a
 * fraction of a millisecond apart: once from the group and once forwarded by the parent. A person
 * pressing again to force the exit is far slower than this.
 */
export const STOP_SIGNAL_REPEAT_WINDOW_MS = 1000;

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
 * SIGTERM and SIGINT start the drain once. A repeat of either, measured from the FIRST signal, is
 * ignored inside STOP_SIGNAL_REPEAT_WINDOW_MS and forces exit 130 after it, the escape from a wedged
 * teardown. The gate is "a signal already arrived", not ShutdownService.isShuttingDown(), which an admin
 * restart also sets, so a first real signal during an admin-restart grace still drains. The listeners
 * stay installed for the life of the process: without one, a further SIGINT or SIGTERM would take
 * Node's default action and kill the process outright.
 */
export function installStopSignalHandlers(deps: StopSignalHandlerDeps): void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const now = deps.now ?? (() => performance.now());
  const listen = deps.listen ?? ((signal: NodeJS.Signals, listener: () => void) => void process.on(signal, listener));
  let firstAt: number | undefined;
  const onStop = (): void => {
    if (firstAt === undefined) {
      firstAt = now();
      deps.shutdown();
      return;
    }
    if (now() - firstAt >= STOP_SIGNAL_REPEAT_WINDOW_MS) exit(130);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) listen(signal, onStop);
}
