import { useTranslation } from 'react-i18next';
import { ListOrdered } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageHeader } from '../components/PageHeader';
import './OpenWaQueues.css';

/**
 * Placeholder while Filas OpenWA migrates from the counter-card UI to an
 * embedded Bull Board (`/api/admin/queues`) inside main-content.
 * Menu, route, and companion_operator allowlist stay intact.
 */
export function OpenWaQueues() {
  const { t } = useTranslation();
  useDocumentTitle(t('filasOpenWa.title'));

  return (
    <div className="openwa-queues-page">
      <PageHeader title={t('filasOpenWa.title')} subtitle={t('filasOpenWa.subtitle')} />
      <div className="empty-table-state" role="status">
        <ListOrdered size={48} strokeWidth={1} />
        <h3>{t('filasOpenWa.migrating.title')}</h3>
        <p>{t('filasOpenWa.migrating.description')}</p>
      </div>
    </div>
  );
}
