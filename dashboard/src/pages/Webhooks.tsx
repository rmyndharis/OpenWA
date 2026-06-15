import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Edit,
  Trash2,
  Play,
  ExternalLink,
  Loader2,
  X,
  Webhook as WebhookIcon,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { webhookApi, type Webhook } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useWebhooksQuery,
  useSessionsQuery,
  useCreateWebhookMutation,
  useUpdateWebhookMutation,
  useDeleteWebhookMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Webhooks.css';

// Must stay aligned with the backend WEBHOOK_EVENTS: the API now rejects unknown
// event names, so offering e.g. the never-emitted 'session.connected' would 400 on save.
const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'group.join',
  'group.leave',
  'group.update',
  '*',
] as const;

export function Webhooks() {
  const { t } = useTranslation();
  useDocumentTitle(t('webhooks.title'));
  const { canWrite } = useRole();
  const { data: webhooks = [], isLoading: loadingWebhooks } = useWebhooksQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const loading = loadingWebhooks;
  const createMutation = useCreateWebhookMutation();
  const updateMutation = useUpdateWebhookMutation();
  const deleteMutation = useDeleteWebhookMutation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; id: string; url: string } | null>(null);
  const [editWebhook, setEditWebhook] = useState<Webhook | null>(null);
  const [newWebhook, setNewWebhook] = useState({ url: '', events: ['message.received'], sessionId: '' });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const eventDescription = (name: string) => {
    if (name === '*') return t('webhooks.eventDescriptions.all');
    return t(`webhooks.eventDescriptions.${name}`, { defaultValue: name });
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleCreate = async () => {
    if (!newWebhook.url || !newWebhook.sessionId) return;
    try {
      await createMutation.mutateAsync({
        sessionId: newWebhook.sessionId,
        url: newWebhook.url,
        events: newWebhook.events,
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '' });
      setToast({ type: 'success', message: t('webhooks.toasts.created') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const confirmDelete = (sessionId: string, id: string, url: string) => {
    setDeleteTarget({ sessionId, id, url });
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: deleteTarget.sessionId, id: deleteTarget.id });
      setShowDeleteModal(false);
      setDeleteTarget(null);
      setToast({ type: 'success', message: t('webhooks.toasts.deleted') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const handleTest = async (sessionId: string, id: string) => {
    setTestingId(id);
    try {
      const result = await webhookApi.test(sessionId, id);
      if (result.success) {
        setToast({ type: 'success', message: t('webhooks.toasts.testOk', { status: result.statusCode }) });
      } else {
        setToast({
          type: 'error',
          message: t('webhooks.toasts.testFailed', { message: result.error || `Status ${result.statusCode}` }),
        });
      }
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.testError', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    } finally {
      setTestingId(null);
    }
  };

  const openEdit = (webhook: Webhook) => {
    setEditWebhook({ ...webhook });
    setShowEditModal(true);
  };

  const handleEdit = async () => {
    if (!editWebhook) return;
    try {
      await updateMutation.mutateAsync({
        sessionId: editWebhook.sessionId,
        id: editWebhook.id,
        data: { url: editWebhook.url, events: editWebhook.events, active: editWebhook.active },
      });
      setShowEditModal(false);
      setEditWebhook(null);
      setToast({ type: 'success', message: t('webhooks.toasts.updated') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.updateFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const toggleEditEvent = (event: string) => {
    if (!editWebhook) return;
    setEditWebhook({
      ...editWebhook,
      events: editWebhook.events.includes(event)
        ? editWebhook.events.filter(e => e !== event)
        : [...editWebhook.events, event],
    });
  };

  const toggleNewEvent = (event: string) => {
    setNewWebhook(prev => ({
      ...prev,
      events: prev.events.includes(event) ? prev.events.filter(e => e !== event) : [...prev.events, event],
    }));
  };

  if (loading) {
    return (
      <div
        className="webhooks-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="webhooks-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('webhooks.addWebhook')}
            </button>
          )
        }
      />

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.createTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowCreateModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('webhooks.session')}</label>
              <select
                value={newWebhook.sessionId}
                onChange={e => setNewWebhook({ ...newWebhook, sessionId: e.target.value })}
              >
                <option value="">{t('webhooks.selectSession')}</option>
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label>{t('common.url')}</label>
              <input
                type="url"
                placeholder="https://..."
                value={newWebhook.url}
                onChange={e => setNewWebhook({ ...newWebhook, url: e.target.value })}
              />
              <label>{t('webhooks.events')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {availableEventNames.map(name => (
                  <button
                    key={name}
                    type="button"
                    className={`event-tag ${newWebhook.events.includes(name) ? 'selected' : ''}`}
                    onClick={() => toggleNewEvent(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleCreate}>
                {t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && editWebhook && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.editTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowEditModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('common.url')}</label>
              <input
                type="url"
                value={editWebhook.url}
                onChange={e => setEditWebhook({ ...editWebhook, url: e.target.value })}
              />
              <label>{t('webhooks.events')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {availableEventNames.map(name => (
                  <button
                    key={name}
                    type="button"
                    className={`event-tag ${editWebhook.events.includes(name) ? 'selected' : ''}`}
                    onClick={() => toggleEditEvent(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="toggle-group">
                <span className="toggle-label">{t('common.status')}</span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={editWebhook.active}
                    onChange={e => setEditWebhook({ ...editWebhook, active: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span className={`toggle-status ${editWebhook.active ? 'active' : 'inactive'}`}>
                  {editWebhook.active ? t('common.active') : t('common.inactive')}
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowEditModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleEdit}>
                {t('webhooks.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && deleteTarget && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.deleteTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowDeleteModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('webhooks.deleteConfirm')}</p>
              <code
                style={{
                  display: 'block',
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  background: 'var(--color-bg-secondary)',
                  borderRadius: '4px',
                  fontSize: '0.85rem',
                  wordBreak: 'break-all',
                }}
              >
                {deleteTarget.url}
              </code>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowDeleteModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="webhooks-content">
        <div className="webhooks-list-container">
          {webhooks.length === 0 ? (
            <div className="empty-table-state">
              <WebhookIcon size={48} strokeWidth={1} />
              <h3>{t('webhooks.empty.title')}</h3>
              <p>{t('webhooks.empty.description')}</p>
            </div>
          ) : (
            <div className="webhooks-card-list">
              {webhooks.map(webhook => {
                const sessionName = sessions.find(s => s.id === webhook.sessionId)?.name || webhook.sessionId.substring(0, 12);
                return (
                  <div key={webhook.id} className="webhook-card">
                    <div className="webhook-card-header">
                      <div className="webhook-url-row">
                        <ExternalLink size={16} className="webhook-url-icon" />
                        <code className="webhook-url">{webhook.url}</code>
                      </div>
                      <div className="webhook-card-actions">
                        <button
                          className="icon-btn"
                          title={t('webhooks.actions.test')}
                          onClick={() => handleTest(webhook.sessionId, webhook.id)}
                          disabled={testingId === webhook.id}
                        >
                          {testingId === webhook.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                        </button>
                        {canWrite && (
                          <>
                            <button className="icon-btn" title={t('webhooks.actions.edit')} onClick={() => openEdit(webhook)}>
                              <Edit size={16} />
                            </button>
                            <button
                              className="icon-btn danger"
                              title={t('webhooks.actions.delete')}
                              onClick={() => confirmDelete(webhook.sessionId, webhook.id, webhook.url)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="webhook-card-body">
                      <div className="webhook-meta">
                        <div className="webhook-meta-item">
                          <span className="webhook-meta-label">{t('webhooks.columns.session')}</span>
                          <span className="webhook-meta-value">{sessionName}</span>
                        </div>
                        <div className="webhook-meta-item">
                          <span className="webhook-meta-label">{t('webhooks.columns.status')}</span>
                          <span className={`status-badge ${webhook.active ? 'active' : 'inactive'}`}>
                            {webhook.active ? t('common.active') : t('common.inactive')}
                          </span>
                        </div>
                      </div>
                      <div className="webhook-events">
                        <span className="webhook-meta-label">{t('webhooks.columns.events')}</span>
                        <div className="events-cell">
                          {webhook.events.map((event: string) => (
                            <span key={event} className="event-tag">
                              {event}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="events-reference">
          <h3>{t('webhooks.available')}</h3>
          <div className="events-list">
            {availableEventNames.map(name => (
              <div key={name} className="event-item">
                <code>{name}</code>
                <span>{eventDescription(name)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
