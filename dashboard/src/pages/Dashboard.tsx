import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery, useSessionStatsQuery, useWebhooksQuery, useStopSessionMutation } from '../hooks/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '../lib/utils';

export function Dashboard() {
  const { t } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const { data: stats } = useSessionStatsQuery();
  const { data: webhooks = [] } = useWebhooksQuery();
  const stopMutation = useStopSessionMutation();

  const loading = loadingSessions;
  const error = sessionsError instanceof Error
    ? sessionsError.message
    : sessionsError
      ? t('dashboard.loadError')
      : null;
  const webhookCount = webhooks.length;

  const handleDisconnect = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
  };

  const overviewItems = [
    { label: t('dashboard.stats.activeSessions'), value: stats?.active ?? 0 },
    { label: t('dashboard.stats.webhooksConfigured'), value: webhookCount },
    { label: t('dashboard.stats.totalSessions'), value: stats?.total ?? sessions.length },
    { label: t('dashboard.stats.messagesToday'), value: stats?.ready ?? 0 },
  ];

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.hoursAgo', { count: Math.floor(diff / 3600000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const statusClasses: Record<string, string> = {
    ready: 'bg-whatsapp-green/10 text-whatsapp-green',
    initializing: 'bg-amber-500/10 text-amber-600',
    connecting: 'bg-amber-500/10 text-amber-600',
    qr_ready: 'bg-blue-500/10 text-blue-600',
    authenticating: 'bg-purple-500/10 text-purple-600',
    created: 'bg-teal-500/10 text-teal-600',
    idle: 'bg-violet-500/10 text-violet-600',
    disconnected: 'bg-orange-500/10 text-orange-600',
    failed: 'bg-red-500/10 text-red-600',
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-3 rounded-full bg-popover/80 px-4 py-2 text-sm text-muted-foreground">
          <CircleNotch size={18} className="animate-spin text-whatsapp-green" />
          Loading dashboard
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-8 bg-background h-full">
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-2xl bg-popover/80 p-5 text-destructive">
          <WarningCircle size={22} weight="fill" className="mt-0.5 shrink-0" />
          <div>
            <h3 className="text-base font-semibold">Error loading dashboard</h3>
            <p className="mt-1 text-sm text-foreground/80">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 p-4 sm:p-8">
        <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Overview</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('dashboard.subtitle')}</p>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-popover/60">
          <div className="grid grid-cols-2 md:grid-cols-4">
            {overviewItems.map(item => (
              <div key={item.label} className="px-4 py-4 sm:px-5 sm:py-5">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{item.label}</div>
                <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{typeof item.value === 'number' ? item.value.toLocaleString() : item.value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-popover/60">
          <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold tracking-tight">{t('dashboard.sessionsOverview')}</h2>
              <Badge variant="secondary" className="rounded-full bg-muted text-muted-foreground">
                {t('dashboard.showingSessions', { shown: sessions.length, total: stats?.total ?? 0 })}
              </Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} className="rounded-full text-whatsapp-green hover:bg-whatsapp-green/10 hover:text-whatsapp-green-dark">
              {t('common.viewAll')}
            </Button>
          </div>

          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center text-muted-foreground">
              <div className="max-w-sm text-sm leading-6">{t('dashboard.noSessions')}</div>
              <Button variant="outline" className="mt-5 rounded-full border-whatsapp-green/30 text-whatsapp-green hover:bg-whatsapp-green/10" onClick={() => navigate('/sessions')}>
                Create your first session
              </Button>
            </div>
          ) : (
            <div>
              {sessions.map(session => (
                <div
                  key={session.id}
                  className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 hover:bg-muted/40 transition-colors cursor-pointer"
                  onClick={() => navigate('/sessions')}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-semibold">{session.name}</span>
                      <Badge className={cn('rounded-full border-none px-2 py-0 text-[10px] font-semibold uppercase tracking-wide', statusClasses[session.status] ?? 'bg-muted text-muted-foreground')}>
                        {formatStatus(session.status)}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground font-mono">{session.id.substring(0, 12)}... • {session.phone || '—'}</div>
                  </div>

                  <div className="flex items-center gap-3 sm:shrink-0">
                    <div className="hidden text-right sm:block">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{t('dashboard.columns.lastActive')}</div>
                      <div className="text-sm font-medium">{formatLastActive(session.lastActive)}</div>
                    </div>

                    {['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDisconnect(session.id);
                        }}
                      >
                        Stop
                      </Button>
                    )}

                    <Button variant="secondary" size="sm" className="rounded-full bg-muted text-muted-foreground hover:text-foreground">
                      Open
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
