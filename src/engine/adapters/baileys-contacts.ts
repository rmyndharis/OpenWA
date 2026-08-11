import type { WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import { ChatSummary, Contact, MediaInput } from '../interfaces/whatsapp-engine.interface';
import { resolveMediaBuffer } from './baileys-messaging';
import { type createLogger } from '../../common/services/logger.service';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Contacts/profile/chats-domain operations extracted from BaileysAdapter. The adapter keeps the
 * public methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysContactsHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  readonly logger: ReturnType<typeof createLogger>;
  normalizedSelfJid(): string;
  listContacts(): Contact[];
  findContact(contactId: string): Contact | null;
  resolvePhone(contactId: string): string | null;
  listChats(): ChatSummary[];
  /** The chat's last known message (the handle readMessages/chatModify need), or null when none. */
  lastMessage(chatId: string): { key: WAMessageKey; timestamp: number } | null;
  /** Fold a neutral @c.us id to the engine @s.whatsapp.net form used as the app-state index key. */
  toEngineJid(jid: string): string;
  /** Fold an engine jid back to the neutral dialect before it crosses the engine boundary. */
  toNeutralJid(jid: string): string;
}

export class BaileysContacts {
  constructor(
    private readonly host: BaileysContactsHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
  private confirmed<T>(work: Promise<T>, operation: string): Promise<T> {
    return withQueryDeadline(work, this.queryBudgetMs, `WhatsApp did not confirm ${operation} in time`);
  }

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      // The library also accepts a timeoutMs third argument, but passing it only converts the
      // stall into a throw — which this catch would swallow into the same null. The deadline has
      // to be ours, and the catch has to let it past.
      const url = await withQueryDeadline(
        this.sock().profilePictureUrl(contactId, 'image'),
        this.queryBudgetMs,
        'WhatsApp did not answer the profile picture lookup in time',
      );
      return url ?? null;
    } catch (err) {
      // A no-picture verdict arrives as a thrown error, so this catch must keep swallowing — but a
      // query that never came back is not a verdict about the picture.
      //
      // NOTE the whatsapp-web.js adapter does the OPPOSITE on this same interface method, and
      // correctly: there the no-picture verdict is delivered as `undefined`, so every throw is a
      // failure and none of them may become null. Same neutral method, opposite error conventions
      // underneath — do not harmonise the two into a shared helper.
      if (err instanceof EngineTransportError) {
        throw err;
      }
      this.host.logger.debug('profilePictureUrl failed; no picture or hidden', {
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // no picture set, or hidden by privacy
    }
  }

  async upsertContact(contactId: string, firstName: string, lastName = ''): Promise<void> {
    this.host.ensureReady();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    // Baileys addresses the entry by JID, unlike whatsapp-web.js which wants a bare phone number.
    // saveOnPrimaryAddressbook stays false to match the wwjs default (syncToAddressbook=false):
    // writing through to the device addressbook is a heavier action than saving the contact.
    // Fold the neutral @c.us the API speaks to the engine @s.whatsapp.net: addOrEditContact ->
    // chatModify keys the addressbook app-state patch by the raw jid (no jidNormalizedUser, unlike
    // the send path), so a raw @c.us index would land under a key WhatsApp never reads and the
    // write would silently target nothing while the endpoint reports success.
    await this.confirmed(
      this.sock().addOrEditContact(this.host.toEngineJid(contactId), {
        firstName,
        fullName,
        saveOnPrimaryAddressbook: false,
      }),
      'the contact save',
    );
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    // Same app-state key fold as upsertContact — a raw @c.us removal targets a phantom entry.
    await this.confirmed(this.sock().removeContact(this.host.toEngineJid(contactId)), 'the contact removal');
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateBlockStatus(contactId, 'block'), 'the block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateBlockStatus(contactId, 'unblock'), 'the unblock');
  }

  /**
   * The read half of block/unblockContact. Bounded by our own clock: Baileys' `query()` swallows
   * its timeout, and an unanswered blocklist query would otherwise surface as an EMPTY blocklist —
   * a claim about the account sold in place of a transport failure. Wire items without a jid attr
   * are dropped rather than reported as "undefined".
   */
  async getBlockedContacts(): Promise<string[]> {
    this.host.ensureReady();
    const jids = await withQueryDeadline(
      this.sock().fetchBlocklist(),
      this.queryBudgetMs,
      'WhatsApp did not answer the blocklist query in time',
    );
    return (jids ?? []).filter((jid): jid is string => Boolean(jid)).map(jid => this.host.toNeutralJid(jid));
  }

  async setProfileName(name: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateProfileName(name), 'the profile name change');
  }

