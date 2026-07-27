import type { Chat, Contact as BaileysContact, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { ChatSummary, Contact } from '../interfaces/whatsapp-engine.interface';
import { chatKind, parseWaId, toNeutralJid as canonicalizeWaId, userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
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
 */
class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

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
    this.map.delete(key);
    this.map.set(key, value);
    if (!this.max) {
      return;
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }
}

/**
 * Per-session, in-memory snapshot of Baileys contacts + chats, fed from `sock.ev` events. Baileys has
 * no fetch-all; this data arrives via `contacts.*`/`chats.*`/`messaging-history.set` (a full re-sync on
 * each connect) and is mapped to the neutral `Contact`/`ChatSummary` on read. Holds no socket — pure data.
 *
 * Every map is LRU-bounded (`BAILEYS_SESSION_STORE_MAX_ENTRIES`, default 5000 per map, 0 = unbounded)
 * because contacts/chats/lastMessages/lidToPn all grow from peer-controlled traffic — without a cap a
 * chatty account leaks one entry per distinct peer ever seen. Miss paths after an eviction:
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
   * @param lidStore  optional persisted, cross-session lid->phone table that backs resolution beyond
   *                  this session's in-memory map (survives restarts, shared across sessions).
   * @param sessionId provenance recorded on rows this session writes to the table.
   */
  constructor(
    private readonly lidStore?: LidMappingStore,
    private readonly sessionId?: string,
  ) {
    // Mirrors LidMappingStoreService: a finite default, 0 opts back into unbounded, garbage falls back.
    const maxEntries = resolveNonNegativeIntEnv(
      process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES,
      SESSION_STORE_MAP_CAP_DEFAULT,
    );
    this.contacts = new LruMap(maxEntries);
    this.chats = new LruMap(maxEntries);
    this.lastMessages = new LruMap(maxEntries);
    this.lidToPn = new LruMap(maxEntries);
    // Double-keyed (raw + neutral JID per chat), so it needs two slots per chat to cover the same span.
    this.ephemeralByChat = new LruMap(maxEntries * 2);
  }

  upsertContacts(records: Partial<BaileysContact>[] = []): void {
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.contacts.get(r.id) ?? { id: r.id };
      const merged: BaileysContact = { ...existing, ...r };
      this.contacts.set(r.id, merged);
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

  upsertChats(records: Partial<Chat>[] = []): void {
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.chats.get(r.id) ?? { id: r.id };
      this.chats.set(r.id, { ...existing, ...r });
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
    return [...this.contacts.values()].map(c => this.toNeutralContact(c));
  }

  findContact(id: string): Contact | null {
    const c = this.contacts.get(id) ?? this.contacts.get(this.toEngineJid(id));
    return c ? this.toNeutralContact(c) : null;
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
    const number = c.phoneNumber ? userPart(c.phoneNumber) : c.id.endsWith('@s.whatsapp.net') ? userPart(c.id) : '';
    return {
      id: this.toNeutralJid(c.id),
      name: c.name ?? c.verifiedName,
      pushName: c.notify,
      number,
      isMyContact: true, // best-effort: present in the synced address book / chat list
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
    return {
      id: this.toNeutralJid(id),
      name: c.name ?? this.resolveContactName(id),
      isGroup: id.endsWith('@g.us'),
      kind: chatKind(this.toNeutralJid(id)),
      unreadCount: c.unreadCount ?? 0,
      timestamp: last?.timestamp ?? this.toUnixSeconds(c.conversationTimestamp),
      lastMessage: last?.text,
    };
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
