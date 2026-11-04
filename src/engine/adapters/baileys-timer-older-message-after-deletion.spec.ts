import type { Chat, WAMessage } from '@whiskeysockets/baileys';
import { BaileysSessionStore } from './baileys-session-store';
import { mergeTwinStates, type ChatStateStore, type ChatStateValue } from './baileys-chat-state-store.service';

/** In-memory ChatStateStore, synchronous: enough for the deletion mark the session store keeps. */
class MemoryChatStateStore implements ChatStateStore {
  private readonly rows = new Map<string, ChatStateValue>();
  private key(s: string, c: string): string {
    return `${s}|${c}`;
  }
  get(s: string, c: string): ChatStateValue | undefined {
    return this.rows.get(this.key(s, c));
  }
  chatIds(s: string): string[] {
    return [...this.rows.keys()].filter(k => k.startsWith(`${s}|`)).map(k => k.slice(s.length + 1));
  }
  remember(s: string, c: string, patch: Partial<ChatStateValue>): Promise<void> {
    const existing = this.rows.get(this.key(s, c)) ?? { muteEndTime: null, archived: false, pinned: false };
    this.rows.set(this.key(s, c), { ...existing, ...patch });
    return Promise.resolve();
  }
  reload(): Promise<void> {
    return Promise.resolve();
  }
  clearSession(): Promise<void> {
    return Promise.resolve();
  }
  fold(s: string, c: string, twins: string[], patch: Partial<ChatStateValue>): Promise<void> {
    const merged = mergeTwinStates([c, ...twins].flatMap(t => this.get(s, t) ?? []));
    for (const t of twins) this.rows.delete(this.key(s, t));
    return this.remember(s, c, { ...(merged ?? {}), ...patch });
  }
  forget(s: string, chatIds: string[]): Promise<void> {
    for (const c of chatIds) this.rows.delete(this.key(s, c));
    return Promise.resolve();
  }
  refreshSession(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A disappearing-messages timer changed while the chat is deleted, then a message stamped with the old timer
 * (sent before the change, delivered after it: a history record, a redelivery, an offline flush). On a listed
 * chat such a message is skipped because the chat record carries the change's ephemeralSettingTimestamp; the
 * deleted chat has no record, so only the store's own copy of that time can tell the message is older.
 */
describe('Baileys disappearing timer kept against an older message once the chat is deleted', () => {
  const SID = 'sess-1';
  const PEER = '628111@s.whatsapp.net';
  const DAY = 86_400;
  const WEEK = 604_800;
  const DELETED_AT_MS = 1_800_000_000_400;
  const CHANGED_AT = 1_800_000_060;

  const stamped = (id: string, seconds: number, remoteJid = PEER): WAMessage => ({
    key: { remoteJid, fromMe: false, id },
    messageTimestamp: seconds,
    message: { extendedTextMessage: { text: id, contextInfo: { expiration: DAY } } },
  });

  function timedChat(): BaileysSessionStore {
    const store = new BaileysSessionStore(undefined, SID, new MemoryChatStateStore());
    const record: Partial<Chat> = {
      id: PEER,
      conversationTimestamp: 1_799_990_000,
      ephemeralExpiration: DAY,
      ephemeralSettingTimestamp: 1_799_000_000,
    };
    store.upsertChats([record]);
    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
    return store;
  }

  function deletedThenChanged(expiration: number | null): BaileysSessionStore {
    const store = timedChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 60_000);
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: CHANGED_AT, ephemeralExpiration: expiration }]);
    expect(store.getEphemeralExpiration(PEER)).toBe(expiration ?? undefined);
    return store;
  }

  afterEach(() => jest.restoreAllMocks());

  it('control: on a listed chat, an older message stamped with the old timer does not bring it back', () => {
    const store = timedChat();
    store.upsertChats([{ id: PEER, ephemeralSettingTimestamp: CHANGED_AT, ephemeralExpiration: null }]);
    store.recordMessage(stamped('3EB0OLDHISTORY', 1_799_999_990), 'text', 0);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('a history message from before the deletion does not bring back a timer turned off while deleted', () => {
    const store = deletedThenChanged(null);
    store.recordMessage(stamped('3EB0OLDHISTORY', 1_799_999_990), 'text', 0);

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('a message sent between the deletion and the change, delivered after the change, does not bring it back', () => {
    const store = deletedThenChanged(null);
    store.recordMessage(stamped('3EB0LATEREDELIVERY', CHANGED_AT - 30), 'text', store.nextMessageOrder());

    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('a timer changed while the chat is deleted is kept against an older message stamped with the old one', () => {
    const store = deletedThenChanged(WEEK);
    store.recordMessage(stamped('3EB0LATEREDELIVERY', CHANGED_AT - 30), 'text', store.nextMessageOrder());

    expect(store.getEphemeralExpiration(PEER)).toBe(WEEK);
  });

  it('a message sent after the change made while the chat is deleted still teaches its timer', () => {
    const store = deletedThenChanged(null);
    store.recordMessage(stamped('3EB0AFTERCHANGE', CHANGED_AT + 30), 'text', store.nextMessageOrder());

    expect(store.getEphemeralExpiration(PEER)).toBe(DAY);
  });

  it('a timer turned off in a held update stays off when the held image itself carries the old timer', () => {
    const store = timedChat();
    const now = jest.spyOn(Date, 'now').mockReturnValue(DELETED_AT_MS);
    store.removeChats([PEER]);
    now.mockReturnValue(DELETED_AT_MS + 300);
    // An image sent while the timer was still on: WhatsApp stamps the chat's timer on it.
    const image: WAMessage = {
      key: { remoteJid: PEER, fromMe: false, id: '3EB0SLOWIMAGE' },
      messageTimestamp: Math.floor((DELETED_AT_MS + 300) / 1000),
      message: { imageMessage: { caption: 'photo', contextInfo: { expiration: DAY } } },
    };
    const imageOrder = store.nextMessageOrder();
    // The buffered flush merged the EPHEMERAL_SETTING update into the image's chat update.
    store.upsertChats([
      {
        id: PEER,
        conversationTimestamp: Number(image.messageTimestamp),
        unreadCount: 1,
        messages: [{ message: image }],
        ephemeralExpiration: null,
        ephemeralSettingTimestamp: 1_800_000_000,
      },
    ]);
    now.mockReturnValue(DELETED_AT_MS + 2_000);
    const text: WAMessage = {
      key: { remoteJid: PEER, fromMe: false, id: '3EB0FASTTEXT' },
      messageTimestamp: Math.floor((DELETED_AT_MS + 2_000) / 1000),
      message: { conversation: 'text' },
    };
    const textOrder = store.nextMessageOrder();
    store.upsertChats([
      { id: PEER, conversationTimestamp: Number(text.messageTimestamp), unreadCount: 1, messages: [{ message: text }] },
    ]);
    store.recordMessage(text, 'text', textOrder);
    store.recordMessage(image, 'image', imageOrder);

    expect(store.listChats().map(c => c.id)).toEqual(['628111@c.us']);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it("teaches one holder of a phone shared by two lids its timer from a message newer than the phone's change", () => {
    const NEW = '222222222222222@lid';
    const store = new BaileysSessionStore(undefined, SID, new MemoryChatStateStore());
    store.addLidMappings([
      { lid: '111111111111111@lid', pn: PEER },
      { lid: NEW, pn: PEER },
    ]);
    store.upsertChats([{ id: PEER, ephemeralExpiration: WEEK, ephemeralSettingTimestamp: CHANGED_AT }]);
    store.recordMessage(stamped('3EB0NEWHOLDER', CHANGED_AT + 30, NEW), 'text', store.nextMessageOrder());

    expect(store.getEphemeralExpiration(NEW)).toBe(DAY);
  });
});
