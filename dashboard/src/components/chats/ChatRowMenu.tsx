import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { Chat } from '../../services/api';
import { chatTitle } from '../../utils/formatPhone';
import { isComposingKey } from '../../utils/composition';
import { chatActionItems, type ChatActionItem, type ChatRowActions } from './chatActionItems';

/**
 * A chat's actions as menu entries, for the row's chevron and the open chat's header menu alike. A disabled
 * entry stays visible with the reason under its label.
 */
export function ChatActionList({
  chat,
  items,
  groupClassName,
  onPicked,
}: {
  chat: Chat;
  items: ChatActionItem[];
  groupClassName: string;
  onPicked: () => void;
}) {
  return (
    <>
      {items.map(item => (
        <div key={item.key} className={groupClassName}>
          {item.separated && <hr />}
          <button
            type="button"
            disabled={item.disabled}
            onClick={() => {
              onPicked();
              item.run(chat);
            }}
          >
            {item.icon}
            <span className="chat-action-label">
              {item.label}
              {item.hint && <small>{item.hint}</small>}
            </span>
          </button>
        </div>
      ))}
    </>
  );
}

/** The actions of a chat for the open chat's header menu; the row's chevron renders its own. */
export function ChatActions({
  chat,
  actions,
  onPicked,
}: {
  chat: Chat;
  actions: ChatRowActions;
  onPicked: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ChatActionList
      chat={chat}
      items={chatActionItems(chat, actions, t)}
      groupClassName="room-menu-group"
      onPicked={onPicked}
    />
  );
}

/**
 * The chevron on a chat row, opening its actions. A sibling of the row, not inside it: the row is itself a
 * button, and a control nested in one is unreachable to assistive technology. A disclosure of plain
 * buttons, not role="menu", which would promise roving focus and arrow keys.
 */
function ChatRowMenu({
  chat,
  actions,
  open,
  onOpenChange,
}: {
  chat: Chat;
  actions: ChatRowActions;
  /** Owned by the list, which keeps one row menu open at a time and draws that row again as its actions change. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const items = chatActionItems(chat, actions, t);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // A menu that leaves the page open (another tab, the new-chat panel, a filtered list) is closed, so the row does
  // not come back with it open. Closing because another row opened is a no-op for the list, which names that row.
  useEffect(() => {
    if (!open) return;
    return () => onOpenChange(false);
  }, [open, onOpenChange]);
  // A 1:1 chat's entries read the address book (Save or Rename), which is asked for once its menu is open. Asked from
  // here, after the list has drawn the row again with the page's current actions, and again as they change.
  const onMenuOpen = actions.onMenuOpen;
  useEffect(() => {
    if (open && chat.kind === 'individual') onMenuOpen?.();
  }, [open, chat.kind, onMenuOpen]);

  // The popover is placed fixed against the viewport, so the scrolling chat list does not clip it: below
  // the chevron when it fits, above it otherwise, aligned to the chevron's end edge and kept on screen.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!open || !popover || !trigger) return;
    const gap = 6;
    const margin = 8;
    const anchor = trigger.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = popover;
    const rtl = getComputedStyle(trigger).direction === 'rtl';
    const fitsBelow = anchor.bottom + gap + height <= window.innerHeight - margin;
    const top = fitsBelow ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height);
    const start = rtl ? anchor.left : anchor.right - width;
    const left = Math.min(Math.max(margin, start), window.innerWidth - width - margin);
    // Physical edges: the stylesheet pins the end edge, and releasing it as inset-inline-end would release `left`
    // in a right-to-left page, throwing the computed position away.
    Object.assign(popover.style, { position: 'fixed', top: `${top}px`, left: `${left}px`, right: 'auto' });
  }, [open]);

  // Closes on a press outside and on Escape, which it takes in the capture phase so the page leaves the
  // open chat alone.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isComposingKey(event) || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    // A fixed popover would drift from its row, so a resize closes it, and so does a scroll of anything the row
    // sits in. The scroll of another element (the open thread following a live message) does not move the row.
    const onScroll = (event: Event) => {
      if ((event.target as Node).contains(rootRef.current)) onOpenChange(false);
    };
    const onResize = () => onOpenChange(false);
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onEscape, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onEscape, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, onOpenChange]);

  // A row with nothing to offer (a read-only key on a 1:1 chat) gets no chevron at all.
  if (items.length === 0) return null;

  return (
    <div className={`chat-row-menu ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-row-menu-trigger"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label={t('chats.rowActions.actionsFor', { name: chatTitle(chat) })}
        title={t('chats.moreActions')}
      >
        <ChevronDown size={18} />
      </button>
      {open && (
        <div className="chat-row-menu-popover" ref={popoverRef}>
          <ChatActionList
            chat={chat}
            items={items}
            groupClassName="chat-row-menu-group"
            onPicked={() => {
              // Focus moves to the chevron, which stays: the picked entry is about to unmount, and a dialog it
              // opens restores focus to whatever holds it then.
              onOpenChange(false);
              triggerRef.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}

export default ChatRowMenu;
