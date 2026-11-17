import type { Client } from 'whatsapp-web.js';
import { WwebjsContacts } from './wwebjs-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Six contact operations reported a dead page and then rethrew the raw Puppeteer error, so the
 * caller got HTTP 500 while every one of those routes documents 503 (contact.controller.ts:78,
 * :117, :182, :207, :230, :252). A user hit it on GET /contacts/blocked when the renderer crashed
 * mid-read: the route promises "retry shortly" and answered the one status that says the opposite.
 *
 * The sibling reads in the same file (getContacts, getContactById, getProfilePicture) already made
 * the split, which is why the file answered two different statuses for one kind of failure.
 */
const logger = createLogger('wwebjs-contact-transport-death.spec');

describe('contact operations distinguish a dead page from an ordinary failure', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

  function makeContacts(reject: unknown): {
    contacts: WwebjsContacts;
    reportIfPageTransportError: jest.Mock;
  } {
    const contact = {
      block: jest.fn().mockRejectedValue(reject),
      unblock: jest.fn().mockRejectedValue(reject),
    };
    const client = {
      getNumberId: jest.fn().mockRejectedValue(reject),
      getBlockedContacts: jest.fn().mockRejectedValue(reject),
      saveOrEditAddressbookContact: jest.fn().mockRejectedValue(reject),
      deleteAddressbookContact: jest.fn().mockRejectedValue(reject),
      getContactById: jest.fn().mockResolvedValue(contact),
      // The privacy id a block or unblock is looked up by first; WhatsApp holds one for this number.
      getContactLidAndPhone: jest.fn().mockResolvedValue([{ lid: '100000000000001@lid', pn: '628123@c.us' }]),
    };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
    } as unknown as WwebjsEngineHost;
    return { contacts: new WwebjsContacts(host), reportIfPageTransportError };
  }

  const call = (contacts: WwebjsContacts, op: string): Promise<unknown> =>
    ({
      getNumberId: () => contacts.getNumberId('628123'),
      getBlockedContacts: () => contacts.getBlockedContacts(),
      upsertContact: () => contacts.upsertContact('628123@c.us', 'Ada'),
      deleteContact: () => contacts.deleteContact('628123@c.us'),
      blockContact: () => contacts.blockContact('628123@c.us'),
      unblockContact: () => contacts.unblockContact('628123@c.us'),
    })[op]!();

  const OPS = ['getNumberId', 'getBlockedContacts', 'upsertContact', 'deleteContact', 'blockContact', 'unblockContact'];

  it.each(OPS)('%s answers a dead page with the 503 its route documents', async op => {
    const { contacts, reportIfPageTransportError } = makeContacts(transportError);

    await expect(call(contacts, op)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  // Negative twin: an ordinary page-side failure must still surface untouched. Without this the fix
  // could simply relabel every failure as a 503, which would tell a caller to retry a request that
  // WhatsApp genuinely refused.
  it.each(OPS)('%s still propagates an ordinary failure unchanged', async op => {
    const refusal = new Error('Evaluation failed: contact not found');
    const { contacts, reportIfPageTransportError } = makeContacts(refusal);

    await expect(call(contacts, op)).rejects.toBe(refusal);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});
