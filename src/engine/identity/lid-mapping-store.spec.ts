import { randomUUID } from 'crypto';
import { DataSource, FindOperator, In, Repository } from 'typeorm';
import { LidMappingStoreService } from './lid-mapping-store.service';
import { LidMapping } from './lid-mapping.entity';
import { Session } from '../../modules/session/entities/session.entity';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';

/** A where-clause value: a literal, or a TypeORM `In([...])` FindOperator. */
type Cond = string | FindOperator<unknown>;

function matches(value: string | null, cond: Cond | undefined): boolean {
  if (cond === undefined) return true;
  if (cond instanceof FindOperator) {
    if (cond.type !== 'in') throw new Error(`fake repo does not support ${cond.type}`);
    return (cond.value as unknown[]).includes(value);
  }
  return value === cond;
}

/** Minimal in-memory stand-in for the TypeORM repo: just the find()/findOne()/upsert() the store uses. */
function makeFakeRepo(seed: Partial<LidMapping>[] = []) {
  const rows: LidMapping[] = seed.map(r => ({
    lid: '',
    phone: null,
    sessionId: null,
    isReported: true,
    updatedAt: new Date(0),
    ...r,
  }));
  return {
    rows,
    find: jest
      .fn()
      .mockImplementation((options?: { where?: { lid?: Cond; phone?: Cond } }) =>
        Promise.resolve(
          rows
            .filter(r => matches(r.lid, options?.where?.lid) && matches(r.phone, options?.where?.phone))
            .map(r => ({ ...r })),
        ),
      ),
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
    createQueryBuilder: () => {
      let values: Partial<LidMapping>;
      const builder = {
        insert: () => builder,
        values: (input: Partial<LidMapping>) => {
          values = input;
          return builder;
        },
        getQueryAndParameters: () => ['', [values]],
      };
      return builder;
    },
    query: jest.fn().mockImplementation((_sql: string, [values]: [Partial<LidMapping>]) => {
      const row = rows.find(r => r.lid === values.lid);
      if (!row) rows.push(values as LidMapping);
      else if (row.phone !== values.phone) Object.assign(row, values);
      else row.isReported = true;
      return Promise.resolve([]);
    }),
    update: jest.fn().mockImplementation((where: Partial<LidMapping>, values: Partial<LidMapping>) => {
      let affected = 0;
      for (const row of rows) {
        if (Object.entries(where).some(([key, value]) => row[key as keyof LidMapping] !== value)) continue;
        for (const [key, value] of Object.entries(values))
          if (typeof value !== 'function') Object.assign(row, { [key]: value });
        affected++;
      }
      return Promise.resolve({ affected });
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

  it('a phone is last-write-wins and reindexes the reverse map on a phone change', async () => {
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

  it('times the warning about failed writes on a monotonic clock of its own', async () => {
    jest.useFakeTimers();
    try {
      const repo = makeFakeRepo();
      const store = await newStore(repo);
      const warn = jest
        .spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn')
        .mockImplementation(() => {});
      repo.upsert.mockRejectedValue(new Error('connection lost'));

      await store.remember('111', '628111', 's1');
      jest.setSystemTime(Date.now() - 3_600_000); // the wall clock alone is set back an hour
      jest.advanceTimersByTime(60_000);
      await store.remember('111', '628111', 's1');

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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

  it('finds a lid by phone from the table once it has left the cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a; its row stays persisted
    expect(store.lidsForPhone('620001')).toEqual([]);
    expect(await store.findLidsForPhone('620001')).toEqual(['lid-a']);
    expect(await store.findLidsForPhone('620002')).toEqual(['lid-b']);
    expect(store.getCached('lid-b')).toBe('620002'); // the table read did not evict the resident entry
  });

  it('skips a table row this process has since re-mapped, and falls back to the cache on a read error', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost')); // the re-map has not reached the table
    await store.remember('111', '628000');
    expect(await store.findLidsForPhone('628999')).toEqual([]);

    repo.find.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findLidsForPhone('628000')).toEqual(['111']);
  });

  it('finds a phone by lid from the table on a cache miss, without indexing the row', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002'); // evicts lid-a; its row stays persisted
    expect(await store.findPhoneForLid('lid-a')).toBe('620001');
    expect(await store.findPhoneForLid('lid-b')).toBe('620002');
    expect(await store.findPhoneForLid('lid-x')).toBeNull();
    expect(store.lidsForPhone('620002')).toEqual(['lid-b']); // the table read did not evict it

    repo.findOne.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findPhoneForLid('lid-a')).toBeNull();
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

  it('drops a phone key from the reverse map once its last lid is evicted or re-mapped', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);
    await store.onModuleInit();
    const phoneToLids = (store as unknown as { phoneToLids: Map<string, Set<string>> }).phoneToLids;

    await store.remember('lid-a', '620001');
    await store.remember('lid-b', '620002');
    await store.remember('lid-c', '620003'); // evicts lid-a, the only lid under 620001
    expect(phoneToLids.has('620001')).toBe(false);

    await store.remember('lid-c', '620004'); // re-maps lid-c away from 620003
    expect(phoneToLids.has('620003')).toBe(false);
    expect([...phoneToLids.keys()].sort()).toEqual(['620002', '620004']);
  });

  it('drops who reported a phone along with the evicted entry', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const store = await newStore(makeFakeRepo());
    const seenBy = (store as unknown as { seenBy: Map<string, Set<string>> }).seenBy;

    await store.remember('lid-a', '620001', 's1');
    await store.remember('lid-b', '620002', 's1');
    await store.remember('lid-c', '620003', 's1'); // evicts lid-a

    expect([...seenBy.keys()].sort()).toEqual(['lid-b', 'lid-c']);
  });

  it('writes a changed phone on its next report after the write failed, once the old one left the cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    await store.remember('lid-a', '620001', 's1');
    await store.remember('lid-b', '620002', 's1'); // evicts lid-a
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('lid-a', '620009', 's1'); // the contact's new number; the table keeps the old one

    await store.remember('lid-a', '620009', 's1');

    expect(repo.rows.find(r => r.lid === 'lid-a')?.phone).toBe('620009');
  });

  it('forgets a failed write along with the evicted entry', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-a', phone: '620001' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('lid-a', '620002'); // fails; the table keeps 620001
    await store.remember('lid-b', '620003'); // evicts lid-a
    store.getCached('lid-a'); // warms lid-a back from its row
    for (let i = 0; i < 20 && store.getCached('lid-a') === undefined; i++) await new Promise(r => setImmediate(r));
    expect(store.getCached('lid-a')).toBe('620001');

    repo.rows[0].phone = '620009'; // another node re-maps it
    expect(await store.findPhoneForLid('lid-a@lid')).toBe('620009');
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

  // The query answers newest first; indexed in that order the newest row sat at the LRU's eviction
  // end, so the first mapping learned after boot evicted the most recently written one.
  it('keeps the newest preloaded row when a new mapping evicts', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '2';
    const repo = makeFakeRepo();
    repo.find.mockResolvedValueOnce([
      { lid: 'lid-new', phone: '620002', sessionId: null, updatedAt: new Date(2000) },
      { lid: 'lid-old', phone: '620001', sessionId: null, updatedAt: new Date(1000) },
    ]);
    const store = await newStore(repo);

    await store.remember('lid-fresh', '620003');

    expect(store.getCached('lid-new')).toBe('620002');
    expect(store.getCached('lid-fresh')).toBe('620003');
    expect(store.getCached('lid-old')).toBeUndefined();
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

  /** Hold the next upsert open until the returned commit() applies it, as the fake repo would. */
  function holdNextUpsert(repo: ReturnType<typeof makeFakeRepo>): () => void {
    const apply = repo.upsert.getMockImplementation() as (values: Partial<LidMapping>) => Promise<object>;
    let commit: () => void = () => undefined;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) => new Promise(resolve => (commit = () => resolve(apply(values)))),
    );
    return () => commit();
  }

  // The same window from the other side: the table still holds the OLD phone, so the read returns a
  // row, and indexing it would leave the stale phone served as a cache hit after the write commits.
  it('does not index a table row read while a newer write for that lid is in flight', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-moved', phone: '620001' }]);
    const commit = holdNextUpsert(repo);
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const writing = store.remember('lid-moved', '620009'); // indexed; its upsert is held open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-moved from the forward map

    expect(store.getCached('lid-moved')).toBeUndefined(); // the query reads the uncommitted table
    await new Promise(resolve => setImmediate(resolve));
    commit();
    await writing;

    expect(store.getCached('lid-moved')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-moved')).toBe('620009');
  });

  it('does not index a table row read before a write that settled while the read was in flight', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo([{ lid: 'lid-moved', phone: '620001' }]);
    let answer: (row: LidMapping | null) => void = () => undefined;
    repo.findOne.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-moved')).toBeUndefined(); // the query is now in flight
    const before = { ...repo.rows[0] };
    await store.remember('lid-moved', '620009'); // re-mapped and committed inside that window
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-moved from the forward map
    answer(before); // the query had already run, so it answers with the old row
    await new Promise(resolve => setImmediate(resolve));

    expect(store.getCached('lid-moved')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-moved')).toBe('620009');
  });

  it('keeps a lid unsettled until the last of two overlapping writes commits', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    const repo = makeFakeRepo();
    const commitFirst = holdNextUpsert(repo);
    const commitSecond = holdNextUpsert(repo);
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    const first = store.remember('lid-busy', '620001');
    const second = store.remember('lid-busy', '620009');
    commitFirst();
    await first; // the second write is still open
    await store.remember('lid-other', '620002'); // cap 1: evicts lid-busy from the forward map

    expect(store.getCached('lid-busy')).toBeUndefined(); // reads the first write's row
    await new Promise(resolve => setImmediate(resolve));
    commitSecond();
    await second;

    expect(store.getCached('lid-busy')).not.toBe('620001');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-busy')).toBe('620009');
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

    repo.rows.push({
      lid: 'lid-imported',
      phone: '620003',
      sessionId: null,
      isReported: true,
      updatedAt: new Date(1000),
    });
    repo.rows.push({ lid: 'lid-newer', phone: '620004', sessionId: null, isReported: true, updatedAt: new Date(2000) });
    await store.reload(); // cap 1: only lid-newer is preloaded, so lid-imported is never re-indexed

    expect(store.getCached('lid-imported')).toBeUndefined(); // the read itself is still a miss
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-imported')).toBe('620003'); // asked the table again rather than blocked
  });

  it('forgets every recorded absence even when the reload cannot read the table', async () => {
    const repo = makeFakeRepo();
    const store = new LidMappingStoreService(repo as unknown as Repository<LidMapping>);

    expect(store.getCached('lid-restored')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(repo.findOne).toHaveBeenCalledTimes(1); // 'lid-restored' is now known to have no row

    // A restore brings the row back, then the post-commit reload fails.
    repo.rows.push({ lid: 'lid-restored', phone: '620005', sessionId: null, isReported: true, updatedAt: new Date() });
    repo.find.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await expect(store.reload()).resolves.toBeUndefined();

    expect(store.getCached('lid-restored')).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(store.getCached('lid-restored')).toBe('620005');
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

describe('LidMappingStoreService — deterministic persisted lookups (authorization path)', () => {
  it('does not authorize a resident mapping removed from the table', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.rows.splice(0, 1); // the preload cached 111; the table no longer holds it
    expect(store.getCached('111')).toBe('628999');
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: null });
    expect(await store.findLidsForPhone('628999')).toEqual([]);
    expect(await store.lidsForPhonesPersisted(['628999'])).toEqual({ 628999: [] });
    const scope = new ChatScopeService(store);
    expect(await scope.allows({ allowedChats: ['628999@c.us'] }, '111@lid')).toBe(false);
    expect(await scope.allows({ allowedChats: ['111@lid'] }, '628999@c.us')).toBe(false);
    expect(await scope.allows({ allowedChats: ['111@lid'] }, '111@lid')).toBe(true);
    expect(await scope.allows({ allowedChats: ['628999@c.us'] }, '628999@c.us')).toBe(true);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: '111' } });
  });

  it('findPhoneForLid answers from the cache when the table read fails', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.findOne.mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');
  });

  it('findPhoneForLid reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      // Preload keeps one row; the other is persisted but not cached, so the table must answer.
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628888' },
      ]);
      const store = await newStore(repo);
      expect(await store.findPhoneForLid('111@lid')).toBe('628999');
      expect(await store.findPhoneForLid('222@lid')).toBe('628888');
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('a stale cached negative never shadows a mapping the table has', async () => {
    const repo = makeFakeRepo([{ lid: '222', phone: null }]);
    const store = await newStore(repo); // this node cached a negative
    expect(store.getCached('222')).toBeNull();
    repo.rows[0].phone = '628888'; // another node has since mapped it in the table
    expect(await store.findPhoneForLid('222@lid')).toBe('628888');
    expect(await store.phonesForLidsPersisted(['222'])).toEqual({ 222: '628888' });
    expect(await store.findLidsForPhone('628888')).toEqual(['222']);
    expect(await store.lidsForPhonesPersisted(['628888'])).toEqual({ 628888: ['222'] });
  });

  it('a cached mapping another node has re-mapped answers the table row, not the cache', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    await store.remember('333', '628111'); // this node cached 333 -> 628111
    repo.rows[0].phone = '628222'; // another node has since re-mapped it in the shared table
    expect(store.getCached('333')).toBe('628111');
    expect(await store.findPhoneForLid('333@lid')).toBe('628222');
  });

  it('findPhoneForLid returns null for a lid with no persisted row', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    expect(await store.findPhoneForLid('999@lid')).toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { lid: '999' } });
  });

  it('findPhoneForLid fails soft (null) when the table read throws', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    repo.findOne.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.findPhoneForLid('555@lid')).toBeNull();
  });

  it('findLidsForPhone reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      // Preload keeps one of the two lids; the reverse map then holds only that one, so the second
      // can only come from the table.
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628999' },
      ]);
      const store = await newStore(repo);
      expect((await store.findLidsForPhone('628999')).sort()).toEqual(['111', '222']);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('findLidsForPhone reads all current persisted rows', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '222', phone: '628999' },
    ]);
    const store = await newStore(repo);
    expect((await store.findLidsForPhone('628999')).sort()).toEqual(['111', '222']);
  });

  it('phonesForLidsPersisted reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628888' },
      ]);
      const store = await newStore(repo);
      expect(await store.phonesForLidsPersisted(['111', '222'])).toEqual({ 111: '628999', 222: '628888' });
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('lidsForPhonesPersisted reads the table for a lid evicted from the LRU cache', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const repo = makeFakeRepo([
        { lid: '111', phone: '628999' },
        { lid: '222', phone: '628999' },
      ]);
      const store = await newStore(repo);
      expect((await store.lidsForPhonesPersisted(['628999']))['628999'].sort()).toEqual(['111', '222']);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('batched lookups query only the requested keys', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '222', phone: '628888' },
    ]);
    const store = await newStore(repo);
    repo.find.mockClear();
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628999' });
    expect(repo.find).toHaveBeenCalledWith({ where: { lid: In(['111']) } });
    expect(await store.lidsForPhonesPersisted(['628888'])).toEqual({ 628888: ['222'] });
    expect(repo.find).toHaveBeenCalledWith({ where: { phone: In(['628888']) } });
  });

  // An allowlist of N lids that the mirror has not seen used to cost N single-row reads ahead of the one
  // batched query, because the mirror was read through getCached, which warms every miss.
  it('phonesForLidsPersisted answers a batch of lids the mirror lacks with one query and no per-lid reads', async () => {
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const lids = Array.from({ length: 300 }, (_, i) => `9${i}`);
      const repo = makeFakeRepo(lids.map(lid => ({ lid, phone: `62${lid}` })));
      const store = await newStore(repo); // the cap keeps one of the 300 resident
      repo.find.mockClear();
      repo.findOne.mockClear();

      const answer = await store.phonesForLidsPersisted(lids);

      expect(Object.keys(answer)).toHaveLength(300);
      expect(answer['9299']).toBe('629299');
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.find).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.LID_MAPPING_CACHE_MAX;
    }
  });

  it('batched lookups handle an empty input, a null-phone row, and a read error', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628999' },
      { lid: '333', phone: null },
    ]);
    const store = await newStore(repo);
    expect(await store.phonesForLidsPersisted([])).toEqual({});
    expect(await store.lidsForPhonesPersisted([])).toEqual({});
    // The null-phone row is skipped rather than indexed under a null key.
    expect((await store.lidsForPhonesPersisted(['628999']))['628999']).toEqual(['111']);
    // A read error falls back to the cache, which the preload filled.
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628999' });
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.lidsForPhonesPersisted(['628999'])).toEqual({ 628999: ['111'] });
  });

  it('drops a cached lid that another node has re-mapped to a different phone', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.rows[0].phone = '628000'; // another node re-mapped 111; this node's cache still says 628999
    expect(store.lidsForPhone('628999')).toEqual(['111']);
    expect(await store.findLidsForPhone('628999')).toEqual([]);
    expect(await store.lidsForPhonesPersisted(['628999'])).toEqual({ 628999: [] });
    // Removing the row also removes its alias from successful reads.
    await store.remember('222', '628999');
    repo.rows.splice(
      repo.rows.findIndex(r => r.lid === '222'),
      1,
    );
    expect(await store.findLidsForPhone('628999')).toEqual([]);
  });

  it('answers the row of a lid another node has re-mapped, in every lookup', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628111' }]);
    const store = await newStore(repo);
    repo.rows[0].phone = '628222'; // another node re-mapped 111; this node's cache still says 628111

    expect(await store.findPhoneForLid('111@lid')).toBe('628222');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628222' });
    expect(await store.findLidsForPhone('628222')).toEqual(['111']);
    expect(await store.lidsForPhonesPersisted(['628222', '628111'])).toEqual({ 628222: ['111'], 628111: [] });
  });

  it('answers no phone for a lid whose phone write has not reached the table, in every lookup', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '444', phone: '628444' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    const none = async (lid: string, phones: string[]) => {
      expect(await store.findPhoneForLid(`${lid}@lid`)).toBeNull();
      expect(await store.phonesForLidsPersisted([lid])).toEqual({ [lid]: null });
      for (const phone of phones) expect(await store.findLidsForPhone(phone)).toEqual([]);
      expect(await store.lidsForPhonesPersisted(phones)).toEqual(Object.fromEntries(phones.map(p => [p, []])));
    };

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628222'); // a re-map: the table still names the old phone
    await none('111', ['628111', '628222']);
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('333', '628333'); // a first write: the table has no row
    await none('333', ['628333']);

    let land!: () => void;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          land = () => {
            repo.rows[1] = { ...repo.rows[1], ...values };
            resolve({});
          };
        }),
    );
    const writing = store.remember('444', '628555', 'sess-1');
    await none('444', ['628444', '628555']); // still in flight
    land();
    await writing;
    await store.remember('111', '628222', 'sess-1'); // the failed re-map lands on its next report

    expect(await store.findPhoneForLid('444@lid')).toBe('628555');
    expect(await store.phonesForLidsPersisted(['111', '444'])).toEqual({ 111: '628222', 444: '628555' });
    expect(await store.lidsForPhonesPersisted(['628222', '628111'])).toEqual({ 628222: ['111'], 628111: [] });
  });

  it('authorizes a first report only once its write reaches the table', async () => {
    const repo = makeFakeRepo();
    const store = await newStore(repo);
    let land!: () => void;
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) =>
        new Promise(resolve => {
          land = () => {
            repo.rows.push(values as LidMapping);
            resolve({});
          };
        }),
    );
    const writing = store.remember('111', '628111', 'sess-1');

    expect(await store.findPhoneForLid('111@lid')).toBeNull();
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: null });
    expect(await store.findLidsForPhone('628111')).toEqual([]);
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: [] });
    land();
    await writing;
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628111' });
    expect(await store.findLidsForPhone('628111')).toEqual(['111']);
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('keeps answering a phone the table holds when only another session failed to take it', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628111' }]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', 'sess-2');

    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628111' });
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('settles two overlapping writes for a lid by the phone the cache holds', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '222', phone: '628222' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    /** Holds the next upsert until settle(true) applies it to row i, or settle(false) fails it. */
    const held = (i: number) => {
      let settle!: (ok: boolean) => void;
      repo.upsert.mockImplementationOnce(
        (values: Partial<LidMapping>) =>
          new Promise((resolve, reject) => {
            settle = ok => {
              if (!ok) return reject(new Error('connection lost'));
              repo.rows[i] = { ...repo.rows[i], ...values };
              resolve({});
            };
          }),
      );
      return (ok: boolean) => settle(ok);
    };

    const older = held(0);
    const first = store.remember('111', '628000', 'sess-1');
    await store.remember('111', '628001', 'sess-1'); // the newer one lands first
    older(false);
    await first;
    repo.rows[0].phone = '628999'; // another node re-maps it: nothing of this node's is pending
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');

    const older2 = held(1);
    const second = store.remember('222', '628000', 'sess-1');
    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628001', 'sess-1'); // the newer one fails
    older2(true);
    await second;
    expect(await store.findPhoneForLid('222@lid')).toBeNull(); // the cached 628001 is still not stored
  });

  it('answers the table again once a failed write has landed, or the table was reloaded', async () => {
    const repo = makeFakeRepo([
      { lid: '111', phone: '628111' },
      { lid: '222', phone: '628222' },
    ]);
    const store = await newStore(repo);
    jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628000', 'sess-1');
    await store.remember('111', '628000', 'sess-1'); // lands
    repo.rows[0].phone = '628999'; // another node re-maps it
    expect(await store.findPhoneForLid('111@lid')).toBe('628999');

    repo.upsert.mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628000', 'sess-1');
    await store.reload();
    repo.rows[1].phone = '628999';
    expect(await store.findPhoneForLid('222@lid')).toBe('628999');
  });

  it('findLidsForPhone falls back to the cache when the table read throws', async () => {
    const repo = makeFakeRepo([{ lid: '111', phone: '628999' }]);
    const store = await newStore(repo);
    repo.find.mockRejectedValueOnce(new Error('no such table'));
    expect(await store.findLidsForPhone('628999')).toEqual(['111']);
  });
});

