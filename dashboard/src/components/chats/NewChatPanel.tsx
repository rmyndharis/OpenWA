import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Loader2, Phone, Search, Users, X } from 'lucide-react';
import { contactApi, sessionApi, type Chat, type Contact } from '../../services/api';
import { formatPhoneForDisplay } from '../../utils/formatPhone';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import ChatAvatar from './ChatAvatar';

type Mode = 'chat' | 'group';

interface Participant {
  id: string;
  label: string;
}

interface NewChatPanelProps {
  sessionId: string;
  /** Opens the chat in the room pane, adding it to the list when it has no history yet. */
  onOpenChat: (chat: Chat) => void;
  onClose: () => void;
}

// The gateway caps a group subject at 100 characters (CreateGroupDto).
const GROUP_NAME_MAX_LENGTH = 100;

/**
 * Digits of a number typed with its country code, or null. The engine resolves digits as they are, so
 * a national "0170…" would silently reach a different country; only "+49…", "0049…" or bare
 * international digits are taken. 7–15 digits covers E.164.
 */
const toInternationalDigits = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (!trimmed.startsWith('+') && digits.startsWith('0')) return null;
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
};

const contactLabel = (c: Contact): string => c.name || c.pushName || formatPhoneForDisplay(c.id) || c.number;

// A chat row for a conversation the engine may not list yet (no history). The first message, or the
// next chat-list load, replaces it with the engine's own row.
const draftChat = (id: string, name: string, kind: Chat['kind'], timestamp = 0): Chat => ({
  id,
  name,
  isGroup: kind === 'group',
  kind,
  unreadCount: 0,
  timestamp,
  archived: false,
  pinned: false,
  muted: false,
});

/**
 * Sidebar sub-view for starting a 1:1 chat or creating a group. The page mounts it only for a key that
 * can write; group creation is offered on Baileys only, since whatsapp-web.js answers it with 501.
 */
