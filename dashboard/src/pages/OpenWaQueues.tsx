import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import { queuesBoardSessionApi } from '../services/api';
import './OpenWaQueues.css';

/**
 * Filas OpenWA embeds Bull Board (`/api/admin/queues`) in main-content after
 * minting an HttpOnly board-session cookie (no `?apiKey` in the iframe URL).
 */
export function OpenWaQueues() {
  const { t } = useTranslation();
  useDocumentTitle(t('filasOpenWa.title'));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void queuesBoardSessionApi
      .mint()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="openwa-queues-page openwa-queues-page--embed">
      <PageHeader title={t('filasOpenWa.title')} subtitle={t('filasOpenWa.subtitle')} />
      {error && (
        <div className="error-banner" role="alert">
          {t('filasOpenWa.embedError')}
        </div>
      )}
      {!ready && !error && <p role="status">{t('filasOpenWa.embedLoading')}</p>}
      {ready && (
        <iframe
          className="openwa-queues-board-frame"
          title={t('filasOpenWa.title')}
          src="/api/admin/queues"
        />
      )}
    </div>
  );
}
