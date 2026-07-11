import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, DataSource, FindManyOptions } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { paginate, ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { resolveFeatureFlags } from '../../config/feature-flags';
import {
  IWhatsAppEngine,
  EngineStatus,
  ChatSummary,
  ChatState,
  DeliveryStatus,
  IncomingMessage,
  ReactionEvent,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

// Reconnect-backoff bounds. An OPERATOR-supplied session.config feeds this math, so the values
// are coerced + clamped: a non-numeric value would otherwise make the delay NaN (setTimeout fires
// at 0 — relaunch storm) and the terminal guard `attempts >= NaN` always false (unbounded loop).
const RECONNECT_BASE_DELAY_MIN_MS = 1000;
const RECONNECT_BASE_DELAY_MAX_MS = 300_000;
const RECONNECT_MAX_ATTEMPTS_CAP = 20;
const RECONNECT_DELAY_CAP_MS = 3_600_000;
/**
 * Delay before retrying an ack UPDATE that matched 0 rows. A fast delivered/read ack can arrive before
 * the send's 2nd save (which writes waMessageId) has committed, so the first UPDATE finds no row. One
 * retry after this delay closes that race; the forward-only transition guard keeps it idempotent.
 */
export const ACK_RECONCILE_DELAY_MS = 750;

const clampNumber = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/** Coerce + clamp the untyped session.config reconnect knobs to finite, bounded values. Defaults
 *  (5000ms / 5 attempts) are preserved; a legitimate `maxReconnectAttempts: 0` (disable) is kept. */
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
  const maxAttempts = Math.floor(
    clampNumber(Number.isFinite(attemptsRaw) ? attemptsRaw : 5, 0, RECONNECT_MAX_ATTEMPTS_CAP),
  );
  return { maxAttempts, baseDelay };
}

/** Clamp a computed backoff delay finite and within setTimeout's safe range (a huge value would
 *  overflow its 32-bit ms field and fire immediately). */
export function clampReconnectDelay(rawDelay: number, baseDelay: number): number {
  return clampNumber(Number.isFinite(rawDelay) ? rawDelay : baseDelay, 0, RECONNECT_DELAY_CAP_MS);
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

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();
  // Bounded cache for inline @lid -> phone resolution (#263), keyed `${sessionId}:${lid}`. Caches
  // misses (null) too, so a chatty unmapped sender isn't re-queried on every message (which also
  // reduces engine rate-limit pressure). Best-effort feature, so staleness is acceptable.
  private readonly lidPhoneCache = new Map<string, string | null>();
  private static readonly LID_PHONE_CACHE_MAX = 5000;
  // Transient, human-readable reason for the most recent terminal engine failure,
  // keyed by session id. Surfaced on read so the dashboard can explain a FAILED
  // status; cleared when the session re-initializes or becomes ready.
  private sessionErrors: Map<string, string> = new Map();

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
  // awaited hook and orphan an engine the lifecycle could never destroy.
  private initializingSessions: Set<string> = new Set();

  // Serializes the read-modify-write of a message's reactions map per `${sessionId}:${waMessageId}`,
  // so two concurrent reaction events on the same message don't clobber each other (both read the
  // same snapshot, both full-row save, last writer wins). Entries are deleted once their chain drains.
  private reactionChains: Map<string, Promise<void>> = new Map();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    @Optional()
    private readonly configService?: ConfigService,
    // Shared lid<->phone table (global). Used to persist an inbound @lid sender's resolved phone so
    // an inbound-only migrated contact's `@lid` and `@c.us` rows bridge in the read-path (#583 R3 Ph2).
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
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

  /** Destroy one engine, isolating + time-bounding failures so shutdown can't be stalled or aborted. */
  private async destroyEngineSafely(sessionId: string, engine: IWhatsAppEngine): Promise<void> {
    this.logger.log(`Destroying engine for session ${sessionId}`, { sessionId, action: 'shutdown' });
    await this.teardownEngineSafely(sessionId, engine, e => e.destroy(), 'destroy');
  }

  /**
   * Run an engine teardown (destroy/disconnect), isolating + time-bounding failures so a stuck
   * Chromium/socket can neither hang nor abort the caller. Always resolves — the caller is then free
   * to reconcile the engines Map and proceed with DB cleanup regardless of teardown outcome.
   */
  private async teardownEngineSafely(
    sessionId: string,
    engine: IWhatsAppEngine,
    teardown: (e: IWhatsAppEngine) => Promise<void>,
    label: 'destroy' | 'disconnect' | 'force-destroy',
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        teardown(engine),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`engine.${label}() timed out`)), 10_000);
        }),
      ]);
    } catch (err) {
      this.logger.error(`Failed to ${label} engine for session ${sessionId}`, String(err), {
        sessionId,
        action: `engine_${label}_failed`,
      });
    } finally {
      if (timer) clearTimeout(timer);
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

  /**
   * Populate the transient `lastError` field from the in-memory error map. Only a
   * FAILED session carries an error; any other status clears it so a recovered
   * session never shows a stale failure reason.
   */
  private attachLastError(session: Session): Session {
    session.lastError = session.status === SessionStatus.FAILED ? this.sessionErrors.get(session.id) : undefined;
    return session;
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

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    try {
      // Stop engine if running — time-bounded + isolated so a stuck Chromium can't wedge the delete;
      // the Map is reconciled and the DB removal proceeds regardless of the outcome. Use forceDestroy()
      // (SIGKILL) rather than a graceful destroy(): the session is being removed permanently, so there is
      // no session state worth saving, and a wedged Chromium must be reaped, not left to time out.
      const engine = this.engines.get(id);
      if (engine) {
        await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
        this.engines.delete(id);
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
      this.logger.log(`Session deleted: ${session.name}`, {
        sessionId: id,
        action: 'delete',
      });

      // Purge the engine's persistent on-disk auth/store dir. It's keyed by session NAME and lives
      // independently of the (now torn-down, and on delete often never-loaded) engine instance, so the
      // teardown above doesn't touch it. Without this, recreating a session under the same name reloads
      // a stale store. Best-effort inside the factory — never fails an otherwise-successful delete.
      await this.engineFactory.purgeSessionData(session.name);
    } finally {
      // Always clear the teardown mark so a later recreate/start with this id isn't suppressed.
      this.stoppingSessions.delete(id);
      this.lastDispatchedStatus.delete(id);
      // Drop the FAILED-reason entry too: it's keyed by a now-deleted UUID that can never be read
      // again, so leaving it would grow the map without bound across create/fail/delete churn.
      this.sessionErrors.delete(id);
    }
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Reserve the slot SYNCHRONOUSLY (same tick as the has() check) so two near-simultaneous
    // start() calls can't both pass the check and orphan an engine — the has() -> engines.set()
    // window spans the awaited hook below. The second caller is rejected; the finally clears the
    // reservation on success AND failure so a failed start never wedges at "already starting".
    if (this.engines.has(id)) {
      throw new BadRequestException('Session is already started');
    }
    if (this.initializingSessions.has(id)) {
      throw new BadRequestException('Session is already starting');
    }
    const maxConcurrentSessions = resolveMaxConcurrentSessions(this.configService);
    if (maxConcurrentSessions !== null) {
      // Count each session once. A session mid-initialization is transiently in BOTH `engines` (set at
      // the start of initializeEngine) and `initializingSessions` (until start()'s finally), so summing
      // the two sizes would double-count it and falsely reject new starts at ~half the configured cap.
      const activeCount = new Set<string>([...this.engines.keys(), ...this.initializingSessions]).size;
      if (activeCount >= maxConcurrentSessions) {
        throw new BadRequestException(`Maximum concurrent sessions reached (${maxConcurrentSessions})`);
      }
    }
    this.initializingSessions.add(id);

    try {
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
          this.engines.delete(id);
        }
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
   * mutate the session that now belongs to a different — or no — engine. `this.engines` is the
   * single source of truth for the active engine, so identity comparison closes both the
   * post-stop and the stale-generation (stop→start / reconnect-replace) windows the one-shot
   * post-init guard does not cover.
   */
  private isLiveEngine(id: string, engine: IWhatsAppEngine): boolean {
    return this.engines.get(id) === engine;
  }

  /**
   * Persist pre-connection history into the `messages` table for the chat view, without webhook/hook/ws
   * dispatch (it predates the live session). De-duplicated by `waMessageId` so re-syncs never duplicate.
   */
  private async persistHistoryMessages(id: string, messages: IncomingMessage[]): Promise<void> {
    const storeEphemeralMessages = resolveFeatureFlags(this.configService).storeEphemeralMessages;
    const byId = new Map<string, IncomingMessage>();
    for (const m of messages) {
      // Need an id to de-dup; chatId/from/to are NOT NULL; status/story posts aren't chats.
      if (!m.id || m.isStatusBroadcast || !m.chatId || !m.from || !m.to) {
        continue;
      }
      // Mirror the live onMessage guard: skip disappearing messages when the operator opted out, so a
      // history backfill can't bypass STORE_EPHEMERAL_MESSAGES=false. No-op when the flag is at its
      // default (true); only a message with a positive timer is dropped, never a regular one.
      if (!storeEphemeralMessages && (m.ephemeralDuration ?? 0) > 0) {
        continue;
      }
      byId.set(m.id, m);
    }
    if (byId.size === 0) {
      return;
    }
    // Chunk the dedup query: a batch can be thousands, past SQLite's bound-variable limit for IN (...).
    const ids = [...byId.keys()];
    const CHUNK = 400;
    let inserted = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunkIds = ids.slice(i, i + CHUNK);
      const existing = await this.messageRepository.find({
        where: { sessionId: id, waMessageId: In(chunkIds) },
        select: ['waMessageId'],
      });
      const seen = new Set(existing.map(r => r.waMessageId));
      const rows = chunkIds
        .filter(x => !seen.has(x))
        .map(x => {
          const m = byId.get(x)!;
          const metadata: Record<string, unknown> = {};
          if (m.media) metadata.media = m.media;
          if (m.quotedMessage) metadata.quotedMessage = m.quotedMessage;
          if (m.call) metadata.call = m.call;
          const row = this.messageRepository.create({
            sessionId: id,
            waMessageId: m.id,
            chatId: m.chatId,
            from: m.from,
            to: m.to,
            body: m.body,
            type: m.type,
            direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
            timestamp: m.timestamp,
            status: MessageStatus.SENT,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          });
          // The chat panel orders by createdAt; stamp the real time so history sorts correctly.
          if (m.timestamp) {
            row.createdAt = new Date(m.timestamp * 1000);
          }
          return row;
        });
      if (rows.length) {
        // Insert-or-ignore: a live onMessage insert can land between the `seen` SELECT above and this
        // write, colliding on UNIQUE(sessionId, waMessageId). orIgnore skips the collision instead of
        // throwing and aborting the whole batch (history is best-effort, persist-never-dispatch).
        await this.messageRepository
          .createQueryBuilder()
          .insert()
          .values(rows as unknown as QueryDeepPartialEntity<Message>[])
          .orIgnore()
          .execute();
        inserted += rows.length;
      }
    }
    if (inserted) {
      this.logger.log(`Persisted ${inserted} history message(s)`, {
        sessionId: id,
        inserted,
        action: 'history_messages_persisted',
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
    this.sessionErrors.delete(id);

    // Mark INITIALIZING before engine.initialize(): the engine drives status forward
    // (QR_READY -> AUTHENTICATING -> READY) through the callbacks below while it
    // initializes, so writing INITIALIZING afterwards would clobber that progress.
    await this.updateStatus(id, SessionStatus.INITIALIZING);

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
      onReady: (phone: string, pushName: string): void => {
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
        this.sessionErrors.delete(id);

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
      },
      onMessage: (message): void => {
        if (!this.isLiveEngine(id, engine)) return;
        // Status/Story posts arrive via the inbound path for some engines; don't persist or webhook them.
        // Mirrors the isStatusBroadcast guard in onMessageCreate below.
        if (message.isStatusBroadcast) {
          return;
        }
        // Ephemeral/disappearing messages: skip persist + dispatch when the operator opted out.
        // A message is ephemeral when its chat has a disappearing-messages timer (ephemeralDuration > 0).
        if (
          !resolveFeatureFlags(this.configService).storeEphemeralMessages &&
          message.ephemeralDuration &&
          message.ephemeralDuration > 0
        ) {
          this.logger.debug('Skipping ephemeral message', {
            sessionId: id,
            messageId: message.id,
            chatId: message.chatId,
            ephemeralDuration: message.ephemeralDuration,
          });
          return;
        }
        this.logger.debug(`Message received from ${message.from}`, {
          sessionId: id,
          messageId: message.id,
          from: message.from,
          action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
        // Convert IncomingMessage to plain object for dispatch
        const messageData = { ...message };

        // Execute hook for message received - plugins can modify or stop processing
        void this.hookManager
          .execute('message:received', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(async ({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue) {
              // A plugin handled the event and asked to stop the chain (continue: false).
              return;
            }

            // Persist the incoming message so the dashboard chats view can render history.
            const incoming: IncomingMessage = finalMessage;

            // Inline @lid -> phone resolution (#263), opt-in via RESOLVE_LID_TO_PHONE. Best-effort:
            // attaches senderPhone (digits or null) before persist/dispatch so webhook/ws consumers
            // get it in a single pass. Only for privacy-id senders, so no lookup for normal numbers.
            if (resolveFeatureFlags(this.configService).resolveLidToPhone && incoming.isLidSender && !incoming.fromMe) {
              incoming.senderPhone = await this.resolveSenderPhone(id, incoming.author ?? incoming.from);
            }

            const metadata: Record<string, unknown> = {};
            if (incoming.media) {
              metadata.media = incoming.media;
            }
            if (incoming.quotedMessage) {
              metadata.quotedMessage = incoming.quotedMessage;
            }
            if (incoming.call) {
              metadata.call = incoming.call;
            }

            const chatName = incoming.contact?.pushName ?? incoming.contact?.name ?? undefined;

            const dbMessage = this.messageRepository.create({
              sessionId: id,
              waMessageId: incoming.id,
              chatId: incoming.chatId,
              chatName,
              from: incoming.from,
              to: incoming.to,
              body: incoming.body,
              type: incoming.type,
              direction: incoming.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
              timestamp: incoming.timestamp,
              status: MessageStatus.SENT,
              metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            });

            // The hook chain above is async; a delete()/teardown can retire this engine while it
            // awaits. Re-check liveness so a late continuation can't persist an orphan messages row
            // (the row has no FK, so a session-delete cleanup would never reap it) or dispatch for a
            // session that no longer exists. Mirrors the synchronous isLiveEngine gate at entry.
            if (!this.isLiveEngine(id, engine)) return;

            // De-duplicate at the source: the engine can re-fire `message` for one inbound message
            // (#464). UNIQUE(sessionId, waMessageId) makes the insert the atomic dedup oracle — a
            // near-simultaneous re-fire loses the race and is skipped here, so persist + webhook + WS
            // happen exactly once. Fail-open: a non-conflict DB error still dispatches, so a real
            // message is never dropped by a transient DB failure.
            let isNewMessage = true;
            let persisted = false;
            try {
              // `insert()` (not `save()`) is load-bearing: the UNIQUE(sessionId, waMessageId) constraint
              // makes a duplicate insert throw, which is the atomic dedup oracle for #464 re-fires.
              // Unlike `save()`, `insert()` does NOT merge DB-generated columns (@PrimaryGeneratedColumn,
              // @CreateDateColumn) back onto the entity instance — so merge them explicitly here, before
              // the `message:persisted` emit. `identifiers[0]` always carries the PK on both SQLite and
              // Postgres; `generatedMaps[0]` adds createdAt where the driver returns it (Postgres yes;
              // SQLite historically does not — acceptable; the PK is the load-bearing field for plugins).
              const result = await this.messageRepository.insert(
                dbMessage as unknown as QueryDeepPartialEntity<Message>,
              );
              Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
              persisted = true;
            } catch (err) {
              if (isUniqueConstraintError(err)) {
                isNewMessage = false;
              } else {
                this.logger.error(`Failed to save incoming message ${incoming.id} to database`, String(err));
              }
            }
            if (!isNewMessage) {
              return; // duplicate re-fire — the original already persisted and dispatched
            }

            // Fire-and-forget: a plugin handler must never break the receive path. Both engine adapters
            // (wwjs `message` and Baileys `upsert`) converge on this persist, so one emit covers inbound.
            // The built-in FTS search provider is DB-synced and does NOT consume this; it exists for
            // plugin providers (Spec 2) + general use.
            // Gate ONLY the hook on `persisted`: on a non-unique insert error (transient SQLITE_BUSY /
            // lock-timeout / connection drop) the row was never stored and `dbMessage.id` is undefined,
            // so emitting `message:persisted` would hand plugins an id-less payload for a row that isn't
            // in the DB. The webhook/WS dispatch below stays fail-open — a real inbound message must
            // never be dropped on a transient DB failure; only the hook requires a durable row.
            if (persisted) {
              void this.hookManager
                .execute(
                  'message:persisted',
                  { sessionId: id, message: dbMessage },
                  { sessionId: id, source: 'SessionService' },
                )
                .catch(() => undefined);
            }

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.received', finalMessage);
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage);
          })
          .catch(err => this.logger.error(`onMessage handler failed for ${id}`, String(err)));
      },
      onHistoryMessages: (messages): void => {
        if (!this.isLiveEngine(id, engine)) return;
        // Persist for the chat view only; no dispatch (these predate the live session).
        void this.persistHistoryMessages(id, messages).catch(err =>
          this.logger.error(`Failed to persist history messages for ${id}`, String(err)),
        );
      },
      onMessageCreate: (message): void => {
        if (!this.isLiveEngine(id, engine)) return;
        // `message_create` fires for every message the account creates, including sends composed on a
        // linked phone — which the `message`/`onMessage` event never delivers. Incoming messages are
        // already handled by `onMessage`, so only outgoing (`fromMe`) ones produce `message.sent` here.
        if (!message.fromMe) {
          return;
        }

        // Status/Story posts are account-created but not real conversations; don't emit `message.sent`
        // for them. The adapter flags these (the engine-specific pseudo-JID stays out of this layer).
        if (message.isStatusBroadcast) {
          return;
        }

        this.logger.debug(`Message sent to ${message.to}`, {
          sessionId: id,
          messageId: message.id,
          to: message.to,
          action: 'message_sent',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
        const messageData = { ...message };

        // Execute hook for message sent - plugins can modify or stop processing
        void this.hookManager
          .execute('message:sent', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue) {
              return;
            }

            // NOTE: unlike onMessage (incoming), this path intentionally does NOT mirror the message
            // to the `messages` table. message_create ALSO fires for API-originated sends, which the
            // REST send path already persists — saving here would double-persist them. Safe
            // persistence of phone-composed sends needs a unique (sessionId, waMessageId) index +
            // de-dup and is tracked as a separate enhancement; until then this path only webhooks/
            // emits. So local message history reflects API sends + all inbound, but not sends
            // composed on a linked phone.
            void this.webhookService.dispatch(id, 'message.sent', finalMessage);
            // Emit real-time event to WebSocket clients (as message.sent, not message.received)
            this.eventsGateway.emitMessageSent(id, finalMessage);
          })
          .catch(err => this.logger.error(`onMessageCreate handler failed for ${id}`, String(err)));
      },
      onMessageAck: (messageId, status: DeliveryStatus): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
          sessionId: id,
          messageId,
          status,
          action: 'message_ack',
        });

        // Reflect real delivery state on the stored message (#220): delivered/read/failed advance the
        // stored status; pending/sent carry no upgrade (it's already SENT — visibly "not delivered").
        // The UPDATE is guarded to the allowed prior statuses so delivery state only ADVANCES: an
        // out-of-order/late ack cannot downgrade a higher status, which also makes these
        // fire-and-forget writes race-safe at the DB level.
        const messageStatus = deliveryStatusToMessageStatus(status);
        if (messageStatus) {
          // Scope by sessionId: waMessageId is unique per account/chat, not global — an ack on one
          // session must never advance a same-id row in another session. The In() guard makes the
          // UPDATE forward-only (a late/out-of-order ack can't downgrade) and idempotent on retry.
          const advanceAck = (): Promise<number> =>
            this.messageRepository
              .update(
                { sessionId: id, waMessageId: messageId, status: In(ackStatusTransitionFrom(messageStatus)) },
                { status: messageStatus },
              )
              .then(result => result.affected ?? 0);

          const logNoop = (): void =>
            this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
              sessionId: id,
              messageId,
              status,
              action: 'message_ack_noop',
            });

          const onAckError = (err: unknown): void =>
            this.logger.error(`Failed to advance ack for ${messageId}`, String(err));

          void advanceAck()
            .then(affected => {
              if (affected > 0) return;
              // affected:0 — most likely the send's 2nd save (which writes waMessageId) hasn't committed
              // yet, so the row isn't matchable. Each ack is one-shot (WhatsApp won't necessarily resend),
              // so retry ONCE after a short delay to close that race rather than leave it stuck at SENT.
              const timer = setTimeout(() => {
                void advanceAck()
                  .then(retried => {
                    if (retried === 0) logNoop();
                  })
                  .catch(onAckError);
              }, ACK_RECONCILE_DELAY_MS);
              timer.unref?.();
            })
            .catch(onAckError);
        }

        // One ack payload, emitted identically over the socket and the webhook so a client coded
        // against either channel sees the same shape. `id` mirrors the field every other message.*
        // event carries (and the idempotency-key resolver reads). `ack` is a deprecated legacy field
        // kept for backward compatibility — new consumers should read the neutral `status`.
        const ackPayload = { id: messageId, messageId, status, ack: deliveryStatusToAck(status) };

        // Push the live delivery/read tick to the dashboard over the websocket.
        this.eventsGateway.emitMessageAck(id, ackPayload);

        // Dispatch the delivery/read receipt to webhooks (#155). Outgoing `message.sent` is handled
        // solely by `onMessageCreate`, so the ack path deliberately does NOT emit `message.sent`.
        void this.webhookService.dispatch(id, 'message.ack', ackPayload);

        // Surface delivery failures actively so consumers don't have to poll for them (#220). Use a
        // distinct object (not the shared ackPayload) so this separate event can't be perturbed by an
        // in-place payload mutation in the concurrent message.ack dispatch's webhook:before hook.
        if (status === 'failed') {
          void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
        }

        // Notify plugins of the delivery/read receipt. The `message:ack` hook event was declared in
        // the HookEvent union but never emitted, so any plugin registered for it silently never fired.
        // Fire-and-forget: an ack is a notification with nothing downstream to cancel, so the hook's
        // `continue` flag is moot. Delivery failures surface here as status `failed` — `message:failed`
        // stays reserved for send-time send failures, which carry a distinct `{ error, input }` payload.
        void this.hookManager.execute(
          'message:ack',
          { messageId, status, ack: deliveryStatusToAck(status) },
          { sessionId: id, source: 'Engine' },
        );
      },
      onMessageRevoked: (message): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.debug(`Message revoked: ${message.id}`, {
          sessionId: id,
          messageId: message.id,
          action: 'message_revoked',
        });

        // Flag the stored message as revoked (best-effort; the message may not be in the
        // DB). The dashboard renders the localized "message deleted" text, so no display
        // string is persisted here.
        //
        // Match on `revokedId` (the ORIGINAL deleted message's id) when present: on wwebjs
        // `message.id` is the revocation notification, which never matches a stored row.
        // `revokedId` falls back to `id` (Baileys, where the two are the same).
        const revokedWaMessageId = message.revokedId ?? message.id;
        void this.messageRepository
          .update({ sessionId: id, waMessageId: revokedWaMessageId }, { body: '', type: 'revoked' })
          .catch(err => {
            this.logger.error(`Failed to update revoked message: ${revokedWaMessageId}`, String(err));
          });

        // Notify consumers regardless of whether the row existed: webhook (message.revoked
        // is a declared event) + the real-time dashboard stream.
        const revokedPayload = message as unknown as Record<string, unknown>;
        void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
        this.eventsGateway.emitMessageRevoked(id, revokedPayload);
      },
      onMessageReaction: (event): void => {
        if (!this.isLiveEngine(id, engine)) return;
        this.logger.debug(`Message reaction received: ${event.messageId} -> ${event.reaction}`, {
          sessionId: id,
          messageId: event.messageId,
          action: 'message_reaction_received',
        });

        // Serialize per message so two concurrent reactions don't read the same snapshot and clobber
        // each other on the full-row save. A prior chain's failure must not block later reactions.
        const key = `${id}:${event.messageId}`;
        const prior = this.reactionChains.get(key) ?? Promise.resolve();
        const next = prior.catch(() => undefined).then(() => this.applyReaction(id, event));
        this.reactionChains.set(key, next);
        void next.finally(() => {
          // Clean up only if no newer reaction chained after us, so the map can't leak per message.
          if (this.reactionChains.get(key) === next) {
            this.reactionChains.delete(key);
          }
        });
      },
      onDisconnected: (reason: string): void => {
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

        // Attempt to reconnect
        this.scheduleReconnect(id, session);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        if (!this.isLiveEngine(id, engine)) return;
        const statusMap: Record<EngineStatus, SessionStatus> = {
          [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
          [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
          [EngineStatus.QR_READY]: SessionStatus.QR_READY,
          [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
          [EngineStatus.READY]: SessionStatus.READY,
          [EngineStatus.FAILED]: SessionStatus.FAILED,
        };
        const newStatus = statusMap[engineState];
        if (newStatus) {
          void this.updateStatus(id, newStatus);
        }
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
    const engineInitTimeoutMs = 60_000;
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
        // Force-kill whatever got launched so a retry doesn't collide with an orphaned browser.
        // teardownEngineSafely is itself time-bound, so this can't wedge a second time.
        await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
        this.engines.delete(id);
        await this.updateStatus(id, SessionStatus.DISCONNECTED);
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
  private async applyReaction(id: string, event: ReactionEvent): Promise<void> {
    try {
      const msg = await this.messageRepository.findOne({ where: { sessionId: id, waMessageId: event.messageId } });
      if (!msg) return;

      const metadata = msg.metadata || {};
      const reactions = (metadata.reactions as Record<string, string>) || {};
      if (!event.reaction) {
        delete reactions[event.senderId];
      } else {
        reactions[event.senderId] = event.reaction;
      }
      metadata.reactions = reactions;
      // Scoped update of ONLY the metadata column. A full-row save(msg) would re-persist the `status`
      // read at findOne time, clobbering a concurrent ack UPDATE (SENT→DELIVERED/READ) that committed in
      // the window between this findOne and the write — reactionChains serializes reaction-vs-reaction
      // but NOT reaction-vs-ack, so scoping the write to metadata is what keeps delivery state monotonic
      // (#220). Other metadata fields are carried through untouched (they were read into `metadata`).
      await this.messageRepository.update({ sessionId: id, waMessageId: event.messageId }, {
        metadata,
      } as QueryDeepPartialEntity<Message>);

      this.eventsGateway.emitMessageReaction(id, { ...event, reactions });
      // Webhook parity with the WebSocket broadcast: same payload (event + post-apply snapshot), so a
      // webhook-only consumer observes reactions too. Idempotency for this event is salted per dispatch.
      void this.webhookService.dispatch(id, 'message.reaction', { ...event, reactions });
    } catch (err) {
      this.logger.error(`Failed to update message reaction: ${event.messageId}`, String(err));
    }
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

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      // Don't leave the session silently stuck DISCONNECTED — mark it terminally FAILED with a reason
      // so findOne/findAll surface it via `lastError` and the dashboard shows it needs a restart.
      // maxAttempts:0 means auto-reconnect is disabled, not that N attempts were tried and failed — say
      // so instead of the misleading "failed after 0 attempts".
      this.sessionErrors.set(
        id,
        state.maxAttempts === 0
          ? 'Auto-reconnect is disabled (max attempts set to 0); the session was left disconnected — restart it manually.'
          : `Reconnection failed after ${state.attempts} attempts — restart the session.`,
      );
      void this.updateStatus(id, SessionStatus.FAILED);
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter), clamped finite + within
    // setTimeout's safe range so the timer can't overflow and fire immediately.
    const delay = clampReconnectDelay(
      state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000,
      state.baseDelay,
    );
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

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
        this.engines.delete(id);
      }

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
          this.engines.delete(id);
        }
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
      await this.teardownEngineSafely(id, engine, e => e.disconnect(), 'disconnect');
      this.engines.delete(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
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

    // Mark as tearing down BEFORE cleanup so an in-flight reconnect can't resurrect it.
    this.stoppingSessions.add(id);
    this.cancelReconnect(id);

    const engine = this.engines.get(id);
    if (engine) {
      await this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
      this.engines.delete(id);
    }

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

  /**
   * Best-effort resolution of a privacy-id sender (`@lid`) to a phone number for inline attachment on
   * incoming messages (#263). Cached per session (incl. misses). Never throws — returns null on any
   * failure or when the engine isn't available. Gated by the caller on `RESOLVE_LID_TO_PHONE`.
   */
  private async resolveSenderPhone(sessionId: string, contactId: string): Promise<string | null> {
    const key = `${sessionId}:${contactId}`;
    const cached = this.lidPhoneCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let phone: string | null;
    try {
      phone = (await this.getEngine(sessionId)?.resolveContactPhone(contactId)) ?? null;
    } catch {
      phone = null;
    }
    // Bounded FIFO eviction: Map preserves insertion order, so the first key is the oldest.
    if (this.lidPhoneCache.size >= SessionService.LID_PHONE_CACHE_MAX) {
      for (const oldest of this.lidPhoneCache.keys()) {
        this.lidPhoneCache.delete(oldest);
        break;
      }
    }
    this.lidPhoneCache.set(key, phone);
    // Persist a real @lid -> phone resolution so the read-path can bridge this contact's `@lid` and
    // `@c.us` rows even when the operator never sent to them (#583 R3 Phase 2). Reuses the resolution
    // above — no extra network call — and is fire-and-forget so dispatch never blocks/fails on it.
    if (phone) {
      void this.lidMappingStore?.remember(userPart(contactId), phone, sessionId)?.catch(() => {});
    }
    return phone;
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
