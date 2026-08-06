import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionOwnershipService } from '../session/session-ownership.service';
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

  constructor(
    private readonly sessionService: SessionService,
    private readonly ownership: SessionOwnershipService,
    private readonly bulkMessages: BulkMessageService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** One pass: adopt every eligible lapsed session. Exposed for the spec; the timer drives it. */
  async sweep(): Promise<void> {
    const lapsed = await this.ownership.lapsedHeldByOthers();
    const eligible = lapsed.filter(session => this.isEligible(session));
    if (eligible.length === 0) return;

    for (let i = 0; i < eligible.length; i++) {
      const session = eligible[i];
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
        await new Promise(resolve => setTimeout(resolve, TAKEOVER_START_STAGGER_MS));
      }
    }
  }

  private isEligible(session: Session): boolean {
    // Only authenticated sessions (phone set): an engine is worth relaunching exactly when the
    // saved credentials can restore the link without a human scanning anything.
    return Boolean(session.phone) && TAKEOVER_STATUSES.has(session.status);
  }
}
