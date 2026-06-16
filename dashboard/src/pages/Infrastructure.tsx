import { useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { infraApi, API_BASE_URL } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useInfraStatusQuery, useInfraConfigQuery } from '../hooks/queries';
import { useToast } from '../components/Toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '../lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
}

interface ServerConfig {
  port: string;
  nodeEnv: 'production' | 'development';
  domain: string;
  dashboardPort: string;
  baseUrl: string;
  dashboardUrl: string;
  corsOrigins: string;
}

interface WebhookConfig {
  timeout: number;
  maxRetries: number;
  retryDelay: number;
}

interface RateLimitConfig {
  ttl: number;
  max: number;
}

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <label htmlFor={id} className="relative inline-flex h-5 w-9 cursor-pointer items-center">
      <input id={id} type="checkbox" className="peer sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="absolute inset-0 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-whatsapp-green" />
      <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
    </label>
  );
}

function RadioCard<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; desc: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {options.map(opt => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
          className={cn(
            "flex flex-col gap-0.5 p-3 rounded-lg text-left transition-colors",
            value === opt.value
              ? 'bg-whatsapp-green/10 ring-1 ring-whatsapp-green'
              : 'bg-background hover:bg-muted/50'
          )}>
          <span className="text-sm font-bold text-foreground">{opt.label}</span>
          <span className="text-xs text-muted-foreground">{opt.desc}</span>
        </button>
      ))}
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const toast = useToast();
  const { data: infraStatus, isLoading: loading } = useInfraStatusQuery();
  const { data: savedConfig } = useInfraConfigQuery();
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
    messages: { pending: 0, completed: 0, failed: 0 } as QueueStats,
    webhooks: { pending: 0, completed: 0, failed: 0 } as QueueStats,
  });

  const [redisEnabled, setRedisEnabled] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [pendingProfiles, setPendingProfiles] = useState<string[]>([]);
  const [previousProfiles, setPreviousProfiles] = useState<string[]>([]);

  const [serverConfig, setServerConfig] = useState<ServerConfig>({
    port: '2785',
    nodeEnv: 'development',
    domain: 'localhost',
    dashboardPort: '2886',
    baseUrl: '',
    dashboardUrl: '',
    corsOrigins: '*',
  });

  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>({
    timeout: 10000,
    maxRetries: 3,
    retryDelay: 5000,
  });

  const [rateLimitConfig, setRateLimitConfig] = useState<RateLimitConfig>({
    ttl: 60,
    max: 100,
  });

  useEffect(() => {
    if (!infraStatus) return;

    setDbConfig(prev => ({
      ...prev,
      type: (infraStatus.database.type as 'sqlite' | 'postgres') || 'sqlite',
      host: infraStatus.database.host || 'localhost',
    }));

    setRedisConfig(prev => ({
      ...prev,
      host: infraStatus.redis.host,
      port: String(infraStatus.redis.port),
      connected: infraStatus.redis.connected,
    }));

    setStorageConfig(prev => ({
      ...prev,
      type: infraStatus.storage.type,
      localPath: infraStatus.storage.path || './uploads',
    }));

    setQueueEnabled(infraStatus.queue.enabled);
    setQueueStats({
      messages: infraStatus.queue.messages,
      webhooks: infraStatus.queue.webhooks,
    });
  }, [infraStatus]);

  useEffect(() => {
    if (!savedConfig) return;
    setDbConfig(prev => ({
      ...prev,
      type: savedConfig.database.type,
      builtIn: savedConfig.database.builtIn,
      host: savedConfig.database.host || prev.host,
      port: savedConfig.database.port || prev.port,
      username: savedConfig.database.username || prev.username,
      database: savedConfig.database.database || prev.database,
      poolSize: savedConfig.database.poolSize,
      sslEnabled: savedConfig.database.sslEnabled,
      sslRejectUnauthorized: savedConfig.database.sslRejectUnauthorized,
    }));
    setRedisEnabled(savedConfig.redis.enabled);
    setRedisConfig(prev => ({
      ...prev,
      builtIn: savedConfig.redis.builtIn,
      host: savedConfig.redis.host || prev.host,
      port: savedConfig.redis.port || prev.port,
    }));
    setQueueEnabled(savedConfig.queue.enabled);
    setStorageConfig(prev => ({
      ...prev,
      type: savedConfig.storage.type,
      builtIn: savedConfig.storage.builtIn,
      localPath: savedConfig.storage.localPath || prev.localPath,
      s3Bucket: savedConfig.storage.s3Bucket || prev.s3Bucket,
      s3Region: savedConfig.storage.s3Region || prev.s3Region,
      s3Endpoint: savedConfig.storage.s3Endpoint || prev.s3Endpoint,
    }));
  }, [savedConfig]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <CircleNotch size={32} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) =>
    setDbConfig(prev => ({ ...prev, [key]: value }));
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) =>
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) =>
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  const updateServerConfig = (key: keyof ServerConfig, value: string) =>
    setServerConfig(prev => ({ ...prev, [key]: value }));
  const updateWebhookConfig = (key: keyof WebhookConfig, value: number) =>
    setWebhookConfig(prev => ({ ...prev, [key]: value }));
  const updateRateLimitConfig = (key: keyof RateLimitConfig, value: number) =>
    setRateLimitConfig(prev => ({ ...prev, [key]: value }));

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const payload = {
        database: { ...dbConfig },
        redis: { enabled: redisEnabled, ...redisConfig },
        queue: { enabled: queueEnabled },
        storage: { ...storageConfig },
        server: { ...serverConfig },
        webhook: { ...webhookConfig },
        rateLimit: { ...rateLimitConfig },
      };

      const result = await infraApi.saveConfig(payload);
      if (result.saved) {
        setPreviousProfiles(pendingProfiles);
        setPendingProfiles(result.profiles || []);
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

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">{t('infrastructure.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('infrastructure.subtitle')}</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Server Configuration */}
          <div className="bg-muted rounded-lg p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-foreground">{t('infrastructure.server.title')}</h2>
              <Badge className={cn(
                "text-[10px] font-bold uppercase border-none",
                serverConfig.nodeEnv === 'production'
                  ? 'bg-whatsapp-green/10 text-whatsapp-green'
                  : 'bg-blue-500/10 text-blue-500'
              )}>
                {serverConfig.nodeEnv === 'production' ? t('infrastructure.server.production') : t('infrastructure.server.development')}
              </Badge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label={t('infrastructure.server.environment')}>
                <Select value={serverConfig.nodeEnv}
                  onValueChange={v => updateServerConfig('nodeEnv', v as 'production' | 'development')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="production">{t('infrastructure.server.production')}</SelectItem>
                    <SelectItem value="development">{t('infrastructure.server.development')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={t('infrastructure.server.domain')}>
                <Input type="text" value={serverConfig.domain}
                  onChange={e => updateServerConfig('domain', e.target.value)} placeholder="localhost"
                  className="bg-background border-none rounded-lg" />
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <FormField label={t('infrastructure.server.apiPort')}>
                <Input type="text" value={serverConfig.port}
                  onChange={e => updateServerConfig('port', e.target.value)}
                  className="bg-background border-none rounded-lg" />
              </FormField>
              <FormField label={t('infrastructure.server.dashboardPort')}>
                <Input type="text" value={serverConfig.dashboardPort}
                  onChange={e => updateServerConfig('dashboardPort', e.target.value)}
                  className="bg-background border-none rounded-lg" />
              </FormField>
              <FormField label={t('infrastructure.server.corsOrigins')}>
                <Input type="text" value={serverConfig.corsOrigins}
                  onChange={e => updateServerConfig('corsOrigins', e.target.value)}
                  placeholder={t('infrastructure.server.corsPlaceholder')}
                  className="bg-background border-none rounded-lg" />
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label={t('infrastructure.server.publicApiUrl')}>
                <Input type="text" value={serverConfig.baseUrl}
                  onChange={e => updateServerConfig('baseUrl', e.target.value)}
                  placeholder="https://api.yourdomain.com"
                  className="bg-background border-none rounded-lg" />
              </FormField>
              <FormField label={t('infrastructure.server.publicDashboardUrl')}>
                <Input type="text" value={serverConfig.dashboardUrl}
                  onChange={e => updateServerConfig('dashboardUrl', e.target.value)}
                  placeholder="https://dashboard.yourdomain.com"
                  className="bg-background border-none rounded-lg" />
              </FormField>
            </div>
          </div>

          {/* Webhook & Rate Limiting */}
          <div className="bg-muted rounded-lg p-4 flex flex-col gap-4">
            <h2 className="text-sm font-bold text-foreground">{t('infrastructure.webhook.title')}</h2>

            <div>
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">{t('infrastructure.webhook.settings')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <FormField label={t('infrastructure.webhook.timeout')}>
                  <Input type="number" value={webhookConfig.timeout}
                    onChange={e => updateWebhookConfig('timeout', parseInt(e.target.value) || 10000)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
                <FormField label={t('infrastructure.webhook.maxRetries')}>
                  <Input type="number" min="0" max="10" value={webhookConfig.maxRetries}
                    onChange={e => updateWebhookConfig('maxRetries', parseInt(e.target.value) || 3)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
                <FormField label={t('infrastructure.webhook.retryDelay')}>
                  <Input type="number" value={webhookConfig.retryDelay}
                    onChange={e => updateWebhookConfig('retryDelay', parseInt(e.target.value) || 5000)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">{t('infrastructure.webhook.rateLimit')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label={t('infrastructure.webhook.window')}>
                  <Input type="number" value={rateLimitConfig.ttl}
                    onChange={e => updateRateLimitConfig('ttl', parseInt(e.target.value) || 60)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
                <FormField label={t('infrastructure.webhook.maxReq')}>
                  <Input type="number" value={rateLimitConfig.max}
                    onChange={e => updateRateLimitConfig('max', parseInt(e.target.value) || 100)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
              </div>
            </div>
          </div>

          {/* Database */}
          <div className="bg-muted rounded-lg p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-foreground">{t('infrastructure.database.title')}</h2>
              <Badge className={cn(
                "text-[10px] font-bold uppercase border-none",
                dbConfig.type === 'postgres' ? 'bg-whatsapp-green/10 text-whatsapp-green' : 'bg-blue-500/10 text-blue-500'
              )}>
                {dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
              </Badge>
            </div>

            <RadioCard
              options={[
                { value: 'sqlite' as const, label: t('infrastructure.database.sqlite'), desc: t('infrastructure.database.sqliteDesc') },
                { value: 'postgres' as const, label: t('infrastructure.database.postgres'), desc: t('infrastructure.database.postgresDesc') },
              ]}
              value={dbConfig.type}
              onChange={v => updateDbConfig('type', v)}
            />

            {dbConfig.type === 'postgres' && (
              <>
                <ToggleRow
                  label={t('infrastructure.database.useBuiltIn')}
                  desc={t('infrastructure.database.builtInDesc')}
                  checked={dbConfig.builtIn}
                  onChange={v => updateDbConfig('builtIn', v)}
                />

                {!dbConfig.builtIn && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField label={t('common.host')}>
                        <Input type="text" value={dbConfig.host}
                          onChange={e => updateDbConfig('host', e.target.value)}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                      <FormField label={t('common.port')}>
                        <Input type="text" value={dbConfig.port}
                          onChange={e => updateDbConfig('port', e.target.value)}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField label={t('common.username')}>
                        <Input type="text" value={dbConfig.username}
                          onChange={e => updateDbConfig('username', e.target.value)}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                      <FormField label={t('common.password')}>
                        <Input type="password" value={dbConfig.password}
                          onChange={e => updateDbConfig('password', e.target.value)}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField label={t('infrastructure.database.dbName')}>
                        <Input type="text" value={dbConfig.database}
                          onChange={e => updateDbConfig('database', e.target.value)}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                      <FormField label={t('infrastructure.database.poolSize')}>
                        <Input type="number" min="1" max="50" value={dbConfig.poolSize}
                          onChange={e => updateDbConfig('poolSize', parseInt(e.target.value))}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                    </div>
                    <ToggleRow
                      label={t('infrastructure.database.ssl')}
                      desc={t('infrastructure.database.sslDesc')}
                      checked={dbConfig.sslEnabled}
                      onChange={v => updateDbConfig('sslEnabled', v)}
                    />
                    {dbConfig.sslEnabled && (
                      <ToggleRow
                        label={t('infrastructure.database.sslRejectUnauthorized')}
                        desc={t('infrastructure.database.sslRejectUnauthorizedDesc')}
                        checked={dbConfig.sslRejectUnauthorized}
                        onChange={v => updateDbConfig('sslRejectUnauthorized', v)}
                      />
                    )}
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col items-center py-6 text-muted-foreground bg-background rounded-lg">
              <p className="text-sm font-medium text-foreground">{t('infrastructure.database.migrationsTitle')}</p>
              <p className="text-xs text-whatsapp-green font-medium mt-2 flex items-center gap-1.5">
                <CheckCircle size={14} weight="fill" />
                {t('infrastructure.database.migrationsStatus')}
              </p>
              <p className="text-xs text-muted-foreground mt-2 max-w-sm text-center">{t('infrastructure.database.migrationsHint')}</p>
            </div>
          </div>

          {/* Redis */}
          <div className="bg-muted rounded-lg p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-foreground">{t('infrastructure.redis.title')}</h2>
              <Badge className={cn(
                "text-[10px] font-bold uppercase border-none",
                redisEnabled && redisConfig.connected
                  ? 'bg-whatsapp-green/10 text-whatsapp-green'
                  : redisEnabled
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-background text-muted-foreground'
              )}>
                {redisEnabled
                  ? redisConfig.connected
                    ? t('infrastructure.statusLabels.connected')
                    : t('infrastructure.statusLabels.disconnected')
                  : t('infrastructure.statusLabels.disabled')}
              </Badge>
            </div>

            <ToggleRow
              label={t('infrastructure.redis.enable')}
              desc={t('infrastructure.redis.enableDesc')}
              checked={redisEnabled}
              onChange={v => {
                setRedisEnabled(v);
                if (!v) setQueueEnabled(false);
              }}
            />

            {redisEnabled && (
              <>
                <ToggleRow
                  label={t('infrastructure.redis.useBuiltIn')}
                  desc={t('infrastructure.redis.builtInDesc')}
                  checked={redisConfig.builtIn}
                  onChange={v => updateRedisConfig('builtIn', v)}
                />

                {!redisConfig.builtIn && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FormField label={t('common.host')}>
                      <Input type="text" value={redisConfig.host}
                        onChange={e => updateRedisConfig('host', e.target.value)}
                        className="bg-background border-none rounded-lg" />
                    </FormField>
                    <FormField label={t('common.port')}>
                      <Input type="text" value={redisConfig.port}
                        onChange={e => updateRedisConfig('port', e.target.value)}
                        className="bg-background border-none rounded-lg" />
                    </FormField>
                    <FormField label={t('common.password')}>
                      <Input type="password" value={redisConfig.password}
                        onChange={e => updateRedisConfig('password', e.target.value)}
                        placeholder={t('infrastructure.redis.passwordOptional')}
                        className="bg-background border-none rounded-lg" />
                    </FormField>
                  </div>
                )}

                <div>
                  <ToggleRow
                    label={t('infrastructure.redis.queueTitle')}
                    desc={t('infrastructure.redis.queueDesc')}
                    checked={queueEnabled}
                    onChange={setQueueEnabled}
                  />
                </div>

                {queueEnabled && (
                  <div className="flex flex-col gap-3 pt-2">
                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('infrastructure.redis.statsTitle')}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="bg-background rounded-lg p-3 flex flex-col gap-2">
                        <h4 className="text-xs font-bold text-muted-foreground">{t('infrastructure.redis.messageQueue')}</h4>
                        <div className="flex gap-4">
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-orange-500">{queueStats.messages.pending}</span>
                            <span className="text-[10px] uppercase tracking-wider text-orange-500 font-bold">{t('infrastructure.redis.pending')}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-whatsapp-green">{queueStats.messages.completed.toLocaleString()}</span>
                            <span className="text-[10px] uppercase tracking-wider text-whatsapp-green font-bold">{t('infrastructure.redis.completed')}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-destructive">{queueStats.messages.failed}</span>
                            <span className="text-[10px] uppercase tracking-wider text-destructive font-bold">{t('infrastructure.redis.failed')}</span>
                          </div>
                        </div>
                      </div>
                      <div className="bg-background rounded-lg p-3 flex flex-col gap-2">
                        <h4 className="text-xs font-bold text-muted-foreground">{t('infrastructure.redis.webhookQueue')}</h4>
                        <div className="flex gap-4">
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-orange-500">{queueStats.webhooks.pending}</span>
                            <span className="text-[10px] uppercase tracking-wider text-orange-500 font-bold">{t('infrastructure.redis.pending')}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-whatsapp-green">{queueStats.webhooks.completed.toLocaleString()}</span>
                            <span className="text-[10px] uppercase tracking-wider text-whatsapp-green font-bold">{t('infrastructure.redis.completed')}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-lg font-bold text-destructive">{queueStats.webhooks.failed}</span>
                            <span className="text-[10px] uppercase tracking-wider text-destructive font-bold">{t('infrastructure.redis.failed')}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="destructive" size="sm" className="rounded-lg">
                        {t('infrastructure.redis.clearFailed')}
                      </Button>
                      <Button variant="secondary" size="sm" className="rounded-lg"
                        onClick={() => window.open(`${API_BASE_URL}/admin/queues`, '_blank')}>
                        {t('infrastructure.redis.viewBullMq')}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {!redisEnabled && (
              <div className="flex flex-col items-center py-6 text-muted-foreground bg-background rounded-lg">
                <p className="text-sm font-medium text-foreground">{t('infrastructure.redis.disabledTitle')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('infrastructure.redis.disabledDesc')}</p>
              </div>
            )}
          </div>

          {/* Storage */}
          <div className="bg-muted rounded-lg p-4 flex flex-col gap-4 lg:col-span-2">
            <h2 className="text-sm font-bold text-foreground">{t('infrastructure.storage.title')}</h2>

            <RadioCard
              options={[
                { value: 'local' as const, label: t('infrastructure.storage.local'), desc: t('infrastructure.storage.localDesc') },
                { value: 's3' as const, label: t('infrastructure.storage.s3'), desc: t('infrastructure.storage.s3Desc') },
              ]}
              value={storageConfig.type}
              onChange={v => updateStorageConfig('type', v)}
            />

            <div className="flex flex-col gap-3">
              {storageConfig.type === 'local' && (
                <FormField label={t('infrastructure.storage.storagePath')}>
                  <Input type="text" value={storageConfig.localPath}
                    onChange={e => updateStorageConfig('localPath', e.target.value)}
                    className="bg-background border-none rounded-lg" />
                </FormField>
              )}

              {storageConfig.type === 's3' && (
                <>
                  <ToggleRow
                    label={t('infrastructure.storage.useBuiltIn')}
                    desc={t('infrastructure.storage.builtInDesc')}
                    checked={storageConfig.builtIn}
                    onChange={v => updateStorageConfig('builtIn', v)}
                  />

                  {!storageConfig.builtIn && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <FormField label={t('infrastructure.storage.bucket')}>
                          <Input type="text" value={storageConfig.s3Bucket}
                            onChange={e => updateStorageConfig('s3Bucket', e.target.value)}
                            className="bg-background border-none rounded-lg" />
                        </FormField>
                        <FormField label={t('infrastructure.storage.region')}>
                          <Input type="text" value={storageConfig.s3Region}
                            onChange={e => updateStorageConfig('s3Region', e.target.value)}
                            className="bg-background border-none rounded-lg" />
                        </FormField>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <FormField label={t('infrastructure.storage.accessKey')}>
                          <Input type="text" value={storageConfig.s3AccessKey}
                            onChange={e => updateStorageConfig('s3AccessKey', e.target.value)}
                            className="bg-background border-none rounded-lg" />
                        </FormField>
                        <FormField label={t('infrastructure.storage.secretKey')}>
                          <Input type="password" value={storageConfig.s3SecretKey}
                            onChange={e => updateStorageConfig('s3SecretKey', e.target.value)}
                            className="bg-background border-none rounded-lg" />
                        </FormField>
                      </div>
                      <FormField label={t('infrastructure.storage.endpoint')}>
                        <Input type="text" value={storageConfig.s3Endpoint}
                          onChange={e => updateStorageConfig('s3Endpoint', e.target.value)}
                          placeholder={t('infrastructure.storage.endpointHint')}
                          className="bg-background border-none rounded-lg" />
                      </FormField>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleSaveConfig} disabled={saving}>
            {saving ? <CircleNotch size={18} className="animate-spin" /> : null}
            {saving ? t('infrastructure.saving') : t('infrastructure.saveConfig')}
          </Button>
        </div>

        <Dialog open={showRestartModal} onOpenChange={v => { if (!v) setShowRestartModal(false); }}>
          <DialogContent className="sm:max-w-md text-center">
            <DialogHeader>
              <DialogTitle>
                {restartStatus === 'idle' && t('infrastructure.restart.idleTitle')}
                {restartStatus === 'restarting' && t('infrastructure.restart.restartingTitle')}
                {restartStatus === 'waiting' && t('infrastructure.restart.waitingTitle')}
                {restartStatus === 'success' && t('infrastructure.restart.successTitle')}
                {restartStatus === 'error' && t('infrastructure.restart.errorTitle')}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              {restartStatus === 'idle' && (
                <>
                  <p className="text-sm text-muted-foreground">
                    <Trans i18nKey="infrastructure.restart.idleDesc" components={{ code: <code />, br: <br /> }} />
                  </p>
                  <div className="flex gap-3">
                    <Button variant="ghost" onClick={() => setShowRestartModal(false)} className="rounded-lg">
                      {t('infrastructure.restart.later')}
                    </Button>
                    <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleRestart}>
                      {t('infrastructure.restart.now')}
                    </Button>
                  </div>
                </>
              )}

              {(restartStatus === 'restarting' || restartStatus === 'waiting') && (
                <>
                  <CircleNotch size={48} className="animate-spin text-whatsapp-green" />
                  <p className="text-sm font-medium text-foreground">
                    {restartCountdown > 0
                      ? t('infrastructure.restart.restartingMsg', { count: restartCountdown })
                      : t('infrastructure.restart.checking')}
                  </p>
                  <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-whatsapp-green rounded-full transition-all duration-1000"
                      style={{ width: restartCountdown > 0 ? `${((30 - restartCountdown) / 30) * 100}%` : '100%' }} />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('infrastructure.restart.dontClose')}</p>
                </>
              )}

              {restartStatus === 'success' && (
                <>
                  <CheckCircle size={48} className="text-whatsapp-green" weight="fill" />
                  <p className="text-sm text-muted-foreground">{t('infrastructure.restart.successMsg')}</p>
                </>
              )}

              {restartStatus === 'error' && (
                <>
                  <p className="text-sm text-destructive">{t('infrastructure.restart.errorMsg')}</p>
                  <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg"
                    onClick={() => window.location.reload()}>
                    {t('infrastructure.restart.reload')}
                  </Button>
                </>
              )}
            </div>
            {restartStatus === 'error' && (
              <DialogFooter>
                <Button variant="ghost" onClick={() => { setShowRestartModal(false); setRestartStatus('idle'); }} className="rounded-lg">
                  {t('common.cancel')}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
