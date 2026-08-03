import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, FileText, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { type MessageTemplate, type TemplatePayload } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useCreateTemplateMutation,
  useDeleteTemplateMutation,
  useSessionsQuery,
  useTemplatesQuery,
  useUpdateTemplateMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { copyToClipboard } from '../utils/clipboard';
import './Templates.css';

type TemplateForm = {
  name: string;
  header: string;
  body: string;
  footer: string;
};

const emptyForm: TemplateForm = {
  name: '',
  header: '',
  body: '',
  footer: '',
};

function extractPlaceholders(template: TemplateForm | MessageTemplate) {
  const source = [template.header, template.body, template.footer].filter(Boolean).join('\n');
  return Array.from(new Set(Array.from(source.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g), match => match[1]))).sort();
}

function toPayload(form: TemplateForm): TemplatePayload {
  return {
    name: form.name.trim(),
    header: form.header.trim() || null,
    body: form.body.trim(),
    footer: form.footer.trim() || null,
  };
}

function renderPreview(template: TemplateForm, values: Record<string, string>) {
  return [template.header, template.body, template.footer]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] || `{{${key}}}`);
}

export function Templates() {
  const { t } = useTranslation();
  useDocumentTitle(t('templates.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');

  const { data: templates = [], isLoading: loadingTemplates } = useTemplatesQuery(
    selectedSessionId,
    !!selectedSessionId,
  );
  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const placeholders = useMemo(() => extractPlaceholders(form), [form]);
  const preview = useMemo(() => renderPreview(form, previewValues), [form, previewValues]);
  const filteredTemplates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter(template =>
      [template.name, template.header, template.body, template.footer]
        .filter(Boolean)
        .some(value => value!.toLowerCase().includes(query)),
    );
  }, [searchTerm, templates]);
  const isSaving = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setPreviewValues(current => {
      const next: Record<string, string> = {};
      for (const key of placeholders) {
        next[key] = current[key] || '';
      }
      return next;
    });
  }, [placeholders]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTemplate(null);
    setPreviewValues({});
  };

  const openEdit = (template: MessageTemplate) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      header: template.header || '',
      body: template.body,
      footer: template.footer || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSave = async () => {
    if (!selectedSessionId || !form.name.trim() || !form.body.trim()) return;

    try {
      if (editingTemplate) {
        await updateMutation.mutateAsync({
          sessionId: selectedSessionId,
          id: editingTemplate.id,
          data: toPayload(form),
        });
        setToast({ type: 'success', message: t('templates.toasts.updated') });
      } else {
        await createMutation.mutateAsync({
          sessionId: selectedSessionId,
          data: toPayload(form),
        });
        setToast({ type: 'success', message: t('templates.toasts.created') });
      }
      resetForm();
    } catch (err) {
      setToast({
        type: 'error',
        message: t(editingTemplate ? 'templates.toasts.updateFailed' : 'templates.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId || !deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      setToast({ type: 'success', message: t('templates.toasts.deleted') });
      if (editingTemplate?.id === deleteTarget.id) resetForm();
      setDeleteTarget(null);
    } catch (err) {
      setToast({
        type: 'error',
        message: t('templates.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const copyName = async (name: string) => {
    if (await copyToClipboard(name)) {
      setToast({ type: 'success', message: t('templates.toasts.copied') });
    }
  };

  if (loadingSessions) {
    return (
      <div className="templates-page templates-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="templates-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('templates.title')}
        subtitle={t('templates.subtitle')}
        actions={
          <select
            className="templates-session-select"
            value={selectedSessionId}
            onChange={event => {
              setSelectedSessionId(event.target.value);
              resetForm();
            }}
          >
            {sessions.length === 0 && <option value="">{t('templates.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {sessions.length === 0 ? (
        <div className="templates-empty-page">
          <FileText size={48} strokeWidth={1} />
          <h3>{t('templates.empty.noSessionsTitle')}</h3>
          <p>{t('templates.empty.noSessionsDesc')}</p>
        </div>
      ) : (
        <div className="templates-workspace">
          <aside className="templates-library">
            <div className="templates-library-header">
              <div>
                <h2>{t('templates.savedTitle')}</h2>
                <span>{t('templates.count', { count: templates.length })}</span>
              </div>
              <button className="btn-primary templates-new-btn" onClick={resetForm} disabled={!canWrite}>
                <Plus size={16} />
                {t('templates.newTemplate')}
              </button>
            </div>

            <div className="templates-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder={t('common.search')}
              />
            </div>

            {loadingTemplates ? (
              <div className="templates-loading-inline">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : templates.length === 0 ? (
              <div className="templates-empty-list">
                <FileText size={40} strokeWidth={1} />
                <h3>{t('templates.empty.title')}</h3>
                <p>{t('templates.empty.description')}</p>
              </div>
            ) : filteredTemplates.length === 0 ? (
              <div className="templates-empty-list compact">
                <Search size={32} strokeWidth={1.5} />
                <h3>{t('templates.empty.title')}</h3>
              </div>
            ) : (
              <div className="template-list" role="list">
                {filteredTemplates.map(template => {
                  const templatePlaceholders = extractPlaceholders(template);
                  const isSelected = editingTemplate?.id === template.id;
                  return (
                    <button
                      key={template.id}
                      className={`template-list-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => openEdit(template)}
                      type="button"
                    >
                      <span className="template-list-title">{template.name}</span>
                      <span className="template-list-body">{template.body}</span>
                      <span className="template-list-meta">
                        {templatePlaceholders.length > 0
                          ? templatePlaceholders.map(key => `{{${key}}}`).join(' ')
                          : t('templates.noPlaceholders')}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <section className="template-editor">
            <div className="template-editor-header">
              <div>
                <h2>{editingTemplate ? t('templates.editTitle') : t('templates.createTitle')}</h2>
                <p>{selectedSession ? t('templates.sessionHint', { name: selectedSession.name }) : ''}</p>
              </div>
              <div className="template-header-actions">
                {editingTemplate && (
                  <button
                    className="icon-btn"
                    title={t('templates.actions.copyName')}
                    onClick={() => void copyName(editingTemplate.name)}
                    type="button"
                  >
                    <Copy size={16} />
                  </button>
                )}
                {editingTemplate && canWrite && (
                  <button
                    className="icon-btn danger"
                    title={t('common.delete')}
                    onClick={() => setDeleteTarget(editingTemplate)}
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>

            <div className="template-form">
              <div className="form-group">
                <label>{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder={t('templates.namePlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="template-message-fields">
                <div className="form-group">
                  <label>{t('templates.header')}</label>
                  <input
                    value={form.header}
                    onChange={event => setForm({ ...form, header: event.target.value })}
                    placeholder={t('templates.headerPlaceholder')}
                    disabled={!canWrite}
                  />
                </div>

                <div className="form-group body-field">
                  <label>{t('templates.body')}</label>
                  <textarea
                    value={form.body}
                    onChange={event => setForm({ ...form, body: event.target.value })}
                    placeholder={t('templates.bodyPlaceholder')}
                    rows={10}
                    disabled={!canWrite}
                  />
                </div>

                <div className="form-group">
                  <label>{t('templates.footer')}</label>
                  <input
                    value={form.footer}
                    onChange={event => setForm({ ...form, footer: event.target.value })}
                    placeholder={t('templates.footerPlaceholder')}
                    disabled={!canWrite}
                  />
                </div>
              </div>

              <div className="template-editor-actions">
                <button className="btn-secondary" onClick={resetForm} disabled={isSaving} type="button">
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={!canWrite || isSaving || !selectedSessionId || !form.name.trim() || !form.body.trim()}
                  type="button"
                >
                  {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  {canWrite
                    ? t(editingTemplate ? 'templates.saveChanges' : 'templates.createTemplate')
                    : t('templates.viewOnly')}
                </button>
              </div>
            </div>
          </section>

          <aside className="template-preview">
            <div className="template-preview-header">
              <h2>{t('templates.previewTitle')}</h2>
              <span>{placeholders.length}</span>
            </div>
            <div className="template-preview-message">
              <pre>{preview || t('templates.previewEmpty')}</pre>
            </div>
            <div className="template-variable-panel">
              {placeholders.length > 0 ? (
                <div className="placeholder-list">
                  {placeholders.map(key => (
                    <label key={key}>
                      <span>{`{{${key}}}`}</span>
                      <input
                        value={previewValues[key] || ''}
                        onChange={event => setPreviewValues({ ...previewValues, [key]: event.target.value })}
                        placeholder={t('templates.previewValuePlaceholder')}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="template-muted">{t('templates.noPlaceholders')}</p>
              )}
            </div>
          </aside>
        </div>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('templates.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('templates.deleteConfirm', { name: deleteTarget.name })}</p>
        </Modal>
      )}
    </div>
  );
}
