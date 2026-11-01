import type { Client } from 'whatsapp-web.js';
import { WwebjsContacts } from './wwebjs-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

const logger = createLogger('wwebjs-contact-lookups.spec');
const PROTOCOL_TIMEOUT = new Error(
  "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
);

function setup(client: Record<string, jest.Mock>) {
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsContacts(host);
}

describe('WwebjsContacts.resolveContactPhone', () => {
  // getContactLidAndPhone asks WhatsApp whether a phone number exists when the page holds no LID for it. That is
  // the check `GET contacts/check/{number}` reserves for OPERATOR keys, and this route is open to every key.
  it.each(['628123456789@c.us', '628123456789@s.whatsapp.net', '628123456789:5@c.us'])(
    'answers %s from the id and never asks the page',
    async id => {
      const getContactLidAndPhone = jest.fn();

      await expect(setup({ getContactLidAndPhone }).resolveContactPhone(id)).resolves.toBe('628123456789');
      expect(getContactLidAndPhone).not.toHaveBeenCalled();
    },
  );

  it.each(['120363021234567890@g.us', '123456789@newsletter', 'status@broadcast', 'not-an-id'])(
    'answers null for %s, which names no phone, without asking the page',
    async id => {
      const getContactLidAndPhone = jest.fn();

      await expect(setup({ getContactLidAndPhone }).resolveContactPhone(id)).resolves.toBeNull();
      expect(getContactLidAndPhone).not.toHaveBeenCalled();
    },
  );

  it('still asks the page about a privacy id, the one thing it needs the page for', async () => {
    const getContactLidAndPhone = jest.fn().mockResolvedValue([{ lid: '159442138038327@lid', pn: '628111@c.us' }]);

    await expect(setup({ getContactLidAndPhone }).resolveContactPhone('159442138038327@lid')).resolves.toBe('628111');
    expect(getContactLidAndPhone).toHaveBeenCalledWith(['159442138038327@lid']);
  });

  it('answers null for a privacy id the page holds no phone for', async () => {
    const getContactLidAndPhone = jest.fn().mockResolvedValue([{ lid: '159442138038327@lid' }]);

    await expect(setup({ getContactLidAndPhone }).resolveContactPhone('159442138038327@lid')).resolves.toBeNull();
  });
});

describe('WwebjsContacts lookups that outrun the protocol budget', () => {
  it('answers a timed-out LID lookup with the 503 the route documents, not the raw timeout', async () => {
    const contacts = setup({ getContactLidAndPhone: jest.fn().mockRejectedValue(PROTOCOL_TIMEOUT) });

    await expect(contacts.getContactLid('628123456789')).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('answers a timed-out number check with a 503 on both entry points', async () => {
    const contacts = setup({ getNumberId: jest.fn().mockRejectedValue(PROTOCOL_TIMEOUT) });

    await expect(contacts.getNumberId('628123456789')).rejects.toBeInstanceOf(EngineTransportError);
    await expect(contacts.checkNumberExists('628123456789')).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('answers a timed-out blocklist read with the 503 its route documents', async () => {
    const contacts = setup({ getBlockedContacts: jest.fn().mockRejectedValue(PROTOCOL_TIMEOUT) });

    await expect(contacts.getBlockedContacts()).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('leaves an ordinary page failure as the failure it is', async () => {
    const refusal = new Error('Evaluation failed: lookup refused');
    const contacts = setup({
      getContactLidAndPhone: jest.fn().mockRejectedValue(refusal),
      getNumberId: jest.fn().mockRejectedValue(refusal),
    });

    await expect(contacts.getContactLid('628123456789')).rejects.toBe(refusal);
    await expect(contacts.getNumberId('628123456789')).rejects.toBe(refusal);
  });
});
