import { Suspense } from 'react';
import { lazyWithRetry as lazy } from '../utils/lazyWithRetry';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, Webhook, Activity, Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useSessionsQuery,
  useSessionStatsQuery,
  useWebhooksQuery,
  useStopSessionMutation,
  useStatsOverviewQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { isSessionStarted } from '../utils/sessionActions';
import './Dashboard.css';
import { formatLastActive, formatSessionStatus } from '../utils/sessionDisplay';

// recharts is heavy (~116 kB gzip); load the analytics section on demand so it never bloats the
// main/login bundle, and only for an unscoped admin key: /stats/messages refuses every other key.
const DashboardCharts = lazy(() => import('../components/DashboardCharts').then(m => ({ default: m.DashboardCharts })));

export function Dashboard() {
  const { t } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const { canWrite, isAdmin, scoped } = useRole();
  // The cross-session statistics also refuse a session-scoped key, whatever its role.
  const canReadStats = isAdmin && !scoped;
  const toast = useToast();
  const {
    data: sessions = [],
    isLoading: loadingSessions,
    error: sessionsError,
    isLoadingError: sessionsNeverLoaded,
  } = useSessionsQuery();
  const { data: stats } = useSessionStatsQuery();
  // GET /webhooks is OPERATOR-only and /stats/overview ADMIN-only. A key without the role is not sent
  // them, since the gateway audits every refusal as a failed authentication; their cards show the
  // unavailable placeholder.
  const { data: webhooks } = useWebhooksQuery(canWrite);
  const { data: overview } = useStatsOverviewQuery(canReadStats);
  const stopMutation = useStopSessionMutation();
  const unavailable = '—';
  const messagesToday = overview ? overview.messages.today.sent + overview.messages.today.received : unavailable;
  const totalMessages = overview ? overview.messages.sent + overview.messages.received : unavailable;
  const loading = loadingSessions;
  // Statistics that are unread or refused do not mean no session is connected: the list says which are.
  const readyCount = stats?.ready ?? sessions.filter(session => session.status === 'ready').length;
  // Only a read that never succeeded replaces the page: a failed background refetch keeps its cached
  // data (as the webhook card below does), so the last good view stays on screen.
  const error = sessionsNeverLoaded
    ? sessionsError instanceof Error
      ? sessionsError.message
      : t('dashboard.loadError')
    : null;
  // A viewer is not sent the webhook read, and a pending or failed read is not zero webhooks either.
  // A failed background refetch keeps the cached list, which still counts.
  const webhookCount = !canWrite || !webhooks ? unavailable : webhooks.length;

  const handleDisconnect = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
    } catch (err) {
      toast.error(t('dashboard.disconnectFailed'), err instanceof Error ? err.message : undefined);
    }
  };

  const statsCards = [
    {
      // `stats.active` counts running engines — which includes initializing/qr_ready/connecting — so
      // it overstates what an operator reads as "connected". READY is the only status where the
      // session can actually send and receive.
      label: t('dashboard.stats.activeSessions'),
      value: readyCount,
      icon: MessageSquare,
      detail: stats ? t('dashboard.stats.sessionsDetail', { running: stats.active, total: stats.total }) : undefined,
    },
    { label: t('dashboard.stats.messagesToday'), value: messagesToday, icon: Send },
    { label: t('dashboard.stats.webhooksConfigured'), value: webhookCount, icon: Webhook },
    { label: t('dashboard.stats.totalMessages'), value: totalMessages, icon: Activity },
  ];

  if (loading) {
    return (
      <div
        className="dashboard"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard" style={{ padding: '2rem' }}>
        <div
          role="alert"
          style={{
            background: 'rgba(239, 68, 68, 0.12)',
            padding: '1rem',
            borderRadius: '8px',
            color: 'var(--error-text)',
          }}
        >
          {t('dashboard.errorPrefix', { message: error })}
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        badge={
          <span className={`status-badge ${readyCount > 0 ? 'connected' : 'disconnected'}`}>
            {readyCount > 0 ? t('common.connected') : t('common.disconnected')}
          </span>
        }
      />

      <div className="stats-grid">
        {statsCards.map(({ label, value, icon: Icon, detail }) => (
          <div key={label} className="stat-card">
            <Icon className="stat-watermark" />
            <div className="stat-header">
              <span className="stat-label">{label}</span>
              <Icon size={20} className="stat-icon" />
            </div>
            <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
            {detail && <div className="stat-detail">{detail}</div>}
          </div>
        ))}
      </div>

      {canReadStats && (
        <Suspense fallback={null}>
          <DashboardCharts />
        </Suspense>
      )}

      <section className="sessions-section">
        <div className="section-header">
          <h2>{t('dashboard.sessionsOverview')}</h2>
          <span className="section-subtitle">
            {t('dashboard.showingSessions', { shown: sessions.length, total: stats?.total ?? sessions.length })}
          </span>
        </div>

        <div className="sessions-table">
          <div className="table-header">
            <span>{t('dashboard.columns.sessionId')}</span>
            <span>{t('dashboard.columns.phone')}</span>
            <span>{t('dashboard.columns.status')}</span>
            <span>{t('dashboard.columns.lastActive')}</span>
            <span>{t('dashboard.columns.actions')}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="table-row" style={{ justifyContent: 'center', color: 'var(--text-muted)' }}>
              {t('dashboard.noSessions')}
            </div>
          ) : (
            sessions.map(session => (
              <div key={session.id} className="table-row">
                <div className="session-info-cell">
                  <span className="session-id">{session.id.substring(0, 12)}</span>
                  <span className="session-name" title={session.name}>
                    {session.name}
                  </span>
                </div>
                <span className="phone">{session.phone || '—'}</span>
                <span className={`status-pill ${session.status}`}>{formatSessionStatus(t, session.status)}</span>
                <span className="last-active">{formatLastActive(t, session.lastActive)}</span>
                <div className="actions">
                  <button className="btn-sm" onClick={() => navigate('/sessions')}>
                    {t('dashboard.view')}
                  </button>
                  {/* Stopping a session is an operator write; a read-only key would only collect a 403. */}
                  {canWrite && isSessionStarted(session) && (
                    <button className="btn-sm danger" onClick={() => handleDisconnect(session.id)}>
                      {t('dashboard.disconnect')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
