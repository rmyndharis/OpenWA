import { useEffect, useRef, useState } from 'react';
import type { InfraStatus, SavedConfig, SaveConfigPayload } from '../services/api';

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
 * Owns the editable infrastructure form: dbConfig/redisConfig/storageConfig/engineConfig, the
 * redis-enabled/queue-enabled toggles, and the hydration that seeds them from the two server
 * sources (live /status + saved /config). Takes those two query results (plus the resolved current
 * engine) as arguments rather than calling the query hooks itself — the page already holds them for
 * its own loading/error early returns, and passing them in keeps this hook testable without a
 * QueryClientProvider.
 *
 * `redisConfig.connected` and the page's `queueStats` are LIVE indicators, not editable form state —
 * they are seeded by a separate effect that lives in the page (every refetch, not just once), and
 * `setRedisConnected` is the narrow write-path that effect uses into this hook's redisConfig.
 */
export function useInfraConfigForm(
  infraStatus: InfraStatus | undefined,
  savedConfig: SavedConfig | undefined,
  currentEngine: string,
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

  // The engine radio seeds ONCE from the running engine (which honours a real ENGINE_TYPE env override
  // over the saved .env.generated value — see the effect below), then is never re-stamped by a background
  // refetch. `engineTouched` additionally wins over a late first resolution: if the operator clicked a
  // different engine before /engines/current resolved, the delayed seed must not revert their selection (#735).
  const engineHydrated = useRef(false);
  const engineTouched = useRef(false);

  /** Whether engineConfig.type reflects a real value (seeded from the running engine or user-picked)
   * rather than the useState default — the save payload omits `type` when it doesn't. */
  const engineTypeKnown = (): boolean => engineHydrated.current || engineTouched.current;

  // Seed the EDITABLE selections from live /status ONCE (the running selection), guarded so a refetch
  // can't clobber an unsaved edit. These are also the badge sources, so on first paint they show what's
  // actually running (#488 family).
  useEffect(() => {
    if (!infraStatus || formHydrated.current) return;
    setDbConfig(prev => ({
      ...prev,
      type: (infraStatus.database.type as 'sqlite' | 'postgres') || 'sqlite',
      host: infraStatus.database.host || 'localhost',
      // builtIn reflects whether OpenWA's bundled container is actually running (live), not saved intent.
      builtIn: infraStatus.database.builtIn,
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: infraStatus.redis.host,
      port: String(infraStatus.redis.port),
      builtIn: infraStatus.redis.builtIn,
    }));
    setRedisEnabledState(infraStatus.redis.enabled);
    setStorageConfig(prev => ({
      ...prev,
      type: infraStatus.storage.type,
      localPath: infraStatus.storage.path || './uploads',
      builtIn: infraStatus.storage.builtIn,
    }));
    setQueueEnabled(infraStatus.queue.enabled);
  }, [infraStatus]);

  // Hydrate the editable form from the saved config (data/.env.generated) ONCE — only the detail fields
  // /status does not expose (username, pool size, SSL flags, S3 details, host/port). The "what's
  // running" fields (type, redis enabled, storage type, built-in) are owned by the live /status effect
  // above. Secrets are never returned, so their inputs stay empty; an empty submit preserves the stored
  // secret on the backend (#226).
  useEffect(() => {
    if (!savedConfig || formHydrated.current) return;
    // NOTE: builtIn for db/redis/storage is owned by the live /status effect above (it reflects the
    // actually-running bundled container), so it is intentionally NOT set here from saved intent.
    setDbConfig(prev => ({
      ...prev,
      host: savedConfig.database.host || prev.host,
      port: savedConfig.database.port || prev.port,
      username: savedConfig.database.username || prev.username,
      database: savedConfig.database.database || prev.database,
      schema: savedConfig.database.schema || prev.schema,
      poolSize: savedConfig.database.poolSize,
      sslEnabled: savedConfig.database.sslEnabled,
      sslRejectUnauthorized: savedConfig.database.sslRejectUnauthorized,
    }));
    setRedisConfig(prev => ({
      ...prev,
      host: savedConfig.redis.host || prev.host,
      port: savedConfig.redis.port || prev.port,
    }));
    setStorageConfig(prev => ({
      ...prev,
      localPath: savedConfig.storage.localPath || prev.localPath,
      s3Bucket: savedConfig.storage.s3Bucket || prev.s3Bucket,
      s3Region: savedConfig.storage.s3Region || prev.s3Region,
      s3Endpoint: savedConfig.storage.s3Endpoint || prev.s3Endpoint,
    }));
    setEngineConfig(prev => ({
      ...prev,
      headless: savedConfig.engine.headless,
      sessionDataPath: savedConfig.engine.sessionDataPath || prev.sessionDataPath,
      browserArgs: savedConfig.engine.browserArgs || prev.browserArgs,
    }));
  }, [savedConfig]);

  // Lock the editable form once both sources have seeded it, so later background refetches only refresh
  // the live indicators above and never overwrite unsaved edits.
  useEffect(() => {
    if (infraStatus && savedConfig) formHydrated.current = true;
  }, [infraStatus, savedConfig]);

  // The active engine reflects what's actually running (honours a real-env ENGINE_TYPE override),
  // so seed the selected radio from it rather than the saved .env.generated value — but only ONCE, and
  // never after the operator has touched it. Without this guard a background refetch (or a late first
  // resolution racing an early click) re-stamps the running engine over an in-progress selection (#735).
  useEffect(() => {
    if (!currentEngine || engineHydrated.current || engineTouched.current) return;
    engineHydrated.current = true;
    setEngineConfig(prev => (prev.type === currentEngine ? prev : { ...prev, type: currentEngine }));
  }, [currentEngine]);

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) =>
    setDbConfig(prev => ({ ...prev, [key]: value }));
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) =>
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) =>
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  const updateEngineConfig = (key: keyof EngineConfig, value: string | boolean) => {
    if (key === 'type') engineTouched.current = true;
    setEngineConfig(prev => ({ ...prev, [key]: value }));
  };

  // Disabling Redis also disables the queue, since queue processing depends on it.
  const setRedisEnabled = (enabled: boolean) => {
    setRedisEnabledState(enabled);
    if (!enabled) setQueueEnabled(false);
  };

  const setRedisConnected = (connected: boolean) => setRedisConfig(prev => ({ ...prev, connected }));

  const buildSavePayload = (): SaveConfigPayload => ({
    database: { ...dbConfig },
    // `connected` is runtime-only status, not persisted configuration. Keep it out of the
    // whitelisted backend DTO so a valid dashboard save cannot be rejected as an unknown field.
    redis: {
      enabled: redisEnabled,
      builtIn: redisConfig.builtIn,
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
    },
    queue: { enabled: queueEnabled },
    storage: { ...storageConfig },
    // Only send `type` once we actually know it — either the radio seeded from the running engine
    // or the operator picked one. If /engines/current never resolved (endpoint down), engineConfig.type
    // still holds its useState default, and sending that would persist ENGINE_TYPE and silently flip
    // the engine on the next restart. The backend treats an absent `type` as "leave ENGINE_TYPE alone".
    engine: engineTypeKnown() ? { ...engineConfig } : { ...engineConfig, type: undefined },
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
