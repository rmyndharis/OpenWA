import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Puzzle,
  Power,
  PowerOff,
  Settings,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  Cpu,
  Database,
  Server,
  Shield,
  Zap,
  X,
  Upload,
  Trash2,
} from 'lucide-react';
import { pluginsApi, infraApi } from '../services/api';
import type { Plugin } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  usePluginsQuery,
  useEnginesQuery,
  useCurrentEngineQuery,
  useInfraStatusQuery,
  queryKeys,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Plugins.css';

type PluginType = 'engine' | 'storage' | 'queue' | 'auth' | 'extension';

const pluginTypeIcons: Record<PluginType, typeof Puzzle> = {
  engine: Cpu,
  storage: Database,
  queue: Server,
  auth: Shield,
  extension: Zap,
};

interface EngineConfig {
  type: string;
  headless: boolean;
  sessionDataPath: string;
  browserArgs: string;
}

export default function Plugins() {
  const { t } = useTranslation();
  useDocumentTitle(t('plugins.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: plugins = [], isLoading: loadingPlugins, error: queryError } = usePluginsQuery();
  const { data: engines = [] } = useEnginesQuery();
  const { data: currentEngineData } = useCurrentEngineQuery();
  const { data: infraStatus } = useInfraStatusQuery();
  const currentEngine = currentEngineData?.engineType ?? '';
  const loading = loadingPlugins;
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null);
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
    type: infraStatus?.engine?.type || 'whatsapp-web.js',
    headless: infraStatus?.engine?.headless ?? true,
    sessionDataPath: '/data/sessions',
    browserArgs: '--no-sandbox --disable-gpu',
  });
  const [savingConfig, setSavingConfig] = useState(false);
  // Values for a schema-driven (non-engine) plugin's config form, keyed by configSchema property.
  const [schemaConfig, setSchemaConfig] = useState<Record<string, unknown>>({});
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
    void queryClient.invalidateQueries({ queryKey: queryKeys.engines });
    void queryClient.invalidateQueries({ queryKey: queryKeys.currentEngine });
  };

  const handleToggle = async (plugin: Plugin) => {
    setActionLoading(plugin.id);
    try {
      if (plugin.status === 'enabled') {
        await pluginsApi.disable(plugin.id);
      } else {
        await pluginsApi.enable(plugin.id);
      }
      refetchAll();
    } catch (err) {
      toast.error(t('plugins.toasts.errorTitle'), err instanceof Error ? err.message : t('plugins.toasts.errorDefault'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleHealthCheck = async (pluginId: string) => {
    setActionLoading(pluginId);
    try {
      const result = await pluginsApi.healthCheck(pluginId);
      if (result.healthy) {
        toast.success(t('plugins.toasts.healthOk'), result.message);
      } else {
        toast.warning(t('plugins.toasts.healthFail'), result.message);
      }
    } catch (err) {
      toast.error(t('plugins.toasts.healthError'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleOpenConfig = (plugin: Plugin) => {
    setConfigPlugin(plugin);
    // Seed the schema form from the plugin's saved config, falling back to each field's default.
    if (plugin.configSchema?.properties) {
      const initial: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(plugin.configSchema.properties)) {
        initial[key] = plugin.config[key] ?? field.default ?? (field.type === 'boolean' ? false : '');
      }
      setSchemaConfig(initial);
    }
    setShowConfigModal(true);
  };

  const handleSaveSchemaConfig = async () => {
    if (!configPlugin) return;
    setSavingConfig(true);
    try {
      await pluginsApi.updateConfig(configPlugin.id, schemaConfig);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
      setShowConfigModal(false);
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      // Persist the engine section to the backend (.env.generated via PUT /infra/config).
      // The engine `type` isn't a savable field (only whatsapp-web.js exists); the backend
      // maps these to PUPPETEER_HEADLESS / SESSION_DATA_PATH / PUPPETEER_ARGS.
      await infraApi.saveConfig({
        engine: {
          headless: engineConfig.headless,
          sessionDataPath: engineConfig.sessionDataPath,
          browserArgs: engineConfig.browserArgs,
        },
      });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
      setShowConfigModal(false);
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleInstall = async () => {
    if (!installFile) return;
    if (installFile.size > 5 * 1024 * 1024) {
      toast.error(
        t('plugins.toasts.installFailed', 'Install failed'),
        t('plugins.installModal.tooLarge', 'The file exceeds the 5 MB limit.'),
      );
      return;
    }
    setInstalling(true);
    try {
      const installed = await pluginsApi.install(installFile);
      refetchAll();
      toast.success(t('plugins.toasts.installed', 'Plugin installed'), installed.name);
      setShowInstallModal(false);
      setInstallFile(null);
    } catch (err) {
      toast.error(t('plugins.toasts.installFailed', 'Install failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (plugin: Plugin) => {
    if (!window.confirm(t('plugins.uninstallConfirm', { name: plugin.name }))) return;
    setActionLoading(plugin.id);
    try {
      await pluginsApi.uninstall(plugin.id);
      refetchAll();
      toast.success(t('plugins.toasts.uninstalled', 'Plugin uninstalled'), plugin.name);
    } catch (err) {
      toast.error(t('plugins.toasts.uninstallFailed', 'Uninstall failed'), err instanceof Error ? err.message : '');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div
        className="plugins-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  const activeEngine = engines.find(e => e.id === currentEngine);
  const enabledCount = plugins.filter(p => p.status === 'enabled').length;
  const activePlugins = plugins.filter(p => p.status === 'enabled');

  return (
    <div className="plugins-page">
      <PageHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle')}
        actions={
          <>
            <button className="btn-secondary" onClick={refetchAll}>
              <RefreshCw size={16} />
              {t('plugins.refresh')}
            </button>
            <button className="btn-primary" onClick={() => setShowInstallModal(true)}>
              <Upload size={16} />
              {t('plugins.install', 'Install plugin')}
            </button>
          </>
        }
      />

      {error && (
        <div className="error-banner">
          <AlertCircle size={20} />
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      <div className="plugins-layout">
        <aside className="plugins-rail">
          <div className="rail-section">
            <p className="rail-label">{t('plugins.rail.engine', 'Active engine')}</p>
            <div className="rail-engine">
              <div className="rail-engine-icon">
                <Cpu size={18} />
              </div>
              <div className="rail-engine-meta">
                <span className="rail-engine-name">{currentEngine || '—'}</span>
                {activeEngine?.library && (
                  <span className="rail-engine-lib">
                    {activeEngine.library.name} {activeEngine.library.version}
                  </span>
                )}
              </div>
              <span className="status-badge connected">{t('plugins.running')}</span>
            </div>
          </div>

          <div className="rail-stats">
            <div className="rail-stat">
              <span className="rail-stat-num">{enabledCount}</span>
              <span className="rail-stat-label">{t('plugins.rail.enabled', 'enabled')}</span>
            </div>
            <div className="rail-stat">
              <span className="rail-stat-num">{plugins.length}</span>
              <span className="rail-stat-label">{t('plugins.rail.installed', 'installed')}</span>
            </div>
          </div>

          <div className="rail-section">
            <p className="rail-label">{t('plugins.rail.active', 'Active plugins')}</p>
            {activePlugins.length === 0 ? (
              <p className="rail-empty">{t('plugins.rail.none', 'None enabled yet')}</p>
            ) : (
              <ul className="rail-active-list">
                {activePlugins.map(p => (
                  <li key={p.id} className="rail-active-item">
                    <span className="status-dot enabled" />
                    <span className="rail-active-name">{p.name}</span>
                    <span className="rail-active-type">{p.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="plugins-main">
          <div className="plugins-grid">
        {plugins.map(plugin => {
          const TypeIcon = pluginTypeIcons[plugin.type as PluginType] || Puzzle;
          const isLoading = actionLoading === plugin.id;

          return (
            <div key={plugin.id} className="plugin-card">
              <div className={`plugin-card-header type-${plugin.type}`}>
                <div className="plugin-info">
                  <div className="plugin-icon-wrapper">
                    <TypeIcon size={20} />
                  </div>
                  <div>
                    <h3 className="plugin-name">{plugin.name}</h3>
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                </div>
                {plugin.builtIn && <span className="plugin-builtin-badge">{t('plugins.builtIn')}</span>}
              </div>

              <div className="plugin-card-body">
                <p className="plugin-description">{plugin.description || t('plugins.noDescription')}</p>

                <div className="plugin-status-row">
                  <div className="plugin-status">
                    <span className={`status-dot ${plugin.status}`} />
                    <span className="status-text">{plugin.status}</span>
                  </div>
                  <span className="plugin-type-label">{plugin.type}</span>
                </div>

                {plugin.error && (
                  <div className="plugin-error">
                    <p className="plugin-error-text">{plugin.error}</p>
                  </div>
                )}

                {plugin.provides && plugin.provides.length > 0 && (
                  <div className="plugin-provides">
                    {plugin.provides.map(item => (
                      <span key={item} className="provides-tag">
                        {item}
                      </span>
                    ))}
                  </div>
                )}

                <div className="plugin-actions">
                  {plugin.type === 'engine' ? (
                    (() => {
                      const enginePlugins = plugins.filter(p => p.type === 'engine');
                      const isOnlyEngine = enginePlugins.length === 1;
                      const isActive = plugin.status === 'enabled';

                      if (isOnlyEngine && isActive) {
                        return (
                          <span className="btn-required">
                            <CheckCircle size={16} />
                            {t('plugins.required')}
                          </span>
                        );
                      } else if (isActive) {
                        return (
                          <span className="btn-active">
                            <CheckCircle size={16} />
                            {t('plugins.active')}
                          </span>
                        );
                      } else {
                        // Engines are pinned to engine.type and switched via Settings + restart, not at
                        // runtime — show "available" instead of a misleading "Activate" that the API rejects.
                        return (
                          <span
                            className="btn-available"
                            title={t('plugins.engineSwitchHint', 'Set as the active engine in Settings, then restart')}
                          >
                            <Cpu size={16} />
                            {t('plugins.available', 'Available')}
                          </span>
                        );
                      }
                    })()
                  ) : (
                    <button
                      onClick={() => handleToggle(plugin)}
                      disabled={isLoading}
                      className={`btn-toggle ${plugin.status === 'enabled' ? 'disable' : 'enable'}`}
                    >
                      {isLoading ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : plugin.status === 'enabled' ? (
                        <>
                          <PowerOff size={16} />
                          {t('plugins.disable')}
                        </>
                      ) : (
                        <>
                          <Power size={16} />
                          {t('plugins.enable')}
                        </>
                      )}
                    </button>
                  )}

                  <button
                    onClick={() => handleHealthCheck(plugin.id)}
                    disabled={isLoading}
                    className="btn-action"
                    title={t('plugins.healthCheck')}
                  >
                    <CheckCircle size={16} />
                  </button>

                  <button className="btn-action" title={t('plugins.configure')} onClick={() => handleOpenConfig(plugin)}>
                    <Settings size={16} />
                  </button>

                  {!plugin.builtIn && (
                    <button
                      className="btn-action btn-action-danger"
                      title={t('plugins.uninstall', 'Uninstall')}
                      onClick={() => void handleUninstall(plugin)}
                      disabled={isLoading}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
          </div>
        </main>
      </div>

      {plugins.length === 0 && !loading && (
        <div className="empty-state">
          <Puzzle size={64} />
          <h3>{t('plugins.empty.title')}</h3>
          <p>{t('plugins.empty.description')}</p>
        </div>
      )}

      {showInstallModal && (
        <div className="modal-overlay" onClick={() => setShowInstallModal(false)}>
          <div className="modal install-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.installModal.title', 'Install a plugin')}</h2>
              <button className="btn-icon" onClick={() => setShowInstallModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p className="install-hint">
                {t('plugins.installModal.hint', 'Upload a plugin packaged as a .zip (with a manifest.json). It runs sandboxed once enabled.')}
              </p>
              <label className={`install-drop${installFile ? ' has-file' : ''}`}>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  hidden
                  onChange={e => setInstallFile(e.target.files?.[0] ?? null)}
                />
                <Upload size={28} />
                <span className="install-drop-name">
                  {installFile ? installFile.name : t('plugins.installModal.choose', 'Choose a .zip file…')}
                </span>
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowInstallModal(false)} disabled={installing}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleInstall()} disabled={!installFile || installing}>
                {installing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                {t('plugins.install', 'Install plugin')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showConfigModal && configPlugin && (
        <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
          <div className="modal config-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.config.title', { name: configPlugin.name })}</h2>
              <button className="btn-icon" onClick={() => setShowConfigModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              {configPlugin.type === 'engine' ? (
                <>
                  <div className="config-info-banner">
                    <AlertCircle size={16} />
                    <span>{t('plugins.config.restartNotice')}</span>
                  </div>

                  <div className="config-form">
                    <div className="form-group">
                      <label>{t('plugins.config.engineType')}</label>
                      <select
                        value={engineConfig.type}
                        onChange={e => setEngineConfig({ ...engineConfig, type: e.target.value })}
                      >
                        <option value="whatsapp-web.js">WhatsApp Web.js</option>
                      </select>
                    </div>

                    <div className="form-group toggle-group">
                      <div className="toggle-info">
                        <label>{t('plugins.config.headless')}</label>
                        <small>{t('plugins.config.headlessDesc')}</small>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={engineConfig.headless}
                          onChange={e => setEngineConfig({ ...engineConfig, headless: e.target.checked })}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>

                    <div className="form-group">
                      <label>{t('plugins.config.sessionDataPath')}</label>
                      <input
                        type="text"
                        value={engineConfig.sessionDataPath}
                        onChange={e => setEngineConfig({ ...engineConfig, sessionDataPath: e.target.value })}
                      />
                    </div>

                    <div className="form-group">
                      <label>{t('plugins.config.browserArgs')}</label>
                      <input
                        type="text"
                        value={engineConfig.browserArgs}
                        onChange={e => setEngineConfig({ ...engineConfig, browserArgs: e.target.value })}
                        placeholder="--no-sandbox --disable-gpu"
                      />
                    </div>
                  </div>
                </>
              ) : configPlugin.configSchema && Object.keys(configPlugin.configSchema.properties).length > 0 ? (
                <div className="config-form">
                  {Object.entries(configPlugin.configSchema.properties).map(([key, field]) => {
                    const value = schemaConfig[key];
                    const label = field.title || key;

                    if (field.type === 'boolean') {
                      return (
                        <div className="form-group toggle-group" key={key}>
                          <div className="toggle-info">
                            <label>{label}</label>
                            {field.description && <small>{field.description}</small>}
                          </div>
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={e => setSchemaConfig({ ...schemaConfig, [key]: e.target.checked })}
                            />
                            <span className="toggle-slider"></span>
                          </label>
                        </div>
                      );
                    }

                    if (field.enum && field.enum.length > 0) {
                      return (
                        <div className="form-group" key={key}>
                          <label>{label}</label>
                          <select
                            value={String(value ?? '')}
                            onChange={e => setSchemaConfig({ ...schemaConfig, [key]: e.target.value })}
                          >
                            {field.enum.map(opt => (
                              <option key={String(opt)} value={String(opt)}>
                                {String(opt)}
                              </option>
                            ))}
                          </select>
                          {field.description && <small>{field.description}</small>}
                        </div>
                      );
                    }

                    const inputType = field.type === 'number' ? 'number' : field.secret ? 'password' : 'text';
                    return (
                      <div className="form-group" key={key}>
                        <label>
                          {label}
                          {field.required && <span className="required-mark"> *</span>}
                        </label>
                        <input
                          type={inputType}
                          value={value === undefined || value === null ? '' : String(value)}
                          placeholder={field.default !== undefined ? String(field.default) : undefined}
                          autoComplete={field.secret ? 'new-password' : undefined}
                          onChange={e =>
                            setSchemaConfig({
                              ...schemaConfig,
                              [key]:
                                field.type === 'number'
                                  ? e.target.value === ''
                                    ? ''
                                    : Number(e.target.value)
                                  : e.target.value,
                            })
                          }
                        />
                        {field.description && <small>{field.description}</small>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="no-config">
                  <Settings size={48} style={{ opacity: 0.3 }} />
                  <p>{t('plugins.config.noOptions')}</p>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowConfigModal(false)}>
                {t('common.cancel')}
              </button>
              {configPlugin.type === 'engine' ? (
                <button className="btn-primary" onClick={handleSaveConfig} disabled={savingConfig}>
                  {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                </button>
              ) : configPlugin.configSchema && Object.keys(configPlugin.configSchema.properties).length > 0 ? (
                <button className="btn-primary" onClick={handleSaveSchemaConfig} disabled={savingConfig}>
                  {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
