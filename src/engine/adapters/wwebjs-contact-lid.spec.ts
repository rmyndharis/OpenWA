import type { Client } from 'whatsapp-web.js';
import { WwebjsContacts } from './wwebjs-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

const logger = createLogger('wwebjs-contact-lid.spec');
const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

function setup(getContactLidAndPhone: jest.Mock) {
  const reportIfPageTransportError = jest.fn();
  const host = {
    ensureReady: jest.fn(),
    getClient: () => ({ getContactLidAndPhone }) as unknown as Client,
    isPageTransportError: (error: unknown) => error === transportError,
    reportIfPageTransportError,
    logger,
  } as unknown as WwebjsEngineHost;
  return { contacts: new WwebjsContacts(host), reportIfPageTransportError };
}

describe('WwebjsContacts.getContactLid', () => {
  it('returns the lid WhatsApp Web holds for the phone id', async () => {
    const lookup = jest.fn().mockResolvedValue([{ lid: '234767895240796@lid', pn: '60123456789@c.us' }]);

    await expect(setup(lookup).contacts.getContactLid('+60 123-456-789')).resolves.toBe('234767895240796@lid');
    expect(lookup).toHaveBeenCalledWith(['60123456789@c.us']);
  });

  it.each([
    ['an unregistered number, which the page answers with no id at all', [{ lid: undefined, pn: undefined }]],
    ['an account WhatsApp Web holds no lid for', [{ lid: undefined, pn: '60123456789@c.us' }]],
    ['no row at all', []],
    ['a lid that is not a privacy id', [{ lid: '60123456789@c.us' }]],
  ])('answers null for %s', async (_label, rows) => {
    await expect(setup(jest.fn().mockResolvedValue(rows)).contacts.getContactLid('60123456789')).resolves.toBeNull();
  });

  it.each(['', 'abc', '@c.us'])('answers null without asking the page when %j holds no digits', async typed => {
    const lookup = jest.fn();

    await expect(setup(lookup).contacts.getContactLid(typed)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('answers a dead page with the 503 the route documents', async () => {
    const { contacts, reportIfPageTransportError } = setup(jest.fn().mockRejectedValue(transportError));

    await expect(contacts.getContactLid('60123456789')).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, 'getContactLid');
  });

  it('still propagates an ordinary failure unchanged', async () => {
    const refusal = new Error('Evaluation failed: lookup refused');

    await expect(setup(jest.fn().mockRejectedValue(refusal)).contacts.getContactLid('60123456789')).rejects.toBe(
      refusal,
    );
  });
});