function NewChatPanel({ sessionId, onOpenChat, onClose }: NewChatPanelProps) {
  const { t } = useTranslation();
  const { error: showErrorToast, success: showSuccessToast } = useToast();
  const { engineType } = useRole();
  const groupsSupported = engineType === 'baileys';

  const [mode, setMode] = useState<Mode>('chat');
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [creating, setCreating] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ['contacts', sessionId],
    queryFn: () => contactApi.list(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 5 * 60 * 1000,
    // contactApi.list already retried a throttled page; another attempt would walk every page again.
    retry: false,
  });

  // Saved, unblocked personal contacts, alphabetically. The address book also lists groups and
  // broadcast lists, which can be neither a 1:1 chat nor a group participant.
  const contacts = useMemo(
    () =>
      (contactsQuery.data ?? [])
        .filter(c => c.isMyContact && !c.isBlocked && !c.id.endsWith('@g.us') && !c.id.endsWith('@broadcast'))
        .sort((a, b) => contactLabel(a).localeCompare(contactLabel(b))),
    [contactsQuery.data],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, '');
  const visibleContacts = normalizedQuery
    ? contacts.filter(
        c =>
          contactLabel(c).toLowerCase().includes(normalizedQuery) ||
          (queryDigits.length > 0 && c.number.includes(queryDigits)),
      )
    : contacts;

  const typedNumber = toInternationalDigits(query);
  const typedNumberLabel = typedNumber ? (formatPhoneForDisplay(typedNumber) ?? `+${typedNumber}`) : '';
  const showNumberHint = Boolean(query.trim()) && !typedNumber && /^[\d\s+()-]+$/.test(query.trim());

  // Resolve a typed number to its canonical WhatsApp id. The send routes accept an unregistered number
  // without an error, so this check is the only thing that keeps a chat from going nowhere.
  const resolveNumber = async (digits: string, label: string): Promise<string | null> => {
    setChecking(true);
    try {
      const res = await contactApi.checkNumber(sessionId, digits);
      if (!res.exists || !res.whatsappId) {
        showErrorToast(t('chats.newChat.notOnWhatsApp', { number: label }));
        return null;
      }
      return res.whatsappId;
    } catch (err) {
      showErrorToast(t('chats.newChat.checkFailed'), err instanceof Error ? err.message : undefined);
      return null;
    } finally {
      setChecking(false);
    }
  };

  const handleStartWithNumber = async () => {
    if (!typedNumber) return;
    const id = await resolveNumber(typedNumber, typedNumberLabel);
    if (id) onOpenChat(draftChat(id, '', 'individual'));
  };

  const toggleParticipant = (p: Participant) => {
    setParticipants(prev => (prev.some(x => x.id === p.id) ? prev.filter(x => x.id !== p.id) : [...prev, p]));
  };

  const handleAddNumber = async () => {
    if (!typedNumber) return;
    const id = await resolveNumber(typedNumber, typedNumberLabel);
    if (!id) return;
    setParticipants(prev => (prev.some(x => x.id === id) ? prev : [...prev, { id, label: typedNumberLabel }]));
    setQuery('');
  };

  const handleCreateGroup = async () => {
    const name = groupName.trim();
    if (!name || participants.length === 0 || creating) return;
    setCreating(true);
    try {
      const group = await sessionApi.createGroup(
        sessionId,
        name,
        participants.map(p => p.id),
      );
      showSuccessToast(t('chats.newGroup.created', { name }));
      onOpenChat(draftChat(group.id, group.name || name, 'group', Math.floor(Date.now() / 1000)));
    } catch (err) {
      showErrorToast(t('chats.newGroup.createFailed'), err instanceof Error ? err.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setQuery('');
  };

  const isGroupMode = mode === 'group';
  const submitTypedNumber = () => void (isGroupMode ? handleAddNumber() : handleStartWithNumber());

  return (
    <div className="new-chat-panel">
      <header className="new-chat-header">
        <button
          type="button"
          className="icon-btn"
          onClick={() => (isGroupMode ? switchMode('chat') : onClose())}
          aria-label={t('common.back')}
          title={t('common.back')}
        >
          <ArrowLeft size={20} />
        </button>
        <span>{isGroupMode ? t('chats.newGroup.title') : t('chats.newChat.title')}</span>
      </header>

      {isGroupMode && (
        <div className="new-group-fields">
          <input
            type="text"
            className="new-group-name"
            placeholder={t('chats.newGroup.namePlaceholder')}
            aria-label={t('chats.newGroup.namePlaceholder')}
            value={groupName}
            maxLength={GROUP_NAME_MAX_LENGTH}
            onChange={e => setGroupName(e.target.value)}
            autoFocus
          />
          {participants.length > 0 && (
            <div className="participant-chips">
              {participants.map(p => (
                <span key={p.id} className="participant-chip">
                  <bdi>{p.label}</bdi>
                  <button
                    type="button"
                    onClick={() => toggleParticipant(p)}
                    aria-label={t('chats.newGroup.removeParticipant', { name: p.label })}
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="chat-search-input new-chat-search">
        <Search size={18} />
        <input
          type="text"
          placeholder={isGroupMode ? t('chats.newGroup.participantsPlaceholder') : t('chats.newChat.searchPlaceholder')}
          aria-label={isGroupMode ? t('chats.newGroup.participantsPlaceholder') : t('chats.newChat.searchPlaceholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && typedNumber && !checking) {
              e.preventDefault();
              submitTypedNumber();
            }
          }}
          autoFocus={!isGroupMode}
        />
        {query && (
          <button
            type="button"
            className="search-clear"
            onClick={() => setQuery('')}
            aria-label={t('chats.clearSearch')}
            title={t('chats.clearSearch')}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {showNumberHint && <p className="new-chat-hint">{t('chats.newChat.numberHint')}</p>}

      <div className="chats-list new-chat-list">
        {!isGroupMode && groupsSupported && !normalizedQuery && (
          <button type="button" className="chat-item-card action-row" onClick={() => switchMode('group')}>
            <span className="chat-avatar avatar-md action-avatar">
              <Users size={22} />
            </span>
            <span className="chat-item-name">{t('chats.newGroup.title')}</span>
          </button>
        )}

        {typedNumber && (
          <button type="button" className="chat-item-card action-row" disabled={checking} onClick={submitTypedNumber}>
            <span className="chat-avatar avatar-md action-avatar">
              {checking ? <Loader2 className="animate-spin" size={22} /> : <Phone size={22} />}
            </span>
            <span className="chat-item-name">
              {checking
                ? t('chats.newChat.checking')
                : isGroupMode
                  ? t('chats.newGroup.addNumber', { number: typedNumberLabel })
                  : t('chats.newChat.startWithNumber', { number: typedNumberLabel })}
            </span>
          </button>
        )}

        <div className="new-chat-section-label">{t('chats.newChat.contacts')}</div>

        {contactsQuery.isLoading ? (
          <div className="chats-list-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>{t('chats.newChat.loadingContacts')}</span>
          </div>
        ) : contactsQuery.isError ? (
          <div className="chats-list-empty">
            <span>{t('chats.newChat.contactsError')}</span>
          </div>
        ) : visibleContacts.length === 0 ? (
          <div className="chats-list-empty">
            <span>{t('chats.newChat.noContacts')}</span>
          </div>
        ) : (
          visibleContacts.map(c => {
            const label = contactLabel(c);
            const selected = participants.some(p => p.id === c.id);
            const phone = formatPhoneForDisplay(c.id) ?? c.number;
            return (
              <button
                type="button"
                key={c.id}
                className={`chat-item-card ${selected ? 'active' : ''}`}
                aria-pressed={isGroupMode ? selected : undefined}
                onClick={() =>
                  isGroupMode
                    ? toggleParticipant({ id: c.id, label })
                    : onOpenChat(draftChat(c.id, c.name || '', 'individual'))
                }
              >
                <ChatAvatar chatId={c.id} kind="individual" />
                <span className="chat-item-info">
                  <span className="chat-item-name">{label}</span>
                  {phone && phone !== label && (
                    <span className="chat-item-snippet">
                      <bdi dir="ltr">{phone}</bdi>
                    </span>
                  )}
                </span>
                {isGroupMode && (
                  <span className={`select-check ${selected ? 'checked' : ''}`} aria-hidden="true">
                    {selected && <Check size={14} strokeWidth={3} />}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {isGroupMode && (
        <footer className="new-group-footer">
          <span className="new-group-count">{t('chats.newGroup.selected', { count: participants.length })}</span>
          <button
            type="button"
            className="new-group-create"
            disabled={!groupName.trim() || participants.length === 0 || creating}
            onClick={() => void handleCreateGroup()}
          >
            {creating ? <Loader2 className="animate-spin" size={18} /> : <Check size={18} />}
            {t('chats.newGroup.create')}
          </button>
        </footer>
      )}
    </div>
  );
}

export default NewChatPanel;
