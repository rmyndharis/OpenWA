import type { Chat, WAMessage } from '@whiskeysockets/baileys';
import { BaileysSessionStore } from './baileys-session-store';
import {
  mergeTwinStates,
  type ChatStateField,
  type ChatStateStore,
  type ChatStateValue,
} from './baileys-chat-state-store.service';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * In-memory ChatStateStore. With `foldDelayMs` a fold lands after the caller returns, as the real store's
 * does on its write chain, and a forget queues behind it on the same chain.
 */
class FakeChatStateStore implements ChatStateStore {
  readonly rows = new Map<string, ChatStateValue>();
  private chain: Promise<void> = Promise.resolve();
  private clock = 1_000_000;
  constructor(private readonly foldDelayMs = 0) {}
  private key(s: string, c: string): string {
    return `${s}\u0000${c}`;
  }
  get(s: string, c: string): ChatStateValue | undefined {
    return this.rows.get(this.key(s, c));
  }
  chatIds(s: string): string[] {
    return [...this.rows.keys()].filter(k => k.startsWith(`${s}\u0000`)).map(k => k.slice(s.length + 1));
  }
  remember(s: string, c: string, patch: Partial<ChatStateValue>): Promise<void> {
    const existing = this.rows.get(this.key(s, c)) ?? {
      muteEndTime: null,
      archived: false,
      pinned: false,
      observed: [],
    };
    const observed = [...new Set([...(existing.observed ?? []), ...(Object.keys(patch) as ChatStateField[])])];
    this.rows.set(this.key(s, c), { ...existing, ...patch, observed, updatedAt: ++this.clock });
    return Promise.resolve();
  }
  reload(): Promise<void> {
    return Promise.resolve();
  }
  clearSession(): Promise<void> {
    return Promise.resolve();
  }
  fold(s: string, c: string, twins: string[], patch: Partial<ChatStateValue>): Promise<void> {
    const apply = (): Promise<void> => {
      const found = twins.filter(t => this.rows.has(this.key(s, t)));
      const merged = mergeTwinStates([c, ...found].flatMap(t => this.get(s, t) ?? []));
      for (const t of found) this.rows.delete(this.key(s, t));
      return this.remember(s, c, { ...(merged ?? {}), ...patch });
    };
    if (!this.foldDelayMs) return apply();
    this.chain = this.chain.then(() => new Promise<void>(resolve => setTimeout(resolve, this.foldDelayMs))).then(apply);
    return this.chain;
  }
  forget(s: string, chatIds: string[]): Promise<void> {
    this.chain = this.chain.then(() => {
      for (const c of chatIds) this.rows.delete(this.key(s, c));
    });
    return this.chain;
  }
  refreshSession(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A chat deleted through the API (chats.delete, replayed by Baileys from its own patch) and then written to
 * again. The deletion is dated in milliseconds by the gateway's clock; a message carries whole seconds, so a
 * message from the deletion's own second is told apart by the order this session observed the two in.
 */
describe('Baileys chat deleted and then sent to within the same second', () => {
  const SID = 'sess-1';
  const PHONE = '628111@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 30));
  const message = (id: string, atMs: number, fromMe = true): WAMessage => ({
    key: { remoteJid: PHONE, fromMe, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });

  function deletedChat(foldDelayMs = 0) {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore(foldDelayMs));
    store.upsertChats([{ id: PHONE, conversationTimestamp: 1_799_990_000 }]);
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PHONE]);
    return { store, now };
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['the mark has been written', 0],
    ['the mark is still on its way to the store', 5],
  ])('lists the chat a message sent half a second after the deletion re-created, when %s', async (_label, delay) => {
    const { store, now } = deletedChat(delay);
    if (!delay) {
      await settle();
      expect(store.listChats()).toEqual([]);
    }

    now.mockReturnValue(DELETED_AT_MS + 500);
    store.recordMessage(message('3EB0SENTAFTERTHEDELETE', DELETED_AT_MS + 500), 'text');
    await settle();

    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(PHONE)).toBeNull();
  });

  // A message from the next second clears the mark by timestamp alone, but one recorded before the mark
  // reached the store used to leave it behind once it landed.
  it('clears a mark that lands after a message from the next second re-created the chat', async () => {
    const { store, now } = deletedChat(5);

    now.mockReturnValue(DELETED_AT_MS + 1500);
    store.recordMessage(message('3EB0NEXTSECOND', DELETED_AT_MS + 1500), 'text');
    await settle();

    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(PHONE)).toBeNull();
  });

  it('keeps the chat deleted for a message of the same second that arrived before the deletion', async () => {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
    store.upsertChats([{ id: PHONE, conversationTimestamp: 1_799_990_000 }]);
    // Its place in the order is taken on arrival, before the media download that can delay its record.
    const arrived = store.nextMessageOrder();
    jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PHONE]);

    store.recordMessage(message('3EB0BEFORETHEDELETE', DELETED_AT_MS - 200, false), 'text', arrived);
    await settle();

    expect(store.listChats()).toEqual([]);
    expect(store.chatDeletedAt(PHONE)).toBe(DELETED_AT_MS);
  });

  it.each([
    ['a history message of the same second', DELETED_AT_MS - 100, 0],
    ['a message from an earlier second delivered late', DELETED_AT_MS - 5_000, undefined],
  ])('keeps the chat deleted for %s', async (_label, atMs, order) => {
    const { store } = deletedChat();

    store.recordMessage(message('3EB0OLDER', atMs, false), 'text', order);
    await settle();

    expect(store.listChats()).toEqual([]);
    expect(store.chatDeletedAt(PHONE)).toBe(DELETED_AT_MS);
  });
});

