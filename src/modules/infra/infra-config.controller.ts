import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  BadRequestException,
  HttpException,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { writeSecretFile } from '../../common/utils/secret-file';
import { EngineFactory } from '../../engine/engine.factory';
import { DockerService, MANAGED_DOCKER_PROFILES } from '../docker';
import { ShutdownService } from '../../common/services/shutdown.service';
import { createLogger } from '../../common/services/logger.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import {
  DatabaseConfigDto,
  EngineConfigDto,
  RedisConfigDto,
  SaveConfigDto,
  StorageConfigDto,
} from './dto/save-config.dto';
import { assertNoDefaultSecretsInProduction } from '../../config/bootstrap-security';
import { BLANK_SHADOWED_ENV_KEYS, isOsProvidedEnv } from '../../config/env-precedence';
import * as fs from 'fs';
import * as path from 'path';
import { generatedEnvPath, readGeneratedEnv } from './generated-env';

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

// Mutable accumulator threaded through the pipeline stages and per-section appliers extracted
// from saveConfig: `updates` collects the values this payload writes, `staleKeys` the keys a mode
// switch makes obsolete (dropped from the merged result), and `profiles` the Docker profiles the
// new config requires.
interface ConfigSectionContext {
  updates: Record<string, string>;
  staleKeys: Set<string>;
  profiles: string[];
}

