import { useState, useEffect, useMemo, useRef, type RefObject } from 'react';
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
import {
  apiKeyDraft,
  apiKeyPatch,
  canScopeSessions,
  invalidChatEntry,
  invalidIpEntry,
  isExpired,
  normalizeChatScope,
  parseScopeList,
  sameSessionScope,
  sessionScopeNames,
  type ApiKeyDraft,
} from '../utils/sessionScope';
import './ApiKeys.css';

const roleNames = ['admin', 'operator', 'viewer'] as const;

const emptyKeyForm = { name: '', role: 'operator', allowedSessions: [] as string[], ips: '', chats: '', expires: '' };

// The key this dashboard signed in with: the list only carries each key's prefix, which is the first
// 12 characters of the raw key.
function isSignedInKey(apiKey: ApiKey): boolean {
  return !!apiKey.keyPrefix && !!sessionStorage.getItem('openwa_api_key')?.startsWith(apiKey.keyPrefix);
}

// The first IP or chat line the gateway would refuse, so the form can name it instead of the bare
// "Bad Request" a production gateway answers with. On an edit, a list left as stored is not sent (see
// apiKeyPatch), so an entry saved before the gateway checked it does not block an unrelated change.
function limitErrors(
  role: string,
  ips: string,
  chats: string,
  stored?: Pick<ApiKey, 'allowedIps' | 'allowedChats'>,
): { ip: string | null; chat: string | null } {
  const ipList = parseScopeList(ips);
  const chatList = normalizeChatScope(chats);
  const unchanged = (list: string[], storedList: string[] | undefined) =>
    !!stored && sameSessionScope(list, storedList ?? []);
  return {
    ip: unchanged(ipList, stored?.allowedIps) ? null : invalidIpEntry(ipList),
    chat: !canScopeSessions(role) || unchanged(chatList, stored?.allowedChats) ? null : invalidChatEntry(chatList),
  };
}