describe('LidMappingStoreService: a negative result on the shared table', () => {
  // Linked sessions in `sessions` (each carries its account's phone); `gone` names one that was deleted.
  const [s1, s2, s3, s9] = ['1', '2', '3', '9'].map(n => `0000000${n}-0000-4000-8000-000000000000`);
  const gone = '0000000d-0000-4000-8000-000000000000';
  let ds: DataSource;
  let repo: Repository<LidMapping>;
  let store: LidMappingStoreService;
  let warn: jest.SpyInstance;
  let clock = 0;
  const row = (lid: string) => repo.findOne({ where: { lid } });
  /** Moves the store's clock on, past or short of the interval between two warnings about failed writes. */
  const later = (ms: number) => (clock += ms);
  const settleWarm = async () => {
    const deadline = performance.now() + 5000;
    while ((store as unknown as { pendingLookups: Set<string> }).pendingLookups.size) {
      if (performance.now() >= deadline) throw new Error('mapping lookup did not finish');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };

  /** Holds the next call of a repository method until `release` is called; `reached` settles on entry. */
  function hold(method: 'upsert' | 'update') {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const reached = new Promise<void>(resolve => (entered = resolve));
    const real = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(repo, method).mockImplementationOnce((async (...args: unknown[]) => {
      entered();
      await gate;
      return real(...args);
    }) as never);
    return { release, reached };
  }

  // SQLite in memory; on PostgreSQL (DATABASE_TYPE=postgres, the test-postgres job) a schema of its own, on
  // the search_path as the app sets it, since the statements differ by dialect.
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let schema = '';
  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };

  beforeEach(async () => {
    const entities = [LidMapping, Session];
    if (pg) {
      schema = `lid_store_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
        : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true },
    ).initialize();
    await ds.getRepository(Session).insert([s1, s2, s3, s9].map(id => ({ id, name: id, phone: `6290000000${id[7]}` })));
    repo = ds.getRepository(LidMapping);
    store = new LidMappingStoreService(repo);
    clock = 0;
    (store as unknown as { now: () => number }).now = () => clock;
    // A statement that fails is only logged, which would let a case pass on a write that never ran.
    warn = jest.spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn');
    await store.onModuleInit();
  });

  afterEach(async () => {
    await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records a negative for a lid with no row', async () => {
    await store.remember('333', null, s1);

    expect(await row('333')).toMatchObject({ phone: null, sessionId: s1 });
    expect(await store.findPhoneForLid('333@lid')).toBeNull();
  });

  it('seeds an unknown phone without optimistically indexing a cached answer', async () => {
    const pending = store.rememberIfUnknown('111', '628111', s1);
    expect(store.getCached('111')).toBeUndefined();
    await expect(pending).resolves.toBe(true);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
    expect(await store.findLidsForPhone('628111')).toEqual([]);
    const restarted = new LidMappingStoreService(repo);
    await restarted.onModuleInit();
    expect(restarted.getCached('111')).toBe('628111');
    expect(await restarted.findPhoneForLid('111@lid')).toBeNull();
  });

  it.each(['preload', 'warm', 'revoked'] as const)(
    'does not count a display-only owner as an actual reporter after %s',
    async mode => {
      if (mode === 'revoked') {
        await store.remember('111', '628111', s1);
        await store.rememberIfUnknown('111', '628222', s3);
      } else await store.rememberIfUnknown('111', '628111', s1);
      if (mode === 'preload') await store.reload();
      else if (mode === 'warm') {
        store.getCached('111');
        await settleWarm();
      }
      await store.remember('111', '628111', s2);
      await repo.update({ lid: '111' }, { updatedAt: new Date('2020-01-01T00:00:00Z') });
      await store.remember('111', '628111', s1);
      expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
      expect((await row('111'))!.updatedAt.getTime()).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
    },
  );

  it('applies a successful actual negative even when a cached lookup completes before its acknowledgment', async () => {
    await store.remember('111', '628111', s1);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const update = repo.update.bind(repo);
    jest.spyOn(repo, 'update').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      entered();
      await gate;
      return result;
    });
    const negative = store.remember('111', null, s1);
    await reached;
    await store.rememberIfUnknown('111', '628111', s2);
    release();
    await expect(negative).resolves.toBe(true);
    expect(store.resolveLid('111@lid')).toBeNull();
    await settleWarm();
    jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('connection lost'));
    jest.spyOn(repo, 'find').mockRejectedValue(new Error('connection lost'));
    await noAlias(store);
    warn.mockClear();
  });

  it.each(['628222', null])('does not seed over a stored %s or change its mirror or owner', async phone => {
    await store.remember('111', phone, s2);
    await store.reload();
    await expect(store.rememberIfUnknown('111', '628111', s1)).resolves.toBe(true);
    expect(await row('111')).toMatchObject({ phone, sessionId: s2 });
    expect(store.getCached('111')).toBe(phone);
    expect(store.lidsForPhone('628111')).toEqual([]);
    if (phone) {
      await store.remember('111', phone, s1);
      expect(await row('111')).toMatchObject({ phone, sessionId: s1 });
    }
  });

  it('keeps a phone stored by a peer while a cached seed waits to execute', async () => {
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    const builder = repo.createQueryBuilder().insert().values({});
    const execute = builder.execute.bind(builder);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    jest.spyOn(builder, 'execute').mockImplementation(async () => {
      await gate;
      return execute();
    });
    const create = jest.spyOn(repo, 'createQueryBuilder').mockReturnValueOnce(builder as never);
    const pending = store.rememberIfUnknown('111', '628111', s1);
    await peer.remember('111', '628222', s2);
    release();
    await expect(pending).resolves.toBe(true);
    create.mockRestore();
    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s2 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('does not clear a failed actual replacement when a cached seed is ignored', async () => {
    await store.remember('111', '628111', s1);
    const fail = jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628222', s1)).resolves.toBe(false);
    fail.mockRestore();
    warn.mockClear();
    await expect(store.rememberIfUnknown('111', '628111', s1)).resolves.toBe(true);
    expect(store.getCached('111')).toBe('628222');
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('retries every failed cached seed and limits only warnings', async () => {
    const builder = repo.createQueryBuilder().insert().values({});
    const execute = jest.spyOn(builder, 'execute').mockRejectedValue(new Error('connection lost'));
    const create = jest.spyOn(repo, 'createQueryBuilder').mockReturnValue(builder as never);
    for (let i = 0; i < 1000; i++) await expect(store.rememberIfUnknown('111', '628111', s1)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    later(60_000);
    await expect(store.rememberIfUnknown('111', '628111', s1)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect((warn.mock.calls as Array<[string]>)[1][0]).toContain('999 more failed');
    create.mockRestore();
    execute.mockRestore();
    warn.mockClear();
    await expect(store.rememberIfUnknown('111', '628111', s1)).resolves.toBe(true);
    expect(await row('111')).toMatchObject({ phone: '628111' });
  });

  it('does not keep an old read absence after a cached seed commits', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const read = jest.spyOn(repo, 'findOne').mockImplementationOnce(async () => {
      await gate;
      return null;
    });
    expect(store.getCached('111')).toBeUndefined();
    await store.rememberIfUnknown('111', '628111', s1);
    release();
    await settleWarm();
    expect(store.getCached('111')).toBeUndefined();
    await settleWarm();
    expect(store.getCached('111')).toBe('628111');
    read.mockRestore();
  });

  it('warms a cached seed after remembering that the table had no row', async () => {
    expect(store.getCached('111')).toBeUndefined();
    await settleWarm();
    await store.rememberIfUnknown('111', '628111', s1);
    expect(store.getCached('111')).toBeUndefined();
    await settleWarm();
    expect(store.getCached('111')).toBe('628111');
  });

  it('does not remember a missing row read while a cached seed waits to execute', async () => {
    const builder = repo.createQueryBuilder().insert().values({});
    const execute = builder.execute.bind(builder);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    jest.spyOn(builder, 'execute').mockImplementation(async () => {
      await gate;
      return execute();
    });
    const create = jest.spyOn(repo, 'createQueryBuilder').mockReturnValueOnce(builder as never);
    const pending = store.rememberIfUnknown('111', '628111', s1);
    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => (releaseRead = resolve));
    const read = jest.spyOn(repo, 'findOne').mockImplementationOnce(async () => {
      await readGate;
      return null;
    });
    expect(store.getCached('111')).toBeUndefined();
    release();
    await pending;
    releaseRead();
    await settleWarm();
    create.mockRestore();
    read.mockRestore();
    expect(store.getCached('111')).toBeUndefined();
    await settleWarm();
    expect(store.getCached('111')).toBe('628111');
  });

  it('keeps the actual failed-phone veto when a cached seed cannot fit beside it', async () => {
    const previous = process.env.LID_MAPPING_CACHE_MAX;
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      const limited = new LidMappingStoreService(repo);
      await limited.onModuleInit();
      await limited.remember('111', '628111', s1);
      const failure = jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
      const limitedWarn = jest.spyOn((limited as unknown as { logger: { warn: () => void } }).logger, 'warn');
      await expect(limited.remember('111', '628222', s1)).resolves.toBe(false);
      failure.mockRestore();
      limitedWarn.mockRestore();
      await limited.rememberIfUnknown('222', '628333', s2);
      await limited.rememberIfUnknown('111', '628111', s2);
      expect(limited.getCached('111')).toBe('628222');
      expect(await limited.findPhoneForLid('111@lid')).toBeNull();
      expect(await limited.findLidsForPhone('628111')).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = previous;
    }
  });

  const noAlias = async (node: LidMappingStoreService, lid = '111', phone = '628111') => {
    expect(await node.findPhoneForLid(`${lid}@lid`)).toBeNull();
    expect(await node.findLidsForPhone(phone)).toEqual([]);
    expect(await node.phonesForLidsPersisted([lid])).toEqual({ [lid]: null });
    expect(await node.lidsForPhonesPersisted([phone])).toEqual({ [phone]: [] });
    const fence = new ChatScopeService(node);
    expect(await fence.allows({ allowedChats: [`${phone}@c.us`] }, `${lid}@lid`)).toBe(false);
    expect(await fence.allows({ allowedChats: [`${lid}@lid`] }, `${phone}@c.us`)).toBe(false);
    expect((await fence.scopeForFilter({ allowedChats: [`${phone}@c.us`] }))!.allowed.has(`${lid}@lid`)).toBe(false);
    expect((await fence.scopeForFilter({ allowedChats: [`${lid}@lid`] }))!.allowed.has(`${phone}@c.us`)).toBe(false);
    expect(await fence.candidatesFor(`${lid}@lid`)).not.toContain(`${phone}@c.us`);
    expect(await fence.candidatesFor(`${phone}@c.us`)).not.toContain(`${lid}@lid`);
    expect(await fence.allows({ allowedChats: [`${lid}@lid`] }, `${lid}@lid`)).toBe(true);
  };

  it('keeps a cached seed for display without authorizing aliases, including after restart and owner release', async () => {
    await store.rememberIfUnknown('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', isReported: false });
    await store.reload();
    expect(store.getCached('111')).toBe('628111');
    await noAlias(store);
    await store.releaseSession(s1);
    expect(await row('111')).toMatchObject({ sessionId: null, isReported: false });
    const restarted = new LidMappingStoreService(repo);
    await restarted.onModuleInit();
    expect(restarted.getCached('111')).toBe('628111');
    expect(restarted.resolveLid('111@lid')).toBeNull();
    expect(restarted.lidsForPhone('628111')).toEqual([]);
    await noAlias(restarted);
  });

  it('upgrades an actual report of the same cached seed instead of skipping its write', async () => {
    await store.rememberIfUnknown('111', '628111', s1);
    await store.reload();
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', isReported: true });
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
  });

  it('revokes a conflicting lookup without replacing the stored phone, then accepts an actual same-phone report', async () => {
    await store.remember('111', '628111', s1);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.rememberIfUnknown('111', '628222', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: false });
    await noAlias(store);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
  });

  it('preserves a loaded unchanged negative owner and timestamp while checking the shared row', async () => {
    await store.remember('111', null, s1);
    await store.reload();
    const original = await row('111');
    const writes = jest.spyOn(repo, 'update');
    for (let i = 0; i < 10; i++) await store.remember('111', null, s2);
    expect(writes).toHaveBeenCalledTimes(10);
    expect(await row('111')).toEqual(original);
  });

  it('rechecks a loaded negative after a peer mapped the lid and its owner logged out', async () => {
    await store.remember('111', null, s1);
    await store.reload();
    expect(store.getCached('111')).toBeNull();
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628111', s2);
    await ds.getRepository(Session).update(s2, { phone: null });
    await store.remember('111', null, s1);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s1 });
    await noAlias(store);
    await noAlias(peer);
  });

  it('takes ownership when a local conflicting lookup made the previous report untrusted', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await store.rememberIfUnknown('111', '628222', s3);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2, isReported: false });
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
  });

  it('checks repeated actual reports without changing an unchanged owner or timestamp', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    const original = await row('111');
    await ds.query('CREATE TABLE mapping_updates (n integer NOT NULL)');
    await ds.query('INSERT INTO mapping_updates VALUES (0)');
    if (pg) {
      await ds.query(
        `CREATE FUNCTION count_mapping_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE mapping_updates SET n = n + 1; RETURN NEW; END $$`,
      );
      await ds.query(
        'CREATE TRIGGER mapping_update AFTER UPDATE ON lid_mappings FOR EACH ROW EXECUTE FUNCTION count_mapping_update()',
      );
    } else {
      await ds.query(
        'CREATE TRIGGER mapping_update AFTER UPDATE ON lid_mappings BEGIN UPDATE mapping_updates SET n = n + 1; END',
      );
    }
    const query = jest.spyOn(repo, 'query');
    const upsert = jest.spyOn(repo, 'upsert');
    for (let i = 0; i < 1000; i++) await expect(store.remember('111', '628111', i % 2 ? s1 : s2)).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1000);
    expect(upsert).not.toHaveBeenCalled();
    expect(await row('111')).toEqual(original);
    expect(await ds.query('SELECT n FROM mapping_updates')).toEqual([{ n: 0 }]);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.rememberIfUnknown('111', '628222', s3);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toEqual(original);
    expect(await ds.query('SELECT n FROM mapping_updates')).toEqual([{ n: 2 }]);
  });

  it('stores the latest actual phone report even when this node counted the same phone before a peer changed it', async () => {
    await store.remember('111', '628111', s1);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628222', s2);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
  });

  it('preserves a same-phone peer owner after a repeated report fails and recovers', async () => {
    await store.remember('111', '628111', s1);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628111', s2);
    await repo.update({ lid: '111' }, { updatedAt: new Date('2020-01-01T00:00:00Z') });
    const original = await row('111');
    jest.spyOn(repo, 'query').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await expect(store.remember('111', '628111', s1)).resolves.toBe(true);
    expect(await row('111')).toEqual(original);
    await store.remember('111', null, s1);
    expect(await row('111')).toEqual(original);
  });

  it('counts a reporter only after its first phone write succeeds', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628111', s2);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
  });

  it.each(['628111', '628222'])(
    'keeps a newer successful report counted when an older %s write fails late',
    async oldPhone => {
      let reject!: (err: Error) => void;
      jest.spyOn(repo, 'upsert').mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      const older = store.remember('111', oldPhone, s1);
      await store.remember('111', '628111', s1);
      const peer = new LidMappingStoreService(repo);
      await peer.onModuleInit();
      await peer.remember('111', '628111', s2);
      await repo.update({ lid: '111' }, { updatedAt: new Date('2020-01-01T00:00:00Z') });
      const original = await row('111');
      reject(new Error('connection lost'));
      await expect(older).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      await expect(store.remember('111', '628111', s1)).resolves.toBe(true);
      expect(await row('111')).toEqual(original);
    },
  );

  it('does not count an old successful phone report after the cache changes away and back', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const upsert = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
      const result = await upsert(...args);
      entered();
      await gate;
      return result;
    });
    const older = store.remember('111', '628111', s1);
    await reached;
    await store.remember('111', '628222', s2);
    await store.remember('111', '628111', s2);
    release();
    await expect(older).resolves.toBe(true);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1, isReported: true });
  });

  it('counts overlapping successful reports of one phone without changing the later owner', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const upsert = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
      const result = await upsert(...args);
      entered();
      await gate;
      return result;
    });
    const older = store.remember('111', '628111', s1);
    await reached;
    await store.remember('111', '628111', s2);
    await repo.update({ lid: '111' }, { updatedAt: new Date('2020-01-01T00:00:00Z') });
    const original = await row('111');
    release();
    await expect(older).resolves.toBe(true);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toEqual(original);
  });

  it.each([
    ['positive', true],
    ['negative', true],
    ['positive', false],
    ['negative', false],
  ] as const)(
    'keeps a newer phone failure veto after an older %s acknowledgment (changed phone: %s)',
    async (kind, changed) => {
      if (kind === 'negative') await store.remember('111', '628111', s1);
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => {
        entered = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const method = kind === 'positive' ? 'upsert' : 'update';
      const execute = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
      jest.spyOn(repo, method).mockImplementationOnce((async (...args: unknown[]) => {
        const result = await execute(...args);
        entered();
        await gate;
        return result;
      }) as never);
      const older = store.remember('111', kind === 'positive' ? '628111' : null, s1);
      await reached;
      if (changed) await store.remember('111', '628222', s2);
      if (kind === 'negative' && !changed)
        jest.spyOn(repo, 'query').mockRejectedValueOnce(new Error('connection lost'));
      else jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
      await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      if (!changed) {
        const peer = new LidMappingStoreService(repo);
        await peer.onModuleInit();
        await peer.remember('111', '628222', s2);
      }
      await noAlias(store, '111', '628111');
      await noAlias(store, '111', '628222');
      release();
      await expect(older).resolves.toBe(true);
      expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s2, isReported: true });
      await noAlias(store, '111', '628111');
      await noAlias(store, '111', '628222');
      await store.remember('111', '628111', s1);
      expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    },
  );

  it.each([true, false])(
    'does not install an old phone failure veto after a newer report succeeds (changed phone: %s)',
    async changed => {
      let reject!: (err: Error) => void;
      jest.spyOn(repo, 'upsert').mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      const older = store.remember('111', '628111', s1);
      if (changed) await store.remember('111', '628222', s2);
      await store.remember('111', '628111', s2);
      reject(new Error('connection lost'));
      await expect(older).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      const peer = new LidMappingStoreService(repo);
      await peer.onModuleInit();
      await peer.remember('111', '628222', s3);
      expect(await store.findPhoneForLid('111@lid')).toBe('628222');
      expect(await store.phonesForLidsPersisted(['111'])).toEqual({ 111: '628222' });
      expect(await store.findLidsForPhone('628222')).toEqual(['111']);
      expect(await store.lidsForPhonesPersisted(['628222'])).toEqual({ 628222: ['111'] });
      expect(await new ChatScopeService(store).allows({ allowedChats: ['628222@c.us'] }, '111@lid')).toBe(true);
    },
  );

  it('vetoes a failed conflict revocation locally and retries it without a hold', async () => {
    await store.remember('111', '628111', s1);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    const failed = jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(false);
    failed.mockRestore();
    expect(await row('111')).toMatchObject({ phone: '628111', isReported: true });
    await noAlias(store);
    expect(await peer.findPhoneForLid('111@lid')).toBe('628111');
    warn.mockClear();
    await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(true);
    await noAlias(peer);
    const restarted = new LidMappingStoreService(repo);
    await restarted.onModuleInit();
    await noAlias(restarted);
  });

  it('keeps a failed cached contradiction veto when an older actual report is acknowledged', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const upsert = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
      const result = await upsert(...args);
      entered();
      await gate;
      return result;
    });
    const older = store.remember('111', '628111', s1);
    await reached;
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    release();
    await expect(older).resolves.toBe(true);
    await noAlias(store);
    await store.remember('111', '628111', s1);
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
  });

  it.each([true, false])(
    'does not replay old actual trust after cached answers change away and back (revocation fails: %s)',
    async fails => {
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => {
        entered = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const upsert = repo.upsert.bind(repo);
      jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
        const result = await upsert(...args);
        entered();
        await gate;
        return result;
      });
      const older = store.remember('111', '628111', s1);
      await reached;
      if (fails) jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
      await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(!fails);
      expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
      warn.mockClear();
      await store.rememberIfUnknown('111', '628111', s2);
      release();
      await expect(older).resolves.toBe(true);
      await noAlias(store);
      jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('connection lost'));
      jest.spyOn(repo, 'find').mockRejectedValue(new Error('connection lost'));
      await noAlias(store);
      warn.mockClear();
      jest.restoreAllMocks();
      await store.remember('111', '628111', s1);
      expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    },
  );

  it('keeps an uncertain replacement veto when a newer actual negative also fails', async () => {
    await store.remember('111', '628111', s1);
    let reject!: (err: Error) => void;
    jest.spyOn(repo, 'upsert').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const replacing = store.remember('111', '628222', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', null, s1)).resolves.toBe(false);
    reject(new Error('connection lost'));
    await expect(replacing).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await noAlias(store, '111', '628111');
    await noAlias(store, '111', '628222');
  });

  it('keeps a pending replacement uncertain through two overlapping failed negatives', async () => {
    await store.remember('111', '628111', s1);
    let failPositive!: (err: Error) => void;
    let failNegative!: (err: Error) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    jest.spyOn(repo, 'upsert').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          failPositive = fail;
        }),
    );
    const positive = store.remember('111', '628222', s1);
    jest.spyOn(repo, 'update').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          failNegative = fail;
          entered();
        }),
    );
    const first = store.remember('111', null, s1);
    await reached;
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', null, s1)).resolves.toBe(false);
    failNegative(new Error('connection lost'));
    await expect(first).resolves.toBe(false);
    failPositive(new Error('connection lost'));
    await expect(positive).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await noAlias(store, '111', '628111');
    await noAlias(store, '111', '628222');
  });

  it('does not accept a cached old phone when the actual replacement write fails after its lookup', async () => {
    await store.remember('111', '628111', s1);
    let reject!: (err: Error) => void;
    jest.spyOn(repo, 'upsert').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const positive = store.remember('111', '628222', s1);
    await store.rememberIfUnknown('111', '628111', s2);
    reject(new Error('connection lost'));
    await expect(positive).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await noAlias(store, '111', '628111');
    await noAlias(store, '111', '628222');
  });

  it('accepts an actual retry that commits after a consistent cached lookup revokes the older stored phone', async () => {
    await store.remember('111', '628222', s1);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628111', s1)).resolves.toBe(false);
    warn.mockClear();
    const paused = hold('upsert');
    const actual = store.remember('111', '628111', s1);
    await paused.reached;
    await store.rememberIfUnknown('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628222', isReported: false });
    paused.release();
    await expect(actual).resolves.toBe(true);
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(store.resolveLid('111@lid')).toBe('628111');
  });

  it('does not restore a stale mirror when a peer report and cached revocation follow the actual SQL commit', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const upsert = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
      const result = await upsert(...args);
      entered();
      await gate;
      return result;
    });
    const actual = store.remember('111', '628111', s1);
    await reached;
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628222', s2);
    await store.rememberIfUnknown('111', '628111', s1);
    release();
    await expect(actual).resolves.toBe(true);
    await noAlias(store);
    jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('connection lost'));
    jest.spyOn(repo, 'find').mockRejectedValue(new Error('connection lost'));
    await noAlias(store);
    warn.mockClear();
  });

  it('does not restore trust from a row read that predates a newer cached revocation', async () => {
    await store.remember('111', '628222', s1);
    const paused = hold('upsert');
    const actual = store.remember('111', '628111', s1);
    await paused.reached;
    await store.rememberIfUnknown('111', '628111', s2);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const findOne = repo.findOne.bind(repo);
    jest.spyOn(repo, 'findOne').mockImplementationOnce(async (...args) => {
      const result = await findOne(...args);
      entered();
      await gate;
      return result;
    });
    paused.release();
    await reached;
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628222', s2);
    await store.rememberIfUnknown('111', '628111', s1);
    release();
    await expect(actual).resolves.toBe(true);
    await noAlias(store);
    jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('connection lost'));
    jest.spyOn(repo, 'find').mockRejectedValue(new Error('connection lost'));
    await noAlias(store);
    warn.mockClear();
  });

  it('keeps a newly reported phone trusted after an older cached revocation acknowledgment', async () => {
    await store.remember('111', '628111', s1);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const update = repo.update.bind(repo);
    jest.spyOn(repo, 'update').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      entered();
      await gate;
      return result;
    });
    const older = store.rememberIfUnknown('111', '628222', s2);
    await reached;
    await store.remember('111', '628111', s1);
    release();
    await expect(older).resolves.toBe(true);
    expect(store.resolveLid('111@lid')).toBe('628111');
    jest.spyOn(repo, 'findOne').mockRejectedValueOnce(new Error('connection lost'));
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
  });

  it('keeps a failed actual replacement veto when a concurrent same-phone cached lookup also fails', async () => {
    await store.remember('111', '628111', s1);
    let reject!: (err: Error) => void;
    jest.spyOn(repo, 'upsert').mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const actual = store.remember('111', '628222', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(false);
    reject(new Error('connection lost'));
    await expect(actual).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    await noAlias(store, '111', '628111');
    await noAlias(store, '111', '628222');
  });

  it.each([true, false])(
    'accepts a successful actual retry alongside a consistent cached lookup (lookup fails: %s)',
    async fails => {
      await store.remember('111', '628111', s1);
      jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
      await expect(store.remember('111', '628222', s1)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => {
        entered = resolve;
      });
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const upsert = repo.upsert.bind(repo);
      jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
        const result = await upsert(...args);
        entered();
        await gate;
        return result;
      });
      const actual = store.remember('111', '628222', s1);
      await reached;
      if (fails) {
        later(60_000);
        jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
      }
      await expect(store.rememberIfUnknown('111', '628222', s2)).resolves.toBe(!fails);
      expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
      warn.mockClear();
      release();
      await expect(actual).resolves.toBe(true);
      expect(store.resolveLid('111@lid')).toBe('628222');
      expect(await store.findPhoneForLid('111@lid')).toBe('628222');
      expect(await store.findLidsForPhone('628222')).toEqual(['111']);
      expect(await new ChatScopeService(store).allows({ allowedChats: ['628222@c.us'] }, '111@lid')).toBe(true);
    },
  );

  it.each(['negative', 'seed'] as const)('keeps a reloaded phone after an old %s write acknowledgment', async kind => {
    await store.remember('111', '628111', s1);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const update = repo.update.bind(repo);
    jest.spyOn(repo, 'update').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      entered();
      await gate;
      return result;
    });
    const older = kind === 'negative' ? store.remember('111', null, s1) : store.rememberIfUnknown('111', '628333', s2);
    await reached;
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628222', s2);
    await store.reload();
    release();
    await expect(older).resolves.toBe(true);
    expect(store.resolveLid('111@lid')).toBe('628222');
    expect(await store.findPhoneForLid('111@lid')).toBe('628222');
  });

  it.each(['628222', '628333'])(
    'tests the current phone atomically when a lookup waits and %s is reported',
    async phone => {
      await store.remember('111', '628111', s1);
      const peer = new LidMappingStoreService(repo);
      await peer.onModuleInit();
      const paused = hold('update');
      const lookup = store.rememberIfUnknown('111', '628222', s2);
      await paused.reached;
      await peer.remember('111', phone, s2);
      paused.release();
      await expect(lookup).resolves.toBe(true);
      expect(await row('111')).toMatchObject({ phone, isReported: phone === '628222' });
      await peer.remember('111', phone, s2);
      expect(await row('111')).toMatchObject({ phone, isReported: true });
    },
  );

  it('keeps cache-only alias refusal independent of host clock steps and restart', async () => {
    await store.rememberIfUnknown('111', '628111', s1);
    await store.reload();
    const hostClock = jest.spyOn(Date, 'now');
    try {
      for (const wall of [Date.parse('2020-01-01T00:00:00Z'), Date.parse('2099-01-01T00:00:00Z')]) {
        hostClock.mockReturnValue(wall);
        await noAlias(store);
        const restarted = new LidMappingStoreService(repo);
        await restarted.onModuleInit();
        await noAlias(restarted);
      }
    } finally {
      hostClock.mockRestore();
    }
  });

  it('refuses an unreported mirror fallback when its persisted row cannot be read', async () => {
    await store.rememberIfUnknown('111', '628111', s1);
    await store.reload();
    const one = jest.spyOn(repo, 'findOne').mockRejectedValue(new Error('connection lost'));
    const many = jest.spyOn(repo, 'find').mockRejectedValue(new Error('connection lost'));
    await noAlias(store);
    one.mockRestore();
    many.mockRestore();
    warn.mockClear();
  });

  it('refuses an unreported mirror when its stored row has been removed', async () => {
    await store.rememberIfUnknown('111', '628111', s1);
    await store.reload();
    await repo.delete({ lid: '111' });
    await noAlias(store);
    expect(store.getCached('111')).toBe('628111');
  });

  it('replaces a peer-revoked different phone when an actual phone is reported again', async () => {
    await store.remember('111', '628111', s1);
    const peer = new LidMappingStoreService(repo);
    await peer.onModuleInit();
    await peer.remember('111', '628222', s2);
    await peer.rememberIfUnknown('111', '628333', s2);
    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', isReported: true });
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
  });

  it('bounds origin metadata with the display mirror', async () => {
    const previous = process.env.LID_MAPPING_CACHE_MAX;
    process.env.LID_MAPPING_CACHE_MAX = '1';
    try {
      store = new LidMappingStoreService(repo);
      await store.onModuleInit();
      for (let i = 0; i < 20; i++) {
        await store.rememberIfUnknown(String(i), `628${i}`, s1);
        store.getCached(String(i));
        await settleWarm();
      }
      expect((store as unknown as { unreported: Set<string> }).unreported.size).toBe(1);
      expect((store as unknown as { unreported: Set<string> }).unreported.has('19')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = previous;
    }
  });

  it('leaves the phone another session stored, in the table and in the cache', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).toBe('628111');
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('clears the phone when the session that stored it answers no phone (#1058)', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', null, s1);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s1 });
    expect(store.lidsForPhone('628111')).toEqual([]);
    expect(store.getCached('111')).not.toBe('628111');
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('clears a phone that no session owns', async () => {
    await repo.save({ lid: '111', phone: '628111', sessionId: null });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('clears a phone stored by a session that no longer exists', async () => {
    await repo.save({ lid: '111', phone: '628111', sessionId: gone });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(store.lidsForPhone('628111')).toEqual([]);
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('clears a phone stored by a session that has since logged out', async () => {
    await store.remember('111', '628111', s1);
    await ds.getRepository(Session).update({ id: s1 }, { phone: null }); // logout, or WhatsApp unlinked it

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('keeps it again once that session is linked again', async () => {
    await store.remember('111', '628111', s1);
    await ds.getRepository(Session).update({ id: s1 }, { phone: null });
    await ds.getRepository(Session).update({ id: s1 }, { phone: '629000000001' });

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('touches no other lid, whichever branch would let the negative replace that row', async () => {
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    const others = [
      { lid: '222', phone: '628222', sessionId: null }, // no owner
      { lid: '444', phone: null, sessionId: s3 }, // holds no phone
      { lid: '555', phone: '628555', sessionId: gone }, // owned by a deleted session
      { lid: '777', phone: '628777', sessionId: s9 }, // owned by a session that logged out
      { lid: '666', phone: '628666', sessionId: s2 }, // owned by the session answering
    ];
    await repo.insert([
      { lid: '111', phone: '628111', sessionId: s2, updatedAt: stamp, isReported: true },
      ...others.map(o => ({ ...o, updatedAt: stamp, isReported: true })),
    ]);
    await ds.getRepository(Session).update({ id: s9 }, { phone: null });
    await store.reload();

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    for (const other of others) expect(await row(other.lid)).toEqual({ ...other, updatedAt: stamp, isReported: true });
  });

  it('drops a phone cached here once the table holds none, whichever session cleared it', async () => {
    await store.remember('111', '628111', s1);
    await repo.update({ lid: '111' }, { phone: null }); // s1 answered no phone on another node

    await store.remember('111', null, s2);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    expect(store.lidsForPhone('628111')).toEqual([]);
  });

  it('lets a later session clear a phone once the session that stored it is released', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('222', '628222', s9);
    const stamp = new Date('2020-01-01T00:00:00.000Z');
    await repo.update({ lid: '111' }, { updatedAt: stamp });

    await store.releaseSession(s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: null, updatedAt: stamp });
    expect(await row('222')).toMatchObject({ phone: '628222', sessionId: s9 });
    await store.remember('111', null, s2);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('releaseSession never throws', async () => {
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));

    await expect(store.releaseSession(s1)).resolves.toBeUndefined();
    warn.mockClear();
  });

  it('gives a released row back to a session that reported its phone before, on its next report', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await ds.getRepository(Session).delete({ id: s2 });
    await store.releaseSession(s2);

    await store.remember('111', '628111', s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    await store.remember('111', null, s3);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(await store.findPhoneForLid('111@lid')).toBe('628111');
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });

  it('does so when the release could not write the table as well', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await ds.getRepository(Session).delete({ id: s2 });
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await store.releaseSession(s2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();

    await store.remember('111', '628111', s1);
    await store.remember('111', null, s3);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('a phone from any session still replaces the row', async () => {
    await store.remember('111', null, s1);
    await store.remember('111', '628111', s2);
    await store.remember('111', '628222', s3);

    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s3 });
  });

  it('gives the row to a second session that reports the same phone, so the first one no longer clears it', async () => {
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });

    await store.remember('111', null, s1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
    expect(store.getCached('111')).toBe('628111');

    await store.remember('111', null, s2);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
  });

  it('writes a phone each session keeps reporting once, not once per report', async () => {
    const upsert = jest.spyOn(repo, 'upsert');
    for (let i = 0; i < 50; i++) {
      await store.remember('111', '628111', s1);
      await store.remember('111', '628111', s2);
    }

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('forgets who reported a phone once the phone changes or is cleared', async () => {
    const seenBy = (store as unknown as { seenBy: Map<string, Set<string>> }).seenBy;
    await store.remember('111', '628111', s1);
    await store.remember('111', '628111', s2);
    await store.remember('111', '628222', s3);
    await store.remember('111', '628222', s1); // s1 reported the old phone, not this one

    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });
    await store.remember('111', null, s1);
    expect(seenBy.has('111')).toBe(false);
  });

  it('knows the owner of a row it loaded, so only another session reporting the phone writes', async () => {
    await repo.insert({ lid: '111', phone: '628111', sessionId: s1, isReported: true });
    await store.reload();
    const upsert = jest.spyOn(repo, 'upsert');

    await store.remember('111', '628111', s1);
    expect(upsert).not.toHaveBeenCalled();
    await store.remember('111', '628111', s2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('knows the owner of a row it warms on a miss as well', async () => {
    await repo.insert({ lid: '111', phone: '628111', sessionId: s1, isReported: true }); // stored after this node loaded the table
    for (let i = 0; i < 100 && store.getCached('111') === undefined; i++) await new Promise(r => setTimeout(r, 5));
    const upsert = jest.spyOn(repo, 'upsert');

    await store.remember('111', '628111', s1);
    expect(upsert).not.toHaveBeenCalled();
    await store.remember('111', '628111', s2);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('takes the row on the next report when taking it failed to write', async () => {
    await store.remember('111', '628111', s1);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628111', s2)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });

    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
    await store.remember('111', null, s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('writes a new phone on the next report when its first write failed', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toBeNull();

    await store.remember('111', '628111', s1);

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('writes a changed phone on its next report after the write failed, whichever node stored the old one', async () => {
    const other = new LidMappingStoreService(repo); // another node on the same table
    await other.onModuleInit();
    await other.remember('111', '628111', s2);
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', '628222', s1)).resolves.toBe(false); // the contact's new number
    warn.mockClear();

    await expect(store.remember('111', '628222', s1)).resolves.toBe(true);

    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });
    expect(await other.findPhoneForLid('111@lid')).toBe('628222');
    expect(await other.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: [] });
  });

  it('writes a phone on every report while its writes keep failing, from any session, warning once a minute', async () => {
    const upsert = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('database or disk is full'));
    for (let i = 0; i < 1000; i++) await expect(store.remember('111', '628111', i % 2 ? s1 : s2)).resolves.toBe(false);
    expect(upsert).toHaveBeenCalledTimes(1000);
    expect(warn).toHaveBeenCalledTimes(1);

    later(59_999);
    await store.remember('111', '628111', s1);
    expect(warn).toHaveBeenCalledTimes(1);
    later(1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('database or disk is full'));
    await expect(store.remember('222', null, s1)).resolves.toBe(false); // any failed write, of any lid
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(1000 more failed since the last warning)'));
    warn.mockClear();

    upsert.mockRestore(); // the database takes writes again
    await expect(store.remember('111', '628111', s1)).resolves.toBe(true);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    await expect(store.remember('111', '628111', s1)).resolves.toBe(true); // already counted: nothing to write
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('writes another phone, or the same one after a negative, once a write of the lid failed', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1);
    warn.mockClear();
    await store.remember('111', '628222', s1);
    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });

    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('222', '628111', s1);
    warn.mockClear();
    await store.remember('222', null, s1);
    await store.remember('222', '628111', s1);
    expect(await row('222')).toMatchObject({ phone: '628111', sessionId: s1 });
  });

  it('writes a phone change on every report until the table takes it, warning once a minute', async () => {
    await store.remember('111', '628111', s1);
    const upsert = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('connection lost'));
    for (let i = 0; i < 5; i++) await store.remember('111', '628222', s1);
    expect(upsert).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);

    later(60_000);
    await store.remember('111', '628222', s1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(4 more failed since the last warning)'));
    later(60_000);
    await store.remember('111', '628222', s1);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(expect.not.stringContaining('more failed'));
    warn.mockClear();

    upsert.mockRestore();
    await store.remember('111', '628222', s1);
    expect(await row('111')).toMatchObject({ phone: '628222', sessionId: s1 });

    // So does another session taking the row.
    const retake = jest.spyOn(repo, 'upsert').mockRejectedValue(new Error('connection lost'));
    await store.remember('111', '628222', s2);
    await store.remember('111', '628222', s2);
    expect(retake).toHaveBeenCalledTimes(2);
    warn.mockClear();
  });

  it('writes a negative again when its first attempt failed', async () => {
    await store.remember('111', '628111', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.remember('111', null, s1)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });

    await expect(store.remember('111', null, s1)).resolves.toBe(true);

    expect(await row('111')).toMatchObject({ phone: null, sessionId: s1 });
    expect(await store.findPhoneForLid('111@lid')).toBeNull();
  });

  it('keeps counted reports after a failed negative until a negative actually clears the row', async () => {
    await store.remember('111', '628111', s2);
    await store.remember('111', '628111', s1);
    await repo.update({ lid: '111' }, { updatedAt: new Date('2020-01-01T00:00:00Z') });
    const original = await row('111');
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', null, s2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    expect(await row('111')).toEqual(original);

    await store.remember('111', '628111', s2);
    expect(await row('111')).toEqual(original);
    await ds.getRepository(Session).update({ id: s1 }, { phone: null });
    await store.remember('111', null, s2);
    expect(await row('111')).toMatchObject({ phone: null, sessionId: s2 });
    await store.remember('111', '628111', s2);
    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s2 });
  });

  it('answers the table again once a negative clears the row, and a failed negative changes nothing', async () => {
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(new Error('connection lost'));
    await store.remember('111', '628111', s1); // a first write that fails: the cache holds an unstored phone
    await store.remember('111', null, s1); // the negative lands and clears the row
    await store.remember('222', '628222', s1);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('connection lost'));
    later(60_000); // so that its warning is logged too
    await store.remember('222', null, s1); // fails
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockClear();
    expect(store.getCached('111')).toBeUndefined(); // warms the cleared row back
    for (let i = 0; i < 100 && store.getCached('111') === undefined; i++) await new Promise(r => setTimeout(r, 5));

    await repo.update({ lid: In(['111', '222']) }, { phone: '628999' }); // another node stores a phone for both
    expect(await store.phonesForLidsPersisted(['111', '222'])).toEqual({ 111: '628999', 222: '628999' });
  });

  it('keeps a phone stored while the negative of another session is being written', async () => {
    const update = hold('update');
    const negative = store.remember('111', null, s2);
    await update.reached; // the row exists (holding no phone); the conditional update has not run
    await store.remember('111', '628111', s1);
    update.release();
    await negative;

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).toBe('628111');
  });

  it('does not cache a negative over a phone still being written', async () => {
    const upsert = hold('upsert');
    const phone = store.remember('111', '628111', s1);
    await upsert.reached;
    await store.remember('111', null, s2); // lands first: there is no row yet
    upsert.release();
    await phone;

    expect(await row('111')).toMatchObject({ phone: '628111', sessionId: s1 });
    expect(store.getCached('111')).not.toBeNull();
    expect(await store.lidsForPhonesPersisted(['628111'])).toEqual({ 628111: ['111'] });
  });
});

describe('LidMappingStoreService: a phone reported under a second lid', () => {
  type Report = Parameters<Parameters<LidMappingStoreService['onSecondLid']>[0]>[0];

  /** Checks are collected over a window; these cases run it at once and wait it out with {@link settle}. */
  const noWindow = (store: LidMappingStoreService) =>
    ((store as unknown as { secondLidWindowMs: number }).secondLidWindowMs = 0);

  async function watched(seed: Partial<LidMapping>[] = [], repo = makeFakeRepo(seed)) {
    const store = await newStore(repo);
    noWindow(store);
    const reports: Report[] = [];
    store.onSecondLid(report => {
      reports.push(report);
    });
    const warn = jest
      .spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    return { repo, store, reports, warn };
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  /** Wait for a condition, up to a deadline; the expectations after it then show what is missing. */
  const until = async (done: () => boolean, ms = 2000): Promise<void> => {
    for (const end = Date.now() + ms; !done() && Date.now() < end;)
      await new Promise(resolve => setTimeout(resolve, 2));
  };
  const owedChecks = (store: LidMappingStoreService) =>
    (store as unknown as { secondLidOwed: Map<string, { phone: string }> }).secondLidOwed;
  const phoneReads = (repo: ReturnType<typeof makeFakeRepo>) =>
    repo.find.mock.calls.filter(([options]) => (options as { where?: { phone?: unknown } })?.where?.phone).length;

  it('reports the phone, both lids and the reporting session once, and logs a warning', async () => {
    const { store, reports, warn } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);

    await expect(store.remember('222', '628999', 's2')).resolves.toBe(true);
    await settle();

    expect(reports).toEqual([{ phone: '628999', previousLid: '111', newLid: '222', sessionId: 's2' }]);
    expect(warn).toHaveBeenCalledWith(
      'A phone number was reported under a second privacy id',
      expect.objectContaining({
        sessionId: 's2',
        phone: '628999',
        previousLid: '111',
        newLid: '222',
        action: 'second_lid_reported',
      }),
    );
    // Detection only: the table and the reverse lookup still hold both lids.
    expect(store.lidsForPhone('628999').sort()).toEqual(['111', '222']);
  });

  it('reports nothing for a phone first reported, or the same lid reported again', async () => {
    const { store, reports, warn } = await watched();

    await store.remember('111', '628999', 's1');
    await store.remember('111', '628999', 's1');
    await store.remember('111', '628999', 's2');
    await settle();

    expect(reports).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts neither an inferred row nor an inferred lookup as an engine report', async () => {
    const { store, reports } = await watched([{ lid: '111', phone: '628999', isReported: false }]);

    await store.remember('222', '628999', 's1'); // the earlier row is display data only
    await store.rememberIfUnknown('333', '628999', 's1'); // a cached lookup is no report
    await settle();

    expect(reports).toEqual([]);
  });

  it('reports one transition once, however often either lid is reported again', async () => {
    const { store, reports } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);

    await store.remember('222', '628999', 's2');
    await store.remember('222', '628999', 's2');
    await store.remember('222', '628999', 's3');
    await store.remember('111', '628999', 's1'); // a history sync replaying the earlier pairing
    await settle();

    expect(reports).toHaveLength(1);
  });

  it('keeps the writes and every other report when the listener throws or rejects', async () => {
    const { repo, store } = await watched([{ lid: '111', phone: '628999' }]);
    const throwing = jest.fn(() => {
      throw new Error('listener down');
    });
    store.onSecondLid(throwing);
    await expect(store.remember('222', '628999', 's2')).resolves.toBe(true);
    await expect(store.remember('333', '628999', 's2')).resolves.toBe(true);
    await settle();
    const rejecting = jest.fn(() => Promise.reject(new Error('listener down')));
    store.onSecondLid(rejecting);
    await expect(store.remember('444', '628999', 's2')).resolves.toBe(true);
    await settle();

    // 222 and 333 were checked together: 111-222, 111-333 and 222-333.
    expect(throwing).toHaveBeenCalledTimes(3);
    expect(rejecting).toHaveBeenCalledTimes(3);
    expect(repo.rows.filter(row => row.phone === '628999').map(row => row.lid)).toEqual(['111', '222', '333', '444']);
    expect(store.getCached('222')).toBe('628999');
  });

  it('reports a lid that only display data mapped to the phone once an engine reports it', async () => {
    const { store, reports } = await watched([
      { lid: '111', phone: '628999' },
      { lid: '222', phone: '628999', isReported: false },
    ]);

    await store.remember('222', '628999', 's2');
    await settle();

    expect(reports).toEqual([{ phone: '628999', previousLid: '111', newLid: '222', sessionId: 's2' }]);
  });

  it('reports nothing for a write that failed, and reports the one that lands', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    repo.upsert.mockRejectedValueOnce(new Error('disk full'));

    await expect(store.remember('222', '628999', 's2')).resolves.toBe(false);
    await settle();
    expect(reports).toEqual([]);

    await store.remember('222', '628999', 's2');
    await settle();
    expect(reports).toHaveLength(1);
  });

  describe('with a small mapping cache', () => {
    const saved = process.env.LID_MAPPING_CACHE_MAX;
    afterEach(() => {
      if (saved === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = saved;
    });

    // A recycled number: the earlier holder's row is old, so past the preload, and the fence reads the table.
    it('reports an earlier lid that only the table still holds', async () => {
      process.env.LID_MAPPING_CACHE_MAX = '2';
      // reload() indexes the rows in reverse, so the last seed row is the one evicted.
      const { store, reports } = await watched([
        { lid: 'a1', phone: '6201' },
        { lid: 'a2', phone: '6202' },
        { lid: '111', phone: '628999', sessionId: 's1' },
      ]);
      expect(store.lidsForPhone('628999')).toEqual([]);

      await store.remember('222', '628999', 's2');
      await settle();

      expect((await store.findLidsForPhone('628999')).sort()).toEqual(['111', '222']);
      expect(reports).toEqual([{ phone: '628999', previousLid: '111', newLid: '222', sessionId: 's2' }]);
    });
  });

  it('reports nothing when the reported pairs are replayed', async () => {
    const { store, reports } = await watched();
    for (let i = 0; i < 1001; i++) {
      await store.remember(`1${i}`, `62800${i}`, 's1');
      await store.remember(`2${i}`, `62800${i}`, 's2');
    }
    await settle();
    expect(reports).toHaveLength(1001);

    for (let i = 0; i < 1001; i++) await store.remember(`2${i}`, `62800${i}`, 's2');
    await settle();
    expect(reports).toHaveLength(1001);
  });

  it('reports nothing again after a restart for a pair it already reported', async () => {
    const first = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);
    await first.store.remember('222', '628999', 's2');
    await settle();

    const second = await newStore(first.repo); // same table, new process
    const reports: Report[] = [];
    second.onSecondLid(report => void reports.push(report));
    await second.remember('222', '628999', 's2');
    await settle();

    expect(first.reports).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('reports two new lids checked together for one phone once, the first as previous', async () => {
    const { store, reports } = await watched();

    await Promise.all([store.remember('111', '628999', 's1'), store.remember('222', '628999', 's2')]);
    await settle();

    expect(reports).toEqual([{ phone: '628999', previousLid: '111', newLid: '222', sessionId: 's2' }]);
  });

  // The first check runs while the second write has landed in the table but not yet returned, so it reads
  // the second lid as the one already there; the second lid's own check finds the pair reported.
  it('reports two new lids checked on different turns once', async () => {
    const { repo, store, reports } = await watched();
    await store.remember('111', '628999', 's1');
    let release: () => void = () => undefined;
    repo.upsert.mockImplementationOnce((values: Partial<LidMapping>) => {
      repo.rows.push(values as LidMapping);
      return new Promise<object>(resolve => (release = () => resolve({})));
    });
    const second = store.remember('222', '628999', 's2');
    await settle();
    release();
    await second;
    await settle();

    expect(reports).toEqual([expect.objectContaining({ previousLid: '222', newLid: '111' })]);
  });

  it('reports a new lid whose first report failed while an overlapping report of it landed', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);
    let fail: (err: Error) => void = () => undefined;
    repo.upsert.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));

    const first = store.remember('222', '628999', 's2'); // held open, then fails
    await expect(store.remember('222', '628999', 's2')).resolves.toBe(true);
    fail(new Error('SQLITE_BUSY: database is locked'));
    await expect(first).resolves.toBe(false);
    await settle();
    await expect(store.remember('222', '628999', 's2')).resolves.toBe(true);
    await settle();

    expect(reports).toEqual([expect.objectContaining({ phone: '628999', previousLid: '111', newLid: '222' })]);
  });

  it('collects the checks of a window into one table read', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    (store as unknown as { secondLidWindowMs: number }).secondLidWindowMs = 30;

    await store.remember('222', '628999', 's2');
    await new Promise(resolve => setImmediate(resolve));
    await store.remember('333', '628888', 's2');
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(phoneReads(repo)).toBe(1);
    expect(reports).toEqual([expect.objectContaining({ previousLid: '111', newLid: '222' })]);
  });

  it('stops at module shutdown without waiting: a collected check is dropped and none is read', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    (store as unknown as { secondLidWindowMs: number }).secondLidWindowMs = 30;

    await store.remember('222', '628999', 's2');
    expect(store.onModuleDestroy()).toBeUndefined();
    await store.remember('333', '628999', 's2');
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(phoneReads(repo)).toBe(0);
    expect(reports).toEqual([]);
  });

  it('ends a read still under way at shutdown without a report or a warning', async () => {
    const { repo, store, reports, warn } = await watched([{ lid: '111', phone: '628999' }]);
    let answer: () => void = () => undefined;
    repo.find.mockImplementationOnce(
      (options: { where?: { phone?: Cond } }) =>
        new Promise(
          resolve => (answer = () => resolve(repo.rows.filter(row => matches(row.phone, options.where?.phone)))),
        ),
    );

    await store.remember('222', '628999', 's2');
    await settle(); // the read is under way and does not answer
    store.onModuleDestroy();
    answer();
    await settle();

    expect(reports).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks a new lid the same sync pushed out of the mapping cache before its write landed', async () => {
    const saved = process.env.LID_MAPPING_CACHE_MAX;
    process.env.LID_MAPPING_CACHE_MAX = '3';
    try {
      const { store, reports } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);
      await Promise.all([
        store.remember('222', '628999', 's2'),
        store.remember('901', '628001', 's2'),
        store.remember('902', '628002', 's2'),
        store.remember('903', '628003', 's2'),
      ]);
      await settle();

      expect(reports).toEqual([expect.objectContaining({ phone: '628999', previousLid: '111', newLid: '222' })]);
    } finally {
      if (saved === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = saved;
    }
  });

  it('reports an earlier lid whose own report from outside the cache fails while the new lid is checked', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);
    // Out of the cache, as the LRU leaves a row of a table larger than the cap.
    const internals = store as unknown as { lidToPhone: Map<string, string>; phoneToLids: Map<string, Set<string>> };
    internals.lidToPhone.delete('111');
    internals.phoneToLids.delete('628999');
    let fail: (err: Error) => void = () => undefined;
    repo.upsert.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));

    const earlier = store.remember('111', '628999', 's1'); // counts as new, held open
    await store.remember('222', '628999', 's2');
    await settle();
    fail(new Error('Connection terminated unexpectedly'));
    await expect(earlier).resolves.toBe(false);
    await settle();

    expect(reports).toEqual([expect.objectContaining({ phone: '628999', previousLid: '111', newLid: '222' })]);
  });

  it('reports a pair once when a lid checked again after a failed read finds it reported', async () => {
    const { repo, store, reports } = await watched();
    repo.find.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await store.remember('111', '628999', 's1'); // its check's read fails: owed again
    await settle();
    await store.remember('222', '628999', 's2');
    await settle();
    await store.remember('111', '628999', 's1'); // lands and runs 111's owed check
    await settle();

    expect(reports.map(report => `${report.previousLid}>${report.newLid}`)).toEqual(['111>222']);
  });

  it('names no pair for a phone its lid left again within the window', async () => {
    const { store, reports } = await watched([{ lid: '111', phone: '628999' }]);

    await store.remember('222', '628999', 's2');
    await store.remember('222', '628888', 's2');
    await settle();

    expect(reports).toEqual([]);
  });

  it('reports a pair again once the time it is remembered for has passed', async () => {
    const { store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    let clock = 0;
    (store as unknown as { now: () => number }).now = () => clock;

    await store.remember('222', '628999', 's2');
    await settle();
    await store.remember('222', '628888', 's2'); // the lid moves away and back: a change each time
    await store.remember('222', '628999', 's2');
    await settle();
    expect(reports).toHaveLength(1);

    clock += 10 * 60_000;
    await store.remember('222', '628888', 's2');
    await store.remember('222', '628999', 's2');
    await settle();
    expect(reports).toHaveLength(2);
  });

  const capLines = (warn: jest.SpyInstance) =>
    warn.mock.calls.map(call => String((call as unknown[])[0])).filter(line => line.includes('second-lid'));

  // A first link or history sync starts every write at once: their checks wait on the writes, not on the cap.
  it('checks every lid of a sync larger than the cap of owed checks and logs no drop', async () => {
    const { store, reports, warn } = await watched([{ lid: '111', phone: '628999' }]);

    await Promise.all([
      store.remember('222', '628999', 's2'),
      ...Array.from({ length: 10_001 }, (_, i) => store.remember(`5${i}`, `62700${i}`, 's1')),
    ]);
    await settle();

    expect(reports).toEqual([expect.objectContaining({ phone: '628999', previousLid: '111', newLid: '222' })]);
    expect(capLines(warn)).toEqual([]);
  });

  // The same sync reports every lid twice, and the second statement fails (SQLITE_BUSY) before the first lands.
  it('owes no check and logs no drop while the first write of each lid of such a sync is in flight', async () => {
    const saved = process.env.LID_MAPPING_CACHE_MAX;
    process.env.LID_MAPPING_CACHE_MAX = '0'; // every lid stays cached, so the second report is not new
    try {
      const { repo, store, reports, warn } = await watched([{ lid: '111', phone: '628999' }]);
      const upsert = repo.upsert.getMockImplementation() as (values: Partial<LidMapping>) => Promise<object>;
      const land: Array<() => void> = [];
      repo.upsert.mockImplementation(
        (values: Partial<LidMapping>) => new Promise(resolve => land.push(() => resolve(upsert(values)))),
      );
      const lids = ['222', ...Array.from({ length: 10_001 }, (_, i) => `5${i}`)];
      const phoneOf = (lid: string) => (lid === '222' ? '628999' : `62700${lid}`);
      const firsts = lids.map(lid => store.remember(lid, phoneOf(lid), 's2'));
      repo.upsert.mockRejectedValue(new Error('SQLITE_BUSY'));
      await Promise.all(lids.map(lid => store.remember(lid, phoneOf(lid), 's2')));
      const owedInFlight = owedChecks(store).size;
      land.forEach(write => write());
      await Promise.all(firsts);
      await until(() => reports.length > 0);

      expect(owedInFlight).toBe(0);
      expect(reports).toEqual([expect.objectContaining({ phone: '628999', previousLid: '111', newLid: '222' })]);
      expect(capLines(warn)).toEqual([]);
      expect(owedChecks(store).size).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = saved;
    }
  });

  it('keeps at most its cap of owed checks and logs a drop at most once a minute, with a count', async () => {
    const { repo, store, warn } = await watched();
    let clock = 0;
    (store as unknown as { now: () => number }).now = () => clock;
    repo.upsert.mockRejectedValue(new Error('SQLITE_BUSY'));

    await Promise.all(Array.from({ length: 10_002 }, (_, i) => store.remember(`5${i}`, `62700${i}`, 's1')));
    expect((store as unknown as { secondLidOwed: Map<string, unknown> }).secondLidOwed.size).toBe(10_000);
    expect(capLines(warn)).toHaveLength(1);

    clock += 60_000;
    await store.remember('6', '62701', 's1');

    expect(capLines(warn)).toEqual([
      'More than 10000 second-lid checks are owed; dropping the oldest',
      'More than 10000 second-lid checks are owed; dropping the oldest (1 more dropped since the last warning)',
    ]);
  });

  // The data source closes when the gateway stops; a check still waiting must not query it or warn.
  it('neither reads nor warns once the data source is closed', async () => {
    const dataSource = { isInitialized: true };
    const repo = Object.assign(makeFakeRepo([{ lid: '111', phone: '628999' }]), { manager: { dataSource } });
    const { store, reports, warn } = await watched([], repo);

    await store.remember('222', '628999', 's2');
    dataSource.isInitialized = false;
    await settle();

    expect(phoneReads(repo)).toBe(0);
    expect(reports).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks again on the next landed write after its table read failed', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    repo.find.mockRejectedValueOnce(new Error('connection reset'));

    await store.remember('222', '628999', 's2');
    await settle();
    expect(reports).toEqual([]);
    await store.remember('222', '628999', 's3');
    await settle();

    expect(reports).toEqual([expect.objectContaining({ previousLid: '111', newLid: '222', sessionId: 's2' })]);
  });

  /** Hold every phone-keyed read open, or fail the one naming `phone`; the others read the fake table. */
  function holdPhoneReads(repo: ReturnType<typeof makeFakeRepo>, phone?: string) {
    const read = repo.find.getMockImplementation() as (options?: { where?: { phone?: Cond } }) => Promise<unknown>;
    const fail: Array<(err: Error) => void> = [];
    repo.find.mockImplementation((options?: { where?: { phone?: Cond } }) => {
      const asked = options?.where?.phone;
      if (!(asked instanceof FindOperator) || (phone && !(asked.value as unknown[]).includes(phone)))
        return read(options);
      return new Promise((_resolve, reject) => fail.push(reject));
    });
    return { read, fail };
  }

  // The new number's write and the current number's check read fail in one database hiccup; the mapping cache then
  // drops the lid and reads it back from the table at the number it was checked for.
  it('checks a lid again when the cache reads it back to the number whose check read failed', async () => {
    const saved = process.env.LID_MAPPING_CACHE_MAX;
    process.env.LID_MAPPING_CACHE_MAX = '3';
    try {
      const { repo, store, reports } = await watched([{ lid: '333', phone: '628777', sessionId: 's1' }]);
      const { read, fail } = holdPhoneReads(repo);

      await store.remember('222', '628777', 's2'); // lands; its check's read is held open
      await until(() => fail.length > 0);
      repo.upsert.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      await expect(store.remember('222', '628111', 's2')).resolves.toBe(false);
      fail[0](new Error('Connection terminated unexpectedly'));
      repo.find.mockImplementation(read);
      for (const lid of ['901', '902', '903']) await store.remember(lid, `62800${lid}`, 's2');
      expect(store.getCached('222')).toBeUndefined(); // the miss reads the row back
      await until(() => store.getCached('222') === '628777');
      await expect(store.remember('222', '628777', 's2')).resolves.toBe(true);
      await until(() => reports.length > 0);

      expect(repo.rows.filter(row => row.phone === '628777').map(row => row.lid)).toEqual(['333', '222']);
      expect(reports).toEqual([{ phone: '628777', previousLid: '333', newLid: '222', sessionId: 's2' }]);
    } finally {
      if (saved === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
      else process.env.LID_MAPPING_CACHE_MAX = saved;
    }
  });

  // The lid's holder changed number while its earlier check was read, and one database hiccup failed both
  // that read and the write of the new number.
  it('keeps a newer owed check of a lid over the one whose read failed', async () => {
    const { repo, store, reports } = await watched([{ lid: '333', phone: '628777', sessionId: 's1' }]);
    const { fail } = holdPhoneReads(repo, '628111');

    await store.remember('222', '628111', 's2'); // lands; its check's read is held open
    await settle();
    repo.upsert.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    await expect(store.remember('222', '628777', 's2')).resolves.toBe(false);
    fail[0](new Error('Connection terminated unexpectedly'));
    await settle();
    await expect(store.remember('222', '628777', 's2')).resolves.toBe(true);
    await settle();

    expect(repo.rows.filter(row => row.phone === '628777').map(row => row.lid)).toEqual(['333', '222']);
    expect(reports).toEqual([{ phone: '628777', previousLid: '333', newLid: '222', sessionId: 's2' }]);
  });

  it('checks the newer number of a lid again when both its reads fail, the older first', async () => {
    const { repo, store, reports } = await watched([{ lid: '333', phone: '628777', sessionId: 's1' }]);
    const { read, fail } = holdPhoneReads(repo);

    await store.remember('222', '628111', 's2'); // lands; read held open
    await settle();
    await store.remember('222', '628777', 's2'); // the number changed: lands; read held open
    await settle();
    fail[0](new Error('connection reset')); // the older read fails first
    await settle();
    fail[1](new Error('connection reset'));
    await settle();
    repo.find.mockImplementation(read);
    await store.remember('222', '628777', 's2');
    await settle();

    expect(reports).toEqual([{ phone: '628777', previousLid: '333', newLid: '222', sessionId: 's2' }]);
  });

  // A history and a contact sync report one new pairing together; the first write lands and its check's read fails
  // while the second write still waits on the database.
  it('checks a new lid when an overlapping write of it lands after its table read failed', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999', sessionId: 's1' }]);
    const { read, fail } = holdPhoneReads(repo);
    const upsert = repo.upsert.getMockImplementation() as (values: Partial<LidMapping>) => Promise<object>;
    let land: () => void = () => undefined;

    const first = store.remember('222', '628999', 's2'); // lands at once
    repo.upsert.mockImplementationOnce(
      (values: Partial<LidMapping>) => new Promise(resolve => (land = () => resolve(upsert(values)))),
    );
    const second = store.remember('222', '628999', 's2'); // the same pairing again, held open
    await expect(first).resolves.toBe(true);
    await until(() => fail.length > 0);
    fail[0](new Error('connection reset'));
    await until(() => owedChecks(store).has('222'));
    repo.find.mockImplementation(read);
    land();
    await expect(second).resolves.toBe(true);
    await until(() => reports.length > 0);

    expect(reports).toEqual([{ phone: '628999', previousLid: '111', newLid: '222', sessionId: 's2' }]);
    expect(owedChecks(store).size).toBe(0);
  });

  it('logs a failed read at most once a minute, with a count', async () => {
    const { repo, store, warn } = await watched([{ lid: '111', phone: '628999' }]);
    let clock = 0;
    (store as unknown as { now: () => number }).now = () => clock;
    repo.find.mockRejectedValue(new Error('connection reset'));

    await store.remember('222', '628999', 's2');
    await settle();
    await store.remember('333', '628999', 's2');
    await settle();
    clock += 60_000;
    await store.remember('444', '628999', 's2');
    await settle();

    expect(warn.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([
      'Could not check for a second lid: connection reset',
      'Could not check for a second lid: connection reset (1 more failed since the last warning)',
    ]);
  });

  it('stays silent about a read the closing data source cut off', async () => {
    const dataSource = { isInitialized: true };
    const repo = Object.assign(makeFakeRepo([{ lid: '111', phone: '628999' }]), { manager: { dataSource } });
    const { store, warn } = await watched([], repo);
    repo.find.mockImplementationOnce(() => {
      dataSource.isInitialized = false;
      return Promise.reject(new Error('Connection terminated'));
    });

    await store.remember('222', '628999', 's2');
    await settle();
    await settle();

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a new lid once when two sessions report it while the first write is in flight', async () => {
    const { repo, store, reports } = await watched([{ lid: '111', phone: '628999' }]);
    let release: () => void = () => undefined;
    repo.upsert.mockImplementationOnce((values: Partial<LidMapping>) => {
      repo.rows.push(values as LidMapping);
      return new Promise<object>(resolve => (release = () => resolve({})));
    });
    const first = store.remember('222', '628999', 's2');
    await store.remember('222', '628999', 's3');
    await settle();
    release();
    await first;
    await settle();

    expect(reports).toEqual([expect.objectContaining({ previousLid: '111', newLid: '222' })]);
  });

  it('names no earlier lid whose own write never reached the table', async () => {
    const { repo, store, reports } = await watched();
    let fail: (err: Error) => void = () => undefined;
    repo.upsert.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const first = store.remember('111', '628999', 's1'); // held open
    await store.remember('222', '628999', 's2');
    await settle();
    fail(new Error('disk full'));
    await expect(first).resolves.toBe(false);
    await settle();

    expect(repo.rows.filter(row => row.phone === '628999').map(row => row.lid)).toEqual(['222']);
    expect(reports).toEqual([]);
  });

  it('logs a table read that fails and keeps the write', async () => {
    const { repo, store, reports, warn } = await watched([{ lid: '111', phone: '628999' }]);
    repo.find.mockRejectedValueOnce(new Error('connection reset'));

    await expect(store.remember('222', '628999', 's2')).resolves.toBe(true);
    await settle();

    expect(reports).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    expect(store.getCached('222')).toBe('628999');
  });
});

describe('LidMappingStoreService: second-lid checks on a real table', () => {
  // SQLite in memory; on PostgreSQL (DATABASE_TYPE=postgres) a schema of its own, where writes land over time.
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  const saved = process.env.LID_MAPPING_CACHE_MAX;
  let ds: DataSource;
  let schema = '';
  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };

  beforeEach(async () => {
    const entities = [LidMapping, Session];
    if (pg) {
      schema = `lid_second_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
        : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true },
    ).initialize();
  });

  afterEach(async () => {
    await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
    if (saved === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = saved;
  });

  async function storeOn(cap?: number) {
    if (cap !== undefined) process.env.LID_MAPPING_CACHE_MAX = String(cap);
    const repo = ds.getRepository(LidMapping);
    const store = new LidMappingStoreService(repo);
    await store.onModuleInit();
    const warn = jest
      .spyOn((store as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const reports: { phone: string; previousLid: string; newLid: string }[] = [];
    store.onSecondLid(report => void reports.push(report));
    const find = jest.spyOn(repo, 'find');
    const reads = () =>
      find.mock.calls.filter(([options]) => (options as { where?: { phone?: unknown } } | undefined)?.where?.phone)
        .length;
    return { repo, store, reports, reads, warn, find };
  }

  /** One sync: every report started together, as addLidMappings does; then its checks have run. */
  async function sync(store: LidMappingStoreService, pairs: string[][], find: jest.SpyInstance): Promise<void> {
    await Promise.all(pairs.map(([lid, phone]) => store.remember(lid, phone, 's1')));
    while ((store as unknown as { secondLidTimer?: unknown }).secondLidTimer !== undefined) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (let seen = -1; seen !== find.mock.results.length;) {
      seen = find.mock.results.length;
      await Promise.allSettled(find.mock.results.map(result => result.value as unknown));
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  const singles = Array.from({ length: 600 }, (_, i) => [`9${i}`, `62811${i}`]);
  const earlier = Array.from({ length: 10 }, (_, i) => [`7${i}`, `62899${i}`]);
  const later = Array.from({ length: 10 }, (_, i) => [`8${i}`, `62899${i}`]);
  const pairsOf = (reports: { phone: string; previousLid: string; newLid: string }[]) =>
    reports.map(({ phone, previousLid, newLid }) => `${phone}:${[previousLid, newLid].sort().join('|')}`).sort();
  const numbers = earlier.map(([lid, phone], i) => `${phone}:${lid}|${later[i][0]}`).sort();

  it('reports each number whose two lids arrive in one sync once', async () => {
    const { store, reports, reads, warn, find } = await storeOn();

    await sync(store, [...earlier, ...singles, ...later], find);

    expect(pairsOf(reports)).toEqual(numbers);
    expect(reads()).toBeLessThan(singles.length / 10); // collected over a window; one turn read about 300 times
    expect(warn).toHaveBeenCalledTimes(reports.length);
  });

  // A window shorter than the sync splits its checks across reads, so a lid's check can find the other lid
  // of its number before that lid's own check has run.
  it('reports each such number once when the checks split across reads', async () => {
    const { store, reports, find } = await storeOn();
    (store as unknown as { secondLidWindowMs: number }).secondLidWindowMs = 1;

    await sync(store, [...earlier, ...singles, ...later], find);

    expect(pairsOf(reports)).toEqual(numbers);
  });

  // The new holder's lid arrives early in the first sync of their account, which holds more lids than the cache.
  it('reports a new lid that the rest of a sync larger than the cache pushes out of it', async () => {
    const { repo } = await storeOn();
    await repo.insert(earlier.map(([lid, phone]) => ({ lid, phone, isReported: true })));
    const { store, reports, find } = await storeOn(100);

    await sync(store, [...later, ...singles], find);

    expect(reports.map(({ phone, previousLid, newLid }) => `${phone}:${previousLid}|${newLid}`).sort()).toEqual(
      numbers,
    );
  });

  it('reports each held pair once when a sync replays it from outside a small mapping cache', async () => {
    const { repo } = await storeOn();
    const rows = [...singles, ...earlier, ...later].map(([lid, phone]) => ({ lid, phone, isReported: true }));
    for (let i = 0; i < rows.length; i += 200) await repo.insert(rows.slice(i, i + 200));
    const { store, reports, find } = await storeOn(100);

    await sync(store, [...earlier, ...singles, ...later], find);

    expect(pairsOf(reports)).toEqual(numbers);
  });

  // A PostgreSQL pool can commit two writes of one lid out of the order they were issued (one waits for a fresh
  // connection while the other takes an idle one). Here the older write is issued once the newer has committed,
  // and both return to the store after that, the newer first.
  it('checks the newer number of a lid whose older write commits after it', async () => {
    const { repo } = await storeOn();
    await repo.insert([
      { lid: '333', phone: '628777', isReported: true },
      { lid: '444', phone: '628888', isReported: true },
    ]);
    const { store, reports, find } = await storeOn();
    const upsert = repo.upsert.bind(repo);
    let issueOlder: () => void = () => undefined;
    let returnOlder: () => void = () => undefined;
    const issued = new Promise<void>(resolve => (issueOlder = resolve));
    const returned = new Promise<void>(resolve => (returnOlder = resolve));
    let olderStored: Promise<unknown> = Promise.resolve();
    jest
      .spyOn(repo, 'upsert')
      .mockImplementationOnce((entity, options) => {
        const stored = issued.then(() => upsert(entity, options));
        olderStored = stored;
        return stored.then(result => returned.then(() => result));
      })
      .mockImplementationOnce(async (entity, options) => {
        const result = await upsert(entity, options);
        issueOlder();
        await olderStored;
        return result;
      });

    const older = store.remember('222', '628777', 's1');
    await expect(store.remember('222', '628888', 's1')).resolves.toBe(true);
    returnOlder();
    await expect(older).resolves.toBe(true);
    await sync(store, [], find);
    expect((await repo.findOneBy({ lid: '222' }))?.phone).toBe('628777');

    await sync(store, [['222', '628888']], find); // the next report of the number this node holds
    expect((await repo.findOneBy({ lid: '222' }))?.phone).toBe('628888');
    expect(pairsOf(reports)).toEqual(['628777:222|333', '628888:222|444']);
  });

  it('checks nothing when a sync replays pairs the mapping cache holds', async () => {
    const { repo } = await storeOn();
    const rows = [...singles, ...earlier, ...later].map(([lid, phone]) => ({ lid, phone, isReported: true }));
    for (let i = 0; i < rows.length; i += 200) await repo.insert(rows.slice(i, i + 200));
    const { store, reports, reads, find } = await storeOn(5000);

    await sync(store, [...earlier, ...singles, ...later], find);

    expect(reads()).toBe(0);
    expect(reports).toEqual([]);
  });
});
