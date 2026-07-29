import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpCode,
  HttpStatus,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isPathWithin, isSafeSessionName } from '../../common/utils/path-safety';
import { writeSecretFile } from '../../common/utils/secret-file';
import { EngineFactory } from '../../engine/engine.factory';
import { getEffectiveWebVersionInfo, resolveCurrentWebVersion } from '../../engine/wa-web-version';
import { DockerService, MANAGED_DOCKER_PROFILES } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { createLogger } from '../../common/services/logger.service';
import { isMissingTableError } from '../../common/utils/db-errors';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ImportStorageDto } from './dto/import-storage.dto';
import { SaveConfigDto } from './dto/save-config.dto';
import { assertNoDefaultSecretsInProduction } from '../../config/bootstrap-security';
import { BLANK_SHADOWED_ENV_KEYS, isOsProvidedEnv } from '../../config/env-precedence';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';

interface InfraStatus {
  // `builtIn` reflects whether OpenWA's own bundled container is actually running and backing this
  // service (detected live from the labeled container), not merely the saved intent. Falls back to the
  // saved flag when Docker is unavailable. (#488)
  database: { connected: boolean; type: string; host: string; builtIn: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string; builtIn: boolean; s3Available?: boolean };
  engine: {
    type: string;
    headless: boolean;
    sessionDataPath: string;
    browserArgs: string;
    // whatsapp-web.js only: the actual WhatsApp Web build in use (distinct from the library version),
    // and how it was chosen. Omitted for other engines (e.g. baileys). (#488)
    webVersion?: string | null;
    webVersionSource?: 'pinned' | 'auto' | 'native';
  };
}

// The PUT /infra/config body DTOs live in ./dto/save-config.dto.ts: as *.dto.ts classes they are
// covered by the input-coercion drift gate (src/common/utils/dto-strict-coercion.spec.ts), which
// controller-local classes escape, and their boolean/numeric fields carry the @ToStrictBoolean /
// @ToStrictNumber transforms that keep a form-encoded 'false' from being coerced to `true`.

class RestartDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  profiles?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  profilesToRemove?: string[];
}

// Database migration types for export/import
interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  secret: string | null;
  headers: string | Record<string, string>;
  filters: string | Record<string, unknown> | null;
  active: boolean | number;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shapes mirror the REAL table columns as returned by `SELECT *` (export-data), not the
// camelCase TypeORM entity properties. `messages` columns are the property names; `message_batches`
// columns are snake_case (the entity maps them via `name:`). Keeping these accurate is what keeps
// the import column lists below from drifting back into "no such column" failures.
interface MessageRow {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  chatName: string | null;
  /** Group participant JID (nullable; added to messages after chatName — keep the import list in sync). */
  author: string | null;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
  /**
   * Postgres-only STORED generated tsvector (FTS). Present in `SELECT *` rows read from a Postgres
   * source (and in backups made before it was stripped) but never a real payload column: export drops
   * it, and the import's explicit column list ignores it. Declared so both directions type-check.
   */
  body_ts?: unknown;
}

interface MessageBatchRow {
  id: string;
  batch_id: string;
  session_id: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown> | null;
  progress: string | Record<string, unknown> | null;
  results: string | unknown[] | null;
  current_index: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so import's
// `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
// backup flow loses them permanently.
interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
interface LidMappingRow {
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

interface PluginInstanceRow {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string;
  verifyToken: string | null;
  config: string | Record<string, unknown> | null;
  enabled: boolean | number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: string;
  metadata: string | Record<string, unknown> | null;
  updatedAt: string;
}

interface IngressEventRow {
  id: string;
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  // Retired to NULL once the dispatch outcome is recorded; only 'pending' rows still carry one.
  payload: string | Record<string, unknown> | null;
  payloadHash?: string | null;
  // Dispatch lifecycle (the AddIngressEventDispatchState migration). A restored 'pending' row must
  // keep these or the reconciler never replays it while the dedup row still blocks the provider's
  // retry. Optional because backups exported before the columns existed don't carry them.
  dispatchState?: 'pending' | 'dispatched' | 'failed' | null;
  dispatchAttempts?: number;
  lastDispatchAt?: string | null;
  sessionId: string | null;
  createdAt: string;
}

interface WebhookDeliveryFailureRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  createdAt: string;
}

interface IntegrationDeliveryFailureRow {
  id: string;
  direction: string;
  pluginId: string;
  instanceId: string;
  sessionId: string | null;
  deliveryId: string | null;
  attempts: number;
  lastError: string;
  payload: string | Record<string, unknown> | null;
  redriven: boolean | number;
  createdAt: string;
}

// status_updates has no FK to sessions (plain columns), so the import's `DELETE FROM sessions` never
// clears it — it must be exported + re-inserted explicitly like lid_mappings. postedAt/expiresAt are
// bigint epoch-ms: raw queries bypass the entity transformer, so Postgres returns them as strings.
interface StatusUpdateRow {
  id: string;
  sessionId: string;
  contactJid: string;
  contactName: string | null;
  contactPushName: string | null;
  waStatusId: string;
  type: string;
  caption: string | null;
  mediaPath: string | null;
  mediaMimetype: string | null;
  mediaOmitted: boolean | number;
  omitReason: string | null;
  backgroundColor: string | null;
  font: number | null;
  postedAt: number | string;
  expiresAt: number | string;
}

interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
  pluginInstances: PluginInstanceRow[];
  conversationMappings: ConversationMappingRow[];
  ingressEvents: IngressEventRow[];
  webhookDeliveryFailures: WebhookDeliveryFailureRow[];
  integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
  statusUpdates: StatusUpdateRow[];
}