/**
 * WhatsApp follows each message received with an update of its chat: the message's time, one more unread, and
 * the message itself. The adapter applies that update at once, while the message is still on its way to its
 * record, so in the deletion's own second the update arrives before anything shows the message is newer.
 */
describe('Baileys chat re-created by a message received in its deletion second', () => {
  const SID = 'sess-1';
  const PEER = '628111@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const received = (id: string, atMs: number): WAMessage => ({
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });
  const chatUpdate = (msg: WAMessage): Partial<Chat> => ({
    id: PEER,
    conversationTimestamp: Number(msg.messageTimestamp),
    unreadCount: 1,
    messages: [{ message: msg }],
  });
  const unreadCount = (store: BaileysSessionStore): number | undefined =>
    store.listChats().find(chat => chat.id === '628111@c.us')?.unreadCount;

  function readChat() {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
    store.upsertChats([{ id: PEER, conversationTimestamp: 1_799_990_000, unreadCount: 0 }]);
    return store;
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['the next second, its chat update first', 1_000, true],
    ['the same second, its chat update first', 300, true],
    ['the same second, its record first', 300, false],
  ])('keeps the unread count of a message received in %s', (_label, afterMs, updateFirst) => {
    const store = readChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + afterMs);
    const msg = received('3EB0RECEIVEDAFTER', DELETED_AT_MS + afterMs);
    // Its place in the order is taken on arrival, before the reads that delay its record.
    const order = store.nextMessageOrder();

    if (updateFirst) store.upsertChats([chatUpdate(msg)]);
    store.recordMessage(msg, 'text', order);
    if (!updateFirst) store.upsertChats([chatUpdate(msg)]);

    expect(unreadCount(store)).toBe(1);
  });

  it('applies no update of a message received before the deletion, also once a later message re-creates the chat', () => {
    const store = readChat();
    const early = received('3EB0RECEIVEDBEFORE', DELETED_AT_MS - 200);
    const earlyOrder = store.nextMessageOrder();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);

    // Its chat update and its record land after the deletion, as when a media download delays them.
    store.upsertChats([chatUpdate(early)]);
    expect(store.listChats()).toEqual([]);
    now.mockReturnValue(DELETED_AT_MS + 300);
    store.recordMessage(
      { key: { remoteJid: PEER, fromMe: true, id: '3EB0SENTAFTER' }, messageTimestamp: 1_800_000_000 },
      'text',
    );
    store.recordMessage(early, 'text', earlyOrder);

    expect(unreadCount(store)).toBe(0);
  });

  // An image in the deletion's second: its record waits on the download while newer updates of the chat land.
  function slowImageThen(later: (store: BaileysSessionStore, now: jest.SpyInstance<number, []>) => void) {
    const store = readChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 300);
    const image = received('3EB0SLOWIMAGE', DELETED_AT_MS + 300);
    const imageOrder = store.nextMessageOrder();
    store.upsertChats([chatUpdate(image)]);
    later(store, now);
    store.recordMessage(image, 'image', imageOrder);
    return store;
  }
  const nextMessage = (store: BaileysSessionStore, now: jest.SpyInstance<number, []>): void => {
    now.mockReturnValue(DELETED_AT_MS + 2_000);
    const text = received('3EB0FASTTEXT', DELETED_AT_MS + 2_000);
    const order = store.nextMessageOrder();
    store.upsertChats([chatUpdate(text)]);
    store.recordMessage(text, 'text', order);
  };
  const chatRecord = (store: BaileysSessionStore): Partial<Chat> | undefined =>
    (store as unknown as { chats: Map<string, Partial<Chat>> }).chats.get(PEER);

  it('keeps a read made on the phone before the slow record lands', () => {
    const store = slowImageThen((s, now) => {
      nextMessage(s, now);
      s.upsertChats([{ id: PEER, unreadCount: 0 }]);
    });

    expect(unreadCount(store)).toBe(0);
  });

  it('keeps the chat time of a newer message recorded before the slow one', () => {
    const store = slowImageThen(nextMessage);

    expect(Number(chatRecord(store)?.conversationTimestamp)).toBe(Math.floor((DELETED_AT_MS + 2_000) / 1000));
  });

  it('keeps the unread count of the slow message under an own send that carries none', () => {
    const store = slowImageThen((s, now) => {
      now.mockReturnValue(DELETED_AT_MS + 500);
      const sent: WAMessage = {
        key: { remoteJid: PEER, fromMe: true, id: '3EB0SENTAFTER' },
        messageTimestamp: 1_800_000_000,
        message: { conversation: 'sent' },
      };
      s.recordMessage(sent, 'text');
      s.upsertChats([{ id: PEER, conversationTimestamp: 1_800_000_000, messages: [{ message: sent }] }]);
    });

    expect(unreadCount(store)).toBe(1);
  });

  it('adds no unread count from a message of the conversation the operator deleted again', () => {
    const store = slowImageThen((s, now) => {
      nextMessage(s, now);
      now.mockReturnValue(DELETED_AT_MS + 5_000);
      s.removeChats([PEER]);
      // Written to again through the API: an own send, whose chat update carries no count.
      now.mockReturnValue(DELETED_AT_MS + 7_000);
      const sent: WAMessage = {
        key: { remoteJid: PEER, fromMe: true, id: '3EB0SENTAGAIN' },
        messageTimestamp: 1_800_000_007,
        message: { conversation: 'sent' },
      };
      s.upsertChats([{ id: PEER, conversationTimestamp: 1_800_000_007, messages: [{ message: sent }] }]);
      s.recordMessage(sent, 'text');
    });

    expect(unreadCount(store)).toBe(0);
  });
});

