import { Controller, Get, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  AvailableEngineDto,
  InfraCurrentEngineResponseDto,
  InfraHealthResponseDto,
  InfraStatusResponseDto,
  InfraUpdateCheckResponseDto,
} from './dto/infra-response.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { producerReady } from '../queue/redis-connection';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { getEffectiveWebVersionInfo, resolveCurrentWebVersion } from '../../engine/wa-web-version';
import { DockerService, namesBundledContainer } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';
import { readGeneratedEnv } from './generated-env';
import { effectiveBuiltInFlag } from './saved-builtin-mode';
import { isEnvPinned } from '../../config/env-precedence';
import { DEFAULT_PUPPETEER_ARGS } from '../../config/configuration';
import { checkForUpdate, type UpdateCheck } from './update-check';

interface InfraStatus {
  // `builtIn` reflects whether OpenWA's own bundled container is actually running and backing this
  // service (detected live from the labeled container), not merely the saved intent. Falls back to the
  // saved flag, the environment's first, when Docker is unavailable. (#488)
  // `running` is whether a bundled container OpenWA created is up, whether or not the service uses it; false for
  // one Docker Compose created, and absent when Docker is unavailable, since nothing can be seen or stopped then.
  database: { connected: boolean; type: string; host: string; builtIn: boolean; running?: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean; running?: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: {
    type: 'local' | 's3';
    path?: string;
    bucket?: string;
    endpoint?: string;
    builtIn: boolean;
    running?: boolean;
    s3Available?: boolean;
  };
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
  // Which of the settings this page can edit are supplied by a layer ABOVE data/.env.generated (the
  // container environment or a project .env) and therefore cannot be changed from the dashboard until
  // that layer is. Reported rather than inferred: a running-vs-saved mismatch is also what a save that
  // has not been restarted yet looks like, and the two need opposite advice (#1082).
  envPinned: string[];
}

/**
 * Every key a save from the Infrastructure page writes (PUT /infra/config), so the page can name each one a layer
 * above the file pins: an unreported pin under an edited field reads as a change the next boot makes.
 * docker-compose.dev.yml pins the local storage path and the three whatsapp-web.js launch options with non-empty
 * defaults; the compose .env route pins the datastore settings. Only page controls are reported: naming variables
 * the page cannot edit would be noise. A pinned host decides the Use Built-in mode of its service.
 */
const DASHBOARD_PINNABLE_ENV_KEYS = [
  'DATABASE_TYPE',
  'POSTGRES_BUILTIN',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_USERNAME',
  'DATABASE_PASSWORD',
  'DATABASE_NAME',
  'DATABASE_POOL_SIZE',
  'POSTGRES_SCHEMA',
  'DATABASE_SSL',
  'DATABASE_SSL_REJECT_UNAUTHORIZED',
  'REDIS_ENABLED',
  'REDIS_BUILTIN',
  'REDIS_TLS',
  'REDIS_USERNAME',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'QUEUE_ENABLED',
  'STORAGE_TYPE',
  'MINIO_BUILTIN',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'STORAGE_LOCAL_PATH',
  'ENGINE_TYPE',
  'PUPPETEER_HEADLESS',
  'SESSION_DATA_PATH',
  'PUPPETEER_ARGS',
];

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraStatusController {
  private readonly logger = createLogger('InfraStatusController');

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
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue,
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
          timer = setTimeout(() => reject(new Error('db probe timeout')), InfraStatusController.DB_PROBE_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  @Get('status')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get infrastructure status' })
  @ApiResponse({ status: 200, description: 'Infrastructure status', type: InfraStatusResponseDto })
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
      // success); a later poll reflects the resolved build. (#488)
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
      this.configService.get<string[]>('engine.puppeteer.args')?.join(' ') || DEFAULT_PUPPETEER_ARGS.join(' ');

    // Built-in detection: prefer the actually-running bundled container as truth (so a stopped/missing
    // container, or a host-pinned external host, reads as NOT built-in), and require the app to be
    // pointed at the bundled service either way. Fall back to the saved *_BUILTIN flag (the environment's first)
    // when Docker is unreachable (bare-npm / socket-less) so the toggles don't spuriously flip off; a flag only
    // decides whether the container starts at boot, so it counts beside the bundled host alone. (#488) The labelled
    // container may be another instance's on the same daemon: it counts whenever this one's host is spelled like the
    // bundled one (docs/13, Scaling Guidelines).
    // `running` names a container OpenWA created beside this instance's own built-in flag only: the container names
    // are fixed per daemon, so a second instance there sees the first one's containers, which are not its to stop.
    const s3Endpoint = this.configService.get<string>('storage.s3.endpoint');
    const running = this.dockerService.isDockerAvailable()
      ? await this.dockerService.getRunningBuiltinServices()
      : null;
    const savedBuiltin = this.readSavedBuiltinFlags();
    const dbBuiltIn =
      (running ? !!running.database : savedBuiltin.database) && namesBundledContainer('postgres', dbHost);
    const redisBuiltIn = (running ? !!running.cache : savedBuiltin.cache) && namesBundledContainer('redis', redisHost);
    const storageBuiltIn =
      (running ? !!running.storage : savedBuiltin.storage) && namesBundledContainer('minio', s3Endpoint);
    // Re-probe (throttled) so a MinIO/S3 that came up after boot is reflected, not latched unreachable.
    const s3Available = storageType === 's3' ? await this.storageService.refreshS3Availability() : undefined;

    // Live webhook-queue depth (the only real queue). pending = waiting + active + delayed. Degrades to
    // zeros when the queue is disabled or Redis is unreachable, so the panel never errors the status read.
    let webhooks = { pending: 0, completed: 0, failed: 0 };
    if (queueEnabled && this.webhookQueue) {
      try {
        await producerReady(this.webhookQueue);
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
      database: {
        connected: dbConnected,
        type: dbType,
        host: dbHost,
        builtIn: dbBuiltIn,
        ...(running ? { running: running.database === 'openwa' && savedBuiltin.database } : {}),
      },
      redis: {
        enabled: redisEnabled,
        connected: redisConnected,
        host: redisHost,
        port: redisPort,
        builtIn: redisBuiltIn,
        ...(running ? { running: running.cache === 'openwa' && savedBuiltin.cache } : {}),
      },
      queue: {
        enabled: queueEnabled,
        webhooks,
      },
      storage: {
        type: storageType,
        path: storagePath,
        ...(storageType === 's3' && storageBucket ? { bucket: storageBucket } : {}),
        // The endpoint this process dials: a bundled MinIO that is stopped still names it, an external store does not.
        ...(storageType === 's3' && s3Endpoint ? { endpoint: s3Endpoint } : {}),
        builtIn: storageBuiltIn,
        ...(running ? { running: running.storage === 'openwa' && savedBuiltin.storage } : {}),
        ...(storageType === 's3' ? { s3Available } : {}),
      },
      engine: {
        type: engineType,
        headless: engineHeadless,
        sessionDataPath,
        browserArgs,
        ...(engineType === 'whatsapp-web.js' ? { webVersion, webVersionSource } : {}),
      },
      envPinned: DASHBOARD_PINNABLE_ENV_KEYS.filter(isEnvPinned),
    };
  }

  /**
   * The saved built-in flags, the fallback when Docker isn't reachable: the environment's, else
   * data/.env.generated's. A host name proves nothing without a container to see, so none counts here.
   */
  private readSavedBuiltinFlags(): { database: boolean; cache: boolean; storage: boolean } {
    try {
      const saved = readGeneratedEnv();
      return {
        database: effectiveBuiltInFlag('database', saved),
        cache: effectiveBuiltInFlag('redis', saved),
        storage: effectiveBuiltInFlag('storage', saved),
      };
    } catch {
      return { database: false, cache: false, storage: false };
    }
  }

  @Get('engines')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get available WhatsApp engines' })
  @ApiResponse({ status: 200, description: 'List of available engines', type: [AvailableEngineDto] })
  getEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    return this.engineFactory.getAvailableEngines();
  }

  @Get('engines/current')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get current active engine' })
  @ApiResponse({ status: 200, description: 'Current engine info', type: InfraCurrentEngineResponseDto })
  getCurrentEngine(): { engineType: string } {
    return { engineType: this.engineFactory.getCurrentEngine() };
  }

  @Get('update-check')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary: 'Compare the running version with the latest OpenWA release',
    description:
      'Reads the latest published GitHub release through the SSRF-guarded fetch and caches it. ' +
      'Set UPDATE_CHECK_ENABLED=false to turn the outbound request off.',
  })
  @ApiResponse({ status: 200, description: 'Update check result', type: InfraUpdateCheckResponseDto })
  getUpdateCheck(): Promise<UpdateCheck> {
    return checkForUpdate();
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Process is up. This route does not probe dependencies — read /infra/status for those.',
    type: InfraHealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'Shutdown teardown has begun: every route except /api/health and /api/health/* answers 503 then. ' +
      'Probe /api/health/live for a check that survives teardown.',
  })
  healthCheck(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
