import {
  BaileysIncomingFields,
  buildIncomingMessageFromBaileys,
  mapBaileysMessageType,
  mapBaileysStatus,
} from './baileys-message-mapper';

describe('mapBaileysMessageType (baileys content-type -> neutral MessageType)', () => {
  it.each([
    ['conversation', false, 'text'],
    ['extendedTextMessage', false, 'text'],
    ['imageMessage', false, 'image'],
    ['videoMessage', false, 'video'],
    ['audioMessage', false, 'audio'],
    ['audioMessage', true, 'voice'],
    ['documentMessage', false, 'document'],
    ['stickerMessage', false, 'sticker'],
    ['locationMessage', false, 'location'],
    ['contactMessage', false, 'contact'],
    [undefined, false, 'unknown'],
    ['pollCreationMessage', false, 'unknown'],
  ])('maps %s (ptt=%s) -> %s', (raw, ptt, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    expect(mapBaileysMessageType(raw as string | undefined, ptt as boolean)).toBe(expected);
  });
});

describe('mapBaileysStatus (proto WAMessageStatus -> neutral DeliveryStatus)', () => {
  it.each([
    [0, 'failed'],
    [1, 'pending'],
    [2, 'sent'],
    [3, 'delivered'],
    [4, 'read'],
    [5, 'read'], // PLAYED collapses to read, mirroring the wwjs adapter
  ])('maps status %s -> %s', (status, expected) => {
    expect(mapBaileysStatus(status)).toBe(expected);
  });

  it('returns null for an unknown/absent status so the adapter skips the ack', () => {
    expect(mapBaileysStatus(undefined)).toBeNull();
    expect(mapBaileysStatus(99)).toBeNull();
  });
});

describe('buildIncomingMessageFromBaileys', () => {
  const base: BaileysIncomingFields = {
    id: 'MSG1',
    remoteJid: '628111@s.whatsapp.net',
    fromMe: false,
    body: 'hi',
    contentType: 'conversation',
    timestamp: 1700000000,
    selfJid: '628999@s.whatsapp.net',
  };

  it('maps a 1:1 inbound message to the neutral shape (chatId, type, non-group)', () => {
    const r = buildIncomingMessageFromBaileys(base);
    expect(r.id).toBe('MSG1');
    expect(r.chatId).toBe('628111@s.whatsapp.net');
    expect(r.from).toBe('628111@s.whatsapp.net');
    expect(r.to).toBe('628999@s.whatsapp.net');
    expect(r.type).toBe('text');
    expect(r.isGroup).toBe(false);
    expect(r.fromMe).toBe(false);
  });

  it('inverts from/to for an outgoing (fromMe) message', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, fromMe: true });
    expect(r.from).toBe('628999@s.whatsapp.net'); // self
    expect(r.to).toBe('628111@s.whatsapp.net'); // chat
  });

  it('applies the supplied normalizer to from/to/chatId on a 1:1 message', () => {
    const normalize = (jid: string) => jid.replace('@s.whatsapp.net', '@c.us');
    const r = buildIncomingMessageFromBaileys(base, normalize);
    expect(r.from).toBe('628111@c.us');
    expect(r.to).toBe('628999@c.us');
    expect(r.chatId).toBe('628111@c.us');
  });

  it('normalizes the group author and self while leaving the group JID intact', () => {
    const normalize = (jid: string) => jid.replace('@s.whatsapp.net', '@c.us');
    const r = buildIncomingMessageFromBaileys(
      { ...base, remoteJid: '123-456@g.us', participant: '628222@s.whatsapp.net' },
      normalize,
    );
    expect(r.from).toBe('123-456@g.us'); // group jid untouched by this normalizer
    expect(r.to).toBe('628999@c.us'); // self normalized
    expect(r.author).toBe('628222@c.us'); // participant normalized
  });

  it('sets author to the participant for a group message and flags isGroup', () => {
    const r = buildIncomingMessageFromBaileys({
      ...base,
      remoteJid: '123-456@g.us',
      participant: '628222@s.whatsapp.net',
    });
    expect(r.isGroup).toBe(true);
    expect(r.author).toBe('628222@s.whatsapp.net');
    expect(r.chatId).toBe('123-456@g.us');
    expect(r.from).toBe('123-456@g.us'); // group inbound: from is the group JID (mirrors wwjs)
    expect(r.to).toBe('628999@s.whatsapp.net'); // recipient is self
  });

  it('flags an @lid 1:1 sender', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, remoteJid: '111@lid' });
    expect(r.isLidSender).toBe(true);
  });

  it('flags an @lid group participant via participant, not the group JID', () => {
    const r = buildIncomingMessageFromBaileys({
      ...base,
      remoteJid: '123-456@g.us',
      participant: '222@lid',
    });
    expect(r.isLidSender).toBe(true);
  });

  it('flags a status broadcast', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, remoteJid: 'status@broadcast' });
    expect(r.isStatusBroadcast).toBe(true);
  });

  it('carries the push name onto contact when present', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, pushName: 'Alice' });
    expect(r.contact).toEqual({ pushName: 'Alice' });
  });

  it('maps ephemeralDuration when present on the fields', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, ephemeralDuration: 604800 });
    expect(r.ephemeralDuration).toBe(604800);
  });

  it('omits ephemeralDuration when absent from the fields', () => {
    expect(buildIncomingMessageFromBaileys(base).ephemeralDuration).toBeUndefined();
  });

  it('omits ephemeralDuration when ephemeralDuration is 0', () => {
    const r = buildIncomingMessageFromBaileys({ ...base, ephemeralDuration: 0 });
    expect(r.ephemeralDuration).toBeUndefined();
  });
});
