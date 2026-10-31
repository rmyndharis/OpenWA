import { Fragment, useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { API_BASE_URL, infraApi, type SavedConfig, type SaveConfigPayload } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';
import { CONTAINER_OF, namesBundledContainer, sameHost } from '../utils/bundledHost';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useInfraStatusQuery, useInfraConfigQuery, useEnginesQuery, useCurrentEngineQuery } from '../hooks/queries';
import { savedBuiltIn, useInfraConfigForm } from '../hooks/useInfraConfigForm';
import { useConfigSave } from '../hooks/useConfigSave';
import { useRestartFlow } from '../hooks/useRestartFlow';
import { useDataBackup } from '../hooks/useDataBackup';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import './Infrastructure.css';

import sqliteIcon from '../assets/icons/sqlite.svg';
import postgresIcon from '../assets/icons/postgresql.svg';
import folderIcon from '../assets/icons/folder.svg';
import s3Icon from '../assets/icons/s3.svg';

interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
}

// The key that holds each managed profile's host.
const HOST_KEY: Record<string, string> = { postgres: 'DATABASE_HOST', redis: 'REDIS_HOST', minio: 'S3_ENDPOINT' };

// The settings a built-in save writes (or drops) for the bundled container while their fields are hidden; one the
// environment pins still wins at boot, so its note moves under the Use Built-in toggle.
const BUILT_IN_DETAIL_KEYS = {
  postgres: [
    'DATABASE_PORT',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
    'DATABASE_POOL_SIZE',
    'POSTGRES_SCHEMA',
    'DATABASE_SSL',
    'DATABASE_SSL_REJECT_UNAUTHORIZED',
  ],
  redis: ['REDIS_PORT', 'REDIS_PASSWORD'],
  minio: ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
};

/** The host the next boot dials for a profile, as GET /config reports it: the environment's, else the saved one. */
const nextBootHost = (profile: string, config: SavedConfig): string =>
  profile === 'postgres' ? config.database.host : profile === 'redis' ? config.redis.host : config.storage.s3Endpoint;

/**
 * The host a save wrote for a profile whose host the environment does not pin, taken from what it sent the way the
 * section writers (src/modules/infra/config-sections.ts) write it, for when the config cannot be read back: the host
 * sent, or '' where the save drops it. A built-in choice the new configuration uses is in the save's profiles, which
 * the restart starts rather than stops, so the host sent beside it does not matter.
 */