// Saved infrastructure config returned to the dashboard form for hydration. Secret
// values are never echoed back — a `*Set` boolean indicates whether one is stored.
interface SavedConfigResponse {
  database: {
    type: 'sqlite' | 'postgres';
    builtIn: boolean;
    host: string;
    port: string;
    username: string;
    database: string;
    schema: string;
    poolSize: number;
    sslEnabled: boolean;
    sslRejectUnauthorized: boolean;
    passwordSet: boolean;
  };
  redis: { enabled: boolean; builtIn: boolean; host: string; port: string; passwordSet: boolean };
  queue: { enabled: boolean };
  storage: {
    type: 'local' | 's3';
    builtIn: boolean;
    localPath: string;
    s3Bucket: string;
    s3Region: string;
    s3Endpoint: string;
    s3CredentialsSet: boolean;
  };
  engine: { type: string; headless: boolean; sessionDataPath: string; browserArgs: string };
}

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraController implements OnApplicationBootstrap {
  private readonly logger = createLogger('InfraController');

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource('main')
    private readonly mainDataSource: DataSource,
    @InjectDataSource('data')
    private readonly dataDataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly dockerService: DockerService,
    private readonly cacheService: CacheService,
    private readonly storageService: StorageService,
    private readonly shutdownService: ShutdownService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue,
    // Best-effort audit emission for the sensitive infra operations below. Injected @Optional and
    // appended last so it never shifts the existing positional args: the running app always provides
    // the @Global AuditService, while the direct-construction unit tests omit it — the `?.` at each
    // call site then makes emission a no-op there instead of forcing every test to wire a mock.
    @Optional()
    private readonly auditService?: AuditService,
    // Post-import runtime reconciliation (see importData). Same trailing-@Optional convention as
    // auditService: provided by the app (InfraModule imports SessionModule; EngineModule is @Global),
    // omitted by direct-construction unit tests, and every use is `?.`-guarded.
    @Optional()
    private readonly sessionService?: SessionService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
  ) {}

  /** Bound the DB liveness probe so a hung connection can't stall the status read. */
  private static readonly DB_PROBE_TIMEOUT_MS = 3000;

  /**
   * Active DB liveness probe: run `SELECT 1`, not just read `DataSource.isInitialized`. A backend
   * (notably Postgres) that dies AFTER init keeps `isInitialized` true until an explicit `.destroy()`,
   * so the old check reported the tile green while the DB was actually down. Bounded by a short
   * timeout; any error or timeout resolves to `false`. Mirrors `/health/ready`'s authoritative probe.
   */
  private async probeDbConnected(ds: DataSource): Promise<boolean> {
    if (!ds.isInitialized) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ds.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('db probe timeout')), InfraController.DB_PROBE_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Matches exactly the filename exportStorage writes: storage-export-<Date.now()>-<randomUUID()>.tar.gz.
  // The captured group is the creation epoch-ms, so the sweep reads the age from the name — anything
  // not in this exact shape (an operator's import candidate, any other file) is never touched.
  private static readonly EXPORT_ARCHIVE_PATTERN =
    /^storage-export-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;

  /**
   * Boot sweep for orphaned storage-export archives. exportStorage deletes each archive on a TTL
   * timer, but that timer dies with the process — an archive whose process restarted or crashed
   * before the timer fired would accumulate on the data volume forever. At bootstrap, delete the
   * archives WE created whose embedded creation timestamp is older than
   * STORAGE_EXPORT_SWEEP_MAX_AGE_MS (default 24h; kept generous so the documented
   * export→restart→import migration flow still finds its file). Young archives and any
   * non-export file in data/exports/ are left untouched.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.sweepStaleExportArchives();
  }

  /**
   * Delete export archives older than STORAGE_EXPORT_SWEEP_MAX_AGE_MS from exportDir. Sweep
   * failures are logged, never thrown: a leftover archive must not block boot.
   */
  async sweepStaleExportArchives(exportDir = path.join(process.cwd(), 'data', 'exports')): Promise<void> {
    const maxAgeRaw = Number.parseInt(process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS ?? '', 10);
    const maxAgeMs = Number.isInteger(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 24 * 60 * 60 * 1000; // default 24h

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(exportDir, { withFileTypes: true });
    } catch (error) {
      // ENOENT just means no export has ever run on this deployment — nothing to sweep.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Storage export sweep could not read the exports directory', {
          exportDir,
          error: String(error),
        });
      }
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = InfraController.EXPORT_ARCHIVE_PATTERN.exec(entry.name);
      if (!match) continue;
      if (now - Number(match[1]) < maxAgeMs) continue;
      try {
        await fs.promises.unlink(path.join(exportDir, entry.name));
        this.logger.log('Swept stale storage export archive', { file: entry.name });
      } catch (error) {
        this.logger.warn('Failed to sweep stale storage export archive', { file: entry.name, error: String(error) });
      }
    }
  }

  @Get('status')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get infrastructure status' })
  @ApiResponse({ status: 200, description: 'Infrastructure status' })
  async getStatus(): Promise<InfraStatus> {
    // Active DB liveness probe (SELECT 1) on both connections in parallel — not just isInitialized,
    // which stays true after a Postgres backend dies until an explicit .destroy() (see probeDbConnected).
    const [mainDbConnected, dataDbConnected] = await Promise.all([
      this.probeDbConnected(this.mainDataSource),
      this.probeDbConnected(this.dataDataSource),
    ]);
    const dbConnected = mainDbConnected && dataDbConnected;
    const dbType = this.configService.get<string>('dataDatabase.type', 'sqlite');
    const dbHost = this.configService.get<string>('dataDatabase.host', 'localhost');

    const redisHost = process.env.REDIS_HOST || this.configService.get<string>('redis.host', 'localhost');
    const redisPort = parseInt(process.env.REDIS_PORT || '', 10) || this.configService.get<number>('redis.port', 6379);
    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    const queueEnabled = this.configService.get<boolean>('queue.enabled', false);

    // Check actual Redis connectivity via CacheService
    const redisConnected = await this.cacheService.isAvailable();

    const storageType = this.configService.get<'local' | 's3'>('storage.type', 'local');
    // Read the key StorageService actually uses (`storage.localPath`, default `./data/media`).
    // The old `storage.path` key never existed, so status always reported the `./uploads` fallback.
    const storagePath = this.configService.get<string>('storage.localPath', './data/media');
    // In S3 mode the local path is unused; surface the bucket so the status panel shows the real
    // backend. `path` is kept (additive) so the dashboard's local-mode rendering is unchanged.
    const storageBucket = this.configService.get<string>('storage.s3.bucket');

    const engineType = this.configService.get<string>('engine.type', 'whatsapp-web.js');
    // whatsapp-web.js only: surface the actual WhatsApp Web build (not the library version) so the
    // dashboard shows which build is running. Trigger the auto-resolve so the panel is populated even
    // before a session starts; the result is cached, so this is a one-time fetch. (#488)
    let webVersion: string | null | undefined;
    let webVersionSource: 'pinned' | 'auto' | 'native' | undefined;
    if (engineType === 'whatsapp-web.js') {
      // Kick the auto-resolve but DON'T await it — /infra/status is polled frequently and the registry
      // fetch can take up to 5s on a firewalled host. Read whatever's cached now (null until the first
      // success); a later poll reflects the resolved build. (#488 review)
      if (getEffectiveWebVersionInfo().source === 'auto') {
        void resolveCurrentWebVersion().catch(() => undefined);
      }
      const info = getEffectiveWebVersionInfo();
      webVersion = info.version;
      webVersionSource = info.source;
    }
    // configuration.ts nests these under engine.puppeteer.{headless,args}; the old flat
    // engine.headless / engine.browserArgs keys never existed, so status always reported defaults.
    const engineHeadless = this.configService.get<boolean>('engine.puppeteer.headless', true) ?? true;
    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath', './data/sessions');
    const browserArgs =
      this.configService.get<string[]>('engine.puppeteer.args')?.join(' ') || '--no-sandbox --disable-gpu';

    // Built-in detection: prefer the actually-running bundled container as truth (so a stopped/missing
    // container, or a host-pinned external host, reads as NOT built-in), and require the app to be
    // pointed at the bundled service. Fall back to the saved *_BUILTIN intent when Docker is
    // unreachable (bare-npm / socket-less) so the toggles don't spuriously flip off. (#488)
    const s3Endpoint = this.configService.get<string>('storage.s3.endpoint');
    const running = this.dockerService.isDockerAvailable()
      ? await this.dockerService.getRunningBuiltinServices()
      : null;
    const savedBuiltin = this.readSavedBuiltinFlags();
    const dbBuiltIn = running ? running.database && dbHost === 'postgres' : savedBuiltin.database;
    const redisBuiltIn = running ? running.cache && redisHost === 'redis' : savedBuiltin.cache;
    const storageBuiltIn = running ? running.storage && s3Endpoint === 'http://minio:9000' : savedBuiltin.storage;
    // Re-probe (throttled) so a MinIO/S3 that came up after boot is reflected, not latched unreachable.
    const s3Available = storageType === 's3' ? await this.storageService.refreshS3Availability() : undefined;

    // Live webhook-queue depth (the only real queue). pending = waiting + active + delayed. Degrades to
    // zeros when the queue is disabled or Redis is unreachable, so the panel never errors the status read.
    let webhooks = { pending: 0, completed: 0, failed: 0 };
    if (queueEnabled && this.webhookQueue) {
      try {
        const counts = await this.webhookQueue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
        webhooks = {
          pending: (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0),
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        };
      } catch (error) {
        this.logger.warn('Failed to read webhook queue job counts', { error: String(error) });
      }
    }

    return {
      database: { connected: dbConnected, type: dbType, host: dbHost, builtIn: dbBuiltIn },
      redis: {
        enabled: redisEnabled,
        connected: redisConnected,
        host: redisHost,
        port: redisPort,
        builtIn: redisBuiltIn,
      },
      queue: {
        enabled: queueEnabled,
        webhooks,
      },
      storage: {
        type: storageType,
        path: storagePath,
        ...(storageType === 's3' && storageBucket ? { bucket: storageBucket } : {}),
        builtIn: storageBuiltIn,
        ...(storageType === 's3' ? { s3Available } : {}),
      },
      engine: {
        type: engineType,
        headless: engineHeadless,
        sessionDataPath,
        browserArgs,
        ...(engineType === 'whatsapp-web.js' ? { webVersion, webVersionSource } : {}),
      },
    };
  }

  /** Saved built-in intent flags from data/.env.generated — the fallback when Docker isn't reachable. */
  private readSavedBuiltinFlags(): { database: boolean; cache: boolean; storage: boolean } {
    try {
      const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
      const saved: Record<string, string> = fs.existsSync(envPath)
        ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
        : {};
      return {
        database: saved.POSTGRES_BUILTIN === 'true',
        cache: saved.REDIS_BUILTIN === 'true',
        storage: saved.MINIO_BUILTIN === 'true',
      };
    } catch {
      return { database: false, cache: false, storage: false };
    }
  }

  @Get('engines')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get available WhatsApp engines' })
  @ApiResponse({ status: 200, description: 'List of available engines' })
  getEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    return this.engineFactory.getAvailableEngines();
  }

  @Get('engines/current')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get current active engine' })
  @ApiResponse({ status: 200, description: 'Current engine info' })
  getCurrentEngine(): { engineType: string } {
    return { engineType: this.engineFactory.getCurrentEngine() };
  }

  @Get('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Read the saved infrastructure configuration for the dashboard form' })
  @ApiResponse({ status: 200, description: 'Saved configuration (secrets omitted)' })
  getConfig(): SavedConfigResponse {
    const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
    const saved: Record<string, string> = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};

    // Secrets (passwords, S3 keys) are never returned; the form shows a "set" indicator
    // and an empty submission preserves the stored value (see saveConfig). This lets the
    // dashboard hydrate the form so a save no longer overwrites unseen fields (#226).
    return {
      database: {
        type: saved.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite',
        builtIn: saved.POSTGRES_BUILTIN === 'true',
        host: saved.DATABASE_HOST || '',
        port: saved.DATABASE_PORT || '',
        username: saved.DATABASE_USERNAME || '',
        database: saved.DATABASE_NAME || '',
        schema: saved.POSTGRES_SCHEMA || 'public',
        poolSize: Number(saved.DATABASE_POOL_SIZE) || 10,
        sslEnabled: saved.DATABASE_SSL === 'true',
        sslRejectUnauthorized: saved.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        passwordSet: Boolean(saved.DATABASE_PASSWORD),
      },
      redis: {
        enabled: saved.REDIS_ENABLED === 'true',
        builtIn: saved.REDIS_BUILTIN === 'true',
        host: saved.REDIS_HOST || '',
        port: saved.REDIS_PORT || '',
        passwordSet: Boolean(saved.REDIS_PASSWORD),
      },
      queue: { enabled: saved.QUEUE_ENABLED === 'true' },
      storage: {
        type: saved.STORAGE_TYPE === 's3' ? 's3' : 'local',
        builtIn: saved.MINIO_BUILTIN === 'true',
        localPath: saved.STORAGE_LOCAL_PATH || '',
        s3Bucket: saved.S3_BUCKET || '',
        s3Region: saved.S3_REGION || '',
        s3Endpoint: saved.S3_ENDPOINT || '',
        s3CredentialsSet: Boolean(saved.S3_ACCESS_KEY_ID && saved.S3_SECRET_ACCESS_KEY),
      },
      engine: {
        type: saved.ENGINE_TYPE || 'whatsapp-web.js',
        headless: saved.PUPPETEER_HEADLESS !== 'false',
        sessionDataPath: saved.SESSION_DATA_PATH || '',
        browserArgs: saved.PUPPETEER_ARGS || '',
      },
    };
  }

  @Put('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Save infrastructure configuration to .env file' })
  @ApiResponse({ status: 200, description: 'Configuration saved' })
  @ApiBody({ description: 'Configuration to save', type: SaveConfigDto })
  saveConfig(@Body() config: SaveConfigDto): { message: string; saved: boolean; envPath: string; profiles: string[] } {
    try {
      const profiles: string[] = [];

      // Merge into the existing saved config rather than rebuilding from scratch, so a
      // partial payload (the dashboard only sends the sections it renders) cannot wipe
      // keys it didn't include (#226). The merge is per-section AND per-key: an absent
      // section leaves that section's keys alone, and within a present section an absent
      // field (`undefined`) leaves its stored key alone — only values actually submitted
      // are written. `existing` below is therefore the base for every key the payload
      // does not mention.
      const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
      const existing: Record<string, string> = fs.existsSync(envPath)
        ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
        : {};
      const updates: Record<string, string> = {};
      // Keys to remove from the merged result — used to drop stale settings when the
      // user switches mode (postgres->sqlite, s3->local, built-in->external) so a reload
      // never sees the new mode alongside leftover keys from the old one.
      const staleKeys = new Set<string>();

      // Secret values are never echoed back to the form, so an empty submission means
      // "unchanged" — keep whatever is already stored instead of blanking it.
      const setSecret = (key: string, value: string | undefined): void => {
        if (value) updates[key] = value;
      };

      // Database. NOTE: these keys must match what src/config/configuration.ts reads.
      if (config.database) {
        updates.DATABASE_TYPE = config.database.type || 'sqlite';
        if (config.database.builtIn !== undefined) {
          updates.POSTGRES_BUILTIN = config.database.builtIn ? 'true' : 'false';
        }
        // The effective mode: an explicit builtIn wins; when it is absent the saved mode
        // is inherited so a partial payload stays in the current mode instead of silently
        // flipping to external.
        const dbBuiltIn = config.database.builtIn ?? existing.POSTGRES_BUILTIN === 'true';
        if (config.database.type === 'postgres') {
          if (dbBuiltIn) {
            // Built-in PostgreSQL - use container name as host
            updates.DATABASE_HOST = 'postgres';
            updates.DATABASE_PORT = '5432';
            updates.DATABASE_USERNAME = 'openwa';
            // The bundled credential is only the DEFAULT. Secrets are never echoed back to the form,
            // so an absent password field means "unchanged", not "reset to 'openwa'" — and the
            // dashboard ALWAYS sends builtIn, so keying the reset on "explicit builtIn:true" reset a
            // re-keyed container on every save from the Infrastructure page.
            // What decides it is whether the stored password belongs to this same bundled container:
            // it does when the previous mode was already built-in. Coming from external, the stored
            // value is the external DB's credential and must not be carried into the container.
            const storedPassword = existing.POSTGRES_BUILTIN === 'true' ? existing.DATABASE_PASSWORD : undefined;
            updates.DATABASE_PASSWORD = config.database.password || storedPassword || 'openwa';
            updates.DATABASE_NAME = 'openwa';
            // Built-in Postgres is initialized with the default 'public' schema (see
            // scripts/postgres-init-schema.sh). Pin it so a later switch from a custom-schema
            // external DB to built-in doesn't carry a stale POSTGRES_SCHEMA forward.
            updates.POSTGRES_SCHEMA = 'public';
            profiles.push('postgres');
          } else {
            // External PostgreSQL. Flipping built-in -> external must not carry the bundled
            // 'openwa' password into the external config: the production boot guard rejects
            // it, so the next boot would crash-loop. A password in the same payload wins.
            if (
              config.database.builtIn === false &&
              existing.POSTGRES_BUILTIN === 'true' &&
              !config.database.password
            ) {
              staleKeys.add('DATABASE_PASSWORD');
            }
            if (config.database.host !== undefined) updates.DATABASE_HOST = config.database.host || 'localhost';
            if (config.database.port !== undefined) updates.DATABASE_PORT = config.database.port || '5432';
            if (config.database.username !== undefined)
              updates.DATABASE_USERNAME = config.database.username || 'postgres';
            setSecret('DATABASE_PASSWORD', config.database.password);
            if (config.database.database !== undefined) updates.DATABASE_NAME = config.database.database || 'openwa';
            if (config.database.schema !== undefined) updates.POSTGRES_SCHEMA = config.database.schema || 'public';
          }
          if (config.database.poolSize !== undefined) {
            updates.DATABASE_POOL_SIZE = String(config.database.poolSize || 10);
          }
          if (config.database.sslEnabled !== undefined) {
            updates.DATABASE_SSL = config.database.sslEnabled ? 'true' : 'false';
            if (config.database.sslEnabled) {
              // Default to certificate verification; only relax it when the operator opts out
              // (managed Postgres with self-signed certs: Supabase, Heroku, Render, Railway).
              updates.DATABASE_SSL_REJECT_UNAUTHORIZED =
                config.database.sslRejectUnauthorized === false ? 'false' : 'true';
            }
          }
        } else {
          // Switching to sqlite: drop stale postgres connection keys, and reset the built-in
          // flag with them — there is no bundled Postgres backing a SQLite database.
          updates.POSTGRES_BUILTIN = 'false';
          for (const k of [
            'DATABASE_HOST',
            'DATABASE_PORT',
            'DATABASE_USERNAME',
            'DATABASE_PASSWORD',
            'DATABASE_NAME',
            'DATABASE_POOL_SIZE',
            'DATABASE_SSL',
            'DATABASE_SSL_REJECT_UNAUTHORIZED',
            'POSTGRES_SCHEMA',
          ]) {
            staleKeys.add(k);
          }
        }
      }

      // Redis and queue are independent sections: a payload carrying only one of them must
      // not rewrite (or disable) the other's saved keys.
      if (config.redis) {
        if (config.redis.enabled !== undefined) updates.REDIS_ENABLED = config.redis.enabled ? 'true' : 'false';
        if (config.redis.builtIn !== undefined) updates.REDIS_BUILTIN = config.redis.builtIn ? 'true' : 'false';
        if (config.redis.builtIn === true) {
          // Built-in Redis - use container name as host. The bundled container runs without
          // auth, so a password saved by an earlier external setup is stale: leaving it
          // would make the client AUTH against a passwordless server on the next boot.
          updates.REDIS_HOST = 'redis';
          updates.REDIS_PORT = '6379';
          if (!config.redis.password) staleKeys.add('REDIS_PASSWORD');
        } else {
          // External Redis (explicit, or inherited when builtIn is absent)
          if (config.redis.host !== undefined) updates.REDIS_HOST = config.redis.host || 'localhost';
          if (config.redis.port !== undefined) updates.REDIS_PORT = config.redis.port || '6379';
        }
        setSecret('REDIS_PASSWORD', config.redis.password);
        const redisEnabled = config.redis.enabled ?? existing.REDIS_ENABLED === 'true';
        const redisBuiltIn = config.redis.builtIn ?? existing.REDIS_BUILTIN === 'true';
        if (redisEnabled && redisBuiltIn) {
          profiles.push('redis');
        }
      }
      if (config.queue) {
        if (config.queue.enabled !== undefined) updates.QUEUE_ENABLED = config.queue.enabled ? 'true' : 'false';
      }

      // Storage. NOTE: STORAGE_LOCAL_PATH / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
      // the names configuration.ts reads (previously saved as STORAGE_PATH / S3_*_KEY and
      // silently ignored — #226).
      if (config.storage) {
        updates.STORAGE_TYPE = config.storage.type || 'local';
        if (config.storage.builtIn !== undefined) {
          updates.MINIO_BUILTIN = config.storage.builtIn ? 'true' : 'false';
        }
        if (config.storage.type === 'local') {
          // Switching to local: drop stale S3 keys, and reset the built-in flag with them —
          // there is no bundled MinIO backing a local storage path.
          updates.MINIO_BUILTIN = 'false';
          if (config.storage.localPath !== undefined) {
            updates.STORAGE_LOCAL_PATH = config.storage.localPath || './data/media';
          }
          // Switching to local: drop stale S3 keys.
          for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_REGION']) {
            staleKeys.add(k);
          }
        } else if (config.storage.type === 's3') {
          staleKeys.add('STORAGE_LOCAL_PATH');
          if (config.storage.builtIn === true) {
            // Built-in MinIO - use container name as endpoint
            updates.S3_ENDPOINT = 'http://minio:9000';
            updates.S3_ACCESS_KEY_ID = 'minioadmin';
            updates.S3_SECRET_ACCESS_KEY = 'minioadmin';
            updates.S3_BUCKET = 'openwa';
            updates.S3_REGION = 'us-east-1';
            profiles.push('minio');
          } else {
            // External S3/MinIO. Flipping built-in -> external must not carry the bundled
            // 'minioadmin' credentials or the internal endpoint into the external config:
            // the production boot guard rejects those credentials (crash-loop), and a stale
            // MinIO endpoint would send AWS-bound traffic to the wrong host. Values in the
            // same payload win.
            if (config.storage.builtIn === false && existing.MINIO_BUILTIN === 'true') {
              if (!config.storage.s3AccessKey) staleKeys.add('S3_ACCESS_KEY_ID');
              if (!config.storage.s3SecretKey) staleKeys.add('S3_SECRET_ACCESS_KEY');
              if (!config.storage.s3Endpoint) staleKeys.add('S3_ENDPOINT');
            }
            if (config.storage.s3Bucket !== undefined) updates.S3_BUCKET = config.storage.s3Bucket;
            if (config.storage.s3Region !== undefined) updates.S3_REGION = config.storage.s3Region || 'ap-southeast-1';
            setSecret('S3_ACCESS_KEY_ID', config.storage.s3AccessKey);
            setSecret('S3_SECRET_ACCESS_KEY', config.storage.s3SecretKey);
            if (config.storage.s3Endpoint !== undefined) {
              // Unlike the credentials, the endpoint IS echoed back to the form, so an empty
              // submission is a real "clear it" (moving to the default AWS endpoint), not
              // "unchanged" — leaving a stale MinIO endpoint behind would silently keep
              // pointing S3 traffic at the old host.
              if (config.storage.s3Endpoint) {
                updates.S3_ENDPOINT = config.storage.s3Endpoint;
              } else {
                staleKeys.add('S3_ENDPOINT');
              }
            }
          }
        }
      }

      // Engine. NOTE: PUPPETEER_HEADLESS / SESSION_DATA_PATH / PUPPETEER_ARGS are the names
      // configuration.ts reads (previously saved as ENGINE_* and silently ignored — #226).
      if (config.engine) {
        // Persist the selected engine so the Infrastructure tile can actually switch engines (the
        // active engine was previously only settable via the ENGINE_TYPE env, never from the UI).
        if (config.engine.type) {
          const validEngineIds = this.engineFactory.getAvailableEngines().map(e => e.id);
          if (!validEngineIds.includes(config.engine.type)) {
            throw new BadRequestException(`Unknown engine type: ${config.engine.type}`);
          }
          updates.ENGINE_TYPE = config.engine.type;
        }
        if (config.engine.headless !== undefined) {
          updates.PUPPETEER_HEADLESS = config.engine.headless ? 'true' : 'false';
        }
        if (config.engine.sessionDataPath !== undefined) {
          updates.SESSION_DATA_PATH = config.engine.sessionDataPath || './data/sessions';
        }
        if (config.engine.browserArgs !== undefined) {
          // Must match configuration.ts's PUPPETEER_ARGS default (4 flags). Once compose blank-forwards
          // PUPPETEER_ARGS, this saved value wins at runtime — a 2-flag default here would silently drop
          // --disable-dev-shm-usage (the Docker /dev/shm tab-crash guard) after any Infrastructure save.
          updates.PUPPETEER_ARGS =
            config.engine.browserArgs || '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu';
        }
      }

      // .env.generated is one KEY=value per line, loaded on the next boot. A value carrying a
      // line break would write a second line and inject an arbitrary env var the operator never
      // set, so refuse any such value before writing anything.
      for (const [key, value] of Object.entries(updates)) {
        if (/[\r\n]/.test(value)) {
          throw new BadRequestException(`Invalid configuration value for ${key}: line breaks are not allowed`);
        }
      }

      // Existing values are the base; this payload's values win (secrets handled above).
      const merged: Record<string, string> = { ...existing, ...updates };
      // Drop keys made obsolete by a mode switch (postgres->sqlite, s3->local, built-in->external).
      for (const k of staleKeys) {
        delete merged[k];
      }

      // Save-time production guard. The file is loaded on the NEXT boot, which may run with
      // NODE_ENV=production regardless of this process's environment — so evaluate the merged
      // result with the very same boot guard (as production) and refuse the save when that boot
      // would refuse to start. This is what stops a built-in->external flip with no fresh
      // credentials from persisting a config that crash-loops the next production boot.
      // Evaluate what that boot would actually SEE, not just what the file holds: load-env.ts
      // loads with dotenv override:false, so a value supplied via the container environment
      // (compose `environment:`) wins over this file — the precedence the file header documents.
      // Without that, a deployment providing DATABASE_PASSWORD & co. through the environment is
      // refused on EVERY save even though its boot passes the guard. A blank compose-forwarded
      // value counts as unset exactly like clearBlankEnv treats it at boot.
      //
      // Only a HOST-supplied key may win. load-env also merges .env and data/.env.generated into
      // process.env, so reading process.env alone would hand back the very file this save is
      // replacing — the guard would then bless a flip by validating the OLD config (a built-in ->
      // external switch keeping the bundled 'openwa' password would save cleanly and crash-loop the
      // next production boot, the exact case this guard exists for). isOsProvidedEnv separates the
      // two using the snapshot load-env takes before either file is loaded.
      const bootValue = (key: string): string | undefined => {
        const envValue = isOsProvidedEnv(key) ? process.env[key] : undefined;
        if (envValue !== undefined && (envValue.trim() !== '' || !BLANK_SHADOWED_ENV_KEYS.includes(key))) {
          return envValue;
        }
        return merged[key];
      };
      try {
        assertNoDefaultSecretsInProduction({
          nodeEnv: 'production',
          databaseType: bootValue('DATABASE_TYPE'),
          databasePassword: bootValue('DATABASE_PASSWORD'),
          postgresBuiltIn: bootValue('POSTGRES_BUILTIN'),
          databaseHost: bootValue('DATABASE_HOST'),
          storageType: bootValue('STORAGE_TYPE'),
          s3AccessKey: bootValue('S3_ACCESS_KEY_ID'),
          s3SecretKey: bootValue('S3_SECRET_ACCESS_KEY'),
          s3Endpoint: bootValue('S3_ENDPOINT'),
          minioBuiltIn: bootValue('MINIO_BUILTIN'),
          redisPassword: bootValue('REDIS_PASSWORD'),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new BadRequestException(
          `Refusing to save a configuration that would be rejected at production boot. ${detail}`,
        );
      }
      const body = Object.keys(merged)
        .sort()
        .map(key => `${key}=${merged[key]}`);
      const contents = [
        '# OpenWA Configuration',
        `# Generated at ${new Date().toISOString()}`,
        '# Managed via Dashboard > Infrastructure. Values in process env or project .env take precedence.',
        '',
        ...body,
        '',
      ].join('\n');

      // Write to data/ so it persists across container restarts. Owner-only (0600): this file holds
      // the DB/S3/Redis credentials, so it must not be world-readable between save and next restart.
      writeSecretFile(envPath, contents);
      this.logger.log('Configuration saved', { envPath });

      // Audit the credential-bearing env mutation. Fire-and-forget (not awaited) so saveConfig stays
      // synchronous — its validation rejections must remain synchronous throws the tests assert via
      // `.toThrow`. Only section names + Docker profiles are recorded; secret values are never logged.
      void this.auditService?.logInfo(AuditAction.INFRA_CONFIG_SAVED, {
        metadata: { sections: Object.keys(config ?? {}), profiles },
      });

      const profileMsg = profiles.length > 0 ? ` Docker profiles required: ${profiles.join(', ')}.` : '';

      return {
        message: `Configuration saved successfully.${profileMsg} Server restart required to apply changes.`,
        saved: true,
        // Return a cwd-relative path so the response doesn't disclose the absolute host filesystem layout.
        envPath: path.relative(process.cwd(), envPath),
        profiles,
      };
    } catch (error) {
      // A validation rejection (unknown engine type, or a newline-injected value) is a BadRequestException
      // and MUST surface as its real 4xx status, not be masked as an HTTP 200 {saved:false} — a client
      // branching on HTTP status alone would otherwise treat rejected input as success. Re-throw any
      // HttpException so the Nest layer maps it. A non-HTTP failure (e.g. a writeSecretFile disk/permission
      // error) stays a {saved:false} 200, preserving the dashboard's body.saved handling for I/O faults.
      if (error instanceof HttpException) {
        throw error;
      }
      return {
        message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        saved: false,
        envPath: '',
        profiles: [],
      };
    }
  }
  @Post('restart')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Request server restart with Docker orchestration' })
  @ApiResponse({ status: 200, description: 'Server will restart with new profiles' })
  @ApiBody({ required: false, type: RestartDto })
  async requestRestart(@Body() body?: RestartDto): Promise<{
    message: string;
    restarting: boolean;
    profiles: string[];
    profilesToRemove: string[];
    estimatedTime: number;
    orchestration?: object;
    removal?: object;
  }> {
    const profiles = body?.profiles || [];
    const profilesToRemove = body?.profilesToRemove || [];
    let orchestrationResult: object | undefined;
    // Teardown is stop-only (see DockerService.stopManagedService): containers are stopped and
    // retained for re-enable, never deleted — the result below reports exactly that.
    let removalResult: { stopped: string[]; errors: string[] } | undefined;

    this.logger.log('Restart requested', { profiles });
    this.logger.log('Profiles to remove', { profilesToRemove });

    // If profiles are specified, orchestrate Docker containers
    if (this.dockerService.isDockerAvailable()) {
      // Remove only the profiles the Save flow explicitly asked to remove, and never one we're about to
      // (re)start. We deliberately do NOT infer teardown from the saved *_BUILTIN flag: the default
      // data/.env.generated carries POSTGRES_BUILTIN=false, so a bare compose-profile restart would
      // otherwise tear down the very backend the app is running on. (Known minor limitation: switching
      // away from a built-in backend and then reloading the page before restarting can leave the old
      // container running until the next explicit change.)
      // Only ever tear down OpenWA-managed services. An arbitrary profile name (or the empty string)
      // would otherwise reach stopManagedService and, via container-name matching, could stop an unrelated
      // container — so constrain teardown to the managed allowlist and drop anything else.
      const requested = profilesToRemove.filter(p => !profiles.includes(p));
      const toRemove = requested.filter(p => MANAGED_DOCKER_PROFILES.includes(p));
      const ignored = requested.filter(p => !MANAGED_DOCKER_PROFILES.includes(p));
      if (ignored.length > 0) {
        this.logger.warn('Ignoring non-managed profiles in profilesToRemove', { ignored });
      }

      // First, stop containers for disabled services (stop-only: retained, never deleted)
      if (toRemove.length > 0) {
        this.logger.log('Stopping disabled profiles (containers retained)...', { toRemove });
        removalResult = { stopped: [], errors: [] };

        for (const profile of toRemove) {
          try {
            const success = await this.dockerService.stopManagedService(profile);
            if (success) {
              removalResult.stopped.push(profile);
            } else {
              removalResult.errors.push(`Failed to stop ${profile}`);
            }
          } catch (err) {
            removalResult.errors.push(`Error stopping ${profile}: ${err}`);
          }
        }
        this.logger.log('Teardown result', { removalResult });
      }

      // Then, start containers for enabled services. Start shares the SAME managed allowlist as
      // teardown above: a non-managed name reaching orchestrateProfiles could, via container-name
      // matching, select an unrelated host container, so constrain start to the managed profiles too
      // and drop anything else. (DockerService already hard-prefixes openwa-<service> and filters on
      // the com.openwa.service label, so this is defense-in-depth, not the sole control.)
      const toStart = profiles.filter(p => MANAGED_DOCKER_PROFILES.includes(p));
      const ignoredStart = profiles.filter(p => !MANAGED_DOCKER_PROFILES.includes(p));
      if (ignoredStart.length > 0) {
        this.logger.warn('Ignoring non-managed profiles in profiles', { ignoredStart });
      }
      if (toStart.length > 0) {
        this.logger.log('Orchestrating enabled profiles...');
        orchestrationResult = await this.dockerService.orchestrateProfiles(toStart);
        this.logger.log('Orchestration result', { orchestrationResult });
      }
    } else {
      this.logger.warn('Docker not available, writing signal file instead');
      // Fallback: write signal file for host script — but apply the SAME managed-profile
      // constraint as the Docker path above: the external consumer of this file must never be
      // handed a profile name the in-process path would have refused.
      try {
        const signalFile = path.resolve(process.cwd(), 'data', '.orchestration-request.json');
        const toStart = profiles.filter(p => MANAGED_DOCKER_PROFILES.includes(p));
        const toRemove = profilesToRemove.filter(p => !profiles.includes(p) && MANAGED_DOCKER_PROFILES.includes(p));
        const ignored = [...profiles, ...profilesToRemove].filter(p => !MANAGED_DOCKER_PROFILES.includes(p));
        if (ignored.length > 0) {
          this.logger.warn('Ignoring non-managed profiles in the signal-file request', { ignored });
        }
        const orchestrationRequest = {
          timestamp: new Date().toISOString(),
          profiles: toStart,
          profilesToRemove: toRemove,
          action: 'restart-with-profiles',
        };
        fs.writeFileSync(signalFile, JSON.stringify(orchestrationRequest, null, 2), 'utf8');
        this.logger.log('Orchestration request written', { signalFile });
      } catch (err) {
        this.logger.error('Failed to write orchestration request', err instanceof Error ? err.message : String(err));
      }
    }

    // Record the operational action (Docker orchestration + scheduled restart) BEFORE starting the
    // shutdown, awaited so the row is persisted even as the process goes down.
    await this.auditService?.logInfo(AuditAction.INFRA_RESTART_REQUESTED, {
      metadata: { profiles, profilesToRemove },
    });

    // Schedule graceful shutdown after the configurable bounded grace (SHUTDOWN_DELAY_MS,
    // default 3s) — readiness reports 503 during the window so traffic drains first.
    void this.shutdownService.shutdown();

    // Calculate estimated time - base 15s + additional for each service (increased for reliability)
    let estimatedTime = 15;
    if (profiles.includes('postgres')) estimatedTime += 20;
    if (profiles.includes('redis')) estimatedTime += 13;
    if (profiles.includes('minio')) estimatedTime += 15;
    if (profilesToRemove.length > 0) estimatedTime += profilesToRemove.length * 5; // +5s per removal

    return {
      message:
        profiles.length > 0 || profilesToRemove.length > 0
          ? `Server is restarting. Enabling: ${profiles.join(', ') || 'none'}. Disabling: ${profilesToRemove.join(', ') || 'none'}.`
          : 'Server is restarting. Please wait...',
      restarting: true,
      profiles,
      profilesToRemove,
      estimatedTime,
      orchestration: orchestrationResult,
      removal: removalResult,
    };
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Server is healthy' })
  healthCheck(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('export-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all data from Data DB for migration' })
  @ApiResponse({ status: 200, description: 'Exported data as JSON' })
  async exportData(): Promise<{
    exportedAt: string;
    dataDbType: string;
    tables: MigrationTables;
    counts: {
      sessions: number;
      webhooks: number;
      messages: number;
      messageBatches: number;
      templates: number;
      baileysStoredMessages: number;
      lidMappings: number;
      pluginInstances: number;
      conversationMappings: number;
      ingressEvents: number;
      webhookDeliveryFailures: number;
      integrationDeliveryFailures: number;
      statusUpdates: number;
    };
    /** Optional tables that were skipped because they genuinely do not exist in this DB (older schema). */
    skippedTables: string[];
  }> {
    // Get all entities from Data DB
    const sessions = await this.dataDataSource.query<SessionRow[]>('SELECT * FROM sessions');
    const webhooks = await this.dataDataSource.query<WebhookRow[]>('SELECT * FROM webhooks');

    // The tables below may legitimately not exist yet (created by migrations an older DB has not run).
    // Only a GENUINE missing-table error (isMissingTableError) may be tolerated — anything else (lock,
    // I/O, timeout, aborted connection) must FAIL the export. The old blind `catch { debug-log }`
    // pattern reported those as "table is empty", producing a 200 "complete" backup that was actually
    // partial — which the import then treated as authoritative and DELETEd the missing tables' rows.
    // A skipped table is surfaced in `skippedTables` (and logged as a warning) so an operator can tell
    // "not migrated yet" apart from "exported empty".
    const skippedTables: string[] = [];
    const queryOptionalTable = async <T>(table: string): Promise<T[]> => {
      try {
        return await this.dataDataSource.query<T[]>(`SELECT * FROM ${table}`);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
        skippedTables.push(table);
        this.logger.warn('Optional table does not exist in this DB; exporting without it', { table });
        return [];
      }
    };

    const messages = await queryOptionalTable<MessageRow>('messages');
    // Postgres carries a STORED generated tsvector column `body_ts` (FTS) that `SELECT *` picks up.
    // It is a server-maintained index artifact, not payload: strip it so backups stay dialect-neutral
    // (and small). The import's explicit column list already ignores it in older archives.
    for (const row of messages) {
      delete row.body_ts;
    }
    const messageBatches = await queryOptionalTable<MessageBatchRow>('message_batches');
    const templates = await queryOptionalTable<TemplateRow>('templates');
    const baileysStoredMessages = await queryOptionalTable<BaileysStoredMessageRow>('baileys_stored_messages');
    const lidMappings = await queryOptionalTable<LidMappingRow>('lid_mappings');
    // Integration Fabric + both DLQs were added after the original migration set; tolerate a genuinely
    // absent table (older DB) like the tables above rather than 500-ing the whole export.
    const pluginInstances = await queryOptionalTable<PluginInstanceRow>('plugin_instances');
    const conversationMappings = await queryOptionalTable<ConversationMappingRow>('conversation_mappings');
    const ingressEvents = await queryOptionalTable<IngressEventRow>('ingress_events');
    const webhookDeliveryFailures = await queryOptionalTable<WebhookDeliveryFailureRow>('webhook_delivery_failures');
    const integrationDeliveryFailures = await queryOptionalTable<IntegrationDeliveryFailureRow>(
      'integration_delivery_failures',
    );
    const statusUpdates = await queryOptionalTable<StatusUpdateRow>('status_updates');

    const counts = {
      sessions: sessions.length,
      webhooks: webhooks.length,
      messages: messages.length,
      messageBatches: messageBatches.length,
      templates: templates.length,
      baileysStoredMessages: baileysStoredMessages.length,
      lidMappings: lidMappings.length,
      pluginInstances: pluginInstances.length,
      conversationMappings: conversationMappings.length,
      ingressEvents: ingressEvents.length,
      webhookDeliveryFailures: webhookDeliveryFailures.length,
      integrationDeliveryFailures: integrationDeliveryFailures.length,
      statusUpdates: statusUpdates.length,
    };

    // Audit the full-DB export: this payload carries webhook + plugin-instance secrets, so WHO pulled
    // a dump (and the per-table row counts) is exactly the trail C002 was missing. Data itself is never
    // logged — only counts.
    await this.auditService?.logInfo(AuditAction.INFRA_DATA_EXPORTED, { metadata: { counts } });

    return {
      exportedAt: new Date().toISOString(),
      dataDbType: this.configService.get<string>('dataDatabase.type', 'sqlite'),
      tables: {
        sessions,
        webhooks,
        messages,
        messageBatches,
        templates,
        baileysStoredMessages,
        lidMappings,
        pluginInstances,
        conversationMappings,
        ingressEvents,
        webhookDeliveryFailures,
        integrationDeliveryFailures,
        statusUpdates,
      },
      counts,
      skippedTables,
    };
  }

  @Post('import-data')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  @ApiBody({
    description: 'Exported data from export-data endpoint',
    schema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'Allow the replace to proceed even while engines are running for sessions the backup does not contain (they keep running until restart; see restartRequired). Prefer stopOrphans, which closes that window inside this request instead.',
        },
        stopOrphans: {
          type: 'boolean',
          description:
            'Stop the running engines for sessions the backup does not contain, inside this request and before the replace runs. Supersedes force for the orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so restartRequired stays false on the success path.',
        },
        tables: {
          type: 'object',
          properties: {
            sessions: { type: 'array' },
            webhooks: { type: 'array' },
            messages: { type: 'array' },
            messageBatches: { type: 'array' },
            statusUpdates: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Data imported successfully' })
  @ApiResponse({
    status: 409,
    description:
      'Refused: live engines exist for sessions the backup would remove (retry with stopOrphans=true to stop them in-request, or force=true to proceed and restart after)',
  })
  async importData(
    @Body()
    data: {
      tables: Partial<MigrationTables>;
      force?: boolean;
      /**
       * Stop the running engines for sessions the backup does not contain, inside this request and
       * before the replace runs (best-effort, time-bounded per engine). Supersedes force=true for the
       * orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so
       * restartRequired stays false on the success path. Without it the pre-existing behavior holds —
       * refuse with 409, or proceed with force=true and leave the engines running until restart.
       */
      stopOrphans?: boolean;
    },
  ): Promise<{
    imported: boolean;
    counts: {
      sessions: number;
      webhooks: number;
      messages: number;
      messageBatches: number;
      templates: number;
      baileysStoredMessages: number;
      lidMappings: number;
      pluginInstances: number;
      conversationMappings: number;
      ingressEvents: number;
      webhookDeliveryFailures: number;
      integrationDeliveryFailures: number;
      statusUpdates: number;
    };
    warnings: string[];
    /**
     * Non-fatal operator-facing messages (e.g. orphan-engine reconciliation details). Distinct from
     * warnings: notices never cause a rollback, while warnings make the replace-rollback gate fire.
     */
    notices: string[];
    /** True when live engines were left pointing at sessions this restore removed — restart to stop them. */
    restartRequired: boolean;
    /** Session ids with a running engine that the restored data no longer contains. */
    orphanedEngines: string[];
    /** Orphan engines stopped inside this request (only populated when stopOrphans=true was passed). */
    stoppedOrphanEngines: string[];
    /** Orphan engines whose teardown threw or timed out (Map reconciled regardless; investigate). */
    failedOrphanEngines: string[];
  }> {
    const warnings: string[] = [];

    // Runtime reconciliation, part 1 (pre-flight): the replace below DELETES every session not in the
    // backup, but an engine started for such a session keeps running as an unstoppable zombie (the
    // session service keys engines by session id, and every stop path goes through the now-missing DB
    // row) whose inbound messages land in tables that were just replaced. Three operator-chosen paths:
    //   - default: refuse with 409 listing the orphan ids;
    //   - force=true: proceed and leave the engines running until process restart (restartRequired=true);
    //   - stopOrphans=true: stop each orphan engine inside this request (best-effort, time-bounded,
    //     isolated per engine) and then proceed — restartRequired stays false on the success path.
    // stopOrphans is preferred over force for the orphan case: a force restore that silently leaves
    // engines writing into the freshly replaced tables for an unbounded time is the corruption this
    // gate exists to prevent, so the explicit-stop path closes that window instead of relying on the
    // operator to restart promptly.
    const importedSessionIds = new Set((data.tables.sessions ?? []).map(s => s.id));
    const orphanedEngines = (this.sessionService?.getActiveSessionIds() ?? []).filter(
      id => !importedSessionIds.has(id),
    );

    let stoppedOrphanEngines: string[] = [];
    let failedOrphanEngines: string[] = [];
    let restartRequired = false;

    // notices collect non-fatal operator-facing messages (orphan-engine reconciliation details) that
    // must NOT trip the warnings→rollback gate further down. warnings is reserved for per-row import
    // failures that make the replace partial and therefore require a rollback.
    const notices: string[] = [];

    if (orphanedEngines.length > 0 && data.stopOrphans && this.sessionService) {
      // Stop the orphans inside this request, BEFORE the transaction opens. destroyEngineSafely's
      // per-engine 10s deadline bounds the worst case (a stuck Chromium cannot wedge the import); the
      // engines are reconciled from the Map regardless of teardown outcome.
      const result = await this.sessionService.stopOrphanEngines(orphanedEngines);
      stoppedOrphanEngines = result.stopped;
      failedOrphanEngines = result.failed;
      if (failedOrphanEngines.length > 0) {
        // Teardown failed for at least one orphan. The Map entry is removed regardless (see
        // stopOrphanEngines), so the engine no longer holds a concurrency slot — but its underlying
        // Chromium/socket may still be alive and writing into restored tables. Surface the ids and
        // flag restartRequired so the operator does not read a clean response as "engines stopped".
        restartRequired = true;
        notices.push(
          `Teardown failed for ${failedOrphanEngines.length} orphan engine(s): ${failedOrphanEngines.join(', ')} ` +
            `(removed from the engine registry; a process restart guarantees cleanup).`,
        );
      }
      // Engines still mid-initialization (no Map entry yet) are reported in notRunning: their start()
      // self-aborts via the stop mark, but they are not counted as stopped here.
      if (result.notRunning.length > 0) {
        notices.push(
          `${result.notRunning.length} orphan session(s) had no live engine yet (still initializing): ` +
            `${result.notRunning.join(', ')} — their start() will self-abort.`,
        );
      }
    } else if (orphanedEngines.length > 0 && !data.force) {
      throw new ConflictException(
        `Import would orphan ${orphanedEngines.length} running engine(s) for session(s) ` +
          `${orphanedEngines.join(', ')} that the backup does not contain. Stop them first, retry with ` +
          `stopOrphans=true (stops them inside this request), or retry with force=true ` +
          `(a server restart is then required to stop the orphaned engines).`,
      );
    } else if (orphanedEngines.length > 0 && data.force) {
      // Legacy escape hatch: proceed and leave the engines running until restart.
      restartRequired = true;
    }

    const queryRunner = this.dataDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Clear existing data (in correct order due to foreign keys). templates and
      // baileys_stored_messages FK sessions ON DELETE CASCADE, so the sessions DELETE would clear
      // them too; clearing them explicitly first keeps the order correct on engines where the
      // cascade is not enforced. Tolerate a genuinely-absent table (isMissingTableError) but let any
      // OTHER failure (lock, I/O, aborted tx) propagate to the transaction rollback below — a blind
      // `.catch(() => {})` here could otherwise silently commit a MERGED (not replaced) restore on
      // SQLite, violating the endpoint's "replaces existing data" contract.
      const clearTable = async (table: string): Promise<void> => {
        try {
          await queryRunner.query(`DELETE FROM ${table}`);
        } catch (err) {
          if (!isMissingTableError(err)) throw err;
          this.logger.debug('Skipped clearing a table that does not exist during import', { table });
        }
      };
      // The INSERTs below are written once, in Postgres' `$N` placeholder form. better-sqlite3 differs
      // from the legacy sqlite3 driver on raw queries in two ways: SQLite parses `$N` as a NAMED
      // parameter, which cannot be bound from the positional array TypeORM passes through (RangeError),
      // and strict binding rejects booleans/undefined — which a Postgres-made backup carries (real
      // booleans survive the JSON round-trip). Postgres needs `$N` and binds booleans natively, so both
      // rewrites apply only on the SQLite path. Safe: every `$N` below occurs once, in ascending order.
      const isPostgres = this.dataDataSource.options.type === 'postgres';
      const insert = (text: string, params: unknown[]): Promise<unknown> =>
        queryRunner.query(
          isPostgres ? text : text.replace(/\$\d+/g, '?'),
          isPostgres ? params : params.map(v => (typeof v === 'boolean' ? Number(v) : (v ?? null))),
        );
      await queryRunner.query('DELETE FROM webhooks');
      await clearTable('messages');
      await clearTable('message_batches');
      await clearTable('templates');
      await clearTable('baileys_stored_messages');
      // lid_mappings is not a FK to sessions, so the sessions DELETE below won't clear it; clear it
      // explicitly so a restore replaces the cache rather than colliding on existing lid PKs.
      await clearTable('lid_mappings');
      // Integration Fabric + both DLQs: none carry an FK constraint to sessions (sessionId is provenance),
      // so clearing them here before the sessions DELETE keeps the replace-semantics complete.
      await clearTable('plugin_instances');
      await clearTable('conversation_mappings');
      await clearTable('ingress_events');
      await clearTable('webhook_delivery_failures');
      await clearTable('integration_delivery_failures');
      // status_updates has no FK to sessions; clear it explicitly so the replace is complete.
      await clearTable('status_updates');
      await queryRunner.query('DELETE FROM sessions');

      // Import sessions first
      let sessionsCount = 0;
      if (data.tables.sessions?.length) {
        for (const session of data.tables.sessions) {
          // A session name becomes the engine auth-directory key, so an unvalidated imported name (this
          // path bypasses CreateSessionDto) could traverse the filesystem. Skip + warn instead of
          // throwing, so one bad row doesn't 500 the whole restore.
          if (!isSafeSessionName(session.name)) {
            warnings.push(`Skipped session ${session.id}: unsafe name ${JSON.stringify(session.name)}`);
            continue;
          }
          try {
            await insert(
              `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                session.id,
                session.name,
                session.status,
                session.phone,
                session.pushName,
                typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
                session.proxyUrl,
                session.proxyType,
                session.connectedAt,
                session.lastActiveAt,
                session.createdAt,
                session.updatedAt,
              ],
            );
            sessionsCount++;
          } catch (err) {
            warnings.push(`Failed to import session ${session.id}: ${err}`);
          }
        }
      }

      // Import webhooks
      let webhooksCount = 0;
      if (data.tables.webhooks?.length) {
        for (const webhook of data.tables.webhooks) {
          try {
            await insert(
              `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                webhook.id,
                webhook.sessionId,
                webhook.url,
                typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
                webhook.secret,
                typeof webhook.headers === 'string' ? webhook.headers : JSON.stringify(webhook.headers || {}),
                webhook.filters == null
                  ? null
                  : typeof webhook.filters === 'string'
                    ? webhook.filters
                    : JSON.stringify(webhook.filters),
                webhook.active,
                webhook.retryCount,
                webhook.lastTriggeredAt,
                webhook.createdAt,
                webhook.updatedAt,
              ],
            );
            webhooksCount++;
          } catch (err) {
            warnings.push(`Failed to import webhook ${webhook.id}: ${err}`);
          }
        }
      }

      // Import messages (optional)
      let messagesCount = 0;
      if (data.tables.messages?.length) {
        for (const msg of data.tables.messages) {
          try {
            await insert(
              `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "chatName", author, "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [
                msg.id,
                msg.sessionId,
                msg.waMessageId ?? null,
                msg.chatId,
                msg.chatName ?? null,
                // Rows exported before the author column existed simply restore to NULL (legacy
                // behavior) instead of failing the whole import on an unknown key.
                msg.author ?? null,
                msg.from,
                msg.to,
                msg.body ?? null,
                msg.type,
                msg.direction,
                msg.timestamp ?? null,
                msg.metadata == null
                  ? null
                  : typeof msg.metadata === 'string'
                    ? msg.metadata
                    : JSON.stringify(msg.metadata),
                msg.status,
                msg.createdAt,
              ],
            );
            messagesCount++;
          } catch (err) {
            warnings.push(`Failed to import message ${msg.id}: ${err}`);
          }
        }
      }

      // Import message batches (optional)
      let messageBatchesCount = 0;
      if (data.tables.messageBatches?.length) {
        for (const batch of data.tables.messageBatches) {
          try {
            await insert(
              `INSERT INTO message_batches (id, batch_id, session_id, status, messages, options, progress, results, current_index, created_at, updated_at, started_at, completed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                batch.id,
                batch.batch_id,
                batch.session_id,
                batch.status,
                typeof batch.messages === 'string' ? batch.messages : JSON.stringify(batch.messages ?? []),
                batch.options == null
                  ? null
                  : typeof batch.options === 'string'
                    ? batch.options
                    : JSON.stringify(batch.options),
                batch.progress == null
                  ? null
                  : typeof batch.progress === 'string'
                    ? batch.progress
                    : JSON.stringify(batch.progress),
                batch.results == null
                  ? null
                  : typeof batch.results === 'string'
                    ? batch.results
                    : JSON.stringify(batch.results),
                batch.current_index,
                batch.created_at,
                batch.updated_at,
                batch.started_at,
                batch.completed_at,
              ],
            );
            messageBatchesCount++;
          } catch (err) {
            warnings.push(`Failed to import message batch ${batch.id}: ${err}`);
          }
        }
      }

      // Import templates (optional; FK -> sessions, restored above)
      let templatesCount = 0;
      if (data.tables.templates?.length) {
        for (const tpl of data.tables.templates) {
          try {
            await insert(
              `INSERT INTO templates (id, "sessionId", name, body, header, footer, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                tpl.id,
                tpl.sessionId,
                tpl.name,
                tpl.body,
                tpl.header ?? null,
                tpl.footer ?? null,
                tpl.createdAt,
                tpl.updatedAt,
              ],
            );
            templatesCount++;
          } catch (err) {
            warnings.push(`Failed to import template ${tpl.id}: ${err}`);
          }
        }
      }

      // Import baileys stored messages (optional; FK -> sessions, restored above)
      let baileysStoredMessagesCount = 0;
      if (data.tables.baileysStoredMessages?.length) {
        for (const bsm of data.tables.baileysStoredMessages) {
          try {
            await insert(
              `INSERT INTO baileys_stored_messages (id, "sessionId", "waMessageId", "serializedMessage", "createdAt")
               VALUES ($1, $2, $3, $4, $5)`,
              [bsm.id, bsm.sessionId, bsm.waMessageId, bsm.serializedMessage, bsm.createdAt],
            );
            baileysStoredMessagesCount++;
          } catch (err) {
            warnings.push(`Failed to import baileys stored message ${bsm.id}: ${err}`);
          }
        }
      }

      // Import lid mappings (optional; not a FK, restored as a standalone cache table)
      let lidMappingsCount = 0;
      if (data.tables.lidMappings?.length) {
        for (const lm of data.tables.lidMappings) {
          try {
            await insert(`INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt") VALUES ($1, $2, $3, $4)`, [
              lm.lid,
              lm.phone ?? null,
              lm.sessionId ?? null,
              lm.updatedAt,
            ]);
            lidMappingsCount++;
          } catch (err) {
            warnings.push(`Failed to import lid mapping ${lm.lid}: ${err}`);
          }
        }
      }

      // Import plugin instances (Integration Fabric config + ingress HMAC secret)
      let pluginInstancesCount = 0;
      if (data.tables.pluginInstances?.length) {
        for (const pi of data.tables.pluginInstances) {
          try {
            await insert(
              `INSERT INTO plugin_instances (id, "pluginId", "instanceId", "sessionScope", secret, "verifyToken", config, enabled, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                pi.id,
                pi.pluginId,
                pi.instanceId,
                pi.sessionScope,
                pi.secret,
                pi.verifyToken,
                pi.config == null ? null : typeof pi.config === 'string' ? pi.config : JSON.stringify(pi.config),
                pi.enabled,
                pi.createdAt,
                pi.updatedAt,
              ],
            );
            pluginInstancesCount++;
          } catch (err) {
            warnings.push(`Failed to import plugin instance ${pi.id}: ${err}`);
          }
        }
      }

      // Import conversation mappings (handover state; sessionId is non-FK provenance)
      let conversationMappingsCount = 0;
      if (data.tables.conversationMappings?.length) {
        for (const cm of data.tables.conversationMappings) {
          try {
            await insert(
              `INSERT INTO conversation_mappings (id, "sessionId", "chatId", "pluginId", "instanceId", "providerConversationId", "handoverState", metadata, "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                cm.id,
                cm.sessionId,
                cm.chatId,
                cm.pluginId,
                cm.instanceId,
                cm.providerConversationId,
                cm.handoverState,
                cm.metadata == null
                  ? null
                  : typeof cm.metadata === 'string'
                    ? cm.metadata
                    : JSON.stringify(cm.metadata),
                cm.updatedAt,
              ],
            );
            conversationMappingsCount++;
          } catch (err) {
            warnings.push(`Failed to import conversation mapping ${cm.id}: ${err}`);
          }
        }
      }

      // Import ingress events (durable inbound dedup oracle; payload is JSON). The dispatch-lifecycle
      // columns ride along: dropping them would strand a restored 'pending' row (NULL dispatchState is
      // never swept by the reconciler) while its dedup key still blocks the provider's retry. Columns
      // absent from a pre-lifecycle backup import as NULL/0 — the same "not watched" reading legacy
      // rows have by design. dispatchAttempts is NOT NULL, so it coalesces to 0 rather than NULL.
      let ingressEventsCount = 0;
      if (data.tables.ingressEvents?.length) {
        for (const ie of data.tables.ingressEvents) {
          try {
            await insert(
              `INSERT INTO ingress_events (id, "instanceId", "pluginId", "providerDeliveryId", route, payload, "payloadHash", "sessionId", "dispatchState", "dispatchAttempts", "lastDispatchAt", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                ie.id,
                ie.instanceId,
                ie.pluginId,
                ie.providerDeliveryId,
                ie.route,
                // A retired (NULL) payload must stay NULL — re-materializing it as '{}' would make a
                // slimmed dedup row read as a pending event with an empty body.
                ie.payload == null ? null : typeof ie.payload === 'string' ? ie.payload : JSON.stringify(ie.payload),
                ie.payloadHash ?? null,
                ie.sessionId,
                ie.dispatchState ?? null,
                ie.dispatchAttempts ?? 0,
                ie.lastDispatchAt ?? null,
                ie.createdAt,
              ],
            );
            ingressEventsCount++;
          } catch (err) {
            warnings.push(`Failed to import ingress event ${ie.id}: ${err}`);
          }
        }
      }

      // Import webhook delivery failures (webhook DLQ)
      let webhookDeliveryFailuresCount = 0;
      if (data.tables.webhookDeliveryFailures?.length) {
        for (const wf of data.tables.webhookDeliveryFailures) {
          try {
            await insert(
              `INSERT INTO webhook_delivery_failures (id, "webhookId", "sessionId", event, url, "idempotencyKey", "deliveryId", attempts, "lastStatusCode", "lastError", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                wf.id,
                wf.webhookId,
                wf.sessionId,
                wf.event,
                wf.url,
                wf.idempotencyKey,
                wf.deliveryId,
                wf.attempts,
                wf.lastStatusCode,
                wf.lastError,
                wf.createdAt,
              ],
            );
            webhookDeliveryFailuresCount++;
          } catch (err) {
            warnings.push(`Failed to import webhook delivery failure ${wf.id}: ${err}`);
          }
        }
      }

      // Import integration delivery failures (inbound + outbound DLQ)
      let integrationDeliveryFailuresCount = 0;
      if (data.tables.integrationDeliveryFailures?.length) {
        for (const df of data.tables.integrationDeliveryFailures) {
          try {
            await insert(
              `INSERT INTO integration_delivery_failures (id, direction, "pluginId", "instanceId", "sessionId", "deliveryId", attempts, "lastError", payload, redriven, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                df.id,
                df.direction,
                df.pluginId,
                df.instanceId,
                df.sessionId,
                df.deliveryId,
                df.attempts,
                df.lastError,
                df.payload == null ? null : typeof df.payload === 'string' ? df.payload : JSON.stringify(df.payload),
                df.redriven,
                df.createdAt,
              ],
            );
            integrationDeliveryFailuresCount++;
          } catch (err) {
            warnings.push(`Failed to import integration delivery failure ${df.id}: ${err}`);
          }
        }
      }

      // Import status updates (24h-TTL status/story store; sessionId is non-FK provenance)
      let statusUpdatesCount = 0;
      if (data.tables.statusUpdates?.length) {
        for (const su of data.tables.statusUpdates) {
          try {
            await insert(
              `INSERT INTO status_updates (id, "sessionId", "contactJid", "contactName", "contactPushName", "waStatusId", type, caption, "mediaPath", "mediaMimetype", "mediaOmitted", "omitReason", "backgroundColor", font, "postedAt", "expiresAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
              [
                su.id,
                su.sessionId,
                su.contactJid,
                su.contactName ?? null,
                su.contactPushName ?? null,
                su.waStatusId,
                su.type,
                su.caption ?? null,
                su.mediaPath ?? null,
                su.mediaMimetype ?? null,
                su.mediaOmitted ?? false,
                su.omitReason ?? null,
                su.backgroundColor ?? null,
                su.font ?? null,
                su.postedAt,
                su.expiresAt,
              ],
            );
            statusUpdatesCount++;
          } catch (err) {
            warnings.push(`Failed to import status update ${su.id}: ${err}`);
          }
        }
      }

      const counts = {
        sessions: sessionsCount,
        webhooks: webhooksCount,
        messages: messagesCount,
        messageBatches: messageBatchesCount,
        templates: templatesCount,
        baileysStoredMessages: baileysStoredMessagesCount,
        lidMappings: lidMappingsCount,
        pluginInstances: pluginInstancesCount,
        conversationMappings: conversationMappingsCount,
        ingressEvents: ingressEventsCount,
        webhookDeliveryFailures: webhookDeliveryFailuresCount,
        integrationDeliveryFailures: integrationDeliveryFailuresCount,
        statusUpdates: statusUpdatesCount,
      };

      // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
      // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
      // half-wiped DB and report success. A partial restore reported as imported:true was how
      // message history could silently vanish on a SQLite->Postgres migration.
      if (warnings.length > 0) {
        await queryRunner.rollbackTransaction();
        return {
          imported: false,
          counts,
          warnings,
          notices,
          restartRequired: false,
          orphanedEngines: [],
          stoppedOrphanEngines: [],
          failedOrphanEngines: [],
        };
      }

      // A wrong/empty/garbage backup file restores zero rows but the DELETE already ran — committing
      // would silently WIPE the database and report success. Refuse it and roll back instead. (#488 review)
      const totalRestored = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (totalRestored === 0) {
        await queryRunner.rollbackTransaction();
        return {
          imported: false,
          counts,
          warnings: ['Backup contained no rows to restore; refused to replace existing data. Check the file.'],
          notices,
          restartRequired: false,
          orphanedEngines: [],
          stoppedOrphanEngines: [],
          failedOrphanEngines: [],
        };
      }

      await queryRunner.commitTransaction();

      // Runtime reconciliation, part 2 (post-commit): the in-memory lid->phone mirror was warmed from
      // the OLD lid_mappings rows and is write-through only, so the just-restored table would never
      // reach it — resolution would keep serving stale entries (and miss restored ones) until the next
      // process start. Reload from the new DB contents. Best-effort: a miss falls back to engine
      // re-resolution, so a reload failure degrades instead of failing the (already committed) import.
      await this.lidMappingStore?.reload();

      // Audit the destructive replace-all restore, only on the committed-success path (the rollback /
      // refused-empty branches above return without emitting, since no data actually changed). Any
      // warnings would have taken the rollback branch, so warnings.length is always 0 here — record
      // only the per-table counts.
      await this.auditService?.logInfo(AuditAction.INFRA_DATA_IMPORTED, { metadata: { counts } });

      // restartRequired was computed in the pre-flight: true only when orphans were left running
      // (force=true legacy path) or when stopOrphans teardown failed for at least one engine.
      return {
        imported: true,
        counts,
        warnings,
        notices,
        restartRequired,
        orphanedEngines,
        stoppedOrphanEngines,
        failedOrphanEngines,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // STORAGE MIGRATION API
  // ============================================================================

  @Get('storage/files/count')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get file count in current storage' })
  @ApiResponse({ status: 200, description: 'File count and size' })
  async getStorageFileCount(): Promise<{
    storageType: string;
    count: number;
    sizeBytes: number;
    sizeMB: string;
  }> {
    const { count, sizeBytes } = await this.storageService.getFileCount();
    return {
      storageType: this.storageService.getCurrentStorageType(),
      count,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    };
  }

  @Get('storage/export')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all storage files as tar.gz' })
  @ApiResponse({ status: 200, description: 'Tar.gz archive stream' })
  async exportStorage(): Promise<{ message: string; download: string }> {
    // Note: In production, this would return a StreamableFile
    // For simplicity, we'll save to a temp file and return the path
    const stream = await this.storageService.createExportStream();
    // Keep the export INSIDE data/ (under data/exports/): the import handler only accepts paths under
    // data/, and the documented backend-migration flow re-imports this file AFTER a container restart,
    // so it must live on the persistent volume — the OS temp dir is wiped on restart. The original
    // unbounded-accumulation leak is addressed by the TTL sweep below + a collision-proof filename
    // (a per-call UUID), not by relocating off the volume.
    const exportDir = path.join(process.cwd(), 'data', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    const exportPath = path.join(exportDir, `storage-export-${Date.now()}-${randomUUID()}.tar.gz`);

    const writeStream = fs.createWriteStream(exportPath);
    stream.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      // pipe() does NOT forward source errors: an archiver/gzip failure surfaces as an 'error' event on
      // the source stream, which without a listener crashes the process. Fail the request instead and
      // tear down the sink so its fd isn't held open waiting for a 'finish' that never comes.
      stream.on('error', (err: Error) => {
        writeStream.destroy();
        reject(err);
      });
    });

    // Sweep the throwaway archive so repeated exports don't accumulate on the data volume.
    const ttlRaw = Number.parseInt(process.env.STORAGE_EXPORT_TTL_MS ?? '', 10);
    const ttlMs = Number.isInteger(ttlRaw) && ttlRaw > 0 ? ttlRaw : 60 * 60 * 1000; // default 1h
    setTimeout(() => {
      fs.promises.unlink(exportPath).catch(() => undefined);
    }, ttlMs).unref();

    // cwd-relative rather than an absolute host path: doesn't leak the filesystem layout, and the
    // import round-trip still works because importStorage's existsSync/createReadStream resolve a
    // relative filePath against the same cwd this was made relative to.
    const download = path.relative(process.cwd(), exportPath);

    // Audit the bulk media-export (all stored files leave the box as one archive).
    await this.auditService?.logInfo(AuditAction.INFRA_STORAGE_EXPORTED, { metadata: { download } });

    return {
      message: 'Storage export completed',
      download,
    };
  }

  @Post('storage/import')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import storage files from tar.gz' })
  @ApiBody({ description: 'Path to tar.gz file to import' })
  @ApiResponse({ status: 200, description: 'Import result' })
  async importStorage(
    @Body() body: ImportStorageDto,
  ): Promise<{ imported: boolean; count: number; storageType: string }> {
    const { filePath } = body;

    // `filePath` is fully caller-controlled. Restrict it to the app's data
    // directory so it cannot point at arbitrary files on the host. Resolve once against the
    // same cwd-relative base used by exportStorage, then use that exact path for both the guard
    // and the file sink.
    const dataDir = path.join(process.cwd(), 'data');
    const resolved = path.resolve(process.cwd(), filePath || '');
    if (!filePath || !isPathWithin(dataDir, resolved)) {
      throw new BadRequestException('filePath must reference a file inside the data directory');
    }

    if (!fs.existsSync(resolved)) {
      throw new BadRequestException(`File not found: ${filePath}`);
    }

    const readStream = fs.createReadStream(resolved);
    // importFromStream rejects on archive/gzip/read failures (its streams carry error listeners, so a
    // bad file fails the request instead of crashing the process on an unhandled 'error' event). The
    // failures that reach here are almost always a problem with the caller-supplied file (not a gzip,
    // not a tar, unreadable, over the resource caps), so surface them as a 400 with the real reason
    // rather than an opaque 500.
    let count: number;
    try {
      count = await this.storageService.importFromStream(readStream);
    } catch (error) {
      throw new BadRequestException(`Storage import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const storageType = this.storageService.getCurrentStorageType();

    // Audit the bulk media-import (files written into the active storage backend).
    await this.auditService?.logInfo(AuditAction.INFRA_STORAGE_IMPORTED, {
      metadata: { count, storageType },
    });

    return {
      imported: true,
      count,
      storageType,
    };
  }
}
