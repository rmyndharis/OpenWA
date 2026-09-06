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
 * How many lease TTLs of silence make a holder "really gone".
 *
 * Two, not one. A lease lapses while its holder is perfectly healthy whenever a query runs long, and
 * the next heartbeat re-extends it; correcting a status on a single lapse would report a live peer's
 * sessions as disconnected, and nothing would put that right, because the peer's own renewal still
 * finds its nodeId and detects no loss. Adoption is unaffected and still acts on the first lapse: it
 * goes through claim(), which a live holder wins back.
 */
const STRANDED_LEASE_TTL_MULTIPLE = 2;

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
    // Deliberately NOT gated on auto-start any more. The sweep now has a second job that starts
    // nothing: correcting a status whose owner is gone. Nothing else revisits one, because the boot
    // reset skips a foreign claim that is still live and after a container recreate the previous
    // hostname IS foreign, so with auto-start off the row went on reporting a running engine no
    // process holds. The adopt loop below is still behind the flag: an operator who disabled
    // auto-start asked for no spontaneous engine starts, not for a dashboard that lies.
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
   * One pass: correct every stale status a vanished node left behind, then adopt every eligible
   * lapsed session. Exposed for the spec; the timer drives it.
   */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    const lapsed = await this.ownership.lapsedHeldByOthers();

    // Correct the stale statuses BEFORE adopting: a row this pass goes on to start gets its
    // INITIALIZING written by start() afterwards, so the correction can never land on a live engine.
    // Idempotent, because DISCONNECTED is not one of the statuses it acts on.
    const goneBefore = new Date(Date.now() - this.ownership.leaseTtlMs * STRANDED_LEASE_TTL_MULTIPLE);
    await this.sessionService.markLapsedDisconnected(lapsed, goneBefore);

    if (!resolveFeatureFlags(this.configService).autoStartSessions) return;
    const eligible = lapsed.filter(session => this.isEligible(session));
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
    // saved credentials can restore the link without a human scanning anything.
    return Boolean(session.phone) && TAKEOVER_STATUSES.has(session.status);
  }
}
