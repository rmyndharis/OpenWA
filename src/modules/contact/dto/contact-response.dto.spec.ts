import 'reflect-metadata';
import { DECORATORS } from '@nestjs/swagger';
import { ContactDto } from './contact-response.dto';
import { BaileysSessionStore } from '../../../engine/adapters/baileys-session-store';
import { WwebjsContacts } from '../../../engine/adapters/wwebjs-contacts';
import type { WwebjsEngineHost } from '../../../engine/adapters/wwebjs-host';

const description = (key: string): string | undefined =>
  (
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, ContactDto.prototype, key) as
      { description?: string } | undefined
  )?.description;

// A lid's digits are not a phone number, and the two engines fill `number` differently for a contact addressed by
// its lid. Each case reads what an engine emits next to the text that describes it.
describe('ContactDto.number', () => {
  it('publishes what each engine carries for a lid contact', () => {
    expect(description('number')).toBe(
      'MSISDN digits, without a leading + or any separators, for a `<phone>@c.us` contact. For a `<lid>@lid` ' +
        "contact it depends on the engine: Baileys carries the phone's digits when the phone is known and an empty " +
        "string when it is not; whatsapp-web.js carries the lid's digits, which are not a phone number.",
    );
  });

  it('is the phone digits on Baileys for a lid contact whose phone is known and empty otherwise', () => {
    const store = new BaileysSessionStore();
    store.upsertContacts([
      { id: '123456789012345@lid', name: 'Ada', phoneNumber: '628123456789@s.whatsapp.net' },
      { id: '223456789012345@lid', name: 'Grace' },
    ]);

    const byId = Object.fromEntries(store.listContacts().map(c => [c.id, c.number]));

    expect(byId).toEqual({ '123456789012345@lid': '628123456789', '223456789012345@lid': '' });
  });

  it('is the lid digits on whatsapp-web.js for a lid contact', async () => {
    const raw = {
      id: { _serialized: '123456789012345@lid' },
      number: '123456789012345',
      pushname: 'Ada',
      isMyContact: false,
      isBlocked: false,
    };
    const host = {
      ensureReady: () => undefined,
      getClient: () => ({ getContactById: () => Promise.resolve(raw) }),
    } as unknown as WwebjsEngineHost;

    const contact = await new WwebjsContacts(host).getContactById('123456789012345@lid');

    expect({ id: contact?.id, number: contact?.number }).toEqual({
      id: '123456789012345@lid',
      number: '123456789012345',
    });
  });
});
