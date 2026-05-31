import { Contact } from '../../interfaces/whatsapp-engine.interface';
import { AdapterContext } from './context';

/**
 * Contact concern: lookups, existence checks, profile pictures, block/unblock.
 * Bodies moved verbatim from the monolithic adapter; behavior is identical.
 */
export class ContactAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getContacts(): Promise<Contact[]> {
    const client = this.ctx.requireClient();
    const contacts = await client.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    const client = this.ctx.requireClient();
    try {
      const contact = await client.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.ctx.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    const client = this.ctx.requireClient();
    const numberId = await client.getNumberId(number);
    return numberId !== null;
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    const client = this.ctx.requireClient();
    try {
      const url = await client.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.ctx.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    const client = this.ctx.requireClient();
    const contact = await client.getContactById(contactId);
    await contact.block();
    this.ctx.logger.log(`Blocked contact ${contactId}`);
  }

  async unblockContact(contactId: string): Promise<void> {
    const client = this.ctx.requireClient();
    const contact = await client.getContactById(contactId);
    await contact.unblock();
    this.ctx.logger.log(`Unblocked contact ${contactId}`);
  }
}
