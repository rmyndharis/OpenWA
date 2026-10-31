import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Crown, Info, Loader2, RefreshCw, ShieldCheck, ShieldOff, UserMinus, UserPlus, Users } from 'lucide-react';
import { Modal } from '../Modal';
import {
  contactApi,
  sessionApi,
  type Chat,
  type GroupInfo,
  type GroupParticipantResult,
  type GroupParticipantsAck,
  type Session,
} from '../../services/api';
import { useProfilePicture } from '../../hooks/useProfilePicture';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import { formatPhoneForDisplay, isolateNumber } from '../../utils/formatPhone';
import { MEDIA_UPLOAD_MAX_BYTES } from '../../utils/mediaUpload';
import { normalizePhoneText } from '../../utils/phone';
import ChatAvatar from './ChatAvatar';

// The gateway's caps (CreateGroupDto / GroupDescriptionDto).
const GROUP_NAME_MAX_LENGTH = 100;
const GROUP_DESCRIPTION_MAX_LENGTH = 1024;

type Tab = 'info' | 'participants';

interface GroupInfoDialogProps {
  session: Session;
  group: Chat;
  onClose: () => void;
  /** The group's name changed through `sessionId`: the page renames its row and room if still on it. */
  onRenamed: (sessionId: string, groupId: string, name: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : undefined);

/** The participant a membership write refused, with the reason the engine gave. */
const refusalText = (r: GroupParticipantResult) => {
  const who = r.id.replace(/@.*/, '');
  const why = r.message ?? (r.status ? `HTTP ${r.status}` : undefined);
  return why ? `${who}: ${why}` : who;
};

/** Whether a participant is this session's own account. */
const isOwnAccount = (participant: GroupInfo['participants'][number], session: Session) => {
  const own = session.phone?.replace(/\D/g, '');
  return Boolean(own) && (participant.number === own || participant.id.split('@')[0].split(':')[0] === own);
};

/**
 * Edit a group's name, picture and description, and its participants, through the session that is open.
 * What this account may change is WhatsApp's call: an admin may change everything, a member only the info
 * of a group whose info is not locked to admins. The dialog reads that from the group and offers no edit the
 * gateway would refuse.
 */
function GroupInfoDialog({ session, group, onClose, onRenamed }: GroupInfoDialogProps) {
  const { t } = useTranslation();
  const { canWrite } = useRole();
  const { success: showSuccess, error: showError } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('info');
  const infoQuery = useQuery({
    queryKey: ['group-info', session.id, group.id],
    queryFn: () => sessionApi.getGroup(session.id, group.id),
  });
  const picture = useProfilePicture(session.id, group.id);
  const info = infoQuery.data;

  const me = info?.participants.find(p => isOwnAccount(p, session));
  const isAdmin = Boolean(me?.isAdmin || me?.isSuperAdmin);
  const canEditInfo = canWrite && Boolean(info) && (isAdmin || info?.locked === false);
  const canManageMembers = canWrite && isAdmin;

  // What the operator has typed. A field they have not touched shows the group as the server last returned it,
  // so loading the group again (a member action, the window regaining focus) neither discards a draft nor
  // leaves an untouched field stale. A save or a refresh drops the draft.
  const [draft, setDraft] = useState<{ name?: string; description?: string }>({});
  const [newPicture, setNewPicture] = useState<{ base64: string; mimetype: string; preview: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const name = draft.name ?? info?.name ?? '';
  const description = draft.description ?? info?.description ?? '';
  const dropDraft = () => {
    setDraft({});
    setNewPicture(null);
  };
  // The preview is an object URL: released when replaced and when the dialog closes.
  useEffect(() => {
    if (!newPicture) return;
    return () => URL.revokeObjectURL(newPicture.preview);
  }, [newPicture]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pickPicture = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      showError(t('chats.errors.fileTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = event => {
      const base64 = String(event.target?.result ?? '').split(',')[1] ?? '';
      setNewPicture({ base64, mimetype: file.type, preview: URL.createObjectURL(file) });
    };
    reader.readAsDataURL(file);
  };

  const trimmedName = name.trim();
  const nameChanged = Boolean(info) && trimmedName !== info?.name;
  const descriptionChanged = Boolean(info) && description !== (info?.description ?? '');
  const dirty = nameChanged || descriptionChanged || Boolean(newPicture);

  // Each field is its own route, called in turn: name, description, picture. Those before a refusal stay saved,
  // those after it are not tried, and the toast carries the gateway's text for the refusal.
  const save = async () => {
    if (!info || !dirty || !trimmedName || saving) return;
    setSaving(true);
    try {
      if (nameChanged) {
        await sessionApi.setGroupSubject(session.id, group.id, trimmedName);
        onRenamed(session.id, group.id, trimmedName);
      }
      if (descriptionChanged) await sessionApi.setGroupDescription(session.id, group.id, description);
      if (newPicture) {
        await sessionApi.setGroupPicture(session.id, group.id, newPicture.base64, newPicture.mimetype);
        await queryClient.invalidateQueries({ queryKey: ['profilePicture', session.id, group.id] });
        await queryClient.invalidateQueries({ queryKey: ['profilePictures', session.id] });
      }
      showSuccess(t('chats.group.saved'));
      await infoQuery.refetch();
      dropDraft();
    } catch (err) {
      showError(t('chats.group.saveFailed'), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  // --- Participants ---
  const [pending, setPending] = useState<string | null>(null);
  const [newMember, setNewMember] = useState('');
  // The gateway takes ASCII digits, whatever script the operator typed them in. 7-15 digits covers E.164: more is
  // two numbers run together, refused as the new-chat panel refuses it.
  const memberDigits = normalizePhoneText(newMember).replace(/\D/g, '').replace(/^00/, '');
  const memberNumberValid = memberDigits.length >= 7 && memberDigits.length <= 15;
  // The gateway answers 200 for a membership write even when it refused some participants, and says
  // which in `results`. Returns whether every participant was accepted.
  const runMemberAction = async (key: string, action: () => Promise<GroupParticipantsAck>): Promise<boolean> => {
    setPending(key);
    try {
      const { results } = await action();
      const refused = results.filter(r => !r.success);
      if (refused.length > 0) {
        showError(t('chats.group.memberActionFailed'), refused.map(refusalText).join('; '));
      }
      await infoQuery.refetch();
      return refused.length === 0;
    } catch (err) {
      showError(t('chats.group.memberActionFailed'), errorText(err));
      return false;
    } finally {
      setPending(null);
    }
  };
  // A number is checked first, as in the new-chat panel: the gateway resolves it to the id WhatsApp uses.
  const addMember = async () => {
    const added = await runMemberAction('add', async () => {
      const check = await contactApi.checkNumber(session.id, memberDigits);
      if (!check.exists || !check.whatsappId) {
        const number = isolateNumber(formatPhoneForDisplay(memberDigits) ?? `+${memberDigits}`);
        throw new Error(t('chats.newChat.notOnWhatsApp', { number }));
      }
      return sessionApi.addGroupParticipants(session.id, group.id, [check.whatsappId]);
    });
    if (added) setNewMember('');
  };

  const sessionName = session.name;
  const subheader = (
    <div className="group-info-toolbar">
      <div className="chats-tabs" role="tablist">
        {(['info', 'participants'] as const).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`chats-tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {id === 'info' ? <Info size={16} /> : <Users size={16} />}
            {id === 'info' ? t('chats.group.tabInfo') : t('chats.group.tabParticipants')}
          </button>
        ))}
      </div>
      {info && (
        <span className={`group-info-badge ${isAdmin ? 'admin' : ''}`}>
          {isAdmin ? <ShieldCheck size={16} /> : <ShieldOff size={16} />}
          {isAdmin
            ? t('chats.group.managedBy', { session: sessionName })
            : t('chats.group.notAdmin', { session: sessionName })}
        </span>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={() => void infoQuery.refetch().then(dropDraft)}
        disabled={infoQuery.isFetching}
        title={t('common.refresh')}
        aria-label={t('common.refresh')}
      >
        <RefreshCw size={18} className={infoQuery.isFetching ? 'animate-spin' : undefined} />
      </button>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      className="group-info-modal"
      closeLabel={t('common.close')}
      title={
        <span className="group-info-title">
          <span className="group-info-tile" aria-hidden="true">
            <Users size={24} />
          </span>
          <span className="group-info-heading">
            <span>{t('chats.group.editTitle')}</span>
            <span className="group-info-subtitle">{info?.name ?? group.name}</span>
          </span>
        </span>
      }
      subheader={subheader}
      footer={
        tab === 'info' ? (
          <>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void save()}
              disabled={!canEditInfo || !dirty || !trimmedName || saving}
            >
              {saving ? <Loader2 className="animate-spin" size={16} /> : t('chats.group.save')}
            </button>
          </>
        ) : undefined
      }
    >
      {infoQuery.isLoading ? (
        <div className="group-info-state">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : infoQuery.isError || !info ? (
        <div className="group-info-state">{t('chats.group.loadFailed')}</div>
      ) : tab === 'info' ? (
        <div className="group-info-form">
          <label className="group-info-field">
            <span>
              {t('chats.group.name')} <span className="required">*</span>
            </span>
            <input
              type="text"
              value={name}
              maxLength={GROUP_NAME_MAX_LENGTH}
              onChange={e => setDraft(current => ({ ...current, name: e.target.value }))}
              disabled={!canEditInfo}
            />
          </label>

          <div className="group-info-field">
            <span>{t('chats.group.picture')}</span>
            <button
              type="button"
              className="group-info-picture"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canEditInfo}
            >
              {newPicture ? (
                <span className="chat-avatar avatar-lg">
                  <img src={newPicture.preview} alt="" />
                </span>
              ) : (
                <ChatAvatar
                  chatId={group.id}
                  pictureUrl={picture.data}
                  kind="group"
                  size="lg"
                  onImageError={() => picture.refetch()}
                />
              )}
              <span>{canEditInfo ? t('chats.group.pictureHint') : t('chats.group.readOnlyHint')}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label={t('chats.group.picture')}
              hidden
              onChange={e => {
                pickPicture(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>

          <label className="group-info-field">
            <span>{t('chats.group.description')}</span>
            <textarea
              value={description}
              maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
              placeholder={t('chats.group.descriptionPlaceholder')}
              onChange={e => setDraft(current => ({ ...current, description: e.target.value }))}
              disabled={!canEditInfo}
              rows={5}
            />
          </label>
        </div>
      ) : (
        <div className="group-info-members">
          {canManageMembers && (
            <form
              className="group-info-add"
              onSubmit={e => {
                e.preventDefault();
                if (memberNumberValid) void addMember();
              }}
            >
              <input
                type="tel"
                value={newMember}
                onChange={e => setNewMember(e.target.value)}
                placeholder={t('chats.group.addPlaceholder')}
                aria-label={t('chats.group.addPlaceholder')}
              />
              <button type="submit" className="btn-primary" disabled={!memberNumberValid || pending !== null}>
                {pending === 'add' ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
                {t('chats.group.add')}
              </button>
            </form>
          )}
          <div className="group-info-count">
            {t('chats.group.participantCount', { count: info.participants.length })}
          </div>
          <ul className="group-info-list">
            {info.participants.map(p => {
              const own = isOwnAccount(p, session);
              // Formatted from the id, not from `number`: a privacy id (@lid) has digits too, and they are no phone.
              const phone = formatPhoneForDisplay(p.id);
              const label = own ? t('chats.you') : p.name || phone || p.number;
              // In a sentence (a button's label, the confirmation) a phone is isolated, as the typed number is.
              const spoken = !own && !p.name && phone ? isolateNumber(phone) : label;
              return (
                <li key={p.id}>
                  <ChatAvatar chatId={p.id} kind="individual" size="sm" />
                  <span className="group-info-member">
                    <bdi className="name">{label}</bdi>
                    {p.name && phone && (
                      <bdi className="number" dir="ltr">
                        {phone}
                      </bdi>
                    )}
                  </span>
                  {(p.isSuperAdmin || p.isAdmin) && (
                    <span className="group-info-role">
                      {p.isSuperAdmin && <Crown size={12} />}
                      {p.isSuperAdmin ? t('chats.group.owner') : t('chats.group.admin')}
                    </span>
                  )}
                  {canManageMembers && !own && !p.isSuperAdmin && (
                    <span className="group-info-actions">
                      <button
                        type="button"
                        className="icon-btn small"
                        disabled={pending !== null}
                        onClick={() =>
                          void runMemberAction(p.id, () =>
                            sessionApi.setGroupAdmins(session.id, group.id, [p.id], !p.isAdmin),
                          )
                        }
                        title={p.isAdmin ? t('chats.group.removeAdmin') : t('chats.group.makeAdmin')}
                        aria-label={`${p.isAdmin ? t('chats.group.removeAdmin') : t('chats.group.makeAdmin')}: ${spoken}`}
                      >
                        {p.isAdmin ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}
                      </button>
                      <button
                        type="button"
                        className="icon-btn small danger"
                        disabled={pending !== null}
                        onClick={() => {
                          if (!window.confirm(t('chats.group.removeConfirm', { name: spoken }))) return;
                          void runMemberAction(p.id, () =>
                            sessionApi.removeGroupParticipants(session.id, group.id, [p.id]),
                          );
                        }}
                        title={t('chats.group.remove')}
                        aria-label={`${t('chats.group.remove')}: ${spoken}`}
                      >
                        {pending === p.id ? <Loader2 className="animate-spin" size={16} /> : <UserMinus size={16} />}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

export default GroupInfoDialog;
