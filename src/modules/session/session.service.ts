import {
  BadGatewayException,
  HttpException,
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
import {
  Repository,
  In,
  Not,
  IsNull,
  LessThan,
  LessThanOrEqual,
  DataSource,
  FindManyOptions,
  FindOptionsWhere,
  Raw,
} from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { setTimeout } from 'node:timers/promises';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { Session, SessionStatus } from './entities/session.entity';
import {
  CreateSessionDto,
  SessionConfigResponseDto,
  UpdateSessionConfigDto,
  SessionProxyResponseDto,
  SessionResponseDto,
  UpdateSessionProxyDto,
  projectSessionProxy,
} from './dto';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore, type ChatPresence } from './presence-store.service';
import {
  SessionEngineLifecycle,
  resolveMaxConcurrentSessions,
  resolveReconnectConfig,
} from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';
import { paginate, ListOptions, resolveListWindow } from '../../common/utils/paginate';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { IWhatsAppEngine, ChatSummary, ChatState } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { HookManager } from '../../core/hooks';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { Message } from '../message/entities/message.entity';
import { ServerShuttingDownException, SessionStoppedException } from './session-engine-controls';
// Type-only: the module binds this class to PLUGIN_SESSION_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type { PluginSessionPort } from '../../core/plugins/plugin-host-ports';

/** Stagger before the single transient-launch retry; short - the claim is held while it waits. */
const SESSION_START_RETRY_DELAY_MS = 2_000;

/**
 * A launch failure worth one retry: infrastructure said "not now" (a 5xx, a transport death, a
 * database error while persisting status), not the session or the caller being refused. HTTP 4xx
 * and the documented 409 not-ready are deliberate answers, and a lost-claim ConflictException is a
 * real conflict.
 */
function isTransientLaunchFailure(error: unknown): boolean {
  // EngineTransportError (503) is the one mapped HTTP shape that means infrastructure died
  // mid-launch (dead page/socket at initialize). Every OTHER HttpException is a deliberate
  // answer: the 409 not-ready family reflects session state, the 504 auth-timeout family
  // reflects the account/proxy, and a 4xx is a refusal. The explicit early-exit (not a message
  // regex relying on the 504 texts never containing 'connection') pins that intent.
  if (error instanceof EngineTransportError) return true;
  if (error instanceof HttpException) return false;
  // TypeORM QueryFailedError and driver errors carry no HttpException shape.
  return error instanceof Error && isTransientDbError(error);
}

/** Pause between sequential auto-start launches so a burst of Chromium boots does not spike the host. */
export const AUTOSTART_THROTTLE_MS = 2_000;

/**
 * How long shutdown waits for the auto-start run once the engines are destroyed. Short: the webhook
 * drain, worker close, usage flush, plugin phase, releaseAll and the HTTP and database close still have
 * to fit the kill deadline (see shutdown-budget.ts).
 */
export const AUTOSTART_SHUTDOWN_WAIT_MS = 5_000;

/** List window for {@link SessionService.findAll}, plus an optional exact session-name filter. */
export interface SessionListOptions extends ListOptions {
  name?: string;
}

/**
 * Statuses that assert an engine is running somewhere. The boot reset clears them for every row this
 * node may claim; markLapsedDisconnected clears them for a row whose holder never came back, a
 * QR_READY row only while it has no phone. FAILED and CREATED stay out of both: an operator has to
 * see them.
 */
const ACTIVE_STATUSES = [
  SessionStatus.READY,
  SessionStatus.INITIALIZING,
  SessionStatus.QR_READY,
  SessionStatus.AUTHENTICATING,
  SessionStatus.ACTION_REQUIRED,
];

/**
 * The session-record API: CRUD over the sessions table, aggregate stats, and the thin engine query
 * proxies (QR/pairing/chats/groups/chat-state) behind the controller routes. Every engine LIFECYCLE
 * verb (start/stop/logout/forceKill/delete/stopOrphanEngines), the reconnect machinery, the engine
 * event wiring, and the status broadcast live in SessionEngineLifecycle — the sole writer of the
 * shared EngineRegistry. This service delegates those verbs one-directionally (no forwardRef), so
 * its public surface toward the controller and the feature modules is unchanged by the split.
 */
