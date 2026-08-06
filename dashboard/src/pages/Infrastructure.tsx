import { useState, useEffect } from 'react';
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
import { API_BASE_URL } from '../services/api';
import { copyToClipboard } from '../utils/clipboard';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useInfraStatusQuery, useInfraConfigQuery, useEnginesQuery, useCurrentEngineQuery } from '../hooks/queries';
import { useInfraConfigForm } from '../hooks/useInfraConfigForm';
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

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const toast = useToast();
  const { data: infraStatus, isLoading: loading, isError: statusError } = useInfraStatusQuery();
  const { data: savedConfig } = useInfraConfigQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const currentEngine = currentEngineData?.engineType ?? '';

  const configForm = useInfraConfigForm(infraStatus, savedConfig, currentEngine);
  const restartFlow = useRestartFlow();
  const dataBackup = useDataBackup();

  // Reads dbConfig/storageConfig (from configForm) plus infraStatus/savedConfig to decide whether the
  // just-saved config crosses to a different backend, then hands the restart flow everything it needs
  // to open — the one-way edge between the save and restart hooks.
  const configSave = useConfigSave({
    buildPayload: configForm.buildSavePayload,
    onSaved: profiles => {
      // Flag a backend switch vs what's actually running so the restart modal can warn about the
      // empty-database / orphaned-media data move before it happens. A switch is: changing type;
      // flipping built-in↔external (different physical backend); OR retargeting an external Postgres
      // to a different host/port/database (also a different, empty DB). Host/port/db aren't all in
      // /status, so compare the edited form against the still-cached saved config.
      const dbExternalRetarget =
        configForm.dbConfig.type === 'postgres' &&
        !configForm.dbConfig.builtIn &&
        !!savedConfig &&
        (configForm.dbConfig.host !== savedConfig.database.host ||
          configForm.dbConfig.port !== savedConfig.database.port ||
          configForm.dbConfig.database !== savedConfig.database.database);
      const dbSwitch =
        !!infraStatus &&
        (configForm.dbConfig.type !== infraStatus.database.type ||
          (configForm.dbConfig.type === 'postgres' && configForm.dbConfig.builtIn !== infraStatus.database.builtIn) ||
          dbExternalRetarget);
      // Scope: this warns on a backend-TYPE change (local↔s3) and a built-in↔external flip — the cases
      // that point at a different store. It does NOT warn on same-backend repointing (e.g. a new S3
      // bucket/endpoint or a new local path); region/endpoint aren't on /status to compare reliably.
      const storageSwitch =
        !!infraStatus &&
        (configForm.storageConfig.type !== infraStatus.storage.type ||
          (configForm.storageConfig.type === 's3' && configForm.storageConfig.builtIn !== infraStatus.storage.builtIn));
      restartFlow.open({ profiles, dbSwitch, storageSwitch });
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

  if (loading) {
    return (
      <div className="infrastructure-page infra-loading">
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
        <div className="infra-card status-error-card">
          <AlertTriangle size={32} className="status-error-icon" />
          <p className="status-error-text">{t('infrastructure.statusLoadError')}</p>
          <button className="btn-secondary status-error-retry" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  // A control here can be ineffective for two different reasons, and they need OPPOSITE advice:
  //   - an environment variable (or a project .env) supplies the value, so it outranks anything saved
  //     here until the deployment changes — the gateway reports this in `envPinned`;
  //   - the value WAS saved and the server has not been restarted yet — a restart applies it.
  // Both look identical as "running differs from saved", which is why drift alone used to be reported
  // as an environment pin even on a stock stack with no variable set anywhere (#1082).
  const settingNote = (envKey: string, running: unknown, saved: unknown) => {
    if (infraStatus?.envPinned?.includes(envKey)) {
      return (
        <p className="env-pin-note">
          <AlertTriangle size={14} /> {t('infrastructure.envPinNote', { name: envKey })}
        </p>
      );
    }
    // savePending suppresses the note only while the request is in flight; afterwards the saved value
    // genuinely differs from the running one until a restart, and saying so is the whole point.
    const pendingRestart = !configSave.savePending && !!infraStatus && !!savedConfig && running !== saved;
    return pendingRestart ? (
      <p className="env-pin-note">
        <AlertTriangle size={14} /> {t('infrastructure.pendingRestartNote')}
      </p>
    ) : null;
  };

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
            <span className={`status-indicator ${configForm.dbConfig.type === 'postgres' ? 'connected' : 'sqlite'}`}>
              ● {configForm.dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
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
                  <span>{t('infrastructure.database.useBuiltIn')}</span>
                  <small>{t('infrastructure.database.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={configForm.dbConfig.builtIn}
                    onChange={e => configForm.updateDbConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!configForm.dbConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input
                        type="text"
                        value={configForm.dbConfig.host}
                        onChange={e => configForm.updateDbConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input
                        type="text"
                        value={configForm.dbConfig.port}
                        onChange={e => configForm.updateDbConfig('port', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.username')}</label>
                      <input
                        type="text"
                        value={configForm.dbConfig.username}
                        onChange={e => configForm.updateDbConfig('username', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={configForm.dbConfig.password}
                        onChange={e => configForm.updateDbConfig('password', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('infrastructure.database.dbName')}</label>
                      <input
                        type="text"
                        value={configForm.dbConfig.database}
                        onChange={e => configForm.updateDbConfig('database', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('infrastructure.database.poolSize')}</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={configForm.dbConfig.poolSize}
                        onChange={e => configForm.updateDbConfig('poolSize', parseInt(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('infrastructure.database.schema')}</label>
                      <input
                        type="text"
                        value={configForm.dbConfig.schema}
                        onChange={e => configForm.updateDbConfig('schema', e.target.value)}
                        placeholder="public"
                      />
                      <small>{t('infrastructure.database.schemaDesc')}</small>
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
                        checked={configForm.dbConfig.sslEnabled}
                        onChange={e => configForm.updateDbConfig('sslEnabled', e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                  {configForm.dbConfig.sslEnabled && (
                    <div className="toggle-row">
                      <div className="toggle-info">
                        <span>{t('infrastructure.database.sslRejectUnauthorized')}</span>
                        <small>{t('infrastructure.database.sslRejectUnauthorizedDesc')}</small>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={configForm.dbConfig.sslRejectUnauthorized}
                          onChange={e => configForm.updateDbConfig('sslRejectUnauthorized', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  )}
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

          {/* Data backup / restore — used to carry data across a database switch (#488). */}
          <div className="data-migration-row">
            <div>
              <strong>{t('infrastructure.migration.backupTitle')}</strong>
              <small>{t('infrastructure.migration.backupHint')}</small>
            </div>
            <div className="data-migration-actions">
              <button
                className="btn-secondary btn-sm"
                onClick={dataBackup.exportBackup}
                disabled={dataBackup.migrating}
              >
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

          {configForm.engineConfig.type === 'whatsapp-web.js' ? (
            <div className="config-form">
              <div className="toggle-row">
                <div className="toggle-info">
                  <span>{t('infrastructure.engine.headless')}</span>
                  <small>{t('infrastructure.engine.headlessDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={configForm.engineConfig.headless}
                    onChange={e => configForm.updateEngineConfig('headless', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
              <div className="form-group">
                <label>{t('infrastructure.engine.sessionDataPath')}</label>
                <input
                  type="text"
                  value={configForm.engineConfig.sessionDataPath}
                  onChange={e => configForm.updateEngineConfig('sessionDataPath', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('infrastructure.engine.browserArgs')}</label>
                <input
                  type="text"
                  value={configForm.engineConfig.browserArgs}
                  onChange={e => configForm.updateEngineConfig('browserArgs', e.target.value)}
                  placeholder="--no-sandbox --disable-gpu"
                />
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
                configForm.redisEnabled && configForm.redisConfig.connected ? 'connected' : 'disconnected'
              }`}
            >
              ●{' '}
              {configForm.redisEnabled
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
              <span>{t('infrastructure.redis.enable')}</span>
              <small>{t('infrastructure.redis.enableDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
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
                  <span>{t('infrastructure.redis.useBuiltIn')}</span>
                  <small>{t('infrastructure.redis.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={configForm.redisConfig.builtIn}
                    onChange={e => configForm.updateRedisConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!configForm.redisConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input
                        type="text"
                        value={configForm.redisConfig.host}
                        onChange={e => configForm.updateRedisConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input
                        type="text"
                        value={configForm.redisConfig.port}
                        onChange={e => configForm.updateRedisConfig('port', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={configForm.redisConfig.password}
                        onChange={e => configForm.updateRedisConfig('password', e.target.value)}
                        placeholder={t('infrastructure.redis.passwordOptional')}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="toggle-row queue-toggle-row">
                <div className="toggle-info">
                  <span>{t('infrastructure.redis.queueTitle')}</span>
                  <small>{t('infrastructure.redis.queueDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={configForm.queueEnabled}
                    onChange={e => configForm.setQueueEnabled(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

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
              // S3 selected but the backend isn't reachable → warn instead of a misleading green.
              const s3Unreachable =
                configForm.storageConfig.type === 's3' && infraStatus?.storage.s3Available === false;
              const cls =
                configForm.storageConfig.type !== 's3' ? 'sqlite' : s3Unreachable ? 'disconnected' : 'connected';
              return (
                <span className={`status-indicator ${cls}`}>
                  ●{' '}
                  {configForm.storageConfig.type === 's3'
                    ? s3Unreachable
                      ? t('infrastructure.storage.s3Unreachable')
                      : 'S3'
                    : 'Local'}
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
                <label>{t('infrastructure.storage.storagePath')}</label>
                <input
                  type="text"
                  value={configForm.storageConfig.localPath}
                  onChange={e => configForm.updateStorageConfig('localPath', e.target.value)}
                />
              </div>
            )}

            {configForm.storageConfig.type === 's3' && (
              <>
                <div className="toggle-row toggle-row-spaced">
                  <div className="toggle-info">
                    <span>{t('infrastructure.storage.useBuiltIn')}</span>
                    <small>{t('infrastructure.storage.builtInDesc')}</small>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={configForm.storageConfig.builtIn}
                      onChange={e => configForm.updateStorageConfig('builtIn', e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {!configForm.storageConfig.builtIn && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.bucket')}</label>
                        <input
                          type="text"
                          value={configForm.storageConfig.s3Bucket}
                          onChange={e => configForm.updateStorageConfig('s3Bucket', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.region')}</label>
                        <input
                          type="text"
                          value={configForm.storageConfig.s3Region}
                          onChange={e => configForm.updateStorageConfig('s3Region', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.accessKey')}</label>
                        <input
                          type="text"
                          value={configForm.storageConfig.s3AccessKey}
                          onChange={e => configForm.updateStorageConfig('s3AccessKey', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.secretKey')}</label>
                        <input
                          type="password"
                          value={configForm.storageConfig.s3SecretKey}
                          onChange={e => configForm.updateStorageConfig('s3SecretKey', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>{t('infrastructure.storage.endpoint')}</label>
                      <input
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
              {restartFlow.restartStatus === 'waiting' && t('infrastructure.restart.waitingTitle')}
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
                        ? `${((30 - restartFlow.restartCountdown) / 30) * 100}%`
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
              <p className="restart-success-msg">{t('infrastructure.restart.successMsg')}</p>
            </>
          )}

          {restartFlow.restartStatus === 'error' && (
            <>
              <p className="restart-error-msg">{t('infrastructure.restart.errorMsg')}</p>
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
