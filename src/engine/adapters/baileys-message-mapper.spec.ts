import {
  BaileysIncomingFields,
  buildIncomingMessageFromBaileys,
  extractBaileysBody,
  extractBaileysCommerce,
  extractBaileysContext,
  isBaileysCatalogShare,
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
    // WhatsApp Business interactive shapes carry their display text (e.g. OTP codes) and are flattened
    // to `text` so consumers render them and read the body over the standard API (#562).
    ['interactiveMessage', false, 'text'],
    ['buttonsMessage', false, 'text'],
    ['templateMessage', false, 'text'],
    ['interactiveResponseMessage', false, 'text'],
    // Meta masks high-security business messages (enterprise OTPs) on linked/companion devices,
    // delivering a bodyless `placeholderMessage` (PlaceholderType MASK_LINKED_DEVICES). Surface it as
    // its own `masked` type so it is distinguishable from a genuinely unparseable message (#574).
    ['placeholderMessage', false, 'masked'],
    [undefined, false, 'unknown'],
    // Native polls surface as their own `poll` type (WhatsApp bumps the content key across versions).
    ['pollCreationMessage', false, 'poll'],
    ['pollCreationMessageV2', false, 'poll'],
    ['pollCreationMessageV3', false, 'poll'],
    // Regression trap: calls arrive via the `call` socket event, never as a message content type,
    // so any call-ish token must stay 'unknown' (no accidental mapping).
    ['callLogMessage', false, 'unknown'],
    // WhatsApp Business commerce shapes carry ids the commerce APIs need, so they get their own
    // types instead of collapsing to a bodyless `unknown`.
    ['orderMessage', false, 'order'],
    ['productMessage', false, 'product'],
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

describe('extractBaileysBody (inbound text/caption + interactive shapes)', () => {
  it('returns plain conversation text', () => {
    expect(extractBaileysBody({ conversation: 'hi' })).toBe('hi');
  });

  it('falls back to extendedTextMessage text', () => {
    expect(extractBaileysBody({ extendedTextMessage: { text: 'hey' } })).toBe('hey');
  });

  it('falls back to a media caption', () => {
    expect(extractBaileysBody({ imageMessage: { caption: 'pic' } })).toBe('pic');
    expect(extractBaileysBody({ videoMessage: { caption: 'clip' } })).toBe('clip');
    expect(extractBaileysBody({ documentMessage: { caption: 'doc' } })).toBe('doc');
  });

  // #562: business interactive messages (OTP/verification codes) were dropped as empty body.
  it('extracts interactiveMessage body text', () => {
    expect(extractBaileysBody({ interactiveMessage: { body: { text: 'Your code is 123456' } } })).toBe(
      'Your code is 123456',
    );
  });

  it('extracts buttonsMessage contentText', () => {
    expect(extractBaileysBody({ buttonsMessage: { contentText: 'Verification: 987654' } })).toBe(
      'Verification: 987654',
    );
  });

  it('extracts templateMessage hydrated content text (both field aliases)', () => {
    expect(extractBaileysBody({ templateMessage: { hydratedTemplate: { hydratedContentText: 'OTP 4242' } } })).toBe(
      'OTP 4242',
    );
    expect(
      extractBaileysBody({ templateMessage: { hydratedFourRowTemplate: { hydratedContentText: 'OTP 1111' } } }),
    ).toBe('OTP 1111');
  });

  it('extracts interactiveResponseMessage body text', () => {
    expect(extractBaileysBody({ interactiveResponseMessage: { body: { text: 'Selected: Yes' } } })).toBe(
      'Selected: Yes',
    );
  });

  it('prefers plain text over an interactive fallback when both are present', () => {
    expect(extractBaileysBody({ conversation: 'plain', interactiveMessage: { body: { text: 'ignored' } } })).toBe(
      'plain',
    );
  });

  it('returns empty string when no extractable text is present', () => {
    expect(extractBaileysBody({})).toBe('');
    expect(extractBaileysBody({ interactiveMessage: {} })).toBe('');
    expect(extractBaileysBody({ templateMessage: {} })).toBe('');
  });

  it('extracts a single shared contact card as its raw vCard', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Alice\nEND:VCARD';
    expect(extractBaileysBody({ contactMessage: { vcard } })).toBe(vcard);
  });

  it('joins multiple shared contact cards, one vCard per line, in order', () => {
    const alice = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
    const bob = 'BEGIN:VCARD\nFN:Bob\nEND:VCARD';
    expect(extractBaileysBody({ contactsArrayMessage: { contacts: [{ vcard: alice }, { vcard: bob }] } })).toBe(
      `${alice}\n${bob}`,
    );
  });

  it('skips a contactsArrayMessage entry with no vCard rather than injecting an empty line', () => {
    const alice = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
    expect(extractBaileysBody({ contactsArrayMessage: { contacts: [{ vcard: alice }, { vcard: null }] } })).toBe(alice);
  });

  it('falls through to empty string for an empty contactsArrayMessage', () => {
    expect(extractBaileysBody({ contactsArrayMessage: { contacts: [] } })).toBe('');
  });

  it('prefers plain text over a contact card when somehow both are present', () => {
    expect(extractBaileysBody({ conversation: 'plain', contactMessage: { vcard: 'ignored' } })).toBe('plain');
  });

  it('extracts an inbound poll question across the wire content-key variants', () => {
    expect(extractBaileysBody({ pollCreationMessage: { name: 'Lunch order?' } })).toBe('Lunch order?');
    expect(extractBaileysBody({ pollCreationMessageV2: { name: 'Team offsite?' } })).toBe('Team offsite?');
    expect(extractBaileysBody({ pollCreationMessageV3: { name: 'Standup time?' } })).toBe('Standup time?');
  });

  it('returns empty for a poll with no name rather than falling through to other sources', () => {
    expect(extractBaileysBody({ pollCreationMessage: {} })).toBe('');
    expect(extractBaileysBody({ pollCreationMessage: { name: null } })).toBe('');
  });

  it('extracts a shared event display name', () => {
    expect(extractBaileysBody({ eventMessage: { name: 'Release party' } })).toBe('Release party');
  });

  it('extracts which business button label the user tapped', () => {
    expect(extractBaileysBody({ buttonsResponseMessage: { selectedDisplayText: 'Yes, notify me' } })).toBe(
      'Yes, notify me',
    );
    expect(extractBaileysBody({ templateButtonReplyMessage: { selectedDisplayText: 'Track order' } })).toBe(
      'Track order',
    );
  });
});

