import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Modal } from '../Modal';
import type { Chat } from '../../services/api';
import { chatTitle } from '../../utils/formatPhone';

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
      title={t('chats.rowActions.muteTitle', { name: chatTitle(chat) })}
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

/**
 * Save a 1:1 chat's contact to the account's address book, or rename the entry it has. `saved` is the address
 * book's word on whether it holds the contact, the one the chat's menu went by; the chat's name says nothing
 * of it, since an unsaved contact is named by its push name.
 */
export function SaveContactDialog({
  chat,
  saved,
  busy,
  onSave,
  onClose,
}: {
  chat: Chat;
  saved: boolean;
  busy: boolean;
  onSave: (firstName: string, lastName: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A saved contact starts from its name, unless that is a push name (`~Max`) or the number itself. The verdict can
  // arrive after the dialog opened (the address book is read when the first menu opens), so until the operator types
  // the fields follow it; the first keystroke freezes both as they stand, and nothing is replaced after that.
  const named = chat.name && !chat.name.startsWith('~') && /\D/.test(chat.name.replace(/[\s+()-]/g, ''));
  const [first, ...rest] = saved && named ? chat.name.trim().split(/\s+/) : [''];
  const [typed, setTyped] = useState<{ first: string; last: string } | null>(null);
  const firstName = typed ? typed.first : (first ?? '');
  const lastName = typed ? typed.last : rest.join(' ');
  const canSave = firstName.trim().length > 0 && !busy;
  // The footer's Save button belongs to the form through this id, so Enter in a name field presses it.
  const formId = useId();
  // The dialog opens on the first name, so typing and Enter work at once; the modal focuses it after it has
  // recorded the opener (autoFocus would have it recorded as the opener instead).
  const firstRef = useRef<HTMLInputElement | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={saved ? t('chats.rowActions.renameContact') : t('chats.rowActions.saveContact')}
      className="confirm-modal"
      closeLabel={t('common.close')}
      initialFocusRef={firstRef}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" form={formId} className="btn-primary" disabled={!canSave}>
            {busy ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="chat-dialog-form"
        onSubmit={event => {
          event.preventDefault();
          if (canSave) onSave(firstName.trim(), lastName.trim());
        }}
      >
        <label>
          <span>{t('chats.rowActions.firstName')}</span>
          <input
            ref={firstRef}
            type="text"
            value={firstName}
            maxLength={NAME_MAX_LENGTH}
            onChange={e => setTyped({ first: e.target.value, last: lastName })}
          />
        </label>
        <label>
          <span>{t('chats.rowActions.lastName')}</span>
          <input
            type="text"
            value={lastName}
            maxLength={NAME_MAX_LENGTH}
            onChange={e => setTyped({ first: firstName, last: e.target.value })}
          />
        </label>
        <p className="text-muted">{chat.id}</p>
      </form>
    </Modal>
  );
}
