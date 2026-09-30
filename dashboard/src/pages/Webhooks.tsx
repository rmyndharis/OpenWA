import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Edit,
  Trash2,
  Play,
  ExternalLink,
  Loader2,
  Webhook as WebhookIcon,
  Check,
  AlertCircle,
  Filter,
  X,
} from 'lucide-react';
import { webhookApi, type Webhook, type WebhookFilters, type WebhookFilterCondition } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { availableEventNames } from '../utils/webhookEvents';
import { filterValueLabel } from '../utils/enumLabels';
import { buildHeaderMap, generateSecret, secretError, type HeaderRow } from '../utils/webhookAuth';
import { copyToClipboard } from '../utils/clipboard';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
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
import { Modal } from '../components/Modal';
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
    value = c.value.map(v => filterValueLabel(t, c.field, v)).join(', ');
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

// Name/value rows for the webhook's custom delivery headers. Values are plain text on purpose: a
// password field could be autofilled with the dashboard's own API key and sent to the receiver.
function HeaderRowsEditor({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <>
      {rows.map((row, index) => (
        <div key={index} className="filter-row header-row">
          <input
            type="text"
            aria-label={t('webhooks.auth.headerName')}
            placeholder={t('webhooks.auth.headerName')}
            autoComplete="off"
            spellCheck={false}
            value={row.name}
            onChange={e => update(index, { name: e.target.value })}
          />
          <input
            type="text"
            aria-label={t('webhooks.auth.headerValue')}
            placeholder={t('webhooks.auth.headerValue')}
            autoComplete="off"
            spellCheck={false}
            value={row.value}
            onChange={e => update(index, { value: e.target.value })}
          />
          <button
            type="button"
            className="filter-remove"
            title={t('webhooks.auth.removeHeader')}
            aria-label={t('webhooks.auth.removeHeader')}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <button type="button" className="filter-add" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        <Plus size={14} />
        {t('webhooks.auth.addHeader')}
      </button>
    </>
  );
}

// The secret input with Generate and Copy. The field stays a password input, so Copy is how a generated
// value reaches the receiver's configuration.
function SecretField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="secret-row">
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button type="button" className="btn-secondary" disabled={disabled} onClick={() => onChange(generateSecret())}>
        {t('webhooks.auth.generateSecret')}
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={disabled || !value}
        onClick={async () => {
          if (await copyToClipboard(value)) toast.success(t('webhooks.auth.secretCopied'));
        }}
      >
        {t('webhooks.auth.copySecret')}
      </button>
    </div>
  );
}

const emptyNewAuth = { secret: '', headers: [] as HeaderRow[] };
// The stored secret and headers are never returned, so an edit starts blank and sends neither unless
// the operator acts: leaving the section alone keeps whatever the webhook already has.
const emptyEditAuth = { secret: '', removeSecret: false, replaceHeaders: false, headers: [] as HeaderRow[] };

export function Webhooks() {
  const { t } = useTranslation();
  useDocumentTitle(t('webhooks.title'));
  const { canWrite } = useRole();
  const { data: webhooks = [], isLoading: loadingWebhooks, error: webhooksError } = useWebhooksQuery();
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
  const [newAuth, setNewAuth] = useState(emptyNewAuth);
  const [editAuth, setEditAuth] = useState(emptyEditAuth);
  const [testingId, setTestingId] = useState<string | null>(null);
  const toast = useToast();

  // Single source for the contact/group autocomplete in whichever modal is open.
  const activeSessionId = showEditModal ? (editWebhook?.sessionId ?? '') : newWebhook.sessionId;
  const { data: chats = [] } = useSessionChatsQuery(activeSessionId, showCreateModal || showEditModal);

  const eventDescription = (name: string) => {
    if (name === '*') return t('webhooks.eventDescriptions.all');
    return t(`webhooks.eventDescriptions.${name}`, { defaultValue: name });
  };

  // The gateway requires a URL and at least one event, so the buttons stay disabled until both are set
  // instead of surfacing the raw validation message in a toast.
  const newHeaders = buildHeaderMap(newAuth.headers);
  const newAuthError = secretError(newAuth.secret) ?? (newHeaders.ok ? null : newHeaders.error);
  const editHeaders = buildHeaderMap(editAuth.headers);
  const editAuthError =
    (editAuth.removeSecret ? null : secretError(editAuth.secret)) ??
    (editAuth.replaceHeaders && !editHeaders.ok ? editHeaders.error : null);
  const canCreate =
    !createMutation.isPending &&
    !!newWebhook.url.trim() &&
    !!newWebhook.sessionId &&
    newWebhook.events.length > 0 &&
    !newAuthError;
  const canSave =
    !!editWebhook &&
    !updateMutation.isPending &&
    !!editWebhook.url.trim() &&
    editWebhook.events.length > 0 &&
    !editAuthError;

  const handleCreate = async () => {
    // The gateway saves every create it receives, so a double click would register the webhook twice.
    if (!canCreate) return;
    try {
      await createMutation.mutateAsync({
        sessionId: newWebhook.sessionId,
        url: newWebhook.url,
        events: newWebhook.events,
        // Don't persist message-filters when no message events are selected (the filter UI is hidden).
        filters: supportsFilters(newWebhook.events) ? newWebhook.filters : null,
        // Both are optional: an empty secret would be refused (minimum 16), and no rows means no headers.
        ...(newAuth.secret ? { secret: newAuth.secret } : {}),
        ...(newHeaders.ok && Object.keys(newHeaders.headers).length > 0 ? { headers: newHeaders.headers } : {}),
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '', filters: null });
      setNewAuth(emptyNewAuth);
      toast.success(t('webhooks.toasts.created'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
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
      toast.success(t('webhooks.toasts.deleted'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleTest = async (sessionId: string, id: string) => {
    setTestingId(id);
    try {
      const result = await webhookApi.test(sessionId, id);
      if (result.success) {
        toast.success(t('webhooks.toasts.testOk', { status: result.statusCode }));
      } else {
        toast.error(t('webhooks.toasts.testFailed', { message: result.error || `Status ${result.statusCode}` }));
      }
    } catch (err) {
      toast.error(
        t('webhooks.toasts.testError', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    } finally {
      setTestingId(null);
    }
  };

  const openEdit = (webhook: Webhook) => {
    setEditWebhook({ ...webhook });
    setEditAuth(emptyEditAuth);
    setShowEditModal(true);
  };

  const handleEdit = async () => {
    if (!editWebhook || !canSave) return;
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
          // Only an explicit action touches the stored credentials: '' removes the secret, and
          // `headers` replaces the whole stored map ({} clears it).
          ...(editAuth.removeSecret ? { secret: '' } : editAuth.secret ? { secret: editAuth.secret } : {}),
          ...(editAuth.replaceHeaders && editHeaders.ok ? { headers: editHeaders.headers } : {}),
        },
      });
      setShowEditModal(false);
      setEditWebhook(null);
      setEditAuth(emptyEditAuth);
      toast.success(t('webhooks.toasts.updated'));
    } catch (err) {
      toast.error(
        t('webhooks.toasts.updateFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
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

      {/* With nothing cached the list area itself explains the failure; this banner covers a failed
          background refetch that keeps the cached list on screen. */}
      {webhooksError && webhooks.length > 0 && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      {showCreateModal && (
        <Modal
          open
          onClose={() => setShowCreateModal(false)}
          title={t('webhooks.createTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleCreate} disabled={!canCreate}>
                {t('common.create')}
              </button>
            </>
          }
        >
          <label htmlFor="wh-1">{t('webhooks.session')}</label>
          <select
            id="wh-1"
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
          <label htmlFor="wh-2">{t('common.url')}</label>
          <input
            id="wh-2"
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
          {newWebhook.events.length === 0 && (
            <span className="hint error" role="status">
              {t('webhooks.noEvents')}
            </span>
          )}
          {supportsFilters(newWebhook.events) && (
            <FilterBuilder
              filters={newWebhook.filters}
              onChange={filters => setNewWebhook(prev => ({ ...prev, filters }))}
              chats={chats}
            />
          )}
          <div className="filter-builder webhook-auth">
            <div className="filter-builder-head">
              <span className="filter-builder-title">{t('webhooks.auth.title')}</span>
              <span className="filter-builder-hint">{t('webhooks.auth.hint')}</span>
            </div>
            <label htmlFor="wh-secret">{t('webhooks.auth.secret')}</label>
            <SecretField
              id="wh-secret"
              value={newAuth.secret}
              onChange={secret => setNewAuth(prev => ({ ...prev, secret }))}
            />
            <span className="filter-builder-hint">{t('webhooks.auth.secretHint')}</span>
            <span className="filter-builder-title">{t('webhooks.auth.headers')}</span>
            <HeaderRowsEditor rows={newAuth.headers} onChange={headers => setNewAuth(prev => ({ ...prev, headers }))} />
            {newAuthError && (
              <span className="hint error" role="status">
                {t(newAuthError)}
              </span>
            )}
          </div>
        </Modal>
      )}

      {showEditModal && editWebhook && (
        <Modal
          open
          onClose={() => setShowEditModal(false)}
          title={t('webhooks.editTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowEditModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleEdit} disabled={!canSave}>
                {t('webhooks.saveChanges')}
              </button>
            </>
          }
        >
          <label htmlFor="wh-3">{t('common.url')}</label>
          <input
            id="wh-3"
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
          {editWebhook.events.length === 0 && (
            <span className="hint error" role="status">
              {t('webhooks.noEvents')}
            </span>
          )}
          {supportsFilters(editWebhook.events) && (
            <FilterBuilder
              filters={editWebhook.filters}
              onChange={filters => setEditWebhook(prev => (prev ? { ...prev, filters } : prev))}
              chats={chats}
            />
          )}
          <div className="filter-builder webhook-auth">
            <div className="filter-builder-head">
              <span className="filter-builder-title">{t('webhooks.auth.title')}</span>
              <span className="filter-builder-hint">{t('webhooks.auth.editHint')}</span>
            </div>
            <label htmlFor="wh-edit-secret">{t('webhooks.auth.secret')}</label>
            <SecretField
              id="wh-edit-secret"
              placeholder={t('webhooks.auth.secretKeepPlaceholder')}
              disabled={editAuth.removeSecret}
              value={editAuth.secret}
              onChange={secret => setEditAuth(prev => ({ ...prev, secret }))}
            />
            <label className="webhook-auth-check">
              <input
                type="checkbox"
                checked={editAuth.removeSecret}
                onChange={e => setEditAuth(prev => ({ ...prev, removeSecret: e.target.checked, secret: '' }))}
              />
              {t('webhooks.auth.removeSecret')}
            </label>
            <label className="webhook-auth-check">
              <input
                type="checkbox"
                checked={editAuth.replaceHeaders}
                onChange={e => setEditAuth(prev => ({ ...prev, replaceHeaders: e.target.checked }))}
              />
              {t('webhooks.auth.replaceHeaders')}
            </label>
            {editAuth.replaceHeaders && (
              <>
                <span className="filter-builder-hint">{t('webhooks.auth.replaceHint')}</span>
                <HeaderRowsEditor
                  rows={editAuth.headers}
                  onChange={headers => setEditAuth(prev => ({ ...prev, headers }))}
                />
              </>
            )}
            {editAuthError && (
              <span className="hint error" role="status">
                {t(editAuthError)}
              </span>
            )}
          </div>
          <div className="toggle-group">
            <span className="toggle-label" id="webhook-active-label">
              {t('common.status')}
            </span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-labelledby="webhook-active-label"
                checked={editWebhook.active}
                onChange={e => setEditWebhook({ ...editWebhook, active: e.target.checked })}
              />
              <span className="toggle-slider"></span>
            </label>
            <span className={`toggle-status ${editWebhook.active ? 'active' : 'inactive'}`}>
              {editWebhook.active ? t('common.active') : t('common.inactive')}
            </span>
          </div>
        </Modal>
      )}

      {showDeleteModal && deleteTarget && (
        <Modal
          open
          onClose={() => setShowDeleteModal(false)}
          title={t('webhooks.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowDeleteModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete}>
                {t('common.delete')}
              </button>
            </>
          }
        >
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
        </Modal>
      )}

      <div className="webhooks-content">
        <div className="webhooks-list-container">
          {webhooksError && webhooks.length === 0 ? (
            // A failed read is not an empty list: a viewer key always gets 403 here (the route is
            // OPERATOR-only), and a gateway error would otherwise read as "no webhooks configured".
            <div className="empty-table-state" role="alert">
              <AlertCircle size={48} strokeWidth={1} />
              {(webhooksError as { status?: number }).status === 403 ? (
                <>
                  <h3>{t('webhooks.empty.forbiddenTitle')}</h3>
                  <p>{t('webhooks.empty.forbiddenDesc')}</p>
                </>
              ) : (
                <>
                  <h3>{t('webhooks.empty.loadErrorTitle')}</h3>
                  <p>{webhooksError.message}</p>
                </>
              )}
            </div>
          ) : webhooks.length === 0 ? (
            <div className="empty-table-state">
              <WebhookIcon size={48} strokeWidth={1} />
              <h3>{t('webhooks.empty.title')}</h3>
              <p>{t('webhooks.empty.description')}</p>
            </div>
          ) : (
            <div className="webhooks-card-list">
              {webhooks.map(webhook => {
                const sessionName =
                  sessions.find(s => s.id === webhook.sessionId)?.name || webhook.sessionId.substring(0, 12);
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
                          {testingId === webhook.id ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <Play size={16} />
                          )}
                        </button>
                        {canWrite && (
                          <>
                            <button
                              className="icon-btn"
                              title={t('webhooks.actions.edit')}
                              onClick={() => openEdit(webhook)}
                            >
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
