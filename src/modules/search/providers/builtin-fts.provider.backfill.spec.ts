import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { BuiltInFtsProvider } from './builtin-fts.provider';

/**
 * The state no other spec constructs: a database whose `messages` rows predate the FTS schema, with
 * the migration NOT applied.
 *
 * `builtin-fts.provider.spec.ts`, `search-dual-db.spec.ts` and `test/search.e2e-spec.ts` all run
 * `AddMessagesFts…up()` first, so the index is always populated by the migration's own backfill and
 * the provider's backfill branch never executes. That is why this shipped and survived: the branch
 * has no coverage, not weak coverage.
 *
 * `messages_fts` is an FTS5 **external-content** table, so `count(*)` on it scans `messages` and
 * returns that table's row count rather than the number of indexed documents. The document count
 * lives in the `messages_fts_docsize` shadow table. Every assertion here is written against
 * behaviour — what `search()` can find — with `docsize` used only to describe the fixture.
 */
describe('BuiltInFtsProvider — backfilling an index built after the rows', () => {
  let ds: DataSource;

  const row = (body: string, timestamp: number) => ({
    sessionId: 's1',
    chatId: 'c1',
    from: 'a@c.us',
    to: 'dest@c.us',
    body,
    type: 'text',
    direction: MessageDirection.OUTGOING,
    timestamp,
  });

  /** Rows first, no FTS schema at all — the shape an upgrade from before the feature produces. */
  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Message).insert([row('alpha legacy', 1), row('bravo legacy', 2)]);
  });
  afterEach(() => ds.destroy());

  /** Rows whose body is NULL — the precondition for the integrity assertion below. */
  const nullBodies = async (): Promise<number> => {
    const r: Array<{ n: number }> = await ds.query(`SELECT count(*) AS n FROM "messages" WHERE "body" IS NULL`);
    return Number(r[0]?.n);
  };

  /**
   * FTS5's index-vs-content check. Two forms exist and they are NOT equivalent: the plain
   * `('integrity-check')` validates only the index's internal structures and answers PASS on an
   * index that holds nothing at all, so it cannot see this defect. The `rank = 1` argument form
   * validates the index AGAINST the content table, which is what makes it discriminating here.
   *
   * VALID ONLY BECAUSE THIS FIXTURE HAS NO NULL BODY, which the caller asserts first. The migration
   * backfills `WHERE body IS NOT NULL` while the AFTER INSERT trigger indexes unconditionally, so on
   * any database holding a NULL-body row this check reports `malformed` forever — including on a
   * healthy, migration-built one. Do not lift it into a general post-condition: it convicts the
   * healthy state, and a fixture that later gains a NULL row would fail here for a reason that has
   * nothing to do with the code under test.
   */
  const indexMatchesContent = async (): Promise<string> => {
    try {
      await ds.query(`INSERT INTO "messages_fts"("messages_fts", "rank") VALUES ('integrity-check', 1)`);
      return 'consistent';
    } catch (e) {
      return e instanceof Error && e.message.includes('malformed') ? 'malformed' : `unexpected: ${String(e)}`;
    }
  };

  const docsize = async (): Promise<number> => {
    const r: Array<{ n: number }> = await ds.query(`SELECT count(*) AS n FROM "messages_fts_docsize"`);
    return Number(r[0]?.n);
  };
  const found = async (q: string): Promise<string[]> =>
    (await new BuiltInFtsProvider(ds).search({ q, limit: 50 })).hits.map(h => h.body ?? '');

  it('indexes rows that predate the FTS table on first boot', async () => {
    await new BuiltInFtsProvider(ds).onModuleInit();

    expect(await docsize()).toBe(2);
    expect(await found('legacy')).toHaveLength(2);
  });

  /**
   * The decisive case, and the reason an emptiness probe is not sufficient: a RESTART, not a fresh
   * boot. The first boot leaves the index empty, then one post-boot write is indexed by the working
   * `AFTER INSERT` trigger — so the second boot meets a PARTIALLY populated index. A probe that asks
   * "is it empty?" is false here and repairs nobody; the installed base is in exactly this state.
   */
  it('repairs a partially populated index on a later boot, not just an empty one', async () => {
    // Construct the state an unrepaired box is actually in, rather than running the old code:
    // the FTS schema and triggers exist, older rows were never indexed, and one later write WAS
    // indexed by the AFTER INSERT trigger. Built by creating the schema and then withdrawing the
    // legacy rows from the index with FTS5's own 'delete' command, so the spec does not restate the
    // provider's DDL and drift from it.
    // Asserted FIRST so it is the failure a future contributor sees: `indexMatchesContent` below is
    // only valid while this fixture holds no NULL body, and a NULL row would otherwise surface as a
    // confusing `malformed` that reads as the fix being broken.
    expect(await nullBodies()).toBe(0);

    await new BuiltInFtsProvider(ds).onModuleInit();
    // The index keys on SQLite's implicit rowid (content_rowid='rowid'), not the entity's uuid id.
    const seeded: Array<{ rowid: number; body: string }> = await ds.query(`SELECT rowid, body FROM "messages"`);
    for (const m of seeded) {
      await ds.query(`INSERT INTO "messages_fts"("messages_fts", "rowid", "body") VALUES ('delete', ?, ?)`, [
        m.rowid,
        m.body,
      ]);
    }
    expect(await docsize()).toBe(0);

    await ds.getRepository(Message).insert([row('charlie fresh', 3)]); // the trigger indexes this one
    expect(await docsize()).toBe(1); // partially populated: the state an emptiness probe cannot see

    await new BuiltInFtsProvider(ds).onModuleInit(); // the build under test

    expect(await docsize()).toBe(3);
    expect(await found('legacy')).toHaveLength(2);
    expect(await found('fresh')).toHaveLength(1);

    // The repair must add ONLY the missing rows. Re-indexing a row the trigger had already indexed
    // leaves a duplicate document that nothing above can see: the shadow table replaces by rowid so
    // `docsize` is unchanged, search returns the right count, and edits and deletes still succeed.
    // This is the one assertion that discriminates — see `indexMatchesContent`, and note the
    // precondition it depends on.
    expect(await indexMatchesContent()).toBe('consistent');
  });

  it('leaves an already complete index alone rather than duplicating it', async () => {
    await new BuiltInFtsProvider(ds).onModuleInit();
    const after = await docsize();
    await new BuiltInFtsProvider(ds).onModuleInit();

    expect(await docsize()).toBe(after);
    expect(await found('legacy')).toHaveLength(2);
  });

  /**
   * Known-negative. The migration backfills `WHERE "body" IS NOT NULL`; the repair must reproduce
   * that contents exactly rather than indexing a NULL body as an empty document, which would make
   * the index disagree with the schema it repairs.
   */
  it('does not index a NULL body, matching what the migration produces', async () => {
    await ds.getRepository(Message).insert([{ ...row('', 4), body: null as unknown as string }]);

    await new BuiltInFtsProvider(ds).onModuleInit();

    expect(await docsize()).toBe(2);
    expect(await found('legacy')).toHaveLength(2);
  });

  /**
   * The write path. On an unrepaired box the `AFTER UPDATE`/`AFTER DELETE` triggers issue FTS5
   * 'delete' commands for documents that were never indexed and the statement is rejected, so the
   * row does not change. This asserts the repair restores ordinary writes — the severe half of the
   * defect, and the half no search assertion can see.
   */
  it('restores ordinary UPDATE and DELETE on rows that predate the index', async () => {
    const repo = ds.getRepository(Message);
    await new BuiltInFtsProvider(ds).onModuleInit();

    const target = await repo.findOneOrFail({ where: { body: 'alpha legacy' } });
    await expect(repo.update({ id: target.id }, { body: 'alpha edited' })).resolves.toBeDefined();
    await expect(repo.delete({ body: 'bravo legacy' })).resolves.toBeDefined();

    expect((await repo.findOneOrFail({ where: { id: target.id } })).body).toBe('alpha edited');
    expect(await found('edited')).toHaveLength(1);
  });
});
