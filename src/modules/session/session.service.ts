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
  ServiceUnavailableException,
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
import { ListingMemo } from '../../common/utils/listing-memo';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';
import { awaitNoOpenTransaction } from '../../common/utils/shared-connection';
import { resolveFeatureFlags } from '../../config/feature-flags';
import {
  IWhatsAppEngine,
  ChatSummary,
  ChatState,
  type StoredChatMessageLookup,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { HookManager } from '../../core/hooks';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { chatKind, parseWaId } from '../../engine/identity/wa-id';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { ServerShuttingDownException, SessionStoppedException } from './session-engine-controls';
import { phoneKey } from './message-mutation-guard';
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
 * One request on this node that wants a session down: a stop, a kill, a delete or an import's
 * stopOrphanEngines. Withdrawn when it is refused or fails having taken nothing down; taken once its stop
 * record is being written, or for a delete once it begins removing the session. See SessionService.stopRequests.
 */
interface StopRequest {
  kind: 'stop' | 'delete';
  /** From one sequence shared by every session, so a number is never issued twice. */
  seq: number;
  state: 'pending' | 'taken' | 'withdrawn';
  /** Its call has returned; a request that was not withdrawn stays while a start that may predate it runs. */
  ended: boolean;
}

/** The stop requests of one session on this node, and the record its deletes running here share. */
interface SessionStops {
  requests: Set<StopRequest>;
  /** A delete still running wrote the 'deleting' record on a row that had none. */
  recorded: boolean;
  /** A delete still running began removing the session's data. */
  removing: boolean;
  /** The last delete out taking the record back. */
  givingBack?: Promise<void>;
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
   * Per session, the stop requests on this node, so a start can tell a stop issued after it began from a mark
   * left over by an earlier one, which start() clears by design. A start yields to any request issued after it
   * began that is not withdrawn: one refused or failed before taking anything down leaves nothing it could take
   * for a stop, and one that took effect stays visible however the others end. See claimAndStart().
   */
  private readonly stopRequests = new Map<string, SessionStops>();
  /** The last number given to a stop request. */
  private stopRequestSeq = 0;
  /**
   * Starts past start()'s cap check, held until they return. That check counts them with the
   * engine's slot holders, so two starts at the last free slot cannot both pass it while their claims
   * are awaited. hasStartCapacity() does not: a held start whose claim then fails never used a slot.
   * getActiveSessionIds() does, so the import pre-flight sees a start waiting on its claim or in its
   * retry pause, when the engine holds no slot for it; every start is held for that reason, capped
   * or not.
   */
  private readonly startReservations = new Map<string, number>();
  /** Ids whose claim a failed start left to another start in flight; the last start out hands it back. */
  private readonly releaseOwed = new Set<string>();
  /** The sorted chat listing the pages of one walk share. Every chat write below drops it. */
  private readonly chatListings = new ListingMemo<ChatSummary>();

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
  ) {
    this.engineRegistry.onRetire(id => this.chatListings.drop(id));
  }

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
    // A failed release is logged and not thrown: a rejection here makes Nest skip every destroy hook
    // after this one (webhook drain, queue worker close, usage flush, plugin onDisable), and the claims
    // lapse with their lease anyway.
    try {
      await this.ownership?.releaseAll(this.startReservations.keys());
    } catch (error) {
      this.logger.warn('Could not release the session claims at shutdown; they lapse with their lease', {
        action: 'session_claim_release_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    // On SQLite every caller shares one connection: opened beside another caller's transaction, this one would be a
    // savepoint in it or carry that one's writes, and either rollback could undo what the other had answered for.
    if (!(await awaitNoOpenTransaction(this.dataSource))) {
      throw new ServiceUnavailableException(
        `Session '${dto.name}' was not created: another database transaction stayed open. Retry the create.`,
      );
    }
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
    const request = this.markStopping(id, 'delete');
    const stops = this.stopRequests.get(id)!;
    // Running from here, before the claim: a claim with nothing running behind it would read as idle to the
    // heartbeat, and a stop or a failed start here would hand it back while the rows are removed. It ends
    // before the claim is handed back.
    const endDelete = this.engineLifecycle.holdDelete(id);
    let claimed = false;
    let ownsClaim: (() => boolean) | undefined;
    try {
      try {
        if (this.ownership) {
          await this.assertNotHeldElsewhere(id, request);
          await this.claimForDelete(id, this.ownership, request, captured => {
            claimed = true;
            ownsClaim = captured;
          });
          claimed = true;
          ownsClaim ??= this.ownership.captureClaim?.(id);
        }
        // A failed write took nothing down, so the mark is dropped and the request withdrawn as for a failed claim.
        await this.keepDownForDelete(id, stops, ownsClaim).catch((error: unknown) => {
          this.engineLifecycle.clearStopping(id);
          this.withdrawStop(request);
          throw error;
        });
        // Refused or failed before it began removing (its row read, either fence), the delete leaves the session as
        // it found it and withdraws its request, so a start it overlapped does not take it for a stop.
        await this.engineLifecycle
          .delete(id, {
            ownsClaim,
            onRemoving: () => {
              this.takeStop(request);
              stops.removing = true;
            },
          })
          .catch((error: unknown) => {
            if (request.state !== 'taken') this.withdrawStop(request);
            throw error;
          });
      } finally {
        endDelete();
      }
      await this.releaseAfterTeardown(id, ownsClaim);
    } catch (error) {
      // A delete that removed nothing leaves the session as it found it. One that began to remove it leaves
      // it stopped, as a process that dies part-way does.
      await this.leaveDelete(id, request, ownsClaim);
      // The row survived. A claim left on it lapses with nothing to renew it, and a peer would then
      // adopt and restart the session the operator was deleting.
      if (claimed) await this.releaseAfterTeardown(id, ownsClaim);
      this.discardStopMarkForMissingSession(id, error);
      throw error;
    }
    await this.leaveDelete(id, request, ownsClaim);
  }

  /**
   * End a delete's share of the stop record. Another delete of the session still running here relies on it, so
   * only the last one out takes it back, and only when they wrote it and none began removing the session. A stop
   * recorded alongside it, here or on another node, stays as a normal stop afterward.
   */
  private async leaveDelete(id: string, request: StopRequest, ownsClaim?: () => boolean): Promise<void> {
    const stops = this.stopRequests.get(id)!;
    request.ended = true;
    const deleting = (): boolean => [...stops.requests].some(other => other.kind === 'delete' && !other.ended);
    if (!deleting() && !stops.givingBack && (ownsClaim?.() ?? true)) {
      const clear = stops.recorded && !stops.removing;
      // Not theirs while it is cleared, so a delete that begins and ends meanwhile leaves it alone.
      stops.recorded = false;
      stops.givingBack = this.clearDeleteStop(id, clear).then(cleared => {
        // Still on the row: a delete that began meanwhile shares it.
        if (!cleared) stops.recorded = true;
        stops.givingBack = undefined;
      });
      await stops.givingBack;
    }
    if (!deleting() && !stops.givingBack) {
      stops.recorded = false;
      stops.removing = false;
    }
    this.endStop(id, request);
  }

  /**
   * Hold the session's claim for as long as the delete runs. A row nobody held, or one whose holder's
   * lease lapsed, could otherwise be claimed by a peer's start or takeover while its rows are removed,
   * and the engine that peer launched would store messages for a session that no longer exists. The
   * heartbeat renews the claim (a delete in flight counts as active) and delete() hands it back.
   * Nothing has been removed when this refuses: a peer that claimed first answers the same 409 as
   * assertNotHeldElsewhere, and a failed write is undone like a failed ownership read.
   */
  private async claimForDelete(
    id: string,
    ownership: SessionOwnershipService,
    request: StopRequest,
    onClaimed: (ownsClaim: () => boolean) => void,
  ): Promise<void> {
    let claimed: boolean;
    try {
      claimed = await ownership.claim(id, onClaimed);
    } catch (error) {
      this.engineLifecycle.clearStopping(id);
      this.withdrawStop(request);
      this.logger.warn(`Could not claim session ${id} for the delete; nothing was deleted`, {
        sessionId: id,
        action: 'session_delete_claim_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableException(`Session ${id} could not be claimed for the delete; nothing was deleted`);
    }
    if (claimed) return;
    this.withdrawStop(request);
    // The claim is a conditional UPDATE, so an id with no row matches nothing too: answer its 404.
    await this.findOne(id);
    throw new ConflictException(`Session ${id} is running on another node`);
  }

  /**
   * Record the delete as a stop on a row that has none, so a session whose delete ends part-way, with the
   * process that ran it, stays down: no peer adopts it and no boot starts it. Written after a take-back in
   * progress, which would otherwise clear it. 'deleting' rather than 'stopped', so the take-back can tell it
   * from a stop that replaced it, also one another node recorded.
   */
  private async keepDownForDelete(id: string, stops: SessionStops, ownsClaim?: () => boolean): Promise<void> {
    if (stops.givingBack) await stops.givingBack;
    const record = async (sessions: Repository<Session>): Promise<void> => {
      const { affected } = await sessions.update({ id, desiredState: IsNull() }, { desiredState: 'deleting' });
      if (affected === 1) stops.recorded = true;
      await sessions.update({ id, desiredState: 'stopped' }, { desiredState: 'deleting-stopped' });
    };
    if (!this.ownership) return record(this.sessionRepository);
    if (!(await awaitNoOpenTransaction(this.dataSource))) {
      throw new ServiceUnavailableException(
        `Session ${id} could not record its delete: another transaction stayed open`,
      );
    }
    await this.dataSource.transaction(async manager => {
      const { affected } = await manager
        .createQueryBuilder()
        .update(Session)
        .set({ nodeId: this.ownership!.nodeId, updatedAt: () => '"updatedAt"' })
        .where({ id, nodeId: this.ownership!.nodeId })
        .execute();
      if (affected !== 1 || ownsClaim?.() === false) {
        throw new ConflictException(`Session ${id} is no longer owned by this delete`);
      }
      await record(manager.getRepository(Session));
    });
  }

  /**
   * Undo keepDownForDelete; answers whether the record is off the row. Best effort: the delete's own error is
   * the answer, and a stop left on is safe. A stop recorded over it since is left alone.
   */
  private async clearDeleteStop(id: string, clear: boolean): Promise<boolean> {
    try {
      const owners: FindOptionsWhere<Session>[] = this.ownership
        ? [{ nodeId: this.ownership.nodeId }, { nodeId: IsNull() }]
        : [{}];
      if (clear) {
        await this.sessionRepository.update(
          owners.map(owner => ({ id, ...owner, desiredState: 'deleting' as const })),
          { desiredState: null },
        );
      }
      await this.sessionRepository.update(
        owners.map(owner => ({ id, ...owner, desiredState: 'deleting-stopped' as const })),
        { desiredState: 'stopped' },
      );
      return true;
    } catch (error) {
      this.logger.warn(`Could not clear the stop a failed delete recorded for session ${id}`, {
        sessionId: id,
        action: 'session_delete_stop_clear_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
   * The stop request set on the same tick needs nothing here: the read or claim that answered 404
   * withdrew it, and a withdrawn request goes when its call returns.
   */
  private discardStopMarkForMissingSession(id: string, error: unknown): void {
    if (!(error instanceof NotFoundException)) return;
    this.engineLifecycle.clearStopping(id);
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
  private async assertNotHeldElsewhere(id: string, request: StopRequest): Promise<void> {
    // Both callers issue the request and set the stop mark before this query. The MARK survives a
    // 409 (harmless, cleared by the next start()) but not a failed query: that decided nothing, and
    // a mark left on a session running here would stop its next disconnect from reconnecting.
    // Either refusal withdraws the REQUEST. Nothing was taken down, and the request exists only so an
    // in-flight start() can tell a stop that happened from one that did not; one left standing
    // cancels that start and leaves the session down with nothing to restart it.
    const heldElsewhere = await this.ownership?.isHeldByOtherNode(id).catch((error: unknown) => {
      this.engineLifecycle.clearStopping(id);
      this.withdrawStop(request);
      throw error;
    });
    if (heldElsewhere) {
      this.withdrawStop(request);
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
      if (left > 0) {
        this.startReservations.set(id, left);
      } else {
        this.startReservations.delete(id);
        // No start of the session runs now to look at the stop requests that have returned.
        this.dropEndedStops(id);
        if (this.releaseOwed.delete(id)) await this.releaseUnlessEngineActive(id, undefined, { correctStatus: true });
      }
    }
  }

  private refuseIfShuttingDown(): void {
    if (this.stopping) throw new ServerShuttingDownException();
  }

  private async claimAndStart(id: string, explicit: boolean): Promise<Session> {
    // Read before the claim, so a stop that lands while the claim is pending counts against this start.
    const stopRequestsBefore = this.stopRequestSeq;
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
      // A failed or refused start must not leave the claim here: until its lease lapsed, no other node
      // could start the session. Released only when nothing is actually alive locally, and then with
      // the status corrected: an "already starting/started" refusal means this node genuinely runs
      // the engine, and releasing then would invite a peer to open a second connection.
      await this.releaseUnlessEngineActive(id, undefined, { correctStatus: true });
      throw error;
    }
    await this.keepDownIfStoppedDuringStart(id, explicit, stopRequestsBefore);
    // A start retired by a concurrent stop() resolves normally but leaves no engine, and that stop
    // skipped its release while this start still held the session. Hand the claim back here, or the
    // row keeps naming this node until the lease lapses and a peer adopts the stopped session.
    await this.releaseUnlessEngineActive(id, undefined, { correctStatus: true });
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
  private async startWithTransientRetry(id: string, explicit: boolean, stopRequestsBefore: number): Promise<Session> {
    // A stop that finished during the claim answered 200 and left the claim to this start; the engine's own
    // stop-mark check cannot tell its mark from a stale one, so the start is refused here.
    if (this.stoppedSince(id, stopRequestsBefore)) {
      throw new SessionStoppedException(`Session ${id} was stopped`);
    }
    // Shutdown may have begun while the claim was pending; the stop clear and the hook must not run.
    this.refuseIfShuttingDown();
    const stoppedSince = (): boolean => this.stoppedSince(id, stopRequestsBefore);
    try {
      return await this.engineLifecycle.start(id, { explicit, stoppedSince });
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
      if (this.stoppedSince(id, stopRequestsBefore)) {
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
        if (this.stoppedSince(id, stopRequestsBefore)) {
          throw new SessionStoppedException(`Session ${id} was stopped`);
        }
        // And shutdown may have begun during the re-claim; the stop clear and the hook must not run.
        this.refuseIfShuttingDown();
        return await this.engineLifecycle.start(id, { explicit, stoppedSince });
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
    const request = this.markStopping(id, 'stop');
    let session: Session;
    try {
      if (this.ownership) await this.assertNotHeldElsewhere(id, request);
      // Recorded once the row read succeeds and BEFORE the teardown, so the 502
      // SESSION_STOP_INCOMPLETE path keeps it too: a stopped session stays down across restarts and
      // takeover until an explicit start. A failed write took nothing down, so the mark is dropped and
      // the request withdrawn as for a failed ownership read; a failed read took nothing down either,
      // and the lifecycle has already dropped the mark, so only the request is withdrawn.
      session = await this.engineLifecycle.stop(id, {
        afterRead: () => {
          this.takeStop(request);
          return this.keepDown(id).catch((error: unknown) => {
            this.engineLifecycle.clearStopping(id);
            this.withdrawStop(request);
            throw error;
          });
        },
        onReadFailed: () => this.withdrawStop(request),
      });
    } catch (error) {
      // Only the local 502 (SESSION_STOP_INCOMPLETE) releases: it evicted the engine and wrote
      // DISCONNECTED, and a claim left to lapse still names this node, so a peer's takeover sweep
      // would adopt the row and start the session the operator just stopped. A released claim is
      // not adopted. The foreign-node 409 keeps its claim (it is the peer's), and so does a 404.
      if (error instanceof BadGatewayException) await this.releaseAfterTeardown(id);
      this.discardStopMarkForMissingSession(id, error);
      throw error;
    } finally {
      this.endStop(id, request);
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
    // A start still waiting on its claim yields to the logout rather than relaunching the session it just
    // took down. Not recorded as a stop: logout clears the phone, which keeps the session out of auto-start.
    let request: StopRequest | undefined;
    const issue = (): StopRequest => (request ??= this.requestStop(id, 'stop'));
    const withdraw = (): void => {
      if (request) this.withdrawStop(request);
    };
    if (this.engines.get(id)) issue();
    try {
      const session = await this.engineLifecycle.logout(id, {
        onReadFailed: withdraw,
        onEngineFound: () => {
          issue();
        },
      });
      // Torn down locally on the 200 path — hand the claim back the way stop() does.
      await this.releaseAfterTeardown(id);
      return session;
    } catch (error) {
      // The 502-incomplete path tears the engine down, so its claim must not survive the call. A 400
      // "not started" refusal changed nothing and keeps whatever claim there is: release() also
      // clears a LAPSED foreign claim, which would take a crashed node's session out of takeover.
      if (error instanceof BadRequestException) withdraw();
      if (!(error instanceof BadRequestException)) await this.releaseAfterTeardown(id);
      throw error;
    } finally {
      if (request) this.endStop(id, request);
    }
  }

  async forceKill(id: string): Promise<Session> {
    // A stop request like stop()'s, so a start still waiting on its claim yields rather than relaunching,
    // but only while there is an engine to kill: issued at once if one runs, so a start sent after the
    // kill keeps its place, otherwise once the kill finds one. A kill that took nothing down (a 400, a
    // 404 or a failed row read) withdraws it, so it cannot retire a start still waiting on its claim. One
    // that found an engine stands, even if its record cannot be written: the engine is killed.
    let request: StopRequest | undefined;
    const issue = (): StopRequest => (request ??= this.requestStop(id, 'stop'));
    const withdraw = (): void => {
      if (request) this.withdrawStop(request);
    };
    if (this.engines.get(id)) issue();
    try {
      // The engine kill records the stop itself, once it has an engine to kill.
      const session = await this.engineLifecycle.forceKill(id, {
        onReadFailed: withdraw,
        onEngineFound: () => this.takeStop(issue()),
        recordStop: () => this.keepDown(id),
      });
      await this.releaseAfterTeardown(id);
      return session;
    } catch (error) {
      // The 400 "not started" also keeps its claim as in logout(). The 502 did evict the engine: its
      // request stands and it releases.
      if (error instanceof BadRequestException) withdraw();
      if (!(error instanceof BadRequestException)) await this.releaseAfterTeardown(id);
      throw error;
    } finally {
      if (request) this.endStop(id, request);
    }
  }

  /**
   * Persist a stop only while no live peer owns the engine. The initial ownership read may predate a peer's
   * claim; deciding in this write also fences a stop delayed until after that peer's start returned. A delete's
   * record still accepts a stop, while remaining distinguishable until its delete finishes.
   */
  private async keepDown(id: string): Promise<void> {
    const claims: FindOptionsWhere<Session>[] = this.ownership
      ? [
          { id, nodeId: IsNull() },
          { id, nodeId: this.ownership.nodeId },
        ]
      : [{ id }];
    const where = this.ownership
      ? claims.flatMap(claim => [
          { ...claim, desiredState: IsNull() },
          { ...claim, desiredState: 'stopped' as const },
        ])
      : id;
    const { affected } = await this.sessionRepository.update(where, { desiredState: 'stopped' });
    if (affected === 0) {
      const deleting = await this.sessionRepository.update(
        { id, desiredState: In(['deleting', 'deleting-stopped']) },
        { desiredState: 'deleting-stopped' },
      );
      if (deleting.affected === 1) return;
      // The delete may have finished between the two writes, leaving a normal stopped or free row.
      if ((await this.sessionRepository.update(where, { desiredState: 'stopped' })).affected === 1) return;
      // Clear an abandoned foreign claim with the record, before its heartbeat can revive it. A
      // pending delete took the branch above and keeps its claim throughout removal.
      if (this.ownership && (await this.ownership.stopExpiredForeignClaim(id))) return;
      await this.findOne(id);
      throw new ConflictException(`Session ${id} is running on another node`);
    }
  }

  /**
   * Re-record a stop an explicit start may have erased. The start clears the stop record with a
   * write conditional on the row still reading what it read, and a stop's own write leaves 'stopped'
   * unchanged, so a stop landing just before the clear was wiped from the row while its in-memory
   * mark retired the start. The session was down, but the next boot would relaunch it. Any stop
   * issued while the start ran whose record was written, or delete that began removing, and leaving no
   * engine behind is the operator's last word; one still pending writes its own record or withdraws, so
   * it re-records nothing here. A failed write is logged rather than thrown: the start's own outcome
   * still stands.
   */
  private async keepDownIfStoppedDuringStart(id: string, explicit: boolean, stopRequestsBefore: number): Promise<void> {
    const stoppedMeanwhile = this.stoppedSince(id, stopRequestsBefore, { taken: true });
    if (!explicit || !stoppedMeanwhile || this.engineLifecycle.isEngineActive(id)) return;
    await this.keepDown(id).catch((error: unknown) =>
      this.logger.error(
        'Failed to record a stop that landed during a start',
        error instanceof Error ? error.message : String(error),
        { sessionId: id, action: 'start_keep_down_failed' },
      ),
    );
  }

  private markStopping(id: string, kind: StopRequest['kind']): StopRequest {
    const request = this.requestStop(id, kind);
    this.engineLifecycle.markStopping(id);
    return request;
  }

  /** Issue a stop request for the session; the caller withdraws, takes and ends exactly this one. */
  private requestStop(id: string, kind: StopRequest['kind']): StopRequest {
    let stops = this.stopRequests.get(id);
    if (!stops) {
      stops = { requests: new Set(), recorded: false, removing: false };
      this.stopRequests.set(id, stops);
    }
    const request: StopRequest = { kind, seq: ++this.stopRequestSeq, state: 'pending', ended: false };
    stops.requests.add(request);
    return request;
  }

  /** Its stop record is being written, or its delete began removing: it can no longer leave nothing behind. */
  private takeStop(request: StopRequest): void {
    if (request.state === 'pending') request.state = 'taken';
  }

  /** It was refused or failed having taken nothing down: no start yields to it. */
  private withdrawStop(request: StopRequest): void {
    request.state = 'withdrawn';
  }

  /**
   * The request's call returned. A withdrawn one goes at once; one that stands stays while a start of the
   * session runs, which may have begun before it, and goes when the last start returns.
   */
  private endStop(id: string, request: StopRequest): void {
    request.ended = true;
    const stops = this.stopRequests.get(id);
    if (!stops) return;
    if (request.state === 'withdrawn' || !this.startReservations.has(id)) stops.requests.delete(request);
    this.tidyStops(id, stops);
  }

  private dropEndedStops(id: string): void {
    const stops = this.stopRequests.get(id);
    if (!stops) return;
    for (const request of stops.requests) if (request.ended) stops.requests.delete(request);
    this.tidyStops(id, stops);
  }

  private tidyStops(id: string, stops: SessionStops): void {
    if (stops.requests.size === 0 && !stops.givingBack) this.stopRequests.delete(id);
  }

  /**
   * Whether a stop request issued after the number `since` (the last one issued when a start began) still
   * stands, pending or taken; with `taken`, only one whose record was written or whose delete began removing.
   * A request issued before the start is not one it yields to, however it ends.
   */
  private stoppedSince(id: string, since: number, { taken = false } = {}): boolean {
    for (const request of this.stopRequests.get(id)?.requests ?? []) {
      if (request.seq > since && request.state !== 'withdrawn' && (!taken || request.state === 'taken')) return true;
    }
    return false;
  }

  /**
   * The claim release for an operator teardown (stop, logout, force-kill). A start() of the same id
   * that is still waiting on its claim owns it, though nothing runs here yet for the engine check to
   * see: releasing would leave the engine it is about to launch on a row no node holds. That start
   * hands the claim back itself if it yields or fails.
   */
  private async releaseAfterTeardown(id: string, ownsClaim?: () => boolean): Promise<void> {
    if (this.startReservations.has(id)) return;
    await this.releaseUnlessEngineActive(
      id,
      ownsClaim
        ? () => ownsClaim() && !this.startReservations.has(id) && !this.engineLifecycle.isEngineActive(id)
        : undefined,
    );
  }

  /**
   * Hand the claim back unless something still runs here (engine, in-flight start, pending reconnect,
   * delete in flight). A start's release (`correctStatus`) then corrects the status of the row it
   * released: nothing runs it here, and a row no node holds is never revisited by the lapsed-claim
   * correction or the takeover sweep, so a READY a vanished node left on it would stand until a boot.
   */
  private async releaseUnlessEngineActive(
    id: string,
    ownsClaim?: () => boolean,
    { correctStatus = false } = {},
  ): Promise<void> {
    if (!this.ownership || this.engineLifecycle.isEngineActive(id)) {
      return;
    }
    // Another start of the id is in flight and may have written the claim since: clearing it now would
    // leave the engine that start launches on a row no node holds. The start that leaves last decides.
    if ((this.startReservations.get(id) ?? 0) > 1) {
      this.releaseOwed.add(id);
      return;
    }
    this.releaseOwed.delete(id);
    await this.releaseClaimBestEffort(id, ownsClaim);
    if (correctStatus) await this.disconnectReleasedRow(id);
  }

  /**
   * Written after the release and on an unclaimed row only: any claim sets `nodeId`, so a row a peer or
   * a later start has claimed since keeps the status its start gives it, and a release that failed
   * leaves the row claimed, to lapse into the corrections that read claimed rows. Best-effort, like the
   * release: the start's own outcome is the answer.
   */
  private async disconnectReleasedRow(id: string): Promise<void> {
    try {
      const { affected } = await this.sessionRepository.update(
        { id, nodeId: IsNull(), status: In(ACTIVE_STATUSES) },
        { status: SessionStatus.DISCONNECTED },
      );
      if (affected) this.engineLifecycle.announceStatus(id, SessionStatus.DISCONNECTED);
    } catch (error) {
      this.logger.warn(`Could not mark session ${id} disconnected after its start left no engine`, {
        sessionId: id,
        action: 'session_release_status_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Best-effort: the outcome of the start or the teardown that asks is already decided, and a claim that
   * cannot be handed back lapses with its lease, which a peer then adopts. A failure here must not
   * replace that outcome (a started session reported as failed, a stopped one as an error, a committed
   * delete as a 500 whose retry answers 404 and writes no audit row).
   */
  private async releaseClaimBestEffort(id: string, ownsClaim?: () => boolean): Promise<void> {
    if (!this.ownership) return;
    try {
      if (ownsClaim) await this.ownership.release(id, ownsClaim);
      else await this.ownership.release(id);
    } catch (error) {
      this.logger.warn(`Could not hand back the claim of session ${id}; it lapses with its lease`, {
        sessionId: id,
        action: 'session_claim_release_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    // On whatsapp-web.js a code requested for a number that is already linked can make WhatsApp revoke that
    // device. The number is the caller's to choose, so a session this key may not touch could be logged out
    // through this one; a number another session holds is refused. The session's own number is its to re-link.
    // Baileys adds a companion device and showed no such effect, so two of its sessions may share a number.
    if (this.pairingMayRevoke() && (await this.otherSessionHoldsNumber(id, phoneNumber))) {
      throw new ConflictException(
        'That number is linked to another session. Delete that session, or log it out while it runs, before pairing this one.',
      );
    }

    const pairingCode = await engine.requestPairingCode(phoneNumber);
    return { pairingCode, status: session.status };
  }

  /** Whether the engine in use is whatsapp-web.js, where a pairing request can revoke a linked device. */
  private pairingMayRevoke(): boolean {
    return (this.configService?.get<string>('engine.type') ?? 'whatsapp-web.js') === 'whatsapp-web.js';
  }

  /**
   * Whether another session stores this number as its phone, whichever way the country writes its mobile
   * marker digit (the spellings the stored phone and the typed number can differ by).
   */
  private async otherSessionHoldsNumber(id: string, phoneNumber: string): Promise<boolean> {
    const key = phoneKey(phoneNumber);
    const others = await this.sessionRepository.find({
      where: { id: Not(id), phone: Not(IsNull()) },
      select: { phone: true },
    });
    return others.some(other => other.phone !== null && phoneKey(other.phone) === key);
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
   * `offset` is the window the caller is about to take: a later page reuses the list its walk's
   * first page read a few seconds ago (see ListingMemo).
   */
  async listChats(id: string, offset?: number): Promise<ChatSummary[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    // Most-recent first. Sorting before the cap means a capped response is the N newest chats (what
    // clients show first) rather than an arbitrary slice.
    return this.chatListings.read(id, offset, async () =>
      [...(await engine.getChats())].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
    );
  }

  async getChats(id: string, opts: ListOptions = {}): Promise<ChatSummary[]> {
    return paginate(await this.listChats(id, opts.offset), opts.limit, opts.offset);
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
    // A publish that settles after its engine was replaced must not leave a preference the replacement never had.
    if (this.engines.isLive(id, engine)) this.presence.setOwnIntent(id, available);
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

    const authors = await this.groupAuthors(id, chatId, messageIds);
    return engine
      .sendSeen(chatId, messageIds, authors, this.storedLastMessage(id, chatId, { receivedOnly: true }))
      .finally(() => this.chatListings.drop(id));
  }

  /**
   * Who posted each named message of a group, from the rows the gateway stored. A group read receipt
   * names the sender, and for a message the engine never kept (history backfill) these rows are the only
   * place it is recorded. Best-effort: a read that cannot learn them still acknowledges what the engine
   * can name on its own.
   */
  private async groupAuthors(
    sessionId: string,
    chatId: string,
    messageIds?: string[],
  ): Promise<ReadonlyMap<string, string> | undefined> {
    if (!messageIds?.length || chatKind(chatId) !== 'group') return undefined;
    try {
      const rows = await this.messageRepository.find({
        where: { sessionId, chatId, waMessageId: In(messageIds), direction: MessageDirection.INCOMING },
        select: { waMessageId: true, author: true },
      });
      return new Map(rows.flatMap(row => (row.waMessageId && row.author ? [[row.waMessageId, row.author]] : [])));
    } catch (error) {
      this.logger.warn('Could not read who posted the messages a read names; sending the read without them', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async markUnread(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.markUnread(chatId, this.storedLastMessage(id, chatId)).finally(() => this.chatListings.drop(id));
  }

  /**
   * The newest message the gateway stored for a chat, for an engine that keys chat writes to one and
   * holds none for the chat itself (Baileys after a restart, #1891). The lookup runs only when the
   * engine calls it, and covers every id form of the chat (the GET messages filter's rules).
   *
   * A received group message counts only with its sender, which the key needs; `receivedOnly` asks
   * for the newest received message, the one a read receipt acknowledges.
   */
  private storedLastMessage(
    sessionId: string,
    chatId: string,
    { receivedOnly = false }: { receivedOnly?: boolean } = {},
  ): StoredChatMessageLookup {
    return async () => {
      const expanded = await resolveJidCandidates(chatId, {
        resolveLid: lid => this.lidMappingStore.findPhoneForLid(lid),
        lidsForPhone: phone => this.lidMappingStore.findLidsForPhone(phone),
      });
      const base = {
        sessionId,
        chatId: In([...new Set([chatId, ...expanded])]),
        waMessageId: Not(IsNull()),
        timestamp: Not(IsNull()),
      };
      const received = { ...base, direction: MessageDirection.INCOMING };
      const where: FindOptionsWhere<Message>[] =
        parseWaId(chatId).kind === 'group'
          ? [
              { ...received, author: Not(IsNull()) },
              ...(receivedOnly ? [] : [{ ...base, direction: MessageDirection.OUTGOING }]),
            ]
          : [receivedOnly ? received : base];
      const row = await this.messageRepository.findOne({
        where,
        order: { timestamp: 'DESC', createdAt: 'DESC' },
        select: { id: true, waMessageId: true, chatId: true, direction: true, author: true, timestamp: true },
      });
      if (!row) return null;
      // The lid the engine keys a lid-migrated chat by, read from the persisted mapping: the engine's
      // own cache can lack it (#1901). A phone can map to more than one lid, so the lid the row is
      // filed under wins, and a row filed under the phone takes the table's lid when it lists one. With
      // two or more, for the chat or for the sender of a received group message, any one is a guess
      // (the engine's cache would pick the oldest), so no write is keyed to the row at all.
      const filed = parseWaId(row.chatId);
      const lids = expanded.filter(candidate => parseWaId(candidate).kind === 'lid');
      if (filed.kind !== 'lid' && lids.length > 1) return null;
      const lid = filed.kind === 'lid' ? `${filed.userPart}@lid` : lids[0];
      const sender =
        parseWaId(chatId).kind === 'group' && row.direction === MessageDirection.INCOMING ? row.author : undefined;
      const authorLids = sender ? await this.persistedLidsOf(sender) : [];
      if (authorLids.length > 1) return null;
      const authorLid = authorLids[0];
      return {
        id: row.waMessageId,
        fromMe: row.direction === MessageDirection.OUTGOING,
        ...(row.author ? { author: row.author } : {}),
        timestamp: row.timestamp,
        ...(lid ? { lid } : {}),
        ...(authorLid ? { authorLid } : {}),
      };
    };
  }

  /** Every `<lid>@lid` the persisted mapping holds for a person (the lid itself for a lid). */
  private async persistedLidsOf(jid: string): Promise<string[]> {
    const parsed = parseWaId(jid);
    if (parsed.kind === 'lid') return [`${parsed.userPart}@lid`];
    if (parsed.kind !== 'user') return [];
    return (await this.lidMappingStore.findLidsForPhone(parsed.userPart)).map(lid => `${lid}@lid`);
  }

  /**
   * Delete every message in a chat, keeping the chat itself. Resolves false when the engine could
   * not act — an unknown chat, or on Baileys a chat with no message in memory or stored to key the
   * change to. On success the gateway's stored copies of the chat's messages are removed too.
   */
  async clearChatMessages(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    const cutoff = new Date();
    const ok = await engine
      .clearChatMessages(chatId, this.storedLastMessage(id, chatId))
      .finally(() => this.chatListings.drop(id));
    if (ok) await this.purgeStoredChat(id, chatId, cutoff);
    return ok;
  }

  /**
   * Archive or unarchive a chat. Resolves false when the engine could not act. Baileys keys the
   * change to the chat's newest message in memory, else the newest stored one, else sends it
   * without one for a chat the session knows, which WhatsApp applies too.
   */
  async archiveChat(id: string, chatId: string, archive: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine
      .archiveChat(chatId, archive, this.storedLastMessage(id, chatId))
      .finally(() => this.chatListings.drop(id));
  }

  /**
   * Mute a chat until `muteUntil` (absolute epoch milliseconds), or unmute it with `null`. Unlike
   * archiveChat there is no "engine declined" outcome — the Baileys mute patch is not keyed to the
   * chat's last message — so this resolves void and a failure surfaces as an error.
   */
  async muteChat(id: string, chatId: string, muteUntil: number | null): Promise<void> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.muteChat(chatId, muteUntil).finally(() => this.chatListings.drop(id));
  }

  /**
   * Pin or unpin a chat. Resolves false only when the engine declined — whatsapp-web.js reports
   * WhatsApp's three-pin cap; Baileys cannot see it and always resolves true.
   */
  async pinChat(id: string, chatId: string, pin: boolean): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    return engine.pinChat(chatId, pin).finally(() => this.chatListings.drop(id));
  }

  /** Delete a chat. On success the gateway's stored copies of its messages are removed too. */
  async deleteChat(id: string, chatId: string): Promise<boolean> {
    await this.findOne(id); // Verify session exists
    const engine = this.requireEngine(id);

    const cutoff = new Date();
    const ok = await engine
      .deleteChat(chatId, this.storedLastMessage(id, chatId))
      .finally(() => this.chatListings.drop(id));
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
   * Owned by the lifecycle service; see SessionEngineLifecycle.stopOrphanEngines(). A stop request
   * too, so a start waiting on its claim or in its retry pause launches nothing: the engine's
   * stop mark alone reads as stale to the start that follows.
   */
  async stopOrphanEngines(
    sessionIds: string[],
  ): Promise<{ stopped: string[]; notRunning: string[]; failed: string[] }> {
    for (const id of sessionIds) {
      const request = this.requestStop(id, 'stop');
      this.takeStop(request);
      this.endStop(id, request);
    }
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
