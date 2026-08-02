import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Loader2, ShieldAlert, Shield } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks';
import { useToast } from '../components/useToast';
import { PageHeader } from '../components/PageHeader';
import {
  useSessionsQuery,
  usePrivacySettingsQuery,
  usePrivacyBlocklistQuery,
  useUpdatePrivacySettingsMutation,
  useResolvePhoneQuery,
} from '../hooks/queries';
import type { UpdatePrivacySettingsInput } from '../services/api';
import './Privacy.css';

type VisibilityField = 'lastSeen' | 'profilePicture' | 'status';
type FieldValue = string;

// Empirically-observed raw keys from Baileys' fetchPrivacySettings() response — undocumented, not a
// stable contract. Used only to pre-fill the form with the account's current values; if WhatsApp
// renames/adds keys, the affected field just falls back to "no change" instead of breaking.
const RAW_KEY: Record<string, string> = {
  lastSeen: 'last',
  online: 'online',
  profilePicture: 'profile',
  status: 'status',
  readReceipts: 'readreceipts',
  groupsAdd: 'groupadd',
  call: 'calladd',
  messages: 'messages',
};

const VISIBILITY_OPTIONS: FieldValue[] = ['all', 'contacts', 'contact_blacklist', 'none'];
const ONLINE_OPTIONS: FieldValue[] = ['all', 'match_last_seen'];
const GROUP_ADD_OPTIONS: FieldValue[] = ['all', 'contacts', 'contact_blacklist'];
const MESSAGES_OPTIONS: FieldValue[] = ['all', 'contacts'];
const CALL_OPTIONS: FieldValue[] = ['all', 'known'];
const READ_RECEIPTS_OPTIONS: FieldValue[] = ['all', 'none'];
const DISAPPEARING_OPTIONS = [0, 86400, 604800, 7776000];

const visibilityFields: VisibilityField[] = ['lastSeen', 'profilePicture', 'status'];

/** One blocklist row — resolves the raw JID (often an @lid) to a phone number, best-effort. */
function BlocklistEntry({ sessionId, contactId }: { sessionId: string; contactId: string }) {
  const { data, isLoading } = useResolvePhoneQuery(sessionId, contactId);
  const phone = data?.phone;
  return (
    <li>
      <span className="privacy-blocklist-id">{contactId}</span>
      {!isLoading && phone && <span className="privacy-blocklist-phone">+{phone}</span>}
    </li>
  );
}

