import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  PuzzlePiece,
  Power,
  Prohibit,
  Gear,
  CheckCircle,
  WarningCircle,
  CircleNotch,
  ArrowClockwise,
} from '@phosphor-icons/react';
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
import { useToast } from '../components/Toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '../lib/utils';

interface EngineConfig {
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
  const [configOpen, setConfigOpen] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null);
  const [engineConfig, setEngineConfig] = useState<EngineConfig>({
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
    setConfigOpen(true);
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      await infraApi.saveConfig({
        engine: {
          headless: engineConfig.headless,
          sessionDataPath: engineConfig.sessionDataPath,
          browserArgs: engineConfig.browserArgs,
        },
      });
      toast.success(t('plugins.toasts.savedTitle'), t('plugins.toasts.savedDesc'));
      setConfigOpen(false);
    } catch (err) {
      toast.error(t('plugins.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <CircleNotch size={48} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  const activeEngine = engines.find(e => e.id === currentEngine);

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t('plugins.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('plugins.subtitle')}</p>
          </div>
          <Button variant="secondary" onClick={refetchAll}>
            <ArrowClockwise size={16} weight="bold" />
            {t('plugins.refresh')}
          </Button>
        </header>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive text-sm rounded-md">
            <WarningCircle size={18} weight="fill" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-4 bg-muted rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{t('plugins.engineCard')}</h3>
              <p className="text-xs text-muted-foreground">{currentEngine}</p>
            </div>
            <Badge className="bg-whatsapp-green/10 text-whatsapp-green border-none">{t('plugins.running')}</Badge>
          </div>
          {activeEngine && activeEngine.features.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{t('plugins.supportedFeatures')}</p>
              <div className="flex flex-wrap gap-1">
                {activeEngine.features.map(feature => (
                  <span key={feature} className="text-xs text-muted-foreground">
                    {feature.replace(/-/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plugins.map(plugin => {
            const isLoading = actionLoading === plugin.id;

            return (
              <div key={plugin.id} className="flex flex-col bg-muted rounded-lg">
                <div className="flex items-start justify-between gap-2 p-4">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold truncate">{plugin.name}</h3>
                    <p className="text-[11px] text-muted-foreground">v{plugin.version}</p>
                  </div>
                  {plugin.builtIn && (
                    <Badge className="text-[10px] text-whatsapp-green border-none bg-whatsapp-green/10 shrink-0">
                      {t('plugins.builtIn')}
                    </Badge>
                  )}
                </div>

                <div className="px-4 pb-4 flex-1 flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground flex-1">{plugin.description || t('plugins.noDescription')}</p>

                  <div className="flex items-center justify-between">
                    <Badge className={cn(
                      "text-[10px] font-bold uppercase tracking-wider border-none",
                      plugin.status === 'enabled' ? 'bg-whatsapp-green/10 text-whatsapp-green' : 'bg-background text-muted-foreground'
                    )}>
                      {plugin.status}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground capitalize">{plugin.type}</span>
                  </div>

                  {plugin.error && (
                    <div className="p-2 bg-destructive/10 text-destructive text-xs rounded-md">{plugin.error}</div>
                  )}

                  {plugin.provides && plugin.provides.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {plugin.provides.map(item => (
                        <span key={item} className="text-[10px] text-muted-foreground">
                          {item}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    {plugin.type === 'engine' ? (
                      (() => {
                        const enginePlugins = plugins.filter(p => p.type === 'engine');
                        const isOnlyEngine = enginePlugins.length === 1;
                        const isActive = plugin.status === 'enabled';

                        if (isOnlyEngine && isActive) {
                          return (
                            <span className="flex items-center gap-1 text-xs text-whatsapp-green font-medium">
                              <CheckCircle size={14} weight="fill" />
                              {t('plugins.required')}
                            </span>
                          );
                        } else if (isActive) {
                          return (
                            <span className="flex items-center gap-1 text-xs text-whatsapp-green font-medium">
                              <CheckCircle size={14} weight="fill" />
                              {t('plugins.active')}
                            </span>
                          );
                        } else {
                          return (
                            <Button size="sm" className="bg-whatsapp-green hover:bg-whatsapp-green/90 text-white rounded-lg"
                              onClick={() => handleToggle(plugin)} disabled={isLoading}>
                              {isLoading ? <CircleNotch size={14} className="animate-spin" /> : <Power size={14} weight="bold" />}
                              {t('plugins.activate')}
                            </Button>
                          );
                        }
                      })()
                    ) : (
                      <Button size="sm" variant={plugin.status === 'enabled' ? 'destructive' : 'default'}
                        className={cn(
                          "rounded-lg",
                          plugin.status !== 'enabled' ? 'bg-whatsapp-green hover:bg-whatsapp-green/90' : ''
                        )}
                        onClick={() => handleToggle(plugin)} disabled={isLoading}>
                        {isLoading ? <CircleNotch size={14} className="animate-spin" /> :
                          plugin.status === 'enabled' ? <Prohibit size={14} weight="bold" /> : <Power size={14} weight="bold" />}
                        {plugin.status === 'enabled' ? t('plugins.disable') : t('plugins.enable')}
                      </Button>
                    )}

                    <Button variant="ghost" size="icon-sm" onClick={() => handleHealthCheck(plugin.id)} disabled={isLoading} title={t('plugins.healthCheck')}>
                      <CheckCircle size={16} />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleOpenConfig(plugin)} title={t('plugins.configure')}>
                      <Gear size={16} />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {plugins.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <PuzzlePiece size={64} weight="thin" />
            <h3 className="font-bold text-foreground text-sm">{t('plugins.empty.title')}</h3>
            <p className="text-sm">{t('plugins.empty.description')}</p>
          </div>
        )}

        <Dialog open={configOpen} onOpenChange={setConfigOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('plugins.config.title', { name: configPlugin?.name || '' })}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {configPlugin?.type === 'engine' ? (
                <>
                  <div className="flex items-center gap-2 p-3 bg-orange-500/10 text-orange-500 text-xs rounded-md">
                    <WarningCircle size={16} weight="fill" />
                    <span>{t('plugins.config.restartNotice')}</span>
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-muted-foreground">{t('plugins.config.engineType')}</label>
                      <Input value="whatsapp-web.js" readOnly className="bg-muted border-none rounded-lg" />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-muted-foreground">{t('plugins.config.headless')}</span>
                        <span className="text-[11px] text-muted-foreground">{t('plugins.config.headlessDesc')}</span>
                      </div>
                      <label className="relative inline-flex h-5 w-9 cursor-pointer items-center">
                        <input type="checkbox" className="peer sr-only" checked={engineConfig.headless}
                          onChange={e => setEngineConfig({ ...engineConfig, headless: e.target.checked })} />
                        <span className="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-whatsapp-green" />
                        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                      </label>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-muted-foreground">{t('plugins.config.sessionDataPath')}</label>
                      <Input value={engineConfig.sessionDataPath}
                        onChange={e => setEngineConfig({ ...engineConfig, sessionDataPath: e.target.value })}
                        className="bg-muted border-none rounded-lg" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-muted-foreground">{t('plugins.config.browserArgs')}</label>
                      <Input value={engineConfig.browserArgs}
                        onChange={e => setEngineConfig({ ...engineConfig, browserArgs: e.target.value })}
                        placeholder="--no-sandbox --disable-gpu"
                        className="bg-muted border-none rounded-lg" />
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-8 text-muted-foreground">
                  <Gear size={48} className="opacity-30" />
                  <p className="text-sm mt-2">{t('plugins.config.noOptions')}</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfigOpen(false)}>{t('common.cancel')}</Button>
              {configPlugin?.type === 'engine' && (
                <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleSaveConfig} disabled={savingConfig}>
                  {savingConfig ? <CircleNotch size={16} className="animate-spin" /> : t('plugins.config.save')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
