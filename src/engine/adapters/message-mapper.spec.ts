import { buildIncomingMessageBase, mapWwebjsMessageType, RawMessageFields } from './message-mapper';

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
    ['revoked', 'revoked'],
    ['e2e_notification', 'unknown'], // any unmapped wwebjs type
  ])('maps wwebjs type %s -> %s', (raw, expected) => {
    expect(mapWwebjsMessageType(raw)).toBe(expected);
  });
});
