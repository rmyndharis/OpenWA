import type { ChatMessage, EngineHistoryMessage, MessageType } from '../services/api';
import { MENTION_CLOSE, MENTION_OPEN } from './messageFormatter.ts';

export type { EngineHistoryMessage };

// Message types whose history rows carry media. History is fetched WITHOUT media (footprint), so such
// a row arrives with no payload — surface it as the omitted placeholder (📎 Media) instead of an empty
// bubble. The DB copy of a recent message still wins in mergeChatMessages, so its real media is kept.
const HISTORY_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);

// Normalize an engine history message into the DB ChatMessage shape the thread renders. Historical
// messages have no live delivery state, so default to `read` (they are old/already-seen); real status
// for current-session messages still comes from the DB copy and live websocket acks.
export function mapEngineHistoryMessage(h: EngineHistoryMessage): ChatMessage {
  return {
    id: h.id,
    waMessageId: h.id,
    chatId: h.chatId,
    chatName: h.contact?.pushName ?? h.contact?.name,
    author: h.author,
    from: h.from,
    to: h.to,
    body: h.body ?? '',
    type: h.type as MessageType,
    direction: h.fromMe ? 'outgoing' : 'incoming',
    status: 'read',
    timestamp: h.timestamp,
    createdAt: new Date((h.timestamp ?? 0) * 1000).toISOString(),
    metadata: (() => {
      const metadata: ChatMessageView['metadata'] = {};
      if (h.media) {
        metadata.media = h.media;
      } else if (HISTORY_MEDIA_TYPES.has(h.type)) {
        metadata.media = { mimetype: '', omitted: true };
      }
      if (h.quotedMessage) metadata.quotedMessage = h.quotedMessage;
      if (h.call) metadata.call = h.call;
      if (h.poll) metadata.poll = h.poll;
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    })(),
  };
}

const msgKey = (m: ChatMessage): string => m.waMessageId ?? m.id;
const msgTime = (m: ChatMessage): number =>
  typeof m.timestamp === 'number' ? m.timestamp : Math.floor(Date.parse(m.createdAt) / 1000) || 0;

// Merge persisted DB messages with engine history into one ascending thread. The engine fills the
// backfill (history from before the gateway captured anything); the DB copy wins on conflict so the
// real delivery status survives. Deduped by the wweb.js serialized id (engine `id` == DB `waMessageId`).
export function mergeChatMessages(db: ChatMessage[], history: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of [...history, ...db]) {
    const key = msgKey(m);
    const hist = byId.get(key);
    // The DB copy wins (authoritative status) — but a legacy row has no stable sender id, so
    // salvage the engine-history copy's author or two same-named participants collapse into one
    // attribution run in the chat view.
    let merged = hist?.author && !m.author ? { ...m, author: hist.author } : m;
    if (m.type === 'poll' && !m.metadata?.poll && hist?.metadata?.poll) {
      merged = { ...merged, metadata: { ...merged.metadata, poll: hist.metadata.poll } };
    }
    if (m.type === 'revoked' || hist?.type === 'revoked') {
      merged = { ...merged, type: 'revoked', body: '', metadata: undefined };
    }
    byId.set(key, merged);
  }
  const sorted = [...byId.values()].sort((a, b) => msgTime(a) - msgTime(b) || a.createdAt.localeCompare(b.createdAt));
  return capMediaPayloads(sorted);
}

/**
 * Upper bound on base64 media payloads held in ONE chat slice at a time. A slice lives in the
 * React Query cache with staleTime: Infinity, so every image/video/voice note that arrives while
 * the chat is open would otherwise pin its full base64 string in heap for the whole session —
 * scrolling through a media-rich chat grows the tab unboundedly. Past the cap the OLDEST
 * payloads and archived previews are replaced by the omitted marker, which renders
 * the same 📎 placeholder as a history row fetched without media; the newest `keep` stay
 * renderable (thread + lightbox). Count-based (not byte-based): payloads are bounded upstream
 * by the backend's media size cap.
 *
 * The cap bounds the RENDERED set, not the fetch window: useChatMessages pages, so a thread scrolled
 * back far enough holds several 100-row pages and the older payloads inside the scrollable window
 * fall back to the 📎 placeholder, whose download button still works. Do not scale `keep` with the
 * page count to close that gap — the rendered set is exactly where a payload costs a second `data:`
 * URI copy and a decoded bitmap, so scaling removes the bound this exists to enforce.
 */