  async setProfileStatus(status: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateProfileStatus(status), 'the profile status change');
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.host.ensureReady();
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      throw new Error('cannot set the profile picture: the own JID is not known yet');
    }
    // updateProfilePicture takes a WAMediaUpload; resolveMediaBuffer covers Buffer | base64 | URL,
    // the same conversion the media sends use.
    const { data } = await resolveMediaBuffer(media);
    await this.confirmed(this.sock().updateProfilePicture(selfJid, data), 'the profile picture change');
  }

  async deleteProfilePicture(): Promise<void> {
    this.host.ensureReady();
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      // Same guard as setProfilePicture: an empty jid would send the removal at nothing while the
      // endpoint reported success.
      throw new Error('cannot delete the profile picture: the own JID is not known yet');
    }
    // The same socket call `deleteGroupPicture` already uses, addressed at the account instead of a
    // group. Baileys resolves void either way, so an acknowledged write is the only signal there is.
    await this.confirmed(this.sock().removeProfilePicture(selfJid), 'the profile picture removal');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContacts(): Promise<Contact[]> {
    this.host.ensureReady();
    return this.host.listContacts();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContactById(contactId: string): Promise<Contact | null> {
    this.host.ensureReady();
    return this.host.findContact(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    return this.host.resolvePhone(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChats(): Promise<ChatSummary[]> {
    this.host.ensureReady();
    return this.host.listChats();
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // nothing known to mark read
    }
    // readMessages reaches fetchPrivacySettings, which destructures the query result and throws a
    // raw TypeError on an unanswered one — no Boom, so nothing downstream can classify it. Marking
    // a chat read is idempotent, so bounding it is safe: a repeat costs nothing.
    await this.confirmed(this.sock().readMessages([last.key]), 'the read receipt');
    return true;
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' unread toggle needs the last message; can't synthesize it
    }
    await this.confirmed(
      this.sock().chatModify(
        { markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
        this.host.toEngineJid(chatId),
      ),
      'the unread mark',
    );
    return true;
  }

  async clearChatMessages(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' clear needs the last message; can't synthesize it
    }
    await this.confirmed(
      this.sock().chatModify(
        { clear: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
        this.host.toEngineJid(chatId),
      ),
      'the chat clear',
    );
    return true;
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' archive toggle needs the last message; can't synthesize it
    }
    await this.confirmed(
      this.sock().chatModify(
        { archive, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
        this.host.toEngineJid(chatId),
      ),
      'the archive change',
    );
    return true;
  }

  async muteChat(chatId: string, muteUntil: number | null): Promise<void> {
    this.host.ensureReady();
    // Deliberately no lastMessage lookup: the `mute` member of ChatModification carries no
    // `lastMessages`, unlike archive/clear/delete, so a chat with no known history mutes fine.
    await this.confirmed(this.sock().chatModify({ mute: muteUntil }, this.host.toEngineJid(chatId)), 'the mute change');
  }

  async pinChat(chatId: string, pin: boolean): Promise<boolean> {
    this.host.ensureReady();
    // No lastMessage lookup: the `pin` member of ChatModification carries no `lastMessages`, unlike
    // archive/clear/delete, so a chat with no known history pins fine. Always true — Baileys writes
    // the app-state patch and reports nothing back, so it has no equivalent of the whatsapp-web.js
    // three-pin refusal to surface.
    await this.confirmed(this.sock().chatModify({ pin }, this.host.toEngineJid(chatId)), 'the pin change');
    return true;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' delete needs the last message; can't synthesize it
    }
    await this.confirmed(
      this.sock().chatModify(
        { delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
        this.host.toEngineJid(chatId),
      ),
      'the chat delete',
    );
    return true;
  }
}
