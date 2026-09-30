import { Repository } from 'typeorm';
import { ChatStateStoreService, mergeTwinStates } from './baileys-chat-state-store.service';
import { ChatState } from './baileys-chat-state.entity';
import { BaileysSessionStore } from './baileys-session-store';

const KEY = (s: string, c: string): string => `${s}\u0000${c}`;

function makeRepo(initial: Partial<ChatState>[] = []) {
  const rows = new Map<string, ChatState>();
  for (const r of initial) {
    rows.set(KEY(r.sessionId!, r.chatId!), {
      muteEndTime: null,
      archived: false,
      pinned: false,
      updatedAt: new Date(),
      ...r,
    } as ChatState);
  }
  const repo = {
    rows,
    // Honors the DESC order and the take the service asks for; the sort is stable for equal stamps.
    find: jest.fn((opts?: { where?: { sessionId: string }; order?: { updatedAt?: 'DESC' }; take?: number }) => {
      const found = [...rows.values()].filter(r => !opts?.where || r.sessionId === opts.where.sessionId);
      const at = (r: ChatState) => r.updatedAt?.getTime() ?? 0;
      if (opts?.order?.updatedAt === 'DESC') found.sort((a, b) => at(b) - at(a));
      return Promise.resolve(opts?.take ? found.slice(0, opts.take) : found);
    }),
    findOne: jest.fn(({ where }: { where: { sessionId: string; chatId: string } }) =>
      Promise.resolve(rows.get(KEY(where.sessionId, where.chatId))),
    ),
    // TypeORM's upsert overwrites only the columns the entity carries, so a partial one merges.
    upsert: jest.fn((v: ChatState) => {
      rows.set(KEY(v.sessionId, v.chatId), { ...rows.get(KEY(v.sessionId, v.chatId)), ...v });
      return Promise.resolve(undefined);
    }),
    update: jest.fn(({ sessionId, chatId }: { sessionId: string; chatId: string }, v: Partial<ChatState>) => {
      const row = rows.get(KEY(sessionId, chatId));
      if (row) rows.set(KEY(sessionId, chatId), { ...row, ...v });
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    // Only the insert-or-ignore chain the service builds: a row already on the key is left alone.
    createQueryBuilder: jest.fn(() => {
      let values: Partial<ChatState> & Pick<ChatState, 'sessionId' | 'chatId'>;
      const qb = {
        insert: () => qb,
        values: (v: typeof values) => ((values = v), qb),
        orIgnore: () => qb,
        execute: () => {
          const k = KEY(values.sessionId, values.chatId);
          if (!rows.has(k)) rows.set(k, { muteEndTime: null, archived: false, pinned: false, ...values } as ChatState);
          return Promise.resolve(undefined);
        },
      };
      return qb;
    }),
    delete: jest.fn(({ sessionId, chatId }: { sessionId: string; chatId?: string }) => {
      for (const [k, r] of rows)
        if (r.sessionId === sessionId && (chatId === undefined || r.chatId === chatId)) rows.delete(k);
      return Promise.resolve(undefined);
    }),
  };
  return repo;
}

const svcWith = (repo: ReturnType<typeof makeRepo>) =>
  new ChatStateStoreService(repo as unknown as Repository<ChatState>);

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('ChatStateStoreService', () => {
  const ENV = 'BAILEYS_CHAT_STATE_CACHE_MAX';
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  it('reloads the table into the cache on boot', async () => {
    const svc = svcWith(makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 123, archived: true, pinned: false }]));
    await svc.reload();
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 123, archived: true, pinned: false });
  });

  it('clearSession drops one session from the table and the cache, and leaves the others', async () => {
    const repo = makeRepo([
      { sessionId: 's', chatId: 'c', archived: true },
      { sessionId: 't', chatId: 'c', pinned: true },
    ]);
    const svc = svcWith(repo);
    await svc.reload();
    await svc.clearSession('s');
    expect([...repo.rows.values()].map(r => r.sessionId)).toEqual(['t']);
    expect(svc.get('s', 'c')).toBeUndefined();
    expect(svc.get('t', 'c')).toMatchObject({ muteEndTime: null, archived: false, pinned: true });
  });

  describe('reports when each state last changed', () => {
    it('reads the stamp from the row on reload, refresh and a read-through', async () => {
      const at = new Date(5000);
      const repo = makeRepo([{ sessionId: 's', chatId: 'c', pinned: true, updatedAt: at }]);
      const svc = svcWith(repo);
      await svc.reload();
      expect(svc.get('s', 'c')?.updatedAt).toBe(5000);
      await svc.refreshSession('s');
      expect(svc.get('s', 'c')?.updatedAt).toBe(5000);
      const cold = svcWith(repo);
      cold.get('s', 'c');
      await tick();
      expect(cold.get('s', 'c')?.updatedAt).toBe(5000);
    });

    it('stamps a change with the instant it persists, and keeps the stamp on a no-op', async () => {
      const repo = makeRepo([{ sessionId: 's', chatId: 'c', pinned: true, updatedAt: new Date(5000) }]);
      const svc = svcWith(repo);
      await svc.remember('s', 'c', { pinned: true, updatedAt: 1 });
      expect(svc.get('s', 'c')?.updatedAt).toBe(5000);
      await svc.remember('s', 'c', { archived: true });
      const stamp = svc.get('s', 'c')?.updatedAt;
      expect(stamp).toBeGreaterThan(5000);
      expect(repo.rows.get(KEY('s', 'c'))?.updatedAt.getTime()).toBe(stamp);
    });
  });

  it("lists the chat ids of one session's cached states", async () => {
    const svc = svcWith(
      makeRepo([
        { sessionId: 's', chatId: 'a', archived: true },
        { sessionId: 's', chatId: 'b', pinned: true },
        { sessionId: 't', chatId: 'c', pinned: true },
      ]),
    );
    await svc.reload();
    expect(svc.chatIds('s').sort()).toEqual(['a', 'b']);
    await svc.forget('s', ['a']);
    expect(svc.chatIds('s')).toEqual(['b']);
  });

  it('returns undefined for an unknown chat', () => {
    expect(svcWith(makeRepo()).get('s', 'nope')).toBeUndefined();
  });

  it('merges a partial patch: mute then archive both survive', async () => {
    const svc = svcWith(makeRepo());
    await svc.remember('s', 'c', { muteEndTime: 999 });
    await svc.remember('s', 'c', { archived: true });
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 999, archived: true, pinned: false });
  });

  it('skips a no-op identical write', async () => {
    const repo = makeRepo();
    const svc = svcWith(repo);
    await svc.remember('s', 'c', { archived: true });
    await svc.remember('s', 'c', { archived: true });
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently-used entry over the cap', async () => {
    process.env[ENV] = '2';
    const svc = svcWith(makeRepo());
    await svc.remember('s', 'a', { archived: true });
    await svc.remember('s', 'b', { archived: true });
    await svc.remember('s', 'c', { archived: true }); // evicts 'a'
    expect(svc.get('s', 'a')).toBeUndefined();
    expect(svc.get('s', 'b')).toBeDefined();
    expect(svc.get('s', 'c')).toBeDefined();
  });

  describe('keeps the most recently changed rows when a preload fills the cap', () => {
    const rows = (): Partial<ChatState>[] => [
      { sessionId: 's', chatId: 'old', pinned: true, updatedAt: new Date(1000) },
      { sessionId: 's', chatId: 'mid', pinned: true, updatedAt: new Date(2000) },
      { sessionId: 's', chatId: 'new', pinned: true, updatedAt: new Date(3000) },
    ];

    it.each([
      ['reload', (svc: ChatStateStoreService) => svc.reload()],
      ['refreshSession', (svc: ChatStateStoreService) => svc.refreshSession('s')],
    ])('evicts the oldest preloaded row first after %s', async (_name, load) => {
      process.env[ENV] = '2';
      const svc = svcWith(makeRepo(rows()));
      await load(svc);
      await svc.remember('s', 'fresh', { pinned: true });
      expect(svc.get('s', 'new')).toEqual(expect.objectContaining({ pinned: true }));
      expect(svc.get('s', 'mid')).toBeUndefined();
    });
  });

  it('preserves persisted siblings when a partial patch lands on a cache-missed chat', async () => {
    // A muted + archived chat whose row is persisted but NOT in the in-memory cache (evicted, or an
    // old row outside the newest-maxEntries reload window). A partial `chats.update` carrying only
    // `{ pinned }` must merge onto the persisted row, not DEFAULT_STATE, or it silently wipes the mute.
    const repo = makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 999, archived: true, pinned: false }]);
    const svc = svcWith(repo); // no reload(): the row is on disk but absent from the cache
    await svc.remember('s', 'c', { pinned: true });
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 999, archived: true, pinned: true });
    expect(repo.rows.get(KEY('s', 'c'))).toMatchObject({ muteEndTime: 999, archived: true, pinned: true });
  });

  it('writes only the patched column when the read-through for a cache-missed chat fails', async () => {
    const repo = makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 999, archived: true, pinned: false }]);
    repo.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const svc = svcWith(repo);
    await svc.remember('s', 'c', { pinned: true });
    expect(repo.rows.get(KEY('s', 'c'))).toMatchObject({ muteEndTime: 999, archived: true, pinned: true });
    // Nothing guessed is cached: the next read warms from the table.
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 999, archived: true, pinned: true });
  });

  it('does not churn a row when a cache-missed patch matches the persisted state', async () => {
    const repo = makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 999, archived: true, pinned: false }]);
    const svc = svcWith(repo);
    await svc.remember('s', 'c', { archived: true }); // already true on disk -> no write
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 999, archived: true, pinned: false });
  });

  it('warms a cache miss from the table so the next read hits', async () => {
    const svc = svcWith(makeRepo([{ sessionId: 's', chatId: 'c', muteEndTime: 5, archived: false, pinned: true }]));
    // No reload: the cache is empty, so the first read misses and schedules a background lookup.
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: 5, archived: false, pinned: true });
  });

  it('does not query again for a chat the table has no row for', async () => {
    const repo = makeRepo();
    const svc = svcWith(repo);
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('reads through again once a chat known to have no row gets one and is evicted', async () => {
    process.env[ENV] = '1';
    const svc = svcWith(makeRepo());
    svc.get('s', 'c');
    await tick(); // 'c' is now known to have no row
    await svc.remember('s', 'c', { archived: true });
    await svc.remember('s', 'd', { pinned: true }); // cap 1: evicts 'c' from the cache
    expect(svc.get('s', 'c')).toBeUndefined();
    await tick();
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: null, archived: true, pinned: false });
  });

  describe('refreshSession (a start: another node may have written the rows since)', () => {
    it('serves one session from the table on the very next read, cached or known absent', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: 'muted', muteEndTime: -1 },
        { sessionId: 's', chatId: 'gone', pinned: true },
        { sessionId: 't', chatId: 'c', pinned: true },
      ]);
      const svc = svcWith(repo);
      await svc.reload();
      svc.get('s', 'new');
      await tick(); // 'new' is now known to have no row
      // Written by the node that held the session meanwhile.
      await repo.upsert({ sessionId: 's', chatId: 'muted', muteEndTime: null } as ChatState);
      await repo.upsert({ sessionId: 's', chatId: 'new', archived: true } as ChatState);
      await repo.delete({ sessionId: 's', chatId: 'gone' });
      await repo.upsert({ sessionId: 't', chatId: 'c', pinned: false } as ChatState);
      await svc.refreshSession('s');
      expect(svc.get('s', 'muted')).toEqual(expect.objectContaining({ muteEndTime: null }));
      expect(svc.get('s', 'new')).toEqual(expect.objectContaining({ archived: true }));
      expect(svc.get('s', 'gone')).toBeUndefined();
      expect(svc.get('t', 'c')).toEqual(expect.objectContaining({ pinned: true })); // another session is untouched
    });

    it('keeps the cache when the table cannot be read, and reads the absent chats through again', async () => {
      const repo = makeRepo([{ sessionId: 's', chatId: 'c', archived: true }]);
      const svc = svcWith(repo);
      await svc.reload();
      svc.get('s', 'new');
      await tick();
      repo.find.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await expect(svc.refreshSession('s')).resolves.toBeUndefined();
      expect(svc.get('s', 'c')).toEqual(expect.objectContaining({ archived: true }));
      await repo.upsert({ sessionId: 's', chatId: 'new', pinned: true } as ChatState);
      svc.get('s', 'new');
      await tick();
      expect(svc.get('s', 'new')).toEqual(expect.objectContaining({ pinned: true }));
    });
  });

  describe('a session whose rows all fit in the cache answers a miss without a query', () => {
    const seeded = () =>
      makeRepo([
        { sessionId: 's', chatId: 'a', archived: true },
        { sessionId: 's', chatId: 'b', pinned: true },
      ]);

    it('after refreshSession, an unknown chat reads undefined and costs no query', async () => {
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      expect(svc.get('s', 'unknown')).toBeUndefined();
      await tick();
      expect(svc.get('s', 'unknown')).toBeUndefined();
      expect(svc.get('s', 'a')).toEqual(expect.objectContaining({ archived: true }));
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('a write on a complete session is persisted and read back', async () => {
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      await svc.remember('s', 'new', { archived: true });
      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(svc.get('s', 'new')).toEqual(expect.objectContaining({ archived: true }));
    });

    it('forget and clearSession keep it complete', async () => {
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      await svc.forget('s', ['a']);
      expect(svc.get('s', 'a')).toBeUndefined();
      await svc.clearSession('s');
      expect(svc.get('s', 'b')).toBeUndefined();
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('reads through again once one of its rows is evicted', async () => {
      process.env[ENV] = '2';
      const repo = makeRepo([{ sessionId: 's', chatId: 'a', archived: true }]);
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      await svc.remember('t', 'x', { pinned: true });
      await svc.remember('t', 'y', { pinned: true }); // cap 2: evicts s/a
      repo.findOne.mockClear();
      expect(svc.get('s', 'a')).toBeUndefined();
      await tick();
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(svc.get('s', 'a')).toEqual(expect.objectContaining({ archived: true }));
    });

    it('is not complete when the preload reached the cap', async () => {
      process.env[ENV] = '2';
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      svc.get('s', 'unknown');
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('is not complete when the refresh read fails', async () => {
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      repo.find.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await svc.refreshSession('s');
      svc.get('s', 'unknown');
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('is not complete when a write overlapped the refresh read', async () => {
      const repo = seeded();
      let release!: () => void;
      repo.upsert.mockImplementationOnce(
        (v: ChatState) =>
          new Promise(resolve => {
            release = () => {
              repo.rows.set(KEY(v.sessionId, v.chatId), { ...v });
              resolve(undefined);
            };
          }),
      );
      const svc = svcWith(repo);
      const pending = svc.remember('s', 'late', { pinned: true });
      await tick(); // the write is indexed and waiting on its upsert
      await svc.refreshSession('s'); // the row is not in the table yet, so the refresh drops it
      release();
      await pending;
      expect(svc.get('s', 'late')).toBeUndefined();
      await tick();
      expect(svc.get('s', 'late')).toEqual(expect.objectContaining({ pinned: true }));
    });

    it('a write whose read-through failed leaves the session incomplete, so the row is read back', async () => {
      const repo = seeded();
      const svc = svcWith(repo);
      await svc.refreshSession('s');
      repo.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      // 'c' is not cached, so the write reads through first; that read fails and nothing is indexed.
      await svc.remember('s', 'c', { pinned: true });
      expect(svc.get('s', 'c')).toBeUndefined();
      await tick();
      expect(svc.get('s', 'c')).toEqual(expect.objectContaining({ pinned: true }));
    });

    it('reload marks every session of an untruncated preload complete, and none of a truncated one', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: 'a', archived: true },
        { sessionId: 't', chatId: 'b', pinned: true },
      ]);
      const svc = svcWith(repo);
      await svc.reload();
      svc.get('s', 'unknown');
      svc.get('t', 'unknown');
      expect(repo.findOne).not.toHaveBeenCalled();

      process.env[ENV] = '2';
      const capped = svcWith(repo);
      await capped.reload();
      capped.get('s', 'unknown');
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });
  });

  it('forget drops the named chats of one session from the table and the cache, after their pending writes', async () => {
    const repo = makeRepo([
      { sessionId: 's', chatId: 'd', pinned: true },
      { sessionId: 't', chatId: 'c', pinned: true },
    ]);
    const svc = svcWith(repo);
    await svc.reload();
    const pending = svc.remember('s', 'c', { archived: true }); // not awaited, as the session store calls it
    await svc.forget('s', ['c', 'd']);
    await pending;
    expect([...repo.rows.keys()]).toEqual([KEY('t', 'c')]);
    expect(svc.get('s', 'c')).toBeUndefined();
    expect(svc.get('s', 'd')).toBeUndefined();
    expect(svc.get('t', 'c')).toEqual(expect.objectContaining({ pinned: true }));
  });

  it('forget swallows a repo error', async () => {
    const repo = makeRepo();
    repo.delete.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await expect(svcWith(repo).forget('s', ['c'])).resolves.toBeUndefined();
  });

  it('keeps both of two concurrent patches for a chat that is not cached yet', async () => {
    const repo = makeRepo();
    const svc = svcWith(repo);
    await Promise.all([svc.remember('s', 'c', { archived: true }), svc.remember('s', 'c', { pinned: true })]);
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: null, archived: true, pinned: true });
    expect(repo.rows.get(KEY('s', 'c'))).toMatchObject({ archived: true, pinned: true });
  });

  it('does not let a concurrent no-op patch reset the cached state of an uncached chat', async () => {
    const repo = makeRepo();
    const svc = svcWith(repo);
    await Promise.all([svc.remember('s', 'c', { pinned: true }), svc.remember('s', 'c', { archived: false })]);
    expect(svc.get('s', 'c')).toMatchObject({ muteEndTime: null, archived: false, pinned: true });
  });

  describe('fold (a chat state filed under more than one spelling)', () => {
    const PHONE = '628111@s.whatsapp.net';
    const LID = '484848@lid';
    const NEW_END = Date.now() + 3_600_000;
    const OLD_END = Date.now() + 7_200_000;
    // The phone row is newer and only on disk; the older lid row is the one the cache holds.
    const coldNewerPhone = () =>
      makeRepo([
        { sessionId: 's', chatId: PHONE, muteEndTime: NEW_END, updatedAt: new Date(2000) },
        { sessionId: 's', chatId: LID, muteEndTime: OLD_END, updatedAt: new Date(1000) },
      ]);
    const warm = async (svc: ChatStateStoreService, chatId: string) => {
      svc.get('s', chatId);
      await tick();
    };

    it('merges onto the newest row read from the table, not the one the cache holds', async () => {
      const repo = coldNewerPhone();
      const svc = svcWith(repo);
      await warm(svc, LID);
      await svc.fold('s', PHONE, [LID], { archived: true });
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ muteEndTime: NEW_END, archived: true });
      expect(svc.get('s', PHONE)).toMatchObject({ muteEndTime: NEW_END, archived: true });
    });

    it('keeps a field only the older row observed, so a pin and a mute on split rows both survive', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: PHONE, muteEndTime: NEW_END, observed: 'muteEndTime', updatedAt: new Date(2000) },
        { sessionId: 's', chatId: LID, pinned: true, observed: 'pinned', updatedAt: new Date(1000) },
      ]);
      const svc = svcWith(repo);
      await svc.fold('s', PHONE, [LID], { muteEndTime: -1 });
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
      // The archive neither row saw stays unobserved, so a twin found later can still supply it.
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({
        muteEndTime: -1,
        pinned: true,
        archived: false,
        observed: 'muteEndTime,pinned',
      });
    });

    it('lets a newer unpin on a row that observed it outweigh an older pin, on a read and a fold', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: PHONE, pinned: false, observed: 'pinned', updatedAt: new Date(2000) },
        { sessionId: 's', chatId: LID, pinned: true, updatedAt: new Date(1000) },
      ]);
      const svc = svcWith(repo);
      await svc.reload();
      expect(mergeTwinStates([svc.get('s', PHONE)!, svc.get('s', LID)!])).toMatchObject({ pinned: false });
      await svc.fold('s', PHONE, [LID], { muteEndTime: -1 });
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ pinned: false, muteEndTime: -1 });
    });

    it.each([
      [1000, 2000],
      [2000, 1000],
    ])(
      'keeps a pin, an archive and a mute split across two rows written before rows kept what they observed (lid at %i, phone at %i)',
      async (lidAt, phoneAt) => {
        const repo = makeRepo([
          { sessionId: 's', chatId: LID, pinned: true, archived: true, observed: null, updatedAt: new Date(lidAt) },
          { sessionId: 's', chatId: PHONE, muteEndTime: -1, observed: null, updatedAt: new Date(phoneAt) },
        ]);
        const svc = svcWith(repo);
        await svc.reload();
        const kept = { pinned: true, archived: true, muteEndTime: -1 };
        expect(mergeTwinStates([svc.get('s', PHONE)!, svc.get('s', LID)!])).toMatchObject(kept);
        await svc.fold('s', PHONE, [LID], { muteEndTime: -1 });
        expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
        expect(repo.rows.get(KEY('s', PHONE))).toMatchObject(kept);
      },
    );

    it('records a clear written onto a row from before rows kept what they observed, so an older pin stays cleared', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: LID, pinned: true, observed: null, updatedAt: new Date(1000) },
        { sessionId: 's', chatId: PHONE, muteEndTime: -1, observed: null, updatedAt: new Date(2000) },
      ]);
      const svc = svcWith(repo);
      await svc.reload();
      await svc.remember('s', PHONE, { pinned: false });
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ muteEndTime: -1, observed: 'muteEndTime,pinned' });
      await svc.reload();
      expect(mergeTwinStates([svc.get('s', PHONE)!, svc.get('s', LID)!])).toMatchObject({
        pinned: false,
        muteEndTime: -1,
      });
    });

    it('keeps what a newer twin observed when folding onto a row from before rows kept it', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: PHONE, muteEndTime: -1, observed: null, updatedAt: new Date(1000) },
        { sessionId: 's', chatId: LID, pinned: false, observed: 'pinned', updatedAt: new Date(2000) },
        { sessionId: 's', chatId: 'older@lid', pinned: true, observed: null, updatedAt: new Date(500) },
      ]);
      const svc = svcWith(repo);
      await svc.fold('s', PHONE, [LID], { archived: true });
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ observed: 'muteEndTime,archived,pinned' });
      await svc.reload();
      expect(mergeTwinStates([svc.get('s', PHONE)!, svc.get('s', 'older@lid')!])).toMatchObject({ pinned: false });
    });

    it('writes a lone unpin for a chat with no row, so it can outweigh a pin on a twin row', async () => {
      const repo = makeRepo();
      const svc = svcWith(repo);
      await svc.remember('s', LID, { pinned: false });
      expect(repo.rows.get(KEY('s', LID))).toMatchObject({ pinned: false, observed: 'pinned' });
      await svc.remember('s', LID, { pinned: false });
      expect(repo.upsert).toHaveBeenCalledTimes(1);
    });

    it('writes no row for a patch that may not create one and only restates defaults', async () => {
      const repo = makeRepo([{ sessionId: 's', chatId: 'archived', archived: true, observed: 'archived' }]);
      const svc = svcWith(repo);
      await svc.remember('s', PHONE, { archived: false }, false);
      await svc.fold('s', PHONE, [LID], { archived: false, pinned: false }, false);
      expect(repo.findOne).toHaveBeenCalledTimes(2); // the phone key once, then known absent; the lid twin
      await svc.remember('s', 'archived', { archived: false }, false);
      expect([...repo.rows.keys()]).toEqual([KEY('s', 'archived')]);
      expect(repo.rows.get(KEY('s', 'archived'))).toMatchObject({ archived: false });
    });

    it('records what a patch carried on a row created after a failed read, so an unpin outweighs an older pin', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: LID, pinned: true, observed: 'pinned', updatedAt: new Date(1000) },
      ]);
      const svc = svcWith(repo);
      repo.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await svc.remember('s', PHONE, { pinned: false });
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ pinned: false, observed: 'pinned' });
      await svc.reload();
      expect(mergeTwinStates([svc.get('s', PHONE)!, svc.get('s', LID)!])).toMatchObject({ pinned: false });
    });

    it('adds no row after a failed read for a patch that may not create one', async () => {
      const repo = makeRepo();
      const svc = svcWith(repo);
      repo.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await svc.remember('s', PHONE, { archived: false }, false);
      expect(repo.rows.size).toBe(0);
    });

    it('carries a newer twin row onto the key and drops the twin', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: PHONE, pinned: false, updatedAt: new Date(1000) },
        { sessionId: 's', chatId: LID, pinned: true, muteEndTime: -1, updatedAt: new Date(2000) },
      ]);
      const svc = svcWith(repo);
      await svc.fold('s', PHONE, [LID], { archived: true });
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ pinned: true, muteEndTime: -1, archived: true });
    });

    it('applies only the patch and keeps the twin when a row cannot be read', async () => {
      const repo = coldNewerPhone();
      const svc = svcWith(repo);
      repo.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await svc.fold('s', PHONE, [LID], { archived: true });
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ muteEndTime: NEW_END, archived: true });
      expect(repo.rows.get(KEY('s', LID))).toMatchObject({ muteEndTime: OLD_END });
    });

    it('keeps the twin when the merged row cannot be written', async () => {
      const repo = makeRepo([{ sessionId: 's', chatId: LID, pinned: true, updatedAt: new Date(1000) }]);
      const svc = svcWith(repo);
      repo.upsert.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await svc.fold('s', PHONE, [LID], { archived: true });
      expect(repo.rows.get(KEY('s', LID))).toMatchObject({ pinned: true });
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('folds a twin that already equals the row on the key without writing it again', async () => {
      const repo = makeRepo([
        { sessionId: 's', chatId: PHONE, pinned: true, updatedAt: new Date(2000) },
        { sessionId: 's', chatId: LID, pinned: true, updatedAt: new Date(1000) },
      ]);
      const svc = svcWith(repo);
      await svc.fold('s', PHONE, [LID], { pinned: true });
      expect(repo.upsert).not.toHaveBeenCalled();
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
    });

    it('neither a listing nor a later change brings back the older mute of a cached lid row', async () => {
      const repo = coldNewerPhone();
      const svc = svcWith(repo);
      await warm(svc, LID);
      const store = new BaileysSessionStore(undefined, 's', svc);
      store.addLidMappings([{ lid: LID, pn: PHONE }]);
      store.upsertChats([{ id: PHONE, name: 'Alice' }]);
      store.listChats();
      await tick();
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(repo.delete).not.toHaveBeenCalled();
      expect(store.listChats()[0].muteExpiration).toBe(NEW_END); // the phone row has warmed by now
      store.upsertChats([{ id: PHONE, archived: true }]);
      await tick();
      await tick();
      expect([...repo.rows.keys()]).toEqual([KEY('s', PHONE)]);
      expect(repo.rows.get(KEY('s', PHONE))).toMatchObject({ muteEndTime: NEW_END, archived: true });
      expect(store.listChats()[0]).toMatchObject({ muteExpiration: NEW_END, archived: true });
    });
  });

  it('swallows a repo error on reload and remember (table may not exist yet)', async () => {
    const fail = () => Promise.reject(new Error('no such table'));
    const values = jest.fn();
    const qb = { insert: () => qb, values: (v: unknown) => (values(v), qb), orIgnore: () => qb, execute: fail };
    const repo = { find: jest.fn(fail), findOne: jest.fn(fail), update: jest.fn(fail), createQueryBuilder: () => qb };
    const svc = new ChatStateStoreService(repo as unknown as Repository<ChatState>);
    await expect(svc.reload()).resolves.toBeUndefined();
    await expect(svc.remember('s', 'c', { archived: true })).resolves.toBeUndefined();
    // The read failed too, so there is no merge base: only the patched column is written, and no
    // guessed state is cached (the chat reads from its live record until the table answers).
    const [written] = values.mock.calls[0] as [Record<string, unknown>];
    expect(written).toMatchObject({ sessionId: 's', chatId: 'c', archived: true, observed: 'archived' });
    expect(written).not.toHaveProperty('muteEndTime');
    expect(written).not.toHaveProperty('pinned');
    expect(svc.get('s', 'c')).toBeUndefined();
  });
});
