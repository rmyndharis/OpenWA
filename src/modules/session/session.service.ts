import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  BadGatewayException,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, DataSource, FindManyOptions } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { decideReconnect, type ReconnectAttemptState } from './reconnect-policy';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { SessionErrorStore } from './session-error-store.service';
import { resolveEngineInitTimeoutMs } from '../../engine/engine-init-timeout';
import { paginate, ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { DEFAULT_MEDIA_MAX_BYTES, STATUS_TTL_MS, StatusStoreService } from '../status-store/status-store.service';
import { buildIncomingStatus } from '../status-store/incoming-status';
import {
  IWhatsAppEngine,
  EngineStatus,
  ChatSummary,
  ChatState,
  GroupEvent,
  IncomingCallEvent,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import {
  incrementSessionReconnectAttempts,
  incrementSessionReconnectLoopAlerts,
} from '../../common/metrics/session-reconnect-metrics';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';

// Message types that carry downloadable media. Any persisted row of these types must have a media
// marker in metadata — never NULL — or the dashboard renders an empty bubble (no placeholder) and the
// by-type stats filter skips the row. Sources that lack the payload (wwjs own-send echo, media-free
// history sync) get the omitted marker synthesized at the persistence chokepoints.

// How many recent status-broadcast messages the connect-time seed pulls (each with its media).
// ponytail: fixed ceiling — the most-recent 50 cover a normal account's 24h of stories; anything
// posted after connect still lands live via onMessage. Make it configurable only if a flood account
// proves 50 too few.
const STATUS_SEED_LIMIT = 50;

interface ReconnectState extends ReconnectAttemptState {
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

// Re-exported so the existing spec import paths keep working after these moved out.
export { clampReconnectDelay } from './reconnect-policy';
export { ACK_RECONCILE_DELAY_MS } from './message-projector.service';
export {
  SESSION_WATCHDOG_INTERVAL_MS,
  SESSION_WATCHDOG_PROBE_TIMEOUT_MS,
  SESSION_WATCHDOG_MAX_FAILURES,
} from './session-liveness-watchdog.service';

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

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = createLogger('SessionService');

  // Live engine instances, owned by the shared EngineRegistry (the narrow port feature modules
  // inject instead of this whole service). This service is the only writer: it creates, replaces and
  // retires engines. `engines` remains a local alias so the lifecycle code below reads unchanged.
  private get engines(): EngineRegistry {
    return this.engineRegistry;
  }

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Last session.status value broadcast per session. Some engines signal one transition via BOTH
  // onStateChanged and a dedicated callback (onQRCode/onDisconnected), so this guards both the WS emit
  // and the webhook POST against firing the same status twice. Cleared on delete().
  private readonly lastDispatchedStatus = new Map<string, SessionStatus>();

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
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly engineRegistry: EngineRegistry,
    private readonly lidResolver: SessionLidResolver,
    private readonly watchdog: SessionLivenessWatchdog,
    private readonly messages: MessageProjector,
    private readonly sessionErrors: SessionErrorStore,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly statusStore: StatusStoreService,
    @Optional()
    private readonly configService?: ConfigService,
    // Draining flag (set on a termination signal or an admin restart). Used to suppress a mid-shutdown
    // reconnect that would launch a fresh Chromium racing onModuleDestroy's teardown. @Optional so the
    // service degrades to today's behaviour if it is ever constructed without the (global) LoggerModule.
    @Optional()
    private readonly shutdownService?: ShutdownService,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
      SessionStatus.ACTION_REQUIRED,
    ];

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    // Start the liveness watchdog FIRST: it must run even when auto-start is disabled (sessions can
    // be started via the API at any time), so it can't sit behind the auto-start early-return below.
    // The watchdog owns the probe cadence and failure counting; a session it proves dead comes
    // back through the same disconnect path an engine-reported drop uses.
    this.watchdog.start((id, engine, reason) => this.handleEngineDisconnected(id, engine, reason));

    if (!resolveFeatureFlags(this.configService).autoStartSessions) return;

    const sessions = await this.sessionRepository.find({
      where: { phone: Not(IsNull()), status: SessionStatus.DISCONNECTED },
    });

    if (sessions.length === 0) return;

    this.logger.log(`Auto-starting ${sessions.length} previously authenticated session(s)`, {
      action: 'auto_start',
      count: sessions.length,
    });

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      try {
        await this.start(session.id);
        this.logger.log(`Auto-started session: ${session.name}`, {
          sessionId: session.id,
          action: 'auto_start_success',
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Auto-start failed for session: ${session.name}`, errorMessage, {
          sessionId: session.id,
          action: 'auto_start_failed',
        });
      }
      // Throttle between sequential Chromium launches; no need to wait after the last one.
      if (i < sessions.length - 1) {
        await this.delay(2000);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Stop the watchdog FIRST (before any teardown below can hang): no new probe/disconnect handling
    // may start mid-shutdown. stop() is idempotent, so a second onModuleDestroy call stays safe.
    this.watchdog.stop();

    // Stop reconnect timers FIRST so nothing reschedules mid-teardown, and so this always runs even
    // if an engine.destroy() below hangs or throws.
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();

    // Destroy engines in parallel, each isolated + time-bounded, so one stuck Chromium can neither
    // stall the shutdown nor abort teardown of the other sessions.
    await Promise.allSettled(
      [...this.engines].map(([sessionId, engine]) => this.destroyEngineSafely(sessionId, engine)),
    );
    this.engines.clear();
  }

  /** Destroy one engine, isolating + time-bounding failures so shutdown can't be stalled or aborted.
   *  Resolves to whether the destroy actually completed (see teardownEngineSafely). */
  private async destroyEngineSafely(sessionId: string, engine: IWhatsAppEngine): Promise<boolean> {
    this.logger.log(`Destroying engine for session ${sessionId}`, { sessionId, action: 'shutdown' });
    return this.teardownEngineSafely(sessionId, engine, e => e.destroy(), 'destroy');
  }

  /**
   * Run an engine teardown (destroy/disconnect), isolating + time-bounding failures so a stuck
   * Chromium/socket can neither hang nor abort the caller. Always resolves — the caller is then free
   * to reconcile the engines Map and proceed with DB cleanup regardless of teardown outcome.
   * Resolves to whether the teardown actually completed: `false` means it threw or hit the 10s
   * deadline, so the underlying Chromium/socket may still be alive (a caller with an operator-facing
   * outcome, like stopOrphanEngines, must surface that instead of reporting a clean stop).
   *
   * A teardown that loses the deadline race keeps running past the caller's return. For 'logout'
   * that leftover promise ends in an fs.rm of the session's on-disk profile — the same path a
   * later start() re-creates — so the raw promise is registered in pendingTeardowns (keyed by the
   * session NAME, which is the auth-dir key) and start()/delete() wait (bounded, fail-closed) for
   * it to settle before touching that path.
   */
  private async teardownEngineSafely(
    sessionId: string,
    engine: IWhatsAppEngine,
    teardown: (e: IWhatsAppEngine) => Promise<void>,
    label: 'destroy' | 'disconnect' | 'force-destroy' | 'logout',
    sessionName?: string,
  ): Promise<boolean> {
    const raw = teardown(engine);
    if (label === 'logout' && sessionName) {
      this.trackPendingCredentialTeardown(sessionName, raw);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        raw,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`engine.${label}() timed out`)), 10_000);
        }),
      ]);
      return true;
    } catch (err) {
      this.logger.error(`Failed to ${label} engine for session ${sessionId}`, String(err), {
        sessionId,
        action: `engine_${label}_failed`,
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Track a destructive credential-teardown promise under the session NAME (the on-disk auth-dir
   * key — NOT the UUID). A logout's `engine.logout()` ends in an `fs.rm` of the same directory a
   * later start() under the same name re-creates, so start()/delete()/executeReconnect consult this
   * map and wait (bounded, fail-closed) before touching that path.
   *
   * Settlement marker only — never rejects, so it can't drive a caller's deadline race to a false
   * "completed". A concurrent teardown for the same name CHAINS onto the previous entry instead of
   * overwriting it (Promise.allSettled), so callers keep waiting until EVERY in-flight teardown for
   * that name has settled — otherwise a second logout's fast settlement would drop the entry while
   * the first teardown's profile rm is still pending. Identity-checked on removal is the ONLY path
   * that evicts the entry, so a newer teardown's entry is never dropped by an older one settling.
   */
  private trackPendingCredentialTeardown(sessionName: string, raw: Promise<void>): void {
    const tracked = raw.catch(() => undefined);
    const previous = this.pendingTeardowns.get(sessionName);
    const entry: Promise<void> = previous ? Promise.allSettled([previous, tracked]).then(() => undefined) : tracked;
    this.pendingTeardowns.set(sessionName, entry);
    void entry.finally(() => {
      if (this.pendingTeardowns.get(sessionName) === entry) {
        this.pendingTeardowns.delete(sessionName);
      }
    });
  }

  /**
   * Wait (bounded) for a teardown that lost its deadline race to settle. A losing logout() promise
   * ends in an fs.rm of the on-disk profile — the same deterministic path start() re-creates and
   * delete() purges — so those paths call this before touching disk. The fence is FAIL CLOSED: a
   * teardown still wedged past the bound could still land its rm on credentials a (re)created session
   * under the same name would write, so the operation refuses with a retryable 409
   * (SESSION_NAME_TEARDOWN_PENDING) instead of proceeding. The entry is NOT dropped on timeout — a
   * retry after the rm eventually settles will see it gone and proceed.
   *
   * Keyed by the session NAME: the auth directories are built from `Session.name`, so two sessions
   * sharing a name (a deleted UUID recreated under the same name) share the credential path and must
   * share the fence.
   */
  private async awaitPendingTeardown(sessionName: string): Promise<void> {
    const pending = this.pendingTeardowns.get(sessionName);
    if (!pending) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      // Fail closed: do NOT proceed. The stale rm could still hit a fresh profile under this name.
      // Message is operator-facing and retryable, with no internal path leak.
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message:
          `A credential teardown for session '${sessionName}' is still in flight. Wait for it to ` +
          'settle and retry.',
        error: 'Conflict',
        code: 'SESSION_NAME_TEARDOWN_PENDING',
      });
    }
  }

  /**
   * Wait for the captured `engine`'s exact in-flight `updateStatus(INITIALIZING)` write to settle.
   * Called by every retiring lifecycle control (stop/logout/delete/forceKill) AFTER the stop mark is
   * set and reconnect cancelled, and BEFORE teardown / the final DISCONNECTED write / parent-row
   * deletion. This keeps the control action the final persisted owner: a delayed INITIALIZING write
   * always settles first, so it can never land after the DISCONNECTED write or the row removal.
   *
   * Identity-checked on the engine object: a control action that captured engine A awaits ONLY A's
   * pending promise, never a replacement B's entry (and never deletes it). A bounded wait mirrors
   * awaitPendingTeardown — the INITIALIZING write is a single DB update, but a wedged DB must not
   * block retirement indefinitely.
   */
  private async awaitInitialStatus(id: string, engine: IWhatsAppEngine): Promise<void> {
    const pending = this.pendingInitialStatuses.get(id);
    if (!pending || pending.engine !== engine) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.promise.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      this.logger.warn(`Proceeding to retire session ${id} while its INITIALIZING status write is still wedged`, {
        sessionId: id,
        action: 'pending_initial_status_wait_exhausted',
      });
    }
  }

  /**
   * Evict a terminally-failed or abandoned engine from the map and SIGKILL its browser process
   * (best-effort, time-bounded via teardownEngineSafely). An engine left in the map keeps holding a
   * concurrency slot and makes a later start() see the session as "already started"; forceDestroy()
   * (not the graceful destroy()) is used because such an engine's browser/CDP connection is typically
   * already broken, so a graceful close would only time out before the process is reaped.
   */
  private evictAndForceDestroy(id: string, engine: IWhatsAppEngine): void {
    this.engines.delete(id);
    void this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    // The findOne pre-check above is a fast path for the common case, but it's a check-then-insert
    // TOCTOU: two concurrent same-name creates both pass it, then one hits the name UNIQUE constraint.
    // Translate that violation to a 409 (matching the pre-check) instead of leaking a raw 500.
    let saved: Session;
    try {
      saved = await this.dataSource.transaction(async manager => {
        return await manager.save(session);
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(`Session with name '${dto.name}' already exists`);
      }
      throw err;
    }
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(allowedSessions?: string[] | null, opts: ListOptions = {}): Promise<Session[]> {
    // A session-restricted key only lists its own sessions; an unrestricted key (null/empty
    // allowlist) lists all — mirroring the ApiKeyGuard allowedSessions model so a scoped key
    // cannot enumerate every session through this aggregate route.
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    const options: FindManyOptions<Session> = { order: { createdAt: 'DESC' }, take: limit, skip: offset };
    if (allowedSessions && allowedSessions.length > 0) {
      options.where = { id: In(allowedSessions) };
    }
    const sessions = await this.sessionRepository.find(options);
    return sessions.map(session => this.attachLastError(session));
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return this.attachLastError(session);
  }

  /** See SessionErrorStore — the reason map and this projection live together. */
  private attachLastError(session: Session): Session {
    return this.sessionErrors.attachTo(session);
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // FENCE #1 — fail-fast on an ALREADY-PENDING credential teardown for this session NAME, BEFORE
    // any lifecycle mutation. A logout teardown that lost its deadline race is still running and ends
    // in an fs.rm of this session's on-disk auth dir (keyed by name). Releasing the name via the DB
    // delete below while that rm is live would let a recreated session under the same name race the
    // stale rm. The fence is keyed by session NAME and fails CLOSED (409). On a 409 NOTHING else runs:
    // no stop mark, no reconnect cancel, no engine teardown, no state cleanup — delete() simply did
    // not happen, and the entry stays reserved.
    await this.awaitPendingTeardown(session.name);

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Set only after the transaction actually removes the parent row. lastDispatchedStatus /
    // sessionErrors (and the recovery budget, Task 8) are cleared ONLY on a committed delete; a
    // rejected 409 from fence #2 leaves them intact (the session still exists).
    let parentDeleted = false;

    try {
      // Stop engine if running — time-bounded + isolated so a stuck Chromium can't wedge the delete;
      // the Map is reconciled and the DB removal proceeds regardless of the outcome. Use forceDestroy()
      // (SIGKILL) rather than a graceful destroy(): the session is being removed permanently, so there is
      // no session state worth saving, and a wedged Chromium must be reaped, not left to time out.
      const engine = this.engines.get(id);
      if (engine) {
        // Await THIS engine's in-flight INITIALIZING write before teardown and the parent-row
        // deletion below, so a delayed pre-initialize status update can never settle after the row
        // is gone (delete cannot be followed by a late status write). Identity-checked.
        await this.awaitInitialStatus(id, engine);
        await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
        this.engines.deleteIfLive(id, engine);
      }

      // FENCE #2 — immediately after the current engine is evicted, BEFORE the session:deleted hook
      // and the DB transaction. A logout that started concurrently AFTER fence #1 but captured this
      // engine before eviction registers its destructive promise synchronously (via the engine's
      // onCredentialTeardownStarted callback), so this fence sees it and refuses — the row/name stay
      // reserved and the transaction does not run. After eviction a NEW logout can't create a
      // destructive promise (no live engine); one that already captured the engine is observed here.
      //
      // Unlike fence #1, a refusal HERE leaves the row behind with its engine already destroyed, so
      // the persisted status would keep reading whatever it was (READY, authenticating, …) for a
      // session that can no longer answer anything. Reconcile it to DISCONNECTED before propagating
      // the 409 — the retry the message asks for should not have to look past a status that lies.
      // Fence #1 needs none of this: nothing has run there yet, so its status is still accurate.
      // Best-effort: a failed status write must not mask the 409 the caller has to act on.
      try {
        await this.awaitPendingTeardown(session.name);
      } catch (fenceError) {
        if (engine) {
          await this.updateStatus(id, SessionStatus.DISCONNECTED).catch(() => undefined);
        }
        throw fenceError;
      }

      // Execute hook BEFORE delete so plugins can access session data
      await this.hookManager.execute(
        'session:deleted',
        {
          id: session.id,
          name: session.name,
          phone: session.phone,
          pushName: session.pushName,
        },
        {
          sessionId: id,
          source: 'SessionService',
        },
      );

      // DB removal is NOT best-effort: a genuine failure must surface (500) rather than be swallowed.
      // Delete every child row explicitly, in one transaction, children before the parent. messages/
      // message_batches carry a plain sessionId with no FK. webhooks/templates/baileys_stored_messages
      // DO declare an ON DELETE CASCADE FK, but the default `data` engine (SQLite) runs with
      // foreign_keys OFF, so that cascade never fires there — a session delete would otherwise orphan
      // them forever (webhooks in particular retain the signing secret + custom headers). Deleting them
      // explicitly is engine-agnostic (redundant-but-harmless on Postgres, where the cascade finds
      // nothing left) and mirrors the restore path's explicit-clear ordering.
      await this.dataSource.transaction(async manager => {
        await manager.delete(Message, { sessionId: id });
        await manager.delete(MessageBatch, { sessionId: id });
        await manager.delete(Webhook, { sessionId: id });
        await manager.delete(Template, { sessionId: id });
        await manager.delete(BaileysStoredMessage, { sessionId: id });
        await manager.remove(session);
      });
      parentDeleted = true;
      this.logger.log(`Session deleted: ${session.name}`, {
        sessionId: id,
        action: 'delete',
      });

      // Purge the persistent on-disk auth/store dirs — BOTH engine shapes (see EngineFactory), since
      // an engine switch may have left a live link for the other engine behind. They're keyed by
      // session NAME and live independently of the (now torn-down, and on delete often never-loaded)
      // engine instance, so the teardown above doesn't touch them. Without this, recreating a session
      // under the same name reloads a stale store. Best-effort inside the factory — never fails an
      // otherwise-successful delete. By this point both fences passed, so no old remover is live
      // against this name (the transaction freed the name; the dirs are safe to purge).
      await this.engineFactory.purgeSessionData(session.name);
    } finally {
      // Always clear the teardown mark so a later recreate/start with this id isn't suppressed. This
      // stop mark was set after fence #1, so clearing it on a rejected 409 only undoes what THIS
      // delete added — it does NOT touch reconnect timer / engine / last status / error / recovery
      // state (those are gated on parentDeleted below).
      this.stoppingSessions.delete(id);
      if (parentDeleted) {
        this.lastDispatchedStatus.delete(id);
        // Drop the FAILED-reason entry too: it's keyed by a now-deleted UUID that can never be read
        // again, so leaving it would grow the map without bound across create/fail/delete churn.
        this.sessionErrors.clear(id);
        // The stuck-auth recovery budget is keyed by id; a committed delete frees it (and a recreated
        // session under the same name gets a fresh UUID + fresh budget). Left only on a committed
        // delete so a failed/409 delete — the session still exists — keeps the budget intact.
        this.stuckAuthRecoveryUsed.delete(id);
      }
      // NOTE: pendingTeardowns is intentionally NOT cleared here. It is keyed by session NAME and
      // its entries self-remove on settlement (identity-checked). A delete that refused at either
      // fence MUST leave the entry in place — the name is still reserved against the live remover —
      // and a delete that succeeded already saw both fences pass, so no live remover exists.
    }
  }

  async start(id: string): Promise<Session> {
    // Reserve the slot SYNCHRONOUSLY at entry — before even the findOne await. Two near-simultaneous
    // start() calls must not both pass the check and orphan an engine (the has() -> engines.set()
    // window spans the awaited hook below), and the infra import pre-flight (getActiveSessionIds)
    // must see an in-flight start during the findOne round-trip too: registered only after findOne,
    // a start would be invisible in that window and a stopOrphans import could DELETE the session
    // row while an engine for it is being created. The finally clears the reservation on success
    // AND failure so a failed start never wedges at "already starting".
    if (this.initializingSessions.has(id)) {
      throw new BadRequestException('Session is already starting');
    }
    this.initializingSessions.add(id);

    try {
      const session = await this.findOne(id);

      if (this.engines.has(id)) {
        throw new BadRequestException('Session is already started');
      }
      const maxConcurrentSessions = resolveMaxConcurrentSessions(this.configService);
      if (maxConcurrentSessions !== null) {
        // Count each OTHER session once. A session mid-initialization is transiently in BOTH
        // `engines` (set at the start of initializeEngine) and `initializingSessions` (until
        // start()'s finally), so summing the two sizes would double-count it; and `id` itself is
        // already reserved in `initializingSessions` (added at entry), so it must not count
        // against the cap it is being checked against.
        const activeIds = new Set<string>(this.engines.activeIds());
        activeIds.delete(id);
        if (activeIds.size >= maxConcurrentSessions) {
          throw new BadRequestException(`Maximum concurrent sessions reached (${maxConcurrentSessions})`);
        }
      }

      // Credential-teardown fence — runs IMMEDIATELY after the read-only findOne + duplicate/cap
      // checks and BEFORE any lifecycle mutation (stop-mark clear, hook, reconnect-state, engine
      // creation, recovery-budget reset) or auth-dir access. A logout teardown that lost its deadline
      // race is still running and ends in an fs.rm of this session's on-disk profile — the same path
      // initializeEngine is about to populate. The fence is keyed by session NAME (the auth-dir key)
      // and FAIL CLOSED: a still-wedged teardown could still rm a fresh profile under this name, so
      // refuse with a retryable 409 instead of proceeding. On a 409, no lifecycle state is touched
      // (the stop mark, reconnect timer, engine, last status/error, and recovery budget are left as
      // they were) — start() simply did not happen. The one transient exception is the
      // initializingSessions reservation added synchronously at start() entry: its finally removes it
      // again, so a refused start does not leave a false "already starting" mark behind (briefly held).
      await this.awaitPendingTeardown(session.name);

      // A fresh start intentionally (re-)creates the engine — clear any stale stop/delete mark.
      this.stoppingSessions.delete(id);

      // Cancel any reconnect timer a prior failed executeReconnect left pending, BEFORE the awaited
      // session:starting hook and engine init — otherwise the stale timer can fire during that I/O
      // and destroy/replace the engine this start() is about to create (or orphan the Chromium
      // process). Idempotent: a no-op when no reconnect state exists (the common fresh-start case).
      this.cancelReconnect(id);

      // Execute hook before starting
      await this.hookManager.execute(
        'session:starting',
        { sessionId: id },
        {
          sessionId: id,
          source: 'SessionService',
        },
      );

      // Initialize reconnect state from the (untrusted) opaque session.config — coerced + clamped
      // so a poisoned value can't drive a NaN/immediate-relaunch storm or an unbounded loop.
      const { maxAttempts, baseDelay } = resolveReconnectConfig(session.config);
      this.reconnectStates.set(id, { attempts: 0, timer: null, maxAttempts, baseDelay });

      // An accepted top-level start() re-arms the stuck-auth recovery budget: every fence above
      // (duplicate-start, cap, credential-teardown) passed, so this is a deliberate, operator-initiated
      // (re)start — not an automatic reconnect. The budget is hoisted to the session so an automatic
      // reconnect can't reset it per generation; only a fresh top-level episode may spend it again.
      // Boot auto-start reaches here through this same method, so it re-arms too.
      this.stuckAuthRecoveryUsed.delete(id);

      try {
        await this.initializeEngine(id, session);
      } catch (err) {
        // engine.initialize() failed AFTER the engine was registered (initializeEngine sets it before
        // initializing). Evict + tear it down so the session doesn't wedge at "already started" with a
        // leaked Chromium/socket permanently holding a concurrency slot. initializingSessions serializes
        // start(), so the engine in the map here is the one this start just created.
        //
        // Use forceDestroy(), not destroy(): initialize() failing usually means the underlying
        // browser/CDP connection is already broken (e.g. a "Target closed" crash mid-injection), so
        // a graceful destroy() has nothing live to talk to — it can only time out via
        // teardownEngineSafely's race, after which the orphaned Chromium process is never actually
        // killed. forceDestroy() SIGKILLs the OS process directly, the same recovery force-kill uses
        // for a wedged engine, which is exactly the state this catch block is handling.
        const orphan = this.engines.get(id);
        if (orphan) {
          this.engines.delete(id);
          this.sessionErrors.set(id, err instanceof Error ? err.message : String(err));
          await this.teardownEngineSafely(id, orphan, e => e.forceDestroy(), 'force-destroy');
          await this.updateStatus(id, SessionStatus.FAILED).catch(() => undefined);
        }
        throw err;
      }

      // A stop()/delete() may have landed while we awaited engine.initialize() — if so, tear down the
      // engine we just registered so the session isn't resurrected to READY (mirrors the post-init
      // guard in executeReconnect; initialize()'s callbacks can also fire async after this returns).
      // delete() clears its teardown mark before this slow init resolves, so re-check the session row
      // exists, not just the mark; the findOne below then surfaces a deleted session as NotFound.
      if (await this.isSessionRetired(id)) {
        const resurrected = this.engines.get(id);
        if (resurrected) {
          await this.teardownEngineSafely(id, resurrected, e => e.destroy(), 'destroy');
          this.engines.deleteIfLive(id, resurrected);
        }
        // A delete() that raced this start purged the on-disk auth dirs BEFORE this init re-created
        // them — purge again so the window leaves no credential residue behind (no-op for a stop()).
        await this.purgeAuthDirsIfDeleted(id, session.name);
      }
      return this.findOne(id);
    } finally {
      this.initializingSessions.delete(id);
    }
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

  /**
   * Backfill currently-active statuses from the engine on connect, so the store has today's stories
   * even for ones posted before this session came online (live posts land via onMessage). Best-effort:
   * Baileys doesn't support this (throws EngineNotSupportedError) and any other engine error must not
   * take down the ready path, so every failure is swallowed here. Ingest is idempotent on
   * `(sessionId, waStatusId)`, so this can never double-count a status onMessage already ingested.
   */
  private async seedStatuses(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    try {
      // Read the status-broadcast chat's own recent messages rather than getContactStatuses(): on
      // whatsapp-web.js the latter reads the StatusV3 collection, which loads asynchronously and is
      // near-empty right after ready, so a status posted before connect would silently never reach the
      // store. Fetching the chat's messages (the same on-demand fetch the chat-history endpoint uses)
      // reliably returns the currently-active statuses with downloadable media/video, and each maps
      // through the very buildIncomingStatus the live onMessage path uses — so a seeded status is
      // indistinguishable from one that arrives live. No status.received webhook is dispatched here:
      // this is a backfill of posts that predate the connection, not a live arrival.
      // Pre-gate media downloads at the store's own cap: a larger blob would be discarded as
      // over_cap on ingest anyway, so downloading it is pure waste (heap + bandwidth).
      const mediaMaxBytes =
        this.configService?.get<number>('status.mediaMaxBytes', DEFAULT_MEDIA_MAX_BYTES) ?? DEFAULT_MEDIA_MAX_BYTES;
      const messages = await engine.getChatHistory('status@broadcast', STATUS_SEED_LIMIT, true, mediaMaxBytes);
      // getChatHistory maps a message's contact from the sync cache only, so status posters (usually
      // @lid ids) come back nameless. Resolve each unique poster once via getContactById — the same
      // lookup the contacts API uses, which maps the @lid to the real contact — so a seeded status
      // carries the poster's name like a live one does. Cached per JID: one lookup per contact, not
      // one per status.
      const contactNames = new Map<string, { name?: string; pushName?: string }>();
      const resolvePoster = async (jid: string): Promise<{ name?: string; pushName?: string }> => {
        const cached = contactNames.get(jid);
        if (cached) return cached;
        let resolved: { name?: string; pushName?: string } = {};
        try {
          const contact = await engine.getContactById(jid);
          if (contact) resolved = { name: contact.name, pushName: contact.pushName };
        } catch {
          // Best-effort: a failed lookup just leaves the status nameless.
        }
        contactNames.set(jid, resolved);
        return resolved;
      };
      for (const msg of messages) {
        try {
          // Mirrors the live path's own-send drop: the broadcast chat's history also contains the
          // account's OWN active statuses, which must not come back as if a contact had posted them.
          if (msg.fromMe) continue;
          // A status whose 24h already ran out is hidden by WhatsApp and would only live until the
          // next purge sweep — don't backfill it (its media was downloaded by getChatHistory
          // regardless; this just skips the row).
          if (msg.timestamp * 1000 + STATUS_TTL_MS <= Date.now()) continue;
          const status = buildIncomingStatus(msg);
          if (!status) continue;
          if (!status.contactName && !status.contactPushName) {
            const poster = await resolvePoster(status.contactJid);
            status.contactName = poster.name;
            status.contactPushName = poster.pushName;
          }
          await this.statusStore.ingest(sessionId, status);
        } catch (itemErr) {
          // One bad item must not abort the whole backfill.
          this.logger.warn('Status seed item skipped', {
            sessionId,
            error: itemErr instanceof Error ? itemErr.message : String(itemErr),
          });
        }
      }
    } catch (err) {
      this.logger.debug('Status seed skipped', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    // Clear any prior failure reason before a fresh start.
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

    const initPromise = engine.initialize({
      onQRCode: (qr: string): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.log('QR code generated', {
          sessionId: id,
          action: 'qr_generated',
        });

        void this.webhookService.dispatch(id, 'session.qr', { sessionId: id, qr });

        // Push the QR to subscribed dashboard clients over the WebSocket (the `session.qr` event is
        // advertised + consumed there, so clients can render it live instead of polling GET /qr).
        this.eventsGateway.emitQRCode(id, qr);

        // Execute hook for QR event
        void this.hookManager.execute(
          'session:qr',
          { sessionId: id },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.QR_READY);
      },
      onReady: (phone, pushName): void => this.handleEngineReady(id, engine, phone, pushName),
      onMessage: (message): void => this.messages.handleInboundMessage(id, engine, message),
      onHistoryMessages: (messages): void => {
        if (!this.isLiveEngine(id, engine)) return;
        // Persist for the chat view only; no dispatch (these predate the live session).
        void this.messages
          .persistHistoryMessages(id, messages)
          .catch(err => this.logger.error(`Failed to persist history messages for ${id}`, String(err)));
      },
      onMessageCreate: (message): void => this.messages.handleOwnSendEcho(id, engine, message),
      onMessageAck: (messageId, status): void => this.messages.handleMessageAck(id, engine, messageId, status),
      onMessageRevoked: (message): void => this.messages.handleMessageRevoked(id, engine, message),
      onMessageReaction: (event): void => {
        if (!this.isLiveEngine(id, engine)) return;
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

        this.messages.applyReactionQueued(id, event);
      },
      onMessageEdited: (message): void => {
        if (!this.isLiveEngine(id, engine)) return;
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

        this.messages.applyMessageEditQueued(id, message);
      },
      onGroupEvent: (event): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.debug(`Group event: ${event.kind} in ${event.groupId}`, {
          sessionId: id,
          groupId: event.groupId,
          kind: event.kind,
          action: 'group_event',
        });
        this.dispatchGroupEvent(id, event);
      },
      onCall: (event: IncomingCallEvent): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.log(`Incoming call from ${event.from}`, {
          sessionId: id,
          callId: event.callId,
          isVideo: event.isVideo,
          isGroup: event.isGroup,
          action: 'call_received',
        });
        const payload: Record<string, unknown> = { ...event };
        this.eventsGateway.emitCallReceived(id, payload);
        void this.webhookService.dispatch(id, 'call.received', payload);
        // Opt-in auto-reject runs AFTER the dispatch so a reject failure can never eat the event.
        void this.maybeAutoRejectCall(id, engine, event.callId);
      },
      onDisconnected: (reason: string): void => {
        if (!this.isLiveEngine(id, engine)) return;
        // Shared with the liveness watchdog (see handleEngineDisconnected). Pass the captured
        // engine so the handler can re-check identity across its DB await — this closure's `engine`
        // (and `session`) snapshots can be stale by the time a disconnect lands, so the handler
        // re-reads the row itself and fences every side effect on `engine` still being the live
        // owner. The captured engine is the exact generation token (no numeric counter).
        void this.handleEngineDisconnected(id, engine, reason);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        if (!this.isLiveEngine(id, engine)) return;
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
          void this.updateStatus(id, newStatus);
        }
      },
      onActionRequired: (reason: string): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.warn(`Session requires operator action: ${reason}`, {
          sessionId: id,
          reason,
          action: 'action_required',
        });
        // Record the reason so attachLastError surfaces it while the session is ACTION_REQUIRED,
        // then updateStatus (via onStateChanged above) has already written the status. Set here too
        // to be defensive: the callback order is onStateChanged then onActionRequired, but persisting
        // the reason here means it is available regardless.
        this.sessionErrors.set(id, reason);
        void this.hookManager.execute('session:error', { reason }, { sessionId: id, source: 'Engine' });
      },
      onError: (reason: string): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.error(`Session engine failed: ${reason}`, undefined, {
          sessionId: id,
          reason,
          action: 'engine_error',
        });

        // Remember the reason so findOne/findAll can surface it to the dashboard,
        // then persist the FAILED status. This is terminal — no reconnect is
        // scheduled (unlike onDisconnected), since re-scanning is required.
        this.sessionErrors.set(id, reason);

        // A prior onDisconnected may have scheduled a reconnect. This failure is terminal
        // (re-scan required), so cancel it — otherwise the pending timer would resurrect a
        // session the operator must manually restart.
        this.cancelReconnect(id);

        void this.hookManager.execute(
          'session:error',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.FAILED);

        // onError is terminal (no reconnect is scheduled — re-scan is required). Evict the dead engine
        // and SIGKILL its process: leaving it in the map would hold a concurrency slot indefinitely and
        // make the next start() reject the session as "already started" instead of re-initializing it.
        this.evictAndForceDestroy(id, engine);
      },
      onCredentialTeardownStarted: (operation: Promise<void>): void => {
        // The adapter fired the moment it began the call that ends in an fs.rm of this session's
        // on-disk auth dir. Track it under the captured session NAME (the auth-dir key) — NOT the
        // UUID, and NOT guarded on this engine still being live: a logout that captured this engine
        // must register its destructive promise even as a concurrent stop()/delete() evicts it,
        // because the rm targets the session name's dir and would otherwise race a (re)created
        // session under that same name. `session.name` is the immutable snapshot captured at
        // initializeEngine entry, so a row delete/recreate under the same name cannot poison the key.
        this.trackPendingCredentialTeardown(session.name, operation);
      },
      claimStuckAuthRecovery: (): boolean => {
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
    });

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

  /**
   * Apply one reaction event to the stored message's reactions map (read-modify-write of the JSON
   * column). Invoked through the per-message serialization chain in onMessageReaction, so concurrent
   * reactions on the same message run sequentially and don't clobber each other.
   */
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
    void this.seedStatuses(id, engine);
  }

  /**
   * Fan a neutral engine GroupEvent out to consumers: the WebSocket room and the webhook stream.
   * The `kind` selects the event name (`group.join` / `group.leave` / `group.update`); the payload
   * is the same plain camelCase shape on both channels, with `kind` itself carried by the name.
   * There is no persistence here — group membership/metadata lives in the engine, not the message
   * store — so unlike message edits there is nothing to apply before notifying.
   */
  private dispatchGroupEvent(id: string, event: GroupEvent): void {
    const payload: Record<string, unknown> = {
      groupId: event.groupId,
      participantIds: event.participantIds,
      timestamp: event.timestamp,
    };
    // Optional fields are added only when present so consumers never see explicit `undefined`s.
    if (event.actorId !== undefined) {
      payload.actorId = event.actorId;
    }
    if (event.changes !== undefined) {
      payload.changes = event.changes;
    }

    switch (event.kind) {
      case 'join':
        this.eventsGateway.emitGroupJoin(id, payload);
        void this.webhookService.dispatch(id, 'group.join', payload);
        break;
      case 'leave':
        this.eventsGateway.emitGroupLeave(id, payload);
        void this.webhookService.dispatch(id, 'group.leave', payload);
        break;
      case 'update':
        this.eventsGateway.emitGroupUpdate(id, payload);
        void this.webhookService.dispatch(id, 'group.update', payload);
        break;
    }
  }

  /**
   * Reject a ringing call when the session opted in via `config.autoRejectCalls`. The session row
   * is re-read here rather than trusting initializeEngine's closure snapshot — a call can arrive
   * long after start, and the row is the only always-current source (mirrors
   * handleEngineDisconnected). `config` is an untyped JSON column: only a strict boolean `true`
   * opts in — truthy strings/numbers are ignored (the coercion discipline of
   * resolveReconnectConfig). Never throws: a reject failure is logged, and the `call.received`
   * dispatch already happened before this ran.
   */
  private async maybeAutoRejectCall(id: string, engine: IWhatsAppEngine, callId: string): Promise<void> {
    let session: Session | null;
    try {
      session = await this.sessionRepository.findOne({ where: { id } });
    } catch (err) {
      this.logger.error('Failed to reload the session for call auto-reject', String(err), {
        sessionId: id,
        action: 'call_auto_reject_error',
      });
      return;
    }
    if (session?.config?.autoRejectCalls !== true) {
      return;
    }
    try {
      await engine.rejectCall(callId);
      this.logger.log('Auto-rejected incoming call', {
        sessionId: id,
        callId,
        action: 'call_auto_rejected',
      });
    } catch (err) {
      this.logger.warn('Failed to auto-reject incoming call', {
        sessionId: id,
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  private async handleEngineDisconnected(id: string, engine: IWhatsAppEngine, reason: string): Promise<void> {
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
    // otherwise schedule a reconnect that races onModuleDestroy's teardown and could orphan a browser.
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

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Disconnect the engine — time-bounded + isolated so a stuck socket can't wedge the stop; the
    // Map is reconciled regardless. (The stop mark is intentionally left set, matching the prior
    // behaviour: a later start() clears it; it guards against a late reconnect resurrecting the id.)
    const engine = this.engines.get(id);
    if (engine) {
      // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
      // write so a delayed pre-initialize status update can never settle after the retirement and
      // become the last persisted status. Identity-checked: only the captured engine's promise.
      await this.awaitInitialStatus(id, engine);
      await this.teardownEngineSafely(id, engine, e => e.disconnect(), 'disconnect');
      this.engines.deleteIfLive(id, engine);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  /**
   * Log out of WhatsApp — attempts an engine-native unlink of this device, then tears the session
   * down locally regardless of the unlink outcome.
   *
   * Differs from stop() in the one way that matters to a user: logout() asks WhatsApp to remove the
   * companion device, so a completed unlink eventually makes the entry disappear from the account
   * holder's Linked Devices list. stop() and delete() only release things locally (delete also
   * purges the on-disk auth dirs).
   *
   * Completion (HTTP 200) means the engine-native unlink operation completed AND the required local
   * credential cleanup completed — for Baileys, a valid companion identity, an acknowledged
   * `remove-companion-device` IQ response, and removal of the on-disk auth dir; for whatsapp-web.js,
   * `Client.logout()` including `LocalAuth.logout()` settled. 200 is NOT an independent observation
   * that the handset UI no longer shows the linked device — only the linked-device canary observes
   * that, and the dashboard must not claim otherwise.
   *
   * Must run while the engine is still live — logout is a network round-trip to WhatsApp, so it
   * cannot be performed after destroy()/forceDestroy(). Mirrors stop()'s lifecycle otherwise
   * (stop-mark + cancel-reconnect + bounded, isolated teardown + Map reconciliation).
   *
   * Requires a started session: with no engine loaded there is nothing to send the unlink through,
   * so the request is rejected with 400 rather than reporting an unlink that never happened. A 400
   * does NOT change the row. To just release a stopped session locally, use stop()/delete().
   *
   * Throws a retryable BadGatewayException (502) carrying a stable `code: 'SESSION_LOGOUT_INCOMPLETE'`
   * when an accepted engine-backed attempt stopped locally but the unlink operation did NOT complete
   * — no identity/no send, no IQ acknowledgement, timeout/transport error, OR local credential
   * cleanup failure. After EVERY engine-backed attempt (200 OR 502) the session is torn down locally
   * (map reconciled, status DISCONNECTED) and `phone` is cleared so the boot auto-start does not
   * resurrect the session into an uncertain/invalid credential state. No success audit is written on
   * the 502 path (the controller audits SESSION_LOGGED_OUT only after the service resolves). The
   * operator can start the session and retry the logout.
   */
  async logout(id: string): Promise<Session> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
    // write so a delayed pre-initialize status update can never settle after the retirement.
    await this.awaitInitialStatus(id, engine);
    // The credential fence is keyed by session NAME (the auth-dir key). Captured immutably here so a
    // raw logout that outlives its deadline race is tracked under the right name even if the row is
    // later deleted/recreated.
    const unlinked = await this.teardownEngineSafely(id, engine, e => e.logout(), 'logout', session.name);
    this.engines.deleteIfLive(id, engine);
    await this.updateStatus(id, SessionStatus.DISCONNECTED);

    if (!unlinked) {
      this.logger.warn(`Session stopped locally but the logout operation did not complete: ${session.name}`, {
        sessionId: id,
        action: 'logout_incomplete',
      });
      // The local teardown already ran (map reconciled, status DISCONNECTED), but the unlink operation
      // did not complete. Clear `phone` AFTER the attempt and BEFORE throwing so the boot auto-start
      // does not resurrect the session into a credential state that can no longer reach READY — the
      // local credentials were torn down, so re-entering auto-start would only wedge it. The retryable
      // 502 carries a stable machine code so the dashboard can branch on origin without guessing from
      // the status/message; no success audit is written on this path.
      await this.sessionRepository.update(id, { phone: null });
      throw new BadGatewayException({
        statusCode: HttpStatus.BAD_GATEWAY,
        message:
          'Session was stopped locally, but the logout operation is incomplete — the device may ' +
          'still be linked. Start the session and retry the logout.',
        error: 'Bad Gateway',
        code: 'SESSION_LOGOUT_INCOMPLETE',
      });
    }

    // A completed engine-backed unlink wipes the stored credentials, so this session can never
    // reach READY again without a fresh QR/pairing. Clear `phone` to take it out of the boot
    // auto-start query (phone IS NOT NULL) instead of resurrecting it into a QR it can never pass
    // on every restart. onReady rewrites it on the next successful link.
    await this.sessionRepository.update(id, { phone: null });

    this.logger.log(`Session logged out: ${session.name}`, {
      sessionId: id,
      action: 'logout',
    });
    return this.findOne(id);
  }

  /**
   * Force-recover a stuck session: SIGKILL its engine's own resources (a wedged Chromium for the
   * whatsapp-web.js engine) and tear it down, even when a normal stop()/delete() can't because the
   * engine is hung. Mirrors stop()'s lifecycle (stop-mark + cancel-reconnect + bounded, isolated
   * teardown + Map reconciliation) but uses the engine's forceDestroy().
   */
  async forceKill(id: string): Promise<Session> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    // No live engine means there is nothing to SIGKILL. Resolving would let the controller write a
    // SESSION_FORCE_KILLED audit row for a kill that never happened — mirror logout()'s not-started
    // refusal. A wedged engine torn down earlier is reaped by the next start()'s orphan sweep (and
    // by process exit), not by force-kill.
    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    this.cancelReconnect(id);

    // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
    // write so a delayed pre-initialize status update can never settle after the retirement.
    await this.awaitInitialStatus(id, engine);
    await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
    this.engines.deleteIfLive(id, engine);

    this.logger.warn(`Session force-killed: ${session.name}`, {
      sessionId: id,
      action: 'force_kill',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  /**
   * Request an 8-char pairing code (link via phone number) as an alternative to scanning the QR.
   * The session must be started but not yet authenticated.
   */
  async requestPairingCode(id: string, phoneNumber: string): Promise<{ pairingCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }
    if (session.status === SessionStatus.READY) {
      throw new BadRequestException('Session is already authenticated, no pairing needed');
    }

    const pairingCode = await engine.requestPairingCode(phoneNumber);
    return { pairingCode, status: session.status };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(
    id: string,
    opts: ListOptions = {},
  ): Promise<{ id: string; name: string; linkedParentJID?: string | null }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    const mapped = groups.map(g => ({
      id: g.id,
      name: g.name,
      linkedParentJID: g.linkedParentJID,
    }));
    return paginate(mapped, opts.limit, opts.offset);
  }

  async getChats(id: string, opts: ListOptions = {}): Promise<ChatSummary[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    // Most-recent first, then bound the response window. Sorting before the cap means a capped
    // response is the N newest chats (what clients show first) rather than an arbitrary slice.
    const chats = [...(await engine.getChats())].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return paginate(chats, opts.limit, opts.offset);
  }

  async sendSeen(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.sendSeen(chatId);
  }

  async markUnread(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.markUnread(chatId);
  }

  async deleteChat(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.deleteChat(chatId);
  }

  async sendChatState(id: string, chatId: string, state: ChatState): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    await engine.sendChatState(chatId, state);
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
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

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(allowedSessions?: string[] | null): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    // Scope to the caller's allowedSessions so a session-restricted key cannot enumerate the count /
    // status distribution of sessions it has no rights to (matches the scoped GET /sessions route).
    const scope = allowedSessions && allowedSessions.length > 0 ? allowedSessions : null;
    // Aggregate status counts in the database instead of loading every row. findAll() is bounded by
    // DEFAULT_LIST_LIMIT for the HTTP routes, so reusing it here would silently undercount `total` and
    // `byStatus` on deployments with more sessions than that cap. A grouped COUNT is correct at any
    // scale and cheaper (no entity hydration).
    const qb = this.sessionRepository
      .createQueryBuilder('session')
      .select('session.status', 'status')
      .addSelect('COUNT(session.id)', 'count');
    if (scope) {
      qb.where('session.id IN (:...scope)', { scope });
    }
    const rows = await qb.groupBy('session.status').getRawMany<{ status: string; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count) || 0;
      byStatus[row.status] = count;
      total += count;
    }

    const memory = process.memoryUsage();

    return {
      total,
      // engines is keyed by session id; a scoped key sees only its own running engines, not the global count.
      active: scope ? [...this.engines.keys()].filter(id => scope.includes(id)).length : this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }

  /**
   * Ids of every session with a live engine — including ones mid-initialization (their engine is not
   * in `engines` yet but will register when start() completes). The infra import pre-flight uses this
   * to refuse a full-replace restore that would orphan a running engine.
   */
  getActiveSessionIds(): string[] {
    return this.engines.activeIds();
  }

  /**
   * Stop the engines for the given session ids WITHOUT touching the sessions DB row (the caller,
   * the infra import path, is about to DELETE that row as part of a full replace). This is the one
   * stop path that bypasses findOne()/stop()/delete() — every other path keys through the row, so an
   * engine orphaned by a restore was previously unstoppable until process restart.
   *
   * Each id is handled in isolation and time-bounded: a stuck Chromium/socket on one orphan can
   * neither stall nor abort the others, and the whole call is bounded by teardownEngineSafely's
   * per-engine 10s deadline. The mark + reconnect-cancel happen first so an in-flight reconnect
   * cannot resurrect the id while teardown runs. Engines that are mid-initialization (no entry in
   * `engines` yet) are marked but cannot be torn down here — their start() will see the stop mark
   * via its existing guard and self-abort; the caller learns about them in `notRunning`.
   *
   * Always resolves. Best-effort: a `failed` entry means teardown threw or timed out, and the engine
   * is removed from the Map regardless so it stops holding a concurrency slot.
   */
  async stopOrphanEngines(
    sessionIds: string[],
  ): Promise<{ stopped: string[]; notRunning: string[]; failed: string[] }> {
    const stopped: string[] = [];
    const notRunning: string[] = [];
    const failed: string[] = [];

    if (sessionIds.length === 0) return { stopped, notRunning, failed };

    await Promise.allSettled(
      sessionIds.map(async id => {
        // Mark + cancel BEFORE teardown so a late reconnect cannot resurrect the id mid-teardown.
        this.stoppingSessions.add(id);
        this.cancelReconnect(id);

        const engine = this.engines.get(id);
        if (!engine) {
          // Either never started, or still inside initializeEngine (no Map entry yet). The stop mark
          // above is what aborts the initializing case via start()'s existing guard.
          notRunning.push(id);
          return;
        }
        try {
          const tornDown = await this.destroyEngineSafely(id, engine);
          // The engine leaves the Map regardless of teardown outcome so it stops holding a
          // concurrency slot — but only a completed teardown counts as `stopped`. A throw/timeout
          // means the Chromium/socket may still be alive and writing, so the id lands in `failed`
          // and the caller (the infra import) can flag restartRequired instead of reporting a
          // clean stop for a wedged engine.
          this.engines.deleteIfLive(id, engine);
          if (tornDown) {
            stopped.push(id);
          } else {
            failed.push(id);
          }
        } catch (err) {
          // destroyEngineSafely never throws today (it isolates via teardownEngineSafely), but defend
          // against a future change so a single orphan cannot abort the batch.
          this.logger.error(`Failed to stop orphan engine for session ${id}`, String(err), {
            sessionId: id,
            action: 'stop_orphan_failed',
          });
          this.engines.deleteIfLive(id, engine);
          failed.push(id);
        }
      }),
    );

    return { stopped, notRunning, failed };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
