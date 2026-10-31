import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PUPPETEER_ARGS } from '../../config/configuration';
import { isEnvPinned } from '../../config/env-precedence';
import { postgresSchemaError } from '../../config/env.validation';
import type { EngineFactory } from '../../engine/engine.factory';
import { datastoreInUse, hostPinnedElsewhere, namesBundledContainer } from '../docker';
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

// What the next boot reads for a key (a host, a selection) before this save changes it: the value the environment
// pins, else the stored one.
function nextBootValue(key: string, existing: Record<string, string>): string | undefined {
  return isEnvPinned(key) ? process.env[key] : existing[key];
}

// What the next boot's validation (env.validation.ts) reads from these keys, refused here instead: the saved
// file is loaded at boot, and a value it rejects crash-loops the instance and the dashboard that could undo it.
function portValue(label: string, value: string): string {
  const port = value.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new BadRequestException(`${label} must be an integer port in [1, 65535] (got ${JSON.stringify(value)})`);
  }
  return port;
}

// The selection a section applies to: the one sent, else the stored one, else the one the environment pins. Only a
// sent one is written, so a save that leaves it out (the page does for a pinned type in a card left untouched) never
// writes a selection over the stored choice. When the environment pins another selection than the stored one, the
// section's fields belong to neither boot: applied to the stored mode they reach the pinned boot now (a PostgreSQL
// DATABASE_NAME refuses a SQLite boot), applied to the pinned mode they reach the stored one once the pin is
// removed. Nothing of the section is written then (null). With no selection at all it cannot be read, and is refused.
function sectionType<T extends string>(
  section: string,
  key: string,
  sent: T | undefined,
  existing: Record<string, string>,
  allowed: readonly T[],
): T | null {
  if (sent) return sent;
  const stored = allowed.find(v => v === existing[key]);
  const pinned = isEnvPinned(key) ? allowed.find(v => v === process.env[key]) : undefined;
  if (stored && pinned && stored !== pinned) return null;
  const type = stored ?? pinned;
  if (type === undefined) {
    throw new BadRequestException(`${section}.type must be one of the following values: ${allowed.join(', ')}`);
  }
  return type;
}

