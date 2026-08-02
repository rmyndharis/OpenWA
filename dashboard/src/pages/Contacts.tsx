import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Edit, Trash2, X, Users, AlertCircle, Ban, Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks';
import { useToast } from '../components/useToast';
import { PageHeader } from '../components/PageHeader';
import { useSessionsQuery, useContactsQuery, useUpsertContactMutation, useRemoveContactMutation } from '../hooks/queries';
import type { Contact } from '../services/api';
import './Contacts.css';

function errorMessage(err: unknown): string {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 501) return 'not-supported';
  return err instanceof Error ? err.message : 'unknown';
}

export function Contacts() {
  const { t } = useTranslation();
  useDocumentTitle(t('contacts.title'));
  const toast = useToast();
  const { canWrite } = useRole();

  const { data: sessions = [] } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const activeSessionId = sessionId || sessions[0]?.id || '';
  const { data: contacts = [], isLoading, isError } = useContactsQuery(activeSessionId, !!activeSessionId);
  const upsertMutation = useUpsertContactMutation();
  const removeMutation = useRemoveContactMutation();

  const [search, setSearch] = useState('');
  const [editTarget, setEditTarget] = useState<Contact | { id: ''; name?: string } | null>(null);
  const [editForm, setEditForm] = useState({ fullName: '', firstName: '' });
  const [newContactId, setNewContactId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      c =>
        c.id.toLowerCase().includes(q) ||
        c.name?.toLowerCase().includes(q) ||
        c.pushName?.toLowerCase().includes(q) ||
        c.number.toLowerCase().includes(q),
    );
  }, [contacts, search]);

  const openAdd = () => {
    setNewContactId('');
    setEditForm({ fullName: '', firstName: '' });
    setEditTarget({ id: '' });
  };

  const openEdit = (contact: Contact) => {
    setEditForm({ fullName: contact.name || '', firstName: '' });
    setEditTarget(contact);
  };

  const closeEdit = () => setEditTarget(null);

  const handleSave = async () => {
    const contactId = editTarget?.id || newContactId.trim();
    if (!contactId || !activeSessionId) return;
    try {
      await upsertMutation.mutateAsync({
        sessionId: activeSessionId,
        contactId,
        data: { fullName: editForm.fullName || undefined, firstName: editForm.firstName || undefined },
      });
      toast.success(t('contacts.toasts.saved'));
      closeEdit();
    } catch (err) {
      const kind = errorMessage(err);
      toast.error(
        t('contacts.toasts.saveFailed'),
        kind === 'not-supported' ? t('contacts.notSupported') : kind,
      );
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || !activeSessionId) return;
    try {
      await removeMutation.mutateAsync({ sessionId: activeSessionId, contactId: deleteTarget.id });
      toast.success(t('contacts.toasts.removed'));
      setDeleteTarget(null);
    } catch (err) {
      const kind = errorMessage(err);
      toast.error(
        t('contacts.toasts.removeFailed'),
        kind === 'not-supported' ? t('contacts.notSupported') : kind,
      );
    }
  };

  return (
    <div className="contacts-page">
      <PageHeader
        title={t('contacts.title')}
        subtitle={t('contacts.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={openAdd} disabled={!activeSessionId}>
              <Users size={18} />
              {t('contacts.addContact')}
            </button>
          )
        }
      />

      <div className="contacts-toolbar">
        <select value={activeSessionId} onChange={e => setSessionId(e.target.value)}>
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="contacts-search">
          <Search size={16} />
          <input
            type="text"
            placeholder={t('contacts.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isError && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.loadError')}</span>
        </div>
      )}

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-table-state">
          <Users size={48} strokeWidth={1} />
          <h3>{t('contacts.empty.title')}</h3>
          <p>{t('contacts.empty.description')}</p>
        </div>
      ) : (
        <div className="contacts-list">
          {filtered.map(contact => (
            <div key={contact.id} className="contact-row">
              <div className="contact-info">
                <span className="contact-name">{contact.name || contact.pushName || contact.number}</span>
                <span className="contact-id">{contact.id}</span>
              </div>
              <div className="contact-badges">
                {contact.isBlocked && (
                  <span className="status-badge blocked">
                    <Ban size={12} /> {t('contacts.blocked')}
                  </span>
                )}
                {contact.isMyContact && <span className="status-badge saved">{t('contacts.saved')}</span>}
              </div>
              {canWrite && (
                <div className="contact-actions">
                  <button className="icon-btn" title={t('contacts.actions.edit')} onClick={() => openEdit(contact)}>
                    <Edit size={16} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title={t('contacts.actions.remove')}
                    onClick={() => setDeleteTarget(contact)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editTarget && (
        <div className="modal-overlay" onClick={closeEdit}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editTarget.id ? t('contacts.editTitle') : t('contacts.addTitle')}</h2>
              <button className="btn-icon" onClick={closeEdit}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {!editTarget.id && (
                <>
                  <label>{t('contacts.contactId')}</label>
                  <input
                    type="text"
                    placeholder="628123456789@c.us"
                    value={newContactId}
                    onChange={e => setNewContactId(e.target.value)}
                  />
                </>
              )}
              <label>{t('contacts.fullName')}</label>
              <input
                type="text"
                value={editForm.fullName}
                onChange={e => setEditForm({ ...editForm, fullName: e.target.value })}
              />
              <label>{t('contacts.firstName')}</label>
              <input
                type="text"
                value={editForm.firstName}
                onChange={e => setEditForm({ ...editForm, firstName: e.target.value })}
              />
              <p className="contacts-hint">{t('contacts.notSupportedHint')}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeEdit}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleSave}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('contacts.removeTitle')}</h2>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('contacts.removeConfirm', { name: deleteTarget.name || deleteTarget.id })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
