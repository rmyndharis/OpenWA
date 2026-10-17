import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Modal } from '../Modal';
import type { Chat } from '../../services/api';

export type MuteDuration = '8h' | '1w' | 'always';

const MUTE_DURATIONS: MuteDuration[] = ['8h', '1w', 'always'];

/** Pick how long a chat stays muted, as WhatsApp offers it: 8 hours, a week, or until it is unmuted. */
export function MuteChatDialog({
  chat,
  busy,
  onMute,
  onClose,
}: {
  chat: Chat;
  busy: boolean;
  onMute: (duration: MuteDuration) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [duration, setDuration] = useState<MuteDuration>('8h');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('chats.rowActions.muteTitle', { name: chat.name || chat.id.split('@')[0] })}
      className="confirm-modal"
      closeLabel={t('common.close')}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={() => onMute(duration)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : t('chats.rowActions.mute')}
          </button>
        </>
      }
    >
      <p className="text-muted">{t('chats.rowActions.muteHint')}</p>
      <fieldset className="chat-dialog-options" aria-label={t('chats.rowActions.mute')}>
        {MUTE_DURATIONS.map(value => (
          <label key={value}>
            <input
              type="radio"
              name="mute-duration"
              value={value}
              checked={duration === value}
              onChange={() => setDuration(value)}
            />
            {t(`chats.rowActions.muteFor.${value}`)}
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}

// The gateway's cap on an address-book name (UpsertContactDto).
const NAME_MAX_LENGTH = 100;

/** Save a 1:1 chat's contact to the account's address book, or rename the entry it has. */
export function SaveContactDialog({
  chat,
  busy,
  onSave,
  onClose,
}: {
  chat: Chat;
  busy: boolean;
  onSave: (firstName: string, lastName: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A push name (`~Max`) or the number itself is no name to start from.
  const known = chat.name && !chat.name.startsWith('~') && /\D/.test(chat.name.replace(/[\s+()-]/g, ''));
  const [first, ...rest] = known ? chat.name.trim().split(/\s+/) : [''];
  const [firstName, setFirstName] = useState(first ?? '');
  const [lastName, setLastName] = useState(rest.join(' '));
  const canSave = firstName.trim().length > 0 && !busy;
  return (
    <Modal
      open
      onClose={onClose}
      title={known ? t('chats.rowActions.renameContact') : t('chats.rowActions.saveContact')}
      className="confirm-modal"
      closeLabel={t('common.close')}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={() => onSave(firstName.trim(), lastName.trim())} disabled={!canSave}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
          </button>
        </>
      }
    >
      <form
        className="chat-dialog-form"
        onSubmit={event => {
          event.preventDefault();
          if (canSave) onSave(firstName.trim(), lastName.trim());
        }}
      >
        <label>
          <span>{t('chats.rowActions.firstName')}</span>
          <input
            type="text"
            value={firstName}
            maxLength={NAME_MAX_LENGTH}
            onChange={e => setFirstName(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          <span>{t('chats.rowActions.lastName')}</span>
          <input type="text" value={lastName} maxLength={NAME_MAX_LENGTH} onChange={e => setLastName(e.target.value)} />
        </label>
        <p className="text-muted">{chat.id}</p>
      </form>
    </Modal>
  );
}
