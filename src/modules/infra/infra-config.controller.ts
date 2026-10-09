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
import { InfraConfigResponseDto, InfraConfigSaveResponseDto, InfraRestartResponseDto } from './dto/infra-response.dto';
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
import { SaveConfigDto } from './dto/save-config.dto';
import { assertNoDefaultSecretsInProduction } from '../../config/bootstrap-security';
import { BLANK_SHADOWED_ENV_KEYS, isEnvPinned, isOsProvidedEnv } from '../../config/env-precedence';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { encodeGeneratedEnvValue, generatedEnvPath, readGeneratedEnv } from './generated-env';
import {
  applyDatabaseSection,
  applyEngineSection,
  applyRedisSection,
  applyStorageSection,
  ConfigSectionContext,
} from './config-sections';

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

// The env key and value that point the app at each bundled service, as /infra/status detects them.
const BUNDLED_SERVICE_ENV: Record<string, [string, string]> = {
  postgres: ['DATABASE_HOST', 'postgres'],
  redis: ['REDIS_HOST', 'redis'],
  minio: ['S3_ENDPOINT', 'http://minio:9000'],
};

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
  @ApiOperation({ summary: 'Read the effective infrastructure configuration for the dashboard form' })
  @ApiResponse({ status: 200, description: 'Effective configuration (secrets omitted)', type: InfraConfigResponseDto })
  getConfig(): SavedConfigResponse {
    const saved = readGeneratedEnv();

    // A value supplied by the host environment or the project .env outranks data/.env.generated at
    // every boot (load-env's override:false order), so the form must read it back instead of the
    // first-run defaults — otherwise a compose `environment:` deployment shows whatsapp-web.js/sqlite
    // while the process actually runs baileys/postgres (#1313). isEnvPinned's boot snapshot excludes
    // file-sourced keys, so a value that only ever lived in data/.env.generated is NOT pinned and the
    // freshly-saved file still wins over process.env's stale boot-time copy — keeping the
    // "saved, pending restart" form state intact until the reboot applies it (#226/#1082). A pinned
    // blank is read as-is: boot's clearBlankEnv drops blank host forwards before the snapshot, so a
    // blank that is still pinned is a `KEY=` line in ./.env, which the file can never fill at boot.
    const effective = (key: string): string | undefined =>
      (isEnvPinned(key) ? process.env[key] : undefined) ?? saved[key];

    // Secrets (passwords, S3 keys) are never returned; the form shows a "set" indicator
    // and an empty submission preserves the stored value (see saveConfig). This lets
    // the dashboard hydrate the form so a save no longer overwrites unseen fields (#226).
    return {
      database: {
        type: effective('DATABASE_TYPE') === 'postgres' ? 'postgres' : 'sqlite',
        builtIn: effective('POSTGRES_BUILTIN') === 'true',
        host: effective('DATABASE_HOST') || '',
        port: effective('DATABASE_PORT') || '',
        username: effective('DATABASE_USERNAME') || '',
        database: effective('DATABASE_NAME') || '',
        schema: effective('POSTGRES_SCHEMA') || 'public',
        poolSize: Number(effective('DATABASE_POOL_SIZE')) || 10,
        sslEnabled: effective('DATABASE_SSL') === 'true',
        sslRejectUnauthorized: effective('DATABASE_SSL_REJECT_UNAUTHORIZED') !== 'false',
        passwordSet: Boolean(effective('DATABASE_PASSWORD')),
      },
      redis: {
        enabled: effective('REDIS_ENABLED') === 'true',
        builtIn: effective('REDIS_BUILTIN') === 'true',
        host: effective('REDIS_HOST') || '',
        port: effective('REDIS_PORT') || '',
        passwordSet: Boolean(effective('REDIS_PASSWORD')),
      },
      queue: { enabled: effective('QUEUE_ENABLED') === 'true' },
      storage: {
        type: effective('STORAGE_TYPE') === 's3' ? 's3' : 'local',
        builtIn: effective('MINIO_BUILTIN') === 'true',
        localPath: effective('STORAGE_LOCAL_PATH') || '',
        s3Bucket: effective('S3_BUCKET') || '',
        s3Region: effective('S3_REGION') || '',
        s3Endpoint: effective('S3_ENDPOINT') || '',
        s3CredentialsSet: Boolean(
          (effective('S3_ACCESS_KEY_ID') || effective('S3_ACCESS_KEY')) &&
          (effective('S3_SECRET_ACCESS_KEY') || effective('S3_SECRET_KEY')),
        ),
      },
      engine: {
        type: effective('ENGINE_TYPE') || 'whatsapp-web.js',
        headless: effective('PUPPETEER_HEADLESS') !== 'false',
        sessionDataPath: effective('SESSION_DATA_PATH') || '',
        browserArgs: effective('PUPPETEER_ARGS') || '',
      },
    };
  }

  @Put('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Save infrastructure configuration to .env file' })
  @ApiResponse({
    status: 200,
    description: 'Save outcome. A failed disk write answers 200 with `saved: false`, so read the flag, not the status.',
    type: InfraConfigSaveResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Rejected before anything was written: an invalid or unknown field, an unknown engine type, a value with a ' +
      'line break or one that cannot be stored, or a configuration that would not boot in production.',
  })
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
      applyDatabaseSection(config.database, existing, ctx);
    }

    // Redis and queue are independent sections: a payload carrying only one of them must
    // not rewrite (or disable) the other's saved keys.
    if (config.redis) {
      applyRedisSection(config.redis, existing, ctx);
    }
    if (config.queue) {
      if (config.queue.enabled !== undefined) updates.QUEUE_ENABLED = config.queue.enabled ? 'true' : 'false';
    }

    if (config.storage) {
      applyStorageSection(config.storage, existing, ctx);
    }

    if (config.engine) {
      applyEngineSection(config.engine, existing, ctx, this.engineFactory);
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
    // refused on EVERY save even though its boot passes the guard. A pinned blank is kept as-is:
    // clearBlankEnv drops blank host forwards before either snapshot, so a blank that is still
    // pinned is a `KEY=` line in ./.env, and boot keeps it. Only without a snapshot (a process that
    // never ran load-env) does a blank on a blank-forwarded key count as unset, as clearBlankEnv would.
    //
    // Only a key from a layer ABOVE the file may win: the host, or the project .env, which load-env
    // also loads ahead of data/.env.generated with override:false. load-env merges the generated
    // file into process.env too, so reading process.env alone would hand back the very file this
    // save is replacing: the guard would then bless a flip by validating the OLD config (a
    // built-in -> external switch keeping the bundled 'openwa' password would save cleanly and
    // crash-loop the next production boot, the exact case this guard exists for). isEnvPinned's
    // snapshot is taken before that file loads; isOsProvidedEnv keeps the no-snapshot default of
    // assuming an override.
    const bootValue = (key: string): string | undefined => {
      if (isEnvPinned(key) && process.env[key] !== undefined) return process.env[key];
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
        // The same canonical-with-legacy fallback main.ts and storage.service apply.
        s3AccessKey: bootValue('S3_ACCESS_KEY_ID') || bootValue('S3_ACCESS_KEY'),
        s3SecretKey: bootValue('S3_SECRET_ACCESS_KEY') || bootValue('S3_SECRET_KEY'),
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
    const unreadable = (key: string) =>
      new BadRequestException(
        `Invalid configuration value for ${key}: it cannot be stored so that it reads back unchanged`,
      );
    const keys = Object.keys(merged).sort();
    const body = keys.map(key => {
      // Quoted where a raw line would read back differently (a `#` in a password would otherwise
      // truncate it on the next boot); refused, before anything is written, where no form can carry it.
      const encoded = encodeGeneratedEnvValue(key, merged[key]);
      if (encoded === undefined) throw unreadable(key);
      return `${key}=${encoded}`;
    });
    const contents = [
      '# OpenWA Configuration',
      `# Generated at ${new Date().toISOString()}`,
      '# Managed via Dashboard > Infrastructure. Values in process env or project .env take precedence.',
      '',
      ...body,
      '',
    ].join('\n');
    // The next boot parses the file as a whole, where a quoted value can run on into a later line
    // (a trailing `\'` escapes its own closing quote), so each line reading back alone is not enough.
    const back = dotenv.parse(contents);
    const drifted = keys.find(key => back[key] !== merged[key]);
    if (drifted !== undefined) throw unreadable(drifted);

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

  @Post('restart')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Request server restart with Docker orchestration' })
  @ApiResponse({ status: 200, description: 'Server will restart with new profiles', type: InfraRestartResponseDto })
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
    // Never stop a bundled service the environment pins the app to (e.g. the documented manual
    // built-in Postgres with DATABASE_HOST=postgres in .env): that pin outranks the saved config, so
    // the restarted app would still point at the container and fail to boot.
    const pinnedToBundled = Object.entries(BUNDLED_SERVICE_ENV)
      .filter(([, [key, value]]) => isEnvPinned(key) && process.env[key] === value)
      .map(([profile]) => profile);
    const requestedRemoval = body?.profilesToRemove || [];
    const profilesToRemove = requestedRemoval.filter(p => !pinnedToBundled.includes(p));
    if (profilesToRemove.length < requestedRemoval.length) {
      this.logger.warn('Keeping profiles the environment pins the app to', { pinnedToBundled });
    }
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
      // otherwise tear down the very backend the app is running on. The dashboard fills this list from the
      // live /infra/status builtIn flags at save time (running minus the new profiles). A container is
      // left running when that status read had failed, or when an environment pin keeps the app on it
      // (dropped above).
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
            removalResult.errors.push(`Error stopping ${profile}: ${err instanceof Error ? err.message : String(err)}`);
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

    // Calculate estimated time - base 15s + additional for each service (increased for reliability).
    // A typical healthy value, not a bound: ShutdownService force-exits teardown 67s after the grace.
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
