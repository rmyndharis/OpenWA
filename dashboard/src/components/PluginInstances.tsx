import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Check, RefreshCw, Pencil, Trash2, X, Loader2, Power, AlertTriangle } from 'lucide-react';
import type { InstanceView, MintedInstance } from '../services/api';
import {
  usePluginInstancesQuery,
  useCreateInstanceMutation,
  useRegenerateInstanceSecretMutation,
  useUpdateInstanceMutation,
  useDeleteInstanceMutation,
} from '../hooks/queries';
import { isValidInstanceId, parseInstanceConfig } from '../utils/instanceForm';
import { copyToClipboard } from '../utils/clipboard';
import { useToast } from './Toast';
import './PluginInstances.css';

const emptyForm = { instanceId: '', sessionScope: '', verifyToken: '', config: '' };

export function PluginInstances({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data: instances = [], isLoading, isError } = usePluginInstancesQuery(pluginId, true);
  const createM = useCreateInstanceMutation(pluginId);
  const regenM = useRegenerateInstanceSecretMutation(pluginId);
  const updateM = useUpdateInstanceMutation(pluginId);
  const deleteM = useDeleteInstanceMutation(pluginId);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedInstance | null>(null); // secret-shown-once view
  const [mintedKind, setMintedKind] = useState<'created' | 'regenerated'>('created');
  const [editing, setEditing] = useState<InstanceView | null>(null);
  const [editForm, setEditForm] = useState({ sessionScope: '', config: '' });
  const [editError, setEditError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'delete' | 'regenerate'; inst: InstanceView } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, id: string) => {
    if (await copyToClipboard(text)) {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setShowForm(true);
  };

  const submitCreate = async () => {
    if (!isValidInstanceId(form.instanceId)) {
      setFormError(t('plugins.instances.errors.invalidId'));
      return;
    }
    const parsed = parseInstanceConfig(form.config);
    if (!parsed.ok) {
      setFormError(t('plugins.instances.errors.invalidJson'));
      return;
    }
    try {
      const created = await createM.mutateAsync({
        instanceId: form.instanceId,
        sessionScope: form.sessionScope.trim() || undefined,
        verifyToken: form.verifyToken.trim() || undefined,
        config: parsed.value,
      });
      setShowForm(false);
      setForm(emptyForm);
      setMintedKind('created');
      setMinted(created);
      toast.success(t('plugins.instances.toasts.created'), created.instanceId);
    } catch (err) {
      const e = err as Error & { status?: number };
      setFormError(e.status === 409 ? t('plugins.instances.errors.duplicateId') : e.message);
    }
  };

  const toggleEnabled = async (inst: InstanceView) => {
    try {
      await updateM.mutateAsync({ instanceId: inst.instanceId, body: { enabled: !inst.enabled } });
      toast.success(t('plugins.instances.toasts.updated'), inst.instanceId);
    } catch (err) {
      toast.error(t('plugins.instances.toasts.actionFailed'), (err as Error).message);
    }
  };

  const openEdit = (inst: InstanceView) => {
    setEditing(inst);
    setEditForm({
      sessionScope: inst.sessionScope ?? '',
      config: inst.config ? JSON.stringify(inst.config, null, 2) : '',
    });
    setEditError(null);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const parsed = parseInstanceConfig(editForm.config);
    if (!parsed.ok) {
      setEditError(t('plugins.instances.errors.invalidJson'));
      return;
    }
    try {
      await updateM.mutateAsync({
        instanceId: editing.instanceId,
        // Blank → omit (leave scope unchanged); mirrors create. Sending '' would corrupt an
        // all-sessions (null) instance into a literal empty scope the backend never clears.
        body: { sessionScope: editForm.sessionScope.trim() || undefined, config: parsed.value ?? {} },
      });
      setEditing(null);
      toast.success(t('plugins.instances.toasts.updated'), editing.instanceId);
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { type, inst } = confirm;
    setConfirm(null);
    try {
      if (type === 'delete') {
        await deleteM.mutateAsync(inst.instanceId);
        toast.success(t('plugins.instances.toasts.deleted'), inst.instanceId);
      } else {
        const res = await regenM.mutateAsync(inst.instanceId);
        setMintedKind('regenerated');
        setMinted(res);
        toast.success(t('plugins.instances.toasts.secretRegenerated'), inst.instanceId);
      }
    } catch (err) {
      toast.error(t('plugins.instances.toasts.actionFailed'), (err as Error).message);
    }
  };

  return (
    <div className="plugin-instances">
      <div className="pi-header">
        <p className="pi-desc">{t('plugins.instances.description')}</p>
        <button className="btn-primary" onClick={openCreate}>
          <Plus size={16} />
          {t('plugins.instances.create')}
        </button>
      </div>

      {isLoading ? (
        <div className="pi-loading">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : isError ? (
        <p className="pi-error">{t('plugins.instances.loadError')}</p>
      ) : instances.length === 0 ? (
        <p className="pi-empty">{t('plugins.instances.empty')}</p>
      ) : (
        <div className="pi-list">
          {instances.map(inst => (
            <div key={inst.id} className="pi-row">
              <div className="pi-main">
                <span className="pi-id">{inst.instanceId}</span>
                <span className="pi-scope">{inst.sessionScope || t('plugins.instances.allSessions')}</span>
              </div>
              {inst.ingressUrls[0] && (
                <div className="pi-url">
                  <code title={inst.ingressUrls[0].url}>{inst.ingressUrls[0].url}</code>
                  <button
                    className="icon-btn-sm"
                    onClick={() => void copy(inst.ingressUrls[0].url, `url-${inst.id}`)}
                    title={t('plugins.instances.actions.copy')}
                  >
                    {copied === `url-${inst.id}` ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
              <span className={`pi-badge ${inst.enabled ? 'on' : 'off'}`}>
                {inst.enabled ? t('plugins.instances.enabled') : t('plugins.instances.disabled')}
              </span>
              <div className="pi-actions">
                <button className="icon-btn" onClick={() => void toggleEnabled(inst)} title={t(`plugins.instances.actions.${inst.enabled ? 'disable' : 'enable'}`)}>
                  <Power size={16} />
                </button>
                <button className="icon-btn" onClick={() => setConfirm({ type: 'regenerate', inst })} title={t('plugins.instances.actions.regenerate')}>
                  <RefreshCw size={16} />
                </button>
                <button className="icon-btn" onClick={() => openEdit(inst)} title={t('plugins.instances.actions.edit')}>
                  <Pencil size={16} />
                </button>
                <button className="icon-btn danger" onClick={() => setConfirm({ type: 'delete', inst })} title={t('plugins.instances.actions.delete')}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal — form, or the secret-shown-once view after mint */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.instances.create')}</h2>
              <button className="btn-icon" onClick={() => setShowForm(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body plugin-instances">
              <label>{t('plugins.instances.form.instanceId')}</label>
              <input
                type="text"
                value={form.instanceId}
                placeholder={t('plugins.instances.form.instanceIdPlaceholder')}
                onChange={e => setForm({ ...form, instanceId: e.target.value })}
              />
              <p className="pi-hint">{t('plugins.instances.form.instanceIdHint')}</p>
              <label>{t('plugins.instances.form.sessionScope')}</label>
              <input
                type="text"
                value={form.sessionScope}
                placeholder={t('plugins.instances.form.sessionScopePlaceholder')}
                onChange={e => setForm({ ...form, sessionScope: e.target.value })}
              />
              <label>{t('plugins.instances.form.verifyToken')}</label>
              <input
                type="text"
                value={form.verifyToken}
                placeholder={t('plugins.instances.form.verifyTokenPlaceholder')}
                onChange={e => setForm({ ...form, verifyToken: e.target.value })}
              />
              <label>{t('plugins.instances.form.config')}</label>
              <textarea
                value={form.config}
                placeholder={t('plugins.instances.form.configPlaceholder')}
                onChange={e => setForm({ ...form, config: e.target.value })}
              />
              {formError && <p className="pi-error">{formError}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowForm(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void submitCreate()} disabled={createM.isPending || !form.instanceId}>
                {createM.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secret-shown-once modal (after create or regenerate) */}
      {minted && (
        <div className="modal-overlay" onClick={() => setMinted(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {mintedKind === 'regenerated'
                  ? t('plugins.instances.regenerate.title')
                  : t('plugins.instances.created.title')}
              </h2>
              <button className="btn-icon" onClick={() => setMinted(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body plugin-instances">
              <p className="pi-hint">{t('plugins.instances.created.hint')}</p>
              <label>{t('plugins.instances.created.secret')}</label>
              <div className="pi-secret">
                <code>{minted.secret}</code>
                <button className="btn-primary" onClick={() => void copy(minted.secret, 'secret')}>
                  {copied === 'secret' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
              <label>{t('plugins.instances.created.ingressUrls')}</label>
              {minted.ingressUrls.map(u => (
                <div key={u.route} className="pi-secret">
                  <code>{u.url}</code>
                  <button className="btn-primary" onClick={() => void copy(u.url, `mint-${u.route}`)}>
                    {copied === `mint-${u.route}` ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setMinted(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal — sessionScope + config */}
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('plugins.instances.edit.title', { id: editing.instanceId })}</h2>
              <button className="btn-icon" onClick={() => setEditing(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body plugin-instances">
              <label>{t('plugins.instances.form.sessionScope')}</label>
              <input
                type="text"
                value={editForm.sessionScope}
                placeholder={t('plugins.instances.form.sessionScopePlaceholder')}
                onChange={e => setEditForm({ ...editForm, sessionScope: e.target.value })}
              />
              <label>{t('plugins.instances.form.config')}</label>
              <textarea
                value={editForm.config}
                placeholder={t('plugins.instances.form.configPlaceholder')}
                onChange={e => setEditForm({ ...editForm, config: e.target.value })}
              />
              {editError && <p className="pi-error">{editError}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void submitEdit()} disabled={updateM.isPending}>
                {updateM.isPending ? <Loader2 className="animate-spin" size={16} /> : t('plugins.instances.actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal — delete or regenerate */}
      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t(`plugins.instances.${confirm.type}.title`)}</h2>
              <button className="btn-icon" onClick={() => setConfirm(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body plugin-instances">
              <div className="pi-confirm-icon">
                <AlertTriangle size={40} />
              </div>
              <p>{t(`plugins.instances.${confirm.type}.confirm`, { id: confirm.inst.instanceId })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button
                className={confirm.type === 'delete' ? 'btn-danger' : 'btn-primary'}
                onClick={() => void runConfirm()}
              >
                {t(`plugins.instances.${confirm.type}.action`)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
