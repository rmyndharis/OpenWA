import type { GroupMetadata } from '@whiskeysockets/baileys';
import { GroupMetadataCache, groupMetadataCacheTtlMs } from './baileys-group-metadata-cache';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';

const group = (id: string, members: string[] = ['628111@s.whatsapp.net']): GroupMetadata =>
  ({ id, subject: 'Test', participants: members.map(member => ({ id: member })) }) as unknown as GroupMetadata;

describe('GroupMetadataCache', () => {
  let clock: number;
  const now = (): number => clock;
  const build = (ttlMs = 1000, maxEntries = 256): GroupMetadataCache => new GroupMetadataCache(ttlMs, maxEntries, now);

  beforeEach(() => {
    clock = 1_000_000;
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('reading through', () => {
    it('queries once and answers from the cache until the TTL ends', async () => {
      const cache = build();
      const fetch = jest.fn().mockResolvedValue(group(GROUP));

      const first = await cache.read(GROUP, fetch);
      clock += 999;
      const second = await cache.read(GROUP, fetch);

      expect(first).toBe(second);
      expect(fetch).toHaveBeenCalledTimes(1);

      clock += 1;
      await cache.read(GROUP, fetch);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps each group apart', async () => {
      const cache = build();
      const fetch = jest.fn((jid: string) => Promise.resolve(group(jid)));

      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));
      await cache.read(GROUP, () => fetch(GROUP));

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('lets concurrent reads of one group share a single query', async () => {
      const cache = build();
      let answer!: (metadata: GroupMetadata) => void;
      const fetch = jest.fn(() => new Promise<GroupMetadata>(resolve => (answer = resolve)));

      const reads = [cache.read(GROUP, fetch), cache.read(GROUP, fetch), cache.read(GROUP, fetch)];
      answer(group(GROUP));
      const results = await Promise.all(reads);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Set(results).size).toBe(1);
    });

    it('does not keep a failed query: the error surfaces and the next read asks again', async () => {
      const cache = build();
      const fetch = jest.fn().mockRejectedValueOnce(new Error('rate-overlimit')).mockResolvedValue(group(GROUP));

      await expect(cache.read(GROUP, fetch)).rejects.toThrow('rate-overlimit');
      await expect(cache.read(GROUP, fetch)).resolves.toMatchObject({ id: GROUP });

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('answers undefined without querying when the TTL is 0, so Baileys queries on its own', async () => {
      const cache = build(0);
      const fetch = jest.fn().mockResolvedValue(group(GROUP));

      await expect(cache.read(GROUP, fetch)).resolves.toBeUndefined();

      expect(cache.enabled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('forgetting', () => {
    it('reads a group again after it is invalidated, and leaves the others', async () => {
      const cache = build();
      const fetch = jest.fn((jid: string) => Promise.resolve(group(jid)));
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));

      cache.invalidate(GROUP);
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));

      expect(fetch.mock.calls.map(([jid]) => jid)).toEqual([GROUP, OTHER, GROUP]);
    });

    it('ignores an invalidation that names no group', () => {
      const cache = build();
      expect(() => cache.invalidate(undefined)).not.toThrow();
    });

    it('does not keep an answer that an invalidation overtook, but still hands it to its callers', async () => {
      const cache = build();
      let answer!: (metadata: GroupMetadata) => void;
      const slow = jest.fn(() => new Promise<GroupMetadata>(resolve => (answer = resolve)));
      const read = cache.read(GROUP, slow);

      cache.invalidate(GROUP); // the membership changed while the query was out
      answer(group(GROUP, ['628111@s.whatsapp.net']));

      await expect(read).resolves.toMatchObject({ id: GROUP });
      const fresh = jest.fn().mockResolvedValue(group(GROUP, ['628111@s.whatsapp.net', '628222@s.whatsapp.net']));
      await cache.read(GROUP, fresh);
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    // A query out on a socket that has been replaced may never be answered, so a read that follows the
    // change has to ask again rather than wait on it, and the old answer must leave the new read alone.
    it.each([
      ['an invalidation', (cache: GroupMetadataCache) => cache.invalidate(GROUP)],
      ['a clear', (cache: GroupMetadataCache) => cache.clear()],
    ])('asks again for a read that follows %s while a query is out', async (_label, forget) => {
      const cache = build();
      let answerOld!: (metadata: GroupMetadata) => void;
      const old = cache.read(GROUP, () => new Promise<GroupMetadata>(resolve => (answerOld = resolve)));

      forget(cache);
      let answerNew!: (metadata: GroupMetadata) => void;
      const fresh = jest.fn(() => new Promise<GroupMetadata>(resolve => (answerNew = resolve)));
      const next = cache.read(GROUP, fresh);
      expect(fresh).toHaveBeenCalledTimes(1);

      answerOld(group(GROUP, ['628111@s.whatsapp.net']));
      await old;
      expect(cache.size).toBe(0); // the old answer is not kept
      const joiner = jest.fn();
      void cache.read(GROUP, joiner);
      expect(joiner).not.toHaveBeenCalled(); // and it did not release the new query's slot

      answerNew(group(GROUP, ['628111@s.whatsapp.net', '628222@s.whatsapp.net']));
      await expect(next).resolves.toMatchObject({ participants: [{}, {}] });
      expect(cache.size).toBe(1);
    });

    it('clears every group, and an answer in flight is not kept either', async () => {
      const cache = build();
      await cache.read(GROUP, () => Promise.resolve(group(GROUP)));
      let answer!: (metadata: GroupMetadata) => void;
      const inFlight = cache.read(OTHER, () => new Promise<GroupMetadata>(resolve => (answer = resolve)));

      cache.clear();
      answer(group(OTHER));
      await inFlight;

      expect(cache.size).toBe(0);
    });

    it('evicts the least recently used group beyond its capacity', async () => {
      const cache = build(1000, 2);
      const fetch = jest.fn((jid: string) => Promise.resolve(group(jid)));
      const third = '120363000000000003@g.us';
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));
      await cache.read(GROUP, () => fetch(GROUP)); // GROUP is now the more recent of the two

      await cache.read(third, () => fetch(third)); // pushes OTHER out

      expect(cache.size).toBe(2);
      fetch.mockClear();
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));
      expect(fetch.mock.calls.map(([jid]) => jid)).toEqual([OTHER]);
    });
  });

  // The TTL is checked when a group is read, so without a timer a group nobody sends to again would keep
  // its participant list in memory for as long as the socket lives. The manual clock does not move with the
  // fake timers, so each step advances both.
  describe('expiry', () => {
    const elapse = (ms: number): void => {
      clock += ms;
      jest.advanceTimersByTime(ms);
    };

    it('drops an entry whose TTL ran out without its group being read again', async () => {
      const cache = build();
      await cache.read(GROUP, () => Promise.resolve(group(GROUP)));
      await cache.read(OTHER, () => Promise.resolve(group(OTHER)));

      elapse(1000);

      expect(cache.size).toBe(0);
    });

    it('keeps an entry still within its TTL when the timer fires, drops it at the next, then stops', async () => {
      const cache = build();
      await cache.read(GROUP, () => Promise.resolve(group(GROUP)));
      elapse(600);
      await cache.read(OTHER, () => Promise.resolve(group(OTHER)));

      elapse(400); // GROUP is due, OTHER is 400 ms old
      expect(cache.size).toBe(1);

      elapse(1000);
      expect(cache.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('stops its timer when the cache is cleared', async () => {
      const cache = build();
      await cache.read(GROUP, () => Promise.resolve(group(GROUP)));
      expect(jest.getTimerCount()).toBe(1);

      cache.clear();

      expect(jest.getTimerCount()).toBe(0);
    });

    // The handle of a timer that was cleared must not be taken for a pending one, or nothing stored after a
    // reconnect would ever expire again.
    it('starts a new timer for what is stored after a clear', async () => {
      const cache = build();
      await cache.read(GROUP, () => Promise.resolve(group(GROUP)));
      cache.clear();
      await cache.read(OTHER, () => Promise.resolve(group(OTHER)));
      expect(jest.getTimerCount()).toBe(1);

      elapse(1000);

      expect(cache.size).toBe(0);
    });

    it('does not keep the process alive while it waits', async () => {
      const fake = global.setTimeout;
      const unrefs: Array<jest.SpyInstance> = [];
      const arm = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const handle = fake(fn, ms) as unknown as { unref: () => unknown };
        if (ms === 1000) unrefs.push(jest.spyOn(handle, 'unref'));
        return handle;
      }) as never);
      try {
        const cache = build();
        await cache.read(GROUP, () => Promise.resolve(group(GROUP)));

        expect(unrefs).toHaveLength(1);
        expect(unrefs[0]).toHaveBeenCalledTimes(1);
      } finally {
        arm.mockRestore();
      }
    });

    it('never waits longer than a Node timer accepts, whatever the TTL', async () => {
      const arm = jest.spyOn(global, 'setTimeout');
      try {
        const cache = build(2 ** 40);
        await cache.read(GROUP, () => Promise.resolve(group(GROUP)));

        expect(arm).toHaveBeenLastCalledWith(expect.any(Function), 2 ** 31 - 1);
      } finally {
        arm.mockRestore();
      }
    });
  });

  describe('groups.update batches', () => {
    it('drops a group whose partial change arrives, and leaves the others', async () => {
      const cache = build();
      const fetch = jest.fn((jid: string) => Promise.resolve(group(jid)));
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));

      cache.applyUpdates([{ id: GROUP, announce: true }]);

      fetch.mockClear();
      await cache.read(GROUP, () => fetch(GROUP));
      await cache.read(OTHER, () => fetch(OTHER));
      expect(fetch.mock.calls.map(([jid]) => jid)).toEqual([GROUP]);
    });

    it('drops a cached group a whole snapshot names, so only the single-group query writes an entry', async () => {
      const cache = build();
      const queried = {
        ...group(GROUP, ['159442138038327@lid']),
        addressingMode: 'lid',
        ephemeralDuration: 86400,
      } as unknown as GroupMetadata;
      const fetch = jest.fn().mockResolvedValue(queried);
      await cache.read(GROUP, fetch);

      // A snapshot of the all-groups listing: phone-form ids, no addressing mode, no disappearing timer.
      cache.applyUpdates([group(GROUP, ['628111@s.whatsapp.net']), group(OTHER)]);

      expect(cache.peek(GROUP)).toBeUndefined();
      expect(cache.size).toBe(0);
      expect(await cache.read(GROUP, fetch)).toBe(queried);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not keep a read that a snapshot overtook', async () => {
      const cache = build();
      let answer!: (metadata: GroupMetadata) => void;
      const fetch = jest.fn(() => new Promise<GroupMetadata>(resolve => (answer = resolve)));
      const read = cache.read(GROUP, fetch);

      cache.applyUpdates([group(GROUP, ['628111@s.whatsapp.net'])]);
      answer(group(GROUP));
      await read;

      expect(cache.size).toBe(0);
    });

    it('does not add a group nobody has sent to from a snapshot', () => {
      const cache = build();

      cache.applyUpdates([group(GROUP), group(OTHER)]);

      expect(cache.size).toBe(0);
    });

    it('skips entries without an id and tolerates a missing batch', () => {
      const cache = build();
      expect(() => cache.applyUpdates([{ subject: 'no id' }])).not.toThrow();
      expect(() => cache.applyUpdates(undefined)).not.toThrow();
    });
  });
});

describe('groupMetadataCacheTtlMs', () => {
  const KEY = 'BAILEYS_GROUP_METADATA_CACHE_TTL_MS';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to five minutes', () => {
    delete process.env[KEY];
    expect(groupMetadataCacheTtlMs()).toBe(300_000);
  });

  it('takes a configured value, 0 included, and falls back on garbage', () => {
    process.env[KEY] = '60000';
    expect(groupMetadataCacheTtlMs()).toBe(60_000);
    process.env[KEY] = '0';
    expect(groupMetadataCacheTtlMs()).toBe(0);
    process.env[KEY] = '5m';
    expect(groupMetadataCacheTtlMs()).toBe(300_000);
    process.env[KEY] = '';
    expect(groupMetadataCacheTtlMs()).toBe(300_000);
  });
});
