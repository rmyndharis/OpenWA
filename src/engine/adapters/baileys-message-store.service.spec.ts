import { DataSource, Repository } from 'typeorm';
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
      type: 'sqlite',
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
    }) as unknown as Parameters<BaileysMessageStoreService['put']>[1];

  it('round-trips a WAMessage through BufferJSON', async () => {
    await seedSession('s1');
    await service.put('s1', msg('M1'));
    const got = await service.getMessage('s1', 'M1');
    expect(got?.key?.id).toBe('M1');
    expect(got?.message?.conversation).toBe('M1');
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

  it('clearSession removes only that session', async () => {
    await seedSession('s1');
    await seedSession('s2');
    await service.put('s1', msg('M1'));
    await service.put('s2', msg('M2'));
    await service.clearSession('s1');
    expect(await service.getMessage('s1', 'M1')).toBeNull();
    expect(await service.getMessage('s2', 'M2')).not.toBeNull();
  });
});
