import { useTranslation } from 'react-i18next';
import { AlertCircle, ListOrdered, Loader2, RefreshCw } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOpenWaRemoteQueuesQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Infrastructure.css';
import './OpenWaQueues.css';

export function OpenWaQueues() {
  const { t } = useTranslation();
  useDocumentTitle(t('filasOpenWa.title'));
  const { data, isLoading, isError, refetch, isFetching } = useOpenWaRemoteQueuesQuery();

  if (isLoading) {
    return (
      <div
        className="openwa-queues-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="openwa-queues-page infrastructure-page">
      <PageHeader
        title={t('filasOpenWa.title')}
        subtitle={t('filasOpenWa.subtitle')}
        actions={
          <button type="button" className="btn-secondary" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw size={16} className={isFetching ? 'animate-spin' : undefined} />
            {t('filasOpenWa.refresh')}
          </button>
        }
      />
      {isError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('filasOpenWa.loadError')}</span>
        </div>
      )}
      {data && !data.configured && (
        <div className="empty-table-state">
          <ListOrdered size={48} strokeWidth={1} />
          <h3>{t('filasOpenWa.unconfigured')}</h3>
          <p>{t('filasOpenWa.unconfiguredHint')}</p>
        </div>
      )}
      {data?.configured && data.queues.length === 0 && (
        <div className="empty-table-state">
          <ListOrdered size={48} strokeWidth={1} />
          <h3>{t('filasOpenWa.empty.title')}</h3>
          <p>{t('filasOpenWa.empty.description')}</p>
        </div>
      )}
      {data?.configured && data.queues.length > 0 && (
        <>
          <p className="openwa-queues-source">
            {data.source === 'bull-board' ? t('filasOpenWa.sourceBullBoard') : t('filasOpenWa.sourceInfraStatus')}
          </p>
          <div className="queue-stats">
            <div className="stats-row">
              {data.queues.map(q => (
                <div className="queue-stat-card" key={q.name}>
                  <h4>{q.name}</h4>
                  <div className="stat-values">
                    <div className="stat-item pending">
                      <span className="value">{q.counts.pending}</span>
                      <span className="label">{t('filasOpenWa.pending')}</span>
                    </div>
                    <div className="stat-item completed">
                      <span className="value">{q.counts.completed.toLocaleString()}</span>
                      <span className="label">{t('filasOpenWa.completed')}</span>
                    </div>
                    <div className="stat-item failed">
                      <span className="value">{q.counts.failed}</span>
                      <span className="label">{t('filasOpenWa.failed')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
