import { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  createCoreRowModel,
  columnVisibilityFeature,
  flexRender,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import {
  Plus,
  Copy,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  Check,
  KeyRound,
  AlertTriangle,
  AlertCircle,
  Pencil,
} from 'lucide-react';
import type { ApiKey } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useDeleteApiKeyMutation,
  useRevokeApiKeyMutation,
  useSessionsQuery,
  useUpdateApiKeyMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { SessionScopePicker } from '../components/SessionScopePicker';
import { useToast } from '../hooks/useToast';
import { copyToClipboard } from '../utils/clipboard';
import { canScopeSessions, sameSessionScope, sessionScopeNames } from '../utils/sessionScope';
import './ApiKeys.css';

const roleNames = ['admin', 'operator', 'companion_operator', 'viewer'] as const;

const emptyKeyForm = { name: '', role: 'operator', allowedSessions: [] as string[] };

function useWindowSize() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return width;
}

const features = tableFeatures({
  columnVisibilityFeature,
  coreRowModel: createCoreRowModel(),
});

const columnHelper = createColumnHelper<typeof features, ApiKey>();

export function ApiKeys() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('apiKeys.title'));
  const { data: apiKeys = [], isLoading: loading, isError: apiKeysError } = useApiKeysQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const createMutation = useCreateApiKeyMutation();
  const updateMutation = useUpdateApiKeyMutation();
  const deleteMutation = useDeleteApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState(emptyKeyForm);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editSessions, setEditSessions] = useState<string[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'revoke'; id: string; name: string } | null>(
    null,
  );

  const windowWidth = useWindowSize();
  const isMobile = windowWidth < 768;
  const isSmall = windowWidth < 640;
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ key: !isSmall, lastUsed: !isMobile });
  }, [isMobile, isSmall]);

  const closeCreateModal = () => {
    setShowModal(false);
    setCreatedKey(null);
    setNewKey(emptyKeyForm);
  };

  const handleCreate = async () => {
    if (!newKey.name) return;
    try {
      const created = await createMutation.mutateAsync({
        name: newKey.name,
        role: newKey.role,
        ...(canScopeSessions(newKey.role) ? { allowedSessions: newKey.allowedSessions } : {}),
      });
      setCreatedKey(created.apiKey || null);
      setNewKey(emptyKeyForm);
    } catch (err) {
      console.error('Failed to create:', err);
      toast.error(t('apiKeys.createBtn'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const openEditSessions = (apiKey: ApiKey) => {
    setEditingKey(apiKey);
    setEditSessions(apiKey.allowedSessions ?? []);
  };

  const handleSaveSessions = async () => {
    if (!editingKey) return;
    // An unchanged Save must not be sent. The server writes `allowedSessions` whenever the field is
    // present, and storing [] over a key that was never scoped reads back as an authorization
    // change: it drops every live /events socket holding that key and writes an audit row saying
    // the scope moved when it did not.
    if (sameSessionScope(editSessions, editingKey.allowedSessions ?? [])) {
      setEditingKey(null);
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: editingKey.id,
        data: { allowedSessions: editSessions },
      });
      setEditingKey(null);
    } catch (err) {
      console.error('Failed to update sessions:', err);
      toast.error(t('apiKeys.sessions.editTitle'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to revoke:', err);
      toast.error(t('apiKeys.actions.revoke'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to delete:', err);
      toast.error(t('apiKeys.actions.delete'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const confirmAndExecute = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'delete') handleDelete(confirmAction.id);
    else handleRevoke(confirmAction.id);
    setConfirmAction(null);
  };

  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = async (text: string, id: string) => {
    if (await copyToClipboard(text)) {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('name', {
          header: () => t('apiKeys.columns.name'),
          cell: info => <span className="name-cell">{info.getValue()}</span>,
        }),
        columnHelper.accessor('keyPrefix', {
          id: 'key',
          header: () => t('apiKeys.columns.key'),
          cell: info => {
            const apiKey = info.row.original;
            return (
              <span className="key-cell">
                <code>{visibleKeys.has(apiKey.id) ? apiKey.keyPrefix + '...' : apiKey.keyPrefix + '****'}</code>
                <button
                  className="icon-btn-sm"
                  onClick={() => toggleKeyVisibility(apiKey.id)}
                  aria-label={visibleKeys.has(apiKey.id) ? t('common.hideApiKey') : t('common.showApiKey')}
                >
                  {visibleKeys.has(apiKey.id) ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            );
          },
        }),
        columnHelper.accessor('role', {
          header: () => t('apiKeys.columns.role'),
          cell: info => <span className="permission-badge">{info.getValue()}</span>,
        }),
        columnHelper.accessor('allowedSessions', {
          id: 'sessions',
          header: () => t('apiKeys.columns.sessions'),
          cell: info => {
            const names = sessionScopeNames(info.getValue(), sessions);
            if (!names) {
              return <span className="sessions-cell all">{t('apiKeys.sessions.all')}</span>;
            }
            if (names.length <= 2) {
              return <span className="sessions-cell">{names.join(', ')}</span>;
            }
            return <span className="sessions-cell">{t('apiKeys.sessions.restricted', { count: names.length })}</span>;
          },
        }),
        columnHelper.accessor('isActive', {
          header: () => t('apiKeys.columns.status'),
          cell: info => (
            <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
              {info.getValue() ? t('apiKeys.statuses.active') : t('apiKeys.statuses.revoked')}
            </span>
          ),
        }),
        columnHelper.accessor('lastUsedAt', {
          id: 'lastUsed',
          header: () => t('apiKeys.columns.lastUsed'),
          cell: info => (
            <span className="last-used">
              {info.getValue() ? new Date(info.getValue()!).toLocaleDateString() : t('common.never')}
            </span>
          ),
        }),
        columnHelper.display({
          id: 'actions',
          header: () => t('apiKeys.columns.actions'),
          cell: info => {
            const apiKey = info.row.original;
            return (
              <span className="actions-cell">
                {/* No per-row copy: the full key only exists once (post-creation modal); the row
                    only has the prefix, so a copy button here could only copy a useless fragment. */}
                {canScopeSessions(apiKey.role) && apiKey.isActive && (
                  <button
                    className="icon-btn"
                    onClick={() => openEditSessions(apiKey)}
                    title={t('apiKeys.actions.editSessions')}
                  >
                    <Pencil size={16} />
                  </button>
                )}
                {apiKey.isActive && (
                  <button
                    className="icon-btn"
                    onClick={() => setConfirmAction({ type: 'revoke', id: apiKey.id, name: apiKey.name })}
                    title={t('apiKeys.actions.revoke')}
                  >
                    <RefreshCw size={16} />
                  </button>
                )}
                <button
                  className="icon-btn danger"
                  onClick={() => setConfirmAction({ type: 'delete', id: apiKey.id, name: apiKey.name })}
                  title={t('apiKeys.actions.delete')}
                >
                  <Trash2 size={16} />
                </button>
              </span>
            );
          },
        }),
      ]),
    [visibleKeys, t, sessions],
  );

  const table = useTable({
    features,
    data: apiKeys,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
  });

  if (loading) {
    return (
      <div
        className="api-keys-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <PageHeader
        title={t('apiKeys.title')}
        subtitle={t('apiKeys.subtitle')}
        actions={
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={18} />
            {t('apiKeys.createBtn')}
          </button>
        }
      />

      {apiKeysError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      {showModal && (
        <Modal
          open
          onClose={closeCreateModal}
          title={createdKey ? t('apiKeys.createdTitle') : t('apiKeys.modalTitle')}
          closeLabel={t('common.close')}
          footer={
            !createdKey ? (
              <>
                <button className="btn-secondary" onClick={closeCreateModal}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleCreate}
                  disabled={createMutation.isPending || !newKey.name}
                >
                  {createMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
                </button>
              </>
            ) : undefined
          }
        >
          {createdKey ? (
            <div>
              <p style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>{t('apiKeys.createdHint')}</p>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <code
                  style={{
                    flex: 1,
                    padding: '0.75rem',
                    background: 'var(--bg-secondary)',
                    borderRadius: '6px',
                    wordBreak: 'break-all',
                  }}
                >
                  {createdKey}
                </code>
                <button className="btn-primary" onClick={() => void handleCopy(createdKey, 'modal')}>
                  {copied === 'modal' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="ak-1">{t('common.name')}</label>
              <input
                id="ak-1"
                type="text"
                placeholder={t('apiKeys.namePlaceholder')}
                value={newKey.name}
                onChange={e => setNewKey({ ...newKey, name: e.target.value })}
              />
              <label htmlFor="ak-2">{t('common.role')}</label>
              <select
                id="ak-2"
                value={newKey.role}
                onChange={e =>
                  setNewKey({
                    ...newKey,
                    role: e.target.value,
                    allowedSessions: canScopeSessions(e.target.value) ? newKey.allowedSessions : [],
                  })
                }
              >
                {roleNames.map(r => (
                  <option key={r} value={r}>
                    {t(`apiKeys.roles.${r}`)}
                  </option>
                ))}
              </select>
              {canScopeSessions(newKey.role) && (
                <SessionScopePicker
                  sessions={sessions}
                  selectedIds={newKey.allowedSessions}
                  onChange={ids => setNewKey({ ...newKey, allowedSessions: ids })}
                  disabled={createMutation.isPending}
                />
              )}
            </>
          )}
        </Modal>
      )}

      {editingKey && (
        <Modal
          open
          onClose={() => setEditingKey(null)}
          title={t('apiKeys.sessions.editTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setEditingKey(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void handleSaveSessions()}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('apiKeys.sessions.save')}
              </button>
            </>
          }
        >
          <p className="session-scope-edit-name">
            <strong>{editingKey.name}</strong>
          </p>
          <SessionScopePicker
            sessions={sessions}
            selectedIds={editSessions}
            onChange={setEditSessions}
            disabled={updateMutation.isPending}
          />
        </Modal>
      )}

      <div className="api-keys-content">
        <div className="keys-table-container">
          {apiKeys.length === 0 ? (
            <div className="empty-table-state">
              <KeyRound size={48} strokeWidth={1} />
              <h3>{t('apiKeys.empty.title')}</h3>
              <p>{t('apiKeys.empty.description')}</p>
            </div>
          ) : (
            <table className="keys-table">
              <thead>
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id} className="table-row header">
                    {headerGroup.headers.map(header => (
                      <th key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="table-row">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="permissions-reference">
          <h3>{t('apiKeys.rolesTitle')}</h3>
          <div className="permissions-list">
            {roleNames.map(r => (
              <div key={r} className="perm-item">
                <code>{r}</code>
                <span>{t(`apiKeys.roleDescriptions.${r}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirmAction && (
        <Modal
          open
          onClose={() => setConfirmAction(null)}
          title={confirmAction.type === 'delete' ? t('apiKeys.confirm.deleteTitle') : t('apiKeys.confirm.revokeTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={confirmAndExecute}>
                {confirmAction.type === 'delete' ? t('apiKeys.confirm.delete') : t('apiKeys.confirm.revoke')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey={
                confirmAction.type === 'delete' ? 'apiKeys.confirm.deleteMessage' : 'apiKeys.confirm.revokeMessage'
              }
              values={{ name: confirmAction.name }}
              components={{ strong: <strong /> }}
            />
          </p>
        </Modal>
      )}
    </div>
  );
}
