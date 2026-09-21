import { Repository } from 'typeorm';
import { LidMappingStoreService } from './lid-mapping-store.service';
import { LidMapping } from './lid-mapping.entity';

/** Minimal in-memory stand-in for the TypeORM repo: just the find()/findOne()/upsert() the store uses. */
function makeFakeRepo(seed: Partial<LidMapping>[] = []) {
  const rows: LidMapping[] = seed.map(r => ({ lid: '', phone: null, sessionId: null, updatedAt: new Date(0), ...r }));
  return {
    rows,
    find: jest.fn().mockImplementation(() => Promise.resolve(rows.map(r => ({ ...r })))),
    findOne: jest
      .fn()
      .mockImplementation((options: { where: { lid: string } }) =>
        Promise.resolve(rows.find(r => r.lid === options.where.lid) ?? null),
      ),
    upsert: jest.fn().mockImplementation((values: Partial<LidMapping>) => {
      const i = rows.findIndex(r => r.lid === values.lid);
      if (i >= 0) rows[i] = { ...rows[i], ...values };
      else rows.push(values as LidMapping);
      return Promise.resolve({});
    }),
  };
}

async function newStore(repo: ReturnType<typeof makeFakeRepo>): Promise<LidMappingStoreService> {
  const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
  await store.onModuleInit();
  return store;
}

describe('LidMappingStoreService', () => {
  it('loads the persisted table into the cache on boot (forward + reverse)', async () => {
    const store = await newStore(makeFakeRepo([{ lid: '111', phone: '628999' }]));
    expect(store.getCached('111')).toBe('628999');
    expect(store.lidsForPhone('628999')).toEqual(['111']);
  });

  it('returns undefined for an unseen lid', async () => {
    const store = await newStore(makeFakeRepo());
    expect(store.getCached('nope')).toBeUndefined();
    expect(store.lidsForPhone('628999')).toEqual([]);
  });

  it('writes a learned mapping through to cache and persistence', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    await store.remember('222', '628888', 'sess-1');
    expect(store.getCached('222')).toBe('628888');
    expect(store.lidsForPhone('628888')).toEqual(['222']);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ lid: '222', phone: '628888', sessionId: 'sess-1' }),
      ['lid'],
    );
  });

  it('caches a negative result (lid known-but-unresolved)', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    await store.remember('333', null);
    expect(store.getCached('333')).toBeNull();
    expect(store.lidsForPhone('anything')).toEqual([]);
    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ lid: '333', phone: null }), ['lid']);
  });

  it('is last-write-wins and reindexes the reverse map on a phone change', async () => {
    const store = await newStore(makeFakeRepo([{ lid: '111', phone: '628999' }]));
    await store.remember('111', '628000');
    expect(store.getCached('111')).toBe('628000');
    expect(store.lidsForPhone('628999')).toEqual([]); // stale reverse entry dropped
    expect(store.lidsForPhone('628000')).toEqual(['111']);
  });

  it('skips a redundant write when the mapping is unchanged', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.upsert.mockClear();
    await store.remember('111', '628999');
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('survives a restart: a fresh store over the same table reloads the mapping', async () => {
    const repo = makeFakeRepo();
    const first = await newStore(repo);
    await first.remember('111', '628999', 'sess-1');

    const second = await newStore(repo); // simulate process restart against the persisted rows
    expect(second.getCached('111')).toBe('628999');
    expect(second.lidsForPhone('628999')).toEqual(['111']);
  });

  it('does not throw when the table is unavailable on boot', async () => {
    const repo = makeFakeRepo();
    repo.find.mockRejectedValueOnce(new Error('no such table: lid_mappings'));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await expect(store.onModuleInit()).resolves.toBeUndefined();
    expect(store.getCached('111')).toBeUndefined();
  });
});

