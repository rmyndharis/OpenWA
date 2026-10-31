import {
  buildIncomingMessageBase,
  mapContactFields,
  mapWwebjsMessageType,
  POLL_MAX_OPTIONS,
  POLL_TEXT_MAX_LENGTH,
  RawContactFields,
  RawMessageFields,
} from './message-mapper';

describe('buildIncomingMessageBase', () => {
  const base: RawMessageFields = {
    id: { _serialized: 'MSG1' },
    from: '123@c.us',
    to: 'me@c.us',
    body: 'hi',
    type: 'chat',
    timestamp: 1700000000,
    fromMe: false,
  };

  it('maps the core fields, neutralizes the type (chat -> text), and flags 1:1 chats as non-group', () => {
    const r = buildIncomingMessageBase(base);
    expect(r.id).toBe('MSG1');
    expect(r.chatId).toBe('123@c.us');
    expect(r.type).toBe('text'); // wwebjs 'chat' is neutralized to 'text'
    expect(r.isGroup).toBe(false);
    expect(r.isStatusBroadcast).toBe(false);
    expect(r.author).toBeUndefined();
    expect(r.contact).toBeUndefined();
    expect(r.isLidSender).toBeUndefined(); // a normal @c.us sender is not flagged
  });

  it('stamps kind from the chat JID', () => {
    expect(buildIncomingMessageBase({ ...base, from: '12036@g.us' }).kind).toBe('group');
  });

  it('reads a renamed `$1` id when the dependency has not normalized it (#747)', () => {
    // The live inbound path. Without this, every arriving message on a renamed build carries
    // `id: undefined` — no dedup key, no reply target, nothing to match an ack against.
    const r = buildIncomingMessageBase({ ...base, id: { $1: 'MSG_RENAMED' } });
    expect(r.id).toBe('MSG_RENAMED');
  });

  it('reports an unreadable id as the empty sentinel rather than undefined', () => {
    // `''` means "received, id unreadable" and is normalized to NULL at the persist chokepoint.
    // `undefined` would type-lie about `IncomingMessage.id: string`.
    const r = buildIncomingMessageBase({ ...base, id: {} });
    expect(r.id).toBe('');
  });

  it('flags a 1:1 sender identified by an @lid privacy id (#263)', () => {
    const r = buildIncomingMessageBase({ ...base, from: '111@lid' });
    expect(r.isLidSender).toBe(true);
  });

  it('flags an @lid group participant via author, not the group JID (#263)', () => {
    const r = buildIncomingMessageBase({ ...base, from: 'group-1@g.us', author: '222@lid' });
    expect(r.isLidSender).toBe(true);
  });

  it('does not flag a group whose participant is a normal number', () => {
    const r = buildIncomingMessageBase({ ...base, from: 'group-1@g.us', author: '456@c.us' });
    expect(r.isLidSender).toBeUndefined();
  });

  it('flags a status/story broadcast via isStatusBroadcast (engine pseudo-JID stays in the adapter)', () => {
    const r = buildIncomingMessageBase({ ...base, fromMe: true, from: 'me@c.us', to: 'status@broadcast' });
    expect(r.isStatusBroadcast).toBe(true);
  });

  it('includes author and pushName for a group message', () => {
    const r = buildIncomingMessageBase({
      ...base,
      from: 'group-1@g.us',
      author: '456@c.us',
      _data: { notifyName: 'Alice' },
    });
    expect(r.isGroup).toBe(true);
    expect(r.author).toBe('456@c.us');
    expect(r.contact).toEqual({ pushName: 'Alice' });
  });

  it('omits contact when no push name is present', () => {
    const r = buildIncomingMessageBase({ ...base, author: '789@c.us' });
    expect(r.author).toBe('789@c.us');
    expect(r.contact).toBeUndefined();
  });

  it('maps ephemeralDuration when present on _data', () => {
    const r = buildIncomingMessageBase({
      ...base,
      _data: { ephemeralDuration: 86400 },
    });
    expect(r.ephemeralDuration).toBe(86400);
  });

  it('omits ephemeralDuration when absent from _data', () => {
    expect(buildIncomingMessageBase(base).ephemeralDuration).toBeUndefined();
  });

  it('omits ephemeralDuration when ephemeralDuration is 0', () => {
    const r = buildIncomingMessageBase({
      ...base,
      _data: { ephemeralDuration: 0 },
    });
    expect(r.ephemeralDuration).toBeUndefined();
  });

  it('uses `to` as the chat for an outgoing (fromMe) message, not the account JID in `from`', () => {
    const r = buildIncomingMessageBase({ ...base, fromMe: true, from: 'me@c.us', to: 'peer@c.us' });
    expect(r.chatId).toBe('peer@c.us');
    expect(r.isGroup).toBe(false);
  });

  it('flags an outgoing group send (fromMe) as a group via `to`', () => {
    const r = buildIncomingMessageBase({ ...base, fromMe: true, from: 'me@c.us', to: 'group-1@g.us' });
    expect(r.chatId).toBe('group-1@g.us');
    expect(r.isGroup).toBe(true);
  });

  it('maps mentionedIds when present', () => {
    const r = buildIncomingMessageBase({ ...base, mentionedIds: ['222@lid', '333@lid'] });
    expect(r.mentionedIds).toEqual(['222@lid', '333@lid']);
  });

  it('omits mentionedIds when absent or empty', () => {
    expect(buildIncomingMessageBase(base).mentionedIds).toBeUndefined();
    expect(buildIncomingMessageBase({ ...base, mentionedIds: [] }).mentionedIds).toBeUndefined();
  });

  it('maps an order id and its single-order token', () => {
    const r = buildIncomingMessageBase({ ...base, type: 'order', orderId: '1000000000000001', token: 'tok' });
    expect(r.order).toEqual({ orderId: '1000000000000001', token: 'tok' });
    expect(r.product).toBeUndefined();
  });

  it('maps an order that arrived without a token', () => {
    expect(buildIncomingMessageBase({ ...base, type: 'order', orderId: '1' }).order).toEqual({ orderId: '1' });
  });

  it('maps a shared product card with the fields whatsapp-web.js exposes', () => {
    const r = buildIncomingMessageBase({
      ...base,
      type: 'product',
      productId: '2000000000000002',
      title: 'Sample',
      description: 'A sample',
      businessOwnerJid: '100000000000@c.us',
    });
    expect(r.product).toEqual({
      productId: '2000000000000002',
      title: 'Sample',
      description: 'A sample',
      businessOwnerJid: '100000000000@c.us',
    });
    expect(r.order).toBeUndefined();
  });

  it('yields nothing when the id that makes the message actionable is missing', () => {
    expect(buildIncomingMessageBase({ ...base, type: 'order', token: 'tok' }).order).toBeUndefined();
    // whatsapp-web.js exposes no catalog field, so an id-less product (a whole-catalog share included) keeps its type.
    const product = buildIncomingMessageBase({ ...base, type: 'product', title: 'Sample' });
    expect(product.type).toBe('product');
    expect(product.product).toBeUndefined();
  });

  it('does not fabricate a product from a title on a non-commerce message', () => {
    const r = buildIncomingMessageBase({ ...base, title: 'Sample', productId: '2', orderId: '1' });
    expect(r.product).toBeUndefined();
    expect(r.order).toBeUndefined();
  });
});

