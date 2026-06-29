import {
  buildIncomingMessageBase,
  mapContactFields,
  mapWwebjsMessageType,
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