function writtenHost(profile: string, sent: SaveConfigPayload): string | undefined {
  if (profile === 'postgres') return sent.database?.type === 'sqlite' ? '' : sent.database?.host;
  if (profile === 'minio') return sent.storage?.type === 'local' ? '' : sent.storage?.s3Endpoint;
  // Consumer pins and the retained cache profile decide whether Redis is unused below.
  return sent.redis?.host;
}

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const toast = useToast();
  const { data: infraStatus, isLoading: loading } = useInfraStatusQuery();
  const { data: savedConfig, isLoading: configLoading } = useInfraConfigQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const currentEngine = currentEngineData?.engineType ?? '';

  const configForm = useInfraConfigForm(infraStatus, savedConfig);
  const queryClient = useQueryClient();
  // The saved config as the page first read it. A save refetches the saved config (so the pending-restart
  // notes see it), but until a restart the database still running is the one read here.
  const loadedConfig = useRef<SavedConfig | undefined>(undefined);
  useEffect(() => {
    if (savedConfig && !loadedConfig.current) loadedConfig.current = savedConfig;
  }, [savedConfig]);
  const restartFlow = useRestartFlow();
  const dataBackup = useDataBackup();

  // Reads dbConfig/storageConfig (from configForm) plus infraStatus/savedConfig to decide whether the
  // just-saved config crosses to a different backend, then hands the restart flow everything it needs
  // to open — the one-way edge between the save and restart hooks.
  const configSave = useConfigSave({
    buildPayload: configForm.buildSavePayload,
    onSaved: async (profiles, sent) => {
      // Flag a backend switch so the restart modal can warn about the empty-database / orphaned-media data
      // move before it happens. A switch is a next boot that connects somewhere else than the server does
      // now: another type, host, port or database name, or another S3 endpoint or bucket. The next boot
      // connects to a value the environment pins whatever the form says, and to the bundled container for
      // a built-in choice; two spellings of that container are one host. Whether it runs right now is no part
      // of it: a stopped one is started again on the same volume. /status reports the type, host, endpoint and
      // bucket in use; the port and the database name are not on it, so those compare with the saved config as
      // the page loaded it. A key with nothing saved reads '', and runs on the same fallback the form was seeded
      // with. A new local path is no switch.
      const loaded = loadedConfig.current;
      const pinned = (key: string) => (infraStatus?.envPinned?.includes(key) ? loaded : undefined);
      const db = configForm.dbConfig;
      const dbType = pinned('DATABASE_TYPE')?.database.type ?? db.type;
      const dbHost =
        (pinned('DATABASE_HOST')?.database.host ?? (db.builtIn ? 'postgres' : db.host.trim())) || 'localhost';
      // The database name the save writes: the form's for an external server; for a built-in one the name the server
      // keeps, the saved config's where its host already reaches the bundled container, else the one the bundled
      // container serves now (the page loaded it), else openwa.
      const dbName = db.builtIn
        ? (namesBundledContainer('postgres', savedConfig?.database.host) && savedConfig?.database.type === 'postgres'
            ? savedConfig.database.database
            : infraStatus?.database.type === 'postgres' && namesBundledContainer('postgres', infraStatus.database.host)
              ? loaded?.database.database
              : '') || 'openwa'
        : db.database;
      const dbRetarget =
        !!loaded &&
        ((!db.builtIn && !pinned('DATABASE_PORT') && db.port !== (loaded.database.port || '5432')) ||
          (!pinned('DATABASE_NAME') && dbName !== (loaded.database.database || 'openwa')));
      const dbSwitch =
        !!infraStatus &&
        (dbType !== infraStatus.database.type ||
          (dbType === 'postgres' && (!sameHost('postgres', dbHost, infraStatus.database.host) || dbRetarget)));
      const storage = configForm.storageConfig;
      const storageType = pinned('STORAGE_TYPE')?.storage.type ?? storage.type;
      // The storage section takes the bundled bucket for a flag sent as true only: beside a pinned endpoint an untouched
      // toggle is left out of the save, and the stored bucket stays. It stays under the flag too when the saved config
      // (the file this save replaced) already reaches the bundled MinIO, which then serves that bucket, and else the
      // bucket the bundled MinIO serves now does.
      const storageBuiltIn = sent.storage?.builtIn === true;
      const keepsBucket = namesBundledContainer('minio', savedConfig?.storage.s3Endpoint);
      const servesBucket =
        infraStatus?.storage.type === 's3' && namesBundledContainer('minio', infraStatus.storage.endpoint);
      const endpoint =
        pinned('S3_ENDPOINT')?.storage.s3Endpoint ?? (storageBuiltIn ? 'http://minio:9000' : storage.s3Endpoint);
      const bucket =
        (pinned('S3_BUCKET')?.storage.s3Bucket ??
          (storageBuiltIn
            ? keepsBucket
              ? savedConfig?.storage.s3Bucket
              : servesBucket
                ? infraStatus?.storage.bucket
                : 'openwa'
            : storage.s3Bucket)) ||
        'openwa';
      const storageSwitch =
        !!infraStatus &&
        (storageType !== infraStatus.storage.type ||
          (storageType === 's3' &&
            (!sameHost('minio', endpoint, infraStatus.storage.endpoint ?? '') ||
              bucket !== (infraStatus.storage.bucket || 'openwa'))));
      // The built-in containers running now, so the restart stops each one the new config dropped. With no
      // status read there is nothing to go on, and nothing is stopped.
      const running = [
        infraStatus?.database.type === 'postgres' && infraStatus.database.builtIn && 'postgres',
        infraStatus?.redis.builtIn && 'redis',
        infraStatus?.storage.type === 's3' && infraStatus.storage.builtIn && 'minio',
      ].filter((p): p is string => typeof p === 'string');
      // A bundled container OpenWA created that no boot uses while the environment pins its host elsewhere: the
      // restart stops it. The server starts nothing for that host whatever the save asked, so it is no start either.
      const pinnedAway = (
        [
          ['postgres', infraStatus?.database.running, pinned('DATABASE_HOST')?.database.host],
          ['redis', infraStatus?.redis.running, pinned('REDIS_HOST')?.redis.host],
          ['minio', infraStatus?.storage.running, pinned('S3_ENDPOINT')?.storage.s3Endpoint],
        ] as const
      )
        .filter(([profile, up, host]) => up && host !== undefined && !namesBundledContainer(profile, host))
        .map(([profile]): string => profile);
      // The server keeps a container only while the next boot both uses its datastore and dials its host: the host the
      // environment pins, else the one in the file this save wrote. A pinned host is the one the page loaded; the saved
      // one the page reads back, or takes from what the save sent when that read fails. It asks for (and names) the
      // containers whose datastore is switched off, then those neither host reaches, and none whose host it cannot
      // tell, so the dialog lists what the server stops. The form is seeded once, so the refetch keeps any edit in
      // progress.
      const saved = await queryClient
        .fetchQuery({ queryKey: ['infra', 'config'], queryFn: infraApi.getConfig, staleTime: 0 })
        .catch(() => undefined);
      const redisEnabled = infraStatus?.envPinned?.includes('REDIS_ENABLED')
        ? infraStatus.redis.enabled
        : (saved?.redis.enabled ?? sent.redis?.enabled);
      const queueEnabled = infraStatus?.envPinned?.includes('QUEUE_ENABLED')
        ? infraStatus.queue.enabled
        : (saved?.queue.enabled ?? sent.queue?.enabled);
      const toStop = [...running, ...pinnedAway].filter(profile => {
        // An inactive datastore never dials its pinned host. A retained Redis profile may still serve the cache.
        const unused =
          profile === 'postgres'
            ? dbType !== 'postgres'
            : profile === 'minio'
              ? storageType !== 's3'
              : sent.redis?.builtIn === true &&
                redisEnabled === false &&
                queueEnabled === false &&
                !profiles.includes('redis');
        if (unused) return true;
        const config = pinned(HOST_KEY[profile]) ?? saved;
        const host = config ? nextBootHost(profile, config) : writtenHost(profile, sent);
        return host !== undefined && !namesBundledContainer(profile, host);
      });
      restartFlow.open({
        profiles: profiles.filter(p => !pinnedAway.includes(p)),
        running: toStop,
        dbSwitch,
        storageSwitch,
      });
    },
  });

  const [queueStats, setQueueStats] = useState({
    webhooks: { pending: 0, completed: 0, failed: 0 } as QueueStats,
  });

  // LIVE indicators (not editable) — always reflect the running process, every refetch.
  useEffect(() => {
    if (!infraStatus) return;
    configForm.setRedisConnected(infraStatus.redis.connected);
    setQueueStats({ webhooks: infraStatus.queue.webhooks });
    // configForm is a fresh object every render; only infraStatus identity should re-arm this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infraStatus]);

  // Data backup / restore, used to carry data across a database switch (#488). It reads and writes the
  // running database only, so it is offered even when the saved config could not be read.
  const dataBackupRow = (
    <div className="data-migration-row">
      <div>
        <strong>{t('infrastructure.migration.backupTitle')}</strong>
        <small>{t('infrastructure.migration.backupHint')}</small>
      </div>
      <div className="data-migration-actions">
        <button className="btn-secondary btn-sm" onClick={dataBackup.exportBackup} disabled={dataBackup.migrating}>
          {dataBackup.migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {t('infrastructure.migration.export')}
        </button>
        <label className="btn-secondary btn-sm" style={{ cursor: dataBackup.migrating ? 'default' : 'pointer' }}>
          <Upload size={14} />
          {t('infrastructure.migration.import')}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden-file-input"
            disabled={dataBackup.migrating}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) void dataBackup.importBackup(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );

  if (loading || configLoading) {
    return (
      <div className="infrastructure-page infra-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  // If the live infrastructure status can't be loaded, do NOT render the editable form: it would seed
  // from component defaults (sqlite/local/built-in:false) and a Save could flip a running backend to
  // external+empty. Show an error + retry instead. (#488)
  // Likewise without the saved config: the database, storage and engine detail fields hydrate only
  // from it, and a Save sends every one of them.
  // Keyed on missing data, not on the query's error flag: a failed background refetch keeps the last
  // good data, and replacing the page then would unmount the form and a restart already in progress.
  if (!infraStatus || !savedConfig) {
    const configOnly = !!infraStatus;
    return (
      <div className="infrastructure-page">
        <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />
        <div className="infra-card status-error-card">
          <AlertTriangle size={32} className="status-error-icon" />
          <p className="status-error-text">
            {t(configOnly ? 'infrastructure.configLoadError' : 'infrastructure.statusLoadError')}
          </p>
          <button className="btn-secondary status-error-retry" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
        {configOnly && <section className="infra-card">{dataBackupRow}</section>}
      </div>
    );
  }

  // A control here can be ineffective for two different reasons, and they need OPPOSITE advice:
  //   - an environment variable (or a project .env) supplies the value, so it outranks anything saved
  //     here until the deployment changes — the gateway reports this in `envPinned`;
  //   - the value WAS saved and the server has not been restarted yet — a restart applies it.
  // Both look identical as "running differs from saved", which is why drift alone used to be reported
  // as an environment pin even on a stock stack with no variable set anywhere (#1082).
  // Pin-only: PUPPETEER_ARGS cannot go through settingNote, because the running list is re-tokenized and
  // gains the pinned `--lang` flag, so it never string-compares equal to the saved value. The headless
  // flag and the two paths do have a running and a saved value, but show only a reported pin as well, and so
  // do the three datastore hosts, under the Use Built-in toggle a pinned host overrides, and every other setting a
  // save writes, after the row that holds its field (a note inside a narrow port field would not fit), or under the
  // Use Built-in toggle while it hides that field.
  const pinNote = (envKey: string, note = 'infrastructure.envPinNote') =>
    infraStatus?.envPinned?.includes(envKey) ? (
      <p className="env-pin-note">
        <AlertTriangle size={14} /> {t(note, { name: envKey })}
      </p>
    ) : null;
  const builtInDetailNotes = (profile: keyof typeof BUILT_IN_DETAIL_KEYS) =>
    BUILT_IN_DETAIL_KEYS[profile].map(key => <Fragment key={key}>{pinNote(key)}</Fragment>);
  // A pinned *_BUILTIN flag decides only whether the boot starts the bundled container, at every boot while it is
  // true; whether the service uses it follows its host. Beside a host pinned elsewhere the boot starts nothing.
  const flagPinNote = (flagKey: string, profile: string) =>
    pinNote(
      flagKey,
      infraStatus.envPinned?.includes(HOST_KEY[profile]) &&
        !namesBundledContainer(profile, nextBootHost(profile, savedConfig))
        ? 'infrastructure.envPinNote'
        : 'infrastructure.envPinFlagNote',
    );
  const settingNote = (envKey: string, running: unknown, saved: unknown) => {
    if (infraStatus?.envPinned?.includes(envKey)) return pinNote(envKey);
    // Hidden only while the save request is in flight (`configSave.saving`).
    const pendingRestart = !configSave.saving && !!infraStatus && !!savedConfig && running !== saved;
    return pendingRestart ? (
      <p className="env-pin-note">
        <AlertTriangle size={14} /> {t('infrastructure.pendingRestartNote')}
      </p>
    ) : null;
  };

  // A switch between a bundled container and an external service that was saved and not restarted for. The
  // toggle shows what was saved, so the note names what runs. It needs the same service running and saved: a
  // pending type change has its own note, and a flag says nothing about a service that is not running. A saved
  // built-in choice switches nothing while the server already dials the bundled host: its container is only
  // stopped, and the restart starts it again.
  const builtInNote = (sameService: boolean, running: boolean, saved: boolean, dialsBundled: boolean) =>
    sameService && !configSave.saving && running !== saved && !(saved && dialsBundled) ? (
      <p className="env-pin-note">
        <AlertTriangle size={14} />{' '}
        {t(saved ? 'infrastructure.pendingBuiltInNote' : 'infrastructure.pendingExternalNote')}
      </p>
    ) : null;

  // Built-in services the restart failed to start or stop. Shown whether or not the server came back:
  // a service that failed to start is the likeliest reason it did not.
  const restartWarningBox = restartFlow.restartWarnings.length > 0 && (
    <div className="migration-warning" role="alert">
      <AlertTriangle size={18} />
      <div>
        {restartFlow.restartWarnings.map((warning, index) => (
          <p key={index}>{warning}</p>
        ))}
      </div>
    </div>
  );

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
            <span className={`status-indicator ${infraStatus.database.type === 'postgres' ? 'connected' : 'sqlite'}`}>
              ● {infraStatus.database.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
            </span>
          </div>
          {settingNote('DATABASE_TYPE', infraStatus.database.type, savedConfig?.database.type)}

          <div className="radio-group">
            <label className={`radio-option ${configForm.dbConfig.type === 'sqlite' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={configForm.dbConfig.type === 'sqlite'}
                onChange={() => configForm.updateDbConfig('type', 'sqlite')}
              />
              <img src={sqliteIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.sqlite')}</span>
              <small>{t('infrastructure.database.sqliteDesc')}</small>
            </label>
            <label className={`radio-option ${configForm.dbConfig.type === 'postgres' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={configForm.dbConfig.type === 'postgres'}
                onChange={() => configForm.updateDbConfig('type', 'postgres')}
              />
              <img src={postgresIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.postgres')}</span>
              <small>{t('infrastructure.database.postgresDesc')}</small>
            </label>
          </div>

          {configForm.dbConfig.type === 'postgres' && (
            <>
              <div className="toggle-row toggle-row-spaced">
                <div className="toggle-info">
                  <span id="toggle-db-builtin">{t('infrastructure.database.useBuiltIn')}</span>
                  <small>{t('infrastructure.database.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-labelledby="toggle-db-builtin"
                    checked={configForm.dbConfig.builtIn}
                    onChange={e => configForm.updateDbConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {builtInNote(
                infraStatus.database.type === 'postgres' && savedConfig.database.type === 'postgres',
                infraStatus.database.builtIn,
                savedBuiltIn(savedConfig.database, infraStatus.database.builtIn),
                namesBundledContainer('postgres', infraStatus.database.host),
              )}
              {pinNote('DATABASE_HOST')}
              {flagPinNote('POSTGRES_BUILTIN', 'postgres')}
              {configForm.dbConfig.builtIn && builtInDetailNotes('postgres')}

              {!configForm.dbConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="infra-1">{t('common.host')}</label>
                      <input
                        id="infra-1"
                        type="text"
                        value={configForm.dbConfig.host}
                        onChange={e => configForm.updateDbConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label htmlFor="infra-2">{t('common.port')}</label>
                      <input
                        id="infra-2"
                        type="text"
                        value={configForm.dbConfig.port}
                        onChange={e => configForm.updateDbConfig('port', e.target.value)}
                      />
                    </div>
                  </div>
                  {pinNote('DATABASE_PORT')}
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="infra-3">{t('common.username')}</label>
                      <input
                        id="infra-3"
                        type="text"
                        value={configForm.dbConfig.username}
                        onChange={e => configForm.updateDbConfig('username', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="infra-4">{t('common.password')}</label>
                      <input
                        id="infra-4"
                        type="password"
                        autoComplete="new-password"
                        value={configForm.dbConfig.password}
                        onChange={e => configForm.updateDbConfig('password', e.target.value)}
                      />
                    </div>
                  </div>
                  {pinNote('DATABASE_USERNAME')}
                  {pinNote('DATABASE_PASSWORD')}
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="infra-5">{t('infrastructure.database.dbName')}</label>
                      <input
                        id="infra-5"
                        type="text"
                        value={configForm.dbConfig.database}
                        onChange={e => configForm.updateDbConfig('database', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label htmlFor="infra-6">{t('infrastructure.database.poolSize')}</label>
                      <input
                        id="infra-6"
                        type="number"
                        min="1"
                        max="50"
                        value={Number.isNaN(configForm.dbConfig.poolSize) ? '' : configForm.dbConfig.poolSize}
                        onChange={e => {
                          // An emptied field stays NaN and is left out of the save; a typed size is kept
                          // inside the range the field offers.
                          const size = parseInt(e.target.value);
                          configForm.updateDbConfig(
                            'poolSize',
                            Number.isNaN(size) ? size : Math.min(50, Math.max(1, size)),
                          );
                        }}
                      />
                    </div>
                  </div>
                  {pinNote('DATABASE_NAME')}
                  {pinNote('DATABASE_POOL_SIZE')}
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="infra-7">{t('infrastructure.database.schema')}</label>
                      <input
                        id="infra-7"
                        type="text"
                        value={configForm.dbConfig.schema}
                        onChange={e => configForm.updateDbConfig('schema', e.target.value)}
                        placeholder="public"
                      />
                      <small>{t('infrastructure.database.schemaDesc')}</small>
                    </div>
                  </div>
                  {pinNote('POSTGRES_SCHEMA')}
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <span id="toggle-db-ssl">{t('infrastructure.database.ssl')}</span>
                      <small>{t('infrastructure.database.sslDesc')}</small>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        aria-labelledby="toggle-db-ssl"
                        checked={configForm.dbConfig.sslEnabled}
                        onChange={e => configForm.updateDbConfig('sslEnabled', e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                  {pinNote('DATABASE_SSL')}
                  {configForm.dbConfig.sslEnabled && (
                    <div className="toggle-row">
                      <div className="toggle-info">
                        <span id="toggle-db-ssl-reject">{t('infrastructure.database.sslRejectUnauthorized')}</span>
                        <small>{t('infrastructure.database.sslRejectUnauthorizedDesc')}</small>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          aria-labelledby="toggle-db-ssl-reject"
                          checked={configForm.dbConfig.sslRejectUnauthorized}
                          onChange={e => configForm.updateDbConfig('sslRejectUnauthorized', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  )}
                  {configForm.dbConfig.sslEnabled && pinNote('DATABASE_SSL_REJECT_UNAUTHORIZED')}
                </div>
              )}
            </>
          )}

          <div className="empty-state-card">
            <Database size={32} className="empty-state-icon success" />
            <p className="empty-state-title">{t('infrastructure.database.migrationsTitle')}</p>
            <p className="migrations-status">
              <CheckCircle size={16} />
              {t('infrastructure.database.migrationsStatus')}
            </p>
            <p className="muted-hint">{t('infrastructure.database.migrationsHint')}</p>
          </div>

          {dataBackupRow}
        </section>

        {/* Engine */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Cpu size={20} />
              <h2>{t('infrastructure.engine.title')}</h2>
            </div>
            <span className="status-indicator connected">● {currentEngine || configForm.engineConfig.type}</span>
          </div>
          {/* The radio re-seeds from the RUNNING engine, so without this a pinned engine silently
              snapped back after a restart and read as "the save did nothing" (#1082). */}
          {settingNote('ENGINE_TYPE', infraStatus.engine.type, savedConfig?.engine.type)}

          <div className="radio-group">
            {engines.map(engine => (
              <label
                key={engine.id}
                className={`radio-option ${configForm.engineConfig.type === engine.id ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="engineType"
                  checked={configForm.engineConfig.type === engine.id}
                  onChange={() => configForm.updateEngineConfig('type', engine.id)}
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

          {/* The WhatsApp Web build sessions request as their pin, distinct from the library version above (#488).
              A page can still run another build; each session logs the one it runs at ready. */}
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

          {configForm.engineConfig.type === 'whatsapp-web.js' ? (
            <div className="config-form">
              <div className="toggle-row">
                <div className="toggle-info">
                  <span id="toggle-engine-headless">{t('infrastructure.engine.headless')}</span>
                  <small>{t('infrastructure.engine.headlessDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-labelledby="toggle-engine-headless"
                    checked={configForm.engineConfig.headless}
                    onChange={e => configForm.updateEngineConfig('headless', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              {pinNote('PUPPETEER_HEADLESS')}
              <div className="form-group">
                <label htmlFor="infra-8">{t('infrastructure.engine.sessionDataPath')}</label>
                <input
                  id="infra-8"
                  type="text"
                  value={configForm.engineConfig.sessionDataPath}
                  onChange={e => configForm.updateEngineConfig('sessionDataPath', e.target.value)}
                />
                {pinNote('SESSION_DATA_PATH')}
              </div>
              <div className="form-group">
                <label htmlFor="infra-9">{t('infrastructure.engine.browserArgs')}</label>
                <input
                  id="infra-9"
                  type="text"
                  value={configForm.engineConfig.browserArgs}
                  onChange={e => configForm.updateEngineConfig('browserArgs', e.target.value)}
                  placeholder="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"
                />
                {pinNote('PUPPETEER_ARGS')}
              </div>
            </div>
          ) : (
            <p className="muted-hint">{t('infrastructure.engine.noBrowser')}</p>
          )}

          <p className="engine-restart-note">{t('infrastructure.engine.restartNote')}</p>
        </section>

        {/* Redis */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Server size={20} />
              <h2>{t('infrastructure.redis.title')}</h2>
            </div>
            <span
              className={`status-indicator ${
                infraStatus.redis.enabled && configForm.redisConfig.connected ? 'connected' : 'disconnected'
              }`}
            >
              ●{' '}
              {infraStatus.redis.enabled
                ? configForm.redisConfig.connected
                  ? t('infrastructure.statusLabels.connected')
                  : t('infrastructure.statusLabels.disconnected')
                : t('infrastructure.statusLabels.disabled')}
            </span>
          </div>
          {settingNote('REDIS_ENABLED', infraStatus.redis.enabled, savedConfig?.redis.enabled)}

          <div
            className="toggle-row"
            style={{
              borderBottom: configForm.redisEnabled ? '1px solid var(--border)' : 'none',
              marginBottom: configForm.redisEnabled ? '1.5rem' : 0,
              paddingBottom: configForm.redisEnabled ? '1.25rem' : 0,
            }}
          >
            <div className="toggle-info">
              <span id="toggle-redis-enable">{t('infrastructure.redis.enable')}</span>
              <small>{t('infrastructure.redis.enableDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-labelledby="toggle-redis-enable"
                checked={configForm.redisEnabled}
                onChange={e => configForm.setRedisEnabled(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {configForm.redisEnabled ? (
            <>
              <div className="toggle-row toggle-row-spaced-bottom">
                <div className="toggle-info">
                  <span id="toggle-redis-builtin">{t('infrastructure.redis.useBuiltIn')}</span>
                  <small>{t('infrastructure.redis.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-labelledby="toggle-redis-builtin"
                    checked={configForm.redisConfig.builtIn}
                    onChange={e => configForm.updateRedisConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {builtInNote(
                infraStatus.redis.enabled && savedConfig.redis.enabled,
                infraStatus.redis.builtIn,
                savedBuiltIn(savedConfig.redis, infraStatus.redis.builtIn),
                namesBundledContainer('redis', infraStatus.redis.host),
              )}
              {pinNote('REDIS_HOST')}
              {flagPinNote('REDIS_BUILTIN', 'redis')}
              {pinNote('REDIS_TLS')}
              {pinNote('REDIS_USERNAME')}
              {configForm.redisConfig.builtIn && builtInDetailNotes('redis')}

              {!configForm.redisConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="infra-10">{t('common.host')}</label>
                      <input
                        id="infra-10"
                        type="text"
                        value={configForm.redisConfig.host}
                        onChange={e => configForm.updateRedisConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label htmlFor="infra-11">{t('common.port')}</label>
                      <input
                        id="infra-11"
                        type="text"
                        value={configForm.redisConfig.port}
                        onChange={e => configForm.updateRedisConfig('port', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="infra-12">{t('common.password')}</label>
                      <input
                        id="infra-12"
                        type="password"
                        autoComplete="new-password"
                        value={configForm.redisConfig.password}
                        onChange={e => configForm.updateRedisConfig('password', e.target.value)}
                        placeholder={t('infrastructure.redis.passwordOptional')}
                      />
                    </div>
                  </div>
                  {pinNote('REDIS_PORT')}
                  {pinNote('REDIS_PASSWORD')}
                </div>
              )}

              <div className="toggle-row queue-toggle-row">
                <div className="toggle-info">
                  <span id="toggle-queue-enable">{t('infrastructure.redis.queueTitle')}</span>
                  <small>{t('infrastructure.redis.queueDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-labelledby="toggle-queue-enable"
                    checked={configForm.queueEnabled}
                    onChange={e => configForm.setQueueEnabled(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              {settingNote('QUEUE_ENABLED', infraStatus.queue.enabled, savedConfig.queue.enabled)}

              {configForm.queueEnabled && (
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
            <div className="empty-state-card">
              <Server size={32} className="empty-state-icon muted" />
              <p className="empty-state-title">{t('infrastructure.redis.disabledTitle')}</p>
              <p className="muted-hint">{t('infrastructure.redis.disabledDesc')}</p>
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
              // S3 running but the backend isn't reachable → warn instead of a misleading green.
              const s3Unreachable = infraStatus.storage.type === 's3' && infraStatus.storage.s3Available === false;
              const cls = infraStatus.storage.type !== 's3' ? 'sqlite' : s3Unreachable ? 'disconnected' : 'connected';
              return (
                <span className={`status-indicator ${cls}`}>
                  ●{' '}
                  {infraStatus.storage.type === 's3'
                    ? s3Unreachable
                      ? t('infrastructure.storage.s3Unreachable')
                      : 'S3'
                    : t('infrastructure.storage.local')}
                </span>
              );
            })()}
          </div>
          {settingNote('STORAGE_TYPE', infraStatus.storage.type, savedConfig?.storage.type)}

          <div className="radio-group">
            <label className={`radio-option ${configForm.storageConfig.type === 'local' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={configForm.storageConfig.type === 'local'}
                onChange={() => configForm.updateStorageConfig('type', 'local')}
              />
              <img src={folderIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.local')}</span>
              <small>{t('infrastructure.storage.localDesc')}</small>
            </label>
            <label className={`radio-option ${configForm.storageConfig.type === 's3' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={configForm.storageConfig.type === 's3'}
                onChange={() => configForm.updateStorageConfig('type', 's3')}
              />
              <img src={s3Icon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.s3')}</span>
              <small>{t('infrastructure.storage.s3Desc')}</small>
            </label>
          </div>

          <div className="config-form">
            {configForm.storageConfig.type === 'local' && (
              <div className="form-group">
                <label htmlFor="infra-13">{t('infrastructure.storage.storagePath')}</label>
                <input
                  id="infra-13"
                  type="text"
                  value={configForm.storageConfig.localPath}
                  onChange={e => configForm.updateStorageConfig('localPath', e.target.value)}
                />
                {pinNote('STORAGE_LOCAL_PATH')}
              </div>
            )}

            {configForm.storageConfig.type === 's3' && (
              <>
                <div className="toggle-row toggle-row-spaced">
                  <div className="toggle-info">
                    <span id="toggle-storage-builtin">{t('infrastructure.storage.useBuiltIn')}</span>
                    <small>{t('infrastructure.storage.builtInDesc')}</small>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      aria-labelledby="toggle-storage-builtin"
                      checked={configForm.storageConfig.builtIn}
                      onChange={e => configForm.updateStorageConfig('builtIn', e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {builtInNote(
                  infraStatus.storage.type === 's3' && savedConfig.storage.type === 's3',
                  infraStatus.storage.builtIn,
                  savedBuiltIn(savedConfig.storage, infraStatus.storage.builtIn),
                  namesBundledContainer('minio', infraStatus.storage.endpoint),
                )}
                {pinNote('S3_ENDPOINT')}
                {flagPinNote('MINIO_BUILTIN', 'minio')}
                {configForm.storageConfig.builtIn && builtInDetailNotes('minio')}

                {!configForm.storageConfig.builtIn && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="infra-14">{t('infrastructure.storage.bucket')}</label>
                        <input
                          id="infra-14"
                          type="text"
                          value={configForm.storageConfig.s3Bucket}
                          onChange={e => configForm.updateStorageConfig('s3Bucket', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="infra-15">{t('infrastructure.storage.region')}</label>
                        <input
                          id="infra-15"
                          type="text"
                          value={configForm.storageConfig.s3Region}
                          onChange={e => configForm.updateStorageConfig('s3Region', e.target.value)}
                        />
                      </div>
                    </div>
                    {pinNote('S3_BUCKET')}
                    {pinNote('S3_REGION')}
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="infra-16">{t('infrastructure.storage.accessKey')}</label>
                        <input
                          id="infra-16"
                          type="text"
                          value={configForm.storageConfig.s3AccessKey}
                          onChange={e => configForm.updateStorageConfig('s3AccessKey', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="infra-17">{t('infrastructure.storage.secretKey')}</label>
                        <input
                          id="infra-17"
                          type="password"
                          autoComplete="new-password"
                          value={configForm.storageConfig.s3SecretKey}
                          onChange={e => configForm.updateStorageConfig('s3SecretKey', e.target.value)}
                        />
                      </div>
                    </div>
                    {pinNote('S3_ACCESS_KEY_ID')}
                    {pinNote('S3_SECRET_ACCESS_KEY')}
                    <div className="form-group">
                      <label htmlFor="infra-18">{t('infrastructure.storage.endpoint')}</label>
                      <input
                        id="infra-18"
                        type="text"
                        value={configForm.storageConfig.s3Endpoint}
                        onChange={e => configForm.updateStorageConfig('s3Endpoint', e.target.value)}
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

      {restartFlow.showRestartModal && (
        <Modal
          open
          onClose={restartFlow.close}
          title={
            <>
              {restartFlow.restartStatus === 'idle' && t('infrastructure.restart.idleTitle')}
              {restartFlow.restartStatus === 'restarting' && t('infrastructure.restart.restartingTitle')}
              {(restartFlow.restartStatus === 'waiting' || restartFlow.restartStatus === 'unknown') &&
                t('infrastructure.restart.waitingTitle')}
              {restartFlow.restartStatus === 'success' && t('infrastructure.restart.successTitle')}
              {restartFlow.restartStatus === 'error' && t('infrastructure.restart.errorTitle')}
            </>
          }
          className="restart-modal"
          closeLabel={t('common.close')}
          hideCloseButton
        >
          {restartFlow.restartStatus === 'idle' && (
            <>
              <p className="restart-idle-desc">
                <Trans i18nKey="infrastructure.restart.idleDesc" components={{ code: <code />, br: <br /> }} />
              </p>
              {/* Without `running` Docker did not answer the status, and the server stops nothing then. */}
              {infraStatus.database.running !== undefined && restartFlow.profilesToRemove.length > 0 && (
                <p className="restart-idle-desc">
                  {t('infrastructure.restart.stopsContainers')}
                  {/* One left-to-right chip per container, kept whole: a name is what the operator types into docker. */}
                  {restartFlow.profilesToRemove.map(p => (
                    <Fragment key={p}>
                      {' '}
                      <code dir="ltr" className="restart-stop-name">
                        {CONTAINER_OF[p] ?? p}
                      </code>
                    </Fragment>
                  ))}
                </p>
              )}
              {(restartFlow.dbSwitch || restartFlow.storageSwitch) && (
                <div className="migration-warning">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{t('infrastructure.migration.title')}</strong>
                    {restartFlow.dbSwitch && <p>{t('infrastructure.migration.dbWarning')}</p>}
                    {restartFlow.storageSwitch && <p>{t('infrastructure.migration.storageWarning')}</p>}
                    {restartFlow.dbSwitch && (
                      <button
                        className="btn-secondary btn-sm"
                        onClick={dataBackup.exportBackup}
                        disabled={dataBackup.migrating}
                      >
                        {dataBackup.migrating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                        {t('infrastructure.migration.downloadBackup')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="restart-actions">
                <button className="btn-secondary" onClick={restartFlow.close}>
                  {t('infrastructure.restart.later')}
                </button>
                <button className="btn-primary" onClick={restartFlow.start}>
                  {t('infrastructure.restart.now')}
                </button>
              </div>
            </>
          )}

          {(restartFlow.restartStatus === 'restarting' || restartFlow.restartStatus === 'waiting') && (
            <>
              <div className="restart-countdown">
                <Loader2 className="animate-spin restart-status-icon" size={48} />
                <p className="restart-countdown-msg">
                  {restartFlow.restartCountdown > 0
                    ? t('infrastructure.restart.restartingMsg', { count: restartFlow.restartCountdown })
                    : t('infrastructure.restart.checking')}
                </p>
              </div>
              <div className="restart-progress-track">
                <div
                  className="restart-progress-fill"
                  style={{
                    width:
                      restartFlow.restartCountdown > 0
                        ? `${((restartFlow.restartTotal - restartFlow.restartCountdown) / restartFlow.restartTotal) * 100}%`
                        : '100%',
                  }}
                />
              </div>
              <p className="restart-dont-close">{t('infrastructure.restart.dontClose')}</p>
            </>
          )}

          {restartFlow.restartStatus === 'success' && (
            <>
              <CheckCircle size={48} className="restart-status-icon" />
              {restartFlow.restartWarnings.length === 0 ? (
                <p className="restart-success-msg">{t('infrastructure.restart.successMsg')}</p>
              ) : (
                <>
                  {restartWarningBox}
                  <button className="btn-primary" onClick={() => window.location.reload()}>
                    {t('infrastructure.restart.reload')}
                  </button>
                </>
              )}
            </>
          )}

          {restartFlow.restartStatus === 'unknown' && (
            <>
              <p className="restart-error-msg">{t('infrastructure.restart.outcomeUnknown')}</p>
              <button className="btn-primary" onClick={() => window.location.reload()}>
                {t('infrastructure.restart.reload')}
              </button>
            </>
          )}

          {restartFlow.restartStatus === 'error' && (
            <>
              <p className="restart-error-msg">{restartFlow.restartError ?? t('infrastructure.restart.errorMsg')}</p>
              {restartWarningBox}
              <button className="btn-primary" onClick={() => window.location.reload()}>
                {t('infrastructure.restart.reload')}
              </button>
            </>
          )}
        </Modal>
      )}

      <footer className="page-footer">
        <button className="btn-primary large" onClick={configSave.saveConfig} disabled={configSave.saving}>
          {configSave.saving ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
          {configSave.saving ? t('infrastructure.saving') : t('infrastructure.saveConfig')}
        </button>
      </footer>
    </div>
  );
}
