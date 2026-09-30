import { BaileysSessionStore } from './baileys-session-store';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import {
  mergeTwinStates,
  type ChatStateField,
  type ChatStateStore,
  type ChatStateValue,
} from './baileys-chat-state-store.service';
import { userPart } from '../identity/wa-id';

/** In-memory ChatStateStore for tests: remember() applies synchronously so a following read sees it. */
class FakeChatStateStore implements ChatStateStore {
  readonly rows = new Map<string, ChatStateValue>();
  private clock = 1_000_000;
  private key(s: string, c: string): string {
    return `${s}\u0000${c}`;
  }
  get(s: string, c: string): ChatStateValue | undefined {
    return this.rows.get(this.key(s, c));
  }
  chatIds(s: string): string[] {
    return [...this.rows.keys()].filter(k => k.startsWith(`${s}\u0000`)).map(k => k.slice(s.length + 1));
  }
  remember(s: string, c: string, patch: Partial<ChatStateValue>, create = true): Promise<void> {
    // Same bookkeeping as the real store: a new row observes only what the patch carries, and a patch
    // that may not create one writes nothing when it only restates defaults.
    const defaults: Partial<ChatStateValue> = { muteEndTime: null, archived: false, pinned: false };
    const restates = (Object.keys(patch) as ChatStateField[]).every(f => patch[f] === defaults[f]);
    if (!create && restates && !this.rows.has(this.key(s, c))) return Promise.resolve();
    const existing = this.rows.get(this.key(s, c)) ?? {
      muteEndTime: null,
      archived: false,
      pinned: false,
      observed: [],
    };
    const observed = existing.observed && [
      ...new Set([...existing.observed, ...(Object.keys(patch) as ChatStateField[])]),
    ];
    this.rows.set(this.key(s, c), { ...existing, ...patch, observed, updatedAt: ++this.clock });
    return Promise.resolve();
  }
  reload(): Promise<void> {
    return Promise.resolve();
  }
  clearSession(): Promise<void> {
    return Promise.resolve();
  }
  /** Same contract as the real store: the rows merged field by field are the base, the twin rows go. */
  fold(s: string, c: string, twins: string[], patch: Partial<ChatStateValue>, create = true): Promise<void> {
    const found = twins.filter(t => this.rows.has(this.key(s, t)));
    if (!found.length) return this.remember(s, c, patch, create);
    const merged = mergeTwinStates([c, ...found].flatMap(t => this.get(s, t) ?? []));
    const fields: ChatStateField[] = ['muteEndTime', 'archived', 'pinned'];
    const base = merged
      ? Object.fromEntries(fields.filter(f => !merged.observed || merged.observed.includes(f)).map(f => [f, merged[f]]))
      : {};
    for (const t of found) this.rows.delete(this.key(s, t));
    return this.remember(s, c, { ...base, ...patch });
  }
  forget(s: string, chatIds: string[]): Promise<void> {
    for (const c of chatIds) this.rows.delete(this.key(s, c));
    return Promise.resolve();
  }
  refreshSession(): Promise<void> {
    return Promise.resolve();
  }
}

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

  it('does not let a later history-sync row wipe a saved name with undefined', () => {
    // Baileys history contacts always include `name: displayName || name || username || undefined`.
    // Spreading that onto an address-book upsert that already had a name used to clear it.
    store.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice', notify: 'Al' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', name: undefined, notify: 'Al' }]);
    expect(store.findContact('628111@s.whatsapp.net')).toMatchObject({ name: 'Alice', pushName: 'Al' });
  });

  it('prefers the named twin when one person occupies both a lid and a phone entry', () => {
    // History sync and app state can key the same person twice. Only one entry carries the saved
    // name, and answering with the other reported a saved contact as unknown.
    store.upsertContacts([{ id: '111@lid', notify: 'Al' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', lid: '111@lid', name: 'Alice' }]);

    expect(store.findContact('111@lid')).toMatchObject({ name: 'Alice', isMyContact: true });
    expect(store.findContact('628111@c.us')).toMatchObject({ name: 'Alice', isMyContact: true });
  });

  it('answers a lid lookup with the phone number when both twins carry a saved name', () => {
    // The preference above is keyed on `name` alone, so when BOTH entries are named the queried
    // dialect wins. For a lid query that is the lid-keyed entry, whose `number` is empty unless it
    // is derived from the resolved id: a saved contact answered with no phone number at all.
    store.upsertContacts([{ id: '111@lid', name: 'Alice' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', lid: '111@lid', name: 'Alice' }]);

    expect(store.findContact('111@lid')).toMatchObject({ id: '628111@c.us', name: 'Alice', number: '628111' });
  });

  it('lists a person once when both of their entries carry a saved name', () => {
    // Both project to the same neutral id once the lid resolves, so listing both puts two rows
    // sharing one id into GET /contacts.
    store.upsertContacts([{ id: '111@lid', name: 'Alice' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', lid: '111@lid', name: 'Alice' }]);

    expect(store.listContacts()).toEqual([
      expect.objectContaining({ id: '628111@c.us', name: 'Alice', number: '628111' }),
    ]);
  });

  it('answers for a saved lid-only contact whose lid has no mapping', () => {
    // Projecting a contact resolves its lid through the store's OWN contacts map, and a read there
    // moves the entry to the most-recent end. Listing over the live map therefore handed this entry
    // back forever. A regression HANGS this file rather than failing it: the loop is synchronous, so
    // no test timeout can interrupt it. A stuck run on this spec means the snapshot went away.
    store.upsertContacts([{ id: '111@lid', name: 'Alice' }]);

    expect(store.listContacts()).toEqual([
      expect.objectContaining({ id: '111@lid', name: 'Alice', number: '', isMyContact: true }),
    ]);
  });

  it('folds two twins by content, not by which one was touched last', () => {
    // The store is LRU-ordered, so iteration order tracks traffic: an inbound message touches the
    // lid twin on every message. Letting order decide meant the list answered with whichever twin
    // had been quiet, dropping a pushname the other had just learned and flipping back later.
    store.upsertContacts([{ id: '111@lid', name: 'Alice', notify: 'Ali', imgUrl: 'http://p/a.jpg' }]);
    store.upsertContacts([{ id: '628111@s.whatsapp.net', lid: '111@lid', name: 'Alice' }]);

    const first = store.listContacts();
    expect(first).toEqual([
      {
        id: '628111@c.us',
        name: 'Alice',
        pushName: 'Ali', // filled from the lid twin, which is the only side that has one
        number: '628111', // and the number from the phone twin, which is the only side with that
        isMyContact: true,
        isBlocked: false,
        profilePicUrl: 'http://p/a.jpg',
      },
    ]);

    // Touch the lid twin the way an inbound message does, moving it to the recent end, and read again.
    expect(store.findContact('111@lid')).toBeTruthy();
    expect(store.listContacts()).toEqual(first);
  });

  it('accepts a contact keyed only by lid (id omitted) and finds it by phone', () => {
    store.upsertContacts([{ lid: '111@lid', phoneNumber: '628111@s.whatsapp.net', name: 'Ada' }]);
    expect(store.findContact('111@lid')?.name).toBe('Ada');
    expect(store.findContact('628111@c.us')?.name).toBe('Ada');
    expect(store.listContacts()[0]).toMatchObject({ id: '628111@c.us', name: 'Ada', number: '628111' });
  });

  it('drops groups/newsletters/status from the contact map (they are not address-book entries)', () => {
    store.upsertContacts([
      { id: '120363-9@g.us', name: 'Team' },
      { id: '123@newsletter', name: 'Channel' },
      { id: 'status@broadcast' },
      { id: '628111@s.whatsapp.net', name: 'Alice' },
    ]);
    expect(store.listContacts()).toHaveLength(1);
    expect(store.findContact('120363-9@g.us')).toBeNull();
    expect(store.findContact('628111@c.us')?.name).toBe('Alice');
  });

  it('does not promote a chat partner into the address book', () => {
    store.upsertChats([
      { id: '628111@s.whatsapp.net', name: 'Alice' },
      { id: '120363-9@g.us', name: 'Team' },
    ]);
    expect(store.findContact('628111@c.us')).toBeNull();
    expect(store.listContacts()).toHaveLength(0);
    expect(store.listChats()).toHaveLength(2);
  });

  /**
   * Baileys documents `name` as the one YOU saved and `notify` as the pushname the contact set
   * themselves, so a contact carrying only `notify` is not in the addressbook. Reporting true for
   * everyone told an automation that every chat partner was a saved contact.
   */
  it('reports isMyContact from the saved name, not for every contact seen', () => {
    store.upsertContacts([
      { id: '628111@s.whatsapp.net', name: 'Alice', notify: 'Al' },
      { id: '628222@s.whatsapp.net', notify: 'Bob' },
    ]);
    expect(store.findContact('628111@s.whatsapp.net')?.isMyContact).toBe(true);
    expect(store.findContact('628222@s.whatsapp.net')?.isMyContact).toBe(false);
    // The pushname still surfaces either way; it is the addressbook claim that changed.
    expect(store.findContact('628222@s.whatsapp.net')?.pushName).toBe('Bob');
    expect(store.listContacts()).toEqual([expect.objectContaining({ id: '628111@c.us', name: 'Alice' })]);
  });

  describe('archived, pinned and muted state', () => {
    // A fresh store per call: upsertChats MERGES, so reusing one store lets an absent-field case
    // re-read a value a prior call set, and the default-to-false path would never run.
    const chatFor = (over: Record<string, unknown>) => {
      const s = new BaileysSessionStore();
      s.upsertChats([{ id: '628111@s.whatsapp.net', name: 'Alice', ...over }]);
      return s.listChats()[0];
    };

    it('maps archived, pinned and muted each from its own field', () => {
      // No Baileys case asserted archived: true before, so `archived: c.archived ?? false` could be
      // a constant false and stay green. Mixed values pin each flag to its own source.
      expect(chatFor({ archived: true, pinned: 0, muteEndTime: 0 })).toMatchObject({
        archived: true,
        pinned: false,
        muted: false,
      });
      expect(chatFor({ archived: false, pinned: 2, muteEndTime: 0 })).toMatchObject({
        archived: false,
        pinned: true,
        muted: false,
      });
    });

    it('reads a pin as a flag, though Baileys reports it as an order', () => {
      // proto.IConversation.pinned is a NUMBER — its position among pinned chats, not a boolean.
      expect(chatFor({ pinned: 2 }).pinned).toBe(true);
      expect(chatFor({ pinned: 0 }).pinned).toBe(false);
      expect(chatFor({}).pinned).toBe(false);
    });

    it('treats a mute as active only while its end time is still ahead', () => {
      const inAnHourMs = Date.now() + 60 * 60 * 1000;
      const anHourAgoMs = Date.now() - 60 * 60 * 1000;
      expect(chatFor({ muteEndTime: inAnHourMs }).muted).toBe(true);
      expect(chatFor({ muteEndTime: anHourAgoMs }).muted).toBe(false);
      expect(chatFor({ muteEndTime: 0 }).muted).toBe(false);
      expect(chatFor({}).muted).toBe(false);
    });

    it('reads both units: epoch ms from an app-state write and epoch seconds from history sync', () => {
      // A chatModify({ mute }) write echoes back the epoch-MS value the gateway passed; a history-sync
      // Conversation.muteEndTime is epoch SECONDS (like conversationTimestamp on the same record). Both
      // must read as muted while ahead, else a synced mute reads unmuted.
      const nowS = Math.floor(Date.now() / 1000);
      expect(chatFor({ muteEndTime: (nowS + 3600) * 1000 }).muted).toBe(true); // ms, still ahead
      expect(chatFor({ muteEndTime: nowS + 3600 }).muted).toBe(true); // seconds, still ahead
      expect(chatFor({ muteEndTime: nowS - 3600 }).muted).toBe(false); // seconds, already past
    });

    it('accepts a Long, which is what the proto actually hands over', () => {
      const asLong = { toNumber: () => Date.now() + 60 * 60 * 1000 };
      expect(chatFor({ muteEndTime: asLong }).muted).toBe(true);
    });

    it('reads a mute set to Always (WhatsApp sends muteEndTime -1) as muted indefinitely', () => {
      expect(chatFor({ muteEndTime: -1 })).toMatchObject({ muted: true, muteExpiration: 0 });
    });
  });

  describe('chat-state persistence (survives a reconnect Baileys cannot resync)', () => {
    const SID = 'sess-1';
    const CHAT = '628111@s.whatsapp.net';
    let fake: FakeChatStateStore;
    beforeEach(() => {
      fake = new FakeChatStateStore();
    });
    // A fresh store sharing the SAME fake models a process restart: this.chats is empty and rebuilds
    // from history sync, but the persisted state is retained.
    const newStore = () => new BaileysSessionStore(undefined, SID, fake);
    const chatOn = (s: BaileysSessionStore, over: Record<string, unknown>) => {
      s.upsertChats([{ id: CHAT, name: 'Alice', ...over }]);
      return s.listChats()[0];
    };

    it('persists a mute and reads it back as muted', () => {
      expect(chatOn(newStore(), { muteEndTime: Date.now() + 60 * 60 * 1000 }).muted).toBe(true);
      expect(fake.rows.size).toBe(1);
    });

    it('a fresh process reads a mute set before the restart, though history sync omits muteEndTime', () => {
      chatOn(newStore(), { muteEndTime: Date.now() + 60 * 60 * 1000 });
      // Restart: this.chats is rebuilt from a history-sync record with NO muteEndTime key.
      expect(chatOn(newStore(), { name: 'Alice' }).muted).toBe(true);
    });

    it('a live unmute (muteEndTime: null) persists and reads unmuted, across a restart', () => {
      const s = newStore();
      chatOn(s, { muteEndTime: Date.now() + 3_600_000 });
      expect(chatOn(s, { muteEndTime: null }).muted).toBe(false);
      expect(chatOn(newStore(), { name: 'Alice' }).muted).toBe(false);
    });

    it('archived and pinned persist and survive a restart', () => {
      chatOn(newStore(), { archived: true, pinned: 2 });
      expect(chatOn(newStore(), { name: 'Alice' })).toMatchObject({ archived: true, pinned: true });
    });

    it('a partial update lacking the keys does not clobber persisted state', () => {
      const s = newStore();
      chatOn(s, { muteEndTime: Date.now() + 3_600_000, archived: true });
      expect(chatOn(s, { name: 'Renamed' })).toMatchObject({ muted: true, archived: true });
    });

    // A decoded proto.Conversation (what history sync hands over) carries archived, pinned and
    // muteEndTime as null defaults on its PROTOTYPE, and sets an own property only for a field that
    // was on the wire. Modelled here without importing the ESM-only WAProto.
    const historyChat = (own: Record<string, unknown>) =>
      Object.assign(Object.create({ archived: null, pinned: null, muteEndTime: null }) as object, {
        id: CHAT,
        name: 'Alice',
        ...own,
      }) as Record<string, unknown>;

    it('a history chat that omits the fields does not reset persisted pin, archive and mute', () => {
      chatOn(newStore(), { muteEndTime: -1, archived: true, pinned: 2 });
      for (const s of [newStore(), newStore()]) {
        s.upsertChats([historyChat({})]);
        expect(s.listChats()[0]).toMatchObject({ muted: true, archived: true, pinned: true });
      }
      expect(fake.get(SID, CHAT)).toMatchObject({ muteEndTime: -1, archived: true, pinned: true });
    });

    it('a history chat that omits the fields writes no row for a chat never seen', () => {
      newStore().upsertChats([historyChat({})]);
      expect(fake.rows.size).toBe(0);
    });

    it('a history chat that carries a field on the wire still persists it', () => {
      newStore().upsertChats([historyChat({ pinned: 5 })]);
      expect(fake.get(SID, CHAT)).toMatchObject({ muteEndTime: null, archived: false, pinned: true });
    });

    it('normalizes a seconds-scale muteEndTime to ms on persist', () => {
      const nowS = Math.floor(Date.now() / 1000);
      chatOn(newStore(), { muteEndTime: nowS + 3600 });
      expect(fake.get(SID, CHAT)?.muteEndTime).toBe((nowS + 3600) * 1000);
      expect(chatOn(newStore(), { name: 'Alice' }).muted).toBe(true);
    });

    it('reports muteExpiration in ms when muted, absent when not, and survives a restart', () => {
      const endMs = Date.now() + 90 * 60 * 1000;
      expect(chatOn(newStore(), { muteEndTime: endMs })).toMatchObject({ muted: true, muteExpiration: endMs });
      // Restart: the fresh store's this.chats has no muteEndTime, but the persisted expiry is read back.
      expect(chatOn(newStore(), { name: 'Alice' })).toMatchObject({ muted: true, muteExpiration: endMs });
      // An unmuted chat carries no expiry (undefined, so omitted from the JSON payload).
      expect(chatOn(newStore(), { muteEndTime: null }).muteExpiration).toBeUndefined();
    });

    it('persists a mute set to Always as -1 and reads it back as muted indefinitely', () => {
      expect(chatOn(newStore(), { muteEndTime: -1 })).toMatchObject({ muted: true, muteExpiration: 0 });
      expect(fake.get(SID, CHAT)?.muteEndTime).toBe(-1);
      expect(chatOn(newStore(), { name: 'Alice' })).toMatchObject({ muted: true, muteExpiration: 0 });
    });

    it('reads a mute Always persisted as -1000 by an earlier version as muted indefinitely', async () => {
      await fake.remember(SID, CHAT, { muteEndTime: -1000 });
      expect(chatOn(newStore(), { name: 'Alice' })).toMatchObject({ muted: true, muteExpiration: 0 });
    });

    it('normalizes a seconds-scale expiry to ms for muteExpiration', () => {
      const nowS = Math.floor(Date.now() / 1000);
      expect(chatOn(newStore(), { muteEndTime: nowS + 3600 }).muteExpiration).toBe((nowS + 3600) * 1000);
    });
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
        kind: 'individual',
        unreadCount: 2,
        timestamp: 200,
        lastMessage: 'newest',
        archived: false,
        pinned: false,
        muted: false,
      },
    ]);
    expect(store.lastMessage('628111@s.whatsapp.net')).toEqual({
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'NEW' },
      timestamp: 200,
      jid: '628111@s.whatsapp.net',
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

  it('updates the chat preview only when the edited message is the current last message', () => {
    store.upsertChats([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
    store.recordMessage({
      key: { remoteJid: '628111@s.whatsapp.net', id: 'LATEST' },
      message: { conversation: 'before edit' },
      messageTimestamp: 200,
    });

    store.recordMessageEdit('628111@c.us', 'OLDER', 'must not replace preview');
    expect(store.listChats()[0]).toEqual(expect.objectContaining({ lastMessage: 'before edit', timestamp: 200 }));

    store.recordMessageEdit('628111@c.us', 'LATEST', 'after edit');
    expect(store.listChats()[0]).toEqual(expect.objectContaining({ lastMessage: 'after edit', timestamp: 200 }));
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
    it('learns a lid->pn mapping from an inbound message key (remoteJid/remoteJidAlt)', () => {
      store.recordKeyLidMappings({ remoteJid: '111@lid', remoteJidAlt: '628999@s.whatsapp.net' });
      expect(store.resolvePhone('111@lid')).toBe('628999');
    });

    it('learns a group participant lid->pn mapping (participant/participantAlt)', () => {
      store.recordKeyLidMappings({ participant: '222@lid', participantAlt: '628222@s.whatsapp.net' });
      expect(store.resolvePhone('222@lid')).toBe('628222');
    });

    it('canonicalizes a @lid to <phone>@c.us once the key mapping is learned', () => {
      expect(store.toNeutralJid('111@lid')).toBe('111@lid'); // unknown yet
      store.recordKeyLidMappings({ remoteJid: '111@lid', remoteJidAlt: '628111@s.whatsapp.net' });
      expect(store.toNeutralJid('111@lid')).toBe('628111@c.us');
    });

    it('pairs the sender of a broadcast-list or status message with its alt, never the list id', () => {
      store.recordKeyLidMappings({
        remoteJid: '1700000000@broadcast',
        remoteJidAlt: '111@lid',
        participant: '628222@s.whatsapp.net',
      });
      store.recordKeyLidMappings({
        remoteJid: 'status@broadcast',
        remoteJidAlt: '333@lid',
        participant: '628444@s.whatsapp.net',
      });
      expect(store.resolvePhone('111@lid')).toBe('628222');
      expect(store.resolvePhone('333@lid')).toBe('628444');
    });

    it('ignores a pair whose phone side is not a user id', () => {
      store.recordKeyLidMappings({ remoteJid: '120363@g.us', remoteJidAlt: '555@lid' });
      expect(store.resolvePhone('555@lid')).toBeNull();
    });

    it("files a received list message's preview under the sender's chat", () => {
      store.upsertChats([{ id: '628222@s.whatsapp.net' }]);
      store.recordMessage({
        key: { remoteJid: '1700000000@broadcast', participant: '628222@s.whatsapp.net', fromMe: false, id: 'L1' },
        message: { conversation: 'offer' },
        messageTimestamp: 100,
      });
      expect(store.listChats()).toEqual([
        expect.objectContaining({ id: '628222@c.us', lastMessage: 'offer', timestamp: 100 }),
      ]);
      expect(store.lastInboundMessage('628222@c.us')?.key.id).toBe('L1');
    });

    it('ignores a key with no lid/pn pair', () => {
      store.recordKeyLidMappings({});
      store.recordKeyLidMappings({ remoteJid: '333@lid' }); // lid without an Alt counterpart
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

  describe('one preview per chat across id dialects', () => {
    const PHONE = '628111@s.whatsapp.net';
    const LID = '484848@lid';
    const msg = (remoteJid: string, id: string, ts: number, fromMe = false) => ({
      key: { remoteJid, fromMe, id },
      message: { conversation: id },
      messageTimestamp: ts,
    });

    it('files an own send addressed as @c.us under the chat Baileys keyed by phone', () => {
      store.upsertChats([{ id: PHONE, conversationTimestamp: 5 }]);
      store.recordMessage(msg('628111@c.us', 'OUT', 100, true));
      expect(store.listChats()).toEqual([
        expect.objectContaining({ id: '628111@c.us', timestamp: 100, lastMessage: 'OUT' }),
      ]);
      expect(store.lastMessage('628111@c.us')).toEqual(expect.objectContaining({ jid: PHONE }));
    });

    it('files a lid-addressed send under the phone-keyed chat once the mapping is known', () => {
      store.upsertChats([{ id: PHONE }]);
      store.addLidMappings([{ lid: LID, pn: PHONE }]);
      store.recordMessage(msg(LID, 'OUT', 100, true));
      expect(store.listChats()).toEqual([expect.objectContaining({ timestamp: 100, lastMessage: 'OUT' })]);
    });

    it('finds a lid-keyed chat from the @c.us id the listing publishes', () => {
      store.upsertChats([{ id: LID }]);
      store.recordKeyLidMappings({ remoteJid: LID, remoteJidAlt: PHONE });
      store.recordMessage(msg(LID, 'IN', 100));
      expect(store.listChats()[0].id).toBe('628111@c.us');
      expect(store.lastMessage('628111@c.us')).toEqual({
        key: { remoteJid: LID, fromMe: false, id: 'IN' },
        timestamp: 100,
        jid: LID,
      });
      store.recordMessageEdit('628111@c.us', 'IN', 'edited');
      expect(store.listChats()[0].lastMessage).toBe('edited');
    });

    it('removes a deleted chat, its preview and its chat state under every spelling', () => {
      const fake = new FakeChatStateStore();
      const s = new BaileysSessionStore(undefined, 'sess-1', fake);
      s.upsertChats([{ id: LID, name: 'Alice', pinned: 7 }]);
      s.recordKeyLidMappings({ remoteJid: LID, remoteJidAlt: PHONE });
      s.recordMessage(msg(LID, 'IN', 100));
      s.upsertChats([{ id: '120363@g.us', name: 'Team' }]);
      // Baileys names the deleted chat by the id its app-state index carries, here the phone twin.
      s.removeChats([PHONE]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '120363@g.us' })]);
      expect(s.lastMessage('628111@c.us')).toBeNull();
      expect(s.lastInboundMessage('628111@c.us')).toBeNull();
      expect(fake.rows.size).toBe(0);
      // A later message re-creates the chat without the pin the deleted one carried.
      s.upsertChats([{ id: LID }]);
      expect(s.listChats().find(c => c.id === '628111@c.us')).toEqual(expect.objectContaining({ pinned: false }));
    });

    it('finds the lid twin through the persisted table as well', () => {
      const lidStore = {
        getCached: jest.fn(() => undefined),
        resolveLid: jest.fn(() => null),
        lidsForPhone: jest.fn((phone: string) => (phone === '628111' ? ['484848'] : [])),
        remember: jest.fn(() => Promise.resolve()),
      };
      const s = new BaileysSessionStore(lidStore, 'sess-1');
      s.upsertChats([{ id: LID }]);
      s.recordMessage(msg(LID, 'IN', 100));
      expect(s.lastMessage('628111@c.us')?.jid).toBe(LID);
    });

    it('tracks the newest received message apart from the preview, for a read receipt', () => {
      store.upsertChats([{ id: PHONE }]);
      expect(store.lastInboundMessage('628111@c.us')).toBeNull();
      store.recordMessage(msg(PHONE, 'IN', 100));
      store.recordMessage(msg('628111@c.us', 'OUT', 200, true));
      expect(store.lastMessage('628111@c.us')?.key.id).toBe('OUT');
      expect(store.lastInboundMessage('628111@c.us')).toEqual({
        key: { remoteJid: PHONE, fromMe: false, id: 'IN' },
        timestamp: 100,
      });
      store.recordMessage(msg(PHONE, 'IN_OLDER', 50));
      expect(store.lastInboundMessage(PHONE)?.key.id).toBe('IN');
    });

    it('keeps one entry when a chat with no record yet is addressed in both dialects', () => {
      store.recordMessage(msg('628111@c.us', 'OUT', 100, true));
      store.recordKeyLidMappings({ remoteJid: LID, remoteJidAlt: PHONE });
      store.recordMessage(msg(LID, 'IN', 200));
      expect(store.lastMessage('628111@c.us')?.key.id).toBe('IN');
      expect(store.lastMessage(LID)?.key.id).toBe('IN');
    });

    it('still finds a message filed under the lid before the mapping to the phone chat was learned', () => {
      store.upsertChats([{ id: PHONE }]);
      store.recordMessage(msg(LID, 'IN', 100));
      store.addLidMappings([{ lid: LID, pn: PHONE }]);
      for (const id of [LID, '628111@c.us']) {
        expect(store.lastMessage(id)).toEqual({
          key: { remoteJid: LID, fromMe: false, id: 'IN' },
          timestamp: 100,
          jid: PHONE,
        });
        expect(store.lastInboundMessage(id)?.key.id).toBe('IN');
      }
    });

    it('prefers the newest message across twins over an older one under the chat key', () => {
      store.upsertChats([{ id: PHONE }]);
      store.recordMessage(msg(PHONE, 'OUT', 100, true));
      store.recordMessage(msg(LID, 'IN', 200));
      store.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(store.lastMessage('628111@c.us')).toEqual(expect.objectContaining({ timestamp: 200, jid: PHONE }));
    });
  });

  describe('one chat known under both its phone number and its lid', () => {
    const SID = 'sess-1';
    const PHONE = '628111@s.whatsapp.net';
    const LID = '484848@lid';
    const K = (c: string) => `${SID}\u0000${c}`;
    let fake: FakeChatStateStore;
    beforeEach(() => {
      fake = new FakeChatStateStore();
    });
    const newStore = () => new BaileysSessionStore(undefined, SID, fake);
    const flush = () => new Promise(resolve => setImmediate(resolve));
    // A decoded proto.Conversation: the fields default to null on the prototype.
    const historyChat = (id: string) =>
      Object.assign(Object.create({ archived: null, pinned: null, muteEndTime: null }) as object, {
        id,
        name: 'Alice',
      }) as Record<string, unknown>;

    it('lists one row and keeps a state WhatsApp syncs under the lid, across a restart', () => {
      const s = newStore();
      s.upsertChats([historyChat(PHONE)]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      s.upsertChats([
        { id: LID, pinned: 1700000000 },
        { id: LID, archived: true },
        { id: LID, muteEndTime: -1 },
      ]);
      const expected = { id: '628111@c.us', name: 'Alice', pinned: true, archived: true, muted: true };
      expect(s.listChats()).toEqual([expect.objectContaining(expected)]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);

      const restarted = newStore();
      restarted.addLidMappings([{ lid: LID, pn: PHONE }]);
      restarted.upsertChats([historyChat(PHONE)]);
      expect(restarted.listChats()).toEqual([expect.objectContaining(expected)]);
    });

    it('reads a state filed under the lid before the mapping was known, and folds it on the next change', async () => {
      const s = newStore();
      s.upsertChats([{ id: LID, pinned: 3 }]);
      expect([...fake.rows.keys()]).toEqual([K(LID)]);
      s.upsertChats([{ id: PHONE, name: 'Alice' }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', name: 'Alice', pinned: true })]);
      await flush();
      expect([...fake.rows.keys()]).toEqual([K(LID)]); // a listing writes nothing
      // A later mute through either spelling folds the lid row onto the phone row.
      s.upsertChats([{ id: LID, muteEndTime: -1 }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ pinned: true, muted: true });
    });

    it('adds no row for the unarchive a message carries, and still clears an archived chat with it', () => {
      const s = newStore();
      const G = '120363000000000002@g.us';
      s.upsertChats([{ id: G, archived: true }]);
      const message = { archived: false, readOnly: false, conversationTimestamp: 60, unreadCount: 1 };
      s.upsertChats([
        { id: PHONE, ...message },
        { id: G, ...message },
      ]);
      expect([...fake.rows.keys()]).toEqual([K(G)]);
      expect(fake.get(SID, G)).toMatchObject({ archived: false });
      s.upsertChats([{ id: LID, pinned: null }]);
      expect(fake.get(SID, LID)).toMatchObject({ pinned: false, observed: ['pinned'] });
    });

    it('finds the lid twin of one state update without indexing every mapping', () => {
      const s = newStore();
      s.upsertChats([{ id: LID, pinned: 3 }]);
      s.addLidMappings([
        { lid: LID, pn: PHONE },
        { lid: '515151@lid', pn: '628222@s.whatsapp.net' },
      ]);
      const index = jest.spyOn(s as unknown as { lidsByPhone(): Map<string, string[]> }, 'lidsByPhone');
      s.upsertChats([
        { id: '120363000000000001@g.us', archived: false },
        { id: PHONE, muteEndTime: -1 },
      ]);
      expect(index).not.toHaveBeenCalled();
      expect([...fake.rows.keys()].sort()).toEqual([K('120363000000000001@g.us'), K(PHONE)]);
      expect(fake.get(SID, PHONE)).toMatchObject({ pinned: true, muteEndTime: -1 });
    });

    const HOUR = 3_600_000;
    const soon = Date.now() + HOUR;
    const later = Date.now() + 2 * HOUR;

    it.each([
      [1000, 2000, later],
      [2000, 1000, soon],
    ])('lets the newer of two rows already on disk win (phone at %i, lid at %i)', async (phoneAt, lidAt, end) => {
      fake.rows.set(K(PHONE), { muteEndTime: soon, archived: false, pinned: false, updatedAt: phoneAt });
      fake.rows.set(K(LID), { muteEndTime: later, archived: false, pinned: false, updatedAt: lidAt });
      const s = newStore();
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      s.upsertChats([historyChat(PHONE)]);
      expect(s.listChats()[0].muteExpiration).toBe(end);
      await flush();
      expect([...fake.rows.keys()]).toEqual([K(PHONE), K(LID)]);
      s.upsertChats([{ id: PHONE, archived: true }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(fake.get(SID, PHONE)).toMatchObject({ muteEndTime: end, archived: true });
    });

    it('keeps a pin on the older row when the newer row of the chat holds only a mute', () => {
      const [mute, pin] = [['muteEndTime'], ['pinned']] as ChatStateField[][];
      fake.rows.set(K(PHONE), { muteEndTime: later, archived: false, pinned: false, updatedAt: 2000, observed: mute });
      fake.rows.set(K(LID), { muteEndTime: null, archived: false, pinned: true, updatedAt: 1000, observed: pin });
      const s = newStore();
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      s.upsertChats([historyChat(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ pinned: true, muted: true, muteExpiration: later });
      s.upsertChats([{ id: PHONE, archived: true }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(fake.get(SID, PHONE)).toMatchObject({ muteEndTime: later, pinned: true, archived: true });
    });

    it('lets a later unpin synced under the unresolved lid outweigh the pin on the phone row', () => {
      const s = newStore();
      s.upsertChats([{ id: PHONE, pinned: 2 }]);
      s.upsertChats([{ id: LID, pinned: 0 }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', pinned: false })]);
      s.upsertChats([{ id: PHONE, muteEndTime: -1 }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ pinned: false, muted: true });
    });

    it('keeps a pin on the older of two rows written before rows kept what they observed', () => {
      fake.rows.set(K(PHONE), { muteEndTime: -1, archived: false, pinned: false, updatedAt: 2000 });
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: true, updatedAt: 1000 });
      const s = newStore();
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      s.upsertChats([historyChat(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ pinned: true, archived: true, muted: true });
      s.upsertChats([{ id: PHONE, muteEndTime: -1 }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ pinned: true, archived: true, muted: true });
    });

    it('writes nothing while listing a chat that still has a lid twin row', () => {
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: false });
      const s = newStore();
      s.upsertChats([{ id: PHONE }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      const writes = ['remember', 'fold', 'forget'].map(m => jest.spyOn(fake, m as 'remember'));
      expect(s.listChats()[0].archived).toBe(true);
      for (const w of writes) expect(w).not.toHaveBeenCalled();
    });

    it('reads the own lid row of a lid-keyed chat whose phone only its contact record knows', () => {
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: true });
      const s = newStore();
      s.upsertContacts([{ id: LID, phoneNumber: PHONE }]);
      s.upsertChats([{ id: LID }]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', archived: true, pinned: true })]);
      s.upsertChats([{ id: LID, muteEndTime: -1 }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ archived: true, pinned: true, muted: true });
    });

    it.each([
      ['a phone-keyed chat record', [PHONE]],
      ['both chat records, the phone one first', [PHONE, LID]],
    ])('reads, folds and forgets a lid row that only a lid-keyed contact maps, with %s', (_label, ids) => {
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: true });
      const s = newStore();
      s.upsertContacts([{ id: LID, phoneNumber: PHONE }]);
      s.upsertChats(ids.map(id => ({ id })));
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', archived: true, pinned: true })]);
      s.upsertChats([{ id: PHONE, muteEndTime: -1 }]);
      expect([...fake.rows.keys()]).toEqual([K(PHONE)]);
      expect(s.listChats()[0]).toMatchObject({ archived: true, pinned: true, muted: true });
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: true });
      s.removeChats([PHONE]);
      expect(fake.rows.size).toBe(0);
      expect(s.listChats()).toEqual([]);
    });

    it('reads the lid record row of a merged chat once the lid mapping is evicted', () => {
      const cap = process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES;
      process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES = '2';
      try {
        fake.rows.set(K(LID), { muteEndTime: null, archived: false, pinned: true });
        const s = newStore();
        s.upsertContacts([{ id: LID, phoneNumber: PHONE, name: 'Alice' }]);
        s.addLidMappings([
          { lid: '1@lid', pn: '6201@s.whatsapp.net' },
          { lid: '2@lid', pn: '6202@s.whatsapp.net' },
        ]);
        s.upsertChats([{ id: PHONE }, { id: LID }]);
        expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', pinned: true })]);
      } finally {
        if (cap === undefined) delete process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES;
        else process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES = cap;
      }
    });

    it.each([
      ['the lid, with the state under the phone', LID, PHONE],
      ['the phone, with the state under the lid', PHONE, LID],
    ])('forgets a deleted chat named by %s when only the mapping table pairs them', async (_label, deleted, row) => {
      fake.rows.set(K(row), { muteEndTime: null, archived: false, pinned: true });
      const lidStore = {
        getCached: jest.fn(() => undefined),
        resolveLid: jest.fn(() => null),
        lidsForPhone: jest.fn(() => []),
        findPhoneForLid: jest.fn((jid: string) => Promise.resolve(jid.startsWith('484848') ? '628111' : null)),
        findLidsForPhone: jest.fn((phone: string) => Promise.resolve(phone === '628111' ? ['484848'] : [])),
        remember: jest.fn(() => Promise.resolve()),
      };
      const s = new BaileysSessionStore(lidStore, SID, fake);
      s.removeChats([deleted]);
      await flush();
      expect(fake.rows.size).toBe(0);
      expect(s.listChats()).toEqual([]);
    });

    it('finds the lid through the persisted mapping table as well', () => {
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: false });
      const lidStore = {
        getCached: jest.fn((lid: string) => (lid === '484848' ? '628111' : undefined)),
        resolveLid: jest.fn(() => null),
        lidsForPhone: jest.fn((phone: string) => (phone === '628111' ? ['484848'] : [])),
        remember: jest.fn(() => Promise.resolve()),
      };
      const s = new BaileysSessionStore(lidStore, SID, fake);
      s.upsertChats([{ id: PHONE }]);
      expect(s.listChats()[0].archived).toBe(true);
    });

    it('writes nothing while listing a chat that has no twin row', () => {
      const s = newStore();
      s.upsertChats([{ id: PHONE, pinned: 2 }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      const remember = jest.spyOn(fake, 'remember');
      const forget = jest.spyOn(fake, 'forget');
      s.listChats();
      expect(remember).not.toHaveBeenCalled();
      expect(forget).not.toHaveBeenCalled();
    });

    it.each([
      ['phone first', [PHONE, LID]],
      ['lid first', [LID, PHONE]],
    ])('merges the two records into one row, whichever arrived first (%s)', (_order, ids) => {
      const s = new BaileysSessionStore();
      for (const id of ids) {
        s.upsertChats([id === LID ? { id, name: 'Alice', unreadCount: 2, conversationTimestamp: 50 } : { id }]);
      }
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([
        expect.objectContaining({ id: '628111@c.us', name: 'Alice', unreadCount: 2, timestamp: 50 }),
      ]);
    });

    it('takes the unread count from the more recently active of the two records', () => {
      const s = new BaileysSessionStore();
      s.upsertChats([
        { id: PHONE, name: 'Alice', unreadCount: 0, conversationTimestamp: 10 },
        { id: LID, unreadCount: 2, conversationTimestamp: 50 },
      ]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', unreadCount: 2, timestamp: 50 })]);
    });

    it('shows a preview filed under the lid before the mapping on the merged row, newest first', () => {
      const s = new BaileysSessionStore();
      const msg = (remoteJid: string, id: string, ts: number) => ({
        key: { remoteJid, fromMe: false, id },
        message: { conversation: id },
        messageTimestamp: ts,
      });
      s.upsertChats([{ id: PHONE }]);
      s.recordMessage(msg(LID, 'VIA_LID', 100));
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([
        expect.objectContaining({ id: '628111@c.us', timestamp: 100, lastMessage: 'VIA_LID' }),
      ]);
      s.recordMessage(msg(PHONE, 'VIA_PHONE', 50));
      expect(s.listChats()[0]).toMatchObject({ timestamp: 100, lastMessage: 'VIA_LID' });
    });

    it('keeps distinct chats apart', () => {
      const s = new BaileysSessionStore();
      s.upsertChats([{ id: PHONE }, { id: '628222@s.whatsapp.net' }, { id: '999@lid' }, { id: '120363@g.us' }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats().map(c => c.id)).toEqual(['628111@c.us', '628222@c.us', '999@lid', '120363@g.us']);
    });

    it('forgets the folded row when the chat is deleted under its lid', () => {
      const s = newStore();
      s.upsertChats([{ id: PHONE, pinned: 2 }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      s.removeChats([LID]);
      expect(fake.rows.size).toBe(0);
    });

    it('lists a chat with a persisted state after a restart, before its next message', () => {
      fake.rows.set(K(PHONE), { muteEndTime: null, archived: false, pinned: true });
      fake.rows.set(K('628222@s.whatsapp.net'), { muteEndTime: -1, archived: false, pinned: false });
      fake.rows.set('other\u0000628333@s.whatsapp.net', { muteEndTime: -1, archived: false, pinned: false });
      const s = newStore();
      s.upsertContacts([{ id: PHONE, name: 'Alice' }]);
      s.upsertChats([{ id: '628222@s.whatsapp.net', name: 'Bob', conversationTimestamp: 70 }]);
      expect(s.listChats()).toEqual([
        expect.objectContaining({ id: '628222@c.us', name: 'Bob', timestamp: 70, muted: true }),
        expect.objectContaining({ id: '628111@c.us', name: 'Alice', timestamp: 0, pinned: true }),
      ]);
      s.removeChats([PHONE]);
      expect(s.listChats().map(c => c.id)).toEqual(['628222@c.us']);
    });

    it('lists a persisted state filed under a lid once, under the phone', () => {
      fake.rows.set(K(LID), { muteEndTime: null, archived: true, pinned: false });
      const s = newStore();
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.listChats()).toEqual([expect.objectContaining({ id: '628111@c.us', archived: true })]);
    });

    it('finds the disappearing timer a lid-keyed chat record carries from the @c.us id', () => {
      const s = new BaileysSessionStore();
      s.upsertChats([{ id: LID, ephemeralExpiration: 86400 }]);
      s.addLidMappings([{ lid: LID, pn: PHONE }]);
      expect(s.getEphemeralExpiration('628111@c.us')).toBe(86400);
    });
  });

  describe('persistent lid->phone table', () => {
    const makeFakeLidStore = () => {
      const map = new Map<string, string | null>();
      const getCached = jest.fn((lid: string) => map.get(lid));
      return {
        map,
        getCached,
        // Mirrors the real implementation: userPart of the JID through getCached, null on a miss.
        resolveLid: jest.fn((jid: string) => getCached(userPart(jid)) ?? null),
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
      s.upsertContacts([{ id: '222@lid', lid: '222@lid', phoneNumber: '628222@s.whatsapp.net' }]);
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
      s.upsertContacts([{ id: 'c1', phoneNumber: '628444@s.whatsapp.net' }]); // phone arrives later
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

  describe('map bounds (BAILEYS_SESSION_STORE_MAX_ENTRIES)', () => {
    const ENV = 'BAILEYS_SESSION_STORE_MAX_ENTRIES';
    const orig = process.env[ENV];
    afterEach(() => {
      if (orig === undefined) delete process.env[ENV];
      else process.env[ENV] = orig;
    });

    const storeWithCap = (cap: string, lidStore?: LidMappingStore) => {
      process.env[ENV] = cap;
      return new BaileysSessionStore(lidStore);
    };

    it('evicts the oldest unsaved contact once over the cap; the miss reads as "unknown"', () => {
      const s = storeWithCap('2');
      s.upsertContacts([{ id: '628111@s.whatsapp.net', notify: 'A' }]);
      s.upsertContacts([{ id: '628222@s.whatsapp.net', notify: 'B' }]);
      s.upsertContacts([{ id: '628333@s.whatsapp.net', notify: 'C' }]);
      expect(s.findContact('628111@s.whatsapp.net')).toBeNull(); // evicted, same as never seen
      expect(s.findContact('628222@s.whatsapp.net')?.pushName).toBe('B');
      expect(s.findContact('628333@s.whatsapp.net')?.pushName).toBe('C');
    });

    it('treats a read as usage: a refreshed entry survives while a stale one is evicted (LRU)', () => {
      const s = storeWithCap('2');
      s.upsertContacts([{ id: '628111@s.whatsapp.net', notify: 'A' }]);
      s.upsertContacts([{ id: '628222@s.whatsapp.net', notify: 'B' }]);
      expect(s.findContact('628111@s.whatsapp.net')?.pushName).toBe('A'); // refresh A
      s.upsertContacts([{ id: '628333@s.whatsapp.net', notify: 'C' }]); // evicts B, not A
      expect(s.findContact('628111@s.whatsapp.net')?.pushName).toBe('A');
      expect(s.findContact('628222@s.whatsapp.net')).toBeNull();
    });

    it('still caches peers once the saved contacts alone fill the cap', () => {
      // The cap governs the peer population. Measuring the whole map instead made a full address
      // book evict each new peer in the very call that inserted it, so `GET /contacts/:id` stopped
      // resolving anyone who is not saved, and chat titles fell back to the raw number.
      const s = storeWithCap('2');
      s.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
      s.upsertContacts([{ id: '628222@s.whatsapp.net', name: 'Bob' }]);

      s.upsertContacts([{ id: '629001@s.whatsapp.net', notify: 'peer one' }]);
      s.upsertContacts([{ id: '629002@s.whatsapp.net', notify: 'peer two' }]);

      expect(s.findContact('629001@s.whatsapp.net')?.pushName).toBe('peer one');
      expect(s.findContact('629002@s.whatsapp.net')?.pushName).toBe('peer two');
      expect(s.findContact('628111@s.whatsapp.net')?.name).toBe('Alice');
      expect(s.findContact('628222@s.whatsapp.net')?.name).toBe('Bob');
    });

    it('keeps the saved address book when unsaved peers overflow the cap', () => {
      // The two populations share one map: a handful of contacts the account saved, and every peer
      // seen once in a group or a broadcast. Only the second grows without limit, and it used to
      // evict the first, emptying GET /contacts on a busy session.
      const s = storeWithCap('3');
      s.upsertContacts([{ id: '628111@s.whatsapp.net', name: 'Alice' }]);
      for (let i = 0; i < 50; i++) {
        s.upsertContacts([{ id: `62${9000 + i}@s.whatsapp.net`, notify: `peer ${i}` }]);
      }
      expect(s.findContact('628111@s.whatsapp.net')?.name).toBe('Alice');
      expect(s.listContacts()).toEqual([expect.objectContaining({ name: 'Alice' })]);
    });

    it('bounds chats: listChats stays at the cap and drops the oldest conversation', () => {
      const s = storeWithCap('2');
      s.upsertChats([{ id: '628111@s.whatsapp.net', name: 'A' }]);
      s.upsertChats([{ id: '628222@s.whatsapp.net', name: 'B' }]);
      s.upsertChats([{ id: '628333@s.whatsapp.net', name: 'C' }]);
      expect(s.listChats().map(c => c.id)).toEqual(['628222@c.us', '628333@c.us']);
    });

    it('bounds lastMessages: an evicted preview reads as the null miss callers already handle', () => {
      const s = storeWithCap('2');
      for (const [i, ts] of [
        ['628111', 100],
        ['628222', 200],
        ['628333', 300],
      ] as const) {
        s.recordMessage({
          key: { remoteJid: `${i}@s.whatsapp.net`, fromMe: false, id: `M-${i}` },
          message: { conversation: 'hi' },
          messageTimestamp: ts,
        });
      }
      expect(s.lastMessage('628111@s.whatsapp.net')).toBeNull(); // sendSeen/markUnread/deleteChat → false
      expect(s.lastMessage('628333@s.whatsapp.net')?.key.id).toBe('M-628333');
    });

    it('bounds lidToPn: an evicted mapping still resolves via the write-through persistent table', () => {
      const map = new Map<string, string | null>();
      const getCached = jest.fn((lid: string) => map.get(lid));
      const lidStore = {
        getCached,
        resolveLid: jest.fn((jid: string) => getCached(userPart(jid)) ?? null),
        lidsForPhone: jest.fn(() => [] as string[]),
        remember: jest.fn((lid: string, phone: string | null) => {
          map.set(lid, phone);
          return Promise.resolve();
        }),
      };
      const s = storeWithCap('2', lidStore);
      s.addLidMappings([
        { lid: '111@lid', pn: '628111@s.whatsapp.net' },
        { lid: '222@lid', pn: '628222@s.whatsapp.net' },
        { lid: '333@lid', pn: '628333@s.whatsapp.net' },
      ]);
      // 111 was evicted from memory: resolution falls through to the persisted row (getCached hit).
      expect(s.resolvePhone('111@lid')).toBe('628111');
      expect(lidStore.getCached).toHaveBeenCalledWith('111');
      // 333 is still in memory: no persistent-table read needed.
      expect(s.resolvePhone('333@lid')).toBe('628333');
      expect(lidStore.getCached).not.toHaveBeenCalledWith('333');
    });

    it('bounds ephemeralByChat (two keys per chat): the oldest chat timer falls back to undefined', () => {
      const s = storeWithCap('2'); // timer map allows 2 × cap = 4 keys → two chats
      for (const i of ['628111', '628222', '628333']) {
        s.recordMessage({
          key: { remoteJid: `${i}@s.whatsapp.net`, fromMe: false, id: `M-${i}` },
          message: { conversation: 'hi' },
          messageTimestamp: 100,
          ephemeralDuration: 86400,
        });
      }
      expect(s.getEphemeralExpiration('628111@s.whatsapp.net')).toBeUndefined(); // evicted → no forced timer
      expect(s.getEphemeralExpiration('628222@s.whatsapp.net')).toBe(86400);
      expect(s.getEphemeralExpiration('628333@s.whatsapp.net')).toBe(86400);
    });

    it('treats 0 as unbounded (legacy behaviour)', () => {
      const s = storeWithCap('0');
      for (let i = 0; i < 100; i++) {
        s.upsertContacts([{ id: `62${1000 + i}@s.whatsapp.net`, name: 'x' }]);
      }
      expect(s.listContacts()).toHaveLength(100);
    });

    it('falls back to the 5000 default for a garbage override', () => {
      const s = storeWithCap('not-a-number');
      // Unsaved peers: the cap governs exactly this population (a saved contact is pinned).
      s.upsertContacts(Array.from({ length: 5001 }, (_, i) => ({ id: `62${100000 + i}@s.whatsapp.net`, notify: 'x' })));
      expect(s.findContact('62100000@s.whatsapp.net')).toBeNull(); // the oldest went first
      // Only the oldest: one entry over a 5000 cap evicts exactly one, which is what pins the default.
      expect(s.findContact('62100001@s.whatsapp.net')).not.toBeNull();
      expect(s.findContact('62105000@s.whatsapp.net')).not.toBeNull();
    });

    it('treats a blank override as unset, not as 0 (unbounded)', () => {
      const s = storeWithCap('');
      s.upsertContacts(Array.from({ length: 5001 }, (_, i) => ({ id: `62${100000 + i}@s.whatsapp.net`, notify: 'x' })));
      expect(s.findContact('62100000@s.whatsapp.net')).toBeNull();
      expect(s.findContact('62100001@s.whatsapp.net')).not.toBeNull();
      expect(s.findContact('62105000@s.whatsapp.net')).not.toBeNull();
    });
  });
});
