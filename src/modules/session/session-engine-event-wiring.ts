import { SessionStatus } from './entities/session.entity';
import { MessageProjector } from './message-projector.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  EngineEventCallbacks,
  EngineStatus,
  IWhatsAppEngine,
  IncomingCallEvent,
  AccountRestriction,
  PresenceUpdateEvent,
  CallOutcomeEvent,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { SessionEngineLeafEvents } from './session-engine-leaf-events';

/**
 * The call-ins SessionEngineEventWiring needs from the lifecycle core. Built ONCE in the
 * lifecycle's constructor. Only the CLOSURE members are live-read: the arrow closures bind the
 * lifecycle's live methods/state (never a stale copy — specs replace some deps at runtime). The
 * dependency VALUE members (messages, sessionErrors, webhookService, eventsGateway, hookManager,
 * leafEvents) are captured once at construction — the same reads the pre-extraction inline code
 * made of the lifecycle's readonly constructor fields. The closures are deliberately NON-async
 * passthroughs returning the callee's own promise object untouched (the Task-1 delegate rule: an
 * `async` wrapper would adopt the inner promise and add settlement hops the retirement-race specs
 * assert against).
 */
export interface SessionEngineWiringHost {
  /** Liveness gate: true only while `engine` is still the live engine registered for `id`. */
  isLiveEngine(id: string, engine: IWhatsAppEngine): boolean;
  /**
   * Ownership gate: true while this node may still speak for `id`. Orthogonal to isLiveEngine —
   * between a lapsed lease and the teardown the heartbeat schedules, isLiveEngine is still true
   * while this is already false. TRUE when no ownership service is wired (single process).
   */
  ownsSession(id: string): boolean;
  handleEngineReady(id: string, engine: IWhatsAppEngine, phone: string, pushName: string): void;
  handleEngineDisconnected(id: string, engine: IWhatsAppEngine, reason: string): Promise<void>;
  updateStatus(id: string, status: SessionStatus): Promise<void>;
  cancelReconnect(id: string): void;
  evictAndForceDestroy(id: string, engine: IWhatsAppEngine): void;
  trackPendingCredentialTeardown(sessionName: string, raw: Promise<void>): void;
  /** Announce a restriction that has ended; shared with the lifecycle's own READY path. */
  reportRestrictionLifted(id: string, lifted: AccountRestriction): void;
  /**
   * SYNCHRONOUS atomic one-shot claim over the lifecycle's shared stuckAuthRecoveryUsed Set (bound
   * by reference through the closure): true exactly once per episode, and only while `engine` is
   * still the live owner.
   */
  claimStuckAuthRecovery(id: string, engine: IWhatsAppEngine): boolean;
  messages: MessageProjector;
  sessionErrors: SessionErrorStore;
  sessionRestrictions: SessionRestrictionStore;
  presence: PresenceStore;
  /** @Global AuditService; absent only in the standalone constructions specs build. */
  auditService?: AuditService;
  webhookService: WebhookService;
  eventsGateway: EventsGateway;
  hookManager: HookManager;
  leafEvents: SessionEngineLeafEvents;
}

/**
 * The engine-callback wiring table extracted from SessionEngineLifecycle.initializeEngine: the 17
 * callbacks passed to engine.initialize(). Plain class (NOT a NestJS provider — the lifecycle's
 * constructor signature is frozen by specs), built inside the lifecycle's constructor. Stateless:
 * buildCallbacks closes over (id, engine, sessionName) and reaches the lifecycle exclusively
 * through `host`, so the emitted table is behaviorally identical to the inline original — the
 * per-callback liveness gating (onMessage/onMessageCreate/onMessageAck/onMessageRevoked/
 * onCredentialTeardownStarted are deliberately UNGATED) and every nested call's order preserved.
 * The callback bodies moved verbatim, which is why they read `this.logger` against the same-named
 * field assigned here; every other former `this.x` read goes through `host`. Specs capture the
 * table from `mockEngine.initialize.mock.calls[0][0]` and invoke callbacks directly.
 */
