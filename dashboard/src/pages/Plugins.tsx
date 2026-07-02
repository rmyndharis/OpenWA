import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { localizePlugin } from '../utils/localizePlugin';
import { coerceFieldInput, emptyForField } from '../utils/pluginConfigForm';
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
  Search,
} from 'lucide-react';
import { pluginsApi } from '../services/api';
import type { Plugin, CatalogPlugin, PluginConfigField } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePluginsQuery, useSessionsQuery, queryKeys } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { PluginInstances } from '../components/PluginInstances';
import './Plugins.css';

type PluginType = 'engine' | 'storage' | 'queue' | 'auth' | 'extension';

const pluginTypeIcons: Record<PluginType, typeof Puzzle> = {
  engine: Cpu,
  storage: Database,
  queue: Server,
  auth: Shield,
  extension: Zap,
};

/**
 * Build a sparse per-session config override from a full edited config: include only non-secret keys
 * whose value differs from the Global base (so untouched keys keep inheriting Global), plus every
 * TOP-LEVEL secret key (the backend restores an untouched `***` to the stored per-session value, or
 * drops it → the host's deep-merge then re-inherits it from Global). A key absent from the base whose
 * value is just the empty default is skipped, so an untouched optional field never creates a spurious
 * override. With no schema, the input is returned as-is.
 *
 * Inheritance of untouched secrets holds for top-level secret keys and secrets nested in an OBJECT
 * (deep-merged). It does NOT hold for a `secret` column inside an array-of-rows: arrays are replaced
 * wholesale at resolve time, so a first-time per-session override that edits any cell of such an array
 * loses the untouched rows' secrets (they redact to `***`, the dashboard can't resend the real value).
 * No bundled plugin ships that shape; a plugin needing per-session array secrets should re-enter them.
 */