describe('mapWwebjsMessageType (engine type-token -> neutral MessageType boundary, #265)', () => {
  it.each([
    ['chat', 'text'],
    ['ptt', 'voice'],
    ['image', 'image'],
    ['video', 'video'],
    ['audio', 'audio'],
    ['document', 'document'],
    ['sticker', 'sticker'],
    ['location', 'location'],
    ['vcard', 'contact'],
    ['multi_vcard', 'contact'],
    ['call_log', 'call'],
    ['revoked', 'revoked'],
    ['poll_creation', 'poll'],
    ['order', 'order'],
    ['product', 'product'],
    // A tapped button, list row or template button: WA Web carries the chosen option's text in the
    // body, and Baileys reports the same replies as text (#562).
    ['buttons_response', 'text'],
    ['list_response', 'text'],
    ['template_button_reply', 'text'],
    ['e2e_notification', 'unknown'], // any unmapped wwebjs type
  ])('maps wwebjs type %s -> %s', (raw, expected) => {
    expect(mapWwebjsMessageType(raw)).toBe(expected);
  });
});

describe('mapContactFields', () => {
  const businessRaw: RawContactFields = {
    id: { _serialized: '254571402260600@lid' },
    number: '254571402260600',
    name: 'Leo hermano',
    pushname: 'leo',
    shortName: 'Leo',
    type: 'in',
    isMyContact: true,
    isWAContact: true,
    isBusiness: true,
    isEnterprise: false,
    verifiedName: 'Leo Store',
    verifiedLevel: 2,
    isBlocked: false,
    labels: ['L1', 'L2'],
  };

  describe('full mode (WEBHOOK_CONTACT_DETAILS opt-in)', () => {
    it('copies the sync fields for a business contact', () => {
      expect(mapContactFields(businessRaw, true)).toEqual({
        id: '254571402260600@lid',
        number: '254571402260600',
        name: 'Leo hermano',
        pushName: 'leo',
        shortName: 'Leo',
        type: 'in',
        isMyContact: true,
        isWAContact: true,
        isBusiness: true,
        isEnterprise: false,
        verifiedName: 'Leo Store',
        verifiedLevel: 2,
        isBlocked: false,
        labels: ['L1', 'L2'],
      });
    });

    it('omits business fields and empty values for a plain personal contact', () => {
      const r = mapContactFields(
        {
          id: { _serialized: '584145200715@c.us' },
          number: '584145200715',
          pushname: 'Ana',
          isMyContact: false,
          isWAContact: true,
          isBusiness: false,
        },
        true,
      );
      expect(r).toEqual({
        id: '584145200715@c.us',
        number: '584145200715',
        pushName: 'Ana',
        isMyContact: false,
        isWAContact: true,
        isBusiness: false,
      });
      expect('verifiedName' in r).toBe(false);
      expect('name' in r).toBe(false);
      expect('labels' in r).toBe(false);
    });

    it('returns an empty object when nothing is set', () => {
      expect(mapContactFields({}, true)).toEqual({});
    });

    it('drops an empty labels array', () => {
      expect(mapContactFields({ labels: [] }, true)).toEqual({});
    });
  });

  describe('minimal mode (default)', () => {
    it('returns only name and pushName even when the contact has full data', () => {
      expect(mapContactFields(businessRaw)).toEqual({ name: 'Leo hermano', pushName: 'leo' });
    });

    it('omits name/pushName when absent and never includes extended fields', () => {
      expect(mapContactFields({ number: '584145200715', isBusiness: true })).toEqual({});
    });
  });
});

