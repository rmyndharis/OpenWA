import { Injectable } from '@nestjs/common';
import { createLogger } from './logger.service';

/** Default grace before teardown; capped so a misconfigured value can't exceed a typical SIGKILL window. */
const DEFAULT_SHUTDOWN_DELAY_MS = 3000;
const MAX_SHUTDOWN_DELAY_MS = 30_000;

@Injectable()
export class ShutdownService {
  private readonly logger = createLogger('ShutdownService');
  private destroyCallback: (() => Promise<void>) | null = null;
  private shuttingDown = false;
  private shutdownScheduled = false;

  /**
   * Set the shutdown callback (called from main.ts after app creation)
   */
  setShutdownCallback(callback: () => Promise<void>): void {
    this.destroyCallback = callback;
  }

  /**
   * True once shutdown has begun. The readiness probe reports 503 while draining so the
   * load balancer / orchestrator stops routing NEW traffic before teardown.
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Flip the draining flag (idempotent). Safe to call synchronously from a signal handler. */
  markShuttingDown(): void {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.logger.log('Entering draining state — readiness now reports 503');
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
      const doShutdown = async () => {
        // The exit status mirrors the teardown outcome: 0 when teardown completed, 1 when it
        // failed — an orchestrator (k8s, systemd, docker restart policies) must not read a
        // resource-leaking shutdown as a clean one. (A teardown that HANGS never reaches this
        // exit at all; that case is bounded externally by the second-signal force-exit in
        // main.ts or the orchestrator's SIGKILL deadline.)
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
          process.exit(exitCode);
        }
      };
      void doShutdown();
    }, delay);
  }

  /**
   * Bounded, configurable grace (SHUTDOWN_DELAY_MS), capped at 30s. An explicit value always wins.
   * When unset, the default is the full 3s drain window (so a load balancer observes the 503 before
   * teardown) for EVERY real deployment — including a bare `docker run` or a Kubernetes pod that never
   * sets NODE_ENV. Only an explicit `development`/`test` skips the window (delay 0), so a
   * `nest start --watch` hot reload or a dev Ctrl+C is not slowed by a grace it does not need.
   */
  private resolveDelay(): number {
    const parsed = Number.parseInt(process.env.SHUTDOWN_DELAY_MS ?? '', 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    const env = process.env.NODE_ENV;
    return env === 'development' || env === 'test' ? 0 : DEFAULT_SHUTDOWN_DELAY_MS;
  }
}