/**
 * Baileys merges the deletions of one buffered window, such as several chats deleted at once on the phone or
 * a catch-up after a reconnect, into one chats.delete event. A message re-creates only its own chat of it.
 */
describe('Baileys chats deleted together by one chats.delete event', () => {
  const SID = 'sess-1';
  const PHONE = '628111@s.whatsapp.net';
  const LID = '484848@lid';
  const OTHER = '628222@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const LATER_MS = DELETED_AT_MS + 10_000;
  const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 30));
  const message = (jid: string, id: string, atMs: number): WAMessage => ({
    key: { remoteJid: jid, fromMe: false, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });

  function deletedTogether(ids: string[], lidStore?: LidMappingStore) {
    const chatState = new FakeChatStateStore();
    const store = new BaileysSessionStore(lidStore, SID, chatState);
    store.upsertChats(ids.map(id => ({ id, conversationTimestamp: 1_799_990_000 })));
    jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats(ids);
    return { store, chatState };
  }

  afterEach(() => jest.restoreAllMocks());

  it('keeps the other chat deleted when a message re-creates one, also after a restart', async () => {
    const { store, chatState } = deletedTogether([PHONE, OTHER]);
    await settle();

    store.recordMessage(message(PHONE, '3EB0REPLY', LATER_MS), 'text');
    // A state update from before the deletion, without a message, does not list the other chat again.
    store.upsertChats([{ id: OTHER, conversationTimestamp: 1_799_990_000 }]);
    await settle();

    expect(store.chatDeletedAt(PHONE)).toBeNull();
    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
    expect(store.chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
    expect(chatState.get(SID, OTHER)?.deletedAt).toBe(DELETED_AT_MS);
    expect(new BaileysSessionStore(undefined, SID, chatState).chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
  });

  // The lid table can list the lid under the phone before the lid itself resolves, so the event names the
  // chat under two state keys whose spellings meet.
  it.each([
    ['the phone first', [PHONE, LID]],
    ['the lid first', [LID, PHONE]],
  ])('re-creates a chat named by both its lid and its phone under both, with %s', async (_label, ids) => {
    const lidStore: LidMappingStore = {
      getCached: () => undefined,
      resolveLid: () => null,
      lidsForPhone: phone => (phone === '628111' ? ['484848'] : []),
      remember: () => Promise.resolve(true),
    };
    const { store, chatState } = deletedTogether(ids, lidStore);
    await settle();
    expect(store.chatDeletedAt(LID)).toBe(DELETED_AT_MS);

    store.recordMessage(message(PHONE, '3EB0REPLY', LATER_MS), 'text');
    await settle();

    expect(store.chatDeletedAt(PHONE)).toBeNull();
    expect(store.chatDeletedAt(LID)).toBeNull();
    expect(chatState.rows.size).toBe(0);
  });

  it.each([
    ['its lid', LID],
    ['its phone', PHONE],
  ])(
    're-creates only the chat whose lid mapping arrived after the event, from a message under %s',
    async (_label, jid) => {
      const { store, chatState } = deletedTogether([LID, PHONE, OTHER]);
      await settle();
      store.addLidMappings([{ lid: LID, pn: PHONE }]);

      store.recordMessage(message(jid, '3EB0REPLY', LATER_MS), 'text');
      store.upsertChats([{ id: OTHER, conversationTimestamp: 1_799_990_000 }]);
      await settle();

      expect(store.chatDeletedAt(LID)).toBeNull();
      expect(store.chatDeletedAt('628111@c.us')).toBeNull();
      expect(store.listChats().map(chat => chat.id)).not.toContain('628222@c.us');
      expect(store.chatDeletedAt(OTHER)).toBe(DELETED_AT_MS);
      expect(chatState.get(SID, OTHER)?.deletedAt).toBe(DELETED_AT_MS);
    },
  );
});

/**
 * A disappearing-messages timer turned off while a chat is marked deleted. Baileys reports the change as a
 * chats.update with ephemeralExpiration null and no conversationTimestamp (Utils/process-message.js: a
 * protocol message is not a real message), and the adapter routes the protocol message itself to
 * processMessageChange, never to recordMessage, so nothing clears the mark first.
 */
describe('Baileys disappearing timer changed around a chat deletion', () => {
  const SID = 'sess-1';
  const PEER = '628111@s.whatsapp.net';
  const DELETED_AT_MS = 1_800_000_000_400;
  const DAY = 86_400;
  const received = (id: string, atMs: number): WAMessage => ({
    key: { remoteJid: PEER, fromMe: false, id },
    messageTimestamp: Math.floor(atMs / 1000),
    message: { conversation: id },
  });
  const chatUpdate = (msg: WAMessage): Partial<Chat> => ({
    id: PEER,
    conversationTimestamp: Number(msg.messageTimestamp),
    unreadCount: 1,
    messages: [{ message: msg }],
  });
  function timedChat() {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
    store.upsertChats([
      {
        id: PEER,
        conversationTimestamp: 1_799_990_000,
        ephemeralExpiration: DAY,
        ephemeralSettingTimestamp: 1_799_000_000,
      },
    ]);
    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
    return store;
  }
  afterEach(() => jest.restoreAllMocks());

  it('a timer turned off while the chat is deleted is not used by the next send', () => {
    const store = timedChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 60_000);
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_800_000_060, ephemeralExpiration: null }]);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
    // The change lists nothing and writes no chat state: the chat stays deleted.
    expect(store.listChats()).toEqual([]);
    expect(store.chatDeletedAt(PEER)).toBe(DELETED_AT_MS);
  });

  it('a timer turned on while the chat is deleted is used by the next send, and the chat stays unlisted', () => {
    const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
    store.upsertChats([{ id: PEER, conversationTimestamp: 1_799_990_000 }]);
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 60_000);
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_800_000_060, ephemeralExpiration: DAY }]);

    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
    expect(store.listChats()).toEqual([]);
  });

  it('a timer turned off while the chat is deleted is not used after a newer message re-creates the chat', () => {
    const store = timedChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 60_000);
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_800_000_060, ephemeralExpiration: null }]);
    now.mockReturnValue(DELETED_AT_MS + 120_000);
    const text = received('3EB0AFTEROFF', DELETED_AT_MS + 120_000);
    const order = store.nextMessageOrder();
    store.upsertChats([chatUpdate(text)]);
    store.recordMessage(text, 'text', order);

    expect(store.listChats().map(c => c.id)).toEqual(['628111@c.us']);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('a timer turned off in a held update applied beneath a newer write is not used by the next send', () => {
    const store = timedChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 300);
    const image = received('3EB0SLOWIMAGE', DELETED_AT_MS + 300);
    const imageOrder = store.nextMessageOrder();
    // The buffered flush merged the EPHEMERAL_SETTING update into the image's chat update (concatChats).
    store.upsertChats([{ ...chatUpdate(image), ephemeralExpiration: null, ephemeralSettingTimestamp: 1_800_000_000 }]);
    now.mockReturnValue(DELETED_AT_MS + 2_000);
    const text = received('3EB0FASTTEXT', DELETED_AT_MS + 2_000);
    const textOrder = store.nextMessageOrder();
    store.upsertChats([chatUpdate(text)]);
    store.recordMessage(text, 'text', textOrder);
    store.recordMessage(image, 'image', imageOrder);

    expect(store.listChats().map(c => c.id)).toEqual(['628111@c.us']);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('control: the same timer-off update on a chat that was never deleted clears the timer', () => {
    const store = timedChat();
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_800_000_060, ephemeralExpiration: null }]);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  // A history record snapshotted while the timer was still on, delivered after it was turned off.
  const staleRecord = (): Partial<Chat> => ({
    id: PEER,
    conversationTimestamp: 1_799_999_950,
    ephemeralExpiration: DAY,
    ephemeralSettingTimestamp: 1_799_000_000,
  });
  function turnedOff() {
    const store = timedChat();
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_799_999_000, ephemeralExpiration: null }]);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
    return store;
  }

  it('a record setting an older timer than the one applied does not bring it back once the chat is deleted', () => {
    const store = turnedOff();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 60_000);
    store.upsertChats([staleRecord()]);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('a record setting an older timer than the one applied does not bring it back on a listed chat', () => {
    const store = turnedOff();
    const record = staleRecord();
    store.upsertChats([record]);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
    expect(store.listChats()[0]).toMatchObject({ timestamp: 1_799_999_950 });
    // The library's payload is left as it came.
    expect(record).toMatchObject({ ephemeralExpiration: DAY, ephemeralSettingTimestamp: 1_799_000_000 });
  });

  it('a record that names no setting time still applies its timer, as nothing tells its age', () => {
    const store = turnedOff();
    store.upsertChats([{ id: PEER, ephemeralExpiration: DAY }]);

    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
  });

  it('a timer change set in the same second as the one applied is taken, as it arrived later', () => {
    const store = timedChat();
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: 1_799_000_000, ephemeralExpiration: null }]);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('an older record under the chat lid is dropped, and a newer one applied, for a lid mapped to its phone', () => {
    const LID = '111111111111111@lid';
    const store = timedChat();
    store.addLidMappings([{ lid: LID, pn: PEER }]);
    store.upsertChats([{ id: LID, ephemeralSettingTimestamp: 1_798_000_000, ephemeralExpiration: null }]);
    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);

    store.upsertChats([{ id: LID, ephemeralSettingTimestamp: 1_799_500_000, ephemeralExpiration: null }]);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
    expect(store.getEphemeralExpiration(LID)).toBeUndefined();
  });

  // A recycled number: the old holder's lid and the new holder's lid both map to the phone.
  describe('two lids the cache maps to one phone', () => {
    const WEEK = 604_800;
    const OLD = '111111111111111@lid';
    const NEW = '222222222222222@lid';
    function recycled() {
      const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
      store.addLidMappings([
        { lid: OLD, pn: PEER },
        { lid: NEW, pn: PEER },
      ]);
      return store;
    }

    it("takes each chat's own timer change, though the other set its timer later", () => {
      const store = recycled();
      store.upsertChats([{ id: OLD, ephemeralExpiration: DAY, ephemeralSettingTimestamp: 1_800_000_100 }]);
      // The new holder's change, made earlier than the other chat's and delivered after it.
      store.upsertChats([{ id: NEW, ephemeralExpiration: WEEK, ephemeralSettingTimestamp: 1_800_000_050 }]);

      expect(store.getEphemeralExpiration(NEW)).toBe(WEEK);
      expect(store.getEphemeralExpiration(OLD)).toBe(DAY);
    });

    it("does not read one holder's timer for the other", () => {
      const store = recycled();
      store.upsertChats([{ id: OLD, ephemeralExpiration: DAY, ephemeralSettingTimestamp: 1_800_000_100 }]);

      expect(store.getEphemeralExpiration(NEW)).toBeUndefined();
    });

    it('gives a send to the phone alone no timer once the phone gains a second lid', () => {
      const store = new BaileysSessionStore(undefined, SID, new FakeChatStateStore());
      store.addLidMappings([{ lid: OLD, pn: PEER }]);
      // While the phone maps to one lid, the old holder's change is cached under the phone too.
      store.upsertChats([{ id: OLD, ephemeralExpiration: DAY, ephemeralSettingTimestamp: 1_800_000_100 }]);
      expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
      store.addLidMappings([{ lid: NEW, pn: PEER }]);
      store.upsertChats([{ id: NEW, ephemeralExpiration: WEEK, ephemeralSettingTimestamp: 1_800_000_500 }]);

      expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
      expect(store.getEphemeralExpiration('628111@c.us')).toBeUndefined();
      expect(store.getEphemeralExpiration(OLD)).toBe(DAY);
      expect(store.getEphemeralExpiration(NEW)).toBe(WEEK);
    });
  });
});
