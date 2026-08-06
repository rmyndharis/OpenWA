import { Injectable, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { decideReconnect, type ReconnectAttemptState } from './reconnect-policy';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveEngineInitTimeoutMs } from '../../engine/engine-init-timeout';
import { StatusStoreService } from '../status-store/status-store.service';
import { IWhatsAppEngine, AccountRestriction } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import {
  incrementSessionReconnectAttempts,
  incrementSessionReconnectLoopAlerts,
} from '../../common/metrics/session-reconnect-metrics';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { SessionLifecycleFences } from './session-lifecycle-fences';
import { SessionStatusBroadcaster } from './session-status-broadcaster';
import { SessionEngineLeafEvents } from './session-engine-leaf-events';
import { SessionEngineEventWiring, SessionEngineWiringHost } from './session-engine-event-wiring';
import { SessionEngineControls } from './session-engine-controls';

/**
 * Eager status-history reads are opt-in. On affected freshly paired whatsapp-web.js accounts,
 * fetching status@broadcast before WhatsApp Web's first scheduled reload makes WhatsApp revoke the
 * companion at that reload. Live status events remain unaffected when this backfill is disabled.
 */
const isStatusSeedOnReadyEnabled = (): boolean => process.env.STATUS_SEED_ON_READY === 'true';

// Message types that carry downloadable media. Any persisted row of these types must have a media
// marker in metadata — never NULL — or the dashboard renders an empty bubble (no placeholder) and the
// by-type stats filter skips the row. Sources that lack the payload (wwjs own-send echo, media-free
// history sync) get the omitted marker synthesized at the persistence chokepoints.

export interface ReconnectState extends ReconnectAttemptState {
  /** The pending attempt's timer. Lives here, not in the policy, which stays free of side effects. */
  timer: NodeJS.Timeout | null;
}

// Reconnect-backoff bounds. An OPERATOR-supplied session.config feeds this math, so the values
// are coerced + clamped: a non-numeric value would otherwise make the delay NaN (setTimeout fires
// at 0 — relaunch storm) and the terminal guard `attempts >= NaN` always false (unbounded loop).
const RECONNECT_BASE_DELAY_MIN_MS = 1000;
const RECONNECT_BASE_DELAY_MAX_MS = 300_000;
const RECONNECT_MAX_ATTEMPTS_CAP = 20;

const clampNumber = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/** Coerce + clamp the untyped session.config reconnect knobs to finite, bounded values. Defaults are
 *  a 5000ms base delay and UNLIMITED attempts (`Infinity`): a long-lived session must keep retrying
 *  (the backoff parks at the 1h cap) instead of dying permanently after ~2.5 minutes. An EXPLICIT
 *  `maxReconnectAttempts: 0` (disable) is preserved, and 1..20 clamps as before. */
export function resolveReconnectConfig(
  config: { maxReconnectAttempts?: unknown; reconnectBaseDelay?: unknown } | null,
): { maxAttempts: number; baseDelay: number } {
  const baseRaw = Number(config?.reconnectBaseDelay);
  const baseDelay = clampNumber(
    Number.isFinite(baseRaw) ? baseRaw : 5000,
    RECONNECT_BASE_DELAY_MIN_MS,
    RECONNECT_BASE_DELAY_MAX_MS,
  );
  const attemptsRaw = Number(config?.maxReconnectAttempts);
  const maxAttempts = Number.isFinite(attemptsRaw)
    ? Math.floor(clampNumber(attemptsRaw, 0, RECONNECT_MAX_ATTEMPTS_CAP))
    : Number.POSITIVE_INFINITY;
  return { maxAttempts, baseDelay };
}

export function resolveMaxConcurrentSessions(configService?: Pick<ConfigService, 'get'>): number | null {
  const configured = configService?.get<number>('sessions.maxConcurrent', 0) ?? 0;
  if (!Number.isFinite(configured) || configured <= 0) return null;
  return Math.floor(configured);
}

/**
 * Distinguishes a wedged-initialization timeout from a real engine.initialize() rejection. Only the
 * timeout case is handled inside initializeEngine(); real rejections must propagate untouched so the
 * caller's catch (start() → FAILED+reason, executeReconnect() → retry) keeps the behavior #600/#631
 * established. See initializeEngine().
 */
export class EngineInitTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`engine.initialize() timed out after ${timeoutMs}ms`);
    this.name = 'EngineInitTimeoutError';
  }
}

/**
 * whatsapp-web.js throws this primitive STRING (not an Error) from its inject() auth poll when WA Web's
 * login bootstrap doesn't complete within authTimeoutMs (default 30s). Match it defensively as both the
 * bare string and an Error carrying the same message, since the library's throw shape isn't contracted.
 */
const ENGINE_AUTH_TIMEOUT = 'auth timeout';

/**
 * Diagnostic surfaced when the engine's internal auth-timeout fires (#733): points at the usual cause
 * (the session proxy / network egress / firewall blocking WhatsApp so no QR is ever delivered) and the
 * WWEBJS_AUTH_TIMEOUT_MS knob for legitimately slow first boots.
 */
const ENGINE_AUTH_TIMEOUT_MESSAGE =
  'WhatsApp Web authentication timed out. Verify the session proxy URL and network egress can reach ' +
  'WhatsApp; for slow first boots, raise WWEBJS_AUTH_TIMEOUT_MS.';

function isAuthTimeoutRejection(err: unknown): boolean {
  return err === ENGINE_AUTH_TIMEOUT || (err instanceof Error && err.message === ENGINE_AUTH_TIMEOUT);
}

/**
 * Disconnect reasons that mean WhatsApp revoked this device, as opposed to a link that merely
 * dropped. Only these are audited (#1107): they are one-shot and terminal — no reconnect can
 * restore the link, only a fresh QR can — so they cannot produce the per-attempt flood that keeps
 * the rest of the disconnect transitions out of the audit log.
 *
 * Deliberately not CONFLICT (another device took over, and takeover is recoverable), not
 * DEPRECATED_VERSION (our own client is too old), and not TIMEOUT (a fault, and the single most
 * common reconnect-storm reason). The first three mirror how the whatsapp-web.js adapter classifies
 * the same states.
 *
 * BOTH engines are covered, and they spell it differently: `'logged out'` is the only reason the
 * Baileys adapter ever passes to this callback, emitted for a WhatsApp-originated loggedOut (401)
 * close — the same event, so it must audit the same way. Baileys' other two terminal closes (403
 * forbidden, 440 connectionReplaced) report through onError instead and are not unlinks.
 */
