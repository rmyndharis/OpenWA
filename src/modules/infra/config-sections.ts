import { BadRequestException } from '@nestjs/common';
import type { EngineFactory } from '../../engine/engine.factory';
import { DatabaseConfigDto, EngineConfigDto, RedisConfigDto, StorageConfigDto } from './dto/save-config.dto';

// Mutable accumulator threaded through the pipeline stages and per-section appliers extracted
// from saveConfig: `updates` collects the values this payload writes, `staleKeys` the keys a mode
// switch makes obsolete (dropped from the merged result), and `profiles` the Docker profiles the
// new config requires.
export interface ConfigSectionContext {
  updates: Record<string, string>;
  staleKeys: Set<string>;
  profiles: string[];
}

// Secret values are never echoed back to the form, so an empty submission means
// "unchanged" — keep whatever is already stored instead of blanking it.
function setSecret(updates: Record<string, string>, key: string, value: string | undefined): void {
  if (value) updates[key] = value;
}

// Database. NOTE: these keys must match what src/config/configuration.ts reads.
export function applyDatabaseSection(
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

export function applyRedisSection(
  redis: RedisConfigDto,
  existing: Record<string, string>,
  ctx: ConfigSectionContext,
): void {
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
export function applyStorageSection(
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
export function applyEngineSection(
  engine: EngineConfigDto,
  existing: Record<string, string>,
  ctx: ConfigSectionContext,
  engineFactory: EngineFactory,
): void {
  const { updates } = ctx;
  // Persist the selected engine so the Infrastructure tile can actually switch engines (the
  // active engine was previously only settable via the ENGINE_TYPE env, never from the UI).
  if (engine.type) {
    const validEngineIds = engineFactory.getAvailableEngines().map(e => e.id);
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
