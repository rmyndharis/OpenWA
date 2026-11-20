import type { Chat } from '@whiskeysockets/baileys';
import { BaileysSessionStore } from './baileys-session-store';

/**
 * What every writer of a chat record's unread count (`u`) and its remembered mark (`mc`, markCovered) leaves it in, from
 * every state a record reaches through the events Baileys raises, driven through the real store. A record that holds a mark
 * set by hand has a negative count; a count that replaces it keeps the mark in `mc`. Nothing here depends on the replay of
 * the session's own mark-read write: it is the table of a store that awaits none, and the note below must leave it as it is.
 */
const PHONE = '628111@s.whatsapp.net';
const LID = '484848@lid';

type Cell = string;
type Record_ = { unreadCount?: number | null; markCovered?: boolean } | undefined;
const recordOf = (store: BaileysSessionStore, id = PHONE): Record_ =>
  (store as unknown as { chats: { get(id: string): Record_ } }).chats.get(id);
const cellOf = (store: BaileysSessionStore, id = PHONE): Cell => {
  const record = recordOf(store, id);
  return record ? `u=${String(record.unreadCount)} mc=${record.markCovered === true ? 'T' : 'F'}` : 'none';
};
const upsert = (store: BaileysSessionStore, update: Partial<Chat>, id = PHONE): void =>
  store.upsertChats([{ id, ...update }]);

/** The states a record reaches through real events. */
const STATES: Record<string, (store: BaileysSessionStore) => void> = {
  none: () => undefined,
  'u=0': store => upsert(store, { unreadCount: 0 }),
  'u=1': store => upsert(store, { unreadCount: 1 }),
  'u=3': store => upsert(store, { unreadCount: 3 }),
  'u=-1': store => upsert(store, { unreadCount: -1 }),
  'u=1 mc=T (mark, then a message)': store => {
    upsert(store, { unreadCount: -1 });
    upsert(store, { unreadCount: 1 });
  },
  'u=2 mc=T (mark, then two messages in one flush)': store => {
    upsert(store, { unreadCount: -1 });
    upsert(store, { unreadCount: 2 });
  },
  'u=1 mc=T (mark, message, message)': store => {
    upsert(store, { unreadCount: -1 });
    upsert(store, { unreadCount: 1 });
    upsert(store, { unreadCount: 1 });
  },
  'no count (a mute only)': store => upsert(store, { muteEndTime: 0 }),
};

/** What can happen to the record next, in the order of the table below. */
const EVENTS: Array<[string, (store: BaileysSessionStore) => void]> = [
  ['message +1', store => upsert(store, { unreadCount: 1 })],
  ['flush of 2', store => upsert(store, { unreadCount: 2 })],
  ['read synced (0)', store => upsert(store, { unreadCount: 0 })],
  ['mark synced (-1)', store => upsert(store, { unreadCount: -1 })],
  ['initial-sync read (null)', store => upsert(store, { unreadCount: null })],
  ['cancelled mark (own undefined)', store => upsert(store, { unreadCount: undefined })],
  ['update without a count (pin)', store => upsert(store, { pinned: 5 })],
  ['clearUnread(false)', store => store.clearUnread(PHONE, false)],
  ['clearUnread(true)', store => store.clearUnread(PHONE, true)],
  ['keepUnread', store => store.keepUnread(PHONE)],
];

/** The cell each event leaves a record in, per starting state. */
const TABLE: Record<string, Cell[]> = {
  none: [
    'u=1 mc=F',
    'u=2 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=undefined mc=F',
    'none',
    'none',
    'none',
  ],
  'u=0': [
    'u=1 mc=F',
    'u=2 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=0 mc=F',
    'u=0 mc=F',
    'u=0 mc=F',
    'u=1 mc=F',
  ],
  'u=1': [
    'u=1 mc=F',
    'u=2 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=1 mc=F',
    'u=0 mc=F',
    'u=1 mc=F',
    'u=1 mc=F',
  ],
  'u=3': [
    'u=1 mc=F',
    'u=2 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=3 mc=F',
    'u=0 mc=F',
    'u=3 mc=F',
    'u=3 mc=F',
  ],
  'u=-1': [
    'u=1 mc=T',
    'u=2 mc=T',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=-1 mc=F',
    'u=-1 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
  ],
  'u=1 mc=T (mark, then a message)': [
    'u=1 mc=T',
    'u=2 mc=T',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=1 mc=T',
    'u=-1 mc=F',
    'u=1 mc=F',
    'u=1 mc=T',
  ],
  'u=2 mc=T (mark, then two messages in one flush)': [
    'u=1 mc=T',
    'u=2 mc=T',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=2 mc=T',
    'u=-1 mc=F',
    'u=2 mc=F',
    'u=2 mc=T',
  ],
  'u=1 mc=T (mark, message, message)': [
    'u=1 mc=T',
    'u=2 mc=T',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=1 mc=T',
    'u=-1 mc=F',
    'u=1 mc=F',
    'u=1 mc=T',
  ],
  'no count (a mute only)': [
    'u=1 mc=F',
    'u=2 mc=F',
    'u=0 mc=F',
    'u=-1 mc=F',
    'u=null mc=F',
    'u=undefined mc=F',
    'u=undefined mc=F',
    'u=undefined mc=F',
    'u=undefined mc=F',
    'u=1 mc=F',
  ],
};