describe('LidMappingStoreService — LRU cap', () => {
  const prevMax = process.env.LID_MAPPING_CACHE_MAX;
  afterEach(() => {
    if (prevMax === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = prevMax;
  });

  it('evicts the least-recently-used forward entry when the cap is exceeded (no unbounded growth)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002');
    await store.remember('lid-c', '620003');
    // Touch lid-a so it is the most-recently-used; lid-b becomes the LRU candidate.
    expect(store.getCached('lid-a')).toBe('620001');
    // Inserting a fourth evicts the LRU (lid-b, not lid-a).
    await store.remember('lid-d', '620004');

    expect(store.getCached('lid-b')).toBeUndefined(); // evicted
    expect(store.getCached('lid-a')).toBe('620001'); // touched, survived
    expect(store.getCached('lid-c')).toBe('620003');
    expect(store.getCached('lid-d')).toBe('620004');
  });

  it('reconciles the reverse map on eviction (no orphan phoneToLids entries)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620001');
    expect(store.lidsForPhone('620001')).toEqual(expect.arrayContaining(['lid-a', 'lid-b']));
    // A third entry evicts lid-a (the LRU); the reverse set must drop it.
    await store.remember('lid-c', '620002');
    expect(store.lidsForPhone('620001')).toEqual(['lid-b']);
    expect(store.lidsForPhone('620002')).toEqual(['lid-c']);
  });

  it('LID_MAPPING_CACHE_MAX=0 disables the cap (legacy unbounded behaviour)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    for (let i = 0; i < 10; i++) {
      await store.remember(`lid-${i}`, `62000${i}`);
    }
    // Nothing evicted — all 10 stay resident.
    for (let i = 0; i < 10; i++) {
      expect(store.getCached(`lid-${i}`)).toBe(`62000${i}`);
    }
  });

  it('falls back to the default cap on a non-numeric env value', () => {
    process.env.LID_MAPPING_CACHE_MAX = 'not-a-number';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    // The constructor must not throw, and must apply the default (5000) rather than NaN/0.
    expect((store as unknown as { maxCachedLids: number }).maxCachedLids).toBe(5000);
  });

  it('treats a blank env value as unset, not as 0 (unbounded)', () => {
    process.env.LID_MAPPING_CACHE_MAX = '';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    expect((store as unknown as { maxCachedLids: number }).maxCachedLids).toBe(5000);
  });
});