const TERMINAL_UNLINK_REASONS = new Set(['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'logged out']);

/**
 * Owns the live WhatsApp engines and every state machine around them: start/stop/logout/forceKill,
 * delete's engine retirement, reconnect backoff, engine-event wiring, and the credential-teardown /
 * initial-status fences that keep concurrent lifecycle actions serialized. SessionService keeps the
 * session-record API (create/find/stats) and the engine query proxies, and delegates every lifecycle
 * verb here. This service is the ONLY writer of the shared EngineRegistry.
 *
 * init ↔ reconnect is mutually recursive (initializeEngine's onDisconnected schedules a reconnect;
 * executeReconnect calls initializeEngine), so they stay in ONE service — splitting them would need
 * forwardRef(), which this codebase deliberately avoids.
 */
@Injectable()
export class SessionEngineLifecycle {
  private readonly logger = createLogger('SessionEngineLifecycle');

  // Live engine instances, owned by the shared EngineRegistry (the narrow port feature modules
  // inject instead of this whole service). This service is the only writer: it creates, replaces and
  // retires engines. `engines` remains a local alias so the lifecycle code below reads unchanged.
  private get engines(): EngineRegistry {
    return this.engineRegistry;
  }

  // Extracted units (plain classes constructed in the constructor below — the TestingModule-frozen
  // provider list means they can't be NestJS providers). The same-named delegates further down
  // keep every call site and spec poke byte-identical (the baileys forwarder precedent).
  private readonly fences: SessionLifecycleFences;
  private readonly broadcaster: SessionStatusBroadcaster;
  private readonly leafEvents: SessionEngineLeafEvents;
  private readonly eventWiring: SessionEngineEventWiring;
  private readonly wiringHost: SessionEngineWiringHost;
  private readonly controls: SessionEngineControls;

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // The status de-dup map is OWNED by the broadcaster (its updateStatus reads/writes it); this
  // getter aliases that exact instance BY REFERENCE (the liveCalls precedent) so the spec's
  // `lastDispatchedStatus.set(...)` / `.get(...)` pokes land on the same Map.
  private get lastDispatchedStatus(): Map<string, SessionStatus> {
    return this.broadcaster.lastDispatchedStatus;
  }

  // Sessions currently being stopped/deleted. An in-flight executeReconnect awaits
  // engine init, so a stop/delete during that window could re-register an engine AFTER
  // teardown (orphan). stop()/delete() add the id here; executeReconnect checks it after its
  // awaits and destroys any engine it just created; start() clears it (intentional restart).
  private stoppingSessions: Set<string> = new Set();

  // Sessions whose engine is mid-initialization (a start() is in flight). Reserved synchronously
  // in start() so a near-simultaneous second start() can't pass the engines.has() check during the
  // awaited hook and orphan an engine the lifecycle could never destroy. Backed by the registry so
  // the infra import pre-flight sees starting sessions through the same port.
  private get initializingSessions(): Set<string> {
    return this.engineRegistry.initializing;
  }

  // Destructive credential-teardown promises (logout rms of the session's on-disk WhatsApp auth
  // dir), keyed by session NAME — the on-disk auth-dir key (EngineFactory.wwjsAuthDir/baileysAuthDir
  // and adapter clearLocalAuth all build the path from Session.name), NOT the UUID. A losing
  // logout() promise keeps running past its deadline race and ends in an fs.rm of that dir — the
  // same path a later start() under the SAME name re-creates — so start()/delete()/executeReconnect
  // consult this map and wait (bounded, fail-closed) for settlement before touching that path. After
  // an old UUID's session is deleted and the name is recreated, a late logout from the old UUID
  // still targets the new session's dir (same name → same path), so keying by name keeps the fence
  // attached to the credential path that is actually at risk. Entries self-remove on settlement
  // (identity-checked); nothing else evicts them (delete()'s finally no longer drops them).
  private readonly pendingTeardowns = new Map<string, Promise<void>>();

  // The in-flight `updateStatus(INITIALIZING)` write keyed by id, carrying the EXACT engine it
  // belongs to. initializeEngine registers the engine, then awaits this write before calling
  // adapter initialize(); a lifecycle control (stop/logout/delete/forceKill) can retire the engine
  // during that awaited write. To keep the control action the final persisted owner, every retiring
  // control awaits the captured engine's exact pending promise (looked up by object identity) after
  // setting the stop mark + cancelling reconnect and BEFORE its teardown / final DISCONNECTED write
  // / parent-row deletion. Settlement and removal are identity-checked on both {engine, promise} so
  // a delayed INITIALIZING for engine A can never be awaited as / delete the entry of a replacement
  // engine B the control action did not capture.
  private readonly pendingInitialStatuses = new Map<string, { engine: IWhatsAppEngine; promise: Promise<void> }>();

  // The ONE-SHOT budget for an automatic stuck-auth credential reset, hoisted out of the adapter
  // instance and keyed by session id. recoverFromStuckAuth() (a generation that authenticated but
  // never reached readiness) claims this synchronously before it wipes LocalAuth; a claim returns true
  // EXACTLY once per episode. Automatic reconnects build a FRESH adapter, so an instance-local budget
  // would reset every generation and wipe credentials forever (the QR -> timeout -> clear loop). The
  // session owns the budget so it survives across reconnect generations within one episode.
  //
  // Cleared ONLY on: an accepted top-level start() (after the duplicate/cap/name-fence checks pass,
  // just before initializeEngine — boot auto-start uses the same method); onReady (recovery proved
  // successful); and a COMMITTED delete (after the parent transaction). NOT cleared on a rejected
  // start, executeReconnect, disconnect, QR, auth failure, engine replacement, or a failed/409 delete.
  private readonly stuckAuthRecoveryUsed = new Set<string>();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    // messageRepository is NOT injected here (it is a dead dep in SessionService too): delete()'s
    // cascade goes through the transaction manager (manager.delete), never the repository.
    private readonly engineFactory: EngineFactory,
    private readonly engineRegistry: EngineRegistry,
    private readonly watchdog: SessionLivenessWatchdog,
    private readonly messages: MessageProjector,
    private readonly sessionErrors: SessionErrorStore,
    private readonly sessionRestrictions: SessionRestrictionStore,
    private readonly presence: PresenceStore,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly statusStore: StatusStoreService,
    @Optional()
    private readonly configService?: ConfigService,
    // Draining flag (set on a termination signal or an admin restart). Used to suppress a mid-shutdown
    // reconnect that would launch a fresh Chromium racing the shutdown teardown. @Optional so the
    // service degrades to today's behaviour if it is ever constructed without the (global) LoggerModule.
    @Optional()
    private readonly shutdownService?: ShutdownService,
    // @Optional so the existing spec constructions keep working. AuditModule is @Global, so a
    // running gateway always has it.
    @Optional()
    private readonly auditService?: AuditService,
  ) {
    // The fence Maps are handed over BY REFERENCE: they stay lifecycle fields (specs poke them
    // through the lifecycle), while the fence logic operates on the same instances.
    this.fences = new SessionLifecycleFences({
      engines: this.engineRegistry,
      pendingTeardowns: this.pendingTeardowns,
      pendingInitialStatuses: this.pendingInitialStatuses,
      logger: this.logger,
    });
    this.broadcaster = new SessionStatusBroadcaster({
      sessionRepository: this.sessionRepository,
      eventsGateway: this.eventsGateway,
      webhookService: this.webhookService,
      logger: this.logger,
    });
    this.leafEvents = new SessionEngineLeafEvents({
      sessionRepository: this.sessionRepository,
      eventsGateway: this.eventsGateway,
      webhookService: this.webhookService,
      configService: this.configService,
      statusStore: this.statusStore,
      logger: this.logger,
    });
    this.eventWiring = new SessionEngineEventWiring({ logger: this.logger });
    // The wiring host is built ONCE here: arrow closures bind the live methods/state (never a
    // stale copy — specs replace some deps at runtime), and the leaf deps are handed over by
    // reference. Every closure is a deliberately NON-async passthrough returning the callee's own
    // promise object untouched (the Task-1 delegate rule: an `async` wrapper would adopt the inner
    // promise and add settlement hops the retirement-race specs assert against).
    this.wiringHost = {
      isLiveEngine: (id, engine) => this.isLiveEngine(id, engine),
      handleEngineReady: (id, engine, phone, pushName) => this.handleEngineReady(id, engine, phone, pushName),
      handleEngineDisconnected: (id, engine, reason) => this.handleEngineDisconnected(id, engine, reason),
      updateStatus: (id, status) => this.updateStatus(id, status),
      cancelReconnect: id => this.cancelReconnect(id),
      evictAndForceDestroy: (id, engine) => this.evictAndForceDestroy(id, engine),
      trackPendingCredentialTeardown: (sessionName, raw) => this.trackPendingCredentialTeardown(sessionName, raw),
      reportRestrictionLifted: (id, lifted) => this.reportRestrictionLifted(id, lifted),
      claimStuckAuthRecovery: (id, engine) => {
        // SYNCHRONOUS atomic claim for the one-shot automatic credential-reset budget. The adapter
        // calls this right before it would wipe LocalAuth (recoverFromStuckAuth); a denial makes the
        // adapter fail terminally WITHOUT touching the auth dir. Two guards, in order:
        //  1. the captured engine must still be the live owner — a stale generation (superseded by a
        //     reconnect/restart) must never spend the budget for the current owner;
        //  2. the session id must not already be in the Set — the budget is one claim per episode.
        // Synchronous on purpose: the race between the stuck-auth timeout and a concurrent
        // start()/reconnect is decided within a single event-loop turn (no await between the checks
        // and the Set mutation).
        if (!this.isLiveEngine(id, engine)) return false;
        if (this.stuckAuthRecoveryUsed.has(id)) return false;
        this.stuckAuthRecoveryUsed.add(id);
        return true;
      },
      messages: this.messages,
      sessionErrors: this.sessionErrors,
      sessionRestrictions: this.sessionRestrictions,
      presence: this.presence,
      auditService: this.auditService,
      webhookService: this.webhookService,
      eventsGateway: this.eventsGateway,
      hookManager: this.hookManager,
      leafEvents: this.leafEvents,
    };
    // The controls host wires the extracted control verbs: the dependency values are captured at
    // construction, the shared Sets/Maps and the Task-1 units go over BY REFERENCE (specs poke them
    // through the lifecycle), `dataSource` is a LIVE closure (specs replace it on the instance at
    // runtime — delete()'s transaction must read the current value at call time), and the core
    // call-ins are NON-async passthrough closures (the Task-1 delegate rule above).
    this.controls = new SessionEngineControls({
      sessionRepository: this.sessionRepository,
      engineFactory: this.engineFactory,
      engines: this.engineRegistry,
      sessionErrors: this.sessionErrors,
      sessionRestrictions: this.sessionRestrictions,
      presence: this.presence,
      hookManager: this.hookManager,
      configService: this.configService,
      logger: this.logger,
      dataSource: () => this.dataSource,
      fences: this.fences,
      broadcaster: this.broadcaster,
      cancelReconnect: id => this.cancelReconnect(id),
      initializeEngine: (id, session) => this.initializeEngine(id, session),
      isSessionRetired: id => this.isSessionRetired(id),
      purgeAuthDirsIfDeleted: (id, name) => this.purgeAuthDirsIfDeleted(id, name),
      updateStatus: (id, status) => this.updateStatus(id, status),
      stoppingSessions: this.stoppingSessions,
      reconnectStates: this.reconnectStates,
      stuckAuthRecoveryUsed: this.stuckAuthRecoveryUsed,
      initializingSessions: this.initializingSessions,
    });
  }

  // --- Control-verb delegates (SessionEngineControls) ------------------------------------------
  // The 7 public control verbs forward onto the extracted unit, so SessionService's public API
  // path (and every spec calling the verbs on the lifecycle) stays byte-identical. The method
  // contracts (docblocks — including logout's 502 contract and delete's transaction-flow comments)
  // moved to session-engine-controls.ts with the bodies. These forwarders are deliberately
  // NON-async: they return the unit's own promise object untouched, preserving the exact microtask
  // settlement profile the inline methods had (the Task-1 delegate rule above).

  /** Delegate: SessionEngineControls.start. */
  start(id: string): Promise<Session> {
    return this.controls.start(id);
  }

  /** Delegate: SessionEngineControls.stop. */
  stop(id: string): Promise<Session> {
    return this.controls.stop(id);
  }

  /** Delegate: SessionEngineControls.logout. */
  logout(id: string): Promise<Session> {
    return this.controls.logout(id);
  }

  /** Delegate: SessionEngineControls.forceKill. */
  forceKill(id: string): Promise<Session> {
    return this.controls.forceKill(id);
  }

  /** Delegate: SessionEngineControls.delete. */
  delete(id: string): Promise<void> {
    return this.controls.delete(id);
  }

  /** Delegate: SessionEngineControls.shutdown. */
  shutdown(): Promise<void> {
    return this.controls.shutdown();
  }

  /** Delegate: SessionEngineControls.stopOrphanEngines. */
  stopOrphanEngines(sessionIds: string[]): Promise<{ stopped: string[]; notRunning: string[]; failed: string[] }> {
    return this.controls.stopOrphanEngines(sessionIds);
  }

  // --- Fence delegates (SessionLifecycleFences) ------------------------------------------------
  // Same-named, same-signature forwarders onto the extracted unit, so every existing call site
  // below — and the spec invoking `trackPendingCredentialTeardown` by name — stays byte-identical.
  // The method contracts (docblocks) moved to session-lifecycle-fences.ts with the bodies.
  // These forwarders are deliberately NON-async: they return the unit's own promise object
  // untouched, so callers observe the exact microtask settlement profile the inline methods had
  // (an `async` wrapper would adopt the inner promise and add settlement hops, which the
  // pre-initialize retirement-race specs assert against).

  /** Delegate: SessionLifecycleFences.teardownEngineSafely. */
  private teardownEngineSafely(
    sessionId: string,
    engine: IWhatsAppEngine,
    teardown: (e: IWhatsAppEngine) => Promise<void>,
    label: 'destroy' | 'disconnect' | 'force-destroy' | 'logout',
    sessionName?: string,
  ): Promise<boolean> {
    return this.fences.teardownEngineSafely(sessionId, engine, teardown, label, sessionName);
  }

  /** Delegate: SessionLifecycleFences.trackPendingCredentialTeardown. */
  private trackPendingCredentialTeardown(sessionName: string, raw: Promise<void>): void {
    this.fences.trackPendingCredentialTeardown(sessionName, raw);
  }

  /** Delegate: SessionLifecycleFences.awaitPendingTeardown. */
  private awaitPendingTeardown(sessionName: string): Promise<void> {
    return this.fences.awaitPendingTeardown(sessionName);
  }

  /** Delegate: SessionLifecycleFences.evictAndForceDestroy. */
  private evictAndForceDestroy(id: string, engine: IWhatsAppEngine): void {
    this.fences.evictAndForceDestroy(id, engine);
  }

  /**
   * Set the tearing-down mark synchronously, before any awaited work a retiring control performs.
   *
   * The pre-initialize retirement race turns on this mark being visible to initializeEngine's
   * post-INITIALIZING check (line ~507) by the time that awaited DB write settles. stop()/delete()
   * both add the mark internally, but only AFTER their own first await (requireSession /
   * awaitPendingTeardown), and the ownership fence added another await ahead of them — so the mark
   * could land after the window it guards. Exposing it lets SessionService set it at true entry,
   * with nothing awaited in between; a mark left behind by a request that then refuses (a 409) is
   * harmless and is cleared by the next start(), which is what the mark is designed for.
   */
  markStopping(id: string): void {
    this.stoppingSessions.add(id);
  }

  /**
   * True while this process still has anything alive for the session: a registered engine, an
   * in-flight start(), or reconnect state whose armed/executing attempt will re-register one.
   * The ownership heartbeat consults this so a claim that no longer covers an engine stops being
   * renewed and can lapse for a peer to adopt; the service-level release paths consult it so an
   * "already starting/started" refusal never releases a session this node genuinely runs.
   */
  isEngineActive(id: string): boolean {
    if (this.engines.has(id) || this.initializingSessions.has(id)) return true;
    // Reconnect state counts only while an attempt is actually pending: a timer armed by
    // scheduleReconnect, or one that has fired and is running executeReconnect (which leaves the
    // spent handle in place and has already counted its attempt). The entry start() creates up
    // front — {attempts: 0, timer: null} — is dormant: a start that then failed leaves nothing
    // that will ever re-register an engine, and treating it as liveness would pin the claim to
    // this node forever.
    const reconnect = this.reconnectStates.get(id);
    return reconnect != null && (reconnect.timer !== null || reconnect.attempts > 0);
  }

  // --- Leaf-event delegates (SessionEngineLeafEvents) ------------------------------------------
  // Same-named, same-signature forwarders onto the extracted unit, so handleEngineReady's call
  // site stays byte-identical (the wiring reaches the unit directly through host.leafEvents).
  // The method contracts (docblocks) moved to session-engine-leaf-events.ts with the bodies.
  // The promise-returning forwarders are deliberately NON-async (the Task-1 rule above).

  /** Delegate: SessionEngineLeafEvents.seedStatuses. */
  private seedStatuses(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    return this.leafEvents.seedStatuses(sessionId, engine);
  }

  /**
   * True only while `engine` is still the live engine registered for `id`. Each callback below
   * captures its own engine instance; once the session is stopped (engine removed from the map) or
   * restarted/reconnected (engine replaced), a late callback from the superseded engine must not
   * mutate the session that now belongs to a different — or no — engine. The registry is the
   * single source of truth for the active engine, so identity comparison closes both the
   * post-stop and the stale-generation (stop→start / reconnect-replace) windows the one-shot
   * post-init guard does not cover.
   */
  private isLiveEngine(id: string, engine: IWhatsAppEngine): boolean {
    return this.engines.isLive(id, engine);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      dbSessionId: id,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);
    // Presence subscriptions live on the socket, so a fresh engine has none — whatever the previous
    // connection last reported is now unverifiable and would be served as if it were current.
    this.presence.clear(id);
    // Clear any prior failure reason before a fresh start. A recorded account restriction is
    // deliberately NOT cleared here: it describes the account, not this attempt, so a restart does
    // not resolve it — and clearing it per attempt would make it flicker off and on through a
    // reconnect loop, re-announcing one unchanged block on every pass. It is dropped where it is
    // actually disproved (handleEngineReady) or reported lifted.
    this.sessionErrors.clear(id);

    // Mark INITIALIZING before engine.initialize(): the engine drives status forward
    // (QR_READY -> AUTHENTICATING -> READY) through the callbacks below while it
    // initializes, so writing INITIALIZING afterwards would clobber that progress.
    //
    // The INITIALIZING write is awaited here, and a lifecycle control (stop/logout/delete/forceKill)
    // can retire this engine during that await. To keep the control action the final persisted owner,
    // the in-flight write is tracked in pendingInitialStatuses (carrying this exact engine) so each
    // retiring control can await ITS captured engine's write before its own final mutation. After the
    // await, ownership is re-validated by object identity + the synchronous stop mark before the
    // adapter is allowed to initialize — a retired engine must never reach initialize() (which would
    // re-arm a torn-down adapter and open an untracked socket).
    const initialStatusPromise = this.updateStatus(id, SessionStatus.INITIALIZING);
    this.pendingInitialStatuses.set(id, { engine, promise: initialStatusPromise });
    try {
      await initialStatusPromise;
    } finally {
      // Remove ONLY this engine's entry: a replacement created by a concurrent start()/reconnect
      // (different engine object) must not have its pending entry evicted by this settlement.
      const pending = this.pendingInitialStatuses.get(id);
      if (pending && pending.engine === engine && pending.promise === initialStatusPromise) {
        this.pendingInitialStatuses.delete(id);
      }
    }

    // After the awaited DB write, re-validate ownership before scheduling initialization. The stop
    // mark is set synchronously by every retiring control BEFORE it awaits this engine's pending
    // write, so checking it here (no DB read on the healthy path) closes the pre-initialize window
    // without changing reconnect-when-reload-fails semantics. isLiveEngine guards the stop-mark-less
    // timeout path and any replacement. There is intentionally NO await between these checks and
    // engine.initialize() below — an intervening await would re-open the retirement window, and it is
    // also why ONE isLiveEngine check is enough: the two guards are separated by a synchronous Set
    // lookup, so nothing can swap the engine between them (a second, identical check used to sit
    // after the stop mark and could never disagree with this one).
    if (!this.isLiveEngine(id, engine)) {
      return;
    }
    if (this.stoppingSessions.has(id)) {
      return;
    }

    // The 17-callback table moved to SessionEngineEventWiring (session-engine-event-wiring.ts):
    // per-callback liveness gating (five callbacks are deliberately UNGATED), every nested call's
    // order, and the synchronous one-shot stuck-auth claim are preserved there, reaching the
    // lifecycle's live methods/state through the wiringHost built in the constructor.
    // `session.name` is handed over as the immutable snapshot onCredentialTeardownStarted keys on.
    const initPromise = engine.initialize(this.eventWiring.buildCallbacks(id, engine, session.name, this.wiringHost));

    // engine.initialize() launches Chromium and navigates to WhatsApp Web with no internal timeout:
    // whatsapp-web.js calls page.goto(..., { timeout: 0 }) and its web-version-cache fetch has none
    // either. If the browser stalls under container memory pressure (observed in prod: a session
    // wedged in INITIALIZING with no error logged and GET /sessions/:id/qr 400ing forever), this
    // await never settles. Race it against a deadline so a wedged init fails fast instead.
    //
    // ONLY the timeout case mutates state here. A REAL rejection (e.g. Chromium can't launch) must
    // propagate untouched so start()'s catch keeps owning FAILED+reason (the diagnosability #600/#631
    // added) — pre-deleting the engine and writing DISCONNECTED here would make start()'s
    // `engines.get(id)` return undefined, skip its FAILED write, and hide the failure reason.
    // The deadline must clear the auth wait an engine runs INSIDE initialize(), or it would SIGKILL a
    // legitimately slow init mid-auth — see resolveEngineInitTimeoutMs for the derivation.
    const engineInitTimeoutMs = resolveEngineInitTimeoutMs();
    // Promise.race can't cancel the losing promise, so swallow a late rejection from initPromise.
    initPromise.catch(() => undefined);

    let initTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        initPromise,
        new Promise<never>((_, reject) => {
          initTimer = setTimeout(() => reject(new EngineInitTimeoutError(engineInitTimeoutMs)), engineInitTimeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof EngineInitTimeoutError) {
        this.logger.error(`Engine initialization timed out for session ${session.name}`, undefined, {
          sessionId: id,
          action: 'engine_init_timeout',
        });
        this.sessionErrors.set(id, err.message);
        // Evict from the map BEFORE tearing down. forceDestroy() → beginClientTeardown → setStatus
        // fires onStateChanged SYNCHRONOUSLY while the engine is still live, so isLiveEngine would
        // pass and the callback would run a redundant DISCONNECTED write against this path; removing
        // the engine first makes isLiveEngine return false. Unlike delete()/stop()/forceKill(), this
        // path has no stoppingSessions + cancelReconnect wrap to fall back on. Matches the canonical
        // delete-before-teardown at evictAndForceDestroy() and start()'s catch.
        //
        // Do NOT port this reorder to delete()/stop()/forceKill(): there, engines.has(id) staying
        // TRUE for the duration of the teardown await is the sole deterministic block on a concurrent
        // start() (start() clears stoppingSessions rather than rejecting on it), so delete-first would
        // open a start()-during-teardown orphan-engine window. Verified in the teardown-ordering audit.
        this.engines.delete(id);
        // Force-kill whatever got launched so a retry doesn't collide with an orphaned browser.
        // teardownEngineSafely is itself time-bound, so this can't wedge a second time.
        await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
        await this.updateStatus(id, SessionStatus.DISCONNECTED);
        // Map to a diagnostic 504 like the auth-timeout branch below, so a wedged init doesn't escape as a
        // bare 500 (#733 follow-up). The browser stalled mid-startup — usually a container memory/resource
        // limit or a wedged Chromium, not a network/proxy issue (that's the auth-timeout's signature).
        throw new HttpException(
          `Engine initialization timed out after ${err.timeoutMs}ms — the browser process did not complete ` +
            'startup in time (often a container memory/resource limit or a stalled Chromium, not a network ' +
            'issue). Retry the session; for chronically slow first boots, raise WWEBJS_AUTH_TIMEOUT_MS.',
          HttpStatus.GATEWAY_TIMEOUT,
        );
      } else if (isAuthTimeoutRejection(err)) {
        // The engine's INTERNAL auth-timeout: whatsapp-web.js throws the primitive string 'auth timeout'
        // (see ENGINE_AUTH_TIMEOUT) when its inject poll exhausts authTimeoutMs (default 30s) — the common
        // pre-QR failure when the browser launched but couldn't reach WhatsApp, e.g. a dead/unreachable
        // session proxy (#733). onError already evicted the engine + wrote FAILED before this catch ran, so
        // only the HTTP mapping remains: surface a diagnostic 504 instead of letting the bare string escape
        // to NestJS's default handler as a meaningless 500.
        throw new HttpException(ENGINE_AUTH_TIMEOUT_MESSAGE, HttpStatus.GATEWAY_TIMEOUT);
      }
      throw err;
    } finally {
      if (initTimer) clearTimeout(initTimer);
    }
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  private handleEngineReady(id: string, engine: IWhatsAppEngine, phone: string, pushName: string): void {
    if (!this.isLiveEngine(id, engine)) return;
    this.logger.log(`Session ready: ${phone}`, {
      sessionId: id,
      phone,
      pushName,
      action: 'ready',
    });

    void this.webhookService.dispatch(id, 'session.authenticated', { sessionId: id, phone, pushName });
    this.eventsGateway.emitSessionAuthenticated(id, { phone, pushName });

    // Execute hook for ready event
    void this.hookManager.execute(
      'session:ready',
      { phone, pushName },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    // Reset reconnect attempts and clear any stale failure reason on success
    const reconnectState = this.reconnectStates.get(id);
    if (reconnectState) {
      reconnectState.attempts = 0;
    }
    // A fresh READY stretch starts the watchdog's failure budget clean too.
    this.watchdog.clear(id);
    this.sessionErrors.clear(id);
    // Being linked and ready is proof that a connection-level block is over — it is exactly what such
    // a block prevents. A reachout timelock survives: it never stopped the session connecting.
    const liftedByReady = this.sessionRestrictions.clearIfDisprovedByReady(id);
    if (liftedByReady) {
      this.reportRestrictionLifted(id, liftedByReady);
    }
    // READY proves any in-flight stuck-auth recovery succeeded (or none was needed), so the
    // one-shot recovery budget is re-armed for a future episode.
    this.stuckAuthRecoveryUsed.delete(id);

    void this.sessionRepository
      .update(id, {
        status: SessionStatus.READY,
        phone,
        pushName,
        connectedAt: new Date(),
        lastActiveAt: new Date(),
      })
      .catch(err =>
        this.logger.warn('Failed to persist session ready state', {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // Best-effort snapshot of the account's own contacts' currently-active statuses. Live status
    // posts arrive through onMessage below; this just backfills what was already up before we
    // connected. Not awaited — onReady must not block on it.
    if (isStatusSeedOnReadyEnabled()) {
      void this.seedStatuses(id, engine);
    } else {
      this.logger.debug('Status backfill on session ready is disabled', {
        sessionId: id,
        action: 'status_seed_on_ready_disabled',
      });
    }
  }

  /**
   * Announce that a restriction has ended. Shared by the two paths that can end one — the engine
   * reporting it lifted, and a session reaching READY despite a connection-level block — so the two
   * cannot drift into announcing the same thing differently. The caller has already removed it from
   * the store and passes what was removed, since the payload describes the restriction that ended.
   */
  reportRestrictionLifted(id: string, lifted: AccountRestriction): void {
    // Phrased as "no longer in force" rather than "WhatsApp lifted it": only one of the two paths is
    // WhatsApp saying so. The other infers it from the session having connected, and the log should
    // not claim more than was actually observed.
    this.logger.log(`The ${lifted.kind} restriction on this session is no longer in force`, {
      sessionId: id,
      kind: lifted.kind,
      code: lifted.code,
      action: 'account_restriction_lifted',
    });
    void this.webhookService.dispatch(id, 'session.restriction', {
      sessionId: id,
      active: false,
      kind: lifted.kind,
      code: lifted.code,
      expiresAt: null,
    });
    this.eventsGateway.emitSessionRestriction(id, {
      active: false,
      kind: lifted.kind,
      code: lifted.code,
      expiresAt: null,
    });
    void this.auditService?.logInfo(AuditAction.SESSION_RESTRICTION_LIFTED, {
      sessionId: id,
      metadata: { kind: lifted.kind, code: lifted.code },
    });
  }

  /**
   * Shared disconnect handling for BOTH the engine's onDisconnected callback and the liveness
   * watchdog: notify consumers (webhook + WS + hook), persist DISCONNECTED, then schedule a
   * reconnect. The session row is re-read here rather than trusting a caller-held snapshot — the
   * watchdog detects death long after the last state change, and even the callback's closure
   * snapshot can be stale — so the reconnect always re-initializes from the current row. Never
   * throws: a DB hiccup must not turn a disconnect into an unhandled rejection.
   *
   * Concurrency fence: the caller has already gated entry on `isLiveEngine(id, engine)` against
   * the synchronous-callback window, but this handler awaits a DB read and (later) schedules work
   * off a captured `session` snapshot. Between the entry check and the awaits an id can be
   * reassigned — a stop()/reconnect that replaces the engine mid-flight — so the captured engine
   * is treated as an object-identity generation token: every observable side effect and the
   * reconnect scheduling are gated on `engine` STILL being the live owner at the point they run.
   * A stale disconnect handler must not publish disconnect side effects for a session that now
   * belongs to a different engine, nor schedule a reconnect whose timer would later destroy the
   * replacement engine.
   */
  async handleEngineDisconnected(id: string, engine: IWhatsAppEngine, reason: string): Promise<void> {
    // Entry fence: the caller already checked liveness, but the gap between that check and this
    // call site is enough for a stop()/reconnect to swap the engine. Re-verify before doing work.
    if (!this.isLiveEngine(id, engine)) return;

    let session: Session | null;
    try {
      session = await this.sessionRepository.findOne({ where: { id } });
    } catch (err) {
      this.logger.error('Failed to reload the session for reconnect scheduling', String(err), {
        sessionId: id,
        action: 'reconnect_schedule_error',
      });
      return;
    }
    // A session deleted just before this ran has nothing left to reconnect; skip it.
    if (!session) return;

    // Post-await fence: the findOne yield above is the window in which a stop()/reconnect can
    // replace the engine for this id. Only a STILL-live owner may publish disconnect side effects
    // or change the persisted status — otherwise a stale disconnect would (e.g.) clobber a
    // replacement engine that is already READY.
    if (!this.isLiveEngine(id, engine)) return;

    this.logger.warn(`Session disconnected: ${reason}`, {
      sessionId: id,
      reason,
      action: 'disconnected',
    });

    // #1107: everything else this method does with `reason` is ephemeral — a log line, a webhook, a
    // socket emit, a plugin hook — and the only DB write below is the status. So once the process
    // restarts, a WhatsApp unlink is indistinguishable over the API from a network drop: both read
    // `disconnected` with a null `lastError`. Audit the unlinks, and only those. That is the same
    // test SESSION_RESTRICTED already passes next door — rare, not reconnect noise, no other durable
    // record — and it keeps the objection that keeps the rest unemitted intact, since a flapping
    // connection retries with TIMEOUT/NAVIGATION and never with one of these.
    if (TERMINAL_UNLINK_REASONS.has(reason)) {
      void this.auditService?.logWarn(AuditAction.SESSION_DISCONNECTED, {
        sessionId: id,
        metadata: { reason },
        errorMessage: `WhatsApp unlinked this device (${reason}); the session must be re-paired with a fresh QR`,
      });
    }

    void this.webhookService.dispatch(id, 'session.disconnected', { sessionId: id, reason });
    this.eventsGateway.emitSessionDisconnected(id, { reason });

    // Execute hook for disconnected event
    void this.hookManager.execute(
      'session:disconnected',
      { reason },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    void this.updateStatus(id, SessionStatus.DISCONNECTED);

    // Pre-schedule fence: scheduleReconnect's timer eventually calls executeReconnect, which does
    // a fresh engines.get(id) and destroys whatever engine currently owns the id. If this engine
    // was superseded since the post-await check above (no await sits between them today, but this
    // is the load-bearing boundary for the reconnect), that timer would destroy the replacement.
    // Object-identity is the exact generation token, so check once more immediately before arming.
    if (!this.isLiveEngine(id, engine)) return;

    // Attempt to reconnect
    this.scheduleReconnect(id, session);
  }

  private scheduleReconnect(id: string, session: Session): void {
    // Don't launch a fresh engine (Chromium) mid-shutdown: a disconnect during the drain window would
    // otherwise schedule a reconnect that races the shutdown teardown and could orphan a browser.
    // Leaving the session DISCONNECTED is the correct end state — a later start()/auto-restore
    // re-initializes it cleanly.
    if (this.shutdownService?.isShuttingDown()) {
      this.logger.log(`Skipping reconnect during shutdown for session: ${session.name}`, { sessionId: id });
      return;
    }

    const state = this.reconnectStates.get(id);
    if (!state) return;

    // All the backoff rules (stability reset, budget, exponential delay, loop cadence) live in the
    // pure policy; this method only applies the effects the decision calls for.
    const decision = decideReconnect(state);

    if (decision.kind === 'exhausted') {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      // Don't leave the session silently stuck DISCONNECTED — mark it terminally FAILED with a reason
      // so findOne/findAll surface it via `lastError` and the dashboard shows it needs a restart.
      this.sessionErrors.set(id, decision.reason);
      void this.updateStatus(id, SessionStatus.FAILED);
      // Terminal path — evict the dead engine so it neither holds a concurrency slot nor makes a
      // subsequent start() reject the session as "already started". This mirrors onError's terminal
      // path (the same rationale: leaving the engine in the map wedges the session). The engine may
      // already be gone in the executeReconnect-catch path (it evicts the half-built engine before
      // scheduling a reconnect), so guard on its presence — evictAndForceDestroy takes a non-null engine.
      const deadEngine = this.engines.get(id);
      if (deadEngine) {
        this.evictAndForceDestroy(id, deadEngine);
      }
      // Terminal: drop the reconnect state too. Nothing fires again for this episode, and a stale
      // entry would keep isEngineActive() true — the ownership heartbeat would renew the claim on
      // a session with no engine, pinning it to this node. start() builds fresh state anyway.
      this.cancelReconnect(id);
      return;
    }

    const delay = decision.delayMs;
    const maxAttemptsLabel = Number.isFinite(state.maxAttempts) ? String(state.maxAttempts) : '∞';
    this.logger.log(
      `Scheduling reconnect attempt ${decision.attempt}/${maxAttemptsLabel} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: decision.attempt,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    incrementSessionReconnectAttempts();

    // One operator-facing signal per ongoing episode, not spam per attempt (see the policy).
    if (decision.loopAlert) {
      this.logger.warn(`Session is reconnect-looping: attempt ${decision.attempt} scheduled`, {
        sessionId: id,
        attempts: decision.attempt,
        nextDelayMs: delay,
        action: 'reconnect_loop',
      });
      incrementSessionReconnectLoopAlerts();
      void this.webhookService.dispatch(id, 'session.reconnect_loop', {
        sessionId: id,
        attempts: decision.attempt,
        nextDelayMs: delay,
      });
    }

    // Clear any timer a prior scheduleReconnect left pending so two back-to-back disconnects
    // don't stack two timers (which would run executeReconnect twice and double-init the engine).
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  /**
   * True once a session must stay down: it is explicitly marked tearing-down, or it was deleted
   * outright while a slow engine.initialize() was in flight. delete() clears its `stoppingSessions`
   * mark in its finally (ms) and removes the session row well before a Chromium launch resolves, so
   * the mark alone can't catch a delete that raced a (re)connect — the session row is the source of
   * truth a post-init guard must re-check before keeping the engine it just created.
   */
  private async isSessionRetired(id: string): Promise<boolean> {
    if (this.stoppingSessions.has(id)) {
      return true;
    }
    return (await this.sessionRepository.findOne({ where: { id } })) == null;
  }

  /**
   * Re-purge a retired session's on-disk auth dirs when its row was deleted while a slow
   * engine.initialize() was still in flight. A start()/(re)connect that lands between delete()'s
   * engine eviction and its row removal initializes a fresh engine that RE-CREATES the auth dir
   * purgeSessionData just emptied (both engines mkdir at init); the post-init guard tears the engine
   * down, but engine teardown never touches the on-disk dirs, so without this second purge the race
   * leaves live WhatsApp credentials behind — and a later same-name recreate would silently re-link
   * them. Gated two ways so ONLY the delete race purges: a stop() retirement still has its row (its
   * credentials must survive), and a row re-created under the SAME name now owns those dirs, so
   * purging would wipe the fresh session's link. Best-effort: a failure is logged, never thrown —
   * the retirement path must still surface the deleted session as NotFound.
   */
  private async purgeAuthDirsIfDeleted(id: string, name: string): Promise<void> {
    try {
      if ((await this.sessionRepository.findOne({ where: { id } })) != null) return;
      if ((await this.sessionRepository.findOne({ where: { name } })) != null) return;
      await this.engineFactory.purgeSessionData(name);
    } catch (error) {
      this.logger.warn('Failed to re-purge session auth dirs after a start/delete race', {
        sessionId: id,
        action: 'engine_repurge_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    // The session may have been stopped/deleted before this fired — don't resurrect it.
    if (this.stoppingSessions.has(id)) {
      return;
    }
    try {
      // Clean up old engine. Time-bound the teardown: a wedged Chromium (the common reconnect
      // trigger) makes destroy() hang, and a raw await here would stall the reconnect forever —
      // the session would never re-init nor reach FAILED. teardownEngineSafely always resolves
      // (after 10s on a hang), so reconnection proceeds either way.
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await this.teardownEngineSafely(id, oldEngine, e => e.destroy(), 'destroy');
        this.engines.deleteIfLive(id, oldEngine);
      }

      // Credential-teardown fence — BEFORE engineFactory.create (inside initializeEngine). A logout
      // teardown that lost its deadline race is still running and ends in an fs.rm of this session's
      // on-disk profile — the same path initializeEngine is about to populate. Keyed by session NAME
      // (the auth-dir key) and FAIL CLOSED: a timeout becomes a failed reconnect attempt that is
      // rescheduled WITHOUT touching the auth dir (the catch below schedules the next attempt; no
      // engine was created, so there is nothing to evict and no dir to purge).
      await this.awaitPendingTeardown(session.name);

      // Re-initialize
      await this.initializeEngine(id, session);

      // A stop()/delete() may have run while we awaited init — if so, tear down the engine we just
      // registered so it isn't orphaned (the session is meant to be down). delete() clears its
      // teardown mark before this slow init resolves, so re-check the session row exists, not just
      // the mark — otherwise a delete that raced the reconnect leaks a live Chromium/socket.
      // Guard the retirement DB read itself: a transient findOne failure must NOT fall through to the
      // catch below, which would misread the freshly-built, HEALTHY engine as a half-built one and
      // force-kill the session we just recovered. On a read error, assume not-retired and keep it.
      let retired: boolean;
      try {
        retired = await this.isSessionRetired(id);
      } catch {
        retired = false;
      }
      if (retired) {
        const resurrected = this.engines.get(id);
        if (resurrected) {
          await this.teardownEngineSafely(id, resurrected, e => e.destroy(), 'destroy');
          this.engines.deleteIfLive(id, resurrected);
        }
        // Same start/delete window as start()'s post-init guard: this re-init re-created auth dirs
        // delete() had already purged — purge again so no credentials outlive the row.
        await this.purgeAuthDirsIfDeleted(id, session.name);
        return;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // initializeEngine registers the engine in the map BEFORE engine.initialize() runs, so a rejected
      // re-init leaves a half-built engine behind. Evict + reap it: otherwise a reconnect that later
      // exhausts its attempts strands an orphaned Chromium holding a concurrency slot, and the next
      // start() sees the session as "already started".
      const halfBuilt = this.engines.get(id);
      if (halfBuilt) {
        this.evictAndForceDestroy(id, halfBuilt);
      }
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  // Public delegate: SessionStatusBroadcaster.updateStatus (persist + de-duped WS/webhook fan-out).
  // Deliberately NON-async: callers (initializeEngine's pending-initial-status fence above all)
  // must await the broadcaster's own promise object, keeping the exact settlement profile the
  // inline method had — an async wrapper would add adoption hops the retirement-race specs catch.
  updateStatus(id: string, status: SessionStatus): Promise<void> {
    return this.broadcaster.updateStatus(id, status);
  }
}
