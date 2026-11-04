import type { Chat } from '@whiskeysockets/baileys';
import { BaileysSessionStore } from './baileys-session-store';

/**
 * A phone's twins come from a walk of every lid mapping the session caches (up to 5000 by default), and a history
 * chunk can carry thousands of chat records with a disappearing timer, all applied in one synchronous call. The
 * walks are counted as reads of the mapping cache's entries, taken around the one upsert being measured.
 */
describe('Baileys chat timer update cost', () => {
  const DAY = 86_400;
  const WEEK = 604_800;
  const phone = (i: number): string => `62811${100_000 + i}@s.whatsapp.net`;
  const lid = (i: number): string => `${100_000_000_000_000 + i}@lid`;

  function storeWithMappings(count: number, extra: { lid: string; pn: string }[] = []) {
    const store = new BaileysSessionStore(undefined, 'sess-1');
    store.addLidMappings([...Array.from({ length: count }, (_, i) => ({ lid: lid(i), pn: phone(i) })), ...extra]);
    const walks = jest.spyOn((store as unknown as { lidToPn: { entries(): unknown } }).lidToPn, 'entries');
    return { store, walks };
  }

  const timed = (id: string, setAt = 1_799_000_000, exp: number | null = DAY): Partial<Chat> => ({
    id,
    conversationTimestamp: 1_800_000_000,
    ephemeralExpiration: exp,
    ephemeralSettingTimestamp: setAt,
  });

  it('walks the lid mappings once to apply the timer of a phone-keyed chat update', () => {
    const { store, walks } = storeWithMappings(20);
    store.upsertChats([timed(phone(3))]);

    expect(walks).toHaveBeenCalledTimes(1);
    expect(store.getEphemeralExpiration(phone(3))).toBe(DAY);
    expect(store.getEphemeralExpiration(lid(3))).toBe(DAY);
  });

  it('walks the lid mappings once to apply the timer of a lid-keyed chat update', () => {
    const { store, walks } = storeWithMappings(20);
    store.upsertChats([timed(lid(3))]);

    expect(walks).toHaveBeenCalledTimes(1);
    expect(store.getEphemeralExpiration(lid(3))).toBe(DAY);
    expect(store.getEphemeralExpiration(phone(3))).toBe(DAY);
  });

  it('walks the lid mappings once for a whole batch of timed chats', () => {
    const { store, walks } = storeWithMappings(100);
    const records = Array.from({ length: 50 }, (_, i) => timed(i % 2 ? lid(i) : phone(i)));
    store.upsertChats(records);

    expect(walks).toHaveBeenCalledTimes(1);
    for (const i of [0, 1, 48, 49]) {
      expect(store.getEphemeralExpiration(phone(i))).toBe(DAY);
      expect(store.getEphemeralExpiration(lid(i))).toBe(DAY);
    }
    expect(store.getEphemeralExpiration(phone(60))).toBeUndefined();
  });

  it('does not walk the lid mappings for a batch that carries no timer', () => {
    const { store, walks } = storeWithMappings(20);
    store.upsertChats([
      { id: phone(1), conversationTimestamp: 1_800_000_000 },
      { id: lid(2), name: 'Ada' },
    ]);

    expect(walks).not.toHaveBeenCalled();
  });

  it("keeps each holder's timer apart when one batch carries both chats of a phone mapped to two lids", () => {
    const OLD = '111111111111111@lid';
    const NEW = '222222222222222@lid';
    const PEER = '628111@s.whatsapp.net';
    const { store, walks } = storeWithMappings(20, [
      { lid: OLD, pn: PEER },
      { lid: NEW, pn: PEER },
    ]);
    store.upsertChats([timed(OLD, 1_800_000_100, DAY), timed(NEW, 1_800_000_050, WEEK)]);

    expect(walks).toHaveBeenCalledTimes(1);
    expect(store.getEphemeralExpiration(OLD)).toBe(DAY);
    expect(store.getEphemeralExpiration(NEW)).toBe(WEEK);
    expect(store.getEphemeralExpiration(PEER)).toBeUndefined();
  });

  it('drops a record older than the timer an earlier record of the same batch applied under its twin', () => {
    const { store, walks } = storeWithMappings(20);
    store.upsertChats([timed(phone(4), 1_799_500_000, null), timed(lid(4), 1_799_000_000, DAY)]);

    expect(walks).toHaveBeenCalledTimes(1);
    expect(store.getEphemeralExpiration(phone(4))).toBeUndefined();
    expect(store.getEphemeralExpiration(lid(4))).toBeUndefined();
  });
});