export const MEDIA_PAYLOAD_CACHE_LIMIT = 100;

/**
 * Enforce MEDIA_PAYLOAD_CACHE_LIMIT on an ascending message list, stripping the oldest payloads
 * first. Returns the input array untouched when already under the cap (stable reference — no
 * downstream re-render), otherwise a new array; entries are copied, never mutated.
 */
export function capMediaPayloads(list: ChatMessageView[], keep = MEDIA_PAYLOAD_CACHE_LIMIT): ChatMessageView[] {
  let payloadCount = 0;
  const retainsMedia = (message: ChatMessageView): boolean => {
    const media = message.metadata?.media;
    return Boolean(
      media?.data || (media?.archived && HISTORY_MEDIA_TYPES.has(message.type) && message.type !== 'document'),
    );
  };
  for (const m of list) if (retainsMedia(m)) payloadCount++;
  if (payloadCount <= keep) return list;

  const next = list.slice();
  let toStrip = payloadCount - keep;
  for (let i = 0; i < next.length && toStrip > 0; i++) {
    const media = next[i].metadata?.media;
    if (!media || !retainsMedia(next[i])) continue;
    next[i] = {
      ...next[i],
      metadata: { ...next[i].metadata, media: { ...media, data: undefined, archived: undefined, omitted: true } },
    };
    toStrip--;
  }
  return next;
}

/**
 * Stable identity of a group message's sender, for attribution runs and sender colors: the
 * participant JID (`author`) when present, falling back to the display name on legacy rows. Keying
 * on this — not the name alone — keeps two participants who share a pushName from collapsing into
 * one run with one color.
 */
export const senderKey = (m: Pick<ChatMessage, 'author' | 'chatName'>): string | undefined => m.author ?? m.chatName;

/**
 * Maps a group participant's numeric id (the local part of their `author` JID, `:device` suffix
 * stripped) to their resolved display name — built from every message in the thread that carries
 * both. An @mention in a message body is just "@<digits>" (WhatsApp never sends a resolved name in
 * the text itself), and those digits are the same id a mentioned participant's OWN messages carry
 * as `author` — so any thread where the mentioned person has posted at least once already has
 * everything needed to resolve the mention, with no separate contact lookup.
 */