describe('the unread count and mark of one record', () => {
  it('names the events the table lists', () => {
    expect(EVENTS.map(([name]) => name)).toEqual([
      'message +1',
      'flush of 2',
      'read synced (0)',
      'mark synced (-1)',
      'initial-sync read (null)',
      'cancelled mark (own undefined)',
      'update without a count (pin)',
      'clearUnread(false)',
      'clearUnread(true)',
      'keepUnread',
    ]);
    expect(Object.keys(TABLE)).toEqual(Object.keys(STATES));
  });

  describe.each(Object.keys(STATES))('from %s', state => {
    it.each(EVENTS.map(([name], index) => [name, index] as const))('after %s', (_event, index) => {
      const store = new BaileysSessionStore();
      STATES[state](store);
      EVENTS[index][1](store);
      expect(cellOf(store)).toBe(TABLE[state][index]);
    });

    it('is forgotten when the chat is deleted', () => {
      const store = new BaileysSessionStore();
      STATES[state](store);
      store.removeChats([PHONE]);
      expect(cellOf(store)).toBe('none');
    });
  });
});

/**
 * Baileys replays the session's own mark-read write as a chat update with a count of zero. When its event buffer holds the
 * replay, the zero reaches the store after the read has returned, and the session notes that it is due (`expectReadEcho`).
 * That zero must not wipe a count raised after the read reset the counts, which the write's range stops short of. Any
 * other update leaves the table above as it is.
 */