export function Privacy() {
  const { t } = useTranslation();
  useDocumentTitle(t('privacy.title'));
  const toast = useToast();
  const { canWrite } = useRole();

  const { data: sessions = [] } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const activeSessionId = sessionId || sessions[0]?.id || '';

  const {
    data: settings,
    isLoading: loadingSettings,
    isError: settingsUnsupported,
  } = usePrivacySettingsQuery(activeSessionId, !!activeSessionId);
  const { data: blocklistData, isLoading: loadingBlocklist } = usePrivacyBlocklistQuery(
    activeSessionId,
    !!activeSessionId,
  );
  const updateMutation = useUpdatePrivacySettingsMutation();

  const [form, setForm] = useState<UpdatePrivacySettingsInput>({});

  // Pre-fill from the account's current settings once loaded — see RAW_KEY comment above.
  useEffect(() => {
    if (!settings) return;
    setForm({
      lastSeen: (settings[RAW_KEY.lastSeen] as UpdatePrivacySettingsInput['lastSeen']) || undefined,
      online: (settings[RAW_KEY.online] as UpdatePrivacySettingsInput['online']) || undefined,
      profilePicture: (settings[RAW_KEY.profilePicture] as UpdatePrivacySettingsInput['profilePicture']) || undefined,
      status: (settings[RAW_KEY.status] as UpdatePrivacySettingsInput['status']) || undefined,
      readReceipts: (settings[RAW_KEY.readReceipts] as UpdatePrivacySettingsInput['readReceipts']) || undefined,
      groupsAdd: (settings[RAW_KEY.groupsAdd] as UpdatePrivacySettingsInput['groupsAdd']) || undefined,
      call: (settings[RAW_KEY.call] as UpdatePrivacySettingsInput['call']) || undefined,
      messages: (settings[RAW_KEY.messages] as UpdatePrivacySettingsInput['messages']) || undefined,
    });
  }, [settings]);

  const handleSave = async () => {
    if (!activeSessionId) return;
    try {
      await updateMutation.mutateAsync({ sessionId: activeSessionId, data: form });
      toast.success(t('privacy.toasts.saved'));
    } catch (err) {
      const status = (err as { status?: number } | undefined)?.status;
      toast.error(
        t('privacy.toasts.saveFailed'),
        status === 501 ? t('privacy.notSupported') : err instanceof Error ? err.message : undefined,
      );
    }
  };

  const visibilityLabel = (field: VisibilityField) => t(`privacy.fields.${field}`);
  const optionLabel = (value: string) => t(`privacy.options.${value}`);

  return (
    <div className="privacy-page">
      <PageHeader title={t('privacy.title')} subtitle={t('privacy.subtitle')} />

      <div className="privacy-toolbar">
        <select value={activeSessionId} onChange={e => setSessionId(e.target.value)}>
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="privacy-grid">
        <div className="privacy-card">
          <div className="privacy-card-header">
            <Shield size={18} />
            <h3>{t('privacy.settingsTitle')}</h3>
          </div>

          {loadingSettings ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : settingsUnsupported ? (
            <div className="privacy-not-supported">
              <ShieldAlert size={18} />
              <span>{t('privacy.notSupported')}</span>
            </div>
          ) : (
            <>
              {visibilityFields.map(field => (
                <div className="privacy-field" key={field}>
                  <label>{visibilityLabel(field)}</label>
                  <select
                    value={form[field] || ''}
                    disabled={!canWrite}
                    onChange={e => setForm({ ...form, [field]: e.target.value || undefined })}
                  >
                    <option value="">{t('privacy.noChange')}</option>
                    {VISIBILITY_OPTIONS.map(opt => (
                      <option key={opt} value={opt}>
                        {optionLabel(opt)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <div className="privacy-field">
                <label>{t('privacy.fields.online')}</label>
                <select
                  value={form.online || ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({ ...form, online: (e.target.value || undefined) as UpdatePrivacySettingsInput['online'] })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {ONLINE_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {optionLabel(opt)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field">
                <label>{t('privacy.fields.readReceipts')}</label>
                <select
                  value={form.readReceipts || ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({
                      ...form,
                      readReceipts: (e.target.value || undefined) as UpdatePrivacySettingsInput['readReceipts'],
                    })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {READ_RECEIPTS_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {optionLabel(opt)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field">
                <label>{t('privacy.fields.groupsAdd')}</label>
                <select
                  value={form.groupsAdd || ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({
                      ...form,
                      groupsAdd: (e.target.value || undefined) as UpdatePrivacySettingsInput['groupsAdd'],
                    })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {GROUP_ADD_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {optionLabel(opt)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field">
                <label>{t('privacy.fields.call')}</label>
                <select
                  value={form.call || ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({ ...form, call: (e.target.value || undefined) as UpdatePrivacySettingsInput['call'] })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {CALL_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {optionLabel(opt)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field">
                <label>{t('privacy.fields.messages')}</label>
                <select
                  value={form.messages || ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({
                      ...form,
                      messages: (e.target.value || undefined) as UpdatePrivacySettingsInput['messages'],
                    })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {MESSAGES_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>
                      {optionLabel(opt)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field">
                <label>{t('privacy.fields.defaultDisappearingMode')}</label>
                <select
                  value={form.defaultDisappearingMode ?? ''}
                  disabled={!canWrite}
                  onChange={e =>
                    setForm({
                      ...form,
                      defaultDisappearingMode: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                >
                  <option value="">{t('privacy.noChange')}</option>
                  {DISAPPEARING_OPTIONS.map(seconds => (
                    <option key={seconds} value={seconds}>
                      {t(`privacy.disappearing.${seconds}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="privacy-field privacy-checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={form.disableLinkPreviews ?? false}
                    disabled={!canWrite}
                    onChange={e => setForm({ ...form, disableLinkPreviews: e.target.checked })}
                  />
                  {t('privacy.fields.disableLinkPreviews')}
                </label>
              </div>

              {canWrite && (
                <button className="btn-primary" onClick={handleSave} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
                  {t('common.save')}
                </button>
              )}
            </>
          )}
        </div>

        <div className="privacy-card">
          <div className="privacy-card-header">
            <Ban size={18} />
            <h3>{t('privacy.blocklistTitle')}</h3>
          </div>
          {loadingBlocklist ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : !blocklistData || blocklistData.blocklist.length === 0 ? (
            <p className="privacy-empty">{t('privacy.blocklistEmpty')}</p>
          ) : (
            <ul className="privacy-blocklist">
              {blocklistData.blocklist.map(id => (
                <BlocklistEntry key={id} sessionId={activeSessionId} contactId={id} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
