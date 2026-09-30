import type { WAMessage } from '@whiskeysockets/baileys';
import { DataSource, DeleteQueryBuilder, Repository } from 'typeorm';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';

describe('BaileysMessageStoreService', () => {
  let ds: DataSource;
  let repo: Repository<BaileysStoredMessage>;
  let service: BaileysMessageStoreService;

  // Seed a sessions row so FK constraints (if SQLite enables them) resolve correctly.
  const seedSession = async (id: string): Promise<void> => {
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      // Session must be present so the @ManyToOne relation metadata resolves and synchronize
      // can emit the CASCADE FK on the baileys_stored_messages table.
      entities: [BaileysStoredMessage, Session],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(BaileysStoredMessage);
    service = new BaileysMessageStoreService(repo);
  });

  afterEach(async () => {
    await ds.destroy();
    delete process.env.BAILEYS_MESSAGE_STORE_LIMIT;
  });

  // Partial WAMessage fixture — cast through unknown so strict checks don't fire on the incomplete shape.
  const msg = (id: string) =>
    ({
      key: { id, remoteJid: '1@s.whatsapp.net', fromMe: false },
      message: { conversation: id },
      // A real WAMessage carries binary fields, and they are the only reason the BufferJSON round-trip
      // exists. With a string-only fixture the assertions below held under any replacer/reviver pair,
      // including identity — the test named the codec without exercising it.
      mediaKey: Buffer.from([0x01, 0x02, 0x03, 0xff]),
    }) as unknown as Parameters<BaileysMessageStoreService['put']>[1];

  /** Hold the next upsert until released: the database round trip a reader can land inside. */
  const holdNextUpsert = (): { release: () => void; fail: (err: Error) => void } => {
    let release!: () => void;
    let fail!: (err: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const real = repo.upsert.bind(repo);
    jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await gate;
      return real(...args);
    });
    return { release, fail };
  };
  const ticks = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };

  it('round-trips a WAMessage through BufferJSON', async () => {
    await seedSession('s1');
    await service.put('s1', msg('M1'));
    const got = await service.getMessage('s1', 'M1');
    expect(got?.key?.id).toBe('M1');
    expect(got?.message?.conversation).toBe('M1');
    // The assertion that makes this a round-trip test rather than a string-copy test.
    const mediaKey = (got as unknown as { mediaKey?: unknown }).mediaKey;
    expect(Buffer.isBuffer(mediaKey)).toBe(true);
    expect(mediaKey).toEqual(Buffer.from([0x01, 0x02, 0x03, 0xff]));
  });

  it('returns null for an unknown id and is session-scoped', async () => {
    await seedSession('s1');
    await service.put('s1', msg('M1'));
    expect(await service.getMessage('s1', 'NOPE')).toBeNull();
    expect(await service.getMessage('s2', 'M1')).toBeNull();
  });

  it('is idempotent on (sessionId, waMessageId)', async () => {
    await seedSession('s1');
    await service.put('s1', msg('M1'));
    await service.put('s1', msg('M1'));
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(1);
  });

  /**
   * Regression test — drives eviction through the REAL put() path so the stored
   * createdAt value comes from the upsert payload (millisecond precision), not from
   * SQLite's datetime('now') (second precision). Without the `createdAt: new Date()`
   * fix in put(), the string comparison '…:XX' < '…:XX.000' evaluates TRUE for every
   * same-second row, and enforceLimit() deletes ALL rows instead of keeping the cap.
   *
   * This test MUST FAIL against the old code (no explicit createdAt in upsert) and
   * PASS with the fix.
   */
  it('eviction via put() keeps exactly the cap — never wipes the store', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '3';
    await seedSession('s_c1');
    const s = new BaileysMessageStoreService(repo);

    // Insert 6 messages via put() — each call sets createdAt: new Date(), so even within the
    // same wall-clock second the stored values carry millisecond precision. A 2ms gap guarantees
    // each createdAt is a distinct millisecond, so the (createdAt, id) eviction order is
    // deterministic and the survivor assertions below don't race the random-UUID tiebreaker.
    for (let i = 1; i <= 6; i++) {
      await s.put('s_c1', msg(`C${i}`));
      await new Promise(r => setTimeout(r, 2));
    }

    const count = await repo.count({ where: { sessionId: 's_c1' } });
    // With the bug: count is 0 (all evicted). With the fix: count is exactly 3.
    expect(count).toBe(3);

    // The newest messages (C4, C5, C6) must survive — they have the latest createdAt.
    expect(await s.getMessage('s_c1', 'C4')).not.toBeNull();
    expect(await s.getMessage('s_c1', 'C5')).not.toBeNull();
    expect(await s.getMessage('s_c1', 'C6')).not.toBeNull();

    // The oldest messages must be evicted.
    expect(await s.getMessage('s_c1', 'C1')).toBeNull();
    expect(await s.getMessage('s_c1', 'C2')).toBeNull();
    expect(await s.getMessage('s_c1', 'C3')).toBeNull();
  });

  it('evicts oldest beyond the per-session cap (pre-seeded rows, distinct timestamps)', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '2';
    await seedSession('s1');
    const s = new BaileysMessageStoreService(repo);
    // Use distinct createdAt values so ordering is deterministic regardless of UUID tiebreaker.
    const t0 = new Date('2024-01-01T00:00:00.000Z');
    const t1 = new Date('2024-01-01T00:00:01.000Z');
    const t2 = new Date('2024-01-01T00:00:02.000Z');
    for (const [waMessageId, createdAt] of [
      ['M1', t0],
      ['M2', t1],
      ['M3', t2],
    ] as [string, Date][]) {
      await repo.save(repo.create({ sessionId: 's1', waMessageId, serializedMessage: '{}', createdAt }));
    }
    // Trigger eviction: put M3 again (idempotent upsert) so enforceLimit runs with 3 rows and cap=2.
    await s.put('s1', msg('M3'));
    expect(await s.getMessage('s1', 'M1')).toBeNull(); // oldest (t0) evicted
    expect(await s.getMessage('s1', 'M2')).not.toBeNull();
    expect(await s.getMessage('s1', 'M3')).not.toBeNull();
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(2);
  });

  it('keeps exactly limit rows when multiple share the same createdAt (tiebreaker via id)', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '2';
    await seedSession('s2');
    const s = new BaileysMessageStoreService(repo);
    // Insert 3 rows with identical createdAt to stress the (createdAt, id) tiebreaker.
    // With UUID primary keys, id ordering is lexicographic — we can only assert count, not which survive.
    const sharedTs = new Date('2024-01-01T00:00:00.000Z');
    for (const waMessageId of ['T1', 'T2', 'T3']) {
      await repo.save(repo.create({ sessionId: 's2', waMessageId, serializedMessage: '{}', createdAt: sharedTs }));
    }
    // Trigger eviction: put a 4th message (distinct, newer ts) through the service.
    await s.put('s2', msg('T4'));
    // Exactly limit rows must remain — no over- or under-deletion.
    expect(await repo.count({ where: { sessionId: 's2' } })).toBe(2);
    // T4 is the newest (distinct createdAt = now) and must survive.
    expect(await s.getMessage('s2', 'T4')).not.toBeNull();
  });

  it('evicts same-createdAt rows by id at the cap and bounds the trim delete by the index', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '3';
    await seedSession('s3');
    const s = new BaileysMessageStoreService(repo);
    const sharedTs = new Date('2024-01-01T00:00:00.000Z');
    for (const id of ['a', 'b', 'c', 'd']) {
      await repo.save(
        repo.create({ id, sessionId: 's3', waMessageId: `W${id}`, serializedMessage: '{}', createdAt: sharedTs }),
      );
    }
    // Pass-through spy: records the SQL every delete builder runs.
    const spy = jest.spyOn(DeleteQueryBuilder.prototype, 'getQueryAndParameters');

    await s.put('s3', msg('NEW'));
    const deletes = spy.mock.results.map(r => r.value as [string, unknown[]]);
    spy.mockRestore();

    // The newest row and the two highest ids of the tied run survive.
    const left = await repo.find({ where: { sessionId: 's3' }, order: { id: 'ASC' } });
    expect(left.map(r => r.waMessageId).sort()).toEqual(['NEW', 'Wc', 'Wd']);
    // The range delete must be bounded by (createdAt, id) on the index, not walk the whole session.
    expect(deletes).toHaveLength(1);
    const [sql, params] = deletes[0];
    const detail = (await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${sql}`, params))
      .map(r => r.detail)
      .join(' | ');
    expect(detail).toMatch(/IDX_baileys_stored_messages_session_created_id \(sessionId=\? AND \(createdAt,id\)/);
  });

  // Issue #319 — an orphaned adapter (its session was deleted/recreated during reconnect
  // churn) keeps receiving messages.upsert and calls put() under a sessionId that no longer
  // has a parent row. The FK then fails (SQLITE_CONSTRAINT in prod) on EVERY message, the
  // store stays empty, and reply/forward/react/delete-by-id can never resolve the message.
  // put() must tolerate the absent parent — skip the write instead of throwing per message.
  it('skips persisting (no throw) when the parent session row is absent (orphaned adapter; #319)', async () => {
    await ds.query('PRAGMA foreign_keys = ON'); // faithfully reproduce production FK enforcement
    // No seedSession('orphan') — the parent is gone.
    await expect(service.put('orphan', msg('M1'))).resolves.toBeUndefined();
    expect(await repo.count({ where: { sessionId: 'orphan' } })).toBe(0);
  });

  it('still rethrows a non-FK persistence error (does not swallow real failures)', async () => {
    await seedSession('s1');
    const boom = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    jest.spyOn(repo, 'upsert').mockRejectedValueOnce(boom);
    await expect(service.put('s1', msg('M1'))).rejects.toThrow('disk full');
  });

  describe('getMessages', () => {
    it('returns the batch in one query, skipping ids it has never seen', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      await service.put('s1', msg('M2'));
      const found = await service.getMessages('s1', ['M1', 'MISSING', 'M2']);
      expect(found.map(m => m.key.id).sort()).toEqual(['M1', 'M2']);
    });

    it('stays scoped to its own session', async () => {
      await seedSession('s1');
      await seedSession('s2');
      await service.put('s2', msg('M1'));
      expect(await service.getMessages('s1', ['M1'])).toEqual([]);
    });

    it('short-circuits on an empty or all-falsy id list instead of querying', async () => {
      // An empty In() clause is a SQL syntax error on some drivers and matches everything on others.
      const find = jest.spyOn(repo, 'find');
      expect(await service.getMessages('s1', [])).toEqual([]);
      expect(await service.getMessages('s1', [''])).toEqual([]);
      expect(find).not.toHaveBeenCalled();
    });

    it('round-trips binary fields the same way getMessage does', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      const [found] = await service.getMessages('s1', ['M1']);
      // mediaKey is off the public WAMessage type, like the fixture that wrote it.
      expect(Buffer.isBuffer((found as unknown as { mediaKey: unknown }).mediaKey)).toBe(true);
    });
  });

  describe('a read issued while the write is in flight', () => {
    beforeEach(() => seedSession('s1'));

    it('getMessage waits for the write', async () => {
      const held = holdNextUpsert();
      const write = service.put('s1', msg('M1'));
      const read = service.getMessage('s1', 'M1');
      await ticks();
      held.release();
      await write;
      expect((await read)?.key?.id).toBe('M1');
    });

    it('getMessages waits for the write', async () => {
      const held = holdNextUpsert();
      const write = service.put('s1', msg('M1'));
      const read = service.getMessages('s1', ['M1', 'OTHER']);
      await ticks();
      held.release();
      await write;
      expect((await read).map(m => m.key.id)).toEqual(['M1']);
    });

    it('a failed write rejects put and leaves the read to report the message missing', async () => {
      const held = holdNextUpsert();
      const write = service.put('s1', msg('M1'));
      const read = service.getMessage('s1', 'M1');
      await ticks();
      held.fail(new Error('disk full'));
      await expect(write).rejects.toThrow('disk full');
      expect(await read).toBeNull();
    });

    it('a write that throws before it starts rejects put and releases the read', async () => {
      jest.spyOn(service as unknown as { write: () => Promise<void> }, 'write').mockImplementationOnce(() => {
        throw new Error('no library');
      });
      const write = service.put('s1', msg('M1'));
      const read = service.getMessage('s1', 'M1');
      await expect(write).rejects.toThrow('no library');
      expect(await read).toBeNull();
    }, 1_000);

    it('a read waits for the latest write of an id, not an earlier failed one', async () => {
      const first = holdNextUpsert();
      const firstWrite = service.put('s1', msg('M1'));
      await ticks();
      const second = holdNextUpsert();
      const secondWrite = service.put('s1', msg('M1'));
      first.fail(new Error('disk full'));
      await expect(firstWrite).rejects.toThrow('disk full');
      const read = service.getMessage('s1', 'M1');
      await ticks();
      second.release();
      await secondWrite;
      expect((await read)?.key?.id).toBe('M1');
    });
  });

  describe('update', () => {
    it('rewrites the stored message in place and keeps its eviction age', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      const before = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });

      await service.update('s1', 'M1', stored => ({ ...stored, message: { conversation: 'edited' } }));

      expect((await service.getMessage('s1', 'M1'))?.message?.conversation).toBe('edited');
      const after = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
      // An edit is not a new message: refreshing createdAt would push it to the back of the eviction queue.
      expect(after.createdAt).toEqual(before.createdAt);
      expect(await repo.count({ where: { sessionId: 's1' } })).toBe(1);
    });

    it('keeps the binary fields through the rewrite', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      await service.update('s1', 'M1', stored => ({ ...stored, message: null }));
      const got = await service.getMessage('s1', 'M1');
      expect(got?.message).toBeNull();
      expect(Buffer.isBuffer((got as unknown as { mediaKey: unknown }).mediaKey)).toBe(true);
    });

    it('leaves an id the store does not hold absent, and a row the change declines untouched', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      const change = jest.fn(() => null);

      await service.update('s1', 'NOPE', change);
      await service.update('s1', 'M1', change);

      expect(change).toHaveBeenCalledTimes(1); // only for the row that exists
      expect(await service.getMessage('s1', 'NOPE')).toBeNull();
      expect((await service.getMessage('s1', 'M1'))?.message?.conversation).toBe('M1');
    });

    it('applies after a put of the same id that has not finished yet', async () => {
      await seedSession('s1');
      // The change is asked for while the original's write is still in flight (its first await is
      // the library import), which is how the inbound path and a delete for everyone meet.
      await Promise.all([
        service.put('s1', msg('M1')),
        Promise.resolve().then(() => service.update('s1', 'M1', stored => ({ ...stored, message: null }))),
      ]);
      expect((await service.getMessage('s1', 'M1'))?.message).toBeNull();
    });

    it('a read issued while an update is in flight sees the change', async () => {
      await seedSession('s1');
      await service.put('s1', msg('M1'));
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      const real = repo.update.bind(repo);
      jest.spyOn(repo, 'update').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        await gate;
        return real(...args);
      });

      const change = service.update('s1', 'M1', stored => ({ ...stored, message: { conversation: 'edited' } }));
      const read = service.getMessage('s1', 'M1');
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      release();
      await change;

      expect((await read)?.message?.conversation).toBe('edited');
    });

    it('an update asked for before the put of the same id settles instead of waiting on it', async () => {
      await seedSession('s1');
      const change = jest.fn((stored: WAMessage) => ({ ...stored, message: null }));

      await Promise.all([service.update('s1', 'M1', change), service.put('s1', msg('M1'))]);

      // Queued first, the update found nothing to change; the put that followed it still landed.
      expect(change).not.toHaveBeenCalled();
      expect((await service.getMessage('s1', 'M1'))?.message?.conversation).toBe('M1');
    });
  });

  it('clearSession removes only that session', async () => {
    await seedSession('s1');
    await seedSession('s2');
    await service.put('s1', msg('M1'));
    await service.put('s2', msg('M2'));
    await service.clearSession('s1');
    expect(await service.getMessage('s1', 'M1')).toBeNull();
    expect(await service.getMessage('s2', 'M2')).not.toBeNull();
  });

  it('clearSession waits for a write of that session still in flight, so it cannot recreate the row', async () => {
    await seedSession('s1');
    await seedSession('s2');
    await service.put('s2', msg('M2'));
    const held = holdNextUpsert();
    const write = service.put('s1', msg('M1'));
    await ticks();

    const clearing = service.clearSession('s1');
    await ticks();
    held.release();
    await clearing;
    await write;

    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(0);
    expect(await repo.count({ where: { sessionId: 's2' } })).toBe(1);
  });
});