// IP, chat and expiry limits shared by the create and edit modals. Chats are offered only where
// sessions are: admin keys stay unscoped in the dashboard.
function KeyLimitFields({
  idPrefix,
  role,
  ips,
  chats,
  expires,
  errors,
  onChange,
  disabled,
  expiresRef,
}: {
  idPrefix: string;
  role: string;
  ips: string;
  chats: string;
  expires: string;
  errors: { ip: string | null; chat: string | null };
  onChange: (patch: { ips?: string; chats?: string; expires?: string }) => void;
  disabled?: boolean;
  expiresRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  // A datetime-local with a blank segment reports value '', like an empty field, so only badInput says
  // there are leftover segments to clear.
  const [partialExpiry, setPartialExpiry] = useState(false);
  return (
    <>
      <label htmlFor={`${idPrefix}-ips`}>{t('apiKeys.ips.label')}</label>
      <textarea
        id={`${idPrefix}-ips`}
        rows={2}
        spellCheck={false}
        value={ips}
        disabled={disabled}
        onChange={e => onChange({ ips: e.target.value })}
      />
      {errors.ip !== null && (
        <span className="key-field-hint error" role="alert">
          {t('apiKeys.ips.invalid', { value: errors.ip })}
        </span>
      )}
      <span className="key-field-hint">{t('apiKeys.ips.hint')}</span>
      {canScopeSessions(role) && (
        <>
          <label htmlFor={`${idPrefix}-chats`}>{t('apiKeys.chats.label')}</label>
          <textarea
            id={`${idPrefix}-chats`}
            rows={2}
            spellCheck={false}
            value={chats}
            disabled={disabled}
            onChange={e => onChange({ chats: e.target.value })}
          />
          {errors.chat !== null && (
            <span className="key-field-hint error" role="alert">
              {t('apiKeys.chats.invalid', { value: errors.chat })}
            </span>
          )}
          <span className="key-field-hint">{t('apiKeys.chats.hint')}</span>
        </>
      )}
      <label htmlFor={`${idPrefix}-expires`}>{t('apiKeys.expiry.label')}</label>
      <div className="key-expiry-row">
        <input
          id={`${idPrefix}-expires`}
          ref={expiresRef}
          type="datetime-local"
          max="9999-12-31T23:59"
          value={expires}
          disabled={disabled}
          onChange={e => {
            setPartialExpiry(e.target.validity.badInput);
            onChange({ expires: e.target.value });
          }}
          // A partial date typed into an empty field leaves the value at '' and fires no change, so
          // badInput is read again when focus leaves the field (clicking Create or Save does that).
          onBlur={e => setPartialExpiry(e.currentTarget.validity.badInput)}
        />
        {(expires || partialExpiry) && (
          <button
            type="button"
            className="btn-secondary"
            disabled={disabled}
            onClick={() => {
              // With the state already '', React writes nothing to the input, so the segments are
              // wiped here.
              if (expiresRef.current) expiresRef.current.value = '';
              setPartialExpiry(false);
              onChange({ expires: '' });
            }}
          >
            {t('apiKeys.expiry.clear')}
          </button>
        )}
      </div>
      <span className="key-field-hint">{t('apiKeys.expiry.hint')}</span>
    </>
  );
}

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
  const { data: apiKeys = [], isLoading: loading, error: apiKeysError } = useApiKeysQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const createMutation = useCreateApiKeyMutation();
  const updateMutation = useUpdateApiKeyMutation();
  const deleteMutation = useDeleteApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState(emptyKeyForm);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editDraft, setEditDraft] = useState<ApiKeyDraft | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'revoke'; id: string; name: string } | null>(
    null,
  );

  const windowWidth = useWindowSize();
  const isMobile = windowWidth < 768;
  const isSmall = windowWidth < 640;
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ key: !isSmall, lastUsed: !isMobile, restrictions: !isMobile });
  }, [isMobile, isSmall]);

  const closeCreateModal = () => {
    setShowModal(false);
    setCreatedKey(null);
    setNewKey(emptyKeyForm);
  };

  // A datetime-local with a blank segment reports an empty value, the same as no expiry at all, and
  // fires no change while it stays incomplete. Only the input's own validity tells the two apart. It
  // also flags a year past the max, which new Date() cannot parse.
  const newExpiresRef = useRef<HTMLInputElement>(null);
  const editExpiresRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    if (!canCreate) return;
    if (newExpiresRef.current && !newExpiresRef.current.validity.valid) {
      toast.error(t('apiKeys.createBtn'), t('apiKeys.expiry.invalid'));
      return;
    }
    const scoped = canScopeSessions(newKey.role);
    const allowedIps = parseScopeList(newKey.ips);
    const allowedChats = scoped ? normalizeChatScope(newKey.chats) : [];
    try {
      const created = await createMutation.mutateAsync({
        name: newKey.name,
        role: newKey.role,
        ...(scoped ? { allowedSessions: newKey.allowedSessions } : {}),
        ...(allowedIps.length > 0 ? { allowedIps } : {}),
        ...(allowedChats.length > 0 ? { allowedChats } : {}),
        ...(newKey.expires ? { expiresAt: new Date(newKey.expires).toISOString() } : {}),
      });
      setCreatedKey(created.apiKey || null);
      setNewKey(emptyKeyForm);
    } catch (err) {
      console.error('Failed to create:', err);
      toast.error(t('apiKeys.createBtn'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const openEdit = (apiKey: ApiKey) => {
    setEditingKey(apiKey);
    setEditDraft(apiKeyDraft(apiKey));
  };

  const closeEdit = () => {
    setEditingKey(null);
    setEditDraft(null);
  };

  const handleSave = async () => {
    if (!editingKey || !editDraft || !canSave) return;
    if (editExpiresRef.current && !editExpiresRef.current.validity.valid) {
      toast.error(t('apiKeys.edit.title'), t('apiKeys.expiry.invalid'));
      return;
    }
    try {
      // An unchanged Save is not sent at all (see apiKeyPatch).
      const data = apiKeyPatch(editingKey, editDraft);
      if (Object.keys(data).length === 0) {
        closeEdit();
        return;
      }
      await updateMutation.mutateAsync({ id: editingKey.id, data });
      closeEdit();
    } catch (err) {
      console.error('Failed to update key:', err);
      toast.error(t('apiKeys.edit.title'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const newErrors = limitErrors(newKey.role, newKey.ips, newKey.chats);
  const editErrors =
    editDraft && editingKey ? limitErrors(editDraft.role, editDraft.ips, editDraft.chats, editingKey) : null;
  // The gateway requires a name of at least 3 characters.
  const canCreate =
    !createMutation.isPending && newKey.name.trim().length >= 3 && newErrors.ip === null && newErrors.chat === null;
  const canSave = !updateMutation.isPending && editErrors?.ip === null && editErrors.chat === null;

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
          // The list carries only the prefix: the full key exists once, in the post-creation modal.
          cell: info => (
            <span className="key-cell">
              <code>{info.getValue()}****</code>
            </span>
          ),
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
        columnHelper.display({
          id: 'restrictions',
          header: () => t('apiKeys.columns.restrictions'),
          cell: info => {
            const { allowedIps, allowedChats, expiresAt } = info.row.original;
            const badges = [];
            if (allowedIps?.length) {
              badges.push(
                <span key="ips" className="restriction-badge" title={allowedIps.join('\n')}>
                  {t('apiKeys.restrictions.ips', { count: allowedIps.length })}
                </span>,
              );
            }
            if (allowedChats?.length) {
              badges.push(
                <span key="chats" className="restriction-badge" title={allowedChats.join('\n')}>
                  {t('apiKeys.restrictions.chats', { count: allowedChats.length })}
                </span>,
              );
            }
            if (expiresAt) {
              const date = new Date(expiresAt).toLocaleString();
              badges.push(
                <span key="expiry" className={`restriction-badge ${isExpired(expiresAt) ? 'expired' : ''}`}>
                  {isExpired(expiresAt)
                    ? t('apiKeys.restrictions.expired', { date })
                    : t('apiKeys.restrictions.expires', { date })}
                </span>,
              );
            }
            return badges.length > 0 ? (
              <span className="restrictions-cell">{badges}</span>
            ) : (
              <span className="restrictions-cell none">{t('apiKeys.restrictions.none')}</span>
            );
          },
        }),
        columnHelper.accessor('isActive', {
          header: () => t('apiKeys.columns.status'),
          cell: info => {
            // A revoked key reads as revoked; an active one past its expiry is refused just the same.
            const status = !info.getValue() ? 'revoked' : isExpired(info.row.original.expiresAt) ? 'expired' : 'active';
            return (
              <span className={`status-badge ${status === 'active' ? 'active' : 'inactive'}`}>
                {t(`apiKeys.statuses.${status}`)}
              </span>
            );
          },
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
                {apiKey.isActive && (
                  <button className="icon-btn" onClick={() => openEdit(apiKey)} title={t('apiKeys.actions.edit')}>
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
    [t, sessions],
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

      {apiKeysError && apiKeys.length > 0 && (
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
                <button className="btn-primary" onClick={handleCreate} disabled={!canCreate}>
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
              {newKey.name.length > 0 && newKey.name.trim().length < 3 && (
                <span className="key-field-hint">{t('apiKeys.nameTooShort')}</span>
              )}
              <label htmlFor="ak-2">{t('common.role')}</label>
              <select
                id="ak-2"
                value={newKey.role}
                onChange={e =>
                  setNewKey({
                    ...newKey,
                    role: e.target.value,
                    allowedSessions: canScopeSessions(e.target.value) ? newKey.allowedSessions : [],
                    chats: canScopeSessions(e.target.value) ? newKey.chats : '',
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
              <KeyLimitFields
                idPrefix="ak-new"
                role={newKey.role}
                ips={newKey.ips}
                chats={newKey.chats}
                expires={newKey.expires}
                errors={newErrors}
                onChange={patch => setNewKey(prev => ({ ...prev, ...patch }))}
                disabled={createMutation.isPending}
                expiresRef={newExpiresRef}
              />
            </>
          )}
        </Modal>
      )}

      {editingKey && editDraft && (
        <Modal
          open
          onClose={closeEdit}
          title={t('apiKeys.edit.title')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeEdit}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleSave()} disabled={!canSave}>
                {updateMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('apiKeys.sessions.save')}
              </button>
            </>
          }
        >
          <p className="session-scope-edit-name">
            <strong>{editingKey.name}</strong>
          </p>
          {isSignedInKey(editingKey) && (
            <p className="key-signed-in-warning" role="note">
              <AlertTriangle size={16} />
              {t('apiKeys.edit.signedIn')}
            </p>
          )}
          <label htmlFor="ak-edit-role">{t('common.role')}</label>
          <select
            id="ak-edit-role"
            value={editDraft.role}
            disabled={updateMutation.isPending}
            onChange={e => setEditDraft({ ...editDraft, role: e.target.value })}
          >
            {roleNames.map(r => (
              <option key={r} value={r}>
                {t(`apiKeys.roles.${r}`)}
              </option>
            ))}
          </select>
          {canScopeSessions(editDraft.role) && (
            <SessionScopePicker
              sessions={sessions}
              selectedIds={editDraft.sessions}
              onChange={ids => setEditDraft({ ...editDraft, sessions: ids })}
              disabled={updateMutation.isPending}
            />
          )}
          <KeyLimitFields
            idPrefix="ak-edit"
            role={editDraft.role}
            ips={editDraft.ips}
            chats={editDraft.chats}
            expires={editDraft.expires}
            errors={editErrors ?? { ip: null, chat: null }}
            onChange={patch => setEditDraft(prev => (prev ? { ...prev, ...patch } : prev))}
            disabled={updateMutation.isPending}
            expiresRef={editExpiresRef}
          />
        </Modal>
      )}

      <div className="api-keys-content">
        <div className="keys-table-container">
          {apiKeysError && apiKeys.length === 0 ? (
            // A failed read is not an empty list: an admin key restricted to sessions always gets 403
            // here (the route needs an unscoped key), and "No API keys created" would read as a gateway
            // with no keys at all.
            <div className="empty-table-state" role="alert">
              <AlertCircle size={48} strokeWidth={1} />
              {(apiKeysError as { status?: number }).status === 403 ? (
                <>
                  <h3>{t('apiKeys.empty.forbiddenTitle')}</h3>
                  <p>{t('apiKeys.empty.forbiddenDesc')}</p>
                </>
              ) : (
                <>
                  <h3>{t('apiKeys.empty.loadErrorTitle')}</h3>
                  <p>{apiKeysError.message}</p>
                </>
              )}
            </div>
          ) : apiKeys.length === 0 ? (
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