// Secret values are never echoed back to the form, so an empty submission means
// "unchanged" — keep whatever is already stored instead of blanking it.
function setSecret(updates: Record<string, string>, key: string, value: string | undefined): void {
  if (value) updates[key] = value;
}

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraConfigController {
  private readonly logger = createLogger('InfraConfigController');

  constructor(
    private readonly engineFactory: EngineFactory,
    private readonly dockerService: DockerService,
    private readonly shutdownService: ShutdownService,
    // Best-effort audit emission for the sensitive infra operations below. Injected @Optional and
    // appended last so it never shifts the existing positional args: the running app always provides
    // the @Global AuditService, while the direct-construction unit tests omit it — the `?.` at each
    // call site then makes emission a no-op there instead of forcing every test to wire a mock.
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  @Get('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Read the saved infrastructure configuration for the dashboard form' })
  @ApiResponse({ status: 200, description: 'Saved configuration (secrets omitted)' })
  getConfig(): SavedConfigResponse {
    const saved = readGeneratedEnv();

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
      const envPath = generatedEnvPath();
      const existing = readGeneratedEnv();
      const updates: Record<string, string> = {};
      // Keys to remove from the merged result — used to drop stale settings when the
      // user switches mode (postgres->sqlite, s3->local, built-in->external) so a reload
      // never sees the new mode alongside leftover keys from the old one.
      const staleKeys = new Set<string>();

      const ctx: ConfigSectionContext = { updates, staleKeys, profiles };

      this.applyConfigSections(config, existing, ctx);
      this.assertNoLineBreakValues(updates);
      const merged = this.mergeWithExisting(existing, ctx);
      this.assertProductionBootable(merged);
      this.persistGeneratedEnv(envPath, merged);
      this.auditConfigSaved(config, profiles);

      return this.buildSaveResponse(envPath, profiles);
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

  // Dispatch each present payload section to its applier; an absent section leaves its saved keys alone.
  private applyConfigSections(
    config: SaveConfigDto,
    existing: Record<string, string>,
    ctx: ConfigSectionContext,
  ): void {
    const { updates } = ctx;
    if (config.database) {
      this.applyDatabaseSection(config.database, existing, ctx);
    }

    // Redis and queue are independent sections: a payload carrying only one of them must
    // not rewrite (or disable) the other's saved keys.
    if (config.redis) {
      this.applyRedisSection(config.redis, existing, ctx);
    }
    if (config.queue) {
      if (config.queue.enabled !== undefined) updates.QUEUE_ENABLED = config.queue.enabled ? 'true' : 'false';
    }

    if (config.storage) {
      this.applyStorageSection(config.storage, existing, ctx);
    }

    if (config.engine) {
      this.applyEngineSection(config.engine, existing, ctx);
    }
  }

  private assertNoLineBreakValues(updates: Record<string, string>): void {
    // .env.generated is one KEY=value per line, loaded on the next boot. A value carrying a
    // line break would write a second line and inject an arbitrary env var the operator never
    // set, so refuse any such value before writing anything.
    for (const [key, value] of Object.entries(updates)) {
      if (/[\r\n]/.test(value)) {
        throw new BadRequestException(`Invalid configuration value for ${key}: line breaks are not allowed`);
      }
    }
  }

  private mergeWithExisting(existing: Record<string, string>, ctx: ConfigSectionContext): Record<string, string> {
    const { updates, staleKeys } = ctx;
    // Existing values are the base; this payload's values win (secrets handled above).
    const merged: Record<string, string> = { ...existing, ...updates };
    // Drop keys made obsolete by a mode switch (postgres->sqlite, s3->local, built-in->external).
    for (const k of staleKeys) {
      delete merged[k];
    }
    return merged;
  }

  private assertProductionBootable(merged: Record<string, string>): void {
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
  }

  private persistGeneratedEnv(envPath: string, merged: Record<string, string>): void {
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
  }

  private auditConfigSaved(config: SaveConfigDto, profiles: string[]): void {
    // Audit the credential-bearing env mutation. Fire-and-forget (not awaited) so saveConfig stays
    // synchronous — its validation rejections must remain synchronous throws the tests assert via
    // `.toThrow`. Only section names + Docker profiles are recorded; secret values are never logged.
    void this.auditService?.logInfo(AuditAction.INFRA_CONFIG_SAVED, {
      metadata: { sections: Object.keys(config ?? {}), profiles },
    });
  }

  private buildSaveResponse(
    envPath: string,
    profiles: string[],
  ): { message: string; saved: boolean; envPath: string; profiles: string[] } {
    const profileMsg = profiles.length > 0 ? ` Docker profiles required: ${profiles.join(', ')}.` : '';

    return {
      message: `Configuration saved successfully.${profileMsg} Server restart required to apply changes.`,
      saved: true,
      // Return a cwd-relative path so the response doesn't disclose the absolute host filesystem layout.
      envPath: path.relative(process.cwd(), envPath),
      profiles,
    };
  }

  // Database. NOTE: these keys must match what src/config/configuration.ts reads.
  private applyDatabaseSection(
    database: DatabaseConfigDto,
    existing: Record<string, string>,
    ctx: ConfigSectionContext,
  ): void {
    const { updates, staleKeys, profiles } = ctx;
    updates.DATABASE_TYPE = database.type || 'sqlite';
    if (database.builtIn !== undefined) {
      updates.POSTGRES_BUILTIN = database.builtIn ? 'true' : 'false';
    }
    // The effective mode: an explicit builtIn wins; when it is absent the saved mode
    // is inherited so a partial payload stays in the current mode instead of silently
    // flipping to external.
    const dbBuiltIn = database.builtIn ?? existing.POSTGRES_BUILTIN === 'true';
    if (database.type === 'postgres') {
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
        updates.DATABASE_PASSWORD = database.password || storedPassword || 'openwa';
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
        if (database.builtIn === false && existing.POSTGRES_BUILTIN === 'true' && !database.password) {
          staleKeys.add('DATABASE_PASSWORD');
        }
        if (database.host !== undefined) updates.DATABASE_HOST = database.host || 'localhost';
        if (database.port !== undefined) updates.DATABASE_PORT = database.port || '5432';
        if (database.username !== undefined) updates.DATABASE_USERNAME = database.username || 'postgres';
        setSecret(updates, 'DATABASE_PASSWORD', database.password);
        if (database.database !== undefined) updates.DATABASE_NAME = database.database || 'openwa';
        if (database.schema !== undefined) updates.POSTGRES_SCHEMA = database.schema || 'public';
      }
      if (database.poolSize !== undefined) {
        updates.DATABASE_POOL_SIZE = String(database.poolSize || 10);
      }
      if (database.sslEnabled !== undefined) {
        updates.DATABASE_SSL = database.sslEnabled ? 'true' : 'false';
        if (database.sslEnabled) {
          // Default to certificate verification; only relax it when the operator opts out
          // (managed Postgres with self-signed certs: Supabase, Heroku, Render, Railway).
          updates.DATABASE_SSL_REJECT_UNAUTHORIZED = database.sslRejectUnauthorized === false ? 'false' : 'true';
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

  private applyRedisSection(redis: RedisConfigDto, existing: Record<string, string>, ctx: ConfigSectionContext): void {
    const { updates, staleKeys, profiles } = ctx;
    if (redis.enabled !== undefined) updates.REDIS_ENABLED = redis.enabled ? 'true' : 'false';
    if (redis.builtIn !== undefined) updates.REDIS_BUILTIN = redis.builtIn ? 'true' : 'false';
    if (redis.builtIn === true) {
      // Built-in Redis - use container name as host. The bundled container runs without
      // auth, so a password saved by an earlier external setup is stale: leaving it
      // would make the client AUTH against a passwordless server on the next boot.
      updates.REDIS_HOST = 'redis';
      updates.REDIS_PORT = '6379';
      if (!redis.password) staleKeys.add('REDIS_PASSWORD');
    } else {
      // External Redis (explicit, or inherited when builtIn is absent)
      if (redis.host !== undefined) updates.REDIS_HOST = redis.host || 'localhost';
      if (redis.port !== undefined) updates.REDIS_PORT = redis.port || '6379';
    }
    setSecret(updates, 'REDIS_PASSWORD', redis.password);
    const redisEnabled = redis.enabled ?? existing.REDIS_ENABLED === 'true';
    const redisBuiltIn = redis.builtIn ?? existing.REDIS_BUILTIN === 'true';
    if (redisEnabled && redisBuiltIn) {
      profiles.push('redis');
    }
  }

  // Storage. NOTE: STORAGE_LOCAL_PATH / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
  // the names configuration.ts reads (previously saved as STORAGE_PATH / S3_*_KEY and
  // silently ignored — #226).
  private applyStorageSection(
    storage: StorageConfigDto,
    existing: Record<string, string>,
    ctx: ConfigSectionContext,
  ): void {
    const { updates, staleKeys, profiles } = ctx;
    updates.STORAGE_TYPE = storage.type || 'local';
    if (storage.builtIn !== undefined) {
      updates.MINIO_BUILTIN = storage.builtIn ? 'true' : 'false';
    }
    if (storage.type === 'local') {
      // Switching to local: drop stale S3 keys, and reset the built-in flag with them —
      // there is no bundled MinIO backing a local storage path.
      updates.MINIO_BUILTIN = 'false';
      if (storage.localPath !== undefined) {
        updates.STORAGE_LOCAL_PATH = storage.localPath || './data/media';
      }
      // Switching to local: drop stale S3 keys.
      for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_REGION']) {
        staleKeys.add(k);
      }
    } else if (storage.type === 's3') {
      staleKeys.add('STORAGE_LOCAL_PATH');
      if (storage.builtIn === true) {
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
        if (storage.builtIn === false && existing.MINIO_BUILTIN === 'true') {
          if (!storage.s3AccessKey) staleKeys.add('S3_ACCESS_KEY_ID');
          if (!storage.s3SecretKey) staleKeys.add('S3_SECRET_ACCESS_KEY');
          if (!storage.s3Endpoint) staleKeys.add('S3_ENDPOINT');
        }
        if (storage.s3Bucket !== undefined) updates.S3_BUCKET = storage.s3Bucket;
        if (storage.s3Region !== undefined) updates.S3_REGION = storage.s3Region || 'ap-southeast-1';
        setSecret(updates, 'S3_ACCESS_KEY_ID', storage.s3AccessKey);
        setSecret(updates, 'S3_SECRET_ACCESS_KEY', storage.s3SecretKey);
        if (storage.s3Endpoint !== undefined) {
          // Unlike the credentials, the endpoint IS echoed back to the form, so an empty
          // submission is a real "clear it" (moving to the default AWS endpoint), not
          // "unchanged" — leaving a stale MinIO endpoint behind would silently keep
          // pointing S3 traffic at the old host.
          if (storage.s3Endpoint) {
            updates.S3_ENDPOINT = storage.s3Endpoint;
          } else {
            staleKeys.add('S3_ENDPOINT');
          }
        }
      }
    }
  }

  // Engine. NOTE: PUPPETEER_HEADLESS / SESSION_DATA_PATH / PUPPETEER_ARGS are the names
  // configuration.ts reads (previously saved as ENGINE_* and silently ignored — #226).
  private applyEngineSection(
    engine: EngineConfigDto,
    existing: Record<string, string>,
    ctx: ConfigSectionContext,
  ): void {
    const { updates } = ctx;
    // Persist the selected engine so the Infrastructure tile can actually switch engines (the
    // active engine was previously only settable via the ENGINE_TYPE env, never from the UI).
    if (engine.type) {
      const validEngineIds = this.engineFactory.getAvailableEngines().map(e => e.id);
      if (!validEngineIds.includes(engine.type)) {
        throw new BadRequestException(`Unknown engine type: ${engine.type}`);
      }
      updates.ENGINE_TYPE = engine.type;
    }
    if (engine.headless !== undefined) {
      updates.PUPPETEER_HEADLESS = engine.headless ? 'true' : 'false';
    }
    if (engine.sessionDataPath !== undefined) {
      updates.SESSION_DATA_PATH = engine.sessionDataPath || './data/sessions';
    }
    if (engine.browserArgs !== undefined) {
      // Must match configuration.ts's PUPPETEER_ARGS default (4 flags). Once compose blank-forwards
      // PUPPETEER_ARGS, this saved value wins at runtime — a 2-flag default here would silently drop
      // --disable-dev-shm-usage (the Docker /dev/shm tab-crash guard) after any Infrastructure save.
      updates.PUPPETEER_ARGS =
        engine.browserArgs || '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu';
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
}
