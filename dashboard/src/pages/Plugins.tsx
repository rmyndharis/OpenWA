import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { localizePlugin } from '../utils/localizePlugin';
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
  Globe,
  Download,
  Plus,
} from 'lucide-react';
import { pluginsApi, infraApi } from '../services/api';
import type { Plugin, CatalogPlugin, PluginConfigField } from '../services/api';
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

/** A blank value for a field, used to seed a form and to add a new array row. */
function emptyForField(field: PluginConfigField): unknown {
  if (field.default !== undefined) return field.default;
  // A <select> always shows its first option, so seed enum state to it — otherwise the form shows a
  // value the user never picked and would save '' instead.
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const obj: Record<string, unknown> = {};
      if (field.properties) for (const [k, sub] of Object.entries(field.properties)) obj[k] = emptyForField(sub);
      return obj;
    }
    default: // string | number | textarea — empty string (number coerced on input)
      return '';
  }
}

/**
 * Renders one config field from a plugin's schema and reports edits via `onChange`. Recurses for
 * nested objects and array-of-rows. Module-scope (stable identity) so inputs keep focus across
 * keystrokes. The secret redact/restore round-trip lives server-side (PUT /plugins/:id/config).
 */
function ConfigField({
  field,
  label,
  value,
  onChange,
}: {
  field: PluginConfigField;
  label: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation();
  const desc = field.description ? <small>{field.description}</small> : null;
  const labelEl = (
    <label>
      {label}
      {field.required && <span className="required-mark"> *</span>}
    </label>
  );

  if (field.type === 'boolean') {
    return (
      <div className="form-group toggle-group">
        <div className="toggle-info">
          <label>{label}</label>
          {desc}
        </div>
        <label className="toggle-switch">
          <input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)} />
          <span className="toggle-slider"></span>
        </label>
      </div>
    );
  }

  if (field.enum && field.enum.length > 0) {
    const options = field.enum;
    return (
      <div className="form-group">
        {labelEl}
        <select
          value={String(value ?? '')}
          // Restore the option's original type (e.g. a number/boolean enum), not the raw string value.
          onChange={e => onChange(options.find(o => String(o) === e.target.value) ?? e.target.value)}
        >
          {options.map(opt => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
        {desc}
      </div>
    );
  }

  if (field.type === 'object') {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const props = field.properties ?? {};
    return (
      <fieldset className="config-fieldset">
        <legend>{label}</legend>
        {desc}
        {Object.entries(props).map(([k, sub]) => (
          <ConfigField
            key={k}
            field={sub}
            label={sub.title || k}
            value={obj[k]}
            onChange={v => onChange({ ...obj, [k]: v })}
          />
        ))}
      </fieldset>
    );
  }

  if (field.type === 'array') {
    const rows = Array.isArray(value) ? value : [];
    const item = field.items;
    if (!item) {
      // No element schema declared — nothing to render safely (don't fall through to a text input
      // that would stringify the array to "[object Object]"/"" and corrupt it).
      return (
        <div className="config-array">
          {labelEl}
          {desc}
        </div>
      );
    }
    return (
      <div className="config-array">
        {labelEl}
        {desc}
        {rows.map((row, i) => (
          <div className="config-array-row" key={i}>
            <div className="config-array-row-body">
              <ConfigField
                field={item}
                label={`#${i + 1}`}
                value={row}
                onChange={v => onChange(rows.map((r, j) => (j === i ? v : r)))}
              />
            </div>
            <button
              type="button"
              className="config-array-remove"
              title={t('common.delete')}
              aria-label={t('common.delete')}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="config-array-add" onClick={() => onChange([...rows, emptyForField(item)])}>
          <Plus size={14} /> {t('plugins.config.addItem')}
        </button>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="form-group">
        {labelEl}
        <textarea
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.default !== undefined ? String(field.default) : undefined}
          minLength={field.min}
          maxLength={field.max}
          rows={4}
          onChange={e => onChange(e.target.value)}
        />
        {desc}
      </div>
    );
  }

  const inputType = field.type === 'number' ? 'number' : field.secret ? 'password' : 'text';
  return (
    <div className="form-group">
      {labelEl}
      <input
        type={inputType}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={field.default !== undefined ? String(field.default) : undefined}
        autoComplete={field.secret ? 'new-password' : undefined}
        min={field.type === 'number' ? field.min : undefined}
        max={field.type === 'number' ? field.max : undefined}
        minLength={field.type !== 'number' ? field.min : undefined}
        maxLength={field.type !== 'number' ? field.max : undefined}
        pattern={field.type !== 'number' ? field.pattern : undefined}
        onChange={e =>
          onChange(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
        }
      />
      {desc}
    </div>
  );
}

/**
 * Renders a plugin's sandboxed-iframe config editor. The entry HTML is fetched WITH the API key
 * (which never enters the iframe) and injected as `srcdoc` into a `sandbox="allow-scripts"` iframe
 * (opaque origin — no access to the parent). The editor talks to the host over a postMessage bridge:
 *   iframe → host  { type: 'config:get' }          → host → iframe { type: 'config:value', config, schema }
 *   iframe → host  { type: 'config:save', config }  → host → iframe { type: 'config:saved' } | { type: 'config:error', message }
 * The host makes the authenticated PUT (secret redact/restore applies); the iframe only ever sees the
 * already-redacted config.
 */
function PluginConfigUi({ plugin }: { plugin: Plugin }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    pluginsApi
      .getConfigUi(plugin.id)
      .then(h => {
        if (!cancelled) setHtml(h);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('common.unknownError'));
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, t]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return; // only our sandboxed iframe (its origin is opaque 'null')
      const msg = e.data as { type?: string; config?: Record<string, unknown> };
      const post = (m: unknown) => frame.postMessage(m, '*');
      if (msg?.type === 'config:get') {
        // Only expose schema-DECLARED fields (already secret-redacted by the API). An undeclared key
        // may hold a secret the host can't mask, so it never reaches the untrusted iframe; with no
        // schema there is nothing safe to send. The plugin must declare its fields to pre-fill them.
        const props = plugin.configSchema?.properties;
        const safeConfig = props
          ? Object.fromEntries(Object.keys(props).flatMap(k => (k in plugin.config ? [[k, plugin.config[k]]] : [])))
          : {};
        post({ type: 'config:value', config: safeConfig, schema: plugin.configSchema });
      } else if (msg?.type === 'config:save') {
        void (async () => {
          try {
            await pluginsApi.updateConfig(plugin.id, msg.config ?? {});
            void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
            post({ type: 'config:saved' });
            toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
          } catch (err) {
            const message = err instanceof Error ? err.message : t('common.unknownError');
            post({ type: 'config:error', message });
            toast.error(t('plugins.toasts.saveFailed'), message);
          }
        })();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [plugin, queryClient, t, toast]);

  if (error) return <div className="config-ui-status config-ui-error">{error}</div>;
  if (html === null)
    return (
      <div className="config-ui-status">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  return (
    <iframe
      ref={iframeRef}
      className="plugin-config-ui-frame"
      sandbox="allow-scripts"
      srcDoc={html}
      title={plugin.name}
      style={{ height: plugin.configUi?.height ?? 600 }}
    />
  );
}

export default function Plugins() {
  const { t, i18n } = useTranslation();
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
  const [installMode, setInstallMode] = useState<'upload' | 'catalog'>('upload');
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

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
        initial[key] = plugin.config[key] ?? emptyForField(field);
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

  const loadCatalog = async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await pluginsApi.catalog());
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCatalogLoading(false);
    }
  };

  // Lazy-load the catalog the first time the Catalog tab is opened.
  useEffect(() => {
    if (showInstallModal && installMode === 'catalog' && catalog.length === 0 && !catalogLoading && !catalogError) {
      void loadCatalog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInstallModal, installMode]);

  const handleInstallFromCatalog = async (entry: CatalogPlugin) => {
    if (!entry.download) {
      toast.error(
        t('plugins.toasts.installFailed', 'Install failed'),
        t('plugins.catalog.noDownload', 'This catalog entry has no download URL.'),
      );
      return;
    }
    setInstallingId(entry.id);
    try {
      const installed = await pluginsApi.installFromUrl(entry.download);
      refetchAll();
      await loadCatalog();
      toast.success(t('plugins.toasts.installed', 'Plugin installed'), installed.name);
    } catch (err) {
      toast.error(t('plugins.toasts.installFailed', 'Install failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstallingId(null);
    }
  };

  const handleUpdateFromCatalog = async (entry: CatalogPlugin) => {
    if (!entry.download) {
      toast.error(
        t('plugins.toasts.updateFailed', 'Update failed'),
        t('plugins.catalog.noDownload', 'This catalog entry has no download URL.'),
      );
      return;
    }
    setInstallingId(entry.id);
    try {
      const updated = await pluginsApi.updateFromUrl(entry.id, entry.download);
      refetchAll();
      await loadCatalog();
      toast.success(t('plugins.catalog.updated', 'Plugin updated'), `${updated.name} v${updated.version}`);
    } catch (err) {
      toast.error(t('plugins.toasts.updateFailed', 'Update failed'), err instanceof Error ? err.message : '');
    } finally {
      setInstallingId(null);
    }
  };

  const handleUninstall = async (plugin: Plugin) => {
    if (!window.confirm(t('plugins.uninstallConfirm', { name: localizePlugin(plugin, i18n.language).name }))) return;
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
                    <span className="rail-active-name">{localizePlugin(p, i18n.language).name}</span>
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
          const lz = localizePlugin(plugin, i18n.language);

          return (
            <div key={plugin.id} className="plugin-card">
              <div className={`plugin-card-header type-${plugin.type}`}>
                <div className="plugin-info">
                  <div className="plugin-icon-wrapper">
                    <TypeIcon size={20} />
                  </div>
                  <div>
                    <h3 className="plugin-name">{lz.name}</h3>
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                </div>
                {plugin.builtIn && <span className="plugin-builtin-badge">{t('plugins.builtIn')}</span>}
              </div>

              <div className="plugin-card-body">
                <p className="plugin-description">{lz.description || t('plugins.noDescription')}</p>

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
            <div className="install-tabs">
              <button
                className={`install-tab${installMode === 'upload' ? ' active' : ''}`}
                onClick={() => setInstallMode('upload')}
              >
                <Upload size={15} /> {t('plugins.installModal.tabUpload', 'Upload .zip')}
              </button>
              <button
                className={`install-tab${installMode === 'catalog' ? ' active' : ''}`}
                onClick={() => setInstallMode('catalog')}
              >
                <Globe size={15} /> {t('plugins.installModal.tabCatalog', 'Catalog')}
              </button>
            </div>

            {installMode === 'upload' ? (
              <>
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
              </>
            ) : (
              <>
                <div className="modal-body">
                  <p className="install-hint">
                    {t('plugins.installModal.catalogHint', 'Install directly from the OpenWA plugin catalog. The .zip is fetched server-side through the SSRF guard, then validated and sandboxed.')}
                  </p>
                  {catalogLoading ? (
                    <div className="catalog-empty">
                      <Loader2 size={20} className="animate-spin" />
                    </div>
                  ) : catalogError ? (
                    <div className="catalog-empty catalog-error">
                      <AlertCircle size={16} /> {catalogError}
                      <button className="btn-secondary" onClick={() => void loadCatalog()}>
                        {t('plugins.refresh', 'Refresh')}
                      </button>
                    </div>
                  ) : catalog.length === 0 ? (
                    <div className="catalog-empty">{t('plugins.catalog.empty', 'No plugins in the catalog.')}</div>
                  ) : (
                    <div className="catalog-list">
                      {catalog.map(entry => {
                        const lz = localizePlugin(entry, i18n.language);
                        return (
                        <div className="catalog-row" key={entry.id}>
                          <div className="catalog-row-info">
                            <div className="catalog-row-name">
                              {lz.name} <span className="catalog-row-version">v{entry.version}</span>
                            </div>
                            {lz.description && <div className="catalog-row-desc">{lz.description}</div>}
                            <div className="catalog-row-meta">
                              {entry.author && <span className="catalog-row-author">{entry.author}</span>}
                              {entry.updateAvailable && (
                                <span className="catalog-badge update">
                                  {t('plugins.catalog.updateAvailable', 'Update available')} (v{entry.installedVersion} → v{entry.version})
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="catalog-row-action">
                            {entry.installed ? (
                              entry.updateAvailable ? (
                                <button
                                  className="btn-primary"
                                  disabled={installingId !== null || !entry.download}
                                  onClick={() => void handleUpdateFromCatalog(entry)}
                                >
                                  {installingId === entry.id ? (
                                    <Loader2 size={15} className="animate-spin" />
                                  ) : (
                                    <Download size={15} />
                                  )}
                                  {t('plugins.catalog.update', 'Update')}
                                </button>
                              ) : (
                                <span className="catalog-installed">
                                  <CheckCircle size={15} /> {t('plugins.catalog.installed', 'Installed')}
                                </span>
                              )
                            ) : (
                              <button
                                className="btn-primary"
                                disabled={installingId !== null || !entry.download}
                                onClick={() => void handleInstallFromCatalog(entry)}
                              >
                                {installingId === entry.id ? (
                                  <Loader2 size={15} className="animate-spin" />
                                ) : (
                                  <Download size={15} />
                                )}
                                {t('plugins.catalog.install', 'Install')}
                              </button>
                            )}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn-secondary" onClick={() => setShowInstallModal(false)}>
                    {t('common.close', 'Close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showConfigModal && configPlugin && (() => {
        const lz = localizePlugin(configPlugin, i18n.language);
        return (
        <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
          <div className="modal config-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.config.title', { name: lz.name })}</h2>
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
              ) : configPlugin.configUi ? (
                <PluginConfigUi plugin={configPlugin} />
              ) : lz.configSchema && Object.keys(lz.configSchema.properties).length > 0 ? (
                <div className="config-form">
                  {Object.entries(lz.configSchema.properties).map(([key, field]) => (
                    <ConfigField
                      key={key}
                      field={field}
                      label={field.title || key}
                      value={schemaConfig[key]}
                      onChange={v => setSchemaConfig({ ...schemaConfig, [key]: v })}
                    />
                  ))}
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
              ) : configPlugin.configUi ? null : lz.configSchema &&
                Object.keys(lz.configSchema.properties).length > 0 ? (
                <button className="btn-primary" onClick={handleSaveSchemaConfig} disabled={savingConfig}>
                  {savingConfig ? <Loader2 size={16} className="animate-spin" /> : t('plugins.config.save')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
