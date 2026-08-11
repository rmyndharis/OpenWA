import { type Client } from 'whatsapp-web.js';
import { Contact } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { userPart } from '../identity/wa-id';
import { readWid, type SerializedWid } from '../types/whatsapp-web-js.types';
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
      // Unlike the avatar lookup, a throw here can legitimately mean the contact is absent:
      // `window.WWebJS.getContact` has no try/catch and reads `contact.isBusiness` straight off
      // `Contact.find`, so an unknown id throws a TypeError on null. Null (→ 404) stays the answer
      // for that. A dead page is not a missing contact, though, and this was the one lookup that
      // never separated the two.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getContactById');
        throw new EngineTransportError(`Transport died while reading contact ${contactId}`);
      }
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

  /**
   * The read half of block/unblockContact. Ids only — the neutral common subset with Baileys,
   * whose blocklist query answers bare jids. An entry whose wid is unreadable (#747 rename
   * hazard) is dropped rather than reported as the literal "undefined".
   */
  async getBlockedContacts(): Promise<string[]> {
    this.host.ensureReady();
    try {
      const contacts = await this.client().getBlockedContacts();
      return contacts.map(c => readWid(c.id as unknown as SerializedWid)).filter((id): id is string => Boolean(id));
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'getBlockedContacts');
      throw error;
    }
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
      // Nothing reaching here is a statement about the avatar, so nothing reaching here may become
      // null. Returning null would answer 200 with {"url": null} — byte-identical to the verdict
      // above — and a caller that caches "no avatar" would record absence for a lookup that never
      // produced one. The page throws for two distinct reasons and we cannot tell them apart from
      // the message: `getChat` failing to resolve the contact at all, or the profile-pic bridge
      // failing. 404 would assert the first; 503 says only that we could not reach an answer, which
      // is all we know.
      //
      // NOTE the Baileys adapter does the OPPOSITE on this same interface method, and correctly:
      // there a no-picture verdict *is* delivered as a throw, so it swallows to null and uses its
      // own deadline to separate a verdict from a non-answer. Do not harmonise the two into a shared
      // helper — the engines disagree about what a throw means.
      this.host.reportIfPageTransportError(error, 'getProfilePicture');
      this.host.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      throw new EngineTransportError(`Could not read the profile picture for ${contactId}: ${String(error)}`);
    }
  }
}