describe('LidMappingStoreService — deterministic preload + repository fallback', () => {
  const prevMax = process.env.LID_MAPPING_CACHE_MAX;
  afterEach(() => {
    if (prevMax === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = prevMax;
  });

  it('preloads deterministically: last-write-first, capped at the LRU limit', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    expect(repo.find).toHaveBeenCalledWith({ order: { updatedAt: 'DESC' }, take: 3 });
  });

  it('preloads without a take when the cap is disabled (0)', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    expect(repo.find).toHaveBeenCalledWith({ order: { updatedAt: 'DESC' }, take: undefined });
  });

  it('warms an evicted-but-persisted mapping from the repository on a cache miss', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a (cap 1); its row stays persisted

    expect(store.getCached('lid-a')).toBeUndefined(); // the miss itself stays a miss (sync contract)
    await new Promise(resolve => setImmediate(resolve)); // let the fallback lookup settle

    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: 'lid-a' } });
    expect(store.getCached('lid-a')).toBe('620001'); // the NEXT lookup hits the warmed cache
  });

  it('runs at most one fallback query per lid while a lookup is in flight', async () => {
    const repo = makeFakeRepo([{ lid: 'lid-a', phone: '620001' }]);
    // No onModuleInit: the cache starts empty even though the row is persisted.
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    let resolveFind: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(
      () =>
        new Promise<LidMapping | null>(resolve => {
          resolveFind = resolve;
        }),
    );

    expect(store.getCached('lid-a')).toBeUndefined();
    expect(store.getCached('lid-a')).toBeUndefined();
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    resolveFind({ lid: 'lid-a', phone: '620001' } as LidMapping);
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-a')).toBe('620001');
  });

  it('stops re-querying the table for a lid it has no row for', async () => {
    // The callers are hot: a webhook filter resolves the event's actor AND each of its own rule
    // values on every dispatch. pendingLookups collapses the lookups that overlap a query still in
    // flight, which within one dispatch is all of them, so an unmapped lid used to cost one query
    // per dispatch rather than one per webhook.
    const repo = makeFakeRepo(); // empty table: every lookup misses
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-absent')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      expect(store.getCached('lid-absent')).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('a recorded absence never shadows a mapping learned afterwards, even once it is evicted', async () => {
    // The forward map answers a learned mapping directly, so the absence only matters after the
    // entry is evicted: a stale one would block the warm-back and make the row unresolvable for
    // the life of the process, although it is still in the table.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    expect(store.getCached('lid-late')).toBeUndefined(); // records the absence
    await new Promise(resolve => setImmediate(resolve));

    await store.remember('lid-late', '620009');
    await store.remember('lid-other', '620010'); // evicts lid-late (cap 1); its row stays persisted

    expect(store.getCached('lid-late')).toBeUndefined(); // the miss itself stays a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-late')).toBe('620009'); // warmed back rather than blocked
  });

  it('records no absence for a lid learned while its table read was in flight', async () => {
    // The read and the write race on every busy session: a filter looks the lid up, and the next
    // message from that person teaches it. The read was issued first, so it answers "no row" about a
    // row that now exists. Recording that as an absence poisons the lid: the forward entry hides it
    // until the LRU evicts, and from then on the warm-back is blocked and the persisted row is
    // unreachable until something teaches the same lid again.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    let answer: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-raced')).toBeUndefined(); // the query is now in flight
    await store.remember('lid-raced', '620001'); // learned and persisted inside that window
    answer(null); // the query had already run, so it answers about the table as it was
    await new Promise(resolve => setImmediate(resolve));

    await store.remember('lid-other', '620002'); // cap 1: evicts lid-raced, the row stays persisted
    expect(store.getCached('lid-raced')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-raced')).toBe('620001'); // warmed back rather than blocked
  });

  it('records no absence for a lid whose own write has not reached the table yet', async () => {
    // remember() indexes synchronously and writes afterwards, and its callers fire it without
    // awaiting (one per mapping in a history batch). A lookup issued inside that window reads a
    // table that does not carry the row yet, and the LRU can evict the forward entry in the same
    // window, so "did this process learn it" answers no. An absence recorded there shadows a row
    // that then commits.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    let commit: () => void = () => undefined;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          commit = () => {
            repo.rows.push(values as LidMapping);
            resolve({});
          };
        }),
    );
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const writing = store.remember('lid-writing', '620001'); // indexed; its upsert is held open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-writing from the forward map

    expect(store.getCached('lid-writing')).toBeUndefined(); // issues the query, which finds no row
    await new Promise(resolve => setImmediate(resolve));

    commit(); // the write lands: the row is in the table from here on
    await writing;

    expect(store.getCached('lid-writing')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-writing')).toBe('620001'); // warmed back rather than blocked
  });

  it('records no absence at all when the cap is disabled', async () => {
    // LID_MAPPING_CACHE_MAX=0 is documented as the legacy unbounded cache. An absence set that grows
    // on every lookup would be a new unbounded map the operator never asked for, and unlike the
    // forward map it grows on caller-supplied ids rather than on mappings the account really has.
    process.env.LID_MAPPING_CACHE_MAX = '0';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    for (let i = 0; i < 3; i++) {
      expect(store.getCached('lid-absent')).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(3); // re-queried, as the legacy behaviour did
  });

  it('bounds the recorded absences by the same cap as the forward map', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    for (const lid of ['a', 'b', 'c']) {
      expect(store.getCached(lid)).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(repo.findOne).toHaveBeenCalledTimes(3);

    // 'a' is the oldest absence and was dropped when 'c' was recorded, so it asks again; 'c' does not.
    expect(store.getCached('a')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(4);
    expect(store.getCached('c')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(4);
  });

  it('forgets every recorded absence when the table is reloaded', async () => {
    // An import or a restore rewrites the table underneath the process, so every answer it recorded
    // about that table is a stale one. Re-indexing the reloaded rows is not enough on its own: the
    // preload takes only the newest `cap` rows, so an imported mapping past that cap is never
    // indexed, and its recorded absence would go on blocking the warm-back that would find it.
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    // The real query is `order: { updatedAt: 'DESC' }, take: cap`; the shared fake ignores both.
    repo.find.mockImplementation((options: { take?: number }) =>
      Promise.resolve(
        [...repo.rows]
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, options?.take ?? repo.rows.length)
          .map(r => ({ ...r })),
      ),
    );
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-imported')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1);

    repo.rows.push({ lid: 'lid-imported', phone: '620003', sessionId: null, updatedAt: new Date(1000) });
    repo.rows.push({ lid: 'lid-newer', phone: '620004', sessionId: null, updatedAt: new Date(2000) });
    await store.reload(); // cap 1: only lid-newer is preloaded, so lid-imported is never re-indexed

    expect(store.getCached('lid-imported')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-imported')).toBe('620003'); // asked the table again rather than blocked
  });

  it('swallows a fallback read error (table unavailable) — the miss stays a miss and never throws', async () => {
    const repo = makeFakeRepo();
    repo.findOne.mockRejectedValueOnce(new Error('no such table: lid_mappings'));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-a')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    // A read error is not recorded as an absence: the table said nothing, so there is nothing to
    // remember, and the next lookup must ask again rather than treat the outage as "no such row".
    expect(store.getCached('lid-a')).toBeUndefined();
  });
});