function sparseSessionOverride(full: Record<string, unknown>, plugin: Plugin): Record<string, unknown> {
  const props = plugin.configSchema?.properties;
  if (!props) return full;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(props)) {
    if (!(key in full)) continue;
    const val = full[key];
    if (field.secret) {
      out[key] = val;
      continue;
    }
    if (JSON.stringify(val) === JSON.stringify(plugin.config[key])) continue; // unchanged → inherit Global
    if (plugin.config[key] === undefined && JSON.stringify(val) === JSON.stringify(emptyForField(field))) {
      continue; // untouched optional field with no Global value → don't pin a spurious empty override
    }
    out[key] = val;
  }
  return out;
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
          required={field.required}
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
        required={field.required}
        min={field.type === 'number' ? field.min : undefined}
        max={field.type === 'number' ? field.max : undefined}
        minLength={field.type !== 'number' ? field.min : undefined}
        maxLength={field.type !== 'number' ? field.max : undefined}
        pattern={field.type !== 'number' ? field.pattern : undefined}
        onChange={e => onChange(coerceFieldInput(field, e.target.value))}
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
function PluginConfigUi({ plugin, sessionId }: { plugin: Plugin; sessionId?: string }) {
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
        // For a per-session editor (sessionId set), expose the resolved slice: the session's override
        // value where set, else the base value.
        const props = plugin.configSchema?.properties;
        const override = sessionId ? (plugin.sessionConfig?.[sessionId] ?? {}) : {};
        const safeConfig = props
          ? Object.fromEntries(
              Object.keys(props).flatMap(k => {
                if (sessionId && k in override) return [[k, override[k]]];
                return k in plugin.config ? [[k, plugin.config[k]]] : [];
              }),
            )
          : {};
        post({ type: 'config:value', config: safeConfig, schema: plugin.configSchema });
      } else if (msg?.type === 'config:save') {
        void (async () => {
          try {
            if (sessionId)
              await pluginsApi.updateSessionConfig(
                plugin.id,
                sessionId,
                sparseSessionOverride(msg.config ?? {}, plugin),
              );
            else await pluginsApi.updateConfig(plugin.id, msg.config ?? {});
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
  }, [plugin, sessionId, queryClient, t, toast]);

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

/**
 * The config modal's "Sessions" tab for a session-scoped plugin: set which sessions it runs for
 * (activation), and optionally a per-session config OVERRIDE on top of the Global (`'*'`) config.
 * Activation → PUT /plugins/:id/sessions; overrides → PUT /plugins/:id/config/:sessionId.
 */
function SessionsTab({ plugin }: { plugin: Plugin }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: sessions = [] } = useSessionsQuery();

  // ── Activation ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'all' | 'specific'>(plugin.activeSessions.includes('*') ? 'all' : 'specific');
  const [picked, setPicked] = useState<Set<string>>(new Set(plugin.activeSessions.filter(s => s !== '*')));
  const [savingAct, setSavingAct] = useState(false);

  const saveActivation = async () => {
    setSavingAct(true);
    try {
      await pluginsApi.setSessions(plugin.id, mode === 'all' ? ['*'] : Array.from(picked));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingAct(false);
    }
  };

  // ── Per-session config override ───────────────────────────────────────────
  const hasSchema = !!plugin.configSchema && Object.keys(plugin.configSchema.properties).length > 0;
  const hasUi = !!plugin.configUi;
  const lzProps = localizePlugin(plugin, i18n.language).configSchema?.properties;
  const [selSession, setSelSession] = useState<string>('');
  const [overrideCfg, setOverrideCfg] = useState<Record<string, unknown>>({});
  const [savingOverride, setSavingOverride] = useState(false);
  const overrideFormRef = useRef<HTMLFormElement>(null);

  // Seed the override form from the resolved slice (the session's override value where set, else base).
  // Keyed on selSession + plugin.id (NOT the plugin object): `configPlugin` is derived from the live
  // query, so it gets a new reference on every refetch (refetchOnWindowFocus) — re-running on that
  // would wipe the operator's in-progress edits. Reseed only when the selected session/plugin changes.
  useEffect(() => {
    const props = plugin.configSchema?.properties;
    if (!selSession || !props) {
      setOverrideCfg({});
      return;
    }
    const ov = plugin.sessionConfig?.[selSession] ?? {};
    const seeded: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(props)) {
      seeded[key] = key in ov ? ov[key] : (plugin.config[key] ?? emptyForField(field));
    }
    setOverrideCfg(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSession, plugin.id]);

  const saveOverride = async () => {
    if (!selSession || !plugin.configSchema?.properties) return;
    // Enforce the schema's HTML constraint hints (required/min/max/pattern) before saving.
    if (overrideFormRef.current && !overrideFormRef.current.reportValidity()) return;
    setSavingOverride(true);
    try {
      await pluginsApi.updateSessionConfig(plugin.id, selSession, sparseSessionOverride(overrideCfg, plugin));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingOverride(false);
    }
  };

  const clearOverride = async () => {
    if (!selSession) return;
    setSavingOverride(true);
    try {
      await pluginsApi.updateSessionConfig(plugin.id, selSession, {});
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingOverride(false);
    }
  };

  const hasOverride = (sid: string): boolean => Object.keys(plugin.sessionConfig?.[sid] ?? {}).length > 0;

  return (
    <div className="sessions-tab">
      <section className="sessions-section">
        <h3>{t('plugins.sessions.activationTitle')}</h3>
        <small>{t('plugins.sessions.activationDesc')}</small>
        <label className="sessions-radio">
          <input type="radio" name="activation" checked={mode === 'all'} onChange={() => setMode('all')} />
          <span>{t('plugins.sessions.allSessions')}</span>
        </label>
        <label className="sessions-radio">
          <input type="radio" name="activation" checked={mode === 'specific'} onChange={() => setMode('specific')} />
          <span>{t('plugins.sessions.specificSessions')}</span>
        </label>
        {mode === 'specific' &&
          (sessions.length === 0 ? (
            <p className="sessions-empty">{t('plugins.sessions.noSessions')}</p>
          ) : (
            <div className="sessions-checklist">
              {sessions.map(s => (
                <label key={s.id} className="sessions-check">
                  <input
                    type="checkbox"
                    checked={picked.has(s.id)}
                    onChange={e => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      setPicked(next);
                    }}
                  />
                  <span>{s.name || s.id}</span>
                </label>
              ))}
            </div>
          ))}
        <button className="btn-primary" onClick={() => void saveActivation()} disabled={savingAct}>
          {savingAct ? <Loader2 size={16} className="animate-spin" /> : t('plugins.sessions.saveActivation')}
        </button>
      </section>

      {(hasSchema || hasUi) && (
        <section className="sessions-section">
          <h3>{t('plugins.sessions.perSessionTitle')}</h3>
          <small>{t('plugins.sessions.perSessionDesc')}</small>
          <select className="sessions-select" value={selSession} onChange={e => setSelSession(e.target.value)}>
            <option value="">{t('plugins.sessions.selectSession')}</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {(s.name || s.id) + (hasOverride(s.id) ? ' ●' : '')}
              </option>
            ))}
          </select>
          {selSession && hasUi ? (
            <PluginConfigUi key={selSession} plugin={plugin} sessionId={selSession} />
          ) : selSession && plugin.configSchema ? (
            <>
              <form ref={overrideFormRef} className="config-form" onSubmit={e => e.preventDefault()}>
                {Object.entries(lzProps ?? plugin.configSchema.properties).map(([key, field]) => (
                  <ConfigField
                    key={key}
                    field={field}
                    label={field.title || key}
                    value={overrideCfg[key]}
                    onChange={v => setOverrideCfg({ ...overrideCfg, [key]: v })}
                  />
                ))}
              </form>
              <div className="sessions-override-actions">
                <button className="btn-secondary" onClick={() => void clearOverride()} disabled={savingOverride}>
                  {t('plugins.sessions.clearOverride')}
                </button>
                <button className="btn-primary" onClick={() => void saveOverride()} disabled={savingOverride}>
                  {savingOverride ? <Loader2 size={16} className="animate-spin" /> : t('plugins.sessions.saveOverride')}
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}

export default function Plugins() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('plugins.title'));
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: plugins = [], isLoading: loadingPlugins, error: queryError } = usePluginsQuery();
  const loading = loadingPlugins;
  const error = queryError instanceof Error ? queryError.message : null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const schemaFormRef = useRef<HTMLFormElement>(null);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configPluginId, setConfigPluginId] = useState<string | null>(null);
  // Derive the open plugin from the LIVE query so the modal (esp. the Sessions tab) reflects the
  // latest activeSessions/sessionConfig after a save + invalidate — not a stale open-time snapshot.
  const configPlugin = configPluginId ? (plugins.find(p => p.id === configPluginId) ?? null) : null;
  const [configTab, setConfigTab] = useState<'config' | 'sessions' | 'instances'>('config');
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
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
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
      toast.error(
        t('plugins.toasts.errorTitle'),
        err instanceof Error ? err.message : t('plugins.toasts.errorDefault'),
      );
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
    setConfigPluginId(plugin.id);
    setConfigTab('config');
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
    // Enforce the schema's HTML constraint hints (required/min/max/pattern) before saving.
    if (schemaFormRef.current && !schemaFormRef.current.reportValidity()) return;
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

  // Engines are configured under Infrastructure (Engine Configuration tile), not here — keep them
  // out of the plugin grid, the counts and the rail so the Plugins page is extensions-only.
  const visiblePlugins = plugins.filter(p => p.type !== 'engine');
  const enabledCount = visiblePlugins.filter(p => p.status === 'enabled').length;
  const activePlugins = visiblePlugins.filter(p => p.status === 'enabled');

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
          <div className="rail-stats">
            <div className="rail-stat">
              <span className="rail-stat-num">{enabledCount}</span>
              <span className="rail-stat-label">{t('plugins.rail.enabled', 'enabled')}</span>
            </div>
            <div className="rail-stat">
              <span className="rail-stat-num">{visiblePlugins.length}</span>
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
            {visiblePlugins.map(plugin => {
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

                      <button
                        onClick={() => handleHealthCheck(plugin.id)}
                        disabled={isLoading}
                        className="btn-action"
                        title={t('plugins.healthCheck')}
                      >
                        <CheckCircle size={16} />
                      </button>

                      <button
                        className="btn-action"
                        title={t('plugins.configure')}
                        onClick={() => handleOpenConfig(plugin)}
                      >
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

      {visiblePlugins.length === 0 && !loading && (
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
                    {t(
                      'plugins.installModal.hint',
                      'Upload a plugin packaged as a .zip (with a manifest.json). It runs sandboxed once enabled.',
                    )}
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
                  <button
                    className="btn-primary"
                    onClick={() => void handleInstall()}
                    disabled={!installFile || installing}
                  >
                    {installing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    {t('plugins.install', 'Install plugin')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-body">
                  <p className="install-hint">
                    {t(
                      'plugins.installModal.catalogHint',
                      'Install directly from the OpenWA plugin catalog. The .zip is fetched server-side through the SSRF guard, then validated and sandboxed.',
                    )}
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
                    (() => {
                      const q = catalogSearch.trim().toLowerCase();
                      const filtered = q
                        ? catalog.filter(e =>
                            [e.name, e.description, e.author, e.id].some(f => f?.toLowerCase().includes(q)),
                          )
                        : catalog;
                      return (
                        <>
                          <div className="catalog-search">
                            <Search size={15} />
                            <input
                              type="text"
                              value={catalogSearch}
                              onChange={e => setCatalogSearch(e.target.value)}
                              placeholder={t('plugins.catalog.searchPlaceholder', 'Search plugins…')}
                            />
                          </div>
                          {filtered.length === 0 ? (
                            <div className="catalog-empty">
                              {t('plugins.catalog.noMatch', 'No plugins match your search.')}
                            </div>
                          ) : (
                            <div className="catalog-list">
                              {filtered.map(entry => {
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
                                            {t('plugins.catalog.updateAvailable', 'Update available')} (v
                                            {entry.installedVersion} → v{entry.version})
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
                        </>
                      );
                    })()
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

      {showConfigModal &&
        configPlugin &&
        (() => {
          const lz = localizePlugin(configPlugin, i18n.language);
          // Session-scoped plugins get a Configuration/Sessions split; ingress-capable plugins add an
          // Instances tab. Either (or both) turns the modal into a tabbed view.
          const showTabs = configPlugin.sessionScoped !== false || configPlugin.ingressCapable;
          return (
            <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
              <div className="modal config-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>{t('plugins.config.title', { name: lz.name })}</h2>
                  <button className="btn-icon" onClick={() => setShowConfigModal(false)}>
                    <X size={20} />
                  </button>
                </div>

                {showTabs && (
                  <div className="modal-tabs">
                    <button
                      className={`modal-tab ${configTab === 'config' ? 'active' : ''}`}
                      onClick={() => setConfigTab('config')}
                    >
                      {t('plugins.config.tabConfig')}
                    </button>
                    {configPlugin.sessionScoped !== false && (
                      <button
                        className={`modal-tab ${configTab === 'sessions' ? 'active' : ''}`}
                        onClick={() => setConfigTab('sessions')}
                      >
                        {t('plugins.config.tabSessions')}
                      </button>
                    )}
                    {configPlugin.ingressCapable && (
                      <button
                        className={`modal-tab ${configTab === 'instances' ? 'active' : ''}`}
                        onClick={() => setConfigTab('instances')}
                      >
                        {t('plugins.instances.title')}
                      </button>
                    )}
                  </div>
                )}

                <div className="modal-body">
                  {showTabs && configTab === 'instances' && configPlugin.ingressCapable ? (
                    <PluginInstances pluginId={configPlugin.id} />
                  ) : showTabs && configTab === 'sessions' && configPlugin.sessionScoped !== false ? (
                    <SessionsTab plugin={configPlugin} />
                  ) : configPlugin.configUi ? (
                    <PluginConfigUi plugin={configPlugin} />
                  ) : lz.configSchema && Object.keys(lz.configSchema.properties).length > 0 ? (
                    <form ref={schemaFormRef} className="config-form" onSubmit={e => e.preventDefault()}>
                      {Object.entries(lz.configSchema.properties).map(([key, field]) => (
                        <ConfigField
                          key={key}
                          field={field}
                          label={field.title || key}
                          value={schemaConfig[key]}
                          onChange={v => setSchemaConfig({ ...schemaConfig, [key]: v })}
                        />
                      ))}
                    </form>
                  ) : (
                    <div className="no-config">
                      <Settings size={48} style={{ opacity: 0.3 }} />
                      <p>{t('plugins.config.noOptions')}</p>
                    </div>
                  )}
                </div>

                <div className="modal-footer">
                  <button className="btn-secondary" onClick={() => setShowConfigModal(false)}>
                    {t('common.close')}
                  </button>
                  {/* The Sessions and Instances tabs have their own actions; the footer Save is config-tab only. */}
                  {showTabs && (configTab === 'sessions' || configTab === 'instances')
                    ? null
                    : configPlugin.configUi ? null : lz.configSchema &&
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
