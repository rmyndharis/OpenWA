import { Controller, Get, Put, Post, Body, BadRequestException, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isPathWithin } from '../../common/utils/path-safety';
import { writeSecretFile } from '../../common/utils/secret-file';
import { EngineFactory } from '../../engine/engine.factory';
import { getEffectiveWebVersionInfo, resolveCurrentWebVersion } from '../../engine/wa-web-version';
import { DockerService, MANAGED_DOCKER_PROFILES } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { createLogger } from '../../common/services/logger.service';
import { ImportStorageDto } from './dto/import-storage.dto';
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

interface SaveConfigDto {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    poolSize?: number;
    sslEnabled?: boolean;
    sslRejectUnauthorized?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    type?: string;
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
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
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
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

interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
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
export class InfraController {
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
  ) {}

  @Get('status')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get infrastructure status' })
  @ApiResponse({ status: 200, description: 'Infrastructure status' })
  async getStatus(): Promise<InfraStatus> {
    // Check both database connections
    const mainDbConnected = this.mainDataSource.isInitialized;
    const dataDbConnected = this.dataDataSource.isInitialized;
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
  @ApiBody({ description: 'Configuration to save' })
  saveConfig(@Body() config: SaveConfigDto): { message: string; saved: boolean; envPath: string; profiles: string[] } {
    try {
      const profiles: string[] = [];

      // Merge into the existing saved config rather than rebuilding from scratch, so a
      // partial payload (the dashboard only sends the sections it renders) cannot wipe
      // keys it didn't include (#226).
      const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
      const existing: Record<string, string> = fs.existsSync(envPath)
        ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
        : {};
      const updates: Record<string, string> = {};
      // Keys to remove from the merged result — used to drop stale settings when the
      // user switches mode (postgres->sqlite, s3->local) so a reload never sees the new
      // mode alongside leftover keys from the old one.
      const staleKeys = new Set<string>();

      // Secret values are never echoed back to the form, so an empty submission means
      // "unchanged" — keep whatever is already stored instead of blanking it.
      const setSecret = (key: string, value: string | undefined): void => {
        if (value) updates[key] = value;
      };

      // Database. NOTE: these keys must match what src/config/configuration.ts reads.
      if (config.database) {
        updates.DATABASE_TYPE = config.database.type || 'sqlite';
        updates.POSTGRES_BUILTIN = config.database.builtIn ? 'true' : 'false';
        if (config.database.type === 'postgres') {
          if (config.database.builtIn) {
            // Built-in PostgreSQL - use container name as host
            updates.DATABASE_HOST = 'postgres';
            updates.DATABASE_PORT = '5432';
            updates.DATABASE_USERNAME = 'openwa';
            updates.DATABASE_PASSWORD = 'openwa';
            updates.DATABASE_NAME = 'openwa';
            profiles.push('postgres');
          } else {
            // External PostgreSQL
            updates.DATABASE_HOST = config.database.host || 'localhost';
            updates.DATABASE_PORT = config.database.port || '5432';
            updates.DATABASE_USERNAME = config.database.username || 'postgres';
            setSecret('DATABASE_PASSWORD', config.database.password);
            updates.DATABASE_NAME = config.database.database || 'openwa';
          }
          updates.DATABASE_POOL_SIZE = String(config.database.poolSize || 10);
          updates.DATABASE_SSL = config.database.sslEnabled ? 'true' : 'false';
          if (config.database.sslEnabled) {
            // Default to certificate verification; only relax it when the operator opts out
            // (managed Postgres with self-signed certs: Supabase, Heroku, Render, Railway).
            updates.DATABASE_SSL_REJECT_UNAUTHORIZED =
              config.database.sslRejectUnauthorized === false ? 'false' : 'true';
          }
        } else {
          // Switching to sqlite: drop stale postgres connection keys.
          for (const k of [
            'DATABASE_HOST',
            'DATABASE_PORT',
            'DATABASE_USERNAME',
            'DATABASE_PASSWORD',
            'DATABASE_NAME',
            'DATABASE_POOL_SIZE',
            'DATABASE_SSL',
            'DATABASE_SSL_REJECT_UNAUTHORIZED',
          ]) {
            staleKeys.add(k);
          }
        }
      }

      // Redis / Queue
      if (config.redis || config.queue) {
        updates.REDIS_ENABLED = config.redis?.enabled ? 'true' : 'false';
        updates.REDIS_BUILTIN = config.redis?.builtIn ? 'true' : 'false';
        updates.QUEUE_ENABLED = config.queue?.enabled ? 'true' : 'false';
        if (config.redis?.enabled) {
          if (config.redis.builtIn) {
            // Built-in Redis - use container name as host
            updates.REDIS_HOST = 'redis';
            updates.REDIS_PORT = '6379';
            profiles.push('redis');
          } else {
            // External Redis
            updates.REDIS_HOST = config.redis.host || 'localhost';
            updates.REDIS_PORT = config.redis.port || '6379';
            setSecret('REDIS_PASSWORD', config.redis.password);
          }
        }
      }

      // Storage. NOTE: STORAGE_LOCAL_PATH / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
      // the names configuration.ts reads (previously saved as STORAGE_PATH / S3_*_KEY and
      // silently ignored — #226).
      if (config.storage) {
        updates.STORAGE_TYPE = config.storage.type || 'local';
        updates.MINIO_BUILTIN = config.storage.builtIn ? 'true' : 'false';
        if (config.storage.type === 'local') {
          updates.STORAGE_LOCAL_PATH = config.storage.localPath || './data/media';
          // Switching to local: drop stale S3 keys.
          for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_REGION']) {
            staleKeys.add(k);
          }
        } else if (config.storage.type === 's3') {
          staleKeys.add('STORAGE_LOCAL_PATH');
          if (config.storage.builtIn) {
            // Built-in MinIO - use container name as endpoint
            updates.S3_ENDPOINT = 'http://minio:9000';
            updates.S3_ACCESS_KEY_ID = 'minioadmin';
            updates.S3_SECRET_ACCESS_KEY = 'minioadmin';
            updates.S3_BUCKET = 'openwa';
            updates.S3_REGION = 'us-east-1';
            profiles.push('minio');
          } else {
            // External S3/MinIO
            updates.S3_BUCKET = config.storage.s3Bucket || '';
            updates.S3_REGION = config.storage.s3Region || 'ap-southeast-1';
            setSecret('S3_ACCESS_KEY_ID', config.storage.s3AccessKey);
            setSecret('S3_SECRET_ACCESS_KEY', config.storage.s3SecretKey);
            if (config.storage.s3Endpoint) {
              updates.S3_ENDPOINT = config.storage.s3Endpoint;
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
        updates.PUPPETEER_HEADLESS = config.engine.headless !== false ? 'true' : 'false';
        updates.SESSION_DATA_PATH = config.engine.sessionDataPath || './data/sessions';
        updates.PUPPETEER_ARGS = config.engine.browserArgs || '--no-sandbox --disable-gpu';
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
      // Drop keys made obsolete by a mode switch (postgres->sqlite, s3->local).
      for (const k of staleKeys) {
        delete merged[k];
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

      const profileMsg = profiles.length > 0 ? ` Docker profiles required: ${profiles.join(', ')}.` : '';

      return {
        message: `Configuration saved successfully.${profileMsg} Server restart required to apply changes.`,
        saved: true,
        envPath,
        profiles,
      };
    } catch (error) {
      return {
        message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        saved: false,
        envPath: '',
        profiles: [],
      };
    }
  }
  @Post('restart')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Request server restart with Docker orchestration' })
  @ApiResponse({ status: 200, description: 'Server will restart with new profiles' })
  async requestRestart(@Body() body?: { profiles?: string[]; profilesToRemove?: string[] }): Promise<{
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
    let removalResult: { removed: string[]; errors: string[] } | undefined;

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
      // would otherwise reach removeService and, via container-name matching, could stop an unrelated
      // container — so constrain teardown to the managed allowlist and drop anything else.
      const requested = profilesToRemove.filter(p => !profiles.includes(p));
      const toRemove = requested.filter(p => MANAGED_DOCKER_PROFILES.includes(p));
      const ignored = requested.filter(p => !MANAGED_DOCKER_PROFILES.includes(p));
      if (ignored.length > 0) {
        this.logger.warn('Ignoring non-managed profiles in profilesToRemove', { ignored });
      }

      // First, remove containers for disabled services
      if (toRemove.length > 0) {
        this.logger.log('Removing disabled profiles...', { toRemove });
        removalResult = { removed: [], errors: [] };

        for (const profile of toRemove) {
          try {
            const success = await this.dockerService.removeService(profile);
            if (success) {
              removalResult.removed.push(profile);
            } else {
              removalResult.errors.push(`Failed to remove ${profile}`);
            }
          } catch (err) {
            removalResult.errors.push(`Error removing ${profile}: ${err}`);
          }
        }
        this.logger.log('Removal result', { removalResult });
      }

      // Then, start containers for enabled services
      if (profiles.length > 0) {
        this.logger.log('Orchestrating enabled profiles...');
        orchestrationResult = await this.dockerService.orchestrateProfiles(profiles);
        this.logger.log('Orchestration result', { orchestrationResult });
      }
    } else {
      this.logger.warn('Docker not available, writing signal file instead');
      // Fallback: write signal file for host script
      try {
        const signalFile = path.resolve(process.cwd(), 'data', '.orchestration-request.json');
        const orchestrationRequest = {
          timestamp: new Date().toISOString(),
          profiles,
          profilesToRemove,
          action: 'restart-with-profiles',
        };
        fs.writeFileSync(signalFile, JSON.stringify(orchestrationRequest, null, 2), 'utf8');
        this.logger.log('Orchestration request written', { signalFile });
      } catch (err) {
        this.logger.error('Failed to write orchestration request', err instanceof Error ? err.message : String(err));
      }
    }

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
    };
  }> {
    // Get all entities from Data DB
    const sessions = await this.dataDataSource.query<SessionRow[]>('SELECT * FROM sessions');
    const webhooks = await this.dataDataSource.query<WebhookRow[]>('SELECT * FROM webhooks');

    // These tables may not exist yet (older DB) or be empty.
    let messages: MessageRow[] = [];
    let messageBatches: MessageBatchRow[] = [];
    let templates: TemplateRow[] = [];
    let baileysStoredMessages: BaileysStoredMessageRow[] = [];
    let lidMappings: LidMappingRow[] = [];

    try {
      messages = await this.dataDataSource.query<MessageRow[]>('SELECT * FROM messages');
    } catch (error) {
      this.logger.debug('Messages table not available for export', { error: String(error) });
    }

    try {
      messageBatches = await this.dataDataSource.query<MessageBatchRow[]>('SELECT * FROM message_batches');
    } catch (error) {
      this.logger.debug('Message batches table not available for export', { error: String(error) });
    }

    try {
      templates = await this.dataDataSource.query<TemplateRow[]>('SELECT * FROM templates');
    } catch (error) {
      this.logger.debug('Templates table not available for export', { error: String(error) });
    }

    try {
      baileysStoredMessages = await this.dataDataSource.query<BaileysStoredMessageRow[]>(
        'SELECT * FROM baileys_stored_messages',
      );
    } catch (error) {
      this.logger.debug('Baileys stored messages table not available for export', { error: String(error) });
    }

    try {
      lidMappings = await this.dataDataSource.query<LidMappingRow[]>('SELECT * FROM lid_mappings');
    } catch (error) {
      this.logger.debug('Lid mappings table not available for export', { error: String(error) });
    }

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
      },
      counts: {
        sessions: sessions.length,
        webhooks: webhooks.length,
        messages: messages.length,
        messageBatches: messageBatches.length,
        templates: templates.length,
        baileysStoredMessages: baileysStoredMessages.length,
        lidMappings: lidMappings.length,
      },
    };
  }

  @Post('import-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  @ApiBody({
    description: 'Exported data from export-data endpoint',
    schema: {
      type: 'object',
      properties: {
        tables: {
          type: 'object',
          properties: {
            sessions: { type: 'array' },
            webhooks: { type: 'array' },
            messages: { type: 'array' },
            messageBatches: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Data imported successfully' })
  async importData(
    @Body()
    data: {
      tables: Partial<MigrationTables>;
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
    };
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const queryRunner = this.dataDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Clear existing data (in correct order due to foreign keys). templates and
      // baileys_stored_messages FK sessions ON DELETE CASCADE, so the sessions DELETE would clear
      // them too; clearing them explicitly first keeps the order correct on engines where the
      // cascade is not enforced, and is a no-op when the table doesn't exist.
      await queryRunner.query('DELETE FROM webhooks');
      await queryRunner.query('DELETE FROM messages').catch(() => {});
      await queryRunner.query('DELETE FROM message_batches').catch(() => {});
      await queryRunner.query('DELETE FROM templates').catch(() => {});
      await queryRunner.query('DELETE FROM baileys_stored_messages').catch(() => {});
      // lid_mappings is not a FK to sessions, so the sessions DELETE below won't clear it; clear it
      // explicitly so a restore replaces the cache rather than colliding on existing lid PKs.
      await queryRunner.query('DELETE FROM lid_mappings').catch(() => {});
      await queryRunner.query('DELETE FROM sessions');

      // Import sessions first
      let sessionsCount = 0;
      if (data.tables.sessions?.length) {
        for (const session of data.tables.sessions) {
          try {
            await queryRunner.query(
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
            await queryRunner.query(
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
            await queryRunner.query(
              `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                msg.id,
                msg.sessionId,
                msg.waMessageId ?? null,
                msg.chatId,
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
            await queryRunner.query(
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
            await queryRunner.query(
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
            await queryRunner.query(
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
            await queryRunner.query(
              `INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt") VALUES ($1, $2, $3, $4)`,
              [lm.lid, lm.phone ?? null, lm.sessionId ?? null, lm.updatedAt],
            );
            lidMappingsCount++;
          } catch (err) {
            warnings.push(`Failed to import lid mapping ${lm.lid}: ${err}`);
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
      };

      // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
      // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
      // half-wiped DB and report success. A partial restore reported as imported:true was how
      // message history could silently vanish on a SQLite->Postgres migration.
      if (warnings.length > 0) {
        await queryRunner.rollbackTransaction();
        return { imported: false, counts, warnings };
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
        };
      }

      await queryRunner.commitTransaction();
      return { imported: true, counts, warnings };
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
    });

    // Sweep the throwaway archive so repeated exports don't accumulate on the data volume.
    const ttlRaw = Number.parseInt(process.env.STORAGE_EXPORT_TTL_MS ?? '', 10);
    const ttlMs = Number.isInteger(ttlRaw) && ttlRaw > 0 ? ttlRaw : 60 * 60 * 1000; // default 1h
    setTimeout(() => {
      fs.promises.unlink(exportPath).catch(() => undefined);
    }, ttlMs).unref();

    return {
      message: 'Storage export completed',
      download: exportPath,
    };
  }

  @Post('storage/import')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import storage files from tar.gz' })
  @ApiBody({ description: 'Path to tar.gz file to import' })
  @ApiResponse({ status: 200, description: 'Import result' })
  async importStorage(
    @Body() body: ImportStorageDto,
  ): Promise<{ imported: boolean; count: number; storageType: string }> {
    const { filePath } = body;

    // `filePath` is fully caller-controlled. Restrict it to the app's data
    // directory so it cannot point at arbitrary files on the host.
    const dataDir = path.join(process.cwd(), 'data');
    if (!filePath || !isPathWithin(dataDir, filePath)) {
      throw new BadRequestException('filePath must reference a file inside the data directory');
    }

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException(`File not found: ${filePath}`);
    }

    const readStream = fs.createReadStream(filePath);
    const count = await this.storageService.importFromStream(readStream);

    return {
      imported: true,
      count,
      storageType: this.storageService.getCurrentStorageType(),
    };
  }
}