export class SessionEngineEventWiring {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: { logger: ReturnType<typeof createLogger> }) {
    this.logger = deps.logger;
  }

  buildCallbacks(
    id: string,
    engine: IWhatsAppEngine,
    sessionName: string,
    host: SessionEngineWiringHost,
  ): EngineEventCallbacks {
    /**
     * Persist an engine-driven status, but only while this node still owns the session.
     *
     * Every caller has already passed the isLiveEngine fence; this closes the other axis. A node
     * whose lease lapsed keeps a live engine until the heartbeat's teardown completes, and a status
     * written in that window lands on a row a peer now owns. FAILED is the one that does not heal:
     * the boot reset and the takeover sweep both exclude it by design, so the session leaves every
     * automatic recovery path until an operator restarts it by hand.
     */
    const persistStatus = (status: SessionStatus): void => {
      if (!host.ownsSession(id)) {
        this.logger.warn('Skipped an engine status write for a session this node no longer owns', {
          sessionId: id,
          status,
          action: 'status_write_skipped_not_owned',
        });
        return;
      }
      void host.updateStatus(id, status);
    };

    return {
      onQRCode: (qr: string): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.log('QR code generated', {
          sessionId: id,
          action: 'qr_generated',
        });

        void host.webhookService.dispatch(id, 'session.qr', { sessionId: id, qr });

        // Push the QR to subscribed dashboard clients over the WebSocket (the `session.qr` event is
        // advertised + consumed there, so clients can render it live instead of polling GET /qr).
        host.eventsGateway.emitQRCode(id, qr);

        // Execute hook for QR event
        void host.hookManager.execute(
          'session:qr',
          { sessionId: id },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        persistStatus(SessionStatus.QR_READY);
      },
      onReady: (phone, pushName): void => host.handleEngineReady(id, engine, phone, pushName),
      onMessage: (message): void => host.messages.handleInboundMessage(id, engine, message),
      onHistoryMessages: (messages): void => {
        if (!host.isLiveEngine(id, engine)) return;
        // Persist for the chat view only; no dispatch (these predate the live session).
        void host.messages
          .persistHistoryMessages(id, messages)
          .catch(err => this.logger.error(`Failed to persist history messages for ${id}`, String(err)));
      },
      onMessageCreate: (message): void => host.messages.handleOwnSendEcho(id, engine, message),
      onMessageAck: (messageId, status): void => host.messages.handleMessageAck(id, engine, messageId, status),
      onMessageRevoked: (message): void => host.messages.handleMessageRevoked(id, engine, message),
      onMessageReaction: (event): void => {
        if (!host.isLiveEngine(id, engine)) return;
        if (!event.messageId) {
          this.logger.warn('Ignoring message reaction without a target message id', {
            sessionId: id,
            action: 'message_reaction_ignored',
          });
          return;
        }
        this.logger.debug(`Message reaction received: ${event.messageId} -> ${event.reaction}`, {
          sessionId: id,
          messageId: event.messageId,
          action: 'message_reaction_received',
        });

        host.messages.applyReactionQueued(id, event);
      },
      onMessageEdited: (message): void => {
        if (!host.isLiveEngine(id, engine)) return;
        if (!message.messageId) {
          this.logger.warn('Ignoring message edit without a target message id', {
            sessionId: id,
            action: 'message_edit_ignored',
          });
          return;
        }
        this.logger.debug(`Message edited: ${message.messageId}`, {
          sessionId: id,
          messageId: message.messageId,
          action: 'message_edited',
        });

        host.messages.applyMessageEditQueued(id, message);
      },
      onGroupEvent: (event): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.debug(`Group event: ${event.kind} in ${event.groupId}`, {
          sessionId: id,
          groupId: event.groupId,
          kind: event.kind,
          action: 'group_event',
        });
        host.leafEvents.dispatchGroupEvent(id, event);
      },
      onCall: (event: IncomingCallEvent): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.log(`Incoming call from ${event.from}`, {
          sessionId: id,
          callId: event.callId,
          isVideo: event.isVideo,
          isGroup: event.isGroup,
          action: 'call_received',
        });
        const payload: Record<string, unknown> = { ...event };
        host.eventsGateway.emitCallReceived(id, payload);
        void host.webhookService.dispatch(id, 'call.received', payload);
        // Opt-in auto-reject runs AFTER the dispatch so a reject failure can never eat the event.
        void host.leafEvents.maybeAutoRejectCall(id, engine, event.callId);
      },
      onDisconnected: (reason: string): void => {
        if (!host.isLiveEngine(id, engine)) return;
        // Shared with the liveness watchdog (see handleEngineDisconnected). Pass the captured
        // engine so the handler can re-check identity across its DB await — this closure's `engine`
        // (and `session`) snapshots can be stale by the time a disconnect lands, so the handler
        // re-reads the row itself and fences every side effect on `engine` still being the live
        // owner. The captured engine is the exact generation token (no numeric counter).
        void host.handleEngineDisconnected(id, engine, reason);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        if (!host.isLiveEngine(id, engine)) return;
        const statusMap: Record<EngineStatus, SessionStatus> = {
          [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
          [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
          [EngineStatus.QR_READY]: SessionStatus.QR_READY,
          [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
          [EngineStatus.READY]: SessionStatus.READY,
          [EngineStatus.ACTION_REQUIRED]: SessionStatus.ACTION_REQUIRED,
          [EngineStatus.FAILED]: SessionStatus.FAILED,
        };
        const newStatus = statusMap[engineState];
        if (newStatus) {
          persistStatus(newStatus);
        }
      },
      onActionRequired: (reason: string): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.warn(`Session requires operator action: ${reason}`, {
          sessionId: id,
          reason,
          action: 'action_required',
        });
        // Record the reason so the last-error projection surfaces it while the session is
        // ACTION_REQUIRED, then updateStatus (via onStateChanged above) has already written the
        // status. Set here too to be defensive: the callback order is onStateChanged then
        // onActionRequired, but persisting the reason here means it is available regardless.
        host.sessionErrors.set(id, reason);
        void host.hookManager.execute('session:error', { reason }, { sessionId: id, source: 'Engine' });
      },
      onCallOutcome: (event: CallOutcomeEvent): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.log(`Call ${event.outcome}: ${event.callId}`, {
          sessionId: id,
          callId: event.callId,
          outcome: event.outcome,
          action: 'call_outcome',
        });
        const payload: Record<string, unknown> = { sessionId: id, ...event };
        // One event per outcome rather than a single call.ended carrying a field: a consumer that
        // only cares about missed calls should be able to subscribe to exactly that.
        if (event.outcome === 'accepted') {
          host.eventsGateway.emitCallAccepted(id, payload);
          void host.webhookService.dispatch(id, 'call.accepted', payload);
        } else if (event.outcome === 'rejected') {
          host.eventsGateway.emitCallRejected(id, payload);
          void host.webhookService.dispatch(id, 'call.rejected', payload);
        } else {
          host.eventsGateway.emitCallMissed(id, payload);
          void host.webhookService.dispatch(id, 'call.missed', payload);
        }
      },
      onPresenceUpdate: (event: PresenceUpdateEvent): void => {
        if (!host.isLiveEngine(id, engine)) return;
        // WhatsApp reports presence on every transition and freely repeats itself, so only an actual
        // change is published. Without this, one watched chat with an active typist produces a
        // continuous stream of identical events — enough to drown every other webhook a consumer
        // subscribes to. The store is the only thing that knows the previous state, so it decides.
        if (!host.presence.record(id, event)) return;
        const payload: Record<string, unknown> = { sessionId: id, ...event };
        host.eventsGateway.emitPresenceUpdate(id, payload);
        void host.webhookService.dispatch(id, 'presence.update', payload);
      },
      onAccountRestriction: (restriction: AccountRestriction | null): void => {
        if (!host.isLiveEngine(id, engine)) return;

        // A lift is only news if we were holding a restriction; an engine that reports "no
        // restriction" on every connect (the Baileys probe does exactly that) must stay quiet.
        if (!restriction) {
          const lifted = host.sessionRestrictions.clear(id);
          if (lifted) host.reportRestrictionLifted(id, lifted);
          return;
        }

        // Both engines repeat an unchanged restriction — whatsapp-web.js on every reconnect attempt,
        // Baileys on every connect probe — so only a change reaches an operator.
        if (!host.sessionRestrictions.set(id, restriction)) return;

        this.logger.warn(`WhatsApp restricted this session's account: ${restriction.kind}`, {
          sessionId: id,
          kind: restriction.kind,
          code: restriction.code,
          expiresAt: restriction.expiresAt,
          action: 'account_restricted',
        });
        const payload = {
          active: true,
          kind: restriction.kind,
          code: restriction.code,
          expiresAt: restriction.expiresAt ? new Date(restriction.expiresAt).toISOString() : null,
        };
        void host.webhookService.dispatch(id, 'session.restriction', { sessionId: id, ...payload });
        host.eventsGateway.emitSessionRestriction(id, payload);
        // Audited, unlike the engine-level connect/disconnect transitions next door: this is rare,
        // it is not reconnect noise, and the store that serves it to the API is in memory — so this
        // row is the only durable record of when the account was restricted.
        void host.auditService?.logWarn(AuditAction.SESSION_RESTRICTED, {
          sessionId: id,
          metadata: {
            kind: restriction.kind,
            code: restriction.code,
            expiresAt: restriction.expiresAt ? new Date(restriction.expiresAt).toISOString() : null,
          },
          errorMessage: `WhatsApp restricted this account: ${restriction.kind} (${restriction.code})`,
        });
      },
      onError: (reason: string): void => {
        if (!host.isLiveEngine(id, engine)) return;
        this.logger.error(`Session engine failed: ${reason}`, undefined, {
          sessionId: id,
          reason,
          action: 'engine_error',
        });

        // Remember the reason so findOne/findAll can surface it to the dashboard,
        // then persist the FAILED status. This is terminal — no reconnect is
        // scheduled (unlike onDisconnected), since re-scanning is required.
        host.sessionErrors.set(id, reason);

        // A prior onDisconnected may have scheduled a reconnect. This failure is terminal
        // (re-scan required), so cancel it — otherwise the pending timer would resurrect a
        // session the operator must manually restart.
        host.cancelReconnect(id);

        void host.hookManager.execute(
          'session:error',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        persistStatus(SessionStatus.FAILED);

        // onError is terminal (no reconnect is scheduled — re-scan is required). Evict the dead engine
        // and SIGKILL its process: leaving it in the map would hold a concurrency slot indefinitely and
        // make the next start() reject the session as "already started" instead of re-initializing it.
        host.evictAndForceDestroy(id, engine);
      },
      onCredentialTeardownStarted: (operation: Promise<void>): void => {
        // The adapter fired the moment it began the call that ends in an fs.rm of this session's
        // on-disk auth dir. Track it under the captured session NAME (the auth-dir key) — NOT the
        // UUID, and NOT guarded on this engine still being live: a logout that captured this engine
        // must register its destructive promise even as a concurrent stop()/delete() evicts it,
        // because the rm targets the session name's dir and would otherwise race a (re)created
        // session under that same name. `session.name` is the immutable snapshot captured at
        // initializeEngine entry, so a row delete/recreate under the same name cannot poison the key.
        host.trackPendingCredentialTeardown(sessionName, operation);
      },
      claimStuckAuthRecovery: (): boolean => host.claimStuckAuthRecovery(id, engine),
    };
  }
}
