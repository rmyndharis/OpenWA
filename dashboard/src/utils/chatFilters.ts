/**
 * Search filtering and status grouping for the three conversation tabs.
 *
 * One search box drives Chats, Channels and Status, but each tab matches on different fields, and the
 * Status tab additionally collapses a flat list into one row per contact with a two-axis ordering.
 * As inline consts inside the page these were three unrelated rules reading one piece of state; as
 * functions they take the query as an argument and can be tested.
 */
import { normalizePhoneText } from './phone.ts';

// The last query as matches() reads it. Every filter calls matches() once per row on every render of the Chats page,
// and folding a native digit walks back to its script's zero, so the fold is made once per query, not once per row.
let lastQuery = { query: '', needle: '', folded: '' };

/** Case-insensitive "does any of these fields contain the query". Absent fields never match. */
export const matches = (query: string, ...fields: (string | undefined)[]): boolean => {
  if (query !== lastQuery.query) {
    const needle = query.toLowerCase();
    // A number typed in the digits of another script matches the ASCII digits of an id.
    lastQuery = { query, needle, folded: normalizePhoneText(needle) };
  }
  const { needle, folded } = lastQuery;
  return fields.some(f => {
    const field = (f ?? '').toLowerCase();
    return field.includes(needle) || (folded !== needle && field.includes(folded));
  });
};

interface ChatLike {
  id: string;
  name?: string;
  kind?: string;
}

/**
 * Chats tab: real conversations only. Channel- and status-kind rows are hidden here and surfaced on
 * their own tabs instead, so a channel never appears twice.
 */
export function filterChats<T extends ChatLike>(chats: T[], query: string): T[] {
  return chats.filter(c => c.kind !== 'channel' && c.kind !== 'status' && matches(query, c.name, c.id));
}

/** The quick filters above the Chats tab list, applied after the search box. */
export const CHAT_LIST_FILTERS = ['all', 'unread', 'direct', 'groups', 'unknown'] as const;
export type ChatListFilter = (typeof CHAT_LIST_FILTERS)[number];

/**
 * The key a contact and a chat share in the address book. Engines spell a phone-based user id as
 * `…@c.us` (whatsapp-web.js) or `…@s.whatsapp.net` (Baileys), so both reduce to the phone digits; any
 * other id (a `@lid` privacy id among them) keeps its full form, so its digits never pass for a phone.
 */
export function contactKey(id: string): string {
  const [user, domain] = id.split('@');
  const phone = user.split(':')[0];
  return (domain === 'c.us' || domain === 's.whatsapp.net') && /^\d+$/.test(phone) ? phone : id;
}

/** The keys of the contacts the address book holds as saved (`isMyContact`); undefined until loaded. */
export function savedContactKeySet(
  contacts: Array<{ id: string; isMyContact: boolean }> | undefined,
): ReadonlySet<string> | undefined {
  return contacts && new Set(contacts.filter(c => c.isMyContact).map(c => contactKey(c.id)));
}

/**
 * A 1:1 chat whose contact the address book does not hold as saved. Decided from the address book, not
 * from the chat's name: Baileys names an unsaved contact by its bare push name (`Bob`), with no marker.
 * Until the address book has loaded no chat counts as unsaved, rather than all of them.
 */
export function isUnsavedContact(chat: ChatLike, savedKeys: ReadonlySet<string> | undefined): boolean {
  if (chat.kind !== 'individual' || !savedKeys) return false;
  return !savedKeys.has(contactKey(chat.id));
}

/**
 * The phone-based contact id the address book can store a 1:1 chat's contact under: the chat id itself
 * when it is one, otherwise null. The gateway refuses a `@lid` id for the address book, and its digits are
 * no phone number.
 */
export function phoneContactId(chatId: string): string | null {
  return /^\d+@(c\.us|s\.whatsapp\.net)$/.test(chatId) ? chatId : null;
}

/** A negative unread count is a chat marked unread (Baileys reports -1), which the Unread filter keeps. */
export function applyChatListFilter<T extends ChatLike & { unreadCount: number }>(
  chats: T[],
  filter: ChatListFilter,
  savedKeys?: ReadonlySet<string>,
): T[] {
  switch (filter) {
    case 'unread':
      return chats.filter(c => c.unreadCount !== 0);
    case 'direct':
      return chats.filter(c => c.kind === 'individual');
    case 'groups':
      return chats.filter(c => c.kind === 'group');
    case 'unknown':
      return chats.filter(c => isUnsavedContact(c, savedKeys));
    default:
      return chats;
  }
}

/** Channels tab: same search box, matched on the channel's own name/id. */
export function filterChannels<T extends { id: string; name: string }>(channels: T[], query: string): T[] {
  return channels.filter(ch => matches(query, ch.name, ch.id));
}

interface StatusItemLike<C> {
  contact: C;
  /** ISO-8601. Compared lexically, which orders ISO strings correctly — the store hands them over as
   *  strings and never as epoch numbers. */
  timestamp: string;
}

/**
 * Status tab: collapse the flat status list to one row per contact.
 *
 * Two orderings, and they run in opposite directions on purpose. Groups are sorted newest-contact
 * first, so the most recently active contact heads the list. Within a group the items are flipped to
 * oldest-first, because the store returns statuses newest-first (postedAt DESC) and the viewer opens
 * at the newest — reading like a WhatsApp story, newest at the bottom where the scroll lands.
 *
 * Getting either direction wrong is invisible in a screenshot and obvious to a user, which is why it
 * is pinned by a test rather than left inline.
 */
export function groupStatusesByContact<
  C extends { id: string; name?: string; pushName?: string },
  T extends StatusItemLike<C>,
>(statuses: T[], query: string): { contact: C; items: T[]; latest: string }[] {
  const byContact = new Map<string, { contact: C; items: T[]; latest: string }>();
  for (const item of statuses) {
    const existing = byContact.get(item.contact.id);
    if (existing) {
      existing.items.push(item);
      if (item.timestamp > existing.latest) existing.latest = item.timestamp;
    } else {
      byContact.set(item.contact.id, { contact: item.contact, items: [item], latest: item.timestamp });
    }
  }
  for (const group of byContact.values()) group.items.reverse();
  return Array.from(byContact.values())
    .filter(g => matches(query, g.contact.name, g.contact.pushName, g.contact.id))
    .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}
