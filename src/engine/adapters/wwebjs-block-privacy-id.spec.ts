import type { Client } from 'whatsapp-web.js';
import { WwebjsContacts } from './wwebjs-contacts';
import { type WwebjsEngineHost } from './wwebjs-host';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';

/**
 * WhatsApp blocks and unblocks by privacy id. whatsapp-web.js reads that id from what the page already holds for
 * the number and does not guard a miss: `Contact.unblock()` reads `_serialized` of nothing, and `Contact.block()`
 * hands WhatsApp a contact whose id is undefined. Both reached the caller as an opaque 500 for a number the session
 * had never talked to.
 */
describe('block and unblock of a number by the privacy id WhatsApp holds for it', () => {
  const LID = '100000000000001@lid';

  function wire(lookup: unknown[]) {
    const contact = { block: jest.fn().mockResolvedValue(true), unblock: jest.fn().mockResolvedValue(true) };
    const client = {
      getContactLidAndPhone: jest.fn().mockResolvedValue(lookup),
      getContactById: jest.fn().mockResolvedValue(contact),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger: { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    } as unknown as WwebjsEngineHost;
    return { contacts: new WwebjsContacts(host), client, contact };
  }

  const OPS: Array<['block' | 'unblock', (contacts: WwebjsContacts, id: string) => Promise<void>]> = [
    ['block', (contacts, id) => contacts.blockContact(id)],
    ['unblock', (contacts, id) => contacts.unblockContact(id)],
  ];

  it.each(OPS)('%ss once the lookup has put the id in the page', async (op, run) => {
    const { contacts, client, contact } = wire([{ lid: LID, pn: '628123@c.us' }]);

    await run(contacts, '628123@c.us');

    // Asked the way the library's lookup takes a phone id, and before the contact is fetched.
    expect(client.getContactLidAndPhone).toHaveBeenCalledWith(['628123@c.us']);
    expect(client.getContactLidAndPhone.mock.invocationCallOrder[0]).toBeLessThan(
      client.getContactById.mock.invocationCallOrder[0],
    );
    expect(contact[op]).toHaveBeenCalledTimes(1);
  });

  // The lookup answers an empty object for a number that is not on WhatsApp.
  it.each(OPS)('refuses to %s a number WhatsApp holds no id for with 400, and sends nothing', async (op, run) => {
    const { contacts, client, contact } = wire([{}]);

    const refusal = run(contacts, '628123@c.us');

    await expect(refusal).rejects.toBeInstanceOf(RecipientUnreachableError);
    await expect(refusal).rejects.toMatchObject({ status: 400 });
    expect(client.getContactById).not.toHaveBeenCalled();
    expect(contact[op]).not.toHaveBeenCalled();
  });

  it.each(OPS)('%ss a contact named by its privacy id without a lookup', async (op, run) => {
    const { contacts, client, contact } = wire([{}]);

    await run(contacts, LID);

    expect(client.getContactLidAndPhone).not.toHaveBeenCalled();
    expect(contact[op]).toHaveBeenCalledTimes(1);
  });

  it.each(OPS)('asks by the bare number when the id comes in the other phone dialect (%s)', async (_op, run) => {
    const { contacts, client } = wire([{ lid: LID }]);

    await run(contacts, '628123@s.whatsapp.net');

    expect(client.getContactLidAndPhone).toHaveBeenCalledWith(['628123@c.us']);
  });
});
