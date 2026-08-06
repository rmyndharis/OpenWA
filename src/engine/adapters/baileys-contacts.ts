import type { WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import { ChatSummary, Contact, MediaInput } from '../interfaces/whatsapp-engine.interface';
import { resolveMediaBuffer } from './baileys-messaging';
import { type createLogger } from '../../common/services/logger.service';

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
}

export class BaileysContacts {
  constructor(private readonly host: BaileysContactsHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      return (await this.sock().profilePictureUrl(contactId, 'image')) ?? null;
    } catch (err) {
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
    await this.sock().addOrEditContact(this.host.toEngineJid(contactId), {
      firstName,
      fullName,
      saveOnPrimaryAddressbook: false,
    });
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    // Same app-state key fold as upsertContact — a raw @c.us removal targets a phantom entry.
    await this.sock().removeContact(this.host.toEngineJid(contactId));
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().updateBlockStatus(contactId, 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().updateBlockStatus(contactId, 'unblock');
  }

  async setProfileName(name: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().updateProfileName(name);
  }

  async setProfileStatus(status: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().updateProfileStatus(status);
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
    await this.sock().updateProfilePicture(selfJid, data);
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
    await this.sock().readMessages([last.key]);
    return true;
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' unread toggle needs the last message; can't synthesize it
    }
    await this.sock().chatModify(
      { markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      this.host.toEngineJid(chatId),
    );
    return true;
  }

  async clearChatMessages(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' clear needs the last message; can't synthesize it
    }
    await this.sock().chatModify(
      { clear: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      this.host.toEngineJid(chatId),
    );
    return true;
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' archive toggle needs the last message; can't synthesize it
    }
    await this.sock().chatModify(
      { archive, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      this.host.toEngineJid(chatId),
    );
    return true;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    const last = this.host.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' delete needs the last message; can't synthesize it
    }
    await this.sock().chatModify(
      { delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      this.host.toEngineJid(chatId),
    );
    return true;
  }
}
