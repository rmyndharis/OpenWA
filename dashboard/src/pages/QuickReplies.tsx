import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit, Trash2, X, Zap, Info } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks';
import { useToast } from '../components/useToast';
import { PageHeader } from '../components/PageHeader';
import { useSessionsQuery, useUpsertQuickReplyMutation, useRemoveQuickReplyMutation } from '../hooks/queries';
import { useLocalQuickReplies, type LocalQuickReply } from '../hooks/useLocalQuickReplies';
import './QuickReplies.css';

function errorMessage(err: unknown): string {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 501) return 'not-supported';
  return err instanceof Error ? err.message : 'unknown';
}

export function QuickReplies() {
  const { t } = useTranslation();
  useDocumentTitle(t('quickReplies.title'));
  const toast = useToast();
  const { canWrite } = useRole();

  const { data: sessions = [] } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const activeSessionId = sessionId || sessions[0]?.id || '';
  const { items, save, remove } = useLocalQuickReplies(activeSessionId);

  const upsertMutation = useUpsertQuickReplyMutation();
  const removeMutation = useRemoveQuickReplyMutation();

  const [editTarget, setEditTarget] = useState<LocalQuickReply | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ shortcut: '', message: '', keywords: '' });
  const [deleteTarget, setDeleteTarget] = useState<LocalQuickReply | null>(null);

  const openCreate = () => {
    setEditTarget(null);
    setForm({ shortcut: '', message: '', keywords: '' });
    setShowModal(true);
  };

  const openEdit = (qr: LocalQuickReply) => {
    setEditTarget(qr);
    setForm({ shortcut: qr.shortcut, message: qr.message, keywords: qr.keywords.join(', ') });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.shortcut || !form.message || !activeSessionId) return;
    const keywords = form.keywords
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    try {
      const result = await upsertMutation.mutateAsync({
        sessionId: activeSessionId,
        data: { id: editTarget?.id, shortcut: form.shortcut, message: form.message, keywords },
      });
      save({ id: result.id, shortcut: form.shortcut, message: form.message, keywords });
      toast.success(t('quickReplies.toasts.saved'));
      setShowModal(false);
    } catch (err) {
      const kind = errorMessage(err);
      toast.error(
        t('quickReplies.toasts.saveFailed'),
        kind === 'not-supported' ? t('quickReplies.notSupported') : kind,
      );
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || !activeSessionId) return;
    try {
      await removeMutation.mutateAsync({ sessionId: activeSessionId, id: deleteTarget.id });
      remove(deleteTarget.id);
      toast.success(t('quickReplies.toasts.removed'));
      setDeleteTarget(null);
    } catch (err) {
      const kind = errorMessage(err);
      toast.error(
        t('quickReplies.toasts.removeFailed'),
        kind === 'not-supported' ? t('quickReplies.notSupported') : kind,
      );
    }
  };

  return (
    <div className="quick-replies-page">
      <PageHeader
        title={t('quickReplies.title')}
        subtitle={t('quickReplies.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={openCreate} disabled={!activeSessionId}>
              <Plus size={18} />
              {t('quickReplies.addQuickReply')}
            </button>
          )
        }
      />

      <div className="quick-replies-toolbar">
        <select value={activeSessionId} onChange={e => setSessionId(e.target.value)}>
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="quick-replies-info-banner">
        <Info size={16} />
        <span>{t('quickReplies.localTrackingNotice')}</span>
      </div>

      {items.length === 0 ? (
        <div className="empty-table-state">
          <Zap size={48} strokeWidth={1} />
          <h3>{t('quickReplies.empty.title')}</h3>
          <p>{t('quickReplies.empty.description')}</p>
        </div>
      ) : (
        <div className="quick-replies-list">
          {items.map(qr => (
            <div key={qr.id} className="quick-reply-card">
              <div className="quick-reply-header">
                <code className="quick-reply-shortcut">{qr.shortcut}</code>
                {canWrite && (
                  <div className="quick-reply-actions">
                    <button className="icon-btn" title={t('quickReplies.actions.edit')} onClick={() => openEdit(qr)}>
                      <Edit size={16} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title={t('quickReplies.actions.remove')}
                      onClick={() => setDeleteTarget(qr)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </div>
              <p className="quick-reply-message">{qr.message}</p>
              {qr.keywords.length > 0 && (
                <div className="quick-reply-keywords">
                  {qr.keywords.map(k => (
                    <span key={k} className="keyword-tag">
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editTarget ? t('quickReplies.editTitle') : t('quickReplies.createTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('quickReplies.shortcut')}</label>
              <input
                type="text"
                placeholder="/hi"
                value={form.shortcut}
                onChange={e => setForm({ ...form, shortcut: e.target.value })}
              />
              <label>{t('quickReplies.message')}</label>
              <textarea
                rows={4}
                value={form.message}
                onChange={e => setForm({ ...form, message: e.target.value })}
              />
              <label>{t('quickReplies.keywords')}</label>
              <input
                type="text"
                placeholder={t('quickReplies.keywordsPlaceholder')}
                value={form.keywords}
                onChange={e => setForm({ ...form, keywords: e.target.value })}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowModal(false)}>
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
              <h2>{t('quickReplies.removeTitle')}</h2>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('quickReplies.removeConfirm', { shortcut: deleteTarget.shortcut })}</p>
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
