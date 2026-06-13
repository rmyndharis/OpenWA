import { buildIncomingMessageBase, RawMessageFields } from './message-mapper';

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

  it('maps the core fields and flags 1:1 chats as non-group', () => {
    const r = buildIncomingMessageBase(base);
    expect(r.id).toBe('MSG1');
    expect(r.chatId).toBe('123@c.us');
    expect(r.isGroup).toBe(false);
    expect(r.author).toBeUndefined();
    expect(r.contact).toBeUndefined();
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
});
