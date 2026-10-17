import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import type { Session } from '../../services/api';
import { useProfilePicture } from '../../hooks/useProfilePicture';
import { formatPhoneForDisplay } from '../../utils/formatPhone';
import { flagOfRegion, regionOfPhone } from '../../utils/phoneCountry';

interface SessionPickerProps {
  /** Every session the gateway lists; only a ready one can be picked. */
  sessions: Session[];
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
  /** Offers the link to the Sessions page, where an operator pairs another number. */
  canAddSession: boolean;
}

/** Two initials from a session's name: "Marie Haas" → "MH", "support" → "SU". */
const initialsOf = (name: string): string => {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
};

// Green for a connected session, amber while one is on its way, red for one that needs a hand.
const statusTone = (status: Session['status']): 'ready' | 'pending' | 'down' =>
  status === 'ready'
    ? 'ready'
    : status === 'initializing' || status === 'authenticating' || status === 'qr_ready'
      ? 'pending'
      : 'down';

/** The flag and the formatted number, e.g. "🇩🇪 +49 174 712 7865". */
function PhoneLine({ phone }: { phone?: string | null }) {
  const { t } = useTranslation();
  if (!phone) return <>{t('chats.noPhone')}</>;
  const region = regionOfPhone(phone);
  return (
    <>
      {region && (
        <span className="session-flag" aria-hidden="true">
          {flagOfRegion(region)}
        </span>
      )}
      {/* Digits and + carry no direction of their own: without ltr a right-to-left page reverses them. */}
      <bdi dir="ltr">{formatPhoneForDisplay(phone) ?? phone}</bdi>
    </>
  );
}

// The account's own profile picture, read through the session itself, so only a ready session has one.
// The initials stand in while it loads, when the account hides it, or when the session is down.
function SessionAvatar({ session, size }: { session: Session; size: 'md' | 'sm' }) {
  const { t } = useTranslation();
  const ownJid = session.phone ? `${session.phone.replace(/\D/g, '')}@c.us` : undefined;
  const picture = useProfilePicture(session.status === 'ready' ? session.id : undefined, ownJid);
  const tone = statusTone(session.status);
  return (
    <span className={`session-avatar ${size}`}>
      {picture.data ? (
        <img src={picture.data} alt="" onError={() => picture.refetch()} />
      ) : (
        <span aria-hidden="true">{initialsOf(session.name)}</span>
      )}
      <span
        className={`session-status-dot ${tone}`}
        role="img"
        aria-label={t(`sessionStatus.${session.status}`)}
        title={t(`sessionStatus.${session.status}`)}
      />
    </span>
  );
}

// Only inside a router: the page also renders in tests that mount it without one.
function AddSessionLink({ onFollow }: { onFollow: () => void }) {
  const { t } = useTranslation();
  return (
    <Link to="/sessions" className="session-picker-add" onClick={onFollow}>
      <span className="session-avatar sm add" aria-hidden="true">
        <Plus size={20} />
      </span>
      <span className="session-text">
        <span className="session-name">{t('chats.sessionPicker.addTitle')}</span>
        <span className="session-phone">{t('chats.sessionPicker.addHint')}</span>
      </span>
      <ChevronRight size={18} className="session-picker-add-chevron" />
    </Link>
  );
}

/**
 * The account switcher in the chat sidebar's header: the selected session's picture, name and number,
 * opening a searchable list of every session with its connection state. A list that also shows the
 * sessions that cannot be opened right now says why a number is missing from the chats.
 */
function SessionPicker({ sessions, selectedSessionId, onSelectSession, canAddSession }: SessionPickerProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  const selected = sessions.find(s => s.id === selectedSessionId);
  const needle = query.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const shown = needle
    ? sessions.filter(
        s =>
          [s.name, s.pushName].some(field => field?.toLowerCase().includes(needle)) ||
          (digits.length > 0 && (s.phone ?? '').includes(digits)),
      )
    : sessions;

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  // Closes on a press outside and on Escape. Escape is taken in the capture phase and marked handled,
  // like the emoji picker's, so the page's own Escape handler leaves the open chat alone.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery('');
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  const options = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);

  // Arrow keys walk the options, from the search box into the list and back.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = options().filter(option => !option.disabled);
    if (all.length === 0) return;
    event.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? all[Math.min(at + 1, all.length - 1)] : at <= 0 ? null : all[at - 1];
    if (next) next.focus();
    else rootRef.current?.querySelector<HTMLInputElement>('.session-picker-search input')?.focus();
  };

  const pick = (session: Session) => {
    if (session.id !== selectedSessionId) onSelectSession(session.id);
    close(true);
  };

  return (
    <div className="session-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="session-switcher-btn"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={t('chats.switchSession')}
      >
        {selected && <SessionAvatar session={selected} size="md" />}
        <span className="session-text">
          <span className="session-name">{selected?.name}</span>
          <span className="session-phone">
            <PhoneLine phone={selected?.phone} />
          </span>
        </span>
        <ChevronDown size={18} className={`session-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="session-picker" onKeyDown={onListKeyDown}>
          <div className="session-picker-search">
            <Search size={18} />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('chats.sessionPicker.searchPlaceholder')}
              aria-label={t('chats.sessionPicker.searchPlaceholder')}
              aria-controls={listId}
              autoFocus
            />
          </div>
          <ul
            className="session-picker-list"
            role="listbox"
            id={listId}
            aria-label={t('chats.sessionLabel')}
            ref={listRef}
          >
            {shown.length === 0 ? (
              <li className="session-picker-empty">{t('chats.sessionPicker.noMatch')}</li>
            ) : (
              shown.map(session => {
                const isSelected = session.id === selectedSessionId;
                const ready = session.status === 'ready';
                return (
                  <li key={session.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={!ready}
                      className={`session-picker-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => pick(session)}
                      title={ready ? undefined : t(`sessionStatus.${session.status}`)}
                    >
                      <SessionAvatar session={session} size="sm" />
                      <span className="session-text">
                        <span className="session-name">{session.name}</span>
                        <span className="session-phone">
                          {session.pushName && (
                            <>
                              <bdi>{session.pushName}</bdi>
                              <span aria-hidden="true"> · </span>
                            </>
                          )}
                          <PhoneLine phone={session.phone} />
                        </span>
                      </span>
                      {isSelected && <Check size={18} className="session-check" />}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {canAddSession && inRouter && <AddSessionLink onFollow={() => close(false)} />}
        </div>
      )}
    </div>
  );
}

export default SessionPicker;
