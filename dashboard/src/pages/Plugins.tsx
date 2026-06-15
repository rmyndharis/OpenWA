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
    setShowConfigModal(true);
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

  return (
    <div className="plugins-page">
      <PageHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle')}
        actions={
          <button className="btn-secondary" onClick={refetchAll}>
            <RefreshCw size={16} />
            {t('plugins.refresh')}
          </button>
        }
      />

      {error && (
        <div className="error-banner">
          <AlertCircle size={20} />
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      <div className="engine-card">
        <div className="engine-header">
          <div className="engine-info">
            <div className="engine-icon-wrapper">
              <Cpu size={24} />
            </div>
            <div>
              <h3 className="engine-title">{t('plugins.engineCard')}</h3>
              <span className="engine-name">{currentEngine}</span>
            </div>
          </div>
          <span className="status-badge connected">{t('plugins.running')}</span>
        </div>

        {activeEngine && activeEngine.features.length > 0 && (
          <div className="engine-features">
            <p className="features-label">{t('plugins.supportedFeatures')}</p>
            <div className="features-list">
              {activeEngine.features.map(feature => (
                <span key={feature} className="feature-tag">
                  {feature.replace(/-/g, ' ')}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

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
                        return (
                          <button
                            onClick={() => handleToggle(plugin)}
                            disabled={isLoading}
                            className="btn-toggle enable"
                          >
                            {isLoading ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <>
                                <Power size={16} />
                                {t('plugins.activate')}
                              </>
                            )}
                          </button>
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
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {plugins.length === 0 && !loading && (
        <div className="empty-state">
          <Puzzle size={64} />
          <h3>{t('plugins.empty.title')}</h3>
          <p>{t('plugins.empty.description')}</p>
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
              {configPlugin.type === 'engine' && (
                <button className="btn-primary" onClick={handleSaveConfig} disabled={savingConfig}>
                  {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
