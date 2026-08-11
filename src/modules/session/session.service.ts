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
import { CreateSessionDto, SessionConfigResponseDto, UpdateSessionConfigDto } from './dto';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore, type ChatPresence } from './presence-store.service';
import { SessionEngineLifecycle, resolveReconnectConfig } from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';
import { paginate, ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { IWhatsAppEngine, ChatSummary, ChatState } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks';

// Re-exported so the existing spec import paths keep working after these moved out.
export { clampReconnectDelay } from './reconnect-policy';
export { ACK_RECONCILE_DELAY_MS } from './message-projector.service';
export {
  SESSION_WATCHDOG_INTERVAL_MS,
  SESSION_WATCHDOG_PROBE_TIMEOUT_MS,
  SESSION_WATCHDOG_MAX_FAILURES,
} from './session-liveness-watchdog.service';
export {
  resolveReconnectConfig,
  resolveMaxConcurrentSessions,
  EngineInitTimeoutError,
} from './session-engine-lifecycle.service';

/**
 * The session-record API: CRUD over the sessions table, aggregate stats, and the thin engine query
 * proxies (QR/pairing/chats/groups/chat-state) behind the controller routes. Every engine LIFECYCLE
 * verb (start/stop/logout/forceKill/delete/stopOrphanEngines), the reconnect machinery, the engine
 * event wiring, and the status broadcast live in SessionEngineLifecycle — the sole writer of the
 * shared EngineRegistry. This service delegates those verbs one-directionally (no forwardRef), so
 * its public surface toward the controller and the feature modules is unchanged by the split.
 */
@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = createLogger('SessionService');

  // Live engine instances, owned by the shared EngineRegistry (the narrow port feature modules
  // inject instead of this whole service). SessionEngineLifecycle is the only writer; the query
  // proxies below read through this alias.
  private get engines(): EngineRegistry {
    return this.engineRegistry;
  }

  /** The detached auto-start run; see onApplicationBootstrap. Awaited by onModuleDestroy. */
  private autoStartRun: Promise<void> = Promise.resolve();
  /** Set at the top of onModuleDestroy so the detached run stops launching further sessions. */
  private shuttingDown = false;

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineRegistry: EngineRegistry,
    private readonly watchdog: SessionLivenessWatchdog,
    private readonly sessionErrors: SessionErrorStore,
    private readonly sessionRestrictions: SessionRestrictionStore,
    private readonly presence: PresenceStore,
    private readonly hookManager: HookManager,
    private readonly engineLifecycle: SessionEngineLifecycle,
    @Optional()
    private readonly configService?: ConfigService,
    // Trailing @Optional, like configService: the running app always provides it, while the
    // direct-construction unit tests omit it — every use below is `?.`-guarded, so a session simply
    // behaves as unowned there, which is what a single-process deployment is anyway.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
  ) {}

  /**
   * On startup, mark as disconnected the sessions whose engines this process was running, since no
   * engine survives a restart.
   *
   * Scoped to what this process may claim. An active status means "an engine is running somewhere",
   * and resetting all of them assumed that somewhere was always here — true of a single process,
   * and wrong beside a live peer, whose sessions would be reported disconnected while they are
   * serving traffic. A row held by another node with an unexpired lease is therefore left alone.
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
      SessionStatus.ACTION_REQUIRED,
    ];

    const claimable = this.ownership?.claimableWhere() ?? [{}];
    const result = await this.sessionRepository.update(
      claimable.map(clause => ({ ...clause, status: In(activeStatuses) })),
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
        nodeId: this.ownership?.nodeId,
      });
    }
  }

  onApplicationBootstrap(): void {
    // Start the liveness watchdog FIRST: it must run even when auto-start is disabled (sessions can
    // be started via the API at any time), so it can't sit behind the auto-start early-return below.
    // The watchdog owns the probe cadence and failure counting; a session it proves dead comes
    // back through the same disconnect path an engine-reported drop uses.
    this.watchdog.start((id, engine, reason) => this.engineLifecycle.handleEngineDisconnected(id, engine, reason));
    // A session this node has lost belongs to a peer now, which is free to start its own engine.
    // Leaving ours running would put two engines on one WhatsApp account — the thing the claim
    // exists to prevent — so the engine goes down. stopOrphanEngines is the right verb: it tears
    // down locally and leaves the row alone, because the row is no longer ours to write.
    // The teardown report is not consulted here: losing a claim is not a request anyone is waiting
    // on, and stopOrphanEngines already logs what it could not stop.
    this.ownership?.onLeaseLoss(async ids => void (await this.engineLifecycle.stopOrphanEngines(ids)));
    // Claims are only renewed while something still runs for them here, so a claim left behind by
    // an untracked teardown path lapses instead of pinning the session to this node forever.
    this.ownership?.setEngineLiveness(id => this.engineLifecycle.isEngineActive(id));
    // Renewal runs regardless of auto-start: a session started through the API later is claimed the
    // same way and must keep its lease alive.
    this.ownership?.startHeartbeat();

    if (!resolveFeatureFlags(this.configService).autoStartSessions) return;

    // DETACHED, deliberately. Nest binds the HTTP listener only after every onApplicationBootstrap
    // hook has settled, and this loop's duration is unbounded: one engine initialization is at least
    // 60s (resolveEngineInitTimeoutMs) and there is a 2s throttle between sessions, so a host with
    // ten authenticated sessions kept the port CLOSED — not unhealthy, closed — for ten minutes.
    // Every liveness probe in that window is a connection refusal, and no probe budget can cover a
    // bound that scales with the session count: the chart's is ~50s and the Dockerfile HEALTHCHECK
    // encodes the same expectation. Awaited on shutdown so a launch in flight is accounted for.
    this.autoStartRun = this.autoStartSessions().catch((error: unknown) => {
      // Previously this rejected out of the hook and aborted boot, so a transient database error
      // during the session scan took the whole gateway down rather than the auto-start.
      this.logger.error('Auto-start scan failed', error instanceof Error ? error.message : String(error), {
        action: 'auto_start_scan_failed',
      });
    });
  }

  /**
   * Launch every previously authenticated session this node may claim, one at a time.
   *
   * Sequential with a throttle by design — these are Chromium launches — which is exactly why it
   * cannot run inside the bootstrap hook. See onApplicationBootstrap.
   */
  private async autoStartSessions(): Promise<void> {
    // Restricted to sessions this node may claim. Without it every replica scans the same rows and
    // races to launch the same engines, which is a WhatsApp account being opened twice, not merely
    // duplicated work.
    const claimable = this.ownership?.claimableWhere() ?? [{}];
    const sessions = await this.sessionRepository.find({
      where: claimable.map(clause => ({ ...clause, phone: Not(IsNull()), status: SessionStatus.DISCONNECTED })),
    });

    if (sessions.length === 0) return;

    this.logger.log(`Auto-starting ${sessions.length} previously authenticated session(s)`, {
      action: 'auto_start',
      count: sessions.length,
    });

    for (let i = 0; i < sessions.length; i++) {
      // A shutdown landing mid-run must not launch anything further: onModuleDestroy tears down what
      // exists, and a browser launched after that point is never destroyed.
      if (this.shuttingDown) {
        this.logger.log(`Auto-start stopped at ${i} of ${sessions.length} session(s): shutting down`, {
          action: 'auto_start_aborted',
        });
        return;
      }
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
    this.shuttingDown = true;
    this.watchdog.stop();
    this.ownership?.stopHeartbeat();
    // A SIGTERM during boot can land while the detached auto-start is mid-launch. Let that one
    // settle — the flag above stops the loop taking another — so the engine it registers is torn
    // down below instead of outliving the process as an orphaned browser. Bounded by the launch
    // already in flight, never by the whole run.
    await this.autoStartRun;
    // Reconnect timers + engine teardown belong to the lifecycle owner.
    await this.engineLifecycle.shutdown();
    // Released only after the engines are actually down, so a peer never claims a session this
    // process is still holding open.
    await this.ownership?.releaseAll();
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
    return sessions.map(session => this.attachRuntimeState(session));
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return this.attachRuntimeState(session);
  }

  /**
   * Attach the transient fields no column carries: why the session last failed, and whether
   * WhatsApp is restricting its account. See SessionErrorStore / SessionRestrictionStore — each map
   * and its projection live together.
   */
  private attachRuntimeState(session: Session): Session {
    return this.sessionRestrictions.attachTo(this.sessionErrors.attachTo(session));
  }

  /**
   * Project the opaque `config` column onto the three keys the engine actually reads, resolved
   * through the same clamp the engine uses — so a legacy row holding an out-of-range value reports
   * what will really happen rather than what someone once wrote.
   */
  private projectConfig(config: Record<string, unknown>): SessionConfigResponseDto {
    const { maxAttempts, baseDelay } = resolveReconnectConfig(config);
    return {
      // Strict `=== true` mirrors maybeAutoRejectCall: a truthy string or 1 left in the opaque blob
      // must not read as opted in here when it would not opt in there.
      autoRejectCalls: config?.autoRejectCalls === true,
      maxReconnectAttempts: Number.isFinite(maxAttempts) ? maxAttempts : null,
      reconnectBaseDelay: baseDelay,
    };
  }

  async getConfig(id: string): Promise<SessionConfigResponseDto> {
    const session = await this.findOne(id);
    return this.projectConfig(session.config ?? {});
  }

  /**
   * Merge the supplied keys into `config` and persist. Merge rather than replace: the column is
   * documented as an opaque blob, so a key this endpoint does not know about belongs to the
   * operator and must survive a write that never mentioned it.
   *
   * An explicit `null` deletes the key, which is the only way back to a default that no in-range
   * value can express (`maxReconnectAttempts` unlimited). `undefined` — the key simply absent from
   * the request — leaves the stored value alone.
   *
   * No restart, and deliberately no engine call: `autoRejectCalls` is re-read from this row on
   * every incoming call, so the write alone is what takes effect. The reconnect pair is read once
   * per start() into reconnectStates, so it lands on the next start; that asymmetry is documented
   * on the DTO rather than papered over by forcing a reconnect nobody asked for.
   */
  async updateConfig(id: string, dto: UpdateSessionConfigDto): Promise<SessionConfigResponseDto> {
    const session = await this.findOne(id);
    const config = { ...(session.config ?? {}) };

    for (const key of ['autoRejectCalls', 'maxReconnectAttempts', 'reconnectBaseDelay'] as const) {
      const value = dto[key];
      if (value === undefined) continue;
      if (value === null) {
        delete config[key];
      } else {
        config[key] = value;
      }
    }

    // update() with an explicit object rather than save() on the loaded entity: the entity carries
    // runtime-attached fields (lastError, restriction) that no column backs, and save() would try to
    // write the whole row back from a snapshot taken before this await.
    await this.sessionRepository.update(id, { config: config as QueryDeepPartialEntity<Record<string, unknown>> });
    return this.projectConfig(config);
  }

  /** Record removal + engine retirement + credential purge: owned by the lifecycle service. */
  async delete(id: string): Promise<void> {
    // Set the tearing-down mark SYNCHRONOUSLY, before the ownership fence's awaited query. The
    // pre-initialize retirement race needs this mark visible to an in-flight start()'s
    // post-INITIALIZING check by the time that write settles; awaiting anything first — the fence's
    // COUNT, or delete()'s own requireSession — would let the mark land after that window. A mark
    // left behind when the fence refuses (409) is harmless and is cleared by the next start().
    this.engineLifecycle.markStopping(id);
    try {
      if (this.ownership) await this.assertNotHeldElsewhere(id);
      await this.engineLifecycle.delete(id);
      await this.ownership?.release(id);
    } catch (error) {
      this.discardStopMarkForMissingSession(id, error);
      throw error;
    }
  }

  /**
   * Reclaim the entry-time stop mark when the id turns out to have no session row.
   *
   * The mark is set synchronously, before the awaited existence check — deliberately, and the
   * comments above say why. A mark left behind by a refusal is harmless because the next start()
   * clears it, but that presupposes a row: start() and delete() both clear the mark only after
   * their own requireSession, so for an id that never had one the entry is unreachable by every
   * reclamation path and survives for the life of the process. A 404 also means there is no engine
   * and no in-flight start() for the mark to guard, so dropping it is safe as well as necessary.
   */
  private discardStopMarkForMissingSession(id: string, error: unknown): void {
    if (error instanceof NotFoundException) this.engineLifecycle.clearStopping(id);
  }

  /**
   * Refuse a lifecycle write for a session a LIVE peer is running.
   *
   * start() is fenced by the claim itself, and logout/force-kill require a local engine, so they
   * cannot act on a peer's session. stop() and delete() can: neither needs an engine here, so
   * without this a request landing on the wrong node — routine when ownership is configured but
   * request routing is not — writes DISCONNECTED over a peer's live session, or deletes its row and
   * credentials outright, while the peer's engine keeps running. A LAPSED claim is not fenced: the
   * holder may be gone, and taking over is exactly what the claim rule allows.
   */
  private async assertNotHeldElsewhere(id: string): Promise<void> {
    if (await this.ownership?.isHeldByOtherNode(id)) {
      throw new ConflictException(`Session ${id} is running on another node`);
    }
  }

  async start(id: string): Promise<Session> {
    // Claimed before the engine is launched, never after: launching first and discovering the
    // session belongs elsewhere would already have opened a second connection to the account.
    if (this.ownership && !(await this.ownership.claim(id))) {
      // The claim is a conditional UPDATE, so an id that does not exist also matches zero rows —
      // surface the route's documented 404 for that case instead of a misleading 409.
      await this.findOne(id);
      throw new ConflictException(`Session ${id} is running on another node`);
    }
    try {
      return await this.engineLifecycle.start(id);
    } catch (error) {
      // A failed or refused start must not leave the claim pinned here — the heartbeat would renew
      // it and the session could never be started anywhere else. Released only when nothing is
      // actually alive locally: an "already starting/started" refusal means this node genuinely
      // runs the engine, and releasing then would invite a peer to open a second connection.
      await this.releaseUnlessEngineActive(id);
      throw error;
    }
  }

  async stop(id: string): Promise<Session> {
    // Synchronous stop-mark before the awaited fence — see delete() for why.
    this.engineLifecycle.markStopping(id);
    let session: Session;
    try {
      if (this.ownership) await this.assertNotHeldElsewhere(id);
      session = await this.engineLifecycle.stop(id);
    } catch (error) {
      this.discardStopMarkForMissingSession(id, error);
      throw error;
    }
    // Handed back on the way out so a peer can pick it up immediately rather than waiting for the
    // lease to lapse. Stop is the deliberate end of this process's ownership — but a start() that
    // began before this stop and is still mid-launch owns the claim now, so the same
    // engine-liveness guard the failure paths use applies here: releasing under an in-flight start
    // would leave a live engine on an unclaimed row that no heartbeat renews and any peer may
    // start a second time.
    await this.releaseUnlessEngineActive(id);
    return session;
  }

  /** See SessionEngineLifecycle.logout() for the full unlink/502 contract. */
  async logout(id: string): Promise<Session> {
    try {
      const session = await this.engineLifecycle.logout(id);
      // Torn down locally on the 200 path — hand the claim back the way stop() does.
      await this.releaseUnlessEngineActive(id);
      return session;
    } catch (error) {
      // The 502-incomplete path tears the engine down too, and a "not started" refusal never had
      // one — either way a claim that no longer covers an engine must not survive the call.
      await this.releaseUnlessEngineActive(id);
      throw error;
    }
  }

  async forceKill(id: string): Promise<Session> {
    try {
      const session = await this.engineLifecycle.forceKill(id);
      await this.releaseUnlessEngineActive(id);
      return session;
    } catch (error) {
      await this.releaseUnlessEngineActive(id);
      throw error;
    }
  }

  /** Hand the claim back unless something still runs here (engine, in-flight start, pending reconnect). */
  private async releaseUnlessEngineActive(id: string): Promise<void> {
    if (!this.ownership || this.engineLifecycle.isEngineActive(id)) {
      return;
    }
    await this.ownership.release(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

        // Execute hook for ready event
        void this.hookManager.execute(
          'session:ready',
          { phone, pushName },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        // Reset reconnect attempts on successful connection
        const reconnectState = this.reconnectStates.get(id);
        if (reconnectState) {
          reconnectState.attempts = 0;
        }

        void this.sessionRepository.update(id, {
          status: SessionStatus.READY,
          phone,
          pushName,
          connectedAt: new Date(),
          lastActiveAt: new Date(),
        });
      },
      onMessage: (message): void => {
        this.logger.debug(`Message received from ${message.from}`, {
          sessionId: id,
          messageId: message.id,
          from: message.from,
          action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() });
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
              // Plugin stopped processing (e.g., auto-reply handled it)
              return;
            }

            // Enrich message with phone number from contact (for legacy ID resolution)
            // This converts '162878178984075@lid' to actual phone number
            if (!message.fromMe) {
              try {
                const engine = this.engines.get(id);
                if (engine) {
                  const contact = await engine.getContactById(message.from);
                  if (contact && contact.number) {
                    (finalMessage as Record<string, unknown>).phoneNumber = contact.number;
                    this.logger.debug(`Enriched message with phone: ${contact.number}`, {
                      sessionId: id,
                      from: message.from,
                    });
                  }
                }
              } catch (error) {
                this.logger.warn(`Failed to enrich message with phone number: ${error}`, {
                  sessionId: id,
                  from: message.from,
                });
              }
            }

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.received', finalMessage as Record<string, unknown>);
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage as Record<string, unknown>);
          });
      },
      onDisconnected: (reason: string): void => {
        this.logger.warn(`Session disconnected: ${reason}`, {
          sessionId: id,
          reason,
          action: 'disconnected',
        });
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

  /**
   * Ask WhatsApp to start reporting a chat's presence. Updates arrive as `presence.update` events;
   * there is no synchronous answer to give here, because presence cannot be queried from either
   * library — only received.
   *
   * The subscription belongs to the connection, so it does not survive a restart or an automatic
   * reconnect and has to be re-issued. That is the engine's contract, not a gateway choice, and the
   * API documents it rather than pretending otherwise by silently replaying subscriptions.
   */
  async subscribeToPresence(id: string, chatId: string): Promise<void> {
    await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.subscribeToPresence(chatId);
  }

  /**
   * Publish the account's own global presence (appear online/offline). Connection-scoped: the
   * setting resets on reconnect, so callers re-issue it after `session.status` reports one.
   */
  async setOnlinePresence(id: string, available: boolean): Promise<void> {
    await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.setOnlinePresence(available);
  }

  /**
   * The last presence WhatsApp reported for a chat, or null when none has been — either because the
   * chat was never subscribed, or because nothing has changed since the subscription was made.
   * Deliberately not an error: "nothing reported yet" is a normal state, not a missing resource.
   */
  async getPresence(id: string, chatId: string): Promise<ChatPresence | null> {
    await this.findOne(id);
    return this.presence.get(id, chatId);
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

  /**
   * Delete every message in a chat, keeping the chat itself. Resolves false when the engine could
   * not act — an unknown chat, or on Baileys a chat with no known history to key the change to.
   */
  async clearChatMessages(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.clearChatMessages(chatId);
  }

  /**
   * Archive or unarchive a chat. Resolves false when the engine could not act — on Baileys a chat
   * with no known history has no last message to key the app-state modification to. That is a
   * defined outcome, not an error, so it is reported as `success: false` rather than a 500.
   */
  async archiveChat(id: string, chatId: string, archive: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.archiveChat(chatId, archive);
  }

  /**
   * Mute a chat until `muteUntil` (absolute epoch milliseconds), or unmute it with `null`. Unlike
   * archiveChat there is no "engine declined" outcome — the Baileys mute patch is not keyed to the
   * chat's last message — so this resolves void and a failure surfaces as an error.
   */
  async muteChat(id: string, chatId: string, muteUntil: number | null): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.muteChat(chatId, muteUntil);
  }

  /**
   * Pin or unpin a chat. Resolves false only when the engine declined — whatsapp-web.js reports
   * WhatsApp's three-pin cap; Baileys cannot see it and always resolves true.
   */
  async pinChat(id: string, chatId: string, pin: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    return engine.pinChat(chatId, pin);
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
   * Stop engines for session ids whose DB row is about to be replaced by an infra import.
   * Owned by the lifecycle service; see SessionEngineLifecycle.stopOrphanEngines().
   */
  async stopOrphanEngines(
    sessionIds: string[],
  ): Promise<{ stopped: string[]; notRunning: string[]; failed: string[] }> {
    return this.engineLifecycle.stopOrphanEngines(sessionIds);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