// Database. NOTE: these keys must match what src/config/configuration.ts reads.
export function applyDatabaseSection(
  database: DatabaseConfigDto,
  existing: Record<string, string>,
  ctx: ConfigSectionContext,
): void {
  const { updates, staleKeys, profiles } = ctx;
  const type = sectionType('database', 'DATABASE_TYPE', database.type, existing, ['sqlite', 'postgres']);
  if (type === null) return;
  if (database.type) updates.DATABASE_TYPE = database.type;
  if (database.builtIn !== undefined) {
    updates.POSTGRES_BUILTIN = database.builtIn ? 'true' : 'false';
  }
  // An explicit choice applies the bundled preset; otherwise the stored host decides the mode. A pinned host must
  // not replace that stored choice, which takes effect again when the pin is removed. An omitted choice beside an
  // external host pin preserves the same stored service's connection details instead of applying its preset again.
  const dbBuiltIn = database.builtIn ?? namesBundledContainer('postgres', existing.DATABASE_HOST);
  if (type === 'postgres') {
    const preserveBundledDetails =
      dbBuiltIn &&
      database.builtIn === undefined &&
      existing.DATABASE_TYPE === 'postgres' &&
      hostPinnedElsewhere('postgres');
    if (dbBuiltIn && !preserveBundledDetails) {
      // Built-in PostgreSQL - use container name as host
      updates.DATABASE_HOST = 'postgres';
      updates.DATABASE_PORT = '5432';
      // A database the next boot already dials on the bundled container (by a host that names it in any spelling)
      // keeps the user, database and schema it uses there: such a file reads as built-in, and a save that changes
      // nothing else must not move the instance to another database. So does the one the bundled container serves the
      // running process, whose environment the boot loaded and a save leaves as it is: switched away and back before a
      // restart, the file holds the other server's values. From anywhere else they belong to another server.
      const servesStored =
        existing.DATABASE_TYPE === 'postgres' &&
        nextBootValue('DATABASE_TYPE', existing) === 'postgres' &&
        namesBundledContainer('postgres', nextBootValue('DATABASE_HOST', existing));
      const servesRunning =
        process.env.DATABASE_TYPE === 'postgres' && namesBundledContainer('postgres', process.env.DATABASE_HOST);
      const kept: Partial<Record<string, string>> = servesStored ? existing : servesRunning ? process.env : {};
      updates.DATABASE_USERNAME = kept.DATABASE_USERNAME || 'openwa';
      // Secrets are not echoed to the form. A blank password keeps one stored for PostgreSQL at the bundled host (stored, pinned,
      // or still serving the running process after a saved switch away); external credentials do not follow it.
      const storedPassword =
        existing.DATABASE_TYPE === 'postgres' &&
        (namesBundledContainer('postgres', existing.DATABASE_HOST) ||
          namesBundledContainer('postgres', nextBootValue('DATABASE_HOST', existing)))
          ? existing.DATABASE_PASSWORD
          : servesRunning
            ? process.env.DATABASE_PASSWORD
            : undefined;
      updates.DATABASE_PASSWORD = database.password || storedPassword || 'openwa';
      updates.DATABASE_NAME = kept.DATABASE_NAME || 'openwa';
      // A newly initialized bundled database starts in public; an existing one keeps its schema.
      updates.POSTGRES_SCHEMA = kept.POSTGRES_SCHEMA || 'public';
    } else if (!dbBuiltIn) {
      // Only an already selected external PostgreSQL owns the stored password. Startup flags do not
      // identify its server, and inactive SQLite details must not seed a newly selected service.
      if (
        (existing.DATABASE_TYPE !== 'postgres' || namesBundledContainer('postgres', existing.DATABASE_HOST)) &&
        !database.password
      ) {
        staleKeys.add('DATABASE_PASSWORD');
      }
      // A blank host or user is what boot reads as unset, which it refuses for PostgreSQL, so a padded or
      // whitespace-only value falls back to the default like an empty one.
      if (database.host !== undefined) updates.DATABASE_HOST = database.host.trim() || 'localhost';
      if (database.port !== undefined) {
        updates.DATABASE_PORT = database.port.trim() ? portValue('database.port', database.port) : '5432';
      }
      if (database.username !== undefined) updates.DATABASE_USERNAME = database.username.trim() || 'postgres';
      setSecret(updates, 'DATABASE_PASSWORD', database.password);
      if (database.database !== undefined) updates.DATABASE_NAME = database.database || 'openwa';
      // Left from SQLite, the key holds a file path, which the next boot would open as a PostgreSQL database name.
      // A file with no type beside a PostgreSQL pin holds a name the pinned server uses, so that one stays.
      else if (existing.DATABASE_TYPE !== 'postgres' && nextBootValue('DATABASE_TYPE', existing) !== 'postgres') {
        staleKeys.add('DATABASE_NAME');
      }
      if (database.schema !== undefined) {
        // Refuse a schema the next boot would reject, or the saved file crash-loops the instance.
        const schemaError = database.schema ? postgresSchemaError(database.schema) : null;
        if (schemaError) throw new BadRequestException(schemaError);
        updates.POSTGRES_SCHEMA = database.schema || 'public';
      }
    }
    if (dbBuiltIn) profiles.push('postgres');
    // null is what JSON makes of an emptied number input, and reads as absent like the other fields.
    if (database.poolSize !== undefined && database.poolSize !== null) {
      if (!Number.isInteger(database.poolSize) || database.poolSize < 0) {
        throw new BadRequestException(
          `database.poolSize must be a non-negative integer (got ${JSON.stringify(database.poolSize)})`,
        );
      }
      updates.DATABASE_POOL_SIZE = String(database.poolSize || 10);
    }
    // The bundled container runs without TLS (getContainerSpec sets none up), so a built-in database the next boot
    // dials there connects without it: SSL kept from an external server would refuse every connection. Beside a host
    // pinned elsewhere an inherited bundled choice keeps its stored TLS keys with its other connection details;
    // an explicit choice still writes the setting sent for that pinned server.
    if (dbBuiltIn && !hostPinnedElsewhere('postgres')) {
      updates.DATABASE_SSL = 'false';
      staleKeys.add('DATABASE_SSL_REJECT_UNAUTHORIZED');
    } else if (!preserveBundledDetails && database.sslEnabled !== undefined) {
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
    // A SQLite name is its file path; only the PostgreSQL name belongs to the mode being left.
    if (existing.DATABASE_TYPE === 'postgres') staleKeys.add('DATABASE_NAME');
    for (const k of [
      'DATABASE_HOST',
      'DATABASE_PORT',
      'DATABASE_USERNAME',
      'DATABASE_PASSWORD',
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
  // As for the database, an omitted choice follows the stored host, independently of the flag that starts a container.
  const redisBuiltIn = redis.builtIn ?? namesBundledContainer('redis', existing.REDIS_HOST);
  if (redisBuiltIn && (redis.builtIn !== undefined || !hostPinnedElsewhere('redis'))) {
    // Built-in Redis - use container name as host. The bundled container runs without
    // auth, so a password saved by an earlier external setup is stale: leaving it
    // would make the client AUTH against a passwordless server on the next boot.
    updates.REDIS_HOST = 'redis';
    updates.REDIS_PORT = '6379';
    // It also listens in plaintext and defines no ACL user, so TLS and a username kept from an external
    // server would fail the connection. Beside a host pinned elsewhere the stored values stay with that server.
    if (!hostPinnedElsewhere('redis')) {
      updates.REDIS_TLS = 'false';
      staleKeys.add('REDIS_USERNAME');
    }
    if (!redis.password) staleKeys.add('REDIS_PASSWORD');
  } else if (!redisBuiltIn) {
    // External Redis (explicit, or inherited when builtIn is absent)
    if (redis.host !== undefined) updates.REDIS_HOST = redis.host.trim() || 'localhost';
    if (redis.port !== undefined) {
      updates.REDIS_PORT = redis.port.trim() ? portValue('redis.port', redis.port) : '6379';
    }
  }
  setSecret(updates, 'REDIS_PASSWORD', redis.password);
  // What the next boot reads: a value the environment pins, else this save's, else the stored one. The queue
  // section is applied first, so its switch is in `updates` already.
  const saved = (key: string): string | undefined => updates[key] ?? existing[key];
  if (datastoreInUse('redis', key => (isEnvPinned(key) ? process.env[key] : saved(key)))) {
    if (redisBuiltIn) profiles.push('redis');
  } else if (!datastoreInUse('redis', saved)) {
    // Nothing the next boot runs reaches Redis, and the file does not either once a pin is removed, so no
    // bundled container may be started for it at boot or kept by the restart, which keeps a container while the
    // saved host still names it. A Redis only a pin switches off keeps the stored choice.
    updates.REDIS_BUILTIN = 'false';
    if (namesBundledContainer('redis', saved('REDIS_HOST'))) staleKeys.add('REDIS_HOST');
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
  const type = sectionType('storage', 'STORAGE_TYPE', storage.type, existing, ['local', 's3']);
  if (type === null) return;
  if (storage.type) updates.STORAGE_TYPE = storage.type;
  if (storage.builtIn !== undefined) {
    updates.MINIO_BUILTIN = storage.builtIn ? 'true' : 'false';
  }
  if (type === 'local') {
    // Switching to local: drop stale S3 keys, and reset the built-in flag with them —
    // there is no bundled MinIO backing a local storage path.
    updates.MINIO_BUILTIN = 'false';
    if (storage.localPath !== undefined) {
      updates.STORAGE_LOCAL_PATH = storage.localPath || './data/media';
    }
    // Switching to local: drop stale S3 keys.
    for (const k of [
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_BUCKET',
      'S3_REGION',
    ]) {
      staleKeys.add(k);
    }
  } else {
    staleKeys.add('STORAGE_LOCAL_PATH');
    // An absent builtIn follows the stored endpoint, as for the database and Redis.
    const storageBuiltIn = storage.builtIn ?? namesBundledContainer('minio', existing.S3_ENDPOINT);
    if (
      storageBuiltIn &&
      (storage.builtIn !== undefined || existing.STORAGE_TYPE !== 's3' || !hostPinnedElsewhere('minio'))
    ) {
      // Built-in MinIO - use container name as endpoint. The bundled keys are only the DEFAULT, as for the database
      // password: keys stored for S3 at the bundled endpoint (pinned or stored, in any spelling) are kept; else
      // the ones the running process dials it with, as for the database.
      const keepKeys =
        existing.STORAGE_TYPE === 's3' &&
        (namesBundledContainer('minio', existing.S3_ENDPOINT) ||
          namesBundledContainer('minio', nextBootValue('S3_ENDPOINT', existing)));
      const servesRunning =
        process.env.STORAGE_TYPE === 's3' && namesBundledContainer('minio', process.env.S3_ENDPOINT);
      const keys: Partial<Record<string, string>> = keepKeys ? existing : servesRunning ? process.env : {};
      updates.S3_ENDPOINT = 'http://minio:9000';
      updates.S3_ACCESS_KEY_ID = keys.S3_ACCESS_KEY_ID || keys.S3_ACCESS_KEY || 'minioadmin';
      updates.S3_SECRET_ACCESS_KEY = keys.S3_SECRET_ACCESS_KEY || keys.S3_SECRET_KEY || 'minioadmin';
      // As for the database: a bucket the next boot already reaches on the bundled MinIO, else the one it serves the
      // running process, is kept with its region.
      const servesStored =
        existing.STORAGE_TYPE === 's3' &&
        nextBootValue('STORAGE_TYPE', existing) === 's3' &&
        namesBundledContainer('minio', nextBootValue('S3_ENDPOINT', existing));
      const kept: Partial<Record<string, string>> = servesStored ? existing : servesRunning ? process.env : {};
      updates.S3_BUCKET = kept.S3_BUCKET || 'openwa';
      updates.S3_REGION = kept.S3_REGION || 'us-east-1';
    } else if (!storageBuiltIn) {
      // Only an already selected external S3 service owns the stored credentials and endpoint.
      // A new external selection must not reuse bundled or inactive local-storage details.
      if (existing.STORAGE_TYPE !== 's3' || namesBundledContainer('minio', existing.S3_ENDPOINT)) {
        if (!storage.s3AccessKey) staleKeys.add('S3_ACCESS_KEY_ID');
        if (!storage.s3SecretKey) staleKeys.add('S3_SECRET_ACCESS_KEY');
        staleKeys.add('S3_ACCESS_KEY');
        staleKeys.add('S3_SECRET_KEY');
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
    if (storageBuiltIn) profiles.push('minio');
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
    // Once compose blank-forwards PUPPETEER_ARGS, this saved value wins at runtime, so an empty field
    // saves the same default configuration.ts applies.
    updates.PUPPETEER_ARGS = engine.browserArgs || DEFAULT_PUPPETEER_ARGS.join(' ');
  }
}
