import { useEffect, useRef, useState } from 'react';
import type { InfraStatus, SavedConfig, SaveConfigPayload } from '../services/api';
import { namesBundledContainer } from '../utils/bundledHost';

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  builtIn: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  schema: string;
  poolSize: number;
  sslEnabled: boolean;
  sslRejectUnauthorized: boolean;
}

export interface RedisConfig {
  builtIn: boolean;
  host: string;
  port: string;
  password: string;
  connected: boolean;
}

export interface StorageConfig {
  type: 'local' | 's3';
  builtIn: boolean;
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
}

export interface EngineConfig {
  type: string;
  headless: boolean;
  sessionDataPath: string;
  browserArgs: string;
}

export interface InfraConfigForm {
  dbConfig: DatabaseConfig;
  redisConfig: RedisConfig;
  storageConfig: StorageConfig;
  engineConfig: EngineConfig;
  redisEnabled: boolean;
  queueEnabled: boolean;
  setRedisEnabled: (enabled: boolean) => void;
  setQueueEnabled: (enabled: boolean) => void;
  /** For the LIVE redis.connected indicator only — not an editable form field. See Infrastructure.tsx. */
  setRedisConnected: (connected: boolean) => void;
  updateDbConfig: (key: keyof DatabaseConfig, value: string | number | boolean) => void;
  updateRedisConfig: (key: keyof RedisConfig, value: string | boolean) => void;
  updateStorageConfig: (key: keyof StorageConfig, value: string | boolean) => void;
  updateEngineConfig: (key: keyof EngineConfig, value: string | boolean) => void;
  buildSavePayload: () => SaveConfigPayload;
}

/**
 * The Use Built-in flag as saved. When `builtInSet` is false the config states no mode for the service: a host the
 * environment pins decides it, the file does not select the service (the first boot writes every flag as false), or
 * nothing is saved. What runs stands in for it then: there is no pending switch, and a save keeps sending the mode
 * that runs.
 */
export const savedBuiltIn = (saved: { builtIn: boolean; builtInSet: boolean }, running: boolean): boolean =>
  saved.builtInSet ? saved.builtIn : running;

/**
 * Owns the editable infrastructure form: dbConfig/redisConfig/storageConfig/engineConfig, the
 * redis-enabled/queue-enabled toggles, and the hydration that seeds them from the two server
 * sources (live /status + saved /config). Takes those two query results as arguments rather than
 * calling the query hooks itself — the page already holds them for its own loading/error early
 * returns, and passing them in keeps this hook testable without a QueryClientProvider.
 *
 * `redisConfig.connected` and the page's `queueStats` are LIVE indicators, not editable form state —
 * they are seeded by a separate effect that lives in the page (every refetch, not just once), and
 * `setRedisConnected` is the narrow write-path that effect uses into this hook's redisConfig.
 */
