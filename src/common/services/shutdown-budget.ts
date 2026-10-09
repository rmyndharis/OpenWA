/**
 * Shutdown time budget. On SIGTERM/SIGINT (and POST /api/infra/restart) the ordered teardown has to
 * finish before the orchestrator's kill deadline, or the late destroy hooks (API-key usage flush,
 * plugin onDisable, DataSource close) are SIGKILLed half way. The bounded stages below run one after
 * another in Nest destroy order (modules in sequence, hooks inside one module in parallel); sessions
 * do not add up, because engines are torn down in parallel under one per-engine deadline.
 *
 *   stage                                   cap      applies when
 *   SHUTDOWN_DELAY_MS drain                  3 s     always (default; the grace before teardown)
 *   ingress reconciler wait                  5 s     a pass in flight (worst case)
 *   engine teardown                         10 s     always
 *   auto-start wait                          5 s     shutdown during the boot window
 *   throttler Redis quit                     2 s     REDIS_ENABLED
 *   webhook drain                            5 s     a delivery in flight (worst case; WEBHOOK_SHUTDOWN_DRAIN_MS)
 *   queue worker close                      10 s     QUEUE_ENABLED
 *   producer queue close                     4 s     QUEUE_ENABLED (2 s per queue, one queue module each)
 *   API-key usage flush                      5 s     pending counters
 *   cache Redis quit                         2 s     REDIS_ENABLED
 *   plugin phase (disable + pending enable) 10 s     a plugin is enabled
 *   WebSocket adapter Redis quit             2 s     REDIS_ENABLED
 *   HTTP close                               0 s     main.ts sets forceCloseConnections
 *
 * Base (single replica, no plugins): 3 + 5 + 10 + 5 + 5 + 5 = 33 s. With a plugin enabled: 43 s.
 * Clustered (QUEUE + REDIS + plugins): 63 s, of which 3 s is the grace.
 *
 * The teardown after the grace has SHUTDOWN_TEARDOWN_LIMIT_MS (67 s), against 60 s of stages in the
 * clustered case. The 7 s left over is the reserve for the waits that have no cap of their own, before
 * and after the HTTP close: the database and plugin hook waits listed at the end, the BullModule
 * re-await of the worker close (closeWorkerIfStarted settles it once its cap is hit), the DataSource
 * close and the ffmpeg kill. They take milliseconds when nothing is wedged.
 *
 * The producer queue close is a stage of its own: ShutdownSafeQueue settles it, rejected or hung (a
 * half-open Redis socket never answers QUIT), within QUEUE_CLOSE_TIMEOUT_MS. Each queue is registered
 * in its own module (queue.module.ts) and Nest closes modules one after the other, so the stage is
 * QUEUE_CLOSE_TIMEOUT_MS times the number of queues in QUEUE_NAMES. A close that rejects makes Nest
 * skip every hook after it, the DataSource close included, and one that hangs holds them until the
 * force-exit.
 *
 * ShutdownService force-exits with status 1 when the teardown overruns that limit. It arms the timer
 * when the grace ends, so a raised SHUTDOWN_DELAY_MS moves the exit and the kill deadline together,
 * and it adds the excess of WEBHOOK_SHUTDOWN_DRAIN_MS over its 5 s default, the one other
 * operator-set input to a stage. The kill deadline an operator needs is therefore
 *
 *   75 s + (SHUTDOWN_DELAY_MS - 3 s) + (WEBHOOK_SHUTDOWN_DRAIN_MS - 5 s)
 *
 * and the shipped 75 s holds for the defaults. A healthy stop exits on its own and never waits. The
 * force-exit covers only SIGTERM, SIGINT and the admin restart; the other signals Nest handles itself
 * (main.ts) call app.close() with no exit timer.
 *
 * Waits with no cap of their own, which only the force-exit bounds: the bulk-message destroy hook (a
 * lookup and an update per processing batch), the pending-message reaper (it awaits its running
 * sweep, whose in-hand row re-emits message:persisted to plugin hooks) and the session ownership
 * release. They wait on the database, and the reaper also on plugin hooks. A wedged database ends the
 * stop at the force-exit, with status 1, before the kill; the stages behind these waits (worker close,
 * usage flush, plugin onDisable) get only the time that is left.
 */

/** Grace before teardown, so a load balancer sees the 503 first. SHUTDOWN_DELAY_MS overrides it. */
export const DEFAULT_SHUTDOWN_DELAY_MS = 3_000;

/** Default for WEBHOOK_SHUTDOWN_DRAIN_MS, the one other operator-set input to a stage in the table. */
export const DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS = 5_000;

/**
 * Must equal docker-compose.yml and docker-compose.dev.yml stop_grace_period and
 * charts/openwa/values.yaml terminationGracePeriodSeconds. It holds for the default delay and drain.
 */
export const SHUTDOWN_KILL_DEADLINE_MS = 75_000;

/** The force-exit fires this long before the kill deadline. */
export const SHUTDOWN_KILL_MARGIN_MS = 5_000;

/** How long the teardown may run after the grace, with the default drain: 67 s. */
export const SHUTDOWN_TEARDOWN_LIMIT_MS =
  SHUTDOWN_KILL_DEADLINE_MS - DEFAULT_SHUTDOWN_DELAY_MS - SHUTDOWN_KILL_MARGIN_MS;

/**
 * The largest delay a Node timer accepts; above it the timer fires after 1 ms. Defined here because
 * configuration.ts imports this file, and re-exported from there for the other callers.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The teardown limit for a given WEBHOOK_SHUTDOWN_DRAIN_MS: it counts 1:1 against the kill deadline. */
export function shutdownTeardownLimitMs(webhookDrainMs: number): number {
  const limit = SHUTDOWN_TEARDOWN_LIMIT_MS + webhookDrainMs - DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS;
  return Math.min(limit, MAX_TIMER_MS);
}
