import { type Client } from 'whatsapp-web.js';
import { Contact } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { userPart } from '../identity/wa-id';
import { readWid } from '../types/whatsapp-web-js.types';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Contact operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
export class WwebjsContacts {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getContacts(): Promise<Contact[]> {
    this.host.ensureReady();
    try {
      const contacts = await this.client().getContacts();

      return contacts.map(c => ({
        id: c.id._serialized,
        name: c.name || undefined,
        pushName: c.pushname || undefined,
        number: c.number,
        isMyContact: c.isMyContact,
        isBlocked: c.isBlocked,
      }));
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'getContacts');
      throw error;
    }
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.host.ensureReady();
    try {
      const contact = await this.client().getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.host.logger.warn(`Failed to get contact: ${contactId}`, { error: String(error) });
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      const numberId = await this.client().getNumberId(number);
      // Read both property names: a WA Web build that renamed `_serialized` would otherwise make
      // every number look unregistered — and checkNumberExists below reports exactly that.
      return readWid(numberId) ?? null;
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'getNumberId');
      throw error;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      // Queried one id at a time: the batch form is prone to "Evaluation failed" and rate-limiting
      // (whatsapp-web.js #3857/#3969). `pn` is the phone JID (`<digits>@c.us`) when the account knows
      // the mapping; best-effort, so a missing mapping or any failure resolves to null.
      const [result] = await this.client().getContactLidAndPhone([contactId]);
      const pn = result?.pn;
      return pn ? pn.replace(/@c\.us$/i, '').replace(/\D/g, '') || null : null;
    } catch (error) {
      this.host.logger.debug(`resolveContactPhone failed for ${contactId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async upsertContact(contactId: string, firstName: string, lastName = ''): Promise<void> {
    this.host.ensureReady();
    // wwjs addresses the addressbook entry by PHONE NUMBER, not JID (Client.js:3266). lastName is
    // positional and required there, so an absent one is passed as an empty string rather than
    // undefined, which would land in the page-side payload as the literal string "undefined".
    // syncToAddressbook is left at its default (false): writing to the device addressbook is a
    // heavier, separately-consented action than saving the WhatsApp contact.
    await this.client().saveOrEditAddressbookContact(userPart(contactId), firstName, lastName);
    this.host.logger.log(`Saved addressbook contact ${contactId}`);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.client().deleteAddressbookContact(userPart(contactId));
    this.host.logger.log(`Deleted addressbook contact ${contactId}`);
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    const contact = await this.client().getContactById(contactId);
    await contact.block();
    this.host.logger.log(`Blocked contact ${contactId}`);
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    const contact = await this.client().getContactById(contactId);
    await contact.unblock();
    this.host.logger.log(`Unblocked contact ${contactId}`);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      const url = await this.client().getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      // Mirrors getGroupInfo: a dead page and a contact with no picture both land here, and only the
      // second may become null (→ service: the contact simply has no avatar). A transport death
      // surfaced as "no picture" sends operators debugging the wrong layer — report it and answer 503.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getProfilePicture');
        throw new EngineTransportError(`Transport died while reading profile picture for ${contactId}`);
      }
      this.host.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }
}
