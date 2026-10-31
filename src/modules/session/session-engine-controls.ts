import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityTarget, EntityManager, In, IsNull, Raw, Repository, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { failUnfinishedSessionBatches } from '../message/batch-media.util';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { closeSessionWrites } from '../../common/utils/session-write-scope';
import { awaitNoOpenTransaction } from '../../common/utils/shared-connection';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { type createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks';
import { SessionLifecycleFences } from './session-lifecycle-fences';
import { SessionStatusBroadcaster } from './session-status-broadcaster';
// The two pure config resolvers stay exported from the lifecycle module (its export surface is
// unchanged — session.service re-exports them from there), so this unit imports them back. The
// resulting import cycle is deferred-usage only — the bindings are read inside method bodies,
// never at module-eval time — which the CommonJS loader resolves safely.
import {
  resolveMaxConcurrentSessions,
  resolveReconnectConfig,
  startSlotHolders,
  type ReconnectState,
} from './session-engine-lifecycle.service';

/**
 * Rows of the tables that grow with traffic (messages, webhook outbox events, webhook delivery failures)
 * removed per statement when a session is deleted. On SQLite this is the most a batch may take: far below the
 * bind-parameter limit, and the loop sizes each batch to the time the last one took (see
 * SESSION_DELETE_BATCH_TARGET_MS_SQLITE), because one writer serves every session and each message row also
 * fires the full-text index trigger. A larger batch costs a little less per row but stalls longer: a
 * 300k-message session deletes 1.2 to 1.7 times faster at 2000 rows than at 500 (it depends on the load of the
 * host), with a longer worst statement. Most of the gain over the first batched delete comes from leaving the
 * session out of the delete's condition, see deleteTrafficRowsInBatches.
 */
export const SESSION_DELETE_BATCH_SIZE_SQLITE = 2000;

/**
 * How long a SQLite batch should take. The driver runs a statement on the event loop, so this is the longest
 * the process is held for one batch. The cost per row rises with the size of the database (about 75 microseconds
 * per row at 300k messages, 170 at 1.2M), which a fixed row count turned into a stall that grew with the history.
 * A batch costs less per row the larger it is, so a shorter target bounds the stall more tightly and lengthens
 * the whole delete: at 150 ms it takes about 1.4 times as long as at 2000 rows a batch, at 250 ms 1.0 to 1.2 times.
 */
export const SESSION_DELETE_BATCH_TARGET_MS_SQLITE = 150;

/** The first SQLite batch and the least one may shrink to, so a slow database is never started on a large batch. */
export const SESSION_DELETE_BATCH_MIN_SQLITE = 250;

/**
 * The pause after a SQLite batch. Yielding for one turn of the event loop lets a request take one step, but a
 * request takes several turns and each was followed by the next batch, so it waited out several batches. A
 * short pause lets it finish before the next one starts.
 */
export const SESSION_DELETE_PAUSE_MS_SQLITE = 5;

/**
 * The same on PostgreSQL, where a statement does not hold the process and a larger batch buys little (a million
 * small rows on an analyzed table delete in about the same few seconds at 500 or 2000 rows). What bounds a
 * statement there is its time under the statement timeout, and that follows the bytes of the rows it deletes: a
 * message that keeps its media inline stores megabytes per row. So it keeps the smaller batch and its headroom.
 */
export const SESSION_DELETE_BATCH_SIZE_POSTGRES = 500;

/**
 * How many batches of a webhook outbox or delivery failure pass one read feeds on PostgreSQL. These two tables
 * have no index that orders a session's rows, so each read goes back over the session's whole index range,
 * including the entries of rows already deleted that a vacuum has not yet removed; a read after every batch made
 * the delete take longer than linear, by seconds at 300,000 rows and far more beyond.
 */
export const SESSION_DELETE_READ_AHEAD_POSTGRES = 20;

/**
 * The size of the next SQLite batch: the last one scaled to the target time, growing by at most a factor of two
 * so a fast first batch cannot overshoot into a slow one, and kept between the floor and the ceiling.
 */
export function nextSqliteDeleteBatchSize(rows: number, tookMs: number): number {
  const scaled = Math.round((rows * SESSION_DELETE_BATCH_TARGET_MS_SQLITE) / Math.max(tookMs, 1));
  return Math.max(SESSION_DELETE_BATCH_MIN_SQLITE, Math.min(SESSION_DELETE_BATCH_SIZE_SQLITE, rows * 2, scaled));
}

/** One table's pass of the batched delete: the repository to delete from and the reader of the next page of ids. */
type TrafficPass = { rows: Repository<{ id: string }>; next: (take: number) => Promise<string[]> };

/** A start refused because an operator stopped the session. Same 409 on the wire as any conflict. */
export class SessionStoppedException extends ConflictException {}

/** A start refused because the gateway is shutting down. Retryable once it is back. */
export class ServerShuttingDownException extends ServiceUnavailableException {
  constructor() {
    super('Server is shutting down');
  }
}

/**
 * The stop marks. Each add() stamps the id afresh, even one already marked, so start() can tell a mark
 * set while it waited from one that was already there when it began.
 */
export class StopMarks extends Set<string> {
  private seq = 0;
  private readonly stamps = new Map<string, number>();

  override add(id: string): this {
    this.stamps.set(id, ++this.seq);
    return super.add(id);
  }

  override delete(id: string): boolean {
    this.stamps.delete(id);
    return super.delete(id);
  }

  /** The stamp of the id's current mark, undefined when it has none. */
  stamp(id: string): number | undefined {
    return this.stamps.get(id);
  }
}

/** Caller callbacks for stop(), delete(), forceKill() and logout(), run around the session read that opens each verb. */
export interface StopHooks {
  /** delete() only: the ownership captured by its caller still covers this operation. */
  ownsClaim?: () => boolean;
  /** stop() only: runs once the session read succeeds and before any teardown; records the stop. */
  afterRead?: () => Promise<void>;
  /**
   * Runs when the first session read fails (for stop() and delete(), after the stop mark is dropped):
   * withdraws the caller's stop request.
   */
  onReadFailed?: () => void;
  /** forceKill()/logout(): runs synchronously once there is an engine to retire. */
  onEngineFound?: () => void;
  /** forceKill() only: persist the stop with the caller's current ownership predicate. */
  recordStop?: () => Promise<void>;
  /** delete() only: runs once the delete starts removing the session's data, the session:deleted hook first. */
  onRemoving?: () => void;
}

/**
 * The deps + core call-ins SessionEngineControls needs from the lifecycle. Built ONCE in the
 * lifecycle's constructor. The dependency VALUES (sessionRepository … broadcaster) are captured at
 * construction — the same reads the pre-extraction code made of the lifecycle's readonly
 * constructor fields — while the shared state containers (stoppingSessions, reconnectStates,
 * stuckAuthRecoveryUsed, initializingSessions) are handed over BY REFERENCE, so this unit, the
 * lifecycle core, and every spec poking them through the lifecycle always observe the same
 * instances. The core call-ins (cancelReconnect … updateStatus) are deliberately NON-async
 * passthrough closures onto the lifecycle's live methods (the Task-1 delegate rule: an `async`
 * wrapper would adopt the inner promise and add settlement hops the retirement-race specs assert
 * against). `dataSource` is a LIVE closure — never a captured value — because specs replace the
 * lifecycle's dataSource on the instance after construction (logout-teardown-race.spec) and
 * delete()'s transaction must observe the current one at call time.
 */
export interface SessionEngineControlsHost {
  sessionRepository: Repository<Session>;
  engineFactory: EngineFactory;
  engines: EngineRegistry;
  sessionErrors: SessionErrorStore;
  sessionRestrictions: SessionRestrictionStore;
  presence: PresenceStore;
  hookManager: HookManager;
  configService?: ConfigService;
  nodeId?: string;
  logger: ReturnType<typeof createLogger>;
  /** LIVE closure — read at call time, never captured (specs replace lifecycle.dataSource at runtime). */
  dataSource(): DataSource;
  fences: SessionLifecycleFences;
  broadcaster: SessionStatusBroadcaster;
  cancelReconnect(id: string): void;
  initializeEngine(id: string, session: Session): Promise<void>;
  isSessionRetired(id: string): Promise<boolean>;
  prepareStart(id: string, desiredState: Session['desiredState']): Promise<boolean>;
  purgeAuthDirsIfDeleted(id: string): Promise<void>;
  updateStatus(id: string, status: SessionStatus): Promise<void>;
  /** Ownership gate, same contract as SessionEngineWiringHost.ownsSession. */
  ownsSession(id: string): boolean;
  /** True once shutdown() has begun; the lifecycle never reopens. */
  isClosed(): boolean;
  stoppingSessions: StopMarks;
  /** The engine each teardown that writes its own status is retiring; see the lifecycle field of the same name. */
  operatorTeardowns: Map<string, IWhatsAppEngine>;
  reconnectStates: Map<string, ReconnectState>;
  stuckAuthRecoveryUsed: Set<string>;
  initializingSessions: Set<string>;
}

/**
 * The 7 public control verbs extracted from SessionEngineLifecycle: start/stop/logout/forceKill/
 * delete/shutdown/stopOrphanEngines, plus the private findOne-or-404 requireSession. Plain class
 * (NOT a NestJS provider — the lifecycle's constructor signature is frozen by specs), built inside
 * the lifecycle's constructor; the lifecycle keeps all 7 verbs as one-line NON-async delegates, so
 * SessionService's public API path and every spec calling the verbs on the lifecycle stay
 * byte-identical. The dependency values and shared state containers are assigned to same-named
 * fields (by reference), so the method bodies below read like the inline originals; every former
 * core call-in (`this.cancelReconnect`, `this.initializeEngine`, `this.isSessionRetired`,
 * `this.purgeAuthDirsIfDeleted`, `this.updateStatus`) goes through `host`, the fences through the
 * `fences` unit, and delete()'s transaction reads `this.host.dataSource()` — the LIVE closure — at
 * call time. Method bodies and their comments/docstrings moved verbatim.
 */
export class SessionEngineControls {
  private readonly sessionRepository: Repository<Session>;
  private readonly engineFactory: EngineFactory;
  private readonly engines: EngineRegistry;
  private readonly sessionErrors: SessionErrorStore;
  private readonly sessionRestrictions: SessionRestrictionStore;
  private readonly presence: PresenceStore;
  private readonly hookManager: HookManager;
  private readonly configService?: ConfigService;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly fences: SessionLifecycleFences;
  private readonly broadcaster: SessionStatusBroadcaster;
  private readonly stoppingSessions: StopMarks;
  private readonly operatorTeardowns: Map<string, IWhatsAppEngine>;
  private readonly reconnectStates: Map<string, ReconnectState>;
  private readonly stuckAuthRecoveryUsed: Set<string>;
  private readonly initializingSessions: Set<string>;
  /**
   * Deletes in flight per id, counted so that two overlapping deletes of one id do not end each other's hold.
   * The stop mark of a delete cannot refuse a start for as long as the delete runs: start() takes a mark that
   * was already set when it began for a stale one and clears it.
   */
  private readonly deleting = new Map<string, number>();

  constructor(private readonly host: SessionEngineControlsHost) {
    this.sessionRepository = host.sessionRepository;
    this.engineFactory = host.engineFactory;
    this.engines = host.engines;
    this.sessionErrors = host.sessionErrors;
    this.sessionRestrictions = host.sessionRestrictions;
    this.presence = host.presence;
    this.hookManager = host.hookManager;
    this.configService = host.configService;
    this.logger = host.logger;
    this.fences = host.fences;
    this.broadcaster = host.broadcaster;
    this.stoppingSessions = host.stoppingSessions;
    this.operatorTeardowns = host.operatorTeardowns;
    this.reconnectStates = host.reconnectStates;
    this.stuckAuthRecoveryUsed = host.stuckAuthRecoveryUsed;
    this.initializingSessions = host.initializingSessions;
  }

  /**
   * True while a delete of the session runs: from before SessionService.delete claims the session until it
   * returns or throws, credential purge included.
   */
  isDeleting(id: string): boolean {
    return this.deleting.has(id);
  }

  /** Count a delete of the session as running until the returned call; see isDeleting. */
  holdDelete(id: string): () => void {
    this.deleting.set(id, (this.deleting.get(id) ?? 0) + 1);
    return () => {
      const running = (this.deleting.get(id) ?? 1) - 1;
      if (running > 0) this.deleting.set(id, running);
      else this.deleting.delete(id);
    };
  }

  /** findOne-or-404 with the runtime-state projection, mirroring SessionService.findOne. */
  private async requireSession(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return this.sessionRestrictions.attachTo(this.sessionErrors.attachTo(session));
  }

  /**
   * requireSession for stop()/delete(), whose caller sets the stop mark before this read. A read
   * that fails has retired nothing, so the mark must not outlive it: left on a running session, its
   * next disconnect would never reconnect and start() would keep refusing it as already started.
   */
  private async requireSessionOrDropStopMark(id: string, onReadFailed?: () => void): Promise<Session> {
    try {
      return await this.requireSession(id);
    } catch (error) {
      this.stoppingSessions.delete(id);
      onReadFailed?.();
      throw error;
    }
  }

  /**
   * `explicit` marks an operator's POST /start, the only start that may clear an operator's stop
   * (desiredState), and only a stop that was already on the row when it began. It clears it only
   * once past every refusal below, so a refused start leaves the stop exactly as it found it.
   * `stoppedSince` answers whether a stop or delete of the session issued after the caller's start
   * began still stands; the start yields to one, also when its mark is already gone.
   */
  async start(
    id: string,
    { explicit = false, stoppedSince }: { explicit?: boolean; stoppedSince?: () => boolean } = {},
  ): Promise<Session> {
    // Reserve the slot SYNCHRONOUSLY at entry — before even the requireSession await. Two
    // near-simultaneous start() calls must not both pass the check and orphan an engine (the has()
    // -> engines.set() window spans the awaited hook below), and the infra import pre-flight
    // (getActiveSessionIds) must see an in-flight start during the findOne round-trip too: registered
    // only after the row read, a start would be invisible in that window and a stopOrphans import
    // could DELETE the session row while an engine for it is being created. The finally clears the
    // reservation on success AND failure so a failed start never wedges at "already starting".
    if (this.initializingSessions.has(id)) {
      throw new BadRequestException('Session is already starting');
    }
    this.initializingSessions.add(id);
    // A stop mark already set when this start began is stale (a start is how one is cleared). One set
    // while it waits below comes from a retirement that saw this start in flight, stopOrphanEngines
    // above all, which writes nothing else this start could read and counts on it aborting. That
    // includes a mark set again on top of a stale one, which only its stamp tells apart.
    const markAtEntry = this.stoppingSessions.stamp(id);

    try {
      const session = await this.requireSession(id);

      // An operator's stop outranks any start but POST /start, so this refuses boot auto-start and
      // the takeover sweep, which pick their rows once and launch them seconds apart, when a stop
      // landed after that read. A delete's record ('deleting') counts as one.
      if (session.desiredState && !explicit) {
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }

      if (this.engines.has(id)) {
        throw new BadRequestException('Session is already started');
      }
      const maxConcurrentSessions = resolveMaxConcurrentSessions(this.configService);
      if (maxConcurrentSessions !== null) {
        // Count each OTHER session once. A session mid-initialization is transiently in BOTH
        // `engines` (set at the start of initializeEngine) and `initializingSessions` (until
        // start()'s finally), so summing the two sizes would double-count it; and `id` itself is
        // already reserved in `initializingSessions` (added at entry), so it must not count
        // against the cap it is being checked against. A session waiting out a failed relaunch holds
        // no engine (the attempt evicted it) but re-registers one when its timer fires, without a cap
        // check of its own, so it keeps its slot here.
        const activeIds = startSlotHolders(this.engines, this.reconnectStates);
        activeIds.delete(id);
        if (activeIds.size >= maxConcurrentSessions) {
          throw new BadRequestException(`Maximum concurrent sessions reached (${maxConcurrentSessions})`);
        }
      }

      // Credential-teardown fence — runs IMMEDIATELY after the read-only session read + duplicate/cap
      // checks and BEFORE any lifecycle mutation (stop-mark clear, hook, reconnect-state, engine
      // creation, recovery-budget reset) or auth-dir access. A logout teardown that lost its deadline
      // race is still running and ends in an fs.rm of this session's on-disk profile — the same path
      // initializeEngine is about to populate. The fence is keyed by session NAME (see
      // awaitPendingTeardown) and FAIL CLOSED: a still-wedged teardown could still rm the fresh
      // profile, so refuse with a retryable 409 instead of proceeding. On a 409, no lifecycle state is touched
      // (the stop mark, reconnect timer, engine, last status/error, and recovery budget are left as
      // they were) — start() simply did not happen. The one transient exception is the
      // initializingSessions reservation added synchronously at start() entry: its finally removes it
      // again, so a refused start does not leave a false "already starting" mark behind (briefly held).
      await this.fences.awaitPendingTeardown(session.name);

      // A delete still running outranks every start, however long it has run: the mark it set is not a
      // stale one, and clearing it below would let an engine start under the delete that is removing the
      // session (the engine would outlive the row). Checked here, with no await before the clear.
      if (this.deleting.has(id)) {
        throw new SessionStoppedException(`Session ${id} is being deleted`);
      }

      // A fresh start intentionally (re-)creates the engine — clear any stale stop/delete mark, but
      // yield to one set after this start began, leaving it in place.
      if (this.stoppingSessions.has(id) && this.stoppingSessions.stamp(id) !== markAtEntry) {
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }
      this.stoppingSessions.delete(id);

      // Cancel any reconnect timer a prior failed executeReconnect left pending, BEFORE the awaited
      // session:starting hook and engine init — otherwise the stale timer can fire during that I/O
      // and destroy/replace the engine this start() is about to create (or orphan the Chromium
      // process). Idempotent: a no-op when no reconnect state exists (the common fresh-start case).
      this.host.cancelReconnect(id);

      // The operator's stop, read again past every refusal and after the mark is cleared. A stop that
      // finished while this start waited above had no engine to take down and just lost its mark,
      // but its record is on the row: only a POST /start sent to an already stopped session clears
      // it, and any other start yields to it with the mark put back. A stop from here on sets the
      // mark again and retires this start after its init. A launch that fails after the clear still
      // counts as the start the operator asked for. A delete issued since this start began that failed once it
      // began removing has dropped its mark and left a record this start may have read too: it still stands.
      const { desiredState } = await this.requireSession(id);
      if ((desiredState && (!explicit || desiredState !== session.desiredState)) || stoppedSince?.()) {
        this.stoppingSessions.add(id);
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }
      // Shutdown may have begun during the reads above, past SessionService's own checks. A start the
      // exiting process will not keep must not clear the stop or run the hook. A start that yielded to
      // a stop answers as the stop, never as a retryable 503: one already on the row is refused above,
      // and the mark (cleared above, so set by a stop or delete that began since) covers one whose row
      // write has not landed yet.
      const closedRefusal = (): Error =>
        this.stoppingSessions.has(id)
          ? new SessionStoppedException(`Session ${id} was stopped`)
          : new ServerShuttingDownException();
      if (this.host.isClosed()) {
        throw closedRefusal();
      }
      if (!(await this.host.prepareStart(id, desiredState))) {
        await this.requireSession(id);
        this.stoppingSessions.add(id);
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }
      // The clear stands, but a shutdown during the write must not let the hook run.
      if (this.host.isClosed()) {
        throw closedRefusal();
      }

      // Execute hook before starting
      await this.hookManager.execute(
        'session:starting',
        { sessionId: id },
        {
          sessionId: id,
          source: 'SessionService',
        },
      );

      // A local teardown already retired this launch; preserve its normal inactive-session response.
      if (this.stoppingSessions.has(id)) return this.requireSession(id);

      // The hook may outlive the lease. Renew this claim only if no stop or owner has replaced it,
      // then register synchronously: a peer stop either changes the row first, or sees the live renewal.
      const prepared = await this.host.prepareStart(id, null);
      // A local stop can arrive during admission too. It owns the inactive response even when its
      // write made admission fail; a delete may already have dropped its mark but retain its request.
      if (this.stoppingSessions.has(id) || stoppedSince?.()) return this.requireSession(id);
      if (!prepared) {
        await this.requireSession(id);
        this.stoppingSessions.add(id);
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }
      if (this.host.isClosed()) throw closedRefusal();

      // Initialize reconnect state from the (untrusted) opaque session.config — coerced + clamped
      // so a poisoned value can't drive a NaN/immediate-relaunch storm or an unbounded loop.
      const { maxAttempts, baseDelay } = resolveReconnectConfig(session.config);
      const reconnectState: ReconnectState = { attempts: 0, timer: null, maxAttempts, baseDelay };
      this.reconnectStates.set(id, reconnectState);

      // An accepted top-level start() re-arms the stuck-auth recovery budget: every fence above
      // (duplicate-start, cap, credential-teardown) passed, so this is a deliberate, operator-initiated
      // (re)start — not an automatic reconnect. The budget is hoisted to the session so an automatic
      // reconnect can't reset it per generation; only a fresh top-level episode may spend it again.
      // Boot auto-start reaches here through this same method, so it re-arms too.
      this.stuckAuthRecoveryUsed.delete(id);

      // initializeEngine registers its engine synchronously, before its first await, so the entry
      // read right after the call is this start's own engine (undefined if creation threw first).
      // The catch must use this capture, not a later lookup: a disconnect of this engine mid-init can
      // schedule a reconnect that registers a replacement before initialize() rejects.
      const before = this.engines.get(id);
      const init = this.host.initializeEngine(id, session);
      const registered = this.engines.get(id);
      const mine = registered !== before ? registered : undefined;
      let failedWritten = false;
      try {
        await init;
      } catch (err) {
        // engine.initialize() failed AFTER the engine was registered. Evict + tear it down so the
        // session doesn't wedge at "already started" with a leaked Chromium/socket permanently holding
        // a concurrency slot. Identity-checked: a replacement registered by a reconnect is left alone,
        // and so is its status (whoever evicted this start's engine owns the teardown).
        //
        // Use forceDestroy(), not destroy(): initialize() failing usually means the underlying
        // browser/CDP connection is already broken (e.g. a "Target closed" crash mid-injection), so
        // a graceful destroy() has nothing live to talk to — it can only time out via
        // teardownEngineSafely's race, after which the orphaned Chromium process is never actually
        // killed. forceDestroy() SIGKILLs the OS process directly, the same recovery force-kill uses
        // for a wedged engine, which is exactly the state this catch block is handling.
        if (mine && this.engines.deleteIfLive(id, mine)) {
          this.sessionErrors.set(id, err instanceof Error ? err.message : String(err));
          await this.fences.teardownEngineSafely(id, mine, e => e.forceDestroy(), 'force-destroy');
          // Fenced on ownership like the engine callbacks: initializeEngine can await a slow
          // Chromium launch for minutes, and this node's lease can lapse and be taken over inside
          // that window. FAILED is excluded from the boot reset AND from the takeover sweep, so
          // writing it onto a row a peer now owns strands the session on every node. Skipped during
          // shutdown too: an init that rejects then usually does so because shutdown destroyed its
          // engine, and the INITIALIZING row is reset by the next boot, where FAILED would not be.
          if (this.host.ownsSession(id) && !this.host.isClosed()) {
            failedWritten = true;
            await this.host.updateStatus(id, SessionStatus.FAILED).catch(() => undefined);
          }
        }
        // Drop the reconnect state this start() armed up front when no engine is registered: nothing
        // will ever fire it, and leaving it behind is dead state a later liveness check would have to
        // reason about. A retry builds its own. A reconnect that already registered a replacement
        // keeps its state.
        if (!this.engines.has(id) && this.reconnectStates.get(id) === reconnectState && !reconnectState.started) {
          this.host.cancelReconnect(id);
        }
        // Shutdown's destroy is the usual cause of an init rejecting now; the adapter's error would
        // read as a fault (or, if transient, buy a retry shutdown refuses anyway). A start a stop
        // retired keeps the adapter's error, as it would without shutdown. So does one whose FAILED
        // went out before shutdown began: a transient error then reaches the retry, whose refusal
        // hands the row back as DISCONNECTED for the next boot.
        throw this.host.isClosed() && !failedWritten && !this.stoppingSessions.has(id)
          ? new ServerShuttingDownException()
          : err;
      }

      // A stop()/delete() may have landed while we awaited engine.initialize() — if so, tear down the
      // engine we just registered so the session isn't resurrected to READY (mirrors the post-init
      // guard in executeReconnect; initialize()'s callbacks can also fire async after this returns).
      // delete() clears its teardown mark before this slow init resolves, so re-check the session row
      // exists, not just the mark; the requireSession below then surfaces a deleted session as NotFound.
      // Guarded like the same read in executeReconnect: a failed read assumes not-retired, so a
      // transient database error cannot fail a start whose engine is already registered and running.
      let retired: boolean;
      try {
        retired = await this.host.isSessionRetired(id);
      } catch {
        retired = false;
      }
      if (retired) {
        await this.reapRetiredEngine(id, mine, reconnectState);
      } else if (this.host.isClosed()) {
        // Shutdown destroys every engine it finds, this one included, and skips initialize() for an
        // engine it caught mid-start. Either way the session is not kept, so this is no success. A
        // start retired above answers as the stop or delete that retired it instead.
        throw new ServerShuttingDownException();
      }
      try {
        return await this.requireSession(id);
      } catch (error) {
        // The engine is registered and running. A failed read (a missing row stays NotFound) must not
        // report a start that worked as failed: the retry a transient database error buys would answer
        // "already started". The row read on entry stands in for the one that failed.
        // A row found gone only now is the retirement the failed read above could not report: the engine
        // goes with it.
        if (!retired && error instanceof NotFoundException) await this.reapRetiredEngine(id, mine, reconnectState);
        if (retired || error instanceof NotFoundException) throw error;
        return session;
      }
    } finally {
      this.initializingSessions.delete(id);
    }
  }

  /**
   * Tears down the engine a start registered for a session that was stopped or deleted meanwhile, or whose
   * claim this node lost, and drops the reconnect state it armed for it.
   */
  private async reapRetiredEngine(
    id: string,
    resurrected: IWhatsAppEngine | undefined,
    reconnectState?: ReconnectState,
  ): Promise<void> {
    if (resurrected) await this.retireLaunchedEngine(id, resurrected);
    // The reconnect state this start armed up front serves no engine now, and the stop or delete that retired it
    // may have run before the state was armed, so nothing else would drop it. A replacement engine that
    // registered meanwhile keeps its own.
    if (!this.engines.has(id) && this.reconnectStates.get(id) === reconnectState && !reconnectState?.started) {
      this.host.cancelReconnect(id);
    }
    // A delete() that raced this start purged the on-disk auth dirs BEFORE this init re-created them, so
    // purge again: the window then leaves no credential residue behind (no-op for a stop()).
    await this.host.purgeAuthDirsIfDeleted(id);
  }

  /**
   * Tear down the engine a start or a reconnect registered for a session retired while it initialized: a
   * stop, a delete, or a claim this node no longer holds. The read that found the claim gone is newer than
   * the in-memory ownership the engine callbacks are fenced on, so the engine's own DISCONNECTED report is
   * held back like an operator teardown's, and the status is written instead only on a row that is still
   * this node's or has no owner: a peer's row keeps the status its own engine gave it (INV-6).
   */
  async retireLaunchedEngine(id: string, engine: IWhatsAppEngine): Promise<void> {
    if (!this.engines.isLive(id, engine)) return;
    this.operatorTeardowns.set(id, engine);
    try {
      await this.fences.destroyWithEscalation(id, engine);
      this.engines.deleteIfLive(id, engine);
    } finally {
      if (this.operatorTeardowns.get(id) === engine) this.operatorTeardowns.delete(id);
    }
    const nodeId = this.host.nodeId;
    const ours =
      nodeId === undefined
        ? { id }
        : [
            { id, nodeId },
            { id, nodeId: IsNull() },
          ];
    try {
      const { affected } = await this.sessionRepository.update(ours, { status: SessionStatus.DISCONNECTED });
      if (affected) this.broadcaster.announce(id, SessionStatus.DISCONNECTED);
    } catch (error) {
      this.logger.warn('Failed to persist the disconnected status of a retired launch', {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(id: string, hooks: StopHooks = {}): Promise<Session> {
    const session = await this.requireSessionOrDropStopMark(id, hooks.onReadFailed);
    // Recorded only once the row is known to exist, and before anything is torn down.
    await hooks.afterRead?.();

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.host.cancelReconnect(id);

    // Disconnect the engine — time-bounded + isolated so a stuck socket can't wedge the stop; the
    // Map is reconciled regardless. (The stop mark is intentionally left set, matching the prior
    // behaviour: a later start() clears it; it guards against a late reconnect resurrecting the id.)
    const engine = this.engines.get(id);
    if (engine) {
      // This teardown's own DISCONNECTED is not announced from the engine callback (see
      // operatorTeardowns): the adapter reports it before the eviction, so consumers would learn the
      // session is down while it still reads as engine-loaded. The write below announces it instead.
      this.operatorTeardowns.set(id, engine);
      try {
        // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
        // write so a delayed pre-initialize status update can never settle after the retirement and
        // become the last persisted status. Identity-checked: only the captured engine's promise.
        await this.fences.awaitInitialStatus(id, engine);
        let tornDown = await this.fences.teardownEngineSafely(id, engine, e => e.disconnect(), 'disconnect');
        if (!tornDown) {
          // The graceful disconnect threw or timed out, so the engine may be half-attached (a leaked
          // Chromium process or a live socket). Escalate to the hard kill, the same forceDestroy()
          // that forceKill() uses for a wedged engine, before reporting the stop.
          this.logger.warn(`Graceful disconnect failed for session ${session.name}; escalating to force-destroy`, {
            sessionId: id,
            action: 'stop_escalate_force_destroy',
          });
          tornDown = await this.fences.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
        }
        // Reconciled regardless of the outcome: a wedged engine must not keep holding a concurrency
        // slot or read as "already started" to a later start().
        this.engines.deleteIfLive(id, engine);
        if (!tornDown) {
          // The hard kill failed too, so the engine's process may still be alive. Local state is
          // settled (Map reconciled, status DISCONNECTED — mirroring logout()'s incomplete path), but
          // the stop is reported as incomplete instead of claimed clean: a retryable 502 with a stable
          // code, and no success log (the controller audits SESSION_STOPPED only after this resolves).
          await this.host.updateStatus(id, SessionStatus.DISCONNECTED);
          throw new BadGatewayException({
            statusCode: HttpStatus.BAD_GATEWAY,
            message:
              'Session was stopped locally, but the engine teardown did not complete: the engine ' +
              'process may still be running. Retry the stop; restart the node to reap a leaked process.',
            error: 'Bad Gateway',
            code: 'SESSION_STOP_INCOMPLETE',
          });
        }
      } finally {
        // Identity-checked, so a verb that captured a different instance keeps its own mark.
        if (this.operatorTeardowns.get(id) === engine) {
          this.operatorTeardowns.delete(id);
        }
      }
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.host.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.requireSession(id);
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
   * cleanup failure. A Baileys session with no linked device has nothing to unlink, so its engine refuses
   * with EngineNotReadyError, answered as that 409 after the same local teardown rather than as a 502
   * whose retry could only repeat. After EVERY engine-backed attempt (200, 409 OR 502) the session is torn down locally
   * (map reconciled, status DISCONNECTED) and `phone` is cleared so the boot auto-start does not
   * resurrect the session into an uncertain/invalid credential state. No success audit is written on
   * the 502 path (the controller audits SESSION_LOGGED_OUT only after the service resolves). The
   * operator can start the session and retry the logout.
   */
  async logout(id: string, hooks: StopHooks = {}): Promise<Session> {
    const session = await this.requireSession(id).catch((error: unknown) => {
      hooks.onReadFailed?.();
      throw error;
    });
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:sessionId/start first.');
    }
    hooks.onEngineFound?.();

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.host.cancelReconnect(id);

    // Announced by the write below rather than from the engine callback, as in stop().
    this.operatorTeardowns.set(id, engine);
    let unlinked: boolean;
    // The teardown helper keeps only whether the call settled; the engine's refusal of a session with no
    // linked device is kept here so it can answer instead of the 502.
    let neverLinked: EngineNotReadyError | undefined;
    try {
      // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
      // write so a delayed pre-initialize status update can never settle after the retirement.
      await this.fences.awaitInitialStatus(id, engine);
      // The credential fence is keyed by session NAME (see awaitPendingTeardown). Captured immutably
      // here so a raw logout that outlives its deadline race is tracked under the right name even if
      // the row is later deleted/recreated.
      unlinked = await this.fences.teardownEngineSafely(
        id,
        engine,
        e =>
          e.logout().catch((error: unknown) => {
            if (error instanceof EngineNotReadyError) neverLinked = error;
            throw error;
          }),
        'logout',
        session.name,
      );
      this.engines.deleteIfLive(id, engine);
      // Clear `phone` AFTER the attempt, whatever its outcome, to take the session out of the boot
      // auto-start query (phone IS NOT NULL). A completed engine-backed unlink wipes the stored
      // credentials, so the session can never reach READY again without a fresh QR/pairing; an
      // incomplete one tore the local credentials down, so re-entering auto-start would only wedge it.
      // Before the status write, so a failed status write cannot leave the flag behind and resurrect
      // the session into a QR it can never pass on every restart. onReady rewrites it on the next link.
      await this.sessionRepository.update(id, { phone: null });
      await this.host.updateStatus(id, SessionStatus.DISCONNECTED);
    } finally {
      if (this.operatorTeardowns.get(id) === engine) {
        this.operatorTeardowns.delete(id);
      }
    }

    if (neverLinked) throw neverLinked;
    if (!unlinked) {
      this.logger.warn(`Session stopped locally but the logout operation did not complete: ${session.name}`, {
        sessionId: id,
        action: 'logout_incomplete',
      });
      // The local teardown already ran (map reconciled, `phone` cleared, status DISCONNECTED), but the
      // unlink operation did not complete. The retryable 502 carries a stable machine code so the
      // dashboard can branch on origin without guessing from the status/message; no success audit is
      // written on this path.
      throw new BadGatewayException({
        statusCode: HttpStatus.BAD_GATEWAY,
        message:
          'Session was stopped locally, but the logout operation is incomplete — the device may ' +
          'still be linked. Start the session and retry the logout.',
        error: 'Bad Gateway',
        code: 'SESSION_LOGOUT_INCOMPLETE',
      });
    }

    this.logger.log(`Session logged out: ${session.name}`, {
      sessionId: id,
      action: 'logout',
    });
    return this.requireSession(id);
  }

  /**
   * Force-recover a stuck session: SIGKILL its engine's own resources (a wedged Chromium for the
   * whatsapp-web.js engine) and tear it down, even when a normal stop()/delete() can't because the
   * engine is hung. Mirrors stop()'s lifecycle (stop-mark + cancel-reconnect + bounded, isolated
   * teardown + Map reconciliation) but uses the engine's forceDestroy().
   */
  async forceKill(id: string, hooks: StopHooks = {}): Promise<Session> {
    // No stop mark is set yet, so a failed read leaves a concurrent stop's mark alone.
    const session = await this.requireSession(id).catch((error: unknown) => {
      hooks.onReadFailed?.();
      throw error;
    });
    const engine = this.engines.get(id);

    // No live engine means there is nothing to SIGKILL. Resolving would let the controller write a
    // SESSION_FORCE_KILLED audit row for a kill that never happened — mirror logout()'s not-started
    // refusal. A wedged engine torn down earlier is reaped by the next start()'s orphan sweep (and
    // by process exit), not by force-kill.
    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:sessionId/start first.');
    }
    // In the same synchronous step as the engine lookup: a refused or failed kill never gets here.
    hooks.onEngineFound?.();

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    this.host.cancelReconnect(id);

    // A force-kill is a stop too: the session stays down across restarts and takeover until an
    // explicit start. Recorded only once there is an engine to kill, and before the teardown, so a
    // POST /start that lands after the eviction clears it and stands. A failed write must not keep a
    // wedged engine alive, so it is logged and the kill goes on.
    const write = (): Promise<unknown> =>
      hooks.recordStop ? hooks.recordStop() : this.sessionRepository.update(id, { desiredState: 'stopped' });
    await write().catch((error: unknown) =>
      this.logger.error(
        'Failed to record the force-kill as a stop',
        error instanceof Error ? error.message : String(error),
        { sessionId: id, action: 'force_kill_keep_down_failed' },
      ),
    );

    // Announced by the write below rather than from the engine callback, as in stop().
    this.operatorTeardowns.set(id, engine);
    try {
      // Await THIS engine's in-flight INITIALIZING write before teardown / the final DISCONNECTED
      // write so a delayed pre-initialize status update can never settle after the retirement.
      await this.fences.awaitInitialStatus(id, engine);
      const tornDown = await this.fences.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
      this.engines.deleteIfLive(id, engine);
      if (!tornDown) {
        // As in stop(): local state is settled, but a kill that may have left the process alive is
        // reported as incomplete, not claimed clean (the controller audits only after a resolve).
        await this.host.updateStatus(id, SessionStatus.DISCONNECTED);
        throw new BadGatewayException({
          statusCode: HttpStatus.BAD_GATEWAY,
          message:
            'Session was stopped locally, but the engine force-kill did not complete: the engine ' +
            'process may still be running. Restart the node to reap a leaked process.',
          error: 'Bad Gateway',
          code: 'SESSION_FORCE_KILL_INCOMPLETE',
        });
      }

      this.logger.warn(`Session force-killed: ${session.name}`, {
        sessionId: id,
        action: 'force_kill',
      });
      await this.host.updateStatus(id, SessionStatus.DISCONNECTED);
    } finally {
      if (this.operatorTeardowns.get(id) === engine) {
        this.operatorTeardowns.delete(id);
      }
    }
    return this.requireSession(id);
  }

  async delete(id: string, hooks: StopHooks = {}): Promise<void> {
    const session = await this.requireSessionOrDropStopMark(id, hooks.onReadFailed);

    // FENCE #1 — fail-fast on an ALREADY-PENDING credential teardown for this session NAME, BEFORE
    // any lifecycle mutation. A logout teardown that lost its deadline race is still running and ends
    // in an fs.rm of this session's on-disk auth dir. Running the purge below while that rm is live
    // would leave the two removals racing over the same tree, and a stale rm must not outlive the
    // row. The fence is keyed by session NAME and fails CLOSED (409). On a 409 NOTHING else runs:
    // no stop mark, no reconnect cancel, no engine teardown, no state cleanup — delete() simply did
    // not happen, and the entry stays reserved.
    await this.fences.awaitPendingTeardown(session.name);

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.host.cancelReconnect(id);

    // Set only after the transaction actually removes the parent row. lastDispatchedStatus /
    // sessionErrors (and the recovery budget, Task 8) are cleared ONLY on a committed delete; a
    // rejected 409 from fence #2 leaves them intact (the session still exists).
    let parentDeleted = false;
    const writes = closeSessionWrites(this.host.dataSource(), id);
    const endDelete = this.holdDelete(id);

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
        await this.fences.awaitInitialStatus(id, engine);
        await this.fences.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
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
        await this.fences.awaitPendingTeardown(session.name);
      } catch (fenceError) {
        if (engine) {
          await this.host.updateStatus(id, SessionStatus.DISCONNECTED).catch(() => undefined);
        }
        throw fenceError;
      }

      await writes.drain();
      hooks.onRemoving?.();
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
      // Delete every child row explicitly, children before the parent: the three tables that grow with traffic
      // go first, in batches (a failure part-way keeps the session with fewer rows), then the rest and the
      // parent in one transaction. For
      // messages/message_batches this is load-bearing: they carry a plain sessionId with no FK, so
      // nothing else would ever remove them. webhooks/templates/baileys_stored_messages (and
      // automation_rules) DO declare an ON DELETE CASCADE FK that fires on BOTH engines —
      // better-sqlite3 defaults `foreign_keys` ON and TypeORM's driver re-asserts it at connection
      // creation — so their explicit deletes are belt-and-braces rather than required; they stay
      // because depending on a pragma neither this file nor a test pins is a thinner guarantee than
      // an explicit delete, and the ordering mirrors the restore path's explicit-clear. chat_states and
      // status_updates are in the no-FK group too, and so are the session's webhook outbox rows,
      // webhook delivery-failure records, integration dead-letter rows (which keep full payloads) and
      // send idempotency claims (which keep the stored response of a send for 24 h, so a session
      // re-created under the same id could not replay one). The webhook and dead-letter records are
      // point-in-time: a delivery still in flight can write one after the commit, and their retention
      // windows cover it.
      //
      // Deliberately kept: conversation_mappings (a re-paired session is rebound to its provider
      // conversations, see ConversationMappingService.rebindSession), ingress_events (the
      // instance-keyed inbound dedup record, payload already dropped after dispatch, always pruned
      // after INGRESS_DEDUP_RETENTION_DAYS), lid_mappings (a global cache by design) and audit_logs (the audit trail).
      await this.deleteTrafficRowsInBatches(session, hooks.ownsClaim);
      const dataSource = this.host.dataSource();
      await this.withDeleteClaim(session, hooks.ownsClaim, async manager => {
        await manager.delete(Message, { sessionId: id });
        await manager.delete(MessageBatch, { sessionId: id });
        await manager.delete(ChatState, { sessionId: id });
        await manager.delete(StatusUpdate, { sessionId: id });
        await manager.delete(Webhook, { sessionId: id });
        await manager.delete(Template, { sessionId: id });
        await manager.delete(BaileysStoredMessage, { sessionId: id });
        await manager.delete(WebhookOutboxEvent, { sessionId: id });
        await manager.delete(WebhookDeliveryFailure, { sessionId: id });
        await manager.delete(IntegrationDeliveryFailure, { sessionId: id });
        await manager.delete(SendIdempotencyKey, { sessionId: id });
        await manager.remove(session);
      });
      parentDeleted = true;
      this.logger.log(`Session deleted: ${session.name}`, {
        sessionId: id,
        action: 'delete',
      });

      // Purge the persistent on-disk auth/store dirs — BOTH engine shapes (see EngineFactory), since
      // an engine switch may have left a live link for the other engine behind. They're keyed by
      // session ID and live independently of the (now torn-down, and on delete often never-loaded)
      // engine instance, so the teardown above doesn't touch them. Without this, the deleted
      // session's WhatsApp credentials stay on the volume. Best-effort inside the factory — never
      // fails an otherwise-successful delete. By this point both fences passed, so no old remover is
      // live against this session's directories. The name goes too: it is the key the directories
      // carried before 0.23.5, and the boot migration keeps a legacy one it could not rename. Unless
      // it is another session's id, whatever its shape (an import accepts any safe key): the dirs it
      // names are then that session's live login, the same exact-id guard the migration keeps. A
      // failed lookup withholds the name rather than fail a delete that has already committed. The id
      // column is varchar on PostgreSQL too (an import keeps any safe key), so a name of any shape can be
      // a session's id there; it is compared as text, so only a name that really is an id withholds itself.
      // Keyed by `id`, not `session.id`: TypeORM clears a removed entity's primary key, so session.id
      // is undefined here and the purge would refuse it as an unsafe key and remove nothing.
      const legacyId =
        dataSource.options.type === 'postgres'
          ? Raw(alias => `CAST(${alias} AS text) = :legacyId`, { legacyId: session.name })
          : session.name;
      const nameIsAnId = await this.sessionRepository.exists({ where: { id: legacyId } }).catch(() => true);
      await this.engineFactory.purgeSessionData(id, nameIsAnId ? undefined : session.name);
    } catch (error) {
      // The session survives, but the write scopes closed above stay retired for good: a bulk batch
      // running for it stops at its next item without recording anything, and one not yet picked up
      // never starts. Nothing else moves a PENDING or PROCESSING row on while this process lives.
      if (!parentDeleted) await this.failUnfinishedBatches(session, hooks.ownsClaim);
      throw error;
    } finally {
      writes.release();
      endDelete();
      // Always clear the teardown mark so a later recreate/start with this id isn't suppressed. This
      // stop mark was set after fence #1, so clearing it on a rejected 409 only undoes what THIS
      // delete added — it does NOT touch reconnect timer / engine / last status / error / recovery
      // state (those are gated on parentDeleted below).
      this.stoppingSessions.delete(id);
      if (parentDeleted) {
        this.broadcaster.clear(id);
        // Drop the FAILED-reason entry too: it's keyed by a now-deleted UUID that can never be read
        // again, so leaving it would grow the map without bound across create/fail/delete churn.
        this.sessionErrors.clear(id);
        // Same unbounded-growth argument for the restriction entry, and the gauge it feeds must not
        // keep counting an account whose session no longer exists.
        this.sessionRestrictions.clear(id);
        // Presence is per-connection state that the deleted session can never receive again, and it
        // is keyed by an id that will never be read.
        this.presence.clear(id);
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

  /**
   * Fail the session's unfinished bulk batches after a delete that closed its write scopes but did not
   * remove it. Written against the table rather than through the batch service, which this module cannot
   * reach without a cycle. Best effort: the database that just failed the delete may fail this too, and the
   * boot reaper still gets the row on the next start.
   */
  private async failUnfinishedBatches(session: Session, ownsClaim?: () => boolean): Promise<void> {
    const sessionId = session.id;
    try {
      await this.withDeleteClaim(session, ownsClaim, manager => failUnfinishedSessionBatches(manager, sessionId));
    } catch (error) {
      this.logger.warn(`Could not fail the unfinished batches of session ${sessionId} after a failed delete`, {
        sessionId,
        action: 'session_delete_batch_fail_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove a session's rows of the tables that grow with traffic (its messages, its webhook outbox records
   * and its webhook delivery failures) in batches, ahead of the transaction that removes everything else.
   * One DELETE over a session that has stored millions of rows ran past PostgreSQL's statement timeout,
   * which failed the whole delete (every retry the same) and, on SQLite, blocked the one event loop for the
   * length of the statement while each message row also fired the full-text index trigger.
   *
   * The batches are not one atomic unit: a failure part-way leaves the session with fewer rows, and
   * repeating the delete finishes the job. Nothing new can land meanwhile, because the engine is gone and
   * the closing write scope refuses outbound writes. SQLite resolves each statement within the same tick, so
   * the loop pauses between batches to let the event loop run, and sizes each batch to the time the last one took.
   *
   * A batch is removed by primary key alone. Its ids were read for this session a statement earlier, so a
   * sessionId condition beside the id list adds no safety, and it costs: SQLite plans the delete as a walk
   * over the session's remaining rows that filters on the list, once per batch (PostgreSQL does too while its
   * statistics are missing or stale), which made a long history take longer than linear.
   */
  private async deleteTrafficRowsInBatches(session: Session, ownsClaim?: () => boolean): Promise<void> {
    const sessionId = session.id;
    const dataSource = this.host.dataSource();
    const postgres = dataSource.options.type === 'postgres';
    let size = postgres ? SESSION_DELETE_BATCH_SIZE_POSTGRES : SESSION_DELETE_BATCH_MIN_SQLITE;
    const readAhead = postgres ? SESSION_DELETE_READ_AHEAD_POSTGRES : 1;
    const head = (entity: EntityTarget<{ id: string; sessionId: string }>): TrafficPass => {
      const repository = dataSource.getRepository(entity);
      let ahead: string[] = [];
      let more = true;
      return {
        rows: repository,
        next: async take => {
          // What is left of the last read is still in the table and comes first in the next, so it is replaced.
          if (ahead.length < take && more) {
            const rows = take * readAhead;
            ahead = (await repository.find({ select: { id: true }, where: { sessionId }, take: rows })).map(
              row => row.id,
            );
            more = ahead.length === rows;
          }
          return ahead.splice(0, take);
        },
      };
    };
    const messages = dataSource.getRepository(Message);
    const passes: TrafficPass[] = [
      { rows: messages, next: this.stampedMessageIds(sessionId) },
      { rows: messages, next: this.unstampedMessageIds(sessionId) },
      head(WebhookOutboxEvent),
      head(WebhookDeliveryFailure),
    ];
    for (const { rows, next } of passes) {
      for (;;) {
        const started = performance.now();
        const ids = await next(size);
        if (ids.length === 0) break;
        await this.withDeleteClaim(session, ownsClaim, async manager => {
          await manager.getRepository(rows.target).delete({ id: In(ids) });
        });
        if (ids.length < size) break;
        if (!postgres) size = nextSqliteDeleteBatchSize(ids.length, performance.now() - started);
        await new Promise<void>(resolve =>
          postgres ? setImmediate(resolve) : setTimeout(resolve, SESSION_DELETE_PAUSE_MS_SQLITE),
        );
      }
    }
  }

  /** Lock the owner row with each destructive unit, never across a hook or between batches. */
  private async withDeleteClaim(
    session: Session,
    ownsClaim: (() => boolean) | undefined,
    remove: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    const dataSource = this.host.dataSource();
    // A savepoint on SQLite's shared connection could be rolled back by an unrelated caller.
    if (!(await awaitNoOpenTransaction(dataSource))) {
      throw new ServiceUnavailableException(
        `Session ${session.id} was not deleted: another database transaction stayed open. Retry the delete.`,
      );
    }
    await dataSource.transaction(async manager => {
      if (this.host.nodeId !== undefined) {
        const { affected } = await manager
          .createQueryBuilder()
          .update(Session)
          .set({ nodeId: this.host.nodeId, updatedAt: () => '"updatedAt"' })
          .where({ id: session.id, nodeId: this.host.nodeId, claimedAt: session.claimedAt ?? IsNull() })
          .execute();
        if (affected !== 1) throw new ConflictException(`Session ${session.id} is no longer owned by this node`);
      }
      if (ownsClaim?.() === false)
        throw new ConflictException(`Session ${session.id} is no longer owned by this delete`);
      await remove(manager);
    });
  }

  /**
   * The messages that carry a timestamp, a page at a time in the order of IDX_messages_session_timestamp_id,
   * each page starting after the last row of the one before. A select that restarted from the head of the
   * session's range every time stepped over every entry the earlier batches had deleted: PostgreSQL keeps
   * those in the index until a vacuum removes them, so the cost of the loop grew with the square of the history.
   */
  private stampedMessageIds(sessionId: string): (take: number) => Promise<string[]> {
    const messages = this.host.dataSource().getRepository(Message);
    let last: { timestamp: number; id: string } | undefined;
    return async take => {
      const query = messages
        .createQueryBuilder('message')
        .select('message.id', 'id')
        .addSelect('message.timestamp', 'timestamp')
        .where('message.sessionId = :sessionId AND message.timestamp IS NOT NULL', { sessionId });
      if (last) query.andWhere('(message.timestamp, message.id) > (:timestamp, :id)', last);
      const page = await query
        .orderBy('message.timestamp', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .limit(take)
        .getRawMany<{ id: string; timestamp: string | number }>();
      const end = page[page.length - 1];
      if (end) last = { timestamp: Number(end.timestamp), id: end.id };
      return page.map(row => row.id);
    };
  }

  /**
   * The messages without a timestamp (a send that was never acknowledged), after the stamped ones, paged by
   * id. Ordering by the null timestamp as well is what lets PostgreSQL read the index in order instead of
   * sorting every remaining row for each page.
   */
  private unstampedMessageIds(sessionId: string): (take: number) => Promise<string[]> {
    const messages = this.host.dataSource().getRepository(Message);
    let lastId: string | undefined;
    return async take => {
      const query = messages
        .createQueryBuilder('message')
        .select('message.id', 'id')
        .where('message.sessionId = :sessionId AND message.timestamp IS NULL', { sessionId });
      if (lastId !== undefined) query.andWhere('message.id > :lastId', { lastId });
      const page = await query
        .orderBy('message.timestamp', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .limit(take)
        .getRawMany<{ id: string }>();
      if (page.length > 0) lastId = page[page.length - 1].id;
      return page.map(row => row.id);
    };
  }

  /**
   * The engine half of SessionService.onModuleDestroy: stop reconnect timers FIRST so nothing
   * reschedules mid-teardown (and so this always runs even if an engine.destroy() below hangs or
   * throws), then destroy engines in parallel, each isolated + time-bounded, so one stuck Chromium
   * can neither stall the shutdown nor abort teardown of the other sessions.
   */
  async shutdown(): Promise<void> {
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();

    await Promise.allSettled(
      [...this.engines].map(([sessionId, engine]) => this.fences.destroyEngineSafely(sessionId, engine)),
    );
    this.engines.clear();
  }

  /**
   * Stop the engines for the given session ids WITHOUT touching the sessions DB row (the caller,
   * the infra import path, is about to DELETE that row as part of a full replace). This is the one
   * stop path that bypasses the session-row-keyed controls — every other path keys through the row,
   * so an engine orphaned by a restore was previously unstoppable until process restart.
   *
   * Each id is handled in isolation and time-bounded: a stuck Chromium/socket on one orphan can
   * neither stall nor abort the others, and the whole call is bounded by two of teardownEngineSafely's
   * 10s deadlines per engine (destroy, then the forceDestroy escalation). The mark + reconnect-cancel happen first so an in-flight reconnect
   * cannot resurrect the id while teardown runs. Engines that are mid-initialization (no entry in
   * `engines` yet) are marked but cannot be torn down here — their start() will see the stop mark
   * via its existing guard and self-abort; the caller learns about them in `notRunning`. A session
   * waiting to relaunch after a failed reconnect has no engine either: the reconnect cancel above is
   * what stops it, and it is reported in `notRunning` too.
   *
   * Always resolves. Best-effort: a `failed` entry means destroy and the forceDestroy escalation both
   * threw or timed out, and the engine is removed from the Map regardless so it stops holding a
   * concurrency slot.
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
        this.host.cancelReconnect(id);

        const engine = this.engines.get(id);
        if (!engine) {
          // Either never started, or still inside initializeEngine (no Map entry yet). The stop mark
          // above is what aborts the initializing case via start()'s existing guard.
          notRunning.push(id);
          return;
        }
        try {
          const tornDown = await this.fences.destroyWithEscalation(id, engine);
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
          // destroyWithEscalation never throws today (it isolates via teardownEngineSafely), but defend
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
}