describe('poll choice metadata', () => {
  it.each([
    [' Park ', 'Beach'],
    [{ name: ' Park ' }, { name: 'Beach' }],
  ])('preserves choices from the library representation', (...pollOptions) => {
    const mapped = buildIncomingMessageBase({
      id: { _serialized: 'P1' },
      from: 'a@c.us',
      to: 'me',
      body: 'Where?',
      type: 'poll_creation',
      timestamp: 100,
      fromMe: false,
      pollName: 'Where?',
      pollOptions,
      allowMultipleAnswers: true,
    });
    expect(mapped.poll).toEqual({ name: 'Where?', options: [' Park ', 'Beach'], allowMultipleAnswers: true });
  });

  describe('bounds', () => {
    const poll = (over: Partial<RawMessageFields>): RawMessageFields => ({
      id: { _serialized: 'P2' },
      from: 'a@c.us',
      to: 'me',
      body: 'Where?',
      type: 'poll_creation',
      timestamp: 100,
      fromMe: false,
      pollName: 'Where?',
      pollOptions: ['Park', 'Beach'],
      allowMultipleAnswers: false,
      ...over,
    });

    it('keeps a poll WhatsApp itself could send exactly as it is', () => {
      const question = 'q'.repeat(255);
      const options = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(100, 'o'));
      const mapped = buildIncomingMessageBase(poll({ body: question, pollName: question, pollOptions: options }));
      expect(mapped.poll).toEqual({ name: question, options, allowMultipleAnswers: false });
      expect(mapped.body).toBe(question);
    });

    // The numbers are written out here, not read from the constants, so moving either by one shows up.
    it('keeps a poll of 32 options with 1024 characters in each text whole', () => {
      const text = (i: number) => `${i}`.padEnd(1024, 'x');
      const pollOptions = Array.from({ length: 32 }, (_, i) => text(i));
      const mapped = buildIncomingMessageBase(poll({ body: text(99), pollName: text(99), pollOptions }));
      expect(mapped.poll).toEqual({ name: text(99), options: pollOptions, allowMultipleAnswers: false });
      expect(mapped.body).toBe(text(99));
    });

    it('cuts a poll at its 33rd option and at the 1025th character of a text', () => {
      const text = (i: number) => `${i}`.padEnd(1025, 'x');
      const pollOptions = Array.from({ length: 33 }, (_, i) => text(i));
      const mapped = buildIncomingMessageBase(poll({ body: text(99), pollName: text(99), pollOptions }));
      expect(mapped.poll?.options).toEqual(pollOptions.slice(0, 32).map(option => option.slice(0, 1024)));
      expect(mapped.poll?.name).toBe(text(99).slice(0, 1024));
      expect(mapped.body).toBe(text(99).slice(0, 1024));
    });

    it('truncates an oversized poll, in the poll and in the body, and keeps it a poll', () => {
      const long = 'x'.repeat(POLL_TEXT_MAX_LENGTH * 3);
      const pollOptions = Array.from({ length: POLL_MAX_OPTIONS * 50 }, (_, i) => ({ name: `${i}${long}` }));
      const mapped = buildIncomingMessageBase(poll({ body: long, pollName: long, pollOptions }));
      expect(mapped.type).toBe('poll');
      expect(mapped.poll?.options).toHaveLength(POLL_MAX_OPTIONS);
      expect(mapped.poll?.options.every(option => option.length === POLL_TEXT_MAX_LENGTH)).toBe(true);
      expect(mapped.poll?.options[1].startsWith('1xxx')).toBe(true);
      expect(mapped.poll?.name).toHaveLength(POLL_TEXT_MAX_LENGTH);
      expect(mapped.body).toHaveLength(POLL_TEXT_MAX_LENGTH);
    });
  });
});
