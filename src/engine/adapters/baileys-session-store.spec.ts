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
      id: '628111@c.us', // listing ids are emitted in the neutral dialect

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
        id: '628111@c.us', // listing ids are emitted in the neutral dialect
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

  describe('getEphemeralExpiration (#473)', () => {
    it('returns the cached disappearing-messages timer for a chat', () => {
      store.upsertChats([{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
      expect(store.getEphemeralExpiration('628111@s.whatsapp.net')).toBe(604800);
    });

    it('accepts a neutral @c.us id and folds it to the engine dialect for lookup', () => {
      store.upsertChats([{ id: '628111@s.whatsapp.net', ephemeralExpiration: 86400 }]);
      expect(store.getEphemeralExpiration('628111@c.us')).toBe(86400);
    });

    it('returns undefined when the chat is unknown, disabled (0), or null (no forced disappear)', () => {
      store.upsertChats([{ id: '628222@s.whatsapp.net', ephemeralExpiration: 0 }]);
      store.upsertChats([{ id: '628333@s.whatsapp.net', ephemeralExpiration: null }]);
      store.upsertChats([{ id: '628444@s.whatsapp.net' }]); // field absent
      expect(store.getEphemeralExpiration('628222@s.whatsapp.net')).toBeUndefined();
      expect(store.getEphemeralExpiration('628333@s.whatsapp.net')).toBeUndefined();
      expect(store.getEphemeralExpiration('628444@s.whatsapp.net')).toBeUndefined();
      expect(store.getEphemeralExpiration('nope@s.whatsapp.net')).toBeUndefined();
    });

    it('learns the timer from an inbound message ephemeralDuration without any chats.* upsert', () => {
      // The real-world case: Chat.ephemeralExpiration is never populated, but every inbound message in
      // a disappearing chat carries the live timer. A neutral @c.us send target must resolve it too.
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' },
        messageTimestamp: 100,
        ephemeralDuration: 7776000,
      });
      expect(store.getEphemeralExpiration('628111@s.whatsapp.net')).toBe(7776000);
      expect(store.getEphemeralExpiration('628111@c.us')).toBe(7776000);
    });

    it('resolves a timer learned under @lid when the send targets the phone jid (#473 LID migration)', () => {
      store.addLidMappings([{ lid: '41562515988583@lid', pn: '5491169954736@s.whatsapp.net' }]);
      store.recordMessage({
        key: { remoteJid: '41562515988583@lid', fromMe: false, id: 'M2' },
        message: { conversation: 'hola' },
        messageTimestamp: 100,
        ephemeralDuration: 7776000,
      });
      // matchwa replies to the neutral phone jid OpenWA delivered on the webhook — the prior no-op case.
      expect(store.getEphemeralExpiration('5491169954736@c.us')).toBe(7776000);
      expect(store.getEphemeralExpiration('5491169954736@s.whatsapp.net')).toBe(7776000);
      expect(store.getEphemeralExpiration('41562515988583@lid')).toBe(7776000);
    });

    it('ignores a non-positive ephemeralDuration and never clears a known timer', () => {
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' },
        messageTimestamp: 100,
        ephemeralDuration: 86400,
      });
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M2' },
        message: { conversation: 'later' },
        messageTimestamp: 200,
        ephemeralDuration: 0,
      });
      expect(store.getEphemeralExpiration('628111@s.whatsapp.net')).toBe(86400);
    });

    it('prefers the message-learned timer over a stale Chat.ephemeralExpiration', () => {
      store.upsertChats([{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' },
        messageTimestamp: 100,
        ephemeralDuration: 7776000,
      });
      expect(store.getEphemeralExpiration('628111@s.whatsapp.net')).toBe(7776000);
    });

    it('learns the timer from contextInfo.expiration when ephemeralDuration is absent (live 1:1)', () => {
      // WebMessageInfo.ephemeralDuration is empty on a live 1:1 upsert; the per-message expiration on the
      // content's contextInfo is the reliable source.
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { extendedTextMessage: { text: 'hi', contextInfo: { expiration: 7776000 } } },
        messageTimestamp: 100,
      });
      expect(store.getEphemeralExpiration('628111@s.whatsapp.net')).toBe(7776000);
    });

    it('unwraps an ephemeralMessage envelope to read contextInfo.expiration', () => {
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M2' },
        message: {
          ephemeralMessage: { message: { extendedTextMessage: { text: 'hi', contextInfo: { expiration: 86400 } } } },
        },
        messageTimestamp: 100,
      });
      expect(store.getEphemeralExpiration('628111@c.us')).toBe(86400);
    });
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

  describe('recordKeyLidMappings (#362)', () => {
    it('learns a lid->pn mapping from an inbound message key (senderLid/senderPn)', () => {
      store.recordKeyLidMappings({ senderLid: '111@lid', senderPn: '628999@s.whatsapp.net' });
      expect(store.resolvePhone('111@lid')).toBe('628999');
    });

    it('learns a group participant lid->pn mapping (participantLid/participantPn)', () => {
      store.recordKeyLidMappings({ participantLid: '222@lid', participantPn: '628222@s.whatsapp.net' });
      expect(store.resolvePhone('222@lid')).toBe('628222');
    });

    it('canonicalizes a @lid to <phone>@c.us once the key mapping is learned', () => {
      expect(store.toNeutralJid('111@lid')).toBe('111@lid'); // unknown yet
      store.recordKeyLidMappings({ senderLid: '111@lid', senderPn: '628111@s.whatsapp.net' });
      expect(store.toNeutralJid('111@lid')).toBe('628111@c.us');
    });

    it('ignores a key with no lid/pn pair', () => {
      store.recordKeyLidMappings({});
      store.recordKeyLidMappings({ senderLid: '333@lid' }); // lid without pn
      expect(store.resolvePhone('333@lid')).toBeNull();
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

  describe('neutral contact/chat ids (round-trip)', () => {
    it('emits @c.us listing ids and accepts a neutral id back on lookup', () => {
      store.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
      store.upsertChats([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
      store.recordMessage({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' },
        messageTimestamp: 100,
      });
      // listing emits the neutral dialect
      expect(store.listContacts()[0].id).toBe('628111@c.us');
      expect(store.listChats()[0].id).toBe('628111@c.us');
      // and the read-back paths accept that same neutral id (folded to the engine dialect internally)
      expect(store.findContact('628111@c.us')?.id).toBe('628111@c.us');
      expect(store.lastMessage('628111@c.us')?.key.id).toBe('M1');
    });

    it('keeps group ids unchanged', () => {
      store.upsertChats([{ id: '120363-9@g.us', name: 'Team' }]);
      expect(store.listChats()[0].id).toBe('120363-9@g.us');
    });
  });

  describe('persistent lid->phone table', () => {
    const makeFakeLidStore = () => {
      const map = new Map<string, string | null>();
      return {
        map,
        getCached: jest.fn((lid: string) => map.get(lid)),
        lidsForPhone: jest.fn(() => [] as string[]),
        remember: jest.fn((lid: string, phone: string | null) => {
          map.set(lid, phone);
          return Promise.resolve();
        }),
      };
    };

    it('writes learned mappings through to the table (bare digits + session provenance)', () => {
      const lidStore = makeFakeLidStore();
      const s = new BaileysSessionStore(lidStore, 'sess-1');
      s.addLidMappings([{ lid: '111@lid', pn: '628999@s.whatsapp.net' }]);
      // Baileys 6.7.23 carries the phone in `jid`; the WhatsApp Business shape uses `phoneNumber`.
      s.upsertContacts([{ id: '222@lid', lid: '222@lid', jid: '628222@s.whatsapp.net' }]);
      s.upsertContacts([{ id: '333@lid', lid: '333@lid', phoneNumber: '628333@s.whatsapp.net' }]);
      expect(lidStore.remember).toHaveBeenCalledWith('111', '628999', 'sess-1');
      expect(lidStore.remember).toHaveBeenCalledWith('222', '628222', 'sess-1');
      expect(lidStore.remember).toHaveBeenCalledWith('333', '628333', 'sess-1');
    });

    it('pairs a lid and phone that arrive in separate contact updates', () => {
      const lidStore = makeFakeLidStore();
      const s = new BaileysSessionStore(lidStore, 'sess-1');
      s.upsertContacts([{ id: 'c1', lid: '444@lid' }]); // lid first, no phone yet
      expect(lidStore.remember).not.toHaveBeenCalled();
      s.upsertContacts([{ id: 'c1', jid: '628444@s.whatsapp.net' }]); // phone arrives later
      expect(lidStore.remember).toHaveBeenCalledWith('444', '628444', 'sess-1');
    });

    it('resolves a lid via the persistent cache when the in-session map misses', () => {
      const lidStore = makeFakeLidStore();
      lidStore.map.set('444', '628777'); // known only to the cross-session table
      const s = new BaileysSessionStore(lidStore, 'sess-1');
      expect(s.resolvePhone('444@lid')).toBe('628777');
      expect(s.toNeutralJid('444@lid')).toBe('628777@c.us');
    });

    it('returns null for a cached-negative or unseen lid', () => {
      const lidStore = makeFakeLidStore();
      lidStore.map.set('555', null); // known-but-unresolved
      const s = new BaileysSessionStore(lidStore, 'sess-1');
      expect(s.resolvePhone('555@lid')).toBeNull();
      expect(s.resolvePhone('666@lid')).toBeNull();
    });
  });
});
