import { BadRequestException } from '@nestjs/common';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';
import { ContactService } from './contact.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { WwebjsContacts } from '../../engine/adapters/wwebjs-contacts';
import type { WwebjsEngineHost } from '../../engine/adapters/wwebjs-host';
import { BaileysMessaging, type BaileysMessagingHost } from '../../engine/adapters/baileys-messaging';
import { createLogger } from '../../common/services/logger.service';

/**
 * The number check names a phone number, like the LID lookup beside it. An id of another dialect only looks like
 * one: Baileys turns `<digits>@g.us` or `<digits>@newsletter` into the phone `+<digits>` and spends a query on it,
 * and answers an `@lid` "not on WhatsApp" without asking, and whatsapp-web.js appends `@c.us` to what it is given.
 * The LID lookup refuses those ids with 400 before an engine is asked; the number check must too, and what it does
 * pass on is the digits of the number, whatever the engine.
 */
describe('ContactService number check input', () => {
  const makeService = (engine: Partial<IWhatsAppEngine>) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as IWhatsAppEngine);
    return new ContactService(engines);
  };
  /** The outcome of a call that may refuse at once or later, as a value. */
  const outcomeOf = async (call: () => unknown): Promise<unknown> => {
    try {
      return await call();
    } catch (error) {
      return error;
    }
  };

  describe('an id that is not a phone number', () => {
    it.each([
      '120363021234567890@g.us',
      '120363021234567890@newsletter',
      '120363021234567890@broadcast',
      'status@broadcast',
      '234767895240796@lid',
      '234767895240796@hosted.lid',
      '628111111111:0@g.us@c.us',
      '@c.us',
      '628111111111@example.com',
    ])('refuses %s with 400 without asking the engine, as the LID lookup does', async id => {
      const getNumberId = jest.fn().mockResolvedValue(null);
      const getContactLid = jest.fn().mockResolvedValue(null);
      const service = makeService({ getNumberId, getContactLid });

      // The sibling route, for reference: refused before the engine.
      expect(() => service.getContactLid('s1', id)).toThrow(BadRequestException);
      expect(getContactLid).not.toHaveBeenCalled();

      expect(await outcomeOf(() => service.getNumberId('s1', id))).toBeInstanceOf(BadRequestException);
      expect(getNumberId).not.toHaveBeenCalled();
    });

    it('keeps the hint for a privacy id that the LID lookup gives', async () => {
      const service = makeService({ getNumberId: jest.fn() });

      const error = await outcomeOf(() => service.getNumberId('s1', '234767895240796@lid'));

      expect((error as Error).message).toContain('GET contacts/{contactId}/phone');
    });

    it.each(['abc', '+', '   ', 'NOT A USER@c.us'])('refuses %p, which holds no digits', async value => {
      const getNumberId = jest.fn().mockResolvedValue(null);
      const service = makeService({ getNumberId });

      expect(await outcomeOf(() => service.getNumberId('s1', value))).toBeInstanceOf(BadRequestException);
      expect(getNumberId).not.toHaveBeenCalled();
    });
  });

  describe('a phone number typed any way, or a phone id', () => {
    it.each([
      ['a bare number', '628127000889', '628127000889'],
      ['a formatted number', '+62 812-7000-8896', '6281270008896'],
      ['a number in brackets', '(62) 812 7000 889', '628127000889'],
      ['a phone id', '628127000889@c.us', '628127000889'],
      ['an id in the protocol dialect', '628127000889@s.whatsapp.net', '628127000889'],
      ['an id of a linked device', '628127000889:5@s.whatsapp.net', '628127000889'],
      ['a hosted id', '628127000889@hosted', '628127000889'],
      ['an id with an upper-case domain', '628127000889@C.US', '628127000889'],
    ])('passes %s to the engine as its digits', async (_label, typed, digits) => {
      const getNumberId = jest.fn().mockResolvedValue(`${digits}@c.us`);
      const service = makeService({ getNumberId });

      await expect(service.getNumberId('s1', typed)).resolves.toBe(`${digits}@c.us`);
      expect(getNumberId).toHaveBeenCalledTimes(1);
      expect(getNumberId).toHaveBeenCalledWith(digits);
    });

    it('still answers 400 when the session is not started', () => {
      const service = new ContactService(new EngineRegistry());

      expect(() => service.getNumberId('missing', '628127000889')).toThrow(BadRequestException);
    });
  });

  describe('what each engine receives for a formatted number', () => {
    it('is the digits on whatsapp-web.js, which would otherwise build `+62 812-7000-8000@c.us` in the page', async () => {
      const getNumberId = jest.fn().mockResolvedValue({ _serialized: '6281270008000@c.us' });
      const host = {
        ensureReady: jest.fn(),
        getClient: () => ({ getNumberId }) as unknown as Client,
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        logger: createLogger('contact-number-check-input.spec'),
      } as unknown as WwebjsEngineHost;
      const contacts = new WwebjsContacts(host);
      const service = makeService({ getNumberId: number => contacts.getNumberId(number) });

      await expect(service.getNumberId('s1', '+62 812-7000-8000')).resolves.toBe('6281270008000@c.us');
      expect(getNumberId).toHaveBeenCalledTimes(1);
      expect(getNumberId).toHaveBeenCalledWith('6281270008000');
    });

    it('is the digits on whatsapp-web.js for an id in the protocol dialect, which the library would suffix again', async () => {
      const getNumberId = jest.fn().mockResolvedValue({ _serialized: '6281270008000@c.us' });
      const host = {
        ensureReady: jest.fn(),
        getClient: () => ({ getNumberId }) as unknown as Client,
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        logger: createLogger('contact-number-check-input.spec'),
      } as unknown as WwebjsEngineHost;
      const contacts = new WwebjsContacts(host);
      const service = makeService({ getNumberId: number => contacts.getNumberId(number) });

      await service.getNumberId('s1', '6281270008000@s.whatsapp.net');

      expect(getNumberId).toHaveBeenCalledWith('6281270008000');
    });

    it('is the digits on Baileys, whose contact query would otherwise carry the spaces and hyphens', async () => {
      const onWhatsApp = jest.fn().mockResolvedValue([{ jid: '6281270008000@s.whatsapp.net', exists: true }]);
      const socket = { onWhatsApp } as unknown as WASocket;
      const messaging = new BaileysMessaging({
        ensureReady: () => undefined,
        getSocket: () => socket,
        toNeutralJid: (jid: string) => jid.replace('@s.whatsapp.net', '@c.us'),
      } as unknown as BaileysMessagingHost);
      const service = makeService({ getNumberId: number => messaging.getNumberId(number) });

      await expect(service.getNumberId('s1', '+62 812-7000-8000')).resolves.toBe('6281270008000@c.us');
      expect(onWhatsApp).toHaveBeenCalledTimes(1);
      expect(onWhatsApp).toHaveBeenCalledWith('6281270008000');
    });
  });
});
