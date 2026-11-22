import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { type createLogger } from '../../common/services/logger.service';

export interface UpdateStatusOptions {
  /** Checked after the write settles; returning false suppresses WS/webhook announcement. */
  canAnnounce?: () => boolean;
  /**
   * When set, fences the SQL UPDATE on `{ id, nodeId: ownerNodeId }` so a node that lost
   * ownership cannot overwrite a peer's row. When `allowUnowned` is also true (retirement/cleanup
   * paths where the claim may already have been released), matches `nodeId = ownerNodeId OR nodeId IS NULL`.
   */
  ownerNodeId?: string;
  allowUnowned?: boolean;
}

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
  // and the webhook POST against firing the same status twice. Cleared on delete(), and before a
  // lapsed-row or released-row correction is announced (see SessionEngineLifecycle.announceStatus).
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

  /**
   * Persist a status transition and mirror it to WS/webhooks when the write actually matched a row.
   *
   * Accepts either a bare `canAnnounce` callback or an `UpdateStatusOptions` object carrying an
   * optional `ownerNodeId` SQL fence. Returns `true` when the UPDATE matched (`affected !== 0`),
   * and `false` (skipping announcement) when `affected === 0`.
   */
  async updateStatus(
    id: string,
    status: SessionStatus,
    options?: (() => boolean) | UpdateStatusOptions,
  ): Promise<boolean> {
    const resolved: UpdateStatusOptions = typeof options === 'function' ? { canAnnounce: options } : (options ?? {});
    const where: string | FindOptionsWhere<Session> | FindOptionsWhere<Session>[] =
      resolved.ownerNodeId !== undefined
        ? resolved.allowUnowned
          ? [
              { id, nodeId: resolved.ownerNodeId },
              { id, nodeId: IsNull() },
            ]
          : { id, nodeId: resolved.ownerNodeId }
        : id;
    const result = await this.sessionRepository.update(where, { status });
    const updated = (result as { affected?: number } | undefined)?.affected !== 0;
    if (!updated) {
      this.logger.debug(`Skipped status announcement for ${status} (0 rows updated)`, {
        sessionId: id,
        status,
        action: 'status_update_skipped',
      });
      return false;
    }
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    if (resolved.canAnnounce?.() === false) return true;
    this.announce(id, status);
    return true;
  }

  /**
   * The fan-out half of updateStatus, for a caller that has ALREADY written the row itself.
   *
   * A write that can land after the session changed hands has to go under a predicate, never by id,
   * because a peer can claim and start the row at any moment; writing by id afterwards to get the
   * fan-out would undo the predicate. Four writes need that split: the correction of a row whose
   * owning node is gone (still that node's, still lapsed, still claiming to run) and a failed start's
   * released row (unclaimed, still claiming to run), both through SessionEngineLifecycle.announceStatus,
   * and the retired launch and the init-timeout eviction (this node's row or an unowned one), which
   * call this directly. Everything else must keep using updateStatus.
   */
  announce(id: string, status: SessionStatus): void {
    // Mirror the status change to WS clients AND subscribed webhooks — both de-duped. Some engines signal
    // one transition via both onStateChanged AND a dedicated callback (onQRCode/onDisconnected), which
    // would otherwise emit/POST the same status twice; only act when it actually changed from the last one.
    if (this.lastDispatchedStatus.get(id) !== status) {
      this.lastDispatchedStatus.set(id, status);
      this.eventsGateway.emitSessionStatus(id, status);
      void this.webhookService.dispatch(id, 'session.status', { sessionId: id, status });
    }
  }

  /**
   * Drop the de-dup entry for a session — called from delete()'s committed-delete cleanup, and
   * before a lapsed-row or released-row correction announces, since that write is a transition this
   * process never saw.
   */
  clear(id: string): void {
    this.lastDispatchedStatus.delete(id);
  }
}
