import { Injectable, Optional } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';

/**
 * Session liveness watchdog. The engine layer is event-driven, so an engine that dies WITHOUT
 * emitting a disconnect (a killed Chromium, a silently wedged socket) would otherwise sit READY
 * forever. This actively probes every live engine on an interval and, after repeated failures,
 * hands the session to the caller's disconnect path.
 *
 * Split out of SessionService because it is a self-contained supervisor: one timer, one failure
 * counter, and exactly one outward effect (`onDead`). Keeping it separate means the probe timeout,
 * the failure threshold, and the observe-only ACTION_REQUIRED rules are testable with a fake clock
 * instead of a live engine.
 */
@Injectable()
export class SessionLivenessWatchdog {
  private readonly logger = createLogger('SessionLivenessWatchdog');

  /** Consecutive failed liveness probes per session id. Cleared on recovery or on a status change. */
  private readonly failures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  /** Invoked when a session has failed enough consecutive probes to be treated as disconnected. */
  private onDead: (id: string, engine: IWhatsAppEngine, reason: string) => Promise<void> = () => Promise.resolve();

  constructor(
    private readonly engines: EngineRegistry,
    @Optional()
    private readonly shutdownService?: ShutdownService,
  ) {}

  /**
   * Start the watchdog (idempotent). One unref'd interval probes every registered engine.
   *
   * @param onDead Called after MAX_FAILURES consecutive failures, to treat the session exactly like
   *   an engine-reported disconnect.
   */
  start(
    onDead: (id: string, engine: IWhatsAppEngine, reason: string) => Promise<void>,
    intervalMs = SESSION_WATCHDOG_INTERVAL_MS,
  ): void {
    this.onDead = onDead;
    if (this.timer) return;
    this.timer = setInterval(() => {
      // allSettled inside the tick keeps a failing session from ever throwing into the timer.
      void this.tick();
    }, intervalMs);
    // The watchdog must never keep the process alive on its own.
    this.timer.unref();
  }

  /** Stop the watchdog and forget all accrued failures. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.failures.clear();
  }

  /** Forget a session's accrued failures (e.g. it just reported ready). */
  clear(id: string): void {
    this.failures.delete(id);
  }

  /** Probe all live engines in parallel; a slow/failed probe must not delay or abort the others. */
  async tick(): Promise<void> {
    // Mid-shutdown the disconnect path would schedule a reconnect racing onModuleDestroy's teardown
    // (same guard as scheduleReconnect) — leave the sessions to the drain instead.
    if (this.shutdownService?.isShuttingDown()) {
      return;
    }
    await Promise.allSettled([...this.engines].map(([id, engine]) => this.probe(id, engine)));
  }

  /**
   * Actively probe one engine. Only READY sessions are expected to answer (anything else is owned by
   * the QR/reconnect flows); engines without `probeLiveness` keep relying on engine events alone.
   * MAX_FAILURES consecutive failures treat the session exactly like an engine-reported disconnect.
   *
   * ACTION_REQUIRED is probed too, but OBSERVE-ONLY: the engine is still running and a human has to
   * act, and clearing that status is theirs to do (stop, then start). Acting on a failed probe would
   * hand the session to the reconnect path and silently drop the very status that asked for
   * attention — so the probe result only reaches the log. Without probing at all, a page that dies
   * while waiting for the operator left no trace anywhere, which is what this closes.
   */
  async probe(id: string, engine: IWhatsAppEngine): Promise<void> {
    const status = engine.getStatus();
    const observeOnly = status === EngineStatus.ACTION_REQUIRED;
    if (status !== EngineStatus.READY && !observeOnly) {
      // Not expected to answer right now — and any accrued failures belong to a previous READY
      // stretch, so the next one starts clean. This also self-cleans the observe-only counter below:
      // every path out of ACTION_REQUIRED passes through a status that lands here (or through
      // onReady, which clears it), so an observe-only count can never be inherited by a READY
      // stretch and push it over MAX_FAILURES early.
      this.failures.delete(id);
      return;
    }
    // Feature-detect: an engine whose transport already self-detects death may skip the probe.
    if (typeof engine.probeLiveness !== 'function') {
      return;
    }

    // A wedged connection can hang the probe itself, so race it against a timeout; a timeout or a
    // probe error both count as "not proven alive".
    let alive: boolean;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      alive = await Promise.race([
        engine.probeLiveness(),
        new Promise<never>((_, reject) => {
          probeTimer = setTimeout(
            () => reject(new Error('liveness probe timed out')),
            SESSION_WATCHDOG_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      alive = false;
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
    }

    // The session may have been stopped/restarted (engine superseded) while the probe was in flight;
    // a stale result must not touch it (mirrors the isLive gate on engine callbacks).
    if (!this.engines.isLive(id, engine)) {
      return;
    }

    if (alive) {
      // Note a recovery on the observe-only path, so the log shows the page came back rather than
      // leaving the earlier warning as the last word.
      if (observeOnly && this.failures.has(id)) {
        this.logger.log('Liveness probe answering again while the session awaits operator action', {
          sessionId: id,
          action: 'watchdog_probe_recovered',
        });
      }
      this.failures.delete(id);
      return;
    }

    const failures = (this.failures.get(id) ?? 0) + 1;
    if (observeOnly) {
      this.failures.set(id, failures);
      // One warning per unresponsive stretch, not one per tick: a session can sit in
      // ACTION_REQUIRED until a human gets to it, and at a 60s interval an unbounded log would bury
      // everything else. The count keeps rising so the recovery branch above can tell it happened.
      if (failures === 1) {
        this.logger.warn(
          'Liveness probe failed while the session awaits operator action; not reconnecting it — ' +
            'the status is operator-owned. If the page is gone, stop and start the session.',
          { sessionId: id, action: 'watchdog_probe_failed_observe_only' },
        );
      }
      return;
    }

    if (failures < SESSION_WATCHDOG_MAX_FAILURES) {
      this.failures.set(id, failures);
      this.logger.warn('Liveness probe failed; will treat the session as dead after repeated failures', {
        sessionId: id,
        failures,
        action: 'watchdog_probe_failed',
      });
      return;
    }

    this.failures.delete(id);
    this.logger.warn('Liveness probe failed repeatedly; handling the session as disconnected', {
      sessionId: id,
      failures,
      action: 'watchdog_disconnect',
    });
    await this.onDead(id, engine, 'liveness probe failed (watchdog)');
  }
}

/**
 * Session liveness watchdog cadence. The engine layer is event-driven, so an engine that dies
 * WITHOUT emitting a disconnect would otherwise sit READY forever.
 */
export const SESSION_WATCHDOG_INTERVAL_MS = 60_000;
/** A wedged connection can hang the probe itself, so each probe is raced against this deadline. */
export const SESSION_WATCHDOG_PROBE_TIMEOUT_MS = 15_000;
/** Consecutive failed probes before a session is treated as disconnected. */
export const SESSION_WATCHDOG_MAX_FAILURES = 2;
