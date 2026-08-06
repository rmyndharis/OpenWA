/**
 * Search filtering and status grouping for the three conversation tabs.
 *
 * One search box drives Chats, Channels and Status, but each tab matches on different fields, and the
 * Status tab additionally collapses a flat list into one row per contact with a two-axis ordering.
 * As inline consts inside the page these were three unrelated rules reading one piece of state; as
 * functions they take the query as an argument and can be tested.
 */

/** Case-insensitive "does any of these fields contain the query". Absent fields never match. */
const matches = (query: string, ...fields: (string | undefined)[]): boolean => {
  const needle = query.toLowerCase();
  return fields.some(f => (f ?? '').toLowerCase().includes(needle));
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
