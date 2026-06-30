import { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Database,
  Server,
  HardDrive,
  Save,
  ExternalLink,
  Loader2,
  CheckCircle,
  Cpu,
  AlertTriangle,
  Download,
  Upload,
} from 'lucide-react';
import { infraApi, API_BASE_URL } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useInfraStatusQuery,
  useInfraConfigQuery,
  useEnginesQuery,
  useCurrentEngineQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Infrastructure.css';

import sqliteIcon from '../assets/icons/sqlite.svg';
import postgresIcon from '../assets/icons/postgresql.svg';
import folderIcon from '../assets/icons/folder.svg';
import s3Icon from '../assets/icons/s3.svg';

interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  builtIn: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  poolSize: number;
  sslEnabled: boolean;
  sslRejectUnauthorized: boolean;
}

interface RedisConfig {
  builtIn: boolean;
  host: string;
  port: string;
  password: string;
  connected: boolean;
}

interface StorageConfig {
  type: 'local' | 's3';
  builtIn: boolean;
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
}

interface EngineConfig {
  type: string;
  headless: boolean;
  sessionDataPath: string;
  browserArgs: string;
}

interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
}

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const toast = useToast();
  const { data: infraStatus, isLoading: loading, isError: statusError } = useInfraStatusQuery();
  const { data: savedConfig } = useInfraConfigQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const currentEngine = currentEngineData?.engineType ?? '';
  const [saving, setSaving] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'waiting' | 'success' | 'error'>('idle');

  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    type: 'sqlite',
    builtIn: false,
    host: 'localhost',
    port: '5432',
    username: 'postgres',
    password: '',
    database: 'openwa',
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

  const [queueStats, setQueueStats] = useState({
    webhooks: { pending: 0, completed: 0, failed: 0 } as QueueStats,
  });

  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: 'whatsapp-web.js',
    headless: true,
    sessionDataPath: './data/sessions',
    browserArgs: '--no-sandbox --disable-gpu',
  });

  const [redisEnabled, setRedisEnabled] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [pendingProfiles, setPendingProfiles] = useState<string[]>([]);
  const [previousProfiles, setPreviousProfiles] = useState<string[]>([]);
  // Set when the just-saved config changes the DB or storage backend vs what's running, so the restart
  // modal can warn that the new backend starts empty and offer a data backup before switching (#488).
  const [dbSwitch, setDbSwitch] = useState(false);
  const [storageSwitch, setStorageSwitch] = useState(false);
  const [migrating, setMigrating] = useState(false);
  // After a successful save (before the restart reloads the page), /config holds the new value but
  // /status still holds the old one — so suppress the "pinned by environment" note, which infers a pin
  // from exactly that divergence and would otherwise mislabel a pending change.
  const [savePending, setSavePending] = useState(false);

  // Whether the editable form has been seeded from the server once. After that, a background refetch
  // (react-query refetchOnWindowFocus) must NOT re-seed the editable fields or it would wipe the
  // operator's in-progress, unsaved edits. A successful save restarts → full page reload, re-arming it.
  const formHydrated = useRef(false);

  // LIVE indicators (not editable) — always reflect the running process, every refetch.
  useEffect(() => {
    if (!infraStatus) return;
    setRedisConfig(prev => ({ ...prev, connected: infraStatus.redis.connected }));
    setQueueStats({ webhooks: infraStatus.queue.webhooks });
  }, [infraStatus]);

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
    setRedisEnabled(infraStatus.redis.enabled);
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
  // so seed the selected radio from it rather than the saved .env.generated value.
  useEffect(() => {
    if (currentEngine) setEngineConfig(prev => ({ ...prev, type: currentEngine }));
  }, [currentEngine]);

  if (loading) {
    return (
      <div
        className="infrastructure-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  // If the live infrastructure status can't be loaded, do NOT render the editable form: it would seed
  // from component defaults (sqlite/local/built-in:false) and a Save could flip a running backend to
  // external+empty. Show an error + retry instead. (#488 review)
  if (statusError || !infraStatus) {
    return (
      <div className="infrastructure-page">
        <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />
        <div className="infra-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
          <AlertTriangle size={32} style={{ color: 'var(--warning, #d97706)', marginBottom: '1rem' }} />
          <p style={{ margin: 0 }}>{t('infrastructure.statusLoadError')}</p>
          <button className="btn-secondary" style={{ marginTop: '1.25rem' }} onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) =>
    setDbConfig(prev => ({ ...prev, [key]: value }));
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) =>
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) =>
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  const updateEngineConfig = (key: keyof EngineConfig, value: string | boolean) =>
    setEngineConfig(prev => ({ ...prev, [key]: value }));

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const payload = {
        database: { ...dbConfig },
        redis: { enabled: redisEnabled, ...redisConfig },
        queue: { enabled: queueEnabled },
        storage: { ...storageConfig },
        engine: { ...engineConfig },
      };

      const result = await infraApi.saveConfig(payload);
      if (result.saved) {
        setSavePending(true);
        setPreviousProfiles(pendingProfiles);
        setPendingProfiles(result.profiles || []);
        // Flag a backend switch vs what's actually running so the restart modal can warn about the
        // empty-database / orphaned-media data move before it happens. A switch is: changing type;
        // flipping built-in↔external (different physical backend); OR retargeting an external Postgres
        // to a different host/port/database (also a different, empty DB). Host/port/db aren't all in
        // /status, so compare the edited form against the still-cached saved config.
        const dbExternalRetarget =
          dbConfig.type === 'postgres' &&
          !dbConfig.builtIn &&
          !!savedConfig &&
          (dbConfig.host !== savedConfig.database.host ||
            dbConfig.port !== savedConfig.database.port ||
            dbConfig.database !== savedConfig.database.database);
        setDbSwitch(
          !!infraStatus &&
            (dbConfig.type !== infraStatus.database.type ||
              (dbConfig.type === 'postgres' && dbConfig.builtIn !== infraStatus.database.builtIn) ||
              dbExternalRetarget),
        );
        // Scope: this warns on a backend-TYPE change (local↔s3) and a built-in↔external flip — the cases
        // that point at a different store. It does NOT warn on same-backend repointing (e.g. a new S3
        // bucket/endpoint or a new local path); region/endpoint aren't on /status to compare reliably.
        setStorageSwitch(
          !!infraStatus &&
            (storageConfig.type !== infraStatus.storage.type ||
              (storageConfig.type === 's3' && storageConfig.builtIn !== infraStatus.storage.builtIn)),
        );
        setShowRestartModal(true);
      } else {
        toast.error(t('infrastructure.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

  // Download a JSON backup of all Data-DB tables. Called BEFORE a DB switch (while still on the old
  // database) so the data can be re-imported into the new one — switching otherwise starts empty (#488).
  const handleExportBackup = async () => {
    setMigrating(true);
    try {
      const dump = await infraApi.exportData();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openwa-backup-${dump.exportedAt?.slice(0, 10) || 'data'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(t('infrastructure.migration.exportFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setMigrating(false);
    }
  };

  // Restore a previously-exported backup into the CURRENT database (use after switching + restart).
  // Import REPLACES all current data, so validate + confirm (showing the row count) before any call.
  const handleImportBackup = async (file: File) => {
    let parsed: { tables?: Record<string, unknown[]> };
    try {
      parsed = JSON.parse(await file.text()) as { tables?: Record<string, unknown[]> };
    } catch {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    if (!parsed?.tables || typeof parsed.tables !== 'object') {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    const rows = Object.values(parsed.tables).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    if (!window.confirm(t('infrastructure.migration.importConfirm', { rows }))) return;
    setMigrating(true);
    try {
      const res = await infraApi.importData(parsed.tables);
      if (res.imported) toast.success(t('infrastructure.migration.importOk'));
      else toast.error(t('infrastructure.migration.importFailed'), (res.warnings || []).slice(0, 3).join('; ') || res.message);
    } catch (err) {
      // A large backup can exceed the request body cap (default 25mb) — give an actionable message
      // instead of a bare "Payload Too Large". The status is carried on the Error by the api client.
      const status = (err as { status?: number } | null)?.status;
      const detail =
        status === 413
          ? t('infrastructure.migration.importTooLarge')
          : err instanceof Error
            ? err.message
            : t('common.unknownError');
      toast.error(t('infrastructure.migration.importFailed'), detail);
    } finally {
      setMigrating(false);
    }
  };

  const handleRestart = async () => {
    setRestartStatus('restarting');
    setRestartCountdown(30);

    const profilesToRemove = previousProfiles.filter(p => !pendingProfiles.includes(p));

    try {
      const response = await infraApi.restart(pendingProfiles, profilesToRemove);
      if (response.estimatedTime) setRestartCountdown(response.estimatedTime);
    } catch {
      // Expected — server shutting down
    }

    setRestartStatus('waiting');
    let intervalRef: ReturnType<typeof setInterval> | null = null;
    const stopCountdown = () => {
      if (intervalRef) {
        clearInterval(intervalRef);
        intervalRef = null;
      }
    };

    intervalRef = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    checkServerHealth(stopCountdown);
  };

  const checkServerHealth = async (stopCountdown?: () => void) => {
    let attempts = 0;
    const maxAttempts = 60;

    const check = async () => {
      try {
        await infraApi.healthCheck();
        stopCountdown?.();
        setRestartCountdown(0);
        setRestartStatus('success');
        setTimeout(() => window.location.reload(), 2000);
      } catch {
        attempts++;
        if (attempts < maxAttempts) setTimeout(check, 1000);
        else setRestartStatus('error');
      }
    };

    setTimeout(check, 3000);
  };

  // A setting whose RUNNING value (/status) differs from the SAVED file (/config) is being pinned by a
  // host/.env environment variable, which wins at runtime — so a dashboard change to it won't apply
  // until that variable is unset. Surface that honestly instead of letting the control look effective.
  const dbPinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.database.type !== savedConfig.database.type;
  const redisPinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.redis.enabled !== savedConfig.redis.enabled;
  const storagePinnedByEnv =
    !savePending && !!infraStatus && !!savedConfig && infraStatus.storage.type !== savedConfig.storage.type;
  const envPinNote = (pinned: boolean) =>
    pinned ? (
      <p className="env-pin-note">
        <AlertTriangle size={14} /> {t('infrastructure.envPinNote')}
      </p>
    ) : null;

  return (
    <div className="infrastructure-page">
      <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />

      <div className="infra-sections">
        {/* Database */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Database size={20} />
              <h2>{t('infrastructure.database.title')}</h2>
            </div>
            <span className={`status-indicator ${dbConfig.type === 'postgres' ? 'connected' : 'sqlite'}`}>
              ● {dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
            </span>
          </div>
          {envPinNote(dbPinnedByEnv)}

          <div className="radio-group">
            <label className={`radio-option ${dbConfig.type === 'sqlite' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={dbConfig.type === 'sqlite'}
                onChange={() => updateDbConfig('type', 'sqlite')}
              />
              <img src={sqliteIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.sqlite')}</span>
              <small>{t('infrastructure.database.sqliteDesc')}</small>
            </label>
            <label className={`radio-option ${dbConfig.type === 'postgres' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={dbConfig.type === 'postgres'}
                onChange={() => updateDbConfig('type', 'postgres')}
              />
              <img src={postgresIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.postgres')}</span>
              <small>{t('infrastructure.database.postgresDesc')}</small>
            </label>
          </div>

          {dbConfig.type === 'postgres' && (
            <>
              <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                <div className="toggle-info">
                  <span>{t('infrastructure.database.useBuiltIn')}</span>
                  <small>{t('infrastructure.database.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={dbConfig.builtIn}
                    onChange={e => updateDbConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!dbConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input type="text" value={dbConfig.host} onChange={e => updateDbConfig('host', e.target.value)} />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input type="text" value={dbConfig.port} onChange={e => updateDbConfig('port', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.username')}</label>
                      <input
                        type="text"
                        value={dbConfig.username}
                        onChange={e => updateDbConfig('username', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={dbConfig.password}
                        onChange={e => updateDbConfig('password', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('infrastructure.database.dbName')}</label>
                      <input
                        type="text"
                        value={dbConfig.database}
                        onChange={e => updateDbConfig('database', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('infrastructure.database.poolSize')}</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={dbConfig.poolSize}
                        onChange={e => updateDbConfig('poolSize', parseInt(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <span>{t('infrastructure.database.ssl')}</span>
                      <small>{t('infrastructure.database.sslDesc')}</small>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={dbConfig.sslEnabled}
                        onChange={e => updateDbConfig('sslEnabled', e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                  {dbConfig.sslEnabled && (
                    <div className="toggle-row">
                      <div className="toggle-info">
                        <span>{t('infrastructure.database.sslRejectUnauthorized')}</span>
                        <small>{t('infrastructure.database.sslRejectUnauthorizedDesc')}</small>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={dbConfig.sslRejectUnauthorized}
                          onChange={e => updateDbConfig('sslRejectUnauthorized', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div
            className="empty-state-card"
            style={{
              padding: '2.5rem',
              textAlign: 'center',
              background: '#F8FAFC',
              borderRadius: '12px',
              border: '1px dashed #E2E8F0',
              marginTop: '1rem',
            }}
          >
            <Database size={32} style={{ color: '#22C55E', marginBottom: '1rem', opacity: 0.7 }} />
            <p style={{ margin: 0, color: '#475569', fontSize: '0.9375rem', fontWeight: 500 }}>
              {t('infrastructure.database.migrationsTitle')}
            </p>
            <p
              style={{
                margin: '0.75rem 0 0',
                color: '#22C55E',
                fontSize: '0.875rem',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
              }}
            >
              <CheckCircle size={16} />
              {t('infrastructure.database.migrationsStatus')}
            </p>
            <p style={{ margin: '0.5rem 0 0', color: '#64748B', fontSize: '0.8125rem', lineHeight: 1.5 }}>
              {t('infrastructure.database.migrationsHint')}
            </p>
          </div>

          {/* Data backup / restore — used to carry data across a database switch (#488). */}
          <div className="data-migration-row">
            <div>
              <strong>{t('infrastructure.migration.backupTitle')}</strong>
              <small>{t('infrastructure.migration.backupHint')}</small>
            </div>
            <div className="data-migration-actions">
              <button className="btn-secondary btn-sm" onClick={handleExportBackup} disabled={migrating}>
                {migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('infrastructure.migration.export')}
              </button>
              <label className="btn-secondary btn-sm" style={{ cursor: migrating ? 'default' : 'pointer' }}>
                <Upload size={14} />
                {t('infrastructure.migration.import')}
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  disabled={migrating}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportBackup(file);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
        </section>

        {/* Engine */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Cpu size={20} />
              <h2>{t('infrastructure.engine.title')}</h2>
            </div>
            <span className="status-indicator connected">● {currentEngine || engineConfig.type}</span>
          </div>

          <div className="radio-group">
            {engines.map(engine => (
              <label key={engine.id} className={`radio-option ${engineConfig.type === engine.id ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="engineType"
                  checked={engineConfig.type === engine.id}
                  onChange={() => updateEngineConfig('type', engine.id)}
                />
                <Cpu className="watermark-icon" />
                <span>{engine.name}</span>
                <small>
                  {engine.library
                    ? `${engine.library.name} ${engine.library.version}`
                    : t('infrastructure.engine.builtIn')}
                </small>
              </label>
            ))}
          </div>

          {/* The actual WhatsApp Web build in use — distinct from the library version above (#488). */}
          {infraStatus?.engine.webVersion !== undefined && (
            <p className="engine-web-version">
              {t('infrastructure.engine.webVersion')}:{' '}
              <code>{infraStatus.engine.webVersion ?? t('infrastructure.engine.webVersionNative')}</code>
              {infraStatus.engine.webVersionSource && (
                <span className="muted">
                  {' '}
                  ({t(`infrastructure.engine.webVersionSource.${infraStatus.engine.webVersionSource}`)})
                </span>
              )}
            </p>
          )}

          {engineConfig.type === 'whatsapp-web.js' ? (
            <div className="config-form">
              <div className="toggle-row">
                <div className="toggle-info">
                  <span>{t('infrastructure.engine.headless')}</span>
                  <small>{t('infrastructure.engine.headlessDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={engineConfig.headless}
                    onChange={e => updateEngineConfig('headless', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              <div className="form-group">
                <label>{t('infrastructure.engine.sessionDataPath')}</label>
                <input
                  type="text"
                  value={engineConfig.sessionDataPath}
                  onChange={e => updateEngineConfig('sessionDataPath', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('infrastructure.engine.browserArgs')}</label>
                <input
                  type="text"
                  value={engineConfig.browserArgs}
                  onChange={e => updateEngineConfig('browserArgs', e.target.value)}
                  placeholder="--no-sandbox --disable-gpu"
                />
              </div>
            </div>
          ) : (
            <p style={{ margin: '0.5rem 0 0', color: '#64748B', fontSize: '0.8125rem', lineHeight: 1.5 }}>
              {t('infrastructure.engine.noBrowser')}
            </p>
          )}

          <p style={{ margin: '1rem 0 0', color: '#64748B', fontSize: '0.8125rem', lineHeight: 1.5 }}>
            {t('infrastructure.engine.restartNote')}
          </p>
        </section>

        {/* Redis */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Server size={20} />
              <h2>{t('infrastructure.redis.title')}</h2>
            </div>
            <span
              className={`status-indicator ${redisEnabled && redisConfig.connected ? 'connected' : 'disconnected'}`}
            >
              ● {redisEnabled
                ? redisConfig.connected
                  ? t('infrastructure.statusLabels.connected')
                  : t('infrastructure.statusLabels.disconnected')
                : t('infrastructure.statusLabels.disabled')}
            </span>
          </div>
          {envPinNote(redisPinnedByEnv)}

          <div
            className="toggle-row"
            style={{
              borderBottom: redisEnabled ? '1px solid var(--border)' : 'none',
              marginBottom: redisEnabled ? '1.5rem' : 0,
              paddingBottom: redisEnabled ? '1.25rem' : 0,
            }}
          >
            <div className="toggle-info">
              <span>{t('infrastructure.redis.enable')}</span>
              <small>{t('infrastructure.redis.enableDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={redisEnabled}
                onChange={e => {
                  setRedisEnabled(e.target.checked);
                  if (!e.target.checked) setQueueEnabled(false);
                }}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {redisEnabled ? (
            <>
              <div className="toggle-row" style={{ marginBottom: '1rem' }}>
                <div className="toggle-info">
                  <span>{t('infrastructure.redis.useBuiltIn')}</span>
                  <small>{t('infrastructure.redis.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={redisConfig.builtIn}
                    onChange={e => updateRedisConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!redisConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input
                        type="text"
                        value={redisConfig.host}
                        onChange={e => updateRedisConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input
                        type="text"
                        value={redisConfig.port}
                        onChange={e => updateRedisConfig('port', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={redisConfig.password}
                        onChange={e => updateRedisConfig('password', e.target.value)}
                        placeholder={t('infrastructure.redis.passwordOptional')}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div
                className="toggle-row"
                style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', marginTop: '0.5rem' }}
              >
                <div className="toggle-info">
                  <span>{t('infrastructure.redis.queueTitle')}</span>
                  <small>{t('infrastructure.redis.queueDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={queueEnabled} onChange={e => setQueueEnabled(e.target.checked)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {queueEnabled && (
                <div className="queue-stats">
                  <h3>{t('infrastructure.redis.statsTitle')}</h3>
                  <div className="stats-row">
                    <div className="queue-stat-card">
                      <h4>{t('infrastructure.redis.webhookQueue')}</h4>
                      <div className="stat-values">
                        <div className="stat-item pending">
                          <span className="value">{queueStats.webhooks.pending}</span>
                          <span className="label">{t('infrastructure.redis.pending')}</span>
                        </div>
                        <div className="stat-item completed">
                          <span className="value">{queueStats.webhooks.completed.toLocaleString()}</span>
                          <span className="label">{t('infrastructure.redis.completed')}</span>
                        </div>
                        <div className="stat-item failed">
                          <span className="value">{queueStats.webhooks.failed}</span>
                          <span className="label">{t('infrastructure.redis.failed')}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="queue-actions">
                    <button
                      className="btn-outline"
                      onClick={() => {
                        // The BullBoard route requires an ADMIN API key in the X-API-Key header — a plain
                        // browser tab can't send one, so copy the URL for use with an authenticated client
                        // / reverse proxy instead of opening a tab that 401s.
                        const base = API_BASE_URL.startsWith('http')
                          ? API_BASE_URL
                          : `${window.location.origin}${API_BASE_URL}`;
                        void copyToClipboard(`${base}/admin/queues`).then(ok => {
                          if (ok) {
                            toast.success(
                              t('infrastructure.redis.bullMqUrlCopied'),
                              t('infrastructure.redis.bullMqUrlHint'),
                            );
                          }
                        });
                      }}
                    >
                      <ExternalLink size={16} />
                      {t('infrastructure.redis.viewBullMq')}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div
              className="empty-state-card"
              style={{
                padding: '2.5rem',
                textAlign: 'center',
                background: '#F8FAFC',
                borderRadius: '12px',
                border: '1px dashed #E2E8F0',
                marginTop: '1rem',
              }}
            >
              <Server size={32} style={{ color: '#94A3B8', marginBottom: '1rem', opacity: 0.5 }} />
              <p style={{ margin: 0, color: '#475569', fontSize: '0.9375rem', fontWeight: 500 }}>
                {t('infrastructure.redis.disabledTitle')}
              </p>
              <p style={{ margin: '0.5rem 0 0', color: '#64748B', fontSize: '0.8125rem', lineHeight: 1.5 }}>
                {t('infrastructure.redis.disabledDesc')}
              </p>
            </div>
          )}
        </section>

        {/* Storage */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <HardDrive size={20} />
              <h2>{t('infrastructure.storage.title')}</h2>
            </div>
            {(() => {
              // S3 selected but the backend isn't reachable → warn instead of a misleading green.
              const s3Unreachable = storageConfig.type === 's3' && infraStatus?.storage.s3Available === false;
              const cls = storageConfig.type !== 's3' ? 'sqlite' : s3Unreachable ? 'disconnected' : 'connected';
              return (
                <span className={`status-indicator ${cls}`}>
                  ● {storageConfig.type === 's3' ? (s3Unreachable ? t('infrastructure.storage.s3Unreachable') : 'S3') : 'Local'}
                </span>
              );
            })()}
          </div>
          {envPinNote(storagePinnedByEnv)}

          <div className="radio-group">
            <label className={`radio-option ${storageConfig.type === 'local' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={storageConfig.type === 'local'}
                onChange={() => updateStorageConfig('type', 'local')}
              />
              <img src={folderIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.local')}</span>
              <small>{t('infrastructure.storage.localDesc')}</small>
            </label>
            <label className={`radio-option ${storageConfig.type === 's3' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={storageConfig.type === 's3'}
                onChange={() => updateStorageConfig('type', 's3')}
              />
              <img src={s3Icon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.s3')}</span>
              <small>{t('infrastructure.storage.s3Desc')}</small>
            </label>
          </div>

          <div className="config-form">
            {storageConfig.type === 'local' && (
              <div className="form-group">
                <label>{t('infrastructure.storage.storagePath')}</label>
                <input
                  type="text"
                  value={storageConfig.localPath}
                  onChange={e => updateStorageConfig('localPath', e.target.value)}
                />
              </div>
            )}

            {storageConfig.type === 's3' && (
              <>
                <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                  <div className="toggle-info">
                    <span>{t('infrastructure.storage.useBuiltIn')}</span>
                    <small>{t('infrastructure.storage.builtInDesc')}</small>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={storageConfig.builtIn}
                      onChange={e => updateStorageConfig('builtIn', e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {!storageConfig.builtIn && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.bucket')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3Bucket}
                          onChange={e => updateStorageConfig('s3Bucket', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.region')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3Region}
                          onChange={e => updateStorageConfig('s3Region', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.accessKey')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3AccessKey}
                          onChange={e => updateStorageConfig('s3AccessKey', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.secretKey')}</label>
                        <input
                          type="password"
                          value={storageConfig.s3SecretKey}
                          onChange={e => updateStorageConfig('s3SecretKey', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>{t('infrastructure.storage.endpoint')}</label>
                      <input
                        type="text"
                        value={storageConfig.s3Endpoint}
                        onChange={e => updateStorageConfig('s3Endpoint', e.target.value)}
                        placeholder={t('infrastructure.storage.endpointHint')}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {showRestartModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '500px', textAlign: 'center' }}>
            <div className="modal-header" style={{ justifyContent: 'center', borderBottom: 'none' }}>
              <h2>
                {restartStatus === 'idle' && t('infrastructure.restart.idleTitle')}
                {restartStatus === 'restarting' && t('infrastructure.restart.restartingTitle')}
                {restartStatus === 'waiting' && t('infrastructure.restart.waitingTitle')}
                {restartStatus === 'success' && t('infrastructure.restart.successTitle')}
                {restartStatus === 'error' && t('infrastructure.restart.errorTitle')}
              </h2>
            </div>
            <div className="modal-body" style={{ padding: '2rem' }}>
              {restartStatus === 'idle' && (
                <>
                  <p style={{ fontSize: '1rem', color: '#475569', marginBottom: '1.5rem' }}>
                    <Trans i18nKey="infrastructure.restart.idleDesc" components={{ code: <code />, br: <br /> }} />
                  </p>
                  {(dbSwitch || storageSwitch) && (
                    <div className="migration-warning">
                      <AlertTriangle size={18} />
                      <div>
                        <strong>{t('infrastructure.migration.title')}</strong>
                        {dbSwitch && <p>{t('infrastructure.migration.dbWarning')}</p>}
                        {storageSwitch && <p>{t('infrastructure.migration.storageWarning')}</p>}
                        {dbSwitch && (
                          <button className="btn-secondary btn-sm" onClick={handleExportBackup} disabled={migrating}>
                            {migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                            {t('infrastructure.migration.downloadBackup')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                    <button className="btn-secondary" onClick={() => setShowRestartModal(false)}>
                      {t('infrastructure.restart.later')}
                    </button>
                    <button className="btn-primary" onClick={handleRestart}>
                      {t('infrastructure.restart.now')}
                    </button>
                  </div>
                </>
              )}

              {(restartStatus === 'restarting' || restartStatus === 'waiting') && (
                <>
                  <div style={{ marginBottom: '1.5rem' }}>
                    <Loader2 className="animate-spin" size={48} style={{ color: '#22C55E', marginBottom: '1rem' }} />
                    <p style={{ fontSize: '1.125rem', color: '#1E293B', fontWeight: 500 }}>
                      {restartCountdown > 0
                        ? t('infrastructure.restart.restartingMsg', { count: restartCountdown })
                        : t('infrastructure.restart.checking')}
                    </p>
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: '8px',
                      background: '#E2E8F0',
                      borderRadius: '4px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: restartCountdown > 0 ? `${((30 - restartCountdown) / 30) * 100}%` : '100%',
                        height: '100%',
                        background: 'linear-gradient(90deg, #22C55E, #10B981)',
                        transition: 'width 1s linear',
                      }}
                    />
                  </div>
                  <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#64748B' }}>
                    {t('infrastructure.restart.dontClose')}
                  </p>
                </>
              )}

              {restartStatus === 'success' && (
                <>
                  <CheckCircle size={48} style={{ color: '#22C55E', marginBottom: '1rem' }} />
                  <p style={{ fontSize: '1rem', color: '#475569' }}>
                    {t('infrastructure.restart.successMsg')}
                  </p>
                </>
              )}

              {restartStatus === 'error' && (
                <>
                  <p style={{ fontSize: '1rem', color: '#DC2626', marginBottom: '1rem' }}>
                    {t('infrastructure.restart.errorMsg')}
                  </p>
                  <button className="btn-primary" onClick={() => window.location.reload()}>
                    {t('infrastructure.restart.reload')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="page-footer">
        <button className="btn-primary large" onClick={handleSaveConfig} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
          {saving ? t('infrastructure.saving') : t('infrastructure.saveConfig')}
        </button>
      </footer>
    </div>
  );
}
