import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout } from 'node:timers/promises';
import { createLogger } from '../../common/services/logger.service';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { SessionService } from '../session/session.service';
import { BulkMessageService } from '../message/bulk-message.service';

/**
 * Statuses worth adopting from a lapsed node. They all mean "an engine was (or should be) running".
 * QR_READY is deliberately absent — an unpaired session on a dead node has nothing to resume, and
 * restarting it elsewhere just renders a QR nobody asked for. FAILED is deliberately absent too:
 * it marks a session an operator must look at, and silently relocating it would hide that.
 */
const TAKEOVER_STATUSES = new Set<SessionStatus>([
  SessionStatus.READY,
  SessionStatus.INITIALIZING,
  SessionStatus.AUTHENTICATING,
  SessionStatus.ACTION_REQUIRED,
  SessionStatus.DISCONNECTED,
]);

/** Pause between successive engine launches, matching the boot auto-start's Chromium stagger. */
const TAKEOVER_START_STAGGER_MS = 2000;

/**
 * Adopts sessions whose holder's lease has lapsed.
 *
 * Boot auto-start runs exactly once, so it misses two real cases, both observed live: a peer that
 * crashes AFTER this node booted, and a container recreate whose new boot lands BEFORE the old
 * identity's lease expires (the claim is correctly refused, and nothing ever retried — the session
 * sat disconnected until someone called POST /start). This sweep is the retry: every tick it looks
 * for lapsed-lease sessions and starts them here through the ordinary start path, so the claim
 * stays race-safe against peers doing the same.
 *
 * Lives in its own module (not SessionModule) because adopting a session also reconciles its
 * in-flight bulk batches via BulkMessageService — which sits in MessageModule, which imports
 * SessionModule; importing it back from SessionModule would close the cycle.
 */
@Injectable()
export class SessionTakeoverService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('SessionTakeoverService');
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepInFlight = false;
  /**
   * Set by onModuleDestroy. Clearing the interval stops the NEXT sweep; it does nothing about one
   * already running, which is neither aborted nor awaited. Without this signal a sweep mid-flight
   * during a rolling restart could construct and register an engine after the shutdown path had
   * already emptied the registry — nothing would tear it down — and claim the ownership lease for a
   * process about to exit, pinning the session to a dead node until the lease lapsed.
   */
  private shuttingDown = false;

  constructor(
    private readonly sessionService: SessionService,
    private readonly ownership: SessionOwnershipService,
    private readonly bulkMessages: BulkMessageService,
    @Optional()
    private readonly configService?: ConfigService,
    // The drain signal, not module destruction. `onModuleDestroy` runs at app.close(), AFTER the
    // bounded shutdown delay — throughout that window the timer is still armed, so without this a
    // tick could launch an engine and claim an ownership lease for a process about to exit. Same
    // source session-engine-lifecycle and the liveness watchdog already consult.
    @Optional()
    private readonly shutdownService?: ShutdownService,
  ) {}

  /** True once EITHER the drain has begun or Nest has torn this module down. */
  private get stopping(): boolean {
    return this.shuttingDown || this.shutdownService?.isShuttingDown() === true;
  }

  onApplicationBootstrap(): void {
    // The same flag that governs boot auto-start: a deployment that opted out of automatic engine
    // starts must not get spontaneous ones from the sweep either.
    if (!resolveFeatureFlags(this.configService).autoStartSessions) return;
    const sweepMs = this.configService?.get<number>('session.takeoverSweepMs', 30_000) ?? 30_000;
    this.sweepTimer = setInterval(() => {
      // At most one sweep at a time: a slow start (Chromium launch) must not stack a second sweep
      // on top of the first — the claim would refuse, but the log noise and DB churn are pointless.
      if (this.sweepInFlight) return;
      this.sweepInFlight = true;
      void this.sweep()
        .catch(error =>
          this.logger.warn('Takeover sweep failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          this.sweepInFlight = false;
        });
    }, sweepMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * One pass of the claim loop: adopt every eligible lapsed session, then any runnable session
   * nobody holds. Exposed for the spec; the timer drives it. Two feeds, one loop — the sweep is a
   * desired-state reconciler, not just a crash detector: "should be running, is not running
   * anywhere" converges here regardless of how the session got into that state.
   */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    const lapsed = await this.ownership.lapsedHeldByOthers();
    const unclaimed = await this.ownership.unclaimedRunnable();
    const seen = new Set<string>();
    // Two feeds, two eligibility rules. Crash adoption (lapsed) resumes only what saved credentials
    // can restore silently — isEligible's phone/status gate. The unclaimed feed is EXPLICIT intent:
    // its query already filters to runnable states, and an unpaired session with desiredState
    // 'running' must be launched (that QR is how ROLE=api pairing reaches a worker at all).
    let eligible = [...lapsed.filter(session => this.isEligible(session)), ...unclaimed].filter(session => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
    // Capacity fence: never adopt past MAX_CONCURRENT_SESSIONS (0 = unlimited). start() enforces
    // the cap too, but refusing here keeps the loop from burning its stagger budget on launches
    // that will be refused — and leaves the rows for a peer with headroom to claim instead.
    const maxConcurrent = this.configService?.get<number>('sessions.maxConcurrent') ?? 0;
    if (maxConcurrent > 0) {
      const headroom = Math.max(0, maxConcurrent - this.sessionService.activeEngineCount());
      if (headroom === 0) return;
      eligible = eligible.slice(0, headroom);
    }
    if (eligible.length === 0) return;

    for (let i = 0; i < eligible.length; i++) {
      const session = eligible[i];
      // Re-checked per iteration, not just at entry: each adoption costs a browser launch plus a
      // stagger, so the loop spans a large part of the sweep interval and shutdown can begin partway
      // through. Everything already adopted is left to the normal teardown; nothing further starts.
      if (this.stopping) return;
      try {
        await this.sessionService.start(session.id);
        this.logger.log(`Adopted session ${session.name} from lapsed node ${session.nodeId ?? '?'}`, {
          sessionId: session.id,
          fromNode: session.nodeId,
          action: 'session_takeover',
        });
        // The dead node's in-flight batches can never complete; surface them as FAILED now rather
        // than leaving them stuck in PROCESSING until some node happens to reboot.
        await this.bulkMessages.reapProcessingBatches(session.id, 'session adopted from a lapsed node');
      } catch (error) {
        if (error instanceof ConflictException) {
          // A peer won the race — exactly the claim doing its job.
          this.logger.debug(`Session ${session.name} was adopted by another node first`, { sessionId: session.id });
        } else {
          this.logger.warn(`Takeover start failed for session ${session.name}`, {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (i < eligible.length - 1) {
        await setTimeout(TAKEOVER_START_STAGGER_MS);
      }
    }
  }

  private isEligible(session: Session): boolean {
    // Only authenticated sessions (phone set): an engine is worth relaunching exactly when the
    // saved credentials can restore the link without a human scanning anything. And only sessions
    // the operator WANTS running — a deliberate stop must never be undone by reconciliation.
    // Rows predating the desiredState column read as undefined in stubbed specs; the migration
    // backfills real rows, so undefined here means "no gate", preserving pre-column behavior.
    const wantsRunning = session.desiredState === undefined || session.desiredState === 'running';
    return wantsRunning && Boolean(session.phone) && TAKEOVER_STATUSES.has(session.status);
  }
}
