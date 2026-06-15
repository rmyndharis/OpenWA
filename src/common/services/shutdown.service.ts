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

    const delay = Math.min(delayMs ?? this.resolveDelay(), MAX_SHUTDOWN_DELAY_MS);
    this.logger.log('Graceful shutdown requested', { delayMs: delay });

    setTimeout(() => {
      this.logger.log('Initiating shutdown...');
      const doShutdown = async () => {
        try {
          if (this.destroyCallback) {
            await this.destroyCallback();
          }
        } catch (error) {
          this.logger.error('Error during shutdown', error instanceof Error ? error.message : String(error));
        } finally {
          process.exit(0);
        }
      };
      void doShutdown();
    }, delay);
  }

  /** Bounded, configurable grace (SHUTDOWN_DELAY_MS); default 3s, capped at 30s. */
  private resolveDelay(): number {
    const parsed = Number.parseInt(process.env.SHUTDOWN_DELAY_MS ?? '', 10);
    if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_SHUTDOWN_DELAY_MS;
    return parsed;
  }
}