describe('extractBaileysContext (quoted body shares the live body extractor)', () => {
  const quoted = (quotedMessage: object) =>
    extractBaileysContext({
      imageMessage: { contextInfo: { stanzaId: 'wamid.original', quotedMessage } },
    }).quotedMessage;

  it('carries a quoted contact card as its vCard', () => {
    const vcard = 'BEGIN:VCARD\nFN:Alice\nEND:VCARD';
    expect(quoted({ contactMessage: { vcard } })).toEqual({ id: 'wamid.original', body: vcard });
  });

  it('carries a quoted poll question', () => {
    expect(quoted({ pollCreationMessage: { name: 'Lunch order?' } })?.body).toBe('Lunch order?');
  });

  it('still carries captions and plain text from the classic sources', () => {
    expect(quoted({ imageMessage: { caption: 'pic' } })?.body).toBe('pic');
    expect(quoted({ conversation: 'the original' })?.body).toBe('the original');
    expect(quoted({ stickerMessage: {} })?.body).toBe('');
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

  it('stamps kind from the chat JID', () => {
    expect(buildIncomingMessageFromBaileys({ ...base, remoteJid: 'abc@newsletter' }).kind).toBe('channel');
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

  it('exposes the status poster from participant as author (status@broadcast is not a group)', () => {
    const r = buildIncomingMessageFromBaileys({
      ...base,
      remoteJid: 'status@broadcast',
      participant: '628111@s.whatsapp.net',
    });
    expect(r.isStatusBroadcast).toBe(true);
    expect(r.isGroup).toBe(false);
    // Without this, buildIncomingStatus can only resolve the poster to the status@broadcast
    // pseudo-JID itself and drops the status entirely.
    expect(r.author).toBe('628111@s.whatsapp.net');
  });

  it('converts extended-text status styling: backgroundArgb -> #RRGGBB, font passed through', () => {
    const r = buildIncomingMessageFromBaileys({
      ...base,
      remoteJid: 'status@broadcast',
      participant: '628111@s.whatsapp.net',
      backgroundArgb: 0xff25d366, // ARGB, alpha in the high byte
      font: 2,
    });
    expect(r.backgroundColor).toBe('#25d366');
    expect(r.font).toBe(2);
  });

  it('leaves styling undefined when the message carries none', () => {
    const r = buildIncomingMessageFromBaileys({ ...base });
    expect(r.backgroundColor).toBeUndefined();
    expect(r.font).toBeUndefined();
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

  it('maps mentionedIds, normalizing each JID, when present', () => {
    const normalize = (jid: string) => jid.replace('@s.whatsapp.net', '@c.us');
    const r = buildIncomingMessageFromBaileys(
      { ...base, mentionedJids: ['111@s.whatsapp.net', '222@s.whatsapp.net'] },
      normalize,
    );
    expect(r.mentionedIds).toEqual(['111@c.us', '222@c.us']);
  });

  it('omits mentionedIds when absent or empty', () => {
    expect(buildIncomingMessageFromBaileys(base).mentionedIds).toBeUndefined();
    expect(buildIncomingMessageFromBaileys({ ...base, mentionedJids: [] }).mentionedIds).toBeUndefined();
  });

  it('normalizes the catalog owner JID, so no commerce field escapes the @c.us convention', () => {
    const normalize = (jid: string) => jid.replace('@s.whatsapp.net', '@c.us');
    const r = buildIncomingMessageFromBaileys(
      {
        ...base,
        contentType: 'productMessage',
        product: { productId: '2', title: 'Sample', businessOwnerJid: '100000000000@s.whatsapp.net' },
      },
      normalize,
    );
    expect(r.product).toEqual({ productId: '2', title: 'Sample', businessOwnerJid: '100000000000@c.us' });
  });

  it('carries the order through untouched, and types a catalog share as unknown', () => {
    expect(
      buildIncomingMessageFromBaileys({ ...base, contentType: 'orderMessage', order: { orderId: '1', token: 't' } })
        .order,
    ).toEqual({ orderId: '1', token: 't' });
    expect(buildIncomingMessageFromBaileys({ ...base, contentType: 'productMessage', isCatalogShare: true }).type).toBe(
      'unknown',
    );
  });
});

describe('extractBaileysCommerce (order / product ids)', () => {
  // Field-for-field shape of an inbound order as WhatsApp sends it; ids and token are placeholders.
  const orderContent = {
    orderMessage: {
      orderId: '1000000000000001',
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  };

  it('extracts the order id and its single-order token', () => {
    expect(extractBaileysCommerce(orderContent, 'orderMessage').order).toEqual({
      orderId: '1000000000000001',
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
  });

  it('keeps the order id when no token came with it', () => {
    const { order } = extractBaileysCommerce({ orderMessage: { orderId: '1' } }, 'orderMessage');
    expect(order).toEqual({ orderId: '1', token: undefined });
  });

  it('extracts the product id and its descriptive fields from a shared product card', () => {
    const { product } = extractBaileysCommerce(
      {
        productMessage: {
          businessOwnerJid: '100000000000@s.whatsapp.net',
          product: { productId: '2000000000000002', title: 'Sample', description: 'A sample' },
        },
      },
      'productMessage',
    );
    expect(product).toEqual({
      productId: '2000000000000002',
      title: 'Sample',
      description: 'A sample',
      businessOwnerJid: '100000000000@s.whatsapp.net',
    });
  });

  it('yields nothing when the id that makes it actionable is missing', () => {
    expect(extractBaileysCommerce({ orderMessage: { token: 'x' } }, 'orderMessage')).toEqual({});
    expect(extractBaileysCommerce({ productMessage: { product: { title: 'A' } } }, 'productMessage')).toEqual({});
  });

  it('yields nothing for a non-commerce content type', () => {
    expect(extractBaileysCommerce(orderContent, 'conversation')).toEqual({});
    expect(extractBaileysCommerce({}, undefined)).toEqual({});
  });
});

describe('isBaileysCatalogShare (the productMessage arm with no product)', () => {
  // There is no `catalogMessage` content type: sharing a whole catalog sends a `productMessage`
  // carrying `catalog` instead of `product`, which would otherwise surface as a `product` message
  // with no product object and an empty body.
  it('detects the catalog arm and maps it to unknown rather than product', () => {
    const content = { productMessage: { catalog: { title: 'Storefront' } } };
    expect(isBaileysCatalogShare(content)).toBe(true);
    expect(mapBaileysMessageType('productMessage', false, true)).toBe('unknown');
    expect(extractBaileysCommerce(content, 'productMessage')).toEqual({});
  });

  it('flattens the catalog title into the body so the message is not empty', () => {
    expect(extractBaileysBody({ productMessage: { catalog: { title: 'Storefront' } } })).toBe('Storefront');
  });

  it('is false for a real product card, and for a productMessage carrying both arms', () => {
    expect(isBaileysCatalogShare({ productMessage: { product: { productId: '2' } } })).toBe(false);
    expect(isBaileysCatalogShare({ productMessage: { product: { productId: '2' }, catalog: { title: 'S' } } })).toBe(
      false,
    );
  });
});
