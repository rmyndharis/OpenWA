import { BaileysSessionStore } from './baileys-session-store';

describe('findContact across identity kinds', () => {
  it('does not answer a phone lookup with a lid contact whose digits are the same', () => {
    const store = new BaileysSessionStore();
    store.upsertContacts([
      { id: '628111@lid', name: 'Other' },
      { id: '777@lid', phoneNumber: '628111@s.whatsapp.net', name: 'Right' },
    ]);

    expect(store.findContact('628111@c.us')?.name).toBe('Right');
  });

  it('does not answer a lid lookup with a phone contact whose digits are the same', () => {
    const store = new BaileysSessionStore();
    store.upsertContacts([
      { id: '777@s.whatsapp.net', name: 'Other' },
      { id: '777@c.us', name: 'Other twin' },
      { id: '628111@s.whatsapp.net', lid: '777@lid', name: 'Right' },
    ]);

    expect(store.findContact('777@lid')?.name).toBe('Right');
  });
});
