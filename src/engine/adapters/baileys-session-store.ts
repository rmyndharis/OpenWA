import type { Chat, Contact as BaileysContact, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { ChatSummary, Contact } from '../interfaces/whatsapp-engine.interface';
import { chatKind, parseWaId, toNeutralJid as canonicalizeWaId, userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import type { ChatStateStore, ChatStateValue } from './baileys-chat-state-store.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

interface LastMessage {
  key: WAMessageKey;
  timestamp: number;
  text: string;
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
 * Per-session, in-memory snapshot of Baileys contacts + chats, fed from `sock.ev` events. Baileys has
 * no fetch-all; this data arrives via `contacts.*`/`chats.*`/`messaging-history.set` (a full re-sync on
 * each connect) and is mapped to the neutral `Contact`/`ChatSummary` on read. Holds no socket — pure data.
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
   * @param lidStore       optional persisted, cross-session lid->phone table that backs resolution beyond
   *                       this session's in-memory map (survives restarts, shared across sessions).
   * @param sessionId      provenance recorded on rows this session writes to the persisted tables.
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
    this.lidToPn = new LruMap(maxEntries);
    // Double-keyed (raw + neutral JID per chat), so it needs two slots per chat to cover the same span.
    this.ephemeralByChat = new LruMap(maxEntries * 2);
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
      const phone = merged.phoneNumber ?? (merged.id.endsWith('@s.whatsapp.net') ? merged.id : undefined);
      if (merged.lid && phone) {
        this.lidToPn.set(merged.lid, phone);
        this.persistLidMapping(merged.lid, phone);
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
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.chats.get(r.id) ?? { id: r.id };
      this.chats.set(r.id, { ...existing, ...r });
      this.persistChatState(r.id, r);
    }
  }

  addLidMappings(mappings: { lid?: string; pn?: string }[] = []): void {
    for (const m of mappings) {
      if (m.lid && m.pn) {
        this.lidToPn.set(m.lid, m.pn);
        this.persistLidMapping(m.lid, m.pn);
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
  recordKeyLidMappings(key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt' | 'participant' | 'participantAlt'>): void {
    this.addLidMappings([
      this.lidPnPair(key.remoteJid, key.remoteJidAlt),
      this.lidPnPair(key.participant, key.participantAlt),
    ]);
  }

  /** Sorts a JID and its WhatsApp-supplied "Alt" counterpart into { lid, pn } by @lid suffix. */
  private lidPnPair(jid?: string | null, alt?: string | null): { lid?: string; pn?: string } {
    if (!jid || !alt) {
      return {};
    }
    if (jid.endsWith('@lid')) {
      return { lid: jid, pn: alt };
    }
    if (alt.endsWith('@lid')) {
      return { lid: alt, pn: jid };
    }
    return {};
  }

  /** Write a learned lid->phone pair through to the persistent table (bare digits, fire-and-forget). */
  private persistLidMapping(lidJid: string, pnJid: string): void {
    void this.lidStore?.remember(userPart(lidJid), userPart(pnJid), this.sessionId);
  }

  recordMessage(msg: WAMessage): void {
    const chatId = msg.key?.remoteJid;
    if (!chatId || !msg.key) {
      return;
    }
    // Learn the chat's disappearing-messages timer from the message itself (#473). This runs before the
    // newest-message guard so every inbound refreshes it; the timer is cached under both the raw and
    // neutral JID so an outbound send addressed in either dialect (phone or @lid) finds it.
    this.recordEphemeralFromMessage(chatId, msg);
    const timestamp = this.toUnixSeconds(msg.messageTimestamp);
    const existing = this.lastMessages.get(chatId);
    if (existing && existing.timestamp >= timestamp) {
      return; // keep the newest
    }
    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
    this.lastMessages.set(chatId, { key: msg.key, timestamp, text });
  }

  /**
   * Refresh the chat preview when (and only when) the edited message is still the latest message in
   * that chat. Editing an older message must not replace the preview or reorder the conversation.
   */
  recordMessageEdit(chatId: string, messageId: string, text: string): void {
    if (!messageId) return;
    const rawChatId = this.lastMessages.has(chatId) ? chatId : this.toEngineJid(chatId);
    const existing = this.lastMessages.get(rawChatId);
    if (!existing || existing.key.id !== messageId) return;
    this.lastMessages.set(rawChatId, { ...existing, text });
  }

  /**
   * Cache a positive disappearing-messages timer learned from an inbound message under both the raw chat
   * JID and its neutral form, so {@link getEphemeralExpiration} hits regardless of which dialect the caller
   * sends to. A non-positive/absent value means "no live timer on this message" and is left untouched (a
   * single non-ephemeral message must not clear a known timer; WhatsApp keeps stamping it while on).
   */
  private recordEphemeralFromMessage(chatId: string, msg: WAMessage): void {
    const duration = this.extractEphemeralDuration(msg);
    if (duration === undefined) {
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
    // Deduplicated by neutral id: one person can occupy two entries, one keyed by `@lid` and one by
    // the phone dialect, and when both carry a saved name they project to the SAME id once the lid
    // resolves. Listing both put two rows sharing one id into the answer.
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
      if (phone !== want && lid !== want) continue;
      if (c.name) return this.toNeutralContact(c);
      unnamed ??= c;
    }
    return unnamed ? this.toNeutralContact(unnamed) : null;
  }

  listChats(): ChatSummary[] {
    return [...this.chats.values()].map(c => this.toNeutralChat(c));
  }

  lastMessage(chatId: string): { key: WAMessageKey; timestamp: number } | null {
    const m = this.lastMessages.get(chatId) ?? this.lastMessages.get(this.toEngineJid(chatId));
    return m ? { key: m.key, timestamp: m.timestamp } : null;
  }

  /**
   * The chat's disappearing-messages timer in seconds (#473), or `undefined` when no timer is known.
   * Only a positive value is returned: `0` / `null` / absent all mean "no known timer", so the caller
   * omits the per-message `ephemeralExpiration` and reproduces today's send behavior (Baileys' own send
   * guard is truthy). This keeps a stale-empty or boot-window cache from ever forcing a message to
   * disappear. Folds a neutral `@c.us` id to the engine dialect first, like the other chat lookups.
   */
  getEphemeralExpiration(chatId: string): number | undefined {
    // Prefer the timer learned from inbound messages (reliably present); try the raw, engine, and
    // neutral keys so an @lid-keyed entry and a phone-dialect send target resolve to the same value.
    const fromMessage =
      this.ephemeralByChat.get(chatId) ??
      this.ephemeralByChat.get(this.toEngineJid(chatId)) ??
      this.ephemeralByChat.get(this.toNeutralJid(chatId));
    if (typeof fromMessage === 'number' && fromMessage > 0) {
      return fromMessage;
    }
    // Fallback to the chat object's own timer for sessions/engines that do surface it on `chats.*`.
    const chat =
      this.chats.get(chatId) ?? this.chats.get(this.toEngineJid(chatId)) ?? this.chats.get(this.toNeutralJid(chatId));
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
   * Canonicalize a Baileys JID to the neutral dialect (see {@link canonicalizeWaId} / wa-id.ts),
   * resolving a lid to its phone via this session's lid->pn map when the mapping is known.
   */
  toNeutralJid(jid: string): string {
    return canonicalizeWaId(jid, id => this.resolvePhone(id));
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
    // The number is read off the NEUTRAL id, which has already done the lid resolution: a lid-keyed
    // entry whose mapping is known projects to `<phone>@c.us` and carries its number, where reading
    // the raw `@lid` key answered an empty string for somebody the account has saved. An unresolved
    // lid still answers '', which is the honest answer there.
    const id = this.toNeutralJid(c.id);
    const number = c.phoneNumber ? userPart(c.phoneNumber) : id.endsWith('@c.us') ? userPart(id) : '';
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
      profilePicUrl: c.imgUrl ?? undefined,
    };
  }

  private toNeutralChat(c: Chat): ChatSummary {
    // Chat.id is nullable on Baileys' own type (it's the raw proto.IConversation field), but
    // upsertChats() only ever stores a record under a truthy r.id, so every value in `this.chats`
    // is provably keyed by a real id.
    const id = c.id!;
    const last = this.lastMessages.get(id);
    // Mute/archive/pin come from the persisted store when it has this chat (it survives a reconnect
    // Baileys cannot resync), else from the live record. A `null` muteEndTime there means unmuted.
    const st = this.sessionId ? this.chatStateStore?.get(this.sessionId, id) : undefined;
    return {
      id: this.toNeutralJid(id),
      name: c.name ?? this.resolveContactName(id),
      isGroup: id.endsWith('@g.us'),
      kind: chatKind(this.toNeutralJid(id)),
      unreadCount: c.unreadCount ?? 0,
      timestamp: last?.timestamp ?? this.toUnixSeconds(c.conversationTimestamp),
      lastMessage: last?.text,
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
   * the persisted version, never an already-applied mute.
   */
  private isMuted(muteEndTime: number | { toNumber(): number } | null | undefined): boolean {
    const raw = this.toUnixSeconds(muteEndTime);
    if (!raw) return false;
    const endMs = raw < 1e12 ? raw * 1000 : raw;
    return endMs > Date.now();
  }

  /**
   * The expiry instant (epoch ms) for {@link ChatSummary.muteExpiration}, or undefined when the chat
   * is not muted. Same normalisation as {@link isMuted}, so the two agree: a value only survives here
   * when it is still in the future.
   */
  private muteExpirationMs(muteEndTime: number | { toNumber(): number } | null | undefined): number | undefined {
    const raw = this.toUnixSeconds(muteEndTime);
    if (!raw) return undefined;
    const endMs = raw < 1e12 ? raw * 1000 : raw;
    return endMs > Date.now() ? endMs : undefined;
  }

  /**
   * Write mute/archive/pin through to the persisted store when a chat update carries them. Key presence,
   * not truthiness, is the trigger: a history-sync or name-hydration partial that omits these keys must
   * not overwrite persisted state, and a live unmute arrives as `muteEndTime: null` (key present) that
   * must persist as null. A no-op when this session has no store wired (unit tests, wwjs).
   */
  private persistChatState(id: string, r: Partial<Chat>): void {
    if (!this.chatStateStore || !this.sessionId) return;
    const patch: Partial<ChatStateValue> = {};
    if ('muteEndTime' in r) patch.muteEndTime = this.normalizeMuteEndTime(r.muteEndTime);
    if ('archived' in r) patch.archived = Boolean(r.archived);
    if ('pinned' in r) patch.pinned = Boolean(r.pinned);
    if (Object.keys(patch).length) {
      void this.chatStateStore.remember(this.sessionId, id, patch);
    }
  }

  /** Normalise a raw muteEndTime to canonical epoch ms, or null (0/absent = unmuted). See {@link isMuted}. */
  private normalizeMuteEndTime(v: number | { toNumber(): number } | null | undefined): number | null {
    const n = this.toUnixSeconds(v);
    if (!n) return null;
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