export function buildMentionNameMap(messages: Pick<ChatMessage, 'author' | 'chatName'>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m.author || !m.chatName) continue;
    const local = m.author.split('@')[0].split(':')[0];
    // A push name is sender-controlled: strip the span delimiters so a name cannot close its own
    // mention early and hand its tail back to Linkify and the format parser. Backticks go too:
    // parseMessageBody peels code before it sees a mention span, so one in the name would pair
    // with another backtick and split the span the same way.
    const name = m.chatName.replace(MENTION_DELIMITERS, '').replace(/`/g, '').trim();
    // Rows are ascending by time, so the last write is the participant's current push name.
    if (name && !blankMentionName(name) && /^\d+$/.test(local)) map.set(local, name);
  }
  return map;
}

const MENTION_DELIMITERS = new RegExp(`[${MENTION_OPEN}${MENTION_CLOSE}]`, 'g');

/**
 * Drop any span delimiter already present in raw message text. Only resolveMentions may place one:
 * parseMessageBody reads every MENTION_OPEN...MENTION_CLOSE pair as a mention, so a body that
 * carries them itself would lose its formatting and links inside the pair.
 */
export const stripMentionDelimiters = (text: string): string => text.replace(MENTION_DELIMITERS, '');

// Characters that render as nothing yet survive `.trim()`: format controls (zero-width space, soft
// hyphen, word joiner, bidi marks), combining marks, the Hangul fillers and the blank braille
// pattern. A push name made only of these would render as a bare "@".
const INVISIBLE = /[\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/gu;

function blankMentionName(name: string): boolean {
  return name.replace(INVISIBLE, '').trim() === '';
}

// The left boundary is the start of the text or whitespace, optionally followed by a run of opening
// punctuation or format openers (`*_~`), so `*@digits*` resolves into a bold mention the way
// WhatsApp renders it while a `_@digits` or `(@digits` inside a URL does not.
const MENTION_TOKEN = /((?:^|\s)[([{"'*_~]*)@(\d{7,})/gu;

// parseMessageBody peels code after this runs, so a mention inside a code span or block is left as
// digits here: rewriting it would split the span and render its backticks literally.
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`]*`)/;

/**
 * Replace "@<digits>" mention tokens with "@<FirstName>" wherever the digits match a known
 * participant (see buildMentionNameMap). An unmatched token is left exactly as WhatsApp sent it —
 * the same fallback WhatsApp's own official clients show for a participant they can't resolve
 * either, rather than guessing. First name only, matching WhatsApp's own mention convention (a
 * bare "@FirstName Last Name" reads as the mention swallowing following prose).
 *
 * The resolved name is wrapped in MENTION_OPEN/MENTION_CLOSE (private-use-area delimiters
 * messageFormatter.ts's parseMessageBody recognizes as a `mention` node), not spliced in as plain
 * text: a push name is set freely by any WhatsApp user, and MessageBody renders that node as a
 * real <bdi> element outside Linkify's ignoreTags-respected walk, so the name can never become a
 * clickable link (character-stripping alone does not stop linkify-react auto-linking a bare word
 * like "localhost").
 *
 * The left boundary only fires at the start of the text or after whitespace, optionally through
 * a run of opening punctuation or format markers. It never fires after `/` or a word, so a URL
 * with the same digits is left untouched, and digits inside a code span are never rewritten (this
 * runs on the raw body, before parseMessageBody splits out code spans). Right after a closing
 * backtick a bare "@digits" is left as it is, while an opener run such as `*@digits*` or
 * `(@digits` still starts a mention: the span has already been split off, so it cannot break.
 */
export function resolveMentions(raw: string, names: Map<string, string>): string {
  const text = stripMentionDelimiters(raw);
  if (names.size === 0 || !text.includes('@')) return text;
  return text
    .split(CODE_SEGMENT)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(MENTION_TOKEN, (full: string, prefix: string, digits: string) => {
            // A bare `^` only counts at the start of the whole text, not right after a closing
            // backtick; `^` followed by an opener run does (see above).
            if (i > 0 && prefix === '') return full;
            // The first word that renders as something: a name like "\u3164 Bob" is not blank as a
            // whole, but its first word alone would show as a bare "@".
            const first = names
              .get(digits)
              ?.split(' ')
              .find(word => !blankMentionName(word));
            return first ? `${prefix}${MENTION_OPEN}@${first}${MENTION_CLOSE}` : full;
          }),
    )
    .join('');
}

// ChatMessageView extends ChatMessage with the view-only fields the chat page renders.
// Lifted from Chats.tsx so hooks/utils can share the same shape.
export type MessageMedia = {
  mimetype: string;
  filename?: string;
  data?: string;
  omitted?: boolean;
  sizeBytes?: number;
  /**
   * Set alongside `omitted` when MESSAGE_INLINE_MEDIA=archive dropped the inline copy because the
   * chat-media archive holds the bytes, the media route serves them, so the thread previews inline.
   */
  archived?: boolean;
};

export const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  if (media.data.startsWith('data:') || media.data.startsWith('http://') || media.data.startsWith('https://')) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};

export interface ChatMessageView extends ChatMessage {
  metadata?: {
    media?: MessageMedia;
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    call?: { video: boolean; missed: boolean };
    buttons?: Array<{ id: string; text: string }>;
    poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
  };
}

/**
 * Metadata for a live `message.received` / `message.sent` WS payload. Prompt `buttons` arrive
 * top-level on that event (the history route never populates them) and are folded here so the
 * thread renders from `metadata.buttons`, matching persisted DB rows.
 */
export function liveMessageMetadata(msg: {
  media?: MessageMedia;
  quotedMessage?: { id: string; body: string };
  call?: { video: boolean; missed: boolean };
  buttons?: Array<{ id: string; text: string }>;
  poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
  metadata?: ChatMessageView['metadata'];
}): ChatMessageView['metadata'] {
  if (msg.metadata) return msg.metadata;
  const metadata: NonNullable<ChatMessageView['metadata']> = {};
  if (msg.media) metadata.media = msg.media;
  if (msg.quotedMessage) metadata.quotedMessage = msg.quotedMessage;
  if (msg.call) metadata.call = msg.call;
  if (msg.poll) metadata.poll = msg.poll;
  if (msg.buttons?.length) metadata.buttons = msg.buttons;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

// Delivery ticks only ADVANCE, never regress. Live websocket events (incl. a replayed message.sent on
// reconnect) and engine acks can arrive out of order, so a late/duplicate lower status must not visually
// downgrade a row already shown as delivered/read. Mirrors the backend transition rules:
// pending<sent<delivered<read advances by rank; `failed` only applies from pending/sent and is terminal.
const DELIVERY_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
export function mergeDeliveryStatus(
  current: ChatMessageView['status'] | undefined,
  incoming: ChatMessageView['status'] | undefined,
): ChatMessageView['status'] | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current === 'failed') return 'failed'; // terminal — nothing advances from failed
  if (incoming === 'failed') return current === 'pending' || current === 'sent' ? 'failed' : current;
  if (!(incoming in DELIVERY_RANK)) return current; // unknown status — ignore
  if (!(current in DELIVERY_RANK)) return incoming;
  return DELIVERY_RANK[incoming] >= DELIVERY_RANK[current] ? incoming : current;
}

/**
 * The reaction map to store after a `message.reaction` event.
 *
 * The gateway OMITS `reactions` when it holds no stored copy of the message to snapshot from — an
 * ephemeral message, or one that predates the session going live. Absent means "unknown", so the map
 * already on screen survives, including the optimistic reaction the local user just added under the
 * `me` key. An empty object is a different claim: every reaction was withdrawn, and that must clear
 * the badge. `??` draws that line where `||` would not, which is the whole reason this is a named
 * function rather than an inline expression — the socket layer carries the absence through
 * deliberately (useWebSocket.ts) and flattening it anywhere in between makes this dead code.
 */
export function mergeReactionSnapshot(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return incoming ?? existing;
}

/**
 * Merge two metadata bags field-by-field. The incoming copy wins per field only when it actually
 * carries a value — a live `message.sent` echo is built as `{media, quotedMessage, call}` with
 * undefined leaves, and a wholesale `incoming ?? existing` swap would wipe the optimistic bubble's
 * quote/call. Media has one extra rule: an incoming marker WITHOUT the payload (a Baileys API-send
 * echo and the media-less history fetch both emit `{media: {omitted: true}}` with no `data`) must
 * not clobber an existing copy holding the real base64 — the optimistic send bubble is
 * the only copy with the payload until a refetch, and the cache is staleTime: Infinity.
 */
function mergeMessageMetadata(
  existing: ChatMessageView['metadata'],
  incoming: ChatMessageView['metadata'],
): ChatMessageView['metadata'] {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const media = (() => {
    if (!incoming.media) return existing.media;
    if (!existing.media) return incoming.media;
    if (existing.media.data && !incoming.media.data) return existing.media;
    return incoming.media;
  })();
  const merged: NonNullable<ChatMessageView['metadata']> = {};
  if (media) merged.media = media;
  const quotedMessage = incoming.quotedMessage ?? existing.quotedMessage;
  if (quotedMessage) merged.quotedMessage = quotedMessage;
  const reactions = incoming.reactions ?? existing.reactions;
  if (reactions) merged.reactions = reactions;
  const call = incoming.call ?? existing.call;
  if (call) merged.call = call;
  const buttons = incoming.buttons ?? existing.buttons;
  if (buttons?.length) merged.buttons = buttons;
  const poll = incoming.poll ?? existing.poll;
  if (poll) merged.poll = poll;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Append `incoming` to `list`. If an entry with the same identity exists, replace it in place.
 * Identity uses the same `waMessageId ?? id` key as mergeChatMessages — a DB row (id=UUID,
 * waMessageId=WA id) and a live WS message (id=WA id) for the same WhatsApp message must dedupe,
 * not double-add. On replace, the delivery status only advances (a replayed lower `sent` echo can't
 * downgrade a delivered/read row) and metadata is merged per field (a payload-less echo can't erase
 * the existing media/quote — see mergeMessageMetadata). The result is run through capMediaPayloads
 * so a long session of incoming media can't grow the cached slice's base64 heap without bound.
 * Returns a new array — does not mutate the input.
 *
 * Requires an ASCENDING (oldest-first) `list` — the cap strips from the front, so a caller holding
 * a `createdAt DESC` page would need to reverse it first, not call this directly on server order.
 */
export function mergeOrAppend(list: ChatMessageView[], incoming: ChatMessageView): ChatMessageView[] {
  const idx = list.findIndex(m => msgKey(m) === msgKey(incoming));
  if (idx === -1) {
    const message = incoming.type === 'revoked' ? { ...incoming, body: '', metadata: undefined } : incoming;
    return capMediaPayloads([...list, message]);
  }
  const existing = list[idx];
  const next = list.slice();
  next[idx] = {
    ...incoming,
    // An echo that lacks the stable sender id must not erase the one already cached.
    author: incoming.author ?? existing.author,
    status: mergeDeliveryStatus(existing.status, incoming.status) ?? incoming.status,
    metadata: mergeMessageMetadata(existing.metadata, incoming.metadata),
  };
  if (existing.type === 'revoked' || incoming.type === 'revoked') {
    next[idx] = { ...next[idx], type: 'revoked', body: '', metadata: undefined };
  }
  return capMediaPayloads(next);
}

/**
 * Apply a partial patch to the entry whose id matches. No-op if not found.
 */
export function updateMessageById(
  list: ChatMessageView[],
  id: string,
  patch: Partial<ChatMessageView>,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === id);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

/**
 * Filter out the entry with the matching id. No-op if not found.
 */
export function removeMessageById(list: ChatMessageView[], id: string): ChatMessageView[] {
  if (!list.some(m => m.id === id)) return list;
  return list.filter(m => m.id !== id);
}

/** Does this row carry the given WhatsApp identity, under either of the two ids it can be keyed by? */
export const byMessageId =
  (messageId: string) =>
  (m: ChatMessageView): boolean =>
    m.id === messageId || m.waMessageId === messageId;

/**
 * Patch every row a WhatsApp identity names, leaving the array untouched when none match.
 *
 * Every match is patched, not just the first: a paged cache can hold the persisted row and its live
 * copy on different pages (see findRevokedIndex for why the two are keyed differently), and
 * patching only the one the merged view preferred would leave the other stale.
 */
export function patchMatchingMessage(
  list: ChatMessageView[],
  messageId: string,
  patch: (message: ChatMessageView) => ChatMessageView,
): ChatMessageView[] {
  const isMatch = byMessageId(messageId);
  let changed = false;
  const next = list.map(m => {
    if (!isMatch(m)) return m;
    const patched = patch(m);
    if (patched !== m) changed = true;
    return patched;
  });
  return changed ? next : list;
}

/**
 * Locate the message a `message.revoked` event refers to. Returns -1 if it isn't cached.
 *
 * The event carries two candidate ids: `id`, and `revokedId` — the ORIGINAL deleted message, which
 * whatsapp-web.js resolves separately because its revoke event can carry an id of its own that never
 * matches a stored row. Baileys sets the two identically, and wwebjs leaves `revokedId` undefined
 * when the original isn't in its local store.
 *
 * Both candidates are tried rather than preferring `revokedId` (the `revokedId ?? id` shape the
 * backend uses to key its own UPDATE): matching either id is a superset that stays correct whichever
 * of the two the cached row was stored under, so it cannot regress the Baileys path. Each candidate
 * is checked against both the DB row id and `waMessageId` — a live WS message and its persisted copy
 * are keyed differently. `revokedId` is guarded because an undefined one would otherwise match a row
 * whose `waMessageId` is also undefined.
 */
export function findRevokedIndex(list: ChatMessageView[], event: { id: string; revokedId?: string }): number {
  const byId = byMessageId(event.id);
  const byRevokedId = event.revokedId !== undefined ? byMessageId(event.revokedId) : undefined;
  return list.findIndex(m => byId(m) || (byRevokedId?.(m) ?? false));
}

/**
 * Replace the displayed body of a cached WhatsApp message after a `message.edited` event. Both id
 * candidates are matched, for the reason given on findRevokedIndex. Returns the original array on
 * a miss.
 */
export function applyMessageEdit(
  list: ChatMessageView[],
  event: { messageId: string; body: string },
): ChatMessageView[] {
  if (!event.messageId) return list;
  const idx = list.findIndex(byMessageId(event.messageId));
  if (idx === -1 || list[idx].type === 'revoked') return list;
  const next = list.slice();
  next[idx] = { ...next[idx], body: event.body };
  return next;
}
