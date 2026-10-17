import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { Chat } from '../../services/api';
import { chatActionItems, type ChatRowActions } from './chatActionItems';

/**
 * The chevron on a chat row, opening its actions. A sibling of the row, not inside it: the row is itself a
 * button, and a control nested in one is unreachable to assistive technology. A disclosure of plain
 * buttons, not role="menu", which would promise roving focus and arrow keys.
 */
function ChatRowMenu({ chat, actions }: { chat: Chat; actions: ChatRowActions }) {
  const { t } = useTranslation();
  const items = chatActionItems(chat, actions, t);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Closes on a press outside and on Escape, which it takes in the capture phase so the page leaves the
  // open chat alone.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  // A row with nothing to offer (a read-only key on a 1:1 chat) gets no chevron at all.
  if (items.length === 0) return null;

  return (
    <div className={`chat-row-menu ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-row-menu-trigger"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={t('chats.rowActions.actionsFor', { name: chat.name || chat.id.split('@')[0] })}
        title={t('chats.moreActions')}
      >
        <ChevronDown size={18} />
      </button>
      {open && (
        <div className="chat-row-menu-popover">
          {items.map(item => (
            <div key={item.key} className="chat-row-menu-group">
              {item.separated && <hr />}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  item.run(chat);
                }}
              >
                {item.icon}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ChatRowMenu;