@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap, PluginSessionPort {
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
  /**
   * stop()/delete() requests per session, counted so the transient start retry can tell a stop issued
   * after it began from a mark left over by an earlier stop, which start() clears by design.
   */
  private readonly stopRequests = new Map<string, number>();
  /**
   * Starts past start()'s cap check, held until they return. That check counts them with the
   * engine's slot holders, so two starts at the last free slot cannot both pass it while their claims
   * are awaited. hasStartCapacity() does not: a held start whose claim then fails never used a slot.
   * getActiveSessionIds() does, so the import pre-flight sees a start waiting on its claim or in its
   * retry pause, when the engine holds no slot for it; every start is held for that reason, capped
   * or not.
   */
  private readonly startReservations = new Map<string, number>();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineRegistry: EngineRegistry,
    private readonly watchdog: SessionLivenessWatchdog,
    private readonly sessionErrors: SessionErrorStore,
    private readonly sessionRestrictions: SessionRestrictionStore,
    private readonly presence: PresenceStore,
    private readonly hookManager: HookManager,
    private readonly engineLifecycle: SessionEngineLifecycle,
    private readonly lidMappingStore: LidMappingStoreService,
    @Optional()
    private readonly configService?: ConfigService,
    // Trailing @Optional, like configService: the running app always provides it, while the
    // direct-construction unit tests omit it — every use below is `?.`-guarded, so a session simply
    // behaves as unowned there, which is what a single-process deployment is anyway.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    // The drain signal, set when shutdown begins and SHUTDOWN_DELAY_MS before onModuleDestroy. Same
    // source the reconnect scheduler and the takeover sweep consult.
    @Optional()
    private readonly shutdownService?: ShutdownService,
  ) {}

  /**
   * True from the start of the shutdown drain. An engine launched during the drain would be torn
   * down seconds later by onModuleDestroy, so starts are refused from here, not from teardown.
   */
  private get stopping(): boolean {
    return this.shuttingDown || this.shutdownService?.isShuttingDown() === true;
  }

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
    const claimable = this.ownership?.claimableWhere() ?? [{}];
    const result = await this.sessionRepository.update(
      claimable.map(clause => ({ ...clause, status: In(ACTIVE_STATUSES) })),
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
    // Nobody is waiting on this teardown, so an engine that could not be stopped (destroy and its
    // forceDestroy escalation both failed) is reported here at error level: it is out of the Map, so
    // force-kill cannot reach it, and a peer may run a second engine on the account until restart.
    this.ownership?.onLeaseLoss(async ids => {
      const { failed } = await this.engineLifecycle.stopOrphanEngines(ids);
      if (failed.length > 0) {
        this.logger.error(
          'Engine teardown failed after lease loss; a peer may run a second engine on the same account until this process restarts',
          undefined,
          { sessionIds: failed, action: 'lease_loss_teardown_failed' },
        );
      }
    });
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
    // Every probe in that window is a connection refusal, and no probe budget can cover a bound that
    // scales with the session count: the chart's startupProbe budget (statefulset.yaml), which governs
    // boot, is a fixed number of seconds, and the Dockerfile HEALTHCHECK encodes the same expectation.
    // Awaited on shutdown so a launch in flight is accounted for.
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
    // A session an operator stopped (desiredState 'stopped') stays down until an explicit start.
    const claimable = this.ownership?.claimableWhere() ?? [{}];
    const sessions = await this.sessionRepository.find({
      where: claimable.map(clause => ({
        ...clause,
        phone: Not(IsNull()),
        status: SessionStatus.DISCONNECTED,
        desiredState: IsNull(),
      })),
    });

    if (sessions.length === 0) return;

    this.logger.log(`Auto-starting ${sessions.length} previously authenticated session(s)`, {
      action: 'auto_start',
      count: sessions.length,
    });

    for (let i = 0; i < sessions.length; i++) {
      // A shutdown landing mid-run must not launch anything further: onModuleDestroy tears down what
      // exists, and a browser launched after that point is never destroyed.
      if (this.stopping) {
        this.logger.log(`Auto-start stopped at ${i} of ${sessions.length} session(s): shutting down`, {
          action: 'auto_start_aborted',
        });
        return;
      }
      // Every start past the cap is refused, so going on would only log one failure per row.
      const max = resolveMaxConcurrentSessions(this.configService);
      if (max !== null && !this.hasStartCapacity(max)) {
        this.logger.log(
          `Auto-start stopped at ${i} of ${sessions.length} session(s): MAX_CONCURRENT_SESSIONS reached`,
          { action: 'auto_start_capacity_reached', max },
        );
        return;
      }
      const session = sessions[i];
      try {
        await this.start(session.id);
        // A launch shutdown tore down mid-init is refused with ServerShuttingDownException (caught
        // below). One already past the engine's post-init checks resolves, but shutdown can still
        // destroy its engine during the start's last row read or its claim bookkeeping, so
        // nothing is left running.
        if (this.shuttingDown && !this.isActive(session.id)) {
          this.logger.log(`Auto-start abandoned for session ${session.name}: shutting down`, {
            sessionId: session.id,
            action: 'auto_start_aborted',
          });
          return;
        }
        this.logger.log(`Auto-started session: ${session.name}`, {
          sessionId: session.id,
          action: 'auto_start_success',
        });
      } catch (error: unknown) {
        if (error instanceof SessionStoppedException) {
          // Stopped after the scan read it; the start refused it, as it should.
          this.logger.log(`Auto-start skipped for session ${session.name}: stopped by an operator`, {
            sessionId: session.id,
            action: 'auto_start_skipped',
          });
        } else if (error instanceof ServerShuttingDownException) {
          // The launch in flight when shutdown began, refused so nothing outlives the teardown.
          this.logger.log(`Auto-start abandoned for session ${session.name}: shutting down`, {
            sessionId: session.id,
            action: 'auto_start_aborted',
          });
          // Nothing later in the run would start either, and shutdown waits on this loop.
          return;
        } else {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.logger.error(`Auto-start failed for session: ${session.name}`, errorMessage, {
            sessionId: session.id,
            action: 'auto_start_failed',
          });
        }
      }
      // Throttle between sequential Chromium launches; no need to wait after the last one.
      // Skipped once shutdown began: onModuleDestroy awaits this loop, and the check above ends it.
      if (i < sessions.length - 1 && !this.stopping) {
        await setTimeout(AUTOSTART_THROTTLE_MS);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Stop the watchdog FIRST (before any teardown below can hang): no new probe/disconnect handling
    // may start mid-shutdown. stop() is idempotent, so a second onModuleDestroy call stays safe.
    this.shuttingDown = true;
    this.watchdog.stop();
    this.ownership?.stopHeartbeat();
    // Reconnect timers + engine teardown belong to the lifecycle owner. Run before waiting on the
    // detached auto-start: a launch it has in flight already registered its engine, so this destroys
    // it and the run unwinds. Waiting first would let a stalled init (an unreachable WhatsApp Web, a
    // proxy that never answers) hold the teardown until its init deadline, past the kill deadline.
    await this.engineLifecycle.shutdown();
    // The lifecycle is closed now, so the run registers no further engine; awaited so its claim
    // release and status writes land before releaseAll and the database close. Bounded: a
    // whatsapp-web.js launch still starting Chromium has no browser handle yet, so the destroy
    // closes nothing and that init runs until whatsapp-web.js settles it, at worst to the init
    // deadline. Past the bound, its browser is left to Puppeteer's exit hook.
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      this.autoStartRun.then(() => true),
      new Promise<false>(resolve => (timer = globalThis.setTimeout(resolve, AUTOSTART_SHUTDOWN_WAIT_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn(`Auto-start still launching after ${AUTOSTART_SHUTDOWN_WAIT_MS}ms; shutting down without it`, {
        action: 'auto_start_shutdown_timeout',
      });
    }
    // Released only after the engines are actually down, so a peer never claims a session this
    // process is still holding open. A start still in flight may own a browser the teardown could
    // not reach (one the bound above gave up on), so its claim is kept and lapses as after a hard kill.
    await this.ownership?.releaseAll(this.startReservations.keys());
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
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Session with name '${dto.name}' already exists`);
      }
      throw err;
    }
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O). Plugins get
    // the session as the REST API returns it, not the entity: the entity carries proxyUrl (credentials
    // allowed) and the config blob, which no response ever exposes.
    await this.hookManager.execute('session:created', SessionResponseDto.fromEntity(saved, this.isActive(saved.id)), {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(allowedSessions?: string[] | null, opts: SessionListOptions = {}): Promise<Session[]> {
    // A session-restricted key only lists its own sessions; an unrestricted key (null/empty
    // allowlist) lists all — mirroring the ApiKeyGuard allowedSessions model so a scoped key
    // cannot enumerate every session through this aggregate route.
    const { limit, offset } = resolveListWindow(opts.limit, opts.offset);
    // `id` tiebreaks the second-resolution `createdAt` so a paged walk has a total order.
    const options: FindManyOptions<Session> = {
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    };
    const where: FindOptionsWhere<Session> = {};
    if (allowedSessions && allowedSessions.length > 0) {
      where.id = In(allowedSessions);
    }
    // Exact, case-sensitive match. Only a non-empty string reaches TypeORM: anything else (an
    // array from a repeated query key, an empty value) is not a name and must not become one.
    if (typeof opts.name === 'string' && opts.name.length > 0) {
      where.name = opts.name;
    }
    if (Object.keys(where).length > 0) {
      options.where = where;
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
    // Compare-and-swap on the stored text: the write lands only while the column still holds the blob
    // this request merged into, so two overlapping PATCHes cannot both start from the same blob and
    // have the later write drop the earlier one's keys. A request that lost the race reads again.
    for (let attempt = 1; ; attempt++) {
      // The raw text rather than the parsed entity, so the comparison is exact whatever wrote the row.
      const row = await this.sessionRepository
        .createQueryBuilder('session')
        .select('session.config', 'config')
        .where('session.id = :id', { id })
        .getRawOne<{ config: string | null }>();
      if (!row) {
        throw new NotFoundException(`Session with id '${id}' not found`);
      }
      const stored = row.config;
      const config = { ...((stored ? JSON.parse(stored) : null) as Record<string, unknown> | null) };

      for (const key of ['autoRejectCalls', 'maxReconnectAttempts', 'reconnectBaseDelay'] as const) {
        const value = dto[key];
        if (value === undefined) continue;
        if (value === null) {
          delete config[key];
        } else {
          config[key] = value;
        }
      }

      // update() with an explicit object rather than save() on an entity: only the config column is
      // written, never the rest of the row from a snapshot taken before this await.
      const { affected } = await this.sessionRepository.update(
        { id, config: Raw(column => (stored === null ? `${column} IS NULL` : `${column} = :stored`), { stored }) },
        { config: config as QueryDeepPartialEntity<Record<string, unknown>> },
      );
      if (affected !== 0) {
        return this.projectConfig(config);
      }
      if (attempt >= 5) {
        throw new ConflictException('Session config is being changed by other requests; retry');
      }
    }
  }

  async getProxy(id: string): Promise<SessionProxyResponseDto> {
    const session = await this.findOne(id);
    return projectSessionProxy(session);
  }

  /**
   * Persist per-session proxy settings. No engine restart — proxy is read at initializeEngine() on
   * the next start(), matching the reconnect settings on PATCH /config.
   */
  async updateProxy(id: string, dto: UpdateSessionProxyDto): Promise<SessionProxyResponseDto> {
    const session = await this.findOne(id);

    if (dto.proxyUrl === null) {
      await this.sessionRepository.update(id, { proxyUrl: null, proxyType: null });
      return projectSessionProxy({ proxyUrl: null });
    }

    if (dto.proxyUrl !== undefined) {
      await this.sessionRepository.update(id, { proxyUrl: dto.proxyUrl, proxyType: null });
      return projectSessionProxy({ proxyUrl: dto.proxyUrl });
    }

    return projectSessionProxy(session);
  }

  /** Record removal + engine retirement + credential purge: owned by the lifecycle service. */
  async delete(id: string): Promise<void> {
    // Set the tearing-down mark SYNCHRONOUSLY, before the ownership fence's awaited query. The
    // pre-initialize retirement race needs this mark visible to an in-flight start()'s
    // post-INITIALIZING check by the time that write settles; awaiting anything first — the fence's
    // COUNT, or delete()'s own requireSession — would let the mark land after that window. A mark
    // left behind when the fence refuses (409) is harmless and is cleared by the next start().
    this.markStopping(id);
    try {
      if (this.ownership) await this.assertNotHeldElsewhere(id);
      // A failed row read deleted nothing: the lifecycle drops the mark, and the count goes with it.
      await this.engineLifecycle.delete(id, { onReadFailed: () => this.uncountStopRequest(id) });
      await this.ownership?.release(id);
      this.stopRequests.delete(id);
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
   *
   * The request count set on the same tick is dropped with it, and for the same reason: its only
   * reader is the transient start retry, which cannot be guarding a session that has no row, so
   * an id that never had one would otherwise keep a counter entry for the life of the process.
   */
  private discardStopMarkForMissingSession(id: string, error: unknown): void {
    if (!(error instanceof NotFoundException)) return;
    this.engineLifecycle.clearStopping(id);
    this.stopRequests.delete(id);
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
    // Both callers count the request and set the stop mark before this query. The MARK survives a
    // 409 (harmless, cleared by the next start()) but not a failed query: that decided nothing, and
    // a mark left on a session running here would stop its next disconnect from reconnecting.
    // Neither refusal keeps its COUNT. Nothing was taken down, and the count exists only so an
    // in-flight start()'s transient retry can tell a stop that happened from one that did not;
    // counting a refusal cancels that retry and leaves the session down with nothing to restart it.
    const heldElsewhere = await this.ownership?.isHeldByOtherNode(id).catch((error: unknown) => {
      this.engineLifecycle.clearStopping(id);
      this.uncountStopRequest(id);
      throw error;
    });
    if (heldElsewhere) {
      this.uncountStopRequest(id);
      throw new ConflictException(`Session ${id} is running on another node`);
    }
  }

  /**
   * `explicit` marks an operator's POST /start: only that clears a stop (desiredState), and only once
   * the engine start is past its refusals. Boot auto-start and the takeover sweep never clear it, and
   * the engine start refuses them a row still marked stopped when it reads it.
   */
  async start(id: string, { explicit = false }: { explicit?: boolean } = {}): Promise<Session> {
    // Refused before the claim, the stop clear and the session:starting hook: none of them should run
    // for a start the exiting process will not keep.
    this.refuseIfShuttingDown();
    // At the cap, refused before the claim: the engine's own cap check runs after it, and its
    // refusal releases the claim to no node. A row nobody holds is never adopted by a peer, while a
    // lapsed lease left where it is gets taken over by one with room. The engine check stays the
    // authoritative one; this only keeps a refusal off the lease. A start that passes holds its slot
    // until it returns, so a concurrent start cannot pass on the same free slot during the claim.
    const max = resolveMaxConcurrentSessions(this.configService);
    if (this.ownership && max !== null) {
      const holders = this.startSlotsInUse();
      holders.delete(id);
      if (holders.size >= max) {
        // Same answer the failed claim below would give, so the cap does not mask a 404 or a 409.
        await this.findOne(id);
        if (await this.ownership.isHeldByOtherNode(id)) {
          throw new ConflictException(`Session ${id} is running on another node`);
        }
        throw new BadRequestException(`Maximum concurrent sessions reached (${max})`);
      }
    }
    // Counted per start, so a duplicate start of the same id keeps the reservation after the first returns.
    this.startReservations.set(id, (this.startReservations.get(id) ?? 0) + 1);
    try {
      return await this.claimAndStart(id, explicit);
    } finally {
      const left = (this.startReservations.get(id) ?? 1) - 1;
      if (left > 0) this.startReservations.set(id, left);
      else this.startReservations.delete(id);
    }
  }

  private refuseIfShuttingDown(): void {
    if (this.stopping) throw new ServerShuttingDownException();
  }

  private async claimAndStart(id: string, explicit: boolean): Promise<Session> {
    // Read before the claim, so a stop that lands while the claim is pending counts against this start.
    const stopRequestsBefore = this.stopRequests.get(id);
    // Claimed before the engine is launched, never after: launching first and discovering the
    // session belongs elsewhere would already have opened a second connection to the account.
    if (this.ownership && !(await this.ownership.claim(id))) {
      // The claim is a conditional UPDATE, so an id that does not exist also matches zero rows —
      // surface the route's documented 404 for that case instead of a misleading 409.
      await this.findOne(id);
      throw new ConflictException(`Session ${id} is running on another node`);
    }
    let session: Session;
    try {
      session = await this.startWithTransientRetry(id, explicit, stopRequestsBefore);
    } catch (error) {
      await this.keepDownIfStoppedDuringStart(id, explicit, stopRequestsBefore);
      // A failed or refused start must not leave the claim pinned here — the heartbeat would renew
      // it and the session could never be started anywhere else. Released only when nothing is
      // actually alive locally: an "already starting/started" refusal means this node genuinely
      // runs the engine, and releasing then would invite a peer to open a second connection.
      await this.releaseUnlessEngineActive(id);
      throw error;
    }
    await this.keepDownIfStoppedDuringStart(id, explicit, stopRequestsBefore);
    // A start retired by a concurrent stop() resolves normally but leaves no engine, and that stop
    // skipped its release while this start still held the session. Hand the claim back here, or the
    // row keeps naming this node until the lease lapses and a peer adopts the stopped session.
    await this.releaseUnlessEngineActive(id);
    return session;
  }

  /**
   * One bounded retry for a TRANSIENT launch failure (a database hiccup while persisting the
   * initial status, a transport blip while the adapter boots). A transient failure during adopt or
   * boot auto-start used to release the claim and end the story: nothing ever retried, so the
   * session stayed down until some process restarted. The retry keeps the claim held (the outer
   * catch only runs when this gives up), and re-claims it if the retry window outlived the lease -
   * a lapsed claim must not turn the retry into a 409.
   *
   * Bounded to one retry on a short stagger: a persistent failure is a real fault, and an
   * unbounded loop here would hold the concurrency slot hostage. HTTP-shaped refusals (409
   * not-ready, 4xx) are NOT transient - they propagate immediately.
   */
  private async startWithTransientRetry(
    id: string,
    explicit: boolean,
    stopRequestsBefore: number | undefined,
  ): Promise<Session> {
    // A stop that finished during the claim answered 200 and left the claim to this start; the engine's own
    // stop-mark check cannot tell its mark from a stale one, so the start is refused here.
    if (this.stopRequests.get(id) !== stopRequestsBefore) {
      throw new SessionStoppedException(`Session ${id} was stopped`);
    }
    // Shutdown may have begun while the claim was pending; the stop clear and the hook must not run.
    this.refuseIfShuttingDown();
    try {
      return await this.engineLifecycle.start(id, { explicit });
    } catch (error) {
      if (!isTransientLaunchFailure(error)) throw error;
      this.logger.warn(`Transient launch failure for session ${id}; retrying once`, {
        sessionId: id,
        action: 'session_start_transient_retry',
        error: error instanceof Error ? error.message : String(error),
      });
      await setTimeout(SESSION_START_RETRY_DELAY_MS);
      // Retrying would bring back a session that a stop() issued since this start began just took
      // down. A mark alone does not prove that: an earlier stop's mark survives until start() clears
      // it, and a first attempt failing before that point would otherwise lose its retry. Answered
      // as the stop it yielded to, like the check above: a 503 reads as retryable, and a client that
      // replays the start would bring the session back.
      if (this.stopRequests.get(id) !== stopRequestsBefore) {
        throw new SessionStoppedException(`Session ${id} was stopped`);
      }
      try {
        // Shutdown may have released this node's claims during the delay; re-claiming would pin the row.
        this.refuseIfShuttingDown();
        // The lease may have lapsed while the first attempt ran; the retry must keep holding the
        // claim, never 409 on the session it already owns.
        if (this.ownership && !(await this.ownership.claim(id))) {
          await this.findOne(id);
          throw new ConflictException(`Session ${id} is running on another node`);
        }
        // Checked again: a stop that landed during the re-claim leaves the claim for claimAndStart's catch to release.
        if (this.stopRequests.get(id) !== stopRequestsBefore) {
          throw new SessionStoppedException(`Session ${id} was stopped`);
        }
        // And shutdown may have begun during the re-claim; the stop clear and the hook must not run.
        this.refuseIfShuttingDown();
        return await this.engineLifecycle.start(id, { explicit });
      } catch (retryError) {
        // The first attempt may have left FAILED, which the boot reset, auto-start and the takeover
        // sweep all skip, and shutdown refused the retry that would have overwritten it. Handed back
        // as DISCONNECTED so the next boot restores the session. Best-effort: the refusal is the answer.
        // Fenced like the boot reset: a FAILED on a row a peer has since adopted is the peer's.
        if (retryError instanceof ServerShuttingDownException) {
          const claimable = this.ownership?.claimableWhere() ?? [{}];
          await this.sessionRepository
            .update(
              claimable.map(clause => ({ ...clause, id, status: SessionStatus.FAILED })),
              { status: SessionStatus.DISCONNECTED },
            )
            .catch(() => undefined);
        }
        throw retryError;
      }
    }
  }

  async stop(id: string): Promise<Session> {
    // Synchronous stop-mark before the awaited fence — see delete() for why.
    this.markStopping(id);
    let session: Session;
    try {
      if (this.ownership) await this.assertNotHeldElsewhere(id);
      // Recorded once the row read succeeds and BEFORE the teardown, so the 502
      // SESSION_STOP_INCOMPLETE path keeps it too: a stopped session stays down across restarts and
      // takeover until an explicit start. A failed write took nothing down, so the mark and count are
      // undone as for a failed ownership read; a failed read took nothing down either, and the
      // lifecycle has already dropped the mark, so only the count is undone.
      session = await this.engineLifecycle.stop(id, {
        afterRead: () =>
          this.keepDown(id).catch((error: unknown) => {
            this.engineLifecycle.clearStopping(id);
            this.uncountStopRequest(id);
            throw error;
          }),
        onReadFailed: () => this.uncountStopRequest(id),
      });
    } catch (error) {
      // Only the local 502 (SESSION_STOP_INCOMPLETE) releases: it evicted the engine and wrote
      // DISCONNECTED, and a claim left to lapse still names this node, so a peer's takeover sweep
      // would adopt the row and start the session the operator just stopped. A released claim is
      // not adopted. The foreign-node 409 keeps its claim (it is the peer's), and so does a 404.
      if (error instanceof BadGatewayException) await this.releaseAfterTeardown(id);
      this.discardStopMarkForMissingSession(id, error);
      throw error;
    }
    // Handed back on the way out so a peer can pick it up immediately rather than waiting for the
    // lease to lapse. Stop is the deliberate end of this process's ownership — but a start() that
    // is still mid-launch or still waiting on its claim owns the claim now, so the same guard the
    // failure paths use applies here: releasing under an in-flight start would leave a live engine
    // on an unclaimed row that no heartbeat renews and any peer may start a second time.
    await this.releaseAfterTeardown(id);
    return session;
  }

  /** See SessionEngineLifecycle.logout() for the full unlink/502 contract. */
  async logout(id: string): Promise<Session> {
    try {
      const session = await this.engineLifecycle.logout(id);
      // Torn down locally on the 200 path — hand the claim back the way stop() does.
      await this.releaseAfterTeardown(id);
      return session;
    } catch (error) {
      // The 502-incomplete path tears the engine down, so its claim must not survive the call. A 400
      // "not started" refusal changed nothing and keeps whatever claim there is: release() also
      // clears a LAPSED foreign claim, which would take a crashed node's session out of takeover.
      if (!(error instanceof BadRequestException)) await this.releaseAfterTeardown(id);
      throw error;
    }
  }

  async forceKill(id: string): Promise<Session> {
    // Counted like stop(), so a start still waiting on its claim yields rather than relaunching, but
    // only while there is an engine to kill: at once if one runs, so a start sent after the kill keeps
    // its place, otherwise once the kill finds one. A kill that took nothing down (a 400, a 404 or a
    // failed row read) is uncounted, so it cannot retire a start that is still waiting on its claim.
    let counted = false;
    const count = (): void => {
      if (counted) return;
      counted = true;
      this.countStopRequest(id);
    };
    const uncount = (): void => {
      if (!counted) return;
      counted = false;
      this.uncountStopRequest(id);
    };
    if (this.engines.get(id)) count();
    try {
      // The engine kill records the stop itself, once it has an engine to kill.
      const session = await this.engineLifecycle.forceKill(id, { onReadFailed: uncount, onEngineFound: count });
      await this.releaseAfterTeardown(id);
      return session;
    } catch (error) {
      // The 400 "not started" also keeps its claim as in logout(). The 502 did evict the engine: it
      // stays counted and releases.
      if (error instanceof BadRequestException) uncount();
      if (!(error instanceof BadRequestException)) await this.releaseAfterTeardown(id);
      throw error;
    }
  }

  /** Persist the operator's stop so boot auto-start and the takeover sweep leave the session down. */
  private async keepDown(id: string): Promise<void> {
    await this.sessionRepository.update(id, { desiredState: 'stopped' });
  }

  /**
   * Re-record a stop an explicit start may have erased. The start clears the stop record with a
   * write conditional on the row still reading 'stopped', and a stop's own write leaves that value
   * unchanged, so a stop landing just before the clear was wiped from the row while its in-memory
   * mark retired the start. The session was down, but the next boot would relaunch it. Any stop
   * counted while the start ran and leaving no engine behind is the operator's last word. A failed
   * write is logged rather than thrown: the start's own outcome still stands.
   */
  private async keepDownIfStoppedDuringStart(
    id: string,
    explicit: boolean,
    stopRequestsBefore: number | undefined,
  ): Promise<void> {
    const stoppedMeanwhile = this.stopRequests.get(id) !== stopRequestsBefore;
    if (!explicit || !stoppedMeanwhile || this.engineLifecycle.isEngineActive(id)) return;
    await this.keepDown(id).catch((error: unknown) =>
      this.logger.error(
        'Failed to record a stop that landed during a start',
        error instanceof Error ? error.message : String(error),
        { sessionId: id, action: 'start_keep_down_failed' },
      ),
    );
  }

  private markStopping(id: string): void {
    this.countStopRequest(id);
    this.engineLifecycle.markStopping(id);
  }

  private countStopRequest(id: string): void {
    this.stopRequests.set(id, (this.stopRequests.get(id) ?? 0) + 1);
  }

  /**
   * Undo markStopping()'s count for a request that took nothing down, and drop the entry once the
   * count is back to zero so ids that are only ever refused cannot accumulate. Decrementing rather
   * than deleting keeps a concurrent stop that DID take effect counted: it leaves the value one
   * above what an in-flight start captured either way, so the retry it must cancel stays cancelled.
   */
  private uncountStopRequest(id: string): void {
    const remaining = (this.stopRequests.get(id) ?? 0) - 1;
    if (remaining > 0) this.stopRequests.set(id, remaining);
    else this.stopRequests.delete(id);
  }

  /**
   * The claim release for an operator teardown (stop, logout, force-kill). A start() of the same id
   * that is still waiting on its claim owns it, though nothing runs here yet for the engine check to
   * see: releasing would leave the engine it is about to launch on a row no node holds. That start
   * hands the claim back itself if it yields or fails.
   */
  private async releaseAfterTeardown(id: string): Promise<void> {
    if (this.startReservations.has(id)) return;
    await this.releaseUnlessEngineActive(id);
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
    const engine = this.engines.require(
      id,
      () => new BadRequestException('Session is not started. Call POST /sessions/:sessionId/start first.'),
    );

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
    const engine = this.engines.require(
      id,
      () => new BadRequestException('Session is not started. Call POST /sessions/:sessionId/start first.'),
    );
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
   * The engine for a started session, or the documented 400. Routes through engines.require's
   * default onMissing so the wire contract stays byte-identical to the hand-rolled guards this
   * replaces ('Session is not started', exactly as each API surface documented it).
   */
  private requireEngine(id: string): IWhatsAppEngine {
    return this.engines.require(id);
  }

  /** Every group for a session WITHOUT the response window, for callers that filter before paging. */
  async listGroups(id: string): Promise<{ id: string; name: string; linkedParentJID?: string | null }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
      linkedParentJID: g.linkedParentJID,
    }));
  }

  /**
   * Every chat for a session, most-recent first, WITHOUT the response window. Callers that must
   * filter before paging (a chat-restricted API key) use this, then paginate themselves: filtering
   * after paginate() would hand back short or empty pages for an allowed chat past the window.
   */
  async listChats(id: string): Promise<ChatSummary[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    // Most-recent first. Sorting before the cap means a capped response is the N newest chats (what
    // clients show first) rather than an arbitrary slice.
    return [...(await engine.getChats())].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  async getChats(id: string, opts: ListOptions = {}): Promise<ChatSummary[]> {
    return paginate(await this.listChats(id), opts.limit, opts.offset);
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
    const engine = this.requireEngine(id);

    return engine.subscribeToPresence(chatId);
  }

  /**
   * Publish the account's own global presence (appear online/offline). A successful call is
   * remembered for the life of this engine and re-applied once each time the connection opens.
   * The intent is stored only after the publish succeeds, so a refusal (Baileys has no push name
   * yet) does not get replayed as if the caller had been told it applied.
   */
  async setOnlinePresence(id: string, available: boolean): Promise<void> {
    await this.findOne(id);
    const engine = this.requireEngine(id);
    await engine.setOnlinePresence(available);
    this.presence.setOwnIntent(id, available);
  }

  /**
   * The last presence WhatsApp reported for a chat, or null when none has been — either because the
   * chat was never subscribed, or because nothing has changed since the subscription was made.
   * Deliberately not an error: "nothing reported yet" is a normal state, not a missing resource.
   */
  async getPresence(id: string, chatId: string): Promise<ChatPresence | null> {
    await this.findOne(id);
    // Presence belongs to a connection: with no engine registered (stopped, logged out, killed or
    // failed) whatever was last reported is no longer current.
    if (!this.engines.has(id)) return null;
    return this.presence.get(id, chatId);
  }

  async sendSeen(id: string, chatId: string, messageIds?: string[]): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.sendSeen(chatId, messageIds);
  }

  async markUnread(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.markUnread(chatId);
  }

  /**
   * Delete every message in a chat, keeping the chat itself. Resolves false when the engine could
   * not act — an unknown chat, or on Baileys a chat with no known history to key the change to.
   * On success the gateway's stored copies of the chat's messages are removed too.
   */
  async clearChatMessages(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    const cutoff = new Date();
    const ok = await engine.clearChatMessages(chatId);
    if (ok) await this.purgeStoredChat(id, chatId, cutoff);
    return ok;
  }

  /**
   * Archive or unarchive a chat. Resolves false when the engine could not act — on Baileys a chat
   * with no known history has no last message to key the app-state modification to. That is a
   * defined outcome, not an error, so it is reported as `success: false` rather than a 500.
   */
  async archiveChat(id: string, chatId: string, archive: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.archiveChat(chatId, archive);
  }

  /**
   * Mute a chat until `muteUntil` (absolute epoch milliseconds), or unmute it with `null`. Unlike
   * archiveChat there is no "engine declined" outcome — the Baileys mute patch is not keyed to the
   * chat's last message — so this resolves void and a failure surfaces as an error.
   */
  async muteChat(id: string, chatId: string, muteUntil: number | null): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.muteChat(chatId, muteUntil);
  }

  /**
   * Pin or unpin a chat. Resolves false only when the engine declined — whatsapp-web.js reports
   * WhatsApp's three-pin cap; Baileys cannot see it and always resolves true.
   */
  async pinChat(id: string, chatId: string, pin: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.pinChat(chatId, pin);
  }

  /** Delete a chat. On success the gateway's stored copies of its messages are removed too. */
  async deleteChat(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    const cutoff = new Date();
    const ok = await engine.deleteChat(chatId);
    if (ok) await this.purgeStoredChat(id, chatId, cutoff);
    return ok;
  }

  /**
   * Remove the stored rows of a chat the engine just cleared or deleted, under every id form of the
   * same chat (the GET messages filter's rules), and emit `message:deleted` per row so search
   * providers drop them. The FTS index follows through its delete trigger, archived media through
   * the orphan sweep. Runs only after the engine succeeded; a failure here is logged, not thrown:
   * WhatsApp already applied the change, and repeating the call finishes the purge.
   *
   * Only rows stored before the second `cutoff` (taken before the engine call) falls in go: a busy
   * chat keeps receiving messages while the batches run, and those arrived after the clear and still
   * exist on WhatsApp. The bound stops short of that second because SQLite stores createdAt as whole
   * seconds and compares it as text against a millisecond parameter, so a row stored later in the
   * same second would match. A pre-clear row from that second stays until a repeat call.
   */
  private async purgeStoredChat(sessionId: string, chatId: string, cutoff: Date): Promise<void> {
    const BATCH = 500;
    const bound = new Date(Math.floor(cutoff.getTime() / 1000) * 1000 - 1);
    try {
      const expanded = await resolveJidCandidates(chatId, {
        resolveLid: lid => this.lidMappingStore.findPhoneForLid(lid),
        lidsForPhone: phone => this.lidMappingStore.findLidsForPhone(phone),
      });
      const chatIds = [...new Set([chatId, ...expanded])];
      for (;;) {
        const rows = await this.messageRepository.find({
          where: { sessionId, chatId: In(chatIds), createdAt: LessThanOrEqual(bound) },
          select: { id: true, waMessageId: true, chatId: true, sessionId: true },
          take: BATCH,
        });
        if (rows.length === 0) return;
        await this.messageRepository.delete({ id: In(rows.map(row => row.id)) });
        for (const message of rows) {
          void this.hookManager
            .execute('message:deleted', { sessionId, message }, { sessionId, source: 'SessionService' })
            .catch(() => undefined);
        }
        if (rows.length < BATCH) return;
      }
    } catch (error) {
      this.logger.error(
        'Failed to remove stored messages of a cleared chat',
        error instanceof Error ? error.message : String(error),
        { sessionId, action: 'chat_local_purge_failed' },
      );
    }
  }

  async sendChatState(id: string, chatId: string, state: ChatState): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.sendChatState(chatId, state);
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
   * The response's `engineLoaded`: an engine in this process, or a live claim by a peer node. A list
   * is answered by whichever node the request landed on, while the lifecycle routes are forwarded to
   * the owner, so a session a peer runs must not read as stopped. The local precondition checks keep
   * using {@link isActive}.
   */
  engineLoaded(session: Session): boolean {
    return this.isActive(session.id) || !!this.ownership?.heldByOtherLiveNode(session);
  }

  /**
   * Ids of every session with a live engine — including ones mid-initialization (their engine is not
   * in `engines` yet but will register when start() completes) and ones waiting to relaunch after a
   * failed reconnect (their timer registers one), plus starts still waiting on their claim or in their
   * transient retry pause. The infra import pre-flight uses this to refuse a full-replace restore that
   * would orphan a running engine.
   */
  getActiveSessionIds(): string[] {
    return [...this.startSlotsInUse()];
  }

  /** Whether this node has a MAX_CONCURRENT_SESSIONS slot free, counted exactly as the engine's cap check counts it. */
  hasStartCapacity(max: number): boolean {
    return this.engineLifecycle.startSlotHolders().size < max;
  }

  private startSlotsInUse(): Set<string> {
    return new Set([...this.engineLifecycle.startSlotHolders(), ...this.startReservations.keys()]);
  }

  /**
   * Stop engines for session ids whose DB row is about to be replaced by an infra import.
   * Owned by the lifecycle service; see SessionEngineLifecycle.stopOrphanEngines(). Counted as a
   * stop too, so a start waiting on its claim or in its retry pause launches nothing: the engine's
   * stop mark alone reads as stale to the start that follows.
   */
  async stopOrphanEngines(
    sessionIds: string[],
  ): Promise<{ stopped: string[]; notRunning: string[]; failed: string[] }> {
    for (const id of sessionIds) this.countStopRequest(id);
    return this.engineLifecycle.stopOrphanEngines(sessionIds);
  }

  /**
   * Mark disconnected every session a vanished node left in a running status.
   *
   * A lapsed claim means no process hosts that engine any more: a crashed peer, or this container's
   * own previous identity after a recreate (the default nodeId is the hostname, which a recreate
   * changes). The boot reset cannot touch those rows because it is fenced to what this node may
   * claim, and a row still naming a foreign node on an unexpired lease is not one of them, so
   * without this the row goes on reporting READY for an engine nobody runs. The claim itself is
   * deliberately left in place, so the row stays the adoptable orphan the takeover sweep looks for.
   *
   * `goneBefore` is the caller's "really gone" cutoff, not simply now: a lease lapses while its
   * holder is perfectly healthy whenever a query runs long, and the next heartbeat re-extends it.
   * Acting on a single lapse would report a live peer's sessions as disconnected, and nothing would
   * correct it, because that peer's renewal still finds its own nodeId and detects no loss. The cutoff
   * narrows that case without closing it: a holder cut off from the database for longer than the
   * cutoff is marked too, and does not write its status back once it reconnects.
   */
  async markLapsedDisconnected(sessions: Session[], goneBefore: Date): Promise<string[]> {
    const marked: string[] = [];
    for (const session of sessions) {
      if (!ACTIVE_STATUSES.includes(session.status)) continue;
      // A correction must never change what the takeover sweep adopts. It adopts every other active
      // status anyway: AUTHENTICATING and ACTION_REQUIRED claim a running engine too, and whatever a
      // human was asked to do lived in the engine that died with its node. It never adopts a row
      // without a phone, but it does adopt a DISCONNECTED row with one, so rewriting a QR_READY row
      // that has a phone would launch an engine that only renders a QR nobody asked for. QR_READY is
      // therefore corrected only without a phone, re-checked in the write below in case a pairing
      // completes in between.
      const unlinkedOnly = session.status === SessionStatus.QR_READY;
      if (unlinkedOnly && session.phone != null) continue;
      // Both are guaranteed non-null by the lapsed-claim query that produced these rows, and both are
      // load-bearing in the predicate below. TypeORM throws on a null or undefined where value, so a
      // null here would fail this row's write instead of matching on it.
      if (session.nodeId == null) continue;
      if (session.leaseExpiresAt == null || session.leaseExpiresAt >= goneBefore) continue;
      // Written on the same predicate the read used, never by id alone: a peer, or this node's own
      // adopt loop, can claim and start this row at any moment, and a claim rewrites `nodeId`, so a
      // row that was taken matches nothing here and keeps the status its start gave it.
      let affected: number | undefined;
      try {
        ({ affected } = await this.sessionRepository.update(
          {
            id: session.id,
            nodeId: session.nodeId,
            leaseExpiresAt: LessThan(goneBefore),
            status: session.status,
            ...(unlinkedOnly && { phone: IsNull() }),
          },
          { status: SessionStatus.DISCONNECTED },
        ));
      } catch (error) {
        // One row's failed write must not strand the rows after it. The next sweep retries this one.
        this.logger.warn(`Failed to correct the status session ${session.name} was left in`, {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!affected) continue;
      this.logger.warn(`Session ${session.name} was left ${session.status} by a node that never came back`, {
        sessionId: session.id,
        action: 'lapsed_claim_reset',
        fromNode: session.nodeId,
      });
      // Fan-out only. The row is already written above, under the predicate that makes it safe;
      // going back through updateStatus would re-write it by id and could land on a row a peer has
      // since claimed and started.
      this.engineLifecycle.announceStatus(session.id, SessionStatus.DISCONNECTED);
      marked.push(session.id);
    }
    return marked;
  }
}
