import { BaileysSessionStore } from './baileys-session-store';

describe('BaileysSessionStore', () => {
  let store: BaileysSessionStore;
  beforeEach(() => {
    store = new BaileysSessionStore();
  });

  it('upserts contacts (full then partial merge) and maps to neutral', () => {
    store.upsertContacts([{ id: '628111@s.whatsapp.net', notify: 'Al', imgUrl: 'http://p/x.jpg' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice' }]); // partial: name added, notify kept
    const c = store.findContact('628111@s.whatsapp.net');
    expect(c).toEqual({
      id: '628111@s.whatsapp.net',
      name: 'Alice',
      pushName: 'Al',
      number: '628111',
      isMyContact: true,
      isBlocked: false,
      profilePicUrl: 'http://p/x.jpg',
    });
    expect(store.findContact('nope@s.whatsapp.net')).toBeNull();
    expect(store.listContacts()).toHaveLength(1);
  });

  it('records the newest message per chat and surfaces it in getChats', () => {
    store.upsertChats([{ id: '628111@s.whatsapp.net', name: 'Alice', unreadCount: 2 }]);
    store.recordMessage({
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'OLD' },
      message: { conversation: 'old' },
      messageTimestamp: 100,
    });
    store.recordMessage({
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'NEW' },
      message: { conversation: 'newest' },
      messageTimestamp: 200,
    });
    const chats = store.listChats();
    expect(chats).toEqual([
      {
        id: '628111@s.whatsapp.net',
        name: 'Alice',
        isGroup: false,
        unreadCount: 2,
        timestamp: 200,
        lastMessage: 'newest',
      },
    ]);
    expect(store.lastMessage('628111@s.whatsapp.net')).toEqual({
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'NEW' },
      timestamp: 200,
    });
  });

  it('does not overwrite a newer last-message with an older one', () => {
    store.recordMessage({
      key: { remoteJid: 'c@s.whatsapp.net', id: 'NEW' },
      message: {},
      messageTimestamp: 200,
    });
    store.recordMessage({
      key: { remoteJid: 'c@s.whatsapp.net', id: 'OLD' },
      message: {},
      messageTimestamp: 100,
    });
    expect(store.lastMessage('c@s.whatsapp.net')?.key.id).toBe('NEW');
  });

  it('flags a group chat by jid', () => {
    store.upsertChats([{ id: '123-456@g.us', name: 'Grp' }]);
    expect(store.listChats()[0].isGroup).toBe(true);
  });

  it('lastMessage returns null for an unknown chat', () => {
    expect(store.lastMessage('unknown@s.whatsapp.net')).toBeNull();
  });

  it('resolves a phone jid to its user-part, a lid via lidPnMappings, and a contact phoneNumber', () => {
    expect(store.resolvePhone('628111@s.whatsapp.net')).toBe('628111');
    store.addLidMappings([{ lid: '111@lid', pn: '628999@s.whatsapp.net' }]);
    expect(store.resolvePhone('111@lid')).toBe('628999');
    store.upsertContacts([{ id: '222@lid', phoneNumber: '628222@s.whatsapp.net' }]);
    expect(store.resolvePhone('222@lid')).toBe('628222');
    expect(store.resolvePhone('333@lid')).toBeNull();
  });

  it('returns the user-part of an already-neutral @c.us id (a resolved-lid sender arrives as @c.us)', () => {
    // Once inbound ids are canonicalized, a resolved lid reaches resolvePhone as <phone>@c.us. Without
    // this branch senderPhone regresses to null for exactly the case the feature exists to surface.
    expect(store.resolvePhone('628111@c.us')).toBe('628111');
    expect(store.resolvePhone('628111:5@c.us')).toBe('628111');
  });

  it('resolves a :device-suffixed lid via the device-stripped mapping', () => {
    store.addLidMappings([{ lid: '111@lid', pn: '628999@s.whatsapp.net' }]);
    expect(store.resolvePhone('111:7@lid')).toBe('628999');
  });

  describe('toNeutralChat contact-name resolution (#369)', () => {
    it('keeps the chat title when Baileys supplies one (it wins over the contact)', () => {
      store.upsertChats([{ id: '628111@s.whatsapp.net', name: 'Chat Title' }]);
      store.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Saved Name' }]);
      expect(store.listChats()[0].name).toBe('Chat Title');
    });

    it('falls back to the saved contact name for a titleless bare-number chat', () => {
      store.upsertChats([{ id: '628111@s.whatsapp.net' }]); // no chat title
      store.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
      expect(store.listChats()[0].name).toBe('Alice');
    });

    it('resolves a saved name for a @lid chat via the lid->pn mapping', () => {
      store.upsertChats([{ id: '111@lid' }]); // titleless, lid-keyed
      store.addLidMappings([{ lid: '111@lid', pn: '628999@s.whatsapp.net' }]);
      store.upsertContacts([{ id: '628999@s.whatsapp.net', name: 'Carol' }]);
      expect(store.listChats()[0].name).toBe('Carol');
    });

    it('uses pushName (notify) when no saved/verified name exists', () => {
      store.upsertChats([{ id: '628222@s.whatsapp.net' }]);
      store.upsertContacts([{ id: '628222@s.whatsapp.net', notify: 'Dave' }]);
      expect(store.listChats()[0].name).toBe('Dave');
    });

    it('falls back to the raw user-part when nothing is known (last resort)', () => {
      store.upsertChats([{ id: '628333@s.whatsapp.net' }]);
      expect(store.listChats()[0].name).toBe('628333');
    });
  });

  describe('toNeutralJid', () => {
    it('maps @s.whatsapp.net to @c.us and strips the device suffix', () => {
      expect(store.toNeutralJid('628111@s.whatsapp.net')).toBe('628111@c.us');
      expect(store.toNeutralJid('628111:12@s.whatsapp.net')).toBe('628111@c.us');
    });

    it('keeps groups as @g.us and passes status@broadcast / empty through', () => {
      expect(store.toNeutralJid('120363-456@g.us')).toBe('120363-456@g.us');
      expect(store.toNeutralJid('status@broadcast')).toBe('status@broadcast');
      expect(store.toNeutralJid('')).toBe('');
    });

    it('resolves a @lid to <phone>@c.us when known, else keeps the raw lid', () => {
      expect(store.toNeutralJid('111@lid')).toBe('111@lid'); // no mapping yet
      store.addLidMappings([{ lid: '111@lid', pn: '628999@s.whatsapp.net' }]);
      expect(store.toNeutralJid('111@lid')).toBe('628999@c.us');
    });

    it('is idempotent on an already-neutral @c.us id', () => {
      expect(store.toNeutralJid('628111@c.us')).toBe('628111@c.us');
    });
  });
});
