import type { Chat, Contact as BaileysContact, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { ChatSummary, Contact, MessageType } from '../interfaces/whatsapp-engine.interface';
import { chatKind, parseWaId, toNeutralJid as canonicalizeWaId, userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import { mergeTwinStates, type ChatStateStore, type ChatStateValue } from './baileys-chat-state-store.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { baileysChatJid, baileysMessageText } from './baileys-message-mapper';

interface LastMessage {
  key: WAMessageKey;
  timestamp: number;
  text: string;
  type?: MessageType;
  /** Where the message stands in the order this session observed them, which settles a tie in `timestamp`. */
  order: number;
}

// Default per-map entry cap, matching the other per-session bounds (LID_MAPPING_CACHE_MAX,
// BAILEYS_MESSAGE_STORE_LIMIT, the session lidPhoneCache — all 5000). Every read below has a defined
// miss path, so an eviction only costs a re-resolution/re-read, never data loss.
export const SESSION_STORE_MAP_CAP_DEFAULT = 5000;

/**
 * Insertion-ordered Map with an LRU cap, the same discipline as LidMappingStoreService: a read or
 * write re-inserts the key at the most-recent end, and a set evicts the least-recently-used entry
 * while over `max`. `max = 0` means unbounded.
 *
 * `pinned` marks entries eviction may never take. It exists for the contacts map, where two
 * populations share one structure: the account's own address book, which the operator curated and
 * which the API reports, and a much larger stream of peers seen once in a group or a broadcast.
 * Without it the second evicts the first.
 *
 * The cap then governs the UNPINNED population alone, which is the one that grows from peer traffic.
 * Counting the whole map instead would make a full address book evict each new peer in the same call
 * that inserted it, so peers would stop being cached at all once the saved set reached the cap. The
 * pinned side is bounded by the account's own contact list rather than by this number.
 */
class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  /** Entries the predicate does not protect. The cap is measured against exactly these. */
  private unpinned = 0;

  constructor(
    private readonly max: number,
    private readonly pinned?: (value: V) => boolean,
  ) {}

  private isPinned(value: V): boolean {
    return this.pinned ? this.pinned(value) : false;
  }

  /** Remove a key while keeping {@link unpinned} honest. No-op for a key that is not held. */
  private drop(key: K): void {
    if (!this.map.has(key)) {
      return;
    }
    if (!this.isPinned(this.map.get(key) as V)) {
      this.unpinned--;
    }
    this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): void {
    this.drop(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.drop(key);
    this.map.set(key, value);
    if (!this.isPinned(value)) {
      this.unpinned++;
    }
    if (!this.max) {
      return;
    }
    while (this.unpinned > this.max) {
      const victim = this.oldestEvictable();
      if (victim === undefined) {
        break; // unreachable while unpinned > 0, and a safe stop if it ever is not
      }
      this.drop(victim);
    }
  }

  /**
   * The least-recently-used entry an eviction may take, or undefined when every entry is pinned.
   * Without a `pinned` predicate this is the map head, as before.
   */
  private oldestEvictable(): K | undefined {
    if (!this.pinned) {
      const oldest = this.map.keys().next().value;
      return oldest;
    }
    for (const [key, value] of this.map) {
      if (!this.pinned(value)) {
        return key;
      }
    }
    return undefined;
  }

  /**
   * LIVE iterator, not a snapshot. {@link get} re-inserts a hit to keep recency order, so a loop
   * whose body reads this map through any path is handed the same entry forever. Copy first
   * (`[...map.values()]`) whenever the body can reach back into the map.
   */
  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** LIVE iterator with the same caveat as {@link values}. */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

/**
 * A chat deletion this process saw, shared by every key the chat's state can sit under. `order` is the
 * observation order when it arrived (see {@link BaileysSessionStore.nextMessageOrder}), which is what tells
 * a message from the deletion's own second apart: a whole-second timestamp cannot.
 */
interface DeletionMark {
  at: number;
  order: number;
  /** The keys the mark is written under in the chat-state store. */
  stateKeys: string[];
  /** Set once a newer message re-created the chat. */
  cleared: boolean;
}

/** A projected contact with the raw store key it came from, so twins can be folded deterministically. */
interface ContactTwin {
  contact: Contact;
  rawId: string;
}

/** True for a store key in the phone dialect, i.e. the twin that carries a phone number of its own. */
function isPhoneKeyed(rawId: string): boolean {
  return rawId.endsWith('@s.whatsapp.net') || rawId.endsWith('@c.us');
}

/**
 * Fold two store entries that project to the same person into one row.
 *
 * Neither side is more correct by position: the store is LRU-ordered, so iteration order tracks
 * traffic, and letting it decide meant `GET /contacts` answered with whichever twin had been quiet
 * and dropped a pushname the other had just learned, flipping back later. So a field absent on one
 * side is filled from the other, and for a field both carry the phone-dialect twin wins, which is
 * the entry {@link BaileysSessionStore.findContact} already answers with for the same id. When
 * neither or both are phone-keyed, the lower raw key wins: arbitrary, but stable across calls.
 */
function mergeContactTwins(a: ContactTwin, b: ContactTwin): ContactTwin {
  const aWins = isPhoneKeyed(a.rawId) !== isPhoneKeyed(b.rawId) ? isPhoneKeyed(a.rawId) : a.rawId <= b.rawId;
  const [primary, secondary] = aWins ? [a, b] : [b, a];
  return {
    rawId: primary.rawId,
    contact: {
      id: primary.contact.id,
      name: primary.contact.name ?? secondary.contact.name,
      pushName: primary.contact.pushName ?? secondary.contact.pushName,
      number: primary.contact.number || secondary.contact.number,
      isMyContact: primary.contact.isMyContact || secondary.contact.isMyContact,
      isBlocked: primary.contact.isBlocked || secondary.contact.isBlocked,
      profilePicUrl: primary.contact.profilePicUrl ?? secondary.contact.profilePicUrl,
    },
  };
}

/**
 * Per-session, in-memory snapshot of Baileys contacts + chats, fed from `sock.ev` events and mapped to
 * the neutral `Contact`/`ChatSummary` on read. Holds no socket, pure data. Baileys has no fetch-all,
 * and `messaging-history.set` arrives only on the first link: once the account has synced, WhatsApp
 * skips history sync on every later connect (see BaileysHistory.hydrateNames). A new engine (a process
 * restart, a session stop and start, a reconnect the gateway runs itself) therefore starts with no
 * chats: the groups hydrateNames re-fetches on every open come back at once, a chat with a persisted
 * mute, archive or pin (ChatStateStore) is listed from that row, and any other 1:1 chat comes back with
 * its next message, since Baileys emits `chats.update` for every real message. Contacts are rebuilt
 * from the address-book snapshot instead.
 *
 * Every map is LRU-bounded (`BAILEYS_SESSION_STORE_MAX_ENTRIES`, default 5000 per map, 0 = unbounded)
 * because contacts/chats/lastMessages/lidToPn all grow from peer-controlled traffic — without a cap a
 * chatty account leaks one entry per distinct peer ever seen. On the contacts map that cap governs the
 * peers ALONE: a contact carrying a saved name is pinned and never evicted, because it comes from the
 * account's own address book rather than from traffic, and that side is bounded by the address book
 * instead (see LruMap's `pinned`). Miss paths after an eviction:
 * `lidToPn` falls back to the contacts map and then the persisted cross-session lid->phone table (all
 * writes are written through), `lastMessage` reads null (callers treat it as "nothing known"),
 * `getEphemeralExpiration` falls back to `Chat.ephemeralExpiration` then undefined (never forces a
 * timer), and contact/name lookups degrade to the raw user-part. `ephemeralByChat` is keyed under both
 * the raw and neutral JID (two entries per chat), so its cap is doubled to cover the same number of
 * chats.
 */
export class BaileysSessionStore {
  private readonly contacts: LruMap<string, BaileysContact>;
  private readonly chats: LruMap<string, Chat>;
  private readonly lastMessages: LruMap<string, LastMessage>;
  /**
   * The newest message each chat RECEIVED, kept apart from the preview because a read receipt can
   * only acknowledge a message the other side sent: Baileys drops an own key from the receipt, so
   * answering with the preview after an API reply sent nothing while the route reported success.
   * An evicted entry reads null, which the receipt path answers as "nothing known".
   */
  private readonly lastInbound: LruMap<string, { key: WAMessageKey; timestamp: number; order: number }>;
  private messageOrder = 0;
  private readonly lidToPn: LruMap<string, string>;
  /**
   * Per-chat disappearing-messages timer (seconds) learned from inbound messages (#473), the reliable
   * source for it: `Chat.ephemeralExpiration` (from `chats.*`/history sync) is empirically absent for a
   * long-standing timer after a reconnect (observed live: 0 of 159 cached chats carried it). Keyed by
   * both the raw and neutral JID so an outbound send addressed in either dialect (phone `@c.us` /
   * `@s.whatsapp.net` or `@lid`) resolves to the same entry. See {@link extractEphemeralDuration} for
   * which message field is read.
   */
  private readonly ephemeralByChat: LruMap<string, number>;
  /**
   * When the timer {@link ephemeralByChat} holds was set, as the chat update that applied it reported it
   * (`ephemeralSettingTimestamp`, epoch seconds), under the same keys. Kept across a deletion like the timer.
   */
  private readonly timerSetAt: LruMap<string, number>;
  /**
   * The chat deletions this process saw, under every spelling. The chat-state store writes the mark on its
   * own queue, so a message recorded before the write lands is judged against this copy, and a mark a newer
   * message cleared stays cleared here while the store's forget is still on its way.
   */
  private readonly deletionMarks: LruMap<string, DeletionMark>;
  /**
   * Chat updates refused in their deletion's own second, by the id of the message each announces, with that
   * deletion. The update a new message brings can come before the message is recorded, and only the record
   * tells whether the message came after the deletion (see {@link recordMessage}).
   */
  private readonly heldChatUpdates: LruMap<string, { mark: DeletionMark; chatId: string; update: Partial<Chat> }>;

  /**
   * @param lidStore       optional persisted, cross-session lid->phone table that backs resolution beyond
   *                       this session's in-memory map (survives restarts, shared across sessions).
   * @param sessionId      recorded on rows this session writes to the persisted tables (a lid row's owner).
   * @param chatStateStore optional persisted per-session mute/archive/pin, so those chat fields survive a
   *                       reconnect Baileys cannot resync (it only re-emits mutations newer than the
   *                       persisted app-state version, never an already-applied one).
   */
  constructor(
    private readonly lidStore?: LidMappingStore,
    private readonly sessionId?: string,
    private readonly chatStateStore?: ChatStateStore,
  ) {
    // Mirrors LidMappingStoreService: a finite default, 0 opts back into unbounded, garbage falls back.
    const maxEntries = resolveNonNegativeIntEnv(
      process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES,
      SESSION_STORE_MAP_CAP_DEFAULT,
    );
    // A saved name only ever arrives from the account's own app-state address book, never from peer
    // traffic, so pinning on it keeps the curated set out of reach of the peers this session happens
    // to observe. The pinned population is bounded by the account's own contact list.
    this.contacts = new LruMap(maxEntries, contact => Boolean(contact.name));
    this.chats = new LruMap(maxEntries);
    this.lastMessages = new LruMap(maxEntries);
    this.lastInbound = new LruMap(maxEntries);
    this.lidToPn = new LruMap(maxEntries);
    // Double-keyed (raw + neutral JID per chat), so it needs two slots per chat to cover the same span.
    this.ephemeralByChat = new LruMap(maxEntries * 2);
    this.timerSetAt = new LruMap(maxEntries * 2);
    this.deletionMarks = new LruMap(maxEntries);
    this.heldChatUpdates = new LruMap(maxEntries);
  }

  upsertContacts(records: Partial<BaileysContact>[] = []): void {
    for (const r of records) {
      // History-sync / app-state rows sometimes key the person as `lid` and leave `id` empty.
      const id = r.id ?? r.lid;
      if (!id) {
        continue;
      }
      // Groups/newsletters/status arrive in the same history-sync contact array as people; they
      // are not address-book entries and must not occupy the contact cap or GET /contacts.
      const kind = parseWaId(id).kind;
      if (kind === 'group' || kind === 'newsletter' || kind === 'broadcast' || kind === 'status') {
        continue;
      }
      const existing = this.contacts.get(id) ?? { id };
      const merged: BaileysContact = { id: existing.id };
      this.assignDefined(merged, existing);
      this.assignDefined(merged, { ...r, id });
      this.contacts.set(id, merged);
      // Capture a lid->phone pair from the merged record (lid + phone can arrive in separate updates).
      // `phoneNumber` is the authoritative PN field; fall back to `id` itself only when it's already
      // in the phone dialect (a lid-only contact's `id` is `<lid>@lid`, which is not a usable phone).
      // A record keyed by its lid carries the lid side in `id` and usually has no `lid` field.
      // A name-only update carries no new pair and must not write an older merged phone over the shared table.
      const phone = merged.phoneNumber ?? (merged.id.endsWith('@s.whatsapp.net') ? merged.id : undefined);
      const lid = merged.lid ?? (parseWaId(merged.id).kind === 'lid' ? merged.id : undefined);
      if (lid && phone && (r.lid !== undefined || r.phoneNumber !== undefined)) {
        this.lidToPn.set(lid, phone);
        this.persistLidMapping(lid, phone, r.phoneNumber !== undefined || kind === 'user');
      }
    }
  }

  /**
   * Copy own enumerable fields whose value is not `undefined`. History-sync contacts always include
   * `name: displayName || name || username || undefined`, and a later `{ ...existing, ...partial }`
   * spread would wipe a saved address-book name that arrived first via `contacts.upsert`.
   *
   * KNOWN LIMIT: a saved name therefore cannot be cleared, so a contact deleted or renamed blank on
   * the phone keeps its old name here, stays in `GET /contacts`, and (being named) is pinned against
   * eviction. Making an absent name authoritative is NOT a safe fix on its own: the same method
   * serves `contacts.update`, which Baileys emits as `{ id, notify }` for the pushname on every
   * inbound message, so absent-means-clear there would wipe the address book message by message.
   * Only an app-state `contactAction` could carry that meaning, and whether WhatsApp expresses a
   * deletion as a contactAction with empty fields is unverified here; settling it needs a live
   * account, not a guess on this path.
   */
  private assignDefined(target: BaileysContact, source: Partial<BaileysContact>): void {
    for (const key of Object.keys(source) as (keyof BaileysContact)[]) {
      const value = source[key];
      if (value !== undefined) {
        (target as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  upsertChats(records: Partial<Chat>[] = []): void {
    // A phone's twins come from a walk of every lid mapping, and a history chunk can carry thousands of chats
    // with a timer: their timer keys read one index of the mappings, built for the batch (the loop adds none).
    const lidIndex = records.some(c => Object.hasOwn(c, 'ephemeralExpiration')) ? this.lidKeysByPhone() : undefined;
    for (const record of records) {
      const r = this.withoutStaleTimer(record, lidIndex);
      if (!r.id) {
        continue;
      }
      // A chat WhatsApp deleted takes no update until a message re-creates it: Baileys applies an own
      // write locally (a mute or pin is sent without a message), and a reconnect resyncs a deletion before
      // an archive or pin made ahead of it. Kept, either would show on the chat a later message re-creates.
      const timestamp = this.toUnixSeconds(r.conversationTimestamp);
      if (this.stillDeleted(r.id, timestamp)) {
        // Except its disappearing timer, which WhatsApp keeps across a deletion, as this store does: a timer
        // turned off while the chat is deleted comes with no message. A held update's timer is applied now.
        this.applyChatTimer(r.id, r, lidIndex);
        // The update of a message from the deletion's own second waits for that message's record.
        const messageId = r.messages?.[0]?.message?.key?.id;
        const mark = messageId ? this.deletionMark(this.markKeys(r.id)) : undefined;
        if (messageId && mark && timestamp === Math.floor(mark.at / 1000)) {
          this.heldChatUpdates.set(messageId, { mark, chatId: r.id, update: r });
        }
        continue;
      }
      const existing = this.chats.get(r.id) ?? { id: r.id };
      this.chats.set(r.id, { ...existing, ...r });
      this.persistChatState(r.id, r);
      this.applyChatTimer(r.id, r, lidIndex);
    }
  }

  /**
   * A timer the chat itself reports (Baileys emits the EPHEMERAL_SETTING change as chats.update) is
   * newer than the one learned from messages, and turning the timer off produces no stamped message
   * that could clear it. Own key only, as in persistChatState: history-sync proto defaults are not news.
   * Every twin: own sends cache the timer under the phone spelling of a chat Baileys keys by its lid,
   * and a twin chat record would otherwise serve the old timer from the getEphemeralExpiration fallback.
   * Only the cache and twin records that exist are written: no record is created and nothing persisted.
   */
  private applyChatTimer(chatId: string, r: Partial<Chat>, lidIndex?: Map<string, string[]>): void {
    if (!Object.hasOwn(r, 'ephemeralExpiration')) return;
    const exp = r.ephemeralExpiration;
    const setAt = this.toUnixSeconds(r.ephemeralSettingTimestamp);
    for (const key of this.timerKeys(chatId, lidIndex)) {
      if (typeof exp === 'number' && exp > 0) {
        this.ephemeralByChat.set(key, exp);
      } else {
        this.ephemeralByChat.delete(key);
      }
      if (setAt) this.timerSetAt.set(key, setAt);
      const twin = key === chatId ? undefined : this.chats.get(key);
      if (twin) this.chats.set(key, { ...twin, ephemeralExpiration: exp });
    }
  }

  /**
   * The keys a chat's timer is cached, compared and read under: every twin, raw and neutral. A phone the cache
   * maps to more than one lid (a recycled number) belongs to no one chat, and through it one holder's timer would
   * be read, compared and written as the other's, so then only the chat's own spellings are used.
   */
  private timerKeys(chatId: string, lidIndex?: Map<string, string[]>): Set<string> {
    const twins = this.chatTwins(chatId, lidIndex);
    const own = parseWaId(chatId);
    const keys = this.phoneOfManyLids(twins, lidIndex)
      ? twins.filter(k => {
          const id = parseWaId(k);
          return id.kind === own.kind && id.userPart === own.userPart;
        })
      : twins;
    return new Set(keys.flatMap(k => [k, this.toNeutralJid(k)]));
  }

  /** Whether the cache maps the phone among a chat's twins (its own number, or its lid's) to more than one lid. */
  private phoneOfManyLids(twins: string[], lidIndex?: Map<string, string[]>): boolean {
    const phone = twins.find(k => parseWaId(k).kind === 'user');
    if (!phone) return false;
    const lids = new Set(
      this.chatTwins(phone, lidIndex)
        .map(k => parseWaId(k))
        .flatMap(id => (id.kind === 'lid' ? [id.userPart] : [])),
    );
    return lids.size > 1;
  }

  /**
   * The update without its timer when it reports a setting older than the one applied for the chat: a history
   * record snapshotted before the timer changed can arrive after the change, also once the chat is deleted. An
   * update that names no setting time is taken as before. A copy, so the library's event payload is untouched.
   */
  private withoutStaleTimer(r: Partial<Chat>, lidIndex?: Map<string, string[]>): Partial<Chat> {
    const setAt = this.toUnixSeconds(r.ephemeralSettingTimestamp);
    if (!r.id || !setAt || !Object.hasOwn(r, 'ephemeralExpiration')) return r;
    if (![...this.timerKeys(r.id, lidIndex)].some(k => (this.timerSetAt.get(k) ?? 0) > setAt)) return r;
    const kept = { ...r };
    delete kept.ephemeralExpiration;
    delete kept.ephemeralSettingTimestamp;
    return kept;
  }

  /**
   * Drop chats Baileys reports deleted (`chats.delete`: an API delete replayed locally, or one made on
   * the phone), with their preview and last inbound message, under every spelling: the id comes from
   * the app-state index, which need not be the twin the chat or its messages are keyed under. The
   * persisted mute/archive/pin is reset and the row marks the deletion ({@link chatDeletedAt}): WhatsApp
   * keeps nothing of the chat while the gateway keeps its stored messages, and a write keyed to one of
   * them comes back from Baileys as an update of the chat, which would list it again.
   */
  removeChats(ids: string[] = []): void {
    const keys = new Set(ids.flatMap(id => this.chatTwins(id)));
    for (const key of keys) {
      this.chats.delete(key);
      this.lastMessages.delete(key);
      this.lastInbound.delete(key);
    }
    if (keys.size && this.chatStateStore && this.sessionId) {
      // Each chat folds its own twins: one event can delete several chats.
      const twinsOf = new Map<string, Set<string>>();
      for (const id of ids) {
        const key = this.stateKey(id);
        twinsOf.set(key, new Set([...(twinsOf.get(key) ?? []), ...this.chatTwins(id)]));
      }
      const at = Date.now();
      // One mark per chat, so a message re-creating one chat of the event leaves the others deleted. Entries
      // whose spellings meet are one chat, named by its lid and its phone before the two resolve alike.
      const marks = new Map<string, DeletionMark>();
      for (const [key, twins] of twinsOf) {
        const spellings = new Set([key, ...twins, ...[...twins].map(twin => this.stateKey(twin))]);
        const met = new Set([...spellings].flatMap(k => marks.get(k) ?? []));
        const stateKeys = [key, ...[...met].flatMap(m => m.stateKeys)];
        const mark: DeletionMark = { at, order: this.messageOrder, stateKeys, cleared: false };
        for (const [k, m] of marks) if (met.has(m)) spellings.add(k);
        for (const k of spellings) marks.set(k, mark);
      }
      for (const [k, mark] of marks) this.deletionMarks.set(k, mark);
      void this.markDeleted(this.chatStateStore, this.sessionId, ids, keys, twinsOf, at);
    }
  }

  /**
   * The marked row is written under the chat's state key, folding the rows of the known twins onto it,
   * queued ahead of any later write. The in-memory mappings can lack the lid or phone twin after a
   * restart, and a delete is never retried, so the twins only the mapping table pairs are forgotten
   * after: a row there would outlive the deletion and put the chat back in the listing.
   *
   * Baileys reports a deletion by ids alone, so it is dated on arrival. One synced on a reconnect is
   * dated later than it happened: a message delivered in the same reconnect counts as older, and the
   * chat stays unlisted, its writes declined, until the next one.
   */
  private async markDeleted(
    store: ChatStateStore,
    sessionId: string,
    ids: string[],
    keys: Set<string>,
    twinsOf: Map<string, Set<string>>,
    deletedAt: number,
  ): Promise<void> {
    const reset = { muteEndTime: null, archived: false, pinned: false, deletedAt };
    const marked = Promise.all(
      [...twinsOf].map(([key, twins]) =>
        store.fold(
          sessionId,
          key,
          [...twins].filter(k => !twinsOf.has(k)),
          reset,
        ),
      ),
    );
    const extra = new Set<string>();
    for (const id of ids) {
      const parsed = parseWaId(id);
      try {
        if (parsed.kind === 'lid') {
          const phone = await this.lidStore?.findPhoneForLid?.(id);
          if (phone) extra.add(`${userPart(phone)}@s.whatsapp.net`);
        } else if (parsed.kind === 'user') {
          for (const lid of (await this.lidStore?.findLidsForPhone?.(parsed.userPart)) ?? []) extra.add(`${lid}@lid`);
        }
      } catch {
        // The table cannot be read; the keys the caches knew are already going.
      }
    }
    await marked;
    const missed = [...extra].filter(k => !keys.has(k) && !twinsOf.has(k));
    if (missed.length) await store.forget(sessionId, missed);
  }

  /**
   * When WhatsApp deleted the chat (epoch ms), read from its persisted state under any spelling, or
   * null when it did not, or a message has re-created the chat since. A message sent at or before it
   * belongs to the deleted chat.
   */
  chatDeletedAt(chatId: string): number | null {
    const recordIds = this.chatTwins(chatId);
    return this.deletedAtOf(this.stateKeys(chatId, recordIds), this.chatState(chatId, recordIds)?.deletedAt);
  }

  /** The deletion the readers go by: this process's own record of it when there is one, else the persisted mark. */
  private deletedAtOf(keys: string[], persisted: number | null | undefined): number | null {
    const mark = this.deletionMark(keys);
    if (mark) return mark.cleared ? null : mark.at;
    return persisted ?? null;
  }

  private deletionMark(keys: string[]): DeletionMark | undefined {
    for (const key of keys) {
      const mark = this.deletionMarks.get(key);
      if (mark) return mark;
    }
    return undefined;
  }

  /**
   * Whether the chat is marked deleted for a message or chat update dated `timestamp` (epoch seconds, 0
   * for none). A message newer than the deletion re-creates the chat on WhatsApp, as a new chat, so its
   * marked row goes and the answer is false. Only the rows a mark can sit under are read, the state key
   * and the lids the jid and the persisted table name: an empty index skips the scan of this session's
   * mappings, too slow to run for each of the thousands of messages a first sync records.
   */
  private stillDeleted(jid: string, timestamp: number, order?: number): boolean {
    const store = this.chatStateStore;
    const sid = this.sessionId;
    if (!store || !sid) return false;
    const lookup = this.markKeys(jid);
    const mark = this.deletionMark(lookup);
    if (mark) {
      if (mark.cleared) return false;
      // A live message observed after the deletion is newer than it, also within the deletion's own second.
      const observedAfter = order !== undefined && order > mark.order && timestamp === Math.floor(mark.at / 1000);
      if (timestamp * 1000 <= mark.at && !observedAfter) return true;
      mark.cleared = true;
      // Named rather than read back: the mark may not have reached the store yet, and the forget queues behind it.
      void store.forget(sid, [...new Set([...mark.stateKeys, ...lookup])]);
      return false;
    }
    const rows = lookup.flatMap(k => {
      const value = store.get(sid, k);
      return value ? [{ k, value }] : [];
    });
    const deletedAt = mergeTwinStates(rows.map(r => r.value))?.deletedAt;
    if (!deletedAt) return false;
    if (timestamp * 1000 <= deletedAt) return true;
    void store.forget(
      sid,
      rows.map(r => r.k),
    );
    return false;
  }

  /** The keys a deletion of the chat can be marked under: its state key and the lids its rows can sit under. */
  private markKeys(jid: string): string[] {
    const key = this.stateKey(jid);
    return [key, ...this.stateTwins([jid], key, new Map())];
  }

  addLidMappings(mappings: { lid?: string; pn?: string }[] = [], isReported = true): void {
    for (const m of mappings) {
      if (m.lid && m.pn) {
        this.lidToPn.set(m.lid, m.pn);
        this.persistLidMapping(m.lid, m.pn, isReported);
      }
    }
  }

  /**
   * Learn lid->pn mappings from an inbound message key (#362). Baileys v7 replaced the 6.7.x
   * `senderLid`/`senderPn`/`participantLid`/`participantPn` fields with `remoteJidAlt` (DM) and
   * `participantAlt` (group) — the "Alt" is always the other dialect of the same field
   * (`remoteJid`/`participant`): if one side is `@lid`, the Alt is the phone JID, and vice versa. This
   * is still the only place a fresh `@lid` sender's number is revealed on the message key itself; the
   * pairs flow through addLidMappings, so they also write through to the persistent table.
   */
  recordKeyLidMappings(
    key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt' | 'participant' | 'participantAlt' | 'fromMe'>,
  ): void {
    // On a status or broadcast-list message `remoteJidAlt` is the SENDER's other dialect (Baileys fills
    // it for every non-group chat), so it pairs with `participant`, not with the `@broadcast` id.
    const broadcast = key.remoteJid?.endsWith('@broadcast');
    this.addLidMappings([
      // Own-message remoteJid can name the recipient while senderAlt still names this account.
      key.fromMe === true ? {} : this.lidPnPair(broadcast ? key.participant : key.remoteJid, key.remoteJidAlt),
      this.lidPnPair(key.participant, key.participantAlt),
    ]);
  }

  /**
   * Sorts a JID and its WhatsApp-supplied "Alt" counterpart into { lid, pn } by @lid suffix. The pn side
   * must be a user id: anything else (a group, a list) would be persisted as that lid's phone number.
   */
  private lidPnPair(jid?: string | null, alt?: string | null): { lid?: string; pn?: string } {
    if (!jid || !alt) {
      return {};
    }
    const [lid, pn] = jid.endsWith('@lid') ? [jid, alt] : alt.endsWith('@lid') ? [alt, jid] : [];
    return lid && pn && parseWaId(pn).kind === 'user' ? { lid, pn } : {};
  }

  /** Write a learned lid->phone pair through to the persistent table (bare digits, fire-and-forget). */
  private persistLidMapping(lidJid: string, pnJid: string, isReported: boolean): void {
    if (isReported) void this.lidStore?.remember(userPart(lidJid), userPart(pnJid), this.sessionId);
    else void this.lidStore?.rememberIfUnknown?.(userPart(lidJid), userPart(pnJid), this.sessionId);
  }

  /**
   * The next place in the observed order. A live message takes its place on arrival, before the media
   * download and the store reads that can let a later one finish first; history, which has none, records 0.
   */
  nextMessageOrder(): number {
    return ++this.messageOrder;
  }

  recordMessage(msg: WAMessage, type?: MessageType, order = this.nextMessageOrder()): void {
    const chatId = msg.key?.remoteJid;
    if (!chatId || !msg.key) {
      return;
    }
    // Learn the chat's disappearing-messages timer from the message itself (#473). This runs before the
    // newest-message guard so every inbound refreshes it; the timer is cached under both the raw and
    // neutral JID so an outbound send addressed in either dialect (phone or @lid) finds it.
    this.recordEphemeralFromMessage(chatId, msg);
    // A received broadcast-list message previews in its sender's chat, where Baileys lists it.
    const key = this.toEngineJid(baileysChatJid(chatId, msg.key.participant, msg.key.fromMe === true));
    const timestamp = this.toUnixSeconds(msg.messageTimestamp);
    // Recorded either way: the readers skip a message from before the deletion, and a newer one clears it.
    this.stillDeleted(key, timestamp, order);
    const messageId = msg.key.id ?? '';
    const held = this.heldChatUpdates.get(messageId);
    if (held) {
      this.heldChatUpdates.delete(messageId);
      // Its chat update came first and was refused; the message came after that deletion, so the chat takes it,
      // beneath what was written to the chat since, as though it had been applied when it came. Not once the
      // chat was deleted again: the message belongs to the conversation that deletion removed.
      const { mark, chatId, update } = held;
      if (mark.cleared && order > mark.order && this.deletionMark(this.markKeys(chatId)) === mark) {
        if (this.chatTwins(chatId).some(k => this.chats.has(k))) {
          this.chats.set(chatId, { ...this.withoutStaleTimer(update), ...this.chats.get(chatId) });
        } else {
          this.upsertChats([update]);
        }
      }
    }
    if (!msg.key.fromMe) {
      const inbound = this.lastInbound.get(key);
      if (
        !inbound ||
        inbound.timestamp < timestamp ||
        (inbound.timestamp === timestamp && this.followsOther(msg, order, inbound))
      ) {
        this.lastInbound.set(key, { key: msg.key, timestamp, order });
      }
    }
    const existing = this.lastMessages.get(key);
    if (
      existing &&
      (existing.timestamp > timestamp || (existing.timestamp === timestamp && !this.followsOther(msg, order, existing)))
    ) {
      return; // keep the newest
    }
    // The text the message was announced with: inside a disappearing chat's or a view-once envelope, and a
    // photo's, video's or document's caption. A deleted message previews nothing, whatever it held.
    const text = type === 'revoked' ? '' : baileysMessageText(msg.message);
    this.lastMessages.set(key, { key: msg.key, timestamp, text, type, order });
  }

  /**
   * Whether a message sent in the same second as `other` came after it. Timestamps have a resolution of
   * a second, so two messages of a burst tie; the order they were observed in decides, and a repeat of
   * the same message (a redelivery) is no later than itself.
   */
  private followsOther(msg: WAMessage, order: number, other: { key: WAMessageKey; order: number }): boolean {
    return !!msg.key.id && other.key.id !== msg.key.id && order > other.order;
  }

  /**
   * Refresh the chat preview when (and only when) the edited message is still the latest message in
   * that chat. Editing an older message must not replace the preview or reorder the conversation. The
   * preview may sit on any twin of the chat, the one the listing reads included, so each is checked.
   * `accept`, when given, judges the key the preview holds: a change it refuses leaves the preview alone.
   */
  recordMessageEdit(
    chatId: string,
    messageId: string,
    text: string,
    type?: MessageType,
    accept?: (key: WAMessageKey) => boolean,
  ): void {
    if (!messageId) return;
    for (const key of new Set([chatId, this.toEngineJid(chatId)])) {
      const existing = this.lastMessages.get(key);
      if (existing?.key.id === messageId && (!accept || accept(existing.key)))
        this.lastMessages.set(key, { ...existing, text, type: type ?? existing.type });
    }
  }

  /**
   * The key a chat's preview is kept under, for an id in any dialect. One conversation reaches this
   * store as `<phone>@c.us` (the API and the listing), `<phone>@s.whatsapp.net` and `<lid>@lid`
   * (Baileys, which addresses a lid-migrated contact by its lid and sends to whatever it is given).
   * Keying each spelling separately left an API send or an inbound message on a twin the chat row
   * never reads, so the chat showed no preview and chat actions found no history. The chat record
   * decides: the twin Baileys keyed the chat under wins, then a twin that already holds a preview,
   * and a chat known under neither falls back to the engine dialect.
   */
  private chatKey(jid: string): string {
    if (this.chats.has(jid)) return jid;
    const twins = this.chatTwins(jid);
    return twins.find(k => this.chats.has(k)) ?? twins.find(k => this.lastMessages.has(k)) ?? this.toEngineJid(jid);
  }

  /**
   * The `<lid>@lid` this session knows for a 1:1 chat or a person, under any spelling of it, or null
   * when none is known (and always for a group). WhatsApp keys a lid-migrated contact's chat by its lid.
   */
  lidOf(jid: string): string | null {
    for (const twin of this.chatTwins(jid)) {
      const parsed = parseWaId(twin);
      if (parsed.kind === 'lid') return `${parsed.userPart}@lid`;
    }
    return null;
  }

  /**
   * Every spelling of one chat this session can connect: the id, its engine form, and its lid or phone twin.
   * `lidIndex` ({@link lidKeysByPhone}) answers a phone's mapped lids in place of a walk of every mapping.
   */
  chatTwins(jid: string, lidIndex?: Map<string, string[]>): string[] {
    const parsed = parseWaId(jid);
    const twins = [jid, this.toEngineJid(jid)];
    if (parsed.kind === 'lid') {
      twins.push(`${parsed.userPart}@lid`);
      const phone = this.resolvePhone(jid);
      if (phone) twins.push(`${phone}@s.whatsapp.net`);
    } else if (parsed.kind === 'user') {
      if (lidIndex) {
        twins.push(...(lidIndex.get(parsed.userPart) ?? []));
      } else {
        for (const [lid, pn] of this.lidToPn.entries()) {
          if (userPart(pn) === parsed.userPart) twins.push(lid);
        }
      }
      for (const lid of this.lidStore?.lidsForPhone(parsed.userPart) ?? []) twins.push(`${lid}@lid`);
    }
    return twins;
  }

  /**
   * Cache a positive disappearing-messages timer learned from an inbound message under both the raw chat
   * JID and its neutral form, so {@link getEphemeralExpiration} hits regardless of which dialect the caller
   * sends to. A non-positive/absent value means "no live timer on this message" and is left untouched (a
   * single non-ephemeral message must not clear a known timer; WhatsApp keeps stamping it while on).
   * A message no newer than the chat's last timer change (`ephemeralSettingTimestamp`, on any twin) is
   * skipped: it carries the old timer, and a reconnect flush or history sync records it after the change.
   * A deleted chat has no record to carry that time, so the change time {@link applyChatTimer} kept counts too.
   */
  private recordEphemeralFromMessage(chatId: string, msg: WAMessage): void {
    const duration = this.extractEphemeralDuration(msg);
    if (duration === undefined) {
      return;
    }
    const setAt = Math.max(
      ...[this.chatKey(chatId), ...this.chatTwins(chatId)].flatMap(k => [
        this.toUnixSeconds(this.chats.get(k)?.ephemeralSettingTimestamp),
        this.timerSetAt.get(k) ?? 0,
        this.timerSetAt.get(this.toNeutralJid(k)) ?? 0,
      ]),
    );
    if (setAt > 0 && this.toUnixSeconds(msg.messageTimestamp) <= setAt) {
      return;
    }
    this.ephemeralByChat.set(chatId, duration);
    this.ephemeralByChat.set(this.toNeutralJid(chatId), duration);
  }

  /**
   * Best-effort read of a message's disappearing timer (seconds). `WebMessageInfo.ephemeralDuration` is
   * populated on history-synced messages but is typically ABSENT on a live 1:1 `messages.upsert`, so fall
   * back to the per-message `contextInfo.expiration` WhatsApp stamps on every message in a disappearing
   * chat — read after unwrapping the ephemeral / view-once / document-with-caption envelope. Exposed so
   * the history-backfill mapper can populate the same signal the live path uses, without duplicating the
   * extraction.
   */
  extractEphemeralDuration(msg: WAMessage): number | undefined {
    const fromInfo = msg.ephemeralDuration;
    if (typeof fromInfo === 'number' && fromInfo > 0) {
      return fromInfo;
    }
    const fromContext = this.contextExpiration(msg.message);
    return typeof fromContext === 'number' && fromContext > 0 ? fromContext : undefined;
  }

  /** Walk a message's content (unwrapping known envelopes) and return the first positive `contextInfo.expiration`. */
  private contextExpiration(content: WAMessage['message'], depth = 0): number | undefined {
    if (!content || typeof content !== 'object' || depth > 4) {
      return undefined;
    }
    const nodes = content as Record<
      string,
      { contextInfo?: { expiration?: number | null }; message?: WAMessage['message'] } | undefined
    >;
    for (const node of Object.values(nodes)) {
      const exp = node?.contextInfo?.expiration;
      if (typeof exp === 'number' && exp > 0) {
        return exp;
      }
      if (node?.message) {
        const nested = this.contextExpiration(node.message, depth + 1);
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return undefined;
  }

  listContacts(): Contact[] {
    // GET /contacts is the address book, not "everyone this session has ever seen". Baileys
    // documents `name` as the one YOU saved; `notify` is only the pushname they set themselves.
    //
    // Deduplicated by neutral id: entries whose raw keys spell one id (a `:device` suffix, the
    // hosted dialect) fold into one row. A person held under both a `@lid` and a phone entry keeps
    // two rows, since the neutral id leaves a lid a lid (`toNeutralJid` resolves nothing);
    // the lid row still carries the phone number when one is known.
    //
    // The iteration is over a SNAPSHOT, and must stay that way: `toNeutralContact` resolves a lid
    // through `resolvePhone`, which reads this very map, and a read moves the entry to the
    // most-recent end. Iterating the live map therefore hands the same entry back forever, a
    // synchronous loop that wedges the process rather than answering the request.
    const byId = new Map<string, ContactTwin>();
    for (const c of [...this.contacts.values()]) {
      if (!c.name) continue;
      const twin: ContactTwin = { contact: this.toNeutralContact(c), rawId: c.id };
      const existing = byId.get(twin.contact.id);
      byId.set(twin.contact.id, existing ? mergeContactTwins(existing, twin) : twin);
    }
    return [...byId.values()].map(t => t.contact);
  }

  findContact(id: string): Contact | null {
    const parsed = parseWaId(id);
    const keys = [id, this.toEngineJid(id)];
    if (parsed.kind === 'lid') {
      keys.push(`${parsed.userPart}@lid`);
    }
    if (parsed.kind === 'user') {
      keys.push(`${parsed.userPart}@s.whatsapp.net`, `${parsed.userPart}@c.us`);
    }
    // One person can occupy two entries, one keyed by `@lid` and one by the phone dialect, and only
    // one of them carries the saved name. Prefer the named one: the nameless twin answers
    // `isMyContact: false` and no display name for somebody the account has saved.
    let unnamed: BaileysContact | undefined;
    for (const key of keys) {
      const direct = this.contacts.get(key);
      if (!direct) continue;
      if (direct.name) return this.toNeutralContact(direct);
      unnamed ??= direct;
    }
    if (parsed.kind !== 'user' && parsed.kind !== 'lid') {
      return unnamed ? this.toNeutralContact(unnamed) : null;
    }
    // The twin is keyed under the OTHER dialect, so a direct hit cannot reach it; the scan below
    // can, through `lid`/`phoneNumber`. Run it even when a direct hit was found, as long as that hit
    // was nameless, and keep the nameless one only if the scan turns up nothing better.
    const want = parsed.userPart;
    for (const c of this.contacts.values()) {
      const phone = c.phoneNumber
        ? userPart(c.phoneNumber)
        : c.id.endsWith('@s.whatsapp.net') || c.id.endsWith('@c.us')
          ? userPart(c.id)
          : '';
      const lid = c.lid ? userPart(c.lid) : c.id.endsWith('@lid') ? userPart(c.id) : '';
      // Digits are only comparable within one kind: a lid and a phone number can read the same.
      if ((parsed.kind === 'user' ? phone : lid) !== want) continue;
      if (c.name) return this.toNeutralContact(c);
      unnamed ??= c;
    }
    return unnamed ? this.toNeutralContact(unnamed) : null;
  }

  /**
   * One row per conversation. A contact WhatsApp migrated to a lid can hold two records, one keyed by
   * phone and one by lid (Baileys files an update under whichever id its source carried, and a record
   * created before the lid->phone mapping was learned stays where it is), and both project to the same
   * neutral id; listing each put two rows sharing one id into the answer. They fold like contacts do:
   * the phone-keyed record is primary, the twin {@link chatJid} routes app-state writes to, and a field
   * the primary lacks comes from the other. The preview is the newest message filed under any key that
   * projects to the row, indexed in one pass rather than a twin scan per chat.
   *
   * Every loop is over a SNAPSHOT: projecting an id resolves a lid through maps whose read moves the
   * entry to the most-recent end, so a live iterator would hand the same entry back forever.
   */
  listChats(): ChatSummary[] {
    const lidIndex = this.lidsByPhone();
    const previews = new Map<string, LastMessage>();
    for (const [key, m] of [...this.lastMessages.entries()]) {
      const id = this.toNeutralJid(key);
      const seen = previews.get(id);
      if (!seen || m.timestamp > seen.timestamp || (m.timestamp === seen.timestamp && m.order > seen.order)) {
        previews.set(id, m);
      }
    }
    const byId = new Map<string, Chat[]>();
    for (const c of [...this.chats.values()]) {
      const id = this.toNeutralJid(c.id!);
      byId.set(id, [...(byId.get(id) ?? []), c]);
    }
    // A message proves the raw conversation exists even before its chat record reaches this process.
    for (const [key] of [...this.lastMessages.entries()]) {
      const id = this.toNeutralJid(key);
      if (!byId.has(id)) byId.set(id, [{ id: key }]);
    }
    // A new engine starts with no chats (see the class comment), but a chat with a persisted state is
    // known to exist, unless the row marks its deletion. So it is listed before its next message arrives.
    if (this.chatStateStore && this.sessionId) {
      for (const chatId of this.chatStateStore.chatIds(this.sessionId)) {
        const id = this.toNeutralJid(chatId);
        if (!byId.has(id)) byId.set(id, [{ id: chatId }]);
      }
    }
    return [...byId].flatMap(([id, records]) => this.toNeutralChat(id, records, previews.get(id), lidIndex) ?? []);
  }

  /**
   * The id the chat is keyed under, for an app-state write addressed with any spelling of it (the
   * listing's @c.us id of a lid-keyed chat resolves to the lid). Baileys indexes the patch by this jid
   * and replays it locally under the same id, so any other spelling names a chat the phone does not
   * hold and lands the echo on a second record.
   */
  chatJid(chatId: string): string {
    return this.chatKey(chatId);
  }

  /** The chat's newest message, with `jid`, the id the chat itself is keyed under. */
  lastMessage(chatId: string): { key: WAMessageKey; timestamp: number; jid: string } | null {
    const m = this.newestAcrossTwins(this.lastMessages, chatId);
    return m ? { key: m.key, timestamp: m.timestamp, jid: this.chatJid(chatId) } : null;
  }

  /** The newest message the chat received (not one this account sent), or null when none is known. */
  lastInboundMessage(chatId: string): { key: WAMessageKey; timestamp: number } | null {
    const m = this.newestAcrossTwins(this.lastInbound, chatId);
    return m ? { key: m.key, timestamp: m.timestamp } : null;
  }

  /**
   * The newest entry `map` holds for a chat under any of its spellings. A message recorded under the
   * contact's lid before the lid->phone mapping was learned stays on the lid twin while the chat key
   * moves to the phone-keyed chat record, so reading the chat key alone would lose it.
   */
  private newestAcrossTwins<T extends { timestamp: number; order: number }>(
    map: LruMap<string, T>,
    chatId: string,
  ): T | undefined {
    let newest: T | undefined;
    for (const k of [this.chatKey(chatId), ...this.chatTwins(chatId)]) {
      const v = map.get(k);
      if (
        v &&
        (!newest || v.timestamp > newest.timestamp || (v.timestamp === newest.timestamp && v.order > newest.order))
      ) {
        newest = v;
      }
    }
    return newest;
  }

  /**
   * The chat's disappearing-messages timer in seconds (#473), or `undefined` when no timer is known.
   * Only a positive value is returned: `0` / `null` / absent all mean "no known timer", so the caller
   * omits the per-message `ephemeralExpiration` and reproduces today's send behavior (Baileys' own send
   * guard is truthy). This keeps a stale-empty or boot-window cache from ever forcing a message to
   * disappear. Folds a neutral `@c.us` id to the engine dialect first, like the other chat lookups.
   */
  getEphemeralExpiration(chatId: string): number | undefined {
    // A phone the cache maps to more than one lid (a recycled number) names no one chat, so a send addressed to
    // it alone carries no timer: what its keys hold was written for whichever holder came first.
    const shared = this.phoneOfManyLids(this.chatTwins(chatId));
    if (shared && parseWaId(chatId).kind === 'user') return undefined;
    // Prefer the timer learned from inbound messages (reliably present); try the raw, engine, and
    // neutral keys so an @lid-keyed entry and a phone-dialect send target resolve to the same value.
    const fromMessage = [chatId, this.toEngineJid(chatId), ...this.timerKeys(chatId)]
      .map(key => this.ephemeralByChat.get(key))
      .find(value => typeof value === 'number' && value > 0);
    if (typeof fromMessage === 'number' && fromMessage > 0) {
      return fromMessage;
    }
    // Fallback to the chat object's own timer for sessions/engines that do surface it on `chats.*`.
    const chat =
      this.chats.get(chatId) ??
      this.chats.get(this.toEngineJid(chatId)) ??
      this.chats.get(this.toNeutralJid(chatId)) ??
      (shared ? undefined : this.chats.get(this.chatKey(chatId)));
    const exp = chat?.ephemeralExpiration;
    return typeof exp === 'number' && exp > 0 ? exp : undefined;
  }

  resolvePhone(id: string): string | null {
    const parsed = parseWaId(id);
    // A user id (@c.us / @s.whatsapp.net) already carries the phone as its user-part. The @c.us case
    // matters once inbound ids are canonicalized: a resolved-lid sender arrives as <phone>@c.us.
    if (parsed.kind === 'user') {
      return parsed.userPart;
    }
    if (parsed.kind === 'lid') {
      // Look up by the device-stripped lid; mappings/contacts are keyed without a :device suffix.
      const lidJid = `${parsed.userPart}@lid`;
      const pn = this.lidToPn.get(lidJid) ?? this.lidToPn.get(id);
      if (pn) {
        return userPart(pn);
      }
      const contactPhone = (this.contacts.get(lidJid) ?? this.contacts.get(id))?.phoneNumber;
      if (contactPhone) {
        return userPart(contactPhone);
      }
      // Fall back to the persistent, cross-session table (in-memory cache, keyed by bare lid digits).
      // `null` means a cached negative (known-unresolved); `undefined` means never seen - both -> null.
      return this.lidStore?.getCached(parsed.userPart) ?? null;
    }
    return null;
  }

  /**
   * Normalize identity without deriving it from a display cache. A LID stays a LID; persisted,
   * reported mappings bridge it to phone grants and filters at the application boundary.
   */
  toNeutralJid(jid: string): string {
    return canonicalizeWaId(jid);
  }

  /**
   * Fold an app-facing neutral id back to the engine's raw dialect. The contacts / chats / lastMessages
   * maps are keyed by Baileys' raw `@s.whatsapp.net`, but the app now hands us the neutral `@c.us`
   * (contact/chat ids are emitted neutral), so map lookups must fold first. The outbound group-participant
   * ops fold for the same reason: only `@s.whatsapp.net` encodes to the single-byte protocol token, whereas
   * a raw `c.us` server suffix would go on the wire as an unknown string. Groups/lids/others share the
   * dialect, so pass them through unchanged.
   */
  toEngineJid(jid: string): string {
    const parsed = parseWaId(jid);
    return parsed.kind === 'user' ? `${parsed.userPart}@s.whatsapp.net` : jid;
  }

  private toNeutralContact(c: BaileysContact): Contact {
    // The id keeps a lid as a lid (`toNeutralJid` resolves nothing). The number is the record's own
    // `phoneNumber`, else the phone `resolvePhone` knows for the lid, so a lid-keyed entry
    // the account has saved still carries its number. An unresolved lid answers '', the honest
    // answer there: a lid's digits are not a phone number.
    const id = this.toNeutralJid(c.id);
    const number = c.phoneNumber ? userPart(c.phoneNumber) : (this.resolvePhone(c.id) ?? '');
    return {
      id,
      name: c.name ?? c.verifiedName,
      pushName: c.notify,
      number,
      // Baileys distinguishes the two names: `name` is documented as the one YOU saved on your
      // WhatsApp, `notify` as the pushname the contact set themselves. Reporting true for everyone
      // told an automation that every chat partner was in the addressbook, which is what
      // whatsapp-web.js reports honestly from the Contact model.
      isMyContact: Boolean(c.name),
      isBlocked: false, // best-effort: blocklist state is not tracked in this slice
      // A `picture` notification stores the marker 'changed' or 'removed' in imgUrl, not a URL.
      profilePicUrl: c.imgUrl && /^https?:\/\//i.test(c.imgUrl) ? c.imgUrl : undefined,
    };
  }

  /**
   * Project the records that share neutral `id` (usually one) into a row. `last` is the newest preview
   * filed under any of their keys. Null for a chat WhatsApp deleted that no message has re-created since.
   */
  private toNeutralChat(
    id: string,
    records: Chat[],
    last: LastMessage | undefined,
    lidIndex: Map<string, string[]>,
  ): ChatSummary | null {
    // Chat.id is nullable on Baileys' own type (it's the raw proto.IConversation field), but
    // upsertChats() only ever stores a record under a truthy r.id, so every value in `this.chats`
    // is provably keyed by a real id. Phone-keyed first, then the lower raw id: stable across calls.
    const [c, ...others] = [...records].sort((a, b) =>
      isPhoneKeyed(a.id!) !== isPhoneKeyed(b.id!) ? (isPhoneKeyed(a.id!) ? -1 : 1) : a.id! < b.id! ? -1 : 1,
    );
    const rawId = c.id!;
    // Mute/archive/pin come from the persisted store when it has this chat (it survives a reconnect
    // Baileys cannot resync), else from the primary's live record. A `null` muteEndTime means unmuted.
    const recordIds = records.map(r => r.id!);
    const st = this.chatState(rawId, recordIds, lidIndex);
    const deletedAt = this.deletedAtOf(this.stateKeys(rawId, recordIds, lidIndex), st?.deletedAt);
    // Only a message newer than the deletion re-creates the chat: a record without one is a state update,
    // and a message sent before it, delivered late, is the deleted chat's.
    const active = () =>
      Math.max(last?.timestamp ?? 0, ...records.map(r => this.toUnixSeconds(r.conversationTimestamp)));
    if (deletedAt && active() * 1000 <= deletedAt) return null;
    return {
      id,
      name: c.name ?? others.find(o => o.name)?.name ?? this.resolveContactName(rawId),
      isGroup: rawId.endsWith('@g.us'),
      kind: chatKind(id),
      // From the most recently active record that has one: new messages to a lid-migrated contact
      // count on the lid record while the phone one keeps a stale 0.
      unreadCount:
        [c, ...others]
          .filter(r => r.unreadCount != null)
          .sort((a, b) => this.toUnixSeconds(b.conversationTimestamp) - this.toUnixSeconds(a.conversationTimestamp))[0]
          ?.unreadCount ?? 0,
      timestamp: last?.timestamp ?? Math.max(...records.map(r => this.toUnixSeconds(r.conversationTimestamp))),
      lastMessage: last?.text,
      lastMessageType: last?.type,
      archived: st ? st.archived : (c.archived ?? false),
      // Baileys reports a pin as an ORDER, not a flag: 0/absent means unpinned.
      pinned: st ? st.pinned : Boolean(c.pinned),
      muted: this.isMuted(st ? st.muteEndTime : c.muteEndTime),
      muteExpiration: this.muteExpirationMs(st ? st.muteEndTime : c.muteEndTime),
    };
  }

  /**
   * Whether a Baileys `muteEndTime` is still in the future.
   *
   * The value arrives in two units. An app-state `chatModify({ mute })` write echoes the epoch
   * MILLISECONDS this gateway passed (measured in `chat-mute.spec.ts`, documented in `mute-chat.dto.ts`).
   * A history-sync `Conversation.muteEndTime` is a Long in the proto's own unit, seconds like the
   * `conversationTimestamp` beside it. So it is normalised by magnitude: below 1e12 is seconds (an
   * epoch-ms stamp below 1e12 is a date before 2001-09) and is scaled to ms. The current state survives a
   * reconnect via {@link persistChatState}, because Baileys re-emits only app-state mutations newer than
   * the persisted version, never an already-applied mute. A negative value is WhatsApp's "Always"
   * sentinel (-1, the value WhatsApp Web sends too), a mute with no end.
   */
  private isMuted(muteEndTime: number | { toNumber(): number } | null | undefined): boolean {
    const raw = this.toUnixSeconds(muteEndTime);
    if (!raw) return false;
    if (raw < 0) return true;
    const endMs = raw < 1e12 ? raw * 1000 : raw;
    return endMs > Date.now();
  }

  /**
   * The expiry instant (epoch ms) for {@link ChatSummary.muteExpiration}, or undefined when the chat
   * is not muted. Same normalisation as {@link isMuted}, so the two agree: a value only survives here
   * when it is still in the future. A mute with no end reads 0, the contract's "muted indefinitely".
   */
  private muteExpirationMs(muteEndTime: number | { toNumber(): number } | null | undefined): number | undefined {
    const raw = this.toUnixSeconds(muteEndTime);
    if (!raw) return undefined;
    if (raw < 0) return 0;
    const endMs = raw < 1e12 ? raw * 1000 : raw;
    return endMs > Date.now() ? endMs : undefined;
  }

  /**
   * Write mute/archive/pin through to the persisted store when a chat update carries them. Own-key
   * presence, not truthiness, is the trigger: a history-sync or name-hydration partial that omits these
   * keys must not overwrite persisted state, and a live unmute arrives as `muteEndTime: null` (an own
   * key) that must persist as null. It has to be an OWN key: history sync hands over decoded
   * `proto.Conversation` instances, whose prototype defaults all three fields to null, so the `in`
   * operator would read every history chunk as a reset to unpinned, unarchived and unmuted. A no-op
   * when this session has no store wired (unit tests, wwjs).
   */
  private persistChatState(id: string, r: Partial<Chat>): void {
    if (!this.chatStateStore || !this.sessionId) return;
    const patch: Partial<ChatStateValue> = {};
    if (Object.hasOwn(r, 'muteEndTime')) patch.muteEndTime = this.normalizeMuteEndTime(r.muteEndTime);
    if (Object.hasOwn(r, 'archived')) patch.archived = Boolean(r.archived);
    if (Object.hasOwn(r, 'pinned')) patch.pinned = Boolean(r.pinned);
    if (Object.keys(patch).length) {
      // A row still filed under a lid twin is folded onto the state key here, on a real change, never
      // on a read: the store picks the newest row from the table, so a twin the cache happens to hold
      // cannot overwrite a newer row it does not.
      const key = this.stateKey(id);
      const twins = this.stateTwins([id], key);
      // Only an app-state action (the update holds the state fields alone) may create a row to hold a
      // default, like an unpin that must outweigh a pin on a twin row. A message carries `archived:
      // false` when the account unarchives on new messages, and a history chat carries its other fields
      // too; a default in either creating a row would leave one row per chat ever messaged.
      const create = Object.keys(r).every(f => f === 'id' || f === 'conditional' || Object.hasOwn(patch, f));
      void (twins.length
        ? this.chatStateStore.fold(this.sessionId, key, twins, patch, create)
        : this.chatStateStore.remember(this.sessionId, key, patch, create));
    }
  }

  /**
   * The one key a chat's persisted state lives under, whatever spelling the update carried: the phone
   * JID once the lid resolves, else the device-stripped lid, and anything else (a group) as is.
   * WhatsApp syncs a lid-migrated contact's pin, mute and archive under the lid while the chat record
   * may be keyed by phone, so keying the row by the raw id split one chat's state across two rows and
   * the listing read the one that never changed.
   */
  private stateKey(id: string): string {
    const parsed = parseWaId(id);
    if (parsed.kind === 'lid') {
      const phone = this.resolvePhone(id);
      return phone ? `${phone}@s.whatsapp.net` : `${parsed.userPart}@lid`;
    }
    return this.toEngineJid(id);
  }

  /**
   * The chat's persisted state. A row may still sit under a lid twin of the state key: written before
   * the mapping was learned, or by an earlier version that keyed rows by the raw id. The rows merge
   * field by field, as the fold does (see {@link mergeTwinStates}). A read never writes: the twin rows
   * are folded onto the state key on the chat's next change (see {@link persistChatState}). `recordIds`
   * are the raw ids of every chat record merged into the row, whose lids are twins too.
   */
  private chatState(rawId: string, recordIds: string[], lidIndex?: Map<string, string[]>): ChatStateValue | undefined {
    const store = this.chatStateStore;
    const sid = this.sessionId;
    if (!store || !sid) return undefined;
    return mergeTwinStates(this.stateKeys(rawId, recordIds, lidIndex).flatMap(k => store.get(sid, k) ?? []));
  }

  /** The chat's state key and the lid twins its state rows can sit under (see {@link stateTwins}). */
  private stateKeys(rawId: string, recordIds: string[], lidIndex?: Map<string, string[]>): string[] {
    const key = this.stateKey(rawId);
    return [key, ...this.stateTwins(recordIds, key, lidIndex)];
  }

  /**
   * The lid spellings of a phone-keyed state key: the lids among the chat's own record ids, and the
   * ones this session's mappings and the persisted table pair with the phone. The own lids matter when
   * only the contact record resolves them, which neither mapping source holds.
   */
  private stateTwins(rawIds: string[], key: string, lidIndex?: Map<string, string[]>): string[] {
    const parsed = parseWaId(key);
    if (parsed.kind !== 'user') return [];
    // A single update scans the mappings for this one phone; building the whole index per update
    // blocked the event loop for seconds when a first sync carried thousands of state fields.
    const twins = new Set(lidIndex?.get(parsed.userPart));
    if (!lidIndex) {
      for (const [lid, pn] of this.lidToPn.entries()) {
        if (userPart(pn) === parsed.userPart) twins.add(`${userPart(lid)}@lid`);
      }
    }
    for (const lid of this.lidStore?.lidsForPhone(parsed.userPart) ?? []) twins.add(`${lid}@lid`);
    for (const rawId of rawIds) {
      const raw = parseWaId(rawId);
      if (raw.kind === 'lid') twins.add(`${raw.userPart}@lid`);
    }
    return [...twins];
  }

  /** Phone digits to the lid keys this session maps to them as {@link chatTwins} finds them, raw, in one walk. */
  private lidKeysByPhone(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [lid, pn] of this.lidToPn.entries()) {
      const lids = index.get(userPart(pn));
      if (lids) lids.push(lid);
      else index.set(userPart(pn), [lid]);
    }
    return index;
  }

  /** Phone digits to the lid JIDs this session maps to them, built once per listing. */
  private lidsByPhone(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [lid, pn] of [...this.lidToPn.entries()]) {
      const phone = userPart(pn);
      index.set(phone, [...(index.get(phone) ?? []), `${userPart(lid)}@lid`]);
    }
    return index;
  }

  /**
   * Normalise a raw muteEndTime to canonical epoch ms, or null (0/absent = unmuted). A mute with no end
   * keeps the -1 sentinel rather than scaling it. See {@link isMuted}.
   */
  private normalizeMuteEndTime(v: number | { toNumber(): number } | null | undefined): number | null {
    const n = this.toUnixSeconds(v);
    if (!n) return null;
    if (n < 0) return -1;
    return n < 1e12 ? n * 1000 : n;
  }

  /**
   * Best-known display name for a chat id when Baileys gave the chat no title (#369). Prefers the saved
   * contact name, then verifiedName, then pushName (`notify`); for a @lid chat it also tries the contact
   * behind the resolved phone. Falls back to the raw user-part so a number/lid is never shown as a JID.
   */
  private resolveContactName(id: string): string {
    const direct = this.contactDisplayName(id);
    if (direct) {
      return direct;
    }
    const parsed = parseWaId(id);
    if (parsed.kind === 'lid') {
      const lidJid = `${parsed.userPart}@lid`;
      const pn =
        this.lidToPn.get(lidJid) ??
        this.lidToPn.get(id) ??
        (this.contacts.get(lidJid) ?? this.contacts.get(id))?.phoneNumber;
      if (pn) {
        const viaPhone =
          this.contactDisplayName(pn) ??
          this.contactDisplayName(`${userPart(pn)}@s.whatsapp.net`) ??
          this.contactDisplayName(`${userPart(pn)}@c.us`);
        if (viaPhone) {
          return viaPhone;
        }
      }
    }
    return userPart(id);
  }

  private contactDisplayName(id: string): string | undefined {
    const c = this.contacts.get(id);
    return c ? (c.name ?? c.verifiedName ?? c.notify ?? undefined) : undefined;
  }

  private toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
    if (ts == null) {
      return 0;
    }
    return typeof ts === 'number' ? ts : ts.toNumber();
  }
}
