import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from './logger.service';
import {
  DEFAULT_SHUTDOWN_DELAY_MS,
  DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS,
  shutdownTeardownLimitMs,
} from './shutdown-budget';

// The delay counts 1:1 against the kill deadline; see shutdown-budget.ts.
const MAX_SHUTDOWN_DELAY_MS = 30_000;

@Injectable()
export class ShutdownService {
  private readonly logger = createLogger('ShutdownService');
  private destroyCallback: (() => Promise<void>) | null = null;
  private readonly shutdownListeners: Array<() => void> = [];
  private shuttingDown = false;
  private shutdownScheduled = false;
  private tearingDown = false;

  constructor(@Optional() private readonly config?: ConfigService) {}

  /**
   * Set the shutdown callback (called from main.ts after app creation)
   */
  setShutdownCallback(callback: () => Promise<void>): void {
    this.destroyCallback = callback;
  }

  /**
   * Run `listener` when shutdown begins, before the grace and every destroy hook. It runs inside the
   * signal handler, so it must not throw or block.
   */
  onShutdown(listener: () => void): void {
    this.shutdownListeners.push(listener);
  }

  /**
   * True once shutdown has begun. The readiness probe reports 503 while draining so the
   * load balancer / orchestrator stops routing NEW traffic before teardown.
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * True once the grace has elapsed and teardown has started. Nest keeps the HTTP listener open
   * until every destroy hook has finished, so the request gate in configure-app.ts refuses new
   * requests from this point on.
   */
  isTearingDown(): boolean {
    return this.tearingDown;
  }

  /** Flip the draining flag (idempotent). Safe to call synchronously from a signal handler. */
  markShuttingDown(): void {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.logger.log('Entering draining state — readiness now reports 503');
      for (const listener of this.shutdownListeners) listener();
    }
  }

  /**
   * Trigger graceful shutdown after a bounded grace window. Readiness flips to 503 first
   * (drain), then after the delay the teardown callback runs and the process exits.
   */
  shutdown(delayMs?: number): void {
    this.markShuttingDown();

    // Idempotent: a repeated signal (double Ctrl+C, or a SIGTERM overlapping an admin restart) must not
    // schedule a second grace timer / second app.close() / second process.exit. The first call wins.
    if (this.shutdownScheduled) return;
    this.shutdownScheduled = true;

    const delay = Math.min(delayMs ?? this.resolveDelay(), MAX_SHUTDOWN_DELAY_MS);
    this.logger.log('Graceful shutdown requested', { delayMs: delay });

    setTimeout(() => {
      this.logger.log('Initiating shutdown...');
      this.tearingDown = true;
      // The only bound on the waits that have none of their own (the database waits, queue and pool
      // close), and the only one on the admin-restart path, where no orchestrator kill follows. Armed
      // here, after the grace, so a raised SHUTDOWN_DELAY_MS moves it with the kill deadline; see
      // shutdown-budget.ts. Not unref'd: a teardown parked on a promise that holds no handle would let
      // the loop drain and the process exit 0 with the remaining hooks never run.
      const budgetMs = shutdownTeardownLimitMs(
        this.config?.get<number>('webhook.shutdownDrainMs') ?? DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS,
      );
      const forceExit = setTimeout(() => {
        this.logger.error('Shutdown teardown exceeded its budget, forcing exit', undefined, { budgetMs });
        process.exit(1);
      }, budgetMs);
      const doShutdown = async () => {
        // The exit status mirrors the teardown outcome: 0 when teardown completed, 1 when it
        // failed, so an orchestrator (k8s, systemd, docker restart policies) must not read a
        // resource-leaking shutdown as a clean one. A teardown that hangs is cut by the force-exit
        // timer above (or by a second signal in main.ts).
        let exitCode = 0;
        try {
          if (this.destroyCallback) {
            await this.destroyCallback();
          }
        } catch (error) {
          exitCode = 1;
          this.logger.error(
            'Shutdown teardown failed — exiting non-zero',
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          clearTimeout(forceExit);
          process.exit(exitCode);
        }
      };
      void doShutdown();
    }, delay);
  }

  /**
   * Bounded, configurable grace (SHUTDOWN_DELAY_MS), capped at 30s. An explicit value always wins.
   * When unset, the default is the full 3s drain window (so a load balancer observes the 503 before
   * teardown) for EVERY real deployment — even an ad-hoc run that never sets NODE_ENV. Only an
   * explicit `development`/`test` skips the window (delay 0), so a `nest start --watch` hot reload
   * or a dev Ctrl+C is not slowed by a grace it does not need.
   */
  private resolveDelay(): number {
    const parsed = Number.parseInt(process.env.SHUTDOWN_DELAY_MS ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    const env = process.env.NODE_ENV;
    return env === 'development' || env === 'test' ? 0 : DEFAULT_SHUTDOWN_DELAY_MS;
  }
}