describe('the unread count and mark of one record while the replay of a mark-read write is awaited', () => {
  const awaiting = (state: string): BaileysSessionStore => {
    const store = new BaileysSessionStore();
    STATES[state](store);
    store.expectReadEcho(PHONE);
    return store;
  };

  /** The cell the zero of the replay leaves each state in. */
  const AFTER_THE_REPLAY: Record<string, Cell> = {
    none: 'u=0 mc=F',
    'u=0': 'u=0 mc=F',
    'u=1': 'u=1 mc=F',
    'u=3': 'u=3 mc=F',
    'u=-1': 'u=0 mc=F',
    'u=1 mc=T (mark, then a message)': 'u=1 mc=T',
    'u=2 mc=T (mark, then two messages in one flush)': 'u=2 mc=T',
    'u=1 mc=T (mark, message, message)': 'u=1 mc=T',
    'no count (a mute only)': 'u=0 mc=F',
  };

  describe.each(Object.keys(STATES))('from %s', state => {
    it('keeps a count above zero when the zero arrives, and applies the zero to any other record', () => {
      const store = awaiting(state);
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe(AFTER_THE_REPLAY[state]);
    });

    it('applies a zero that comes after it, as the replay is not awaited twice', () => {
      const store = awaiting(state);
      upsert(store, { unreadCount: 0 });
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe('u=0 mc=F');
    });

    it('takes a count above zero as the replay, applies it as it is, and applies a zero that comes after', () => {
      const store = awaiting(state);
      upsert(store, { unreadCount: 1 });
      expect(cellOf(store)).toBe(TABLE[state][0]);
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe('u=0 mc=F');
    });

    it('is not asked about a write that was never confirmed', () => {
      const store = new BaileysSessionStore();
      STATES[state](store);
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe('u=0 mc=F');
    });
  });

  it.each([
    ['a mark cancelled on the phone', { unreadCount: undefined }, 'u=undefined mc=F'],
    ['a read synced as the first of an initial sync', { unreadCount: null }, 'u=null mc=F'],
    ['a mark set on the phone', { unreadCount: -1 }, 'u=-1 mc=F'],
  ] as Array<[string, Partial<Chat>, Cell]>)('ends the wait with %s, and applies it', (_what, update, cell) => {
    const store = awaiting('u=3');
    upsert(store, update);
    expect(cellOf(store)).toBe(cell);
    upsert(store, { unreadCount: 2 });
    upsert(store, { unreadCount: 0 });
    expect(cellOf(store)).toBe('u=0 mc=F');
  });

  it('keeps waiting through an update that carries no count', () => {
    const store = awaiting('u=3');
    upsert(store, { pinned: 5 });
    upsert(store, { unreadCount: 0 });
    expect(cellOf(store)).toBe('u=3 mc=F');
  });

  it('still applies the other fields of the update that carries the zero', () => {
    const store = awaiting('u=3');
    upsert(store, { unreadCount: 0, pinned: 5, muteEndTime: -1 });
    expect(recordOf(store)).toMatchObject({ unreadCount: 3, pinned: 5, muteEndTime: -1 });
  });

  it('waits for the chat the write was keyed to, and for no other', () => {
    const store = new BaileysSessionStore();
    upsert(store, { unreadCount: 2 });
    store.expectReadEcho('628222@s.whatsapp.net');
    upsert(store, { unreadCount: 0 });
    expect(cellOf(store)).toBe('u=0 mc=F');
  });

  it('is not met by the zero of a twin record of the chat, which is no replay of this write', () => {
    const store = new BaileysSessionStore();
    store.addLidMappings([{ lid: LID, pn: PHONE }]);
    upsert(store, { unreadCount: 2 });
    upsert(store, { unreadCount: 1, conversationTimestamp: 1_700_000_000 }, LID);
    store.expectReadEcho(PHONE);
    upsert(store, { unreadCount: 0 }, LID);
    expect(cellOf(store, LID)).toBe('u=0 mc=F');
    expect(cellOf(store)).toBe('u=2 mc=F');
    upsert(store, { unreadCount: 0 });
    expect(cellOf(store)).toBe('u=2 mc=F');
  });

  // A count synced under the other spelling of a chat that has a record under one only goes to that record, by the
  // same rules as one synced under its own: it names no time and no message, so it is no chat of its own.
  describe('a count synced under the other spelling of the chat', () => {
    const twinStore = (): BaileysSessionStore => {
      const store = new BaileysSessionStore();
      store.addLidMappings([{ lid: LID, pn: PHONE }]);
      return store;
    };

    it('reads the chat', () => {
      const store = twinStore();
      upsert(store, { unreadCount: 3 });
      upsert(store, { unreadCount: 0 }, LID);
      expect([cellOf(store), cellOf(store, LID)]).toEqual(['u=0 mc=F', 'none']);
    });

    it('keeps the mark set by hand that a count replaces', () => {
      const store = twinStore();
      upsert(store, { unreadCount: -1 });
      upsert(store, { unreadCount: 1 }, LID);
      expect([cellOf(store), cellOf(store, LID)]).toEqual(['u=1 mc=T', 'none']);
    });

    it('is taken for the replay of a write keyed to its own spelling', () => {
      const store = twinStore();
      upsert(store, { unreadCount: 2 });
      store.expectReadEcho(LID);
      upsert(store, { unreadCount: 0 }, LID);
      expect([cellOf(store), cellOf(store, LID)]).toEqual(['u=2 mc=F', 'none']);
    });
  });

  it('forgets what it awaits when the socket that held the replay is replaced', () => {
    const store = awaiting('u=3');
    store.dropReadEchoes();
    upsert(store, { unreadCount: 0 });
    expect(cellOf(store)).toBe('u=0 mc=F');
  });

  describe('for as long as Baileys can hold the replay', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      [34_999, 'u=3 mc=F'],
      [35_001, 'u=0 mc=F'],
    ])('after %i ms, a zero leaves the record at %s', (elapsed, cell) => {
      const store = awaiting('u=3');
      jest.advanceTimersByTime(elapsed);
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe(cell);
    });

    it('lets a later write note the chat again', () => {
      const store = awaiting('u=3');
      jest.advanceTimersByTime(40_000);
      store.expectReadEcho(PHONE);
      upsert(store, { unreadCount: 0 });
      expect(cellOf(store)).toBe('u=3 mc=F');
    });
  });
});