export function useInfraConfigForm(
  infraStatus: InfraStatus | undefined,
  savedConfig: SavedConfig | undefined,
): InfraConfigForm {
  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    type: 'sqlite',
    builtIn: false,
    host: 'localhost',
    port: '5432',
    username: 'postgres',
    password: '',
    database: 'openwa',
    schema: 'public',
    poolSize: 10,
    sslEnabled: false,
    sslRejectUnauthorized: true,
  });

  const [redisConfig, setRedisConfig] = useState<RedisConfig>({
    builtIn: false,
    host: 'localhost',
    port: '6379',
    password: '',
    connected: false,
  });

  const [storageConfig, setStorageConfig] = useState<StorageConfig>({
    type: 'local',
    builtIn: false,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3AccessKey: '',
    s3SecretKey: '',
    s3Endpoint: '',
  });

  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: 'whatsapp-web.js',
    headless: true,
    sessionDataPath: './data/sessions',
    browserArgs: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
  });

  const [redisEnabled, setRedisEnabledState] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);

  // Whether the editable form has been seeded from the server once. After that, a background refetch
  // (react-query refetchOnWindowFocus) must NOT re-seed the editable fields or it would wipe the
  // operator's in-progress, unsaved edits. A successful save restarts → full page reload, re-arming it.
  const formHydrated = useRef(false);

  // The engine radio seeds ONCE from the saved file (see the effect below), then is never re-stamped by
  // a background refetch. `engineTouched` additionally wins over a late first resolution: if the
  // operator clicked a different engine before the seed resolved, the delayed seed must not revert
  // their selection (#735).
  const engineHydrated = useRef(false);
  const engineTouched = useRef(false);
  // Whether the operator has edited the database card, the storage card or the Redis switch here. Until then a
  // selection the environment pins is the pin, not a choice, and a save leaves it out (see buildSavePayload).
  const dbTouched = useRef(false);
  const redisTouched = useRef(false);
  const storageTouched = useRef(false);
  const redisEnabledTouched = useRef(false);
  // Whether the operator has used each Use Built-in toggle here; beside a pinned host an unused one is left out.
  const dbBuiltInTouched = useRef(false);
  const redisBuiltInTouched = useRef(false);
  const storageBuiltInTouched = useRef(false);

  /** Whether engineConfig.type reflects a real value (seeded from the saved config or user-picked)
   * rather than the useState default — the save payload omits `type` when it doesn't. */
  const engineTypeKnown = (): boolean => engineHydrated.current || engineTouched.current;

  // Seed the editable form ONCE, when both reads are in. The saved config (data/.env.generated) is the
  // operator's intent, so it supplies every selection and detail field: the running process is stale from
  // the moment a change is saved until the server restarts, and a form seeded from it writes that stale
  // value back over the saved one on the next save of ANY field, deleting the stored settings of the
  // service it switched away from (the engine radio below learned the same, #1082). That holds for the Use
  // Built-in toggles too: shown from what runs, one that reads "external" invites typing an external host
  // and credentials that the gateway drops under the stored bundled mode. What is running is reported by the
  // badges and the pending-restart notes. Only a host, port or path nothing has saved comes from the live
  // /status, and so does a built-in flag nothing stores. One effect once both exist also keeps the result from depending on which read settled last.
  // Secrets are never returned, so their inputs stay empty; an empty submit preserves the stored secret on
  // the backend (#226).
  useEffect(() => {
    if (!infraStatus || !savedConfig || formHydrated.current) return;
    formHydrated.current = true;
    const { database, redis, queue, storage, engine } = savedConfig;
    setDbConfig(prev => ({
      ...prev,
      type: database.type,
      host: database.host || infraStatus.database.host || 'localhost',
      port: database.port || prev.port,
      username: database.username || prev.username,
      database: database.database || prev.database,
      schema: database.schema || prev.schema,
      poolSize: database.poolSize,
      sslEnabled: database.sslEnabled,
      sslRejectUnauthorized: database.sslRejectUnauthorized,
      builtIn: savedBuiltIn(database, infraStatus.database.builtIn),
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: redis.host || infraStatus.redis.host,
      port: redis.port || String(infraStatus.redis.port),
      builtIn: savedBuiltIn(redis, infraStatus.redis.builtIn),
    }));
    setRedisEnabledState(redis.enabled);
    setQueueEnabled(queue.enabled);
    setStorageConfig(prev => ({
      ...prev,
      type: storage.type,
      localPath: storage.localPath || infraStatus.storage.path || './uploads',
      s3Bucket: storage.s3Bucket || prev.s3Bucket,
      s3Region: storage.s3Region || prev.s3Region,
      s3Endpoint: storage.s3Endpoint || prev.s3Endpoint,
      builtIn: savedBuiltIn(storage, infraStatus.storage.builtIn),
    }));
    setEngineConfig(prev => ({
      ...prev,
      headless: engine.headless,
      sessionDataPath: engine.sessionDataPath || prev.sessionDataPath,
      browserArgs: engine.browserArgs || prev.browserArgs,
    }));
  }, [infraStatus, savedConfig]);

  // Seed the radio once from /config, and never after the operator has touched it (#735).
  //
  // /config reports the EFFECTIVE engine: the saved file value while nothing pins ENGINE_TYPE, the
  // pinned value outright when an environment variable supplies one (#1313). Either way the seeded
  // value may be one nobody chose here — the running one is stale from the moment a change is saved
  // until the server restarts — so the seed is display-only: buildSavePayload omits `type` for an
  // untouched seed under a pin, and only an operator click (engineTouched) persists a selection. What
  // is actually running is reported by the card badge and, when the two differ, named by the card's
  // own notice.
  useEffect(() => {
    const seed = savedConfig?.engine.type;
    if (!seed || engineHydrated.current || engineTouched.current) return;
    engineHydrated.current = true;
    setEngineConfig(prev => (prev.type === seed ? prev : { ...prev, type: seed }));
  }, [savedConfig]);

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) => {
    dbTouched.current = true;
    if (key === 'builtIn') dbBuiltInTouched.current = true;
    setDbConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) => {
    redisTouched.current = true;
    if (key === 'builtIn') redisBuiltInTouched.current = true;
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) => {
    storageTouched.current = true;
    if (key === 'builtIn') storageBuiltInTouched.current = true;
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  };
  const updateEngineConfig = (key: keyof EngineConfig, value: string | boolean) => {
    if (key === 'type') engineTouched.current = true;
    setEngineConfig(prev => ({ ...prev, [key]: value }));
  };

  // Disabling Redis also disables the queue, since queue processing depends on it.
  const setRedisEnabled = (enabled: boolean) => {
    redisEnabledTouched.current = true;
    setRedisEnabledState(enabled);
    if (!enabled) setQueueEnabled(false);
  };

  const setRedisConnected = (connected: boolean) => setRedisConfig(prev => ({ ...prev, connected }));

  // /config reports the EFFECTIVE selection, so under a pin the form shows the pinned value. Sending it back would
  // write the pin into data/.env.generated over the stored choice, which unsetting the variable was supposed to
  // reveal (#1082), and drop the stored settings of the mode it replaces. Untouched, it is left out, and the
  // gateway keeps the stored selection. Any edit in the database or storage card sends it: the edited fields belong
  // to the mode the card shows, and a stored selection of the other mode would drop them. Read at save time, like
  // the engine pin below. A pinned host decides the built-in mode the same way, and a flag of true sent beside it
  // writes the bundled credentials over stored ones the pinned host may still need, so an unused toggle there is
  // left out too and the gateway keeps the stored flag, unless the form changes the selection the flag belongs to:
  // the stored flag is the one of the selection being left then (the first boot writes it false beside SQLite). Beside
  // a host pinned elsewhere the card shows the external server the next boot dials, so an edit in the card belongs to
  // that server and sends the flag the card shows; left out, the gateway would apply a stored built-in mode instead.
  const pinnedSeed = (key: string, touched: { current: boolean }) =>
    !touched.current && !!infraStatus?.envPinned?.includes(key);
  const editedAway = (profile: string, pinnedHost: string | undefined, touched: { current: boolean }) =>
    touched.current && !namesBundledContainer(profile, pinnedHost);

  const buildSavePayload = (): SaveConfigPayload => ({
    // A bundled container never receives a typed password (the field is hidden once built-in is on,
    // but a value typed before the toggle survives in state). '' means "unchanged" on the backend.
    // An emptied pool size is NaN, which JSON writes as null and the backend refuses: leave it out.
    database: {
      ...dbConfig,
      type: pinnedSeed('DATABASE_TYPE', dbTouched) ? undefined : dbConfig.type,
      builtIn:
        pinnedSeed('DATABASE_HOST', dbBuiltInTouched) &&
        dbConfig.type === savedConfig?.database.type &&
        !editedAway('postgres', savedConfig?.database.host, dbTouched)
          ? undefined
          : dbConfig.builtIn,
      password: dbConfig.builtIn ? '' : dbConfig.password,
      // The bundled container runs without TLS, so a built-in database is saved with SSL off (the gateway writes that
      // too); beside a host pinned elsewhere the next boot dials that server, and the setting shown stays.
      sslEnabled:
        dbConfig.builtIn &&
        !(
          infraStatus?.envPinned?.includes('DATABASE_HOST') &&
          !namesBundledContainer('postgres', savedConfig?.database.host)
        )
          ? false
          : dbConfig.sslEnabled,
      poolSize: Number.isInteger(dbConfig.poolSize) ? dbConfig.poolSize : undefined,
    },
    // `connected` is runtime-only status, not persisted configuration. Keep it out of the
    // whitelisted backend DTO so a valid dashboard save cannot be rejected as an unknown field.
    redis: {
      enabled: pinnedSeed('REDIS_ENABLED', redisEnabledTouched) ? undefined : redisEnabled,
      builtIn:
        pinnedSeed('REDIS_HOST', redisBuiltInTouched) &&
        redisEnabled === savedConfig?.redis.enabled &&
        !editedAway('redis', savedConfig?.redis.host, redisTouched)
          ? undefined
          : redisConfig.builtIn,
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.builtIn ? '' : redisConfig.password,
    },
    queue: { enabled: queueEnabled },
    storage: {
      ...storageConfig,
      type: pinnedSeed('STORAGE_TYPE', storageTouched) ? undefined : storageConfig.type,
      builtIn:
        pinnedSeed('S3_ENDPOINT', storageBuiltInTouched) &&
        storageConfig.type === savedConfig?.storage.type &&
        !editedAway('minio', savedConfig?.storage.s3Endpoint, storageTouched)
          ? undefined
          : storageConfig.builtIn,
    },
    // Only send `type` once we actually know it — either the radio seeded from /config or the
    // operator picked one. If /config never resolved, engineConfig.type still holds its useState
    // default, and sending that would persist ENGINE_TYPE and silently flip the engine on the next
    // restart. The backend treats an absent `type` as "leave ENGINE_TYPE alone".
    //
    // An untouched seed under a PINNED ENGINE_TYPE counts as unknown too: /config reports the
    // effective (pinned) engine, so the seeded value is the pin, not a choice made here — sending
    // it would bake the pin into data/.env.generated over the operator's stored choice, which
    // unsetting the variable was supposed to reveal (#1082). Pin-ness is read HERE, at save time,
    // not at seed time: the two queries settle independently and the save click always sees the
    // latest /status. An operator click (engineTouched) is a deliberate choice and always sends.
    engine:
      engineTypeKnown() &&
      !(engineHydrated.current && !engineTouched.current && infraStatus?.envPinned?.includes('ENGINE_TYPE'))
        ? { ...engineConfig }
        : { ...engineConfig, type: undefined },
  });

  return {
    dbConfig,
    redisConfig,
    storageConfig,
    engineConfig,
    redisEnabled,
    queueEnabled,
    setRedisEnabled,
    setQueueEnabled,
    setRedisConnected,
    updateDbConfig,
    updateRedisConfig,
    updateStorageConfig,
    updateEngineConfig,
    buildSavePayload,
  };
}
