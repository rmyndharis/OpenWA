import type { Chat, Contact as BaileysContact, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { ChatSummary, Contact } from '../interfaces/whatsapp-engine.interface';
import { parseWaId, toNeutralJid as canonicalizeWaId, userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * Baileys `Contact` does not include a `phoneNumber` field, but WhatsApp Business events may supply
 * the resolved phone JID alongside the lid-based id. We extend the input type locally so callers can
 * pass `phoneNumber` when available (e.g. from `contacts.upsert` payloads that carry lid+pn pairs).
 */
type BaileysContactWithPhone = BaileysContact & { phoneNumber?: string };

interface LastMessage {
  key: WAMessageKey;
  timestamp: number;
  text: string;
}

/**
 * Per-session, in-memory snapshot of Baileys contacts + chats, fed from `sock.ev` events. Baileys has
 * no fetch-all; this data arrives via `contacts.*`/`chats.*`/`messaging-history.set` (a full re-sync on
 * each connect) and is mapped to the neutral `Contact`/`ChatSummary` on read. Holds no socket — pure data.
 */
export class BaileysSessionStore {
  private readonly contacts = new Map<string, BaileysContactWithPhone>();
  private readonly chats = new Map<string, Chat>();
  private readonly lastMessages = new Map<string, LastMessage>();
  private readonly lidToPn = new Map<string, string>();

  /**
   * @param lidStore  optional persisted, cross-session lid->phone table that backs resolution beyond
   *                  this session's in-memory map (survives restarts, shared across sessions).
   * @param sessionId provenance recorded on rows this session writes to the table.
   */
  constructor(
    private readonly lidStore?: LidMappingStore,
    private readonly sessionId?: string,
  ) {}

  upsertContacts(records: Partial<BaileysContactWithPhone>[] = []): void {
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.contacts.get(r.id) ?? { id: r.id };
      const merged: BaileysContactWithPhone = { ...existing, ...r };
      this.contacts.set(r.id, merged);
      // Capture a lid->phone pair from the merged record (lid + phone can arrive in separate updates).
      // The phone is `jid` on a Baileys Contact (`@s.whatsapp.net`); `phoneNumber` only appears on the
      // WhatsApp Business event shape we extend in locally.
      const phone = merged.phoneNumber ?? merged.jid;
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
   * Learn lid->pn mappings from an inbound message key (#362). Baileys attaches the sender's phone JID
   * (`senderPn` / `participantPn`) next to its privacy id (`senderLid` / `participantLid`) on the message
   * key — the only place a fresh `@lid` sender's number is revealed in @whiskeysockets/baileys@6.7.23
   * (there is no `getPNForLID` lookup and `contacts.*` / `messaging-history.set` don't fire for it). This
   * lets `resolvePhone` (senderPhone, `GET /contacts/:id/phone`) and lid canonicalization succeed. The
   * pairs flow through addLidMappings, so they also write through to the persistent table.
   */
  recordKeyLidMappings(key: Pick<WAMessageKey, 'senderLid' | 'senderPn' | 'participantLid' | 'participantPn'>): void {
    this.addLidMappings([
      { lid: key.senderLid ?? undefined, pn: key.senderPn ?? undefined },
      { lid: key.participantLid ?? undefined, pn: key.participantPn ?? undefined },
    ]);
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
    const timestamp = this.toUnixSeconds(msg.messageTimestamp);
    const existing = this.lastMessages.get(chatId);
    if (existing && existing.timestamp >= timestamp) {
      return; // keep the newest
    }
    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
    this.lastMessages.set(chatId, { key: msg.key, timestamp, text });
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

  private toNeutralContact(c: BaileysContactWithPhone): Contact {
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
    const last = this.lastMessages.get(c.id);
    return {
      id: this.toNeutralJid(c.id),
      name: c.name ?? this.resolveContactName(c.id),
      isGroup: c.id.endsWith('@g.us'),
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
