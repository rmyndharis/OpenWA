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
  AlertCircle,
  Filter,
} from 'lucide-react';
import { webhookApi, type Webhook, type WebhookFilters, type WebhookFilterCondition } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useWebhooksQuery,
  useSessionsQuery,
  useSessionChatsQuery,
  useCreateWebhookMutation,
  useUpdateWebhookMutation,
  useDeleteWebhookMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { FilterBuilder } from '../components/FilterBuilder';
import './Webhooks.css';

// Filters only apply to message.* events (the wildcard subscribes to them too).
const supportsFilters = (events: string[]) => events.some(e => e === '*' || e.startsWith('message.'));

type TFn = ReturnType<typeof useTranslation>['t'];

// One-line, human-readable summary of a condition for the badge popover, reusing the FilterBuilder labels.
function conditionSummary(c: WebhookFilterCondition, t: TFn): string {
  const field = t(`webhooks.filters.fields.${c.field}`, { defaultValue: c.field });
  const operator = t(`webhooks.filters.operators.${c.operator}`, { defaultValue: c.operator });
  let value: string;
  if (typeof c.value === 'boolean') {
    value = c.value ? t('webhooks.filters.yes') : t('webhooks.filters.no');
  } else if (Array.isArray(c.value)) {
    value = c.value.join(', ');
  } else {
    value = `"${c.value}"`;
  }
  const caseNote = c.caseSensitive ? ` · ${t('webhooks.filters.caseSensitive')}` : '';
  return `${field} ${operator} ${value}${caseNote}`;
}

// Filters badge with a hover/focus popover listing the configured conditions. The popover is
// fixed-positioned from the badge's rect so the card's `overflow: hidden` doesn't clip it.
function FilterBadge({ filters }: { filters: WebhookFilters }) {
  const { t } = useTranslation();
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 6, left: r.left });
  };
  const close = () => setCoords(null);

  return (
    <span
      className="filter-badge filter-badge-interactive"
      tabIndex={0}
      onMouseEnter={e => openAt(e.currentTarget)}
      onMouseLeave={close}
      onFocus={e => openAt(e.currentTarget)}
      onBlur={close}
    >
      <Filter size={12} />
      {t('webhooks.filters.badge', { count: filters.conditions.length })}
      {coords && (
        <div className="filter-popover" style={{ top: coords.top, left: coords.left }} role="tooltip">
          <div className="filter-popover-title">{t('webhooks.filters.title')}</div>
          {filters.conditions.map((condition, i) => (
            <div key={i} className="filter-popover-row">
              {conditionSummary(condition, t)}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// Must stay aligned with the backend WEBHOOK_EVENTS: the API now rejects unknown
// event names, so offering e.g. the never-emitted 'session.connected' would 400 on save.
const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.reaction',
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
  const { data: webhooks = [], isLoading: loadingWebhooks, isError: webhooksError } = useWebhooksQuery();
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
  const [newWebhook, setNewWebhook] = useState<{
    url: string;
    events: string[];
    sessionId: string;
    filters: WebhookFilters | null;
  }>({ url: '', events: ['message.received'], sessionId: '', filters: null });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Single source for the contact/group autocomplete in whichever modal is open.
  const activeSessionId = showEditModal ? editWebhook?.sessionId ?? '' : newWebhook.sessionId;
  const { data: chats = [] } = useSessionChatsQuery(activeSessionId, showCreateModal || showEditModal);

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
        // Don't persist message-filters when no message events are selected (the filter UI is hidden).
        filters: supportsFilters(newWebhook.events) ? newWebhook.filters : null,
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '', filters: null });
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
        data: {
          url: editWebhook.url,
          events: editWebhook.events,
          active: editWebhook.active,
          // Clear message-filters if the edit removed all message events (the filter UI is hidden then).
          filters: supportsFilters(editWebhook.events) ? (editWebhook.filters ?? null) : null,
        },
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

      {webhooksError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

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
              <div className="event-tags">
                {availableEventNames.map(name => {
                  const isSelected = newWebhook.events.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`event-tag ${isSelected ? 'selected' : ''}`}
                      onClick={() => toggleNewEvent(name)}
                    >
                      {isSelected && <Check size={12} className="tag-check-icon" />}
                      {name}
                    </button>
                  );
                })}
              </div>
              {supportsFilters(newWebhook.events) && (
                <FilterBuilder
                  filters={newWebhook.filters}
                  onChange={filters => setNewWebhook(prev => ({ ...prev, filters }))}
                  chats={chats}
                />
              )}
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
              <div className="event-tags">
                {availableEventNames.map(name => {
                  const isSelected = editWebhook.events.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`event-tag ${isSelected ? 'selected' : ''}`}
                      onClick={() => toggleEditEvent(name)}
                    >
                      {isSelected && <Check size={12} className="tag-check-icon" />}
                      {name}
                    </button>
                  );
                })}
              </div>
              {supportsFilters(editWebhook.events) && (
                <FilterBuilder
                  filters={editWebhook.filters}
                  onChange={filters => setEditWebhook(prev => (prev ? { ...prev, filters } : prev))}
                  chats={chats}
                />
              )}
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
                          {webhook.filters?.conditions?.length ? <FilterBadge filters={webhook.filters} /> : null}
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
