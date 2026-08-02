import { Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { type createLogger } from '../../common/services/logger.service';

/**
 * The session-status fan-out extracted from SessionEngineLifecycle: persist the status, then
 * mirror it to WS clients and subscribed webhooks, de-duped. Plain class (NOT a NestJS provider —
 * the lifecycle's constructor signature is frozen by specs), built inside the lifecycle's
 * constructor. The de-dup Map is OWNED here; the lifecycle exposes a `lastDispatchedStatus`
 * getter alias returning it by reference (the liveCalls precedent) so the spec's `.set()` pokes
 * land on this exact instance, and keeps `updateStatus` as a public delegate so its 9 call sites
 * stay byte-identical. The method body below moved verbatim, which is why it reads
 * `this.sessionRepository` / `this.eventsGateway` / `this.webhookService` / `this.logger` against
 * the same-named fields assigned here.
 */
export class SessionStatusBroadcaster {
  // Last session.status value broadcast per session. Some engines signal one transition via BOTH
  // onStateChanged and a dedicated callback (onQRCode/onDisconnected), so this guards both the WS emit
  // and the webhook POST against firing the same status twice. Cleared on delete().
  readonly lastDispatchedStatus = new Map<string, SessionStatus>();

  private readonly sessionRepository: Repository<Session>;
  private readonly eventsGateway: EventsGateway;
  private readonly webhookService: WebhookService;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: {
    sessionRepository: Repository<Session>;
    eventsGateway: EventsGateway;
    webhookService: WebhookService;
    logger: ReturnType<typeof createLogger>;
  }) {
    this.sessionRepository = deps.sessionRepository;
    this.eventsGateway = deps.eventsGateway;
    this.webhookService = deps.webhookService;
    this.logger = deps.logger;
  }

  async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Mirror the status change to WS clients AND subscribed webhooks — both de-duped. Some engines signal
    // one transition via both onStateChanged AND a dedicated callback (onQRCode/onDisconnected), which
    // would otherwise emit/POST the same status twice; only act when it actually changed from the last one.
    if (this.lastDispatchedStatus.get(id) !== status) {
      this.lastDispatchedStatus.set(id, status);
      this.eventsGateway.emitSessionStatus(id, status);
      void this.webhookService.dispatch(id, 'session.status', { sessionId: id, status });
    }
  }

  /** Drop the de-dup entry for a session — called from delete()'s committed-delete cleanup. */
  clear(id: string): void {
    this.lastDispatchedStatus.delete(id);
  }
}
