/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageProjector } from '../session/message-projector.service';
import type { HookManager } from '../../core/hooks';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { SendPacingService } from './send-pacing.service';
import type { MessageSendService } from './message-send.service';

/**
 * `createdAt` is not a unique sort key. On SQLite it is whole seconds; on Postgres `NOW()` is
 * transaction-scoped, so one bulk write ties every row it inserts; and the history projector stamps
 * the column from WhatsApp's own second-resolution timestamp on both. A chat therefore routinely
 * holds many rows sharing one value.
 *
 * Postgres plans this list as a Sort over a bitmap heap scan, and that sort is not stable: two
 * identical statements can return one tie group in two different orders. An offset pager walking
 * such a table then repeats some rows and never returns others, with no error and no concurrent
 * write required. Measured on postgres:16 before the tiebreaker existed: a single walk of 5000 tied
 * rows returned 23 rows twice and 23 rows not at all, reproducibly.
 *
 * This suite runs only where the defect lives. SQLite reaches the same rows through an index scan
 * and happens to be self-consistent, so an in-memory harness cannot fail on it.
 *
 * It pins ordering only. Offset paging over a table taking concurrent writes still drifts, because
 * the window is anchored to a count rather than to a row; closing that needs a cursor.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('message list ordering over tied createdAt (postgres)', () => {
  const SESSION_ID = 'sess-ordering';
  const ROWS = 5000;
  const PAGE = 100;

  let ds: DataSource;
  let repository: Repository<Message>;
  let service: MessageService;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
      entities: [Message],
    });
    await ds.initialize();

    // Raw DDL rather than ORM synchronize, like the sibling PG specs: the production shape comes
    // from the migration chain (varchar id, no uuid extension), and the index that decides this
    // test, (sessionId, createdAt), has to be the one the deployed schema carries.
    await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await ds.query(
      `CREATE TABLE "messages" (` +
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, ` +
        `"chatId" varchar NOT NULL, "chatName" varchar, "author" varchar, "from" varchar NOT NULL, ` +
        `"to" varchar NOT NULL, "body" text, "type" varchar NOT NULL DEFAULT 'text', ` +
        `"direction" varchar NOT NULL DEFAULT 'outgoing', "timestamp" bigint, "metadata" text, ` +
        `"mediaPath" varchar, "mediaMimetype" varchar, "status" varchar NOT NULL DEFAULT 'sent', ` +
        `"createdAt" timestamp NOT NULL DEFAULT now())`,
    );
    await ds.query(`CREATE INDEX "IDX_sess_created" ON "messages" ("sessionId", "createdAt")`);
    await ds.query(`CREATE INDEX "IDX_created" ON "messages" ("createdAt")`);
    await ds.query(`CREATE INDEX "IDX_chat" ON "messages" ("chatId")`);
    await ds.query(`CREATE INDEX "IDX_status" ON "messages" ("status")`);

    repository = ds.getRepository(Message);

    // getMessages without filters touches nothing but the repository; the rest are inert.
    service = new MessageService(
      repository,
      {} as EngineRegistry,
      {} as MessageProjector,
      {} as HookManager,
      { lidsForPhone: () => [], getCached: () => undefined } as unknown as LidMappingStoreService,
      {} as SendPacingService,
      {} as MessageSendService,
    );

    // One tie group, stamped the way message-history-projector.ts stamps a backfill.
    await repository.insert(
      Array.from({ length: ROWS }, (_, i) => ({
        id: randomUUID(),
        sessionId: SESSION_ID,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        body: `m${i}`,
        direction: MessageDirection.INCOMING,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`).catch(() => undefined);
    await ds.destroy();
  });

  it('serves every row exactly once across a full offset walk of one tie group', async () => {
    const served: string[] = [];
    for (let offset = 0; offset < ROWS; offset += PAGE) {
      const { messages } = await service.getMessages(SESSION_ID, { limit: PAGE, offset });
      served.push(...messages.map(m => m.id));
    }

    const distinct = new Set(served);
    expect(served).toHaveLength(ROWS);
    expect(distinct.size).toBe(ROWS); // no row repeated, and therefore none missed
  });

  /**
   * The tiebreaker gives the list a total order; it does not stop the WINDOW drifting, because
   * `offset` addresses a position by count. A message arriving mid-walk pushes every older row down
   * one, so the next offset re-reads a row the previous page already served. `after` anchors on the
   * last row instead, which a concurrent insert cannot move.
   */
  describe('a message arriving between pages', () => {
    const LIVE_SESSION = 'sess-live-walk';
    const LIVE_ROWS = 500;
    const LIVE_PAGE = 100;

    const arrive = (n: number): Promise<unknown> =>
      repository.insert({
        id: randomUUID(),
        sessionId: LIVE_SESSION,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        body: `live-${n}`,
        direction: MessageDirection.INCOMING,
        createdAt: new Date('2026-06-01T00:00:00.000Z'), // newer than the fixture: lands on page 0
      });

    beforeEach(async () => {
      await repository.delete({ sessionId: LIVE_SESSION });
      await repository.insert(
        Array.from({ length: LIVE_ROWS }, (_, i) => ({
          id: randomUUID(),
          sessionId: LIVE_SESSION,
          chatId: 'peer@c.us',
          from: 'peer@c.us',
          to: 'me@c.us',
          body: `m${i}`,
          direction: MessageDirection.INCOMING,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        })),
      );
    });

    afterAll(async () => {
      await repository.delete({ sessionId: LIVE_SESSION });
    });

    it('shifts an offset walk, so it serves a row twice', async () => {
      const served: string[] = [];
      for (let page = 0; page * LIVE_PAGE < LIVE_ROWS; page++) {
        const { messages } = await service.getMessages(LIVE_SESSION, { limit: LIVE_PAGE, offset: page * LIVE_PAGE });
        served.push(...messages.map(m => m.id));
        await arrive(page);
      }

      expect(served.length - new Set(served).size).toBeGreaterThan(0);
    });

    it('does not shift an `after` walk', async () => {
      const served: string[] = [];
      let after: string | undefined;
      for (let page = 0; page * LIVE_PAGE < LIVE_ROWS; page++) {
        const { messages } = await service.getMessages(LIVE_SESSION, { limit: LIVE_PAGE, after });
        served.push(...messages.map(m => m.id));
        after = messages[messages.length - 1]?.id;
        await arrive(page);
      }

      expect(served).toHaveLength(LIVE_ROWS);
      expect(new Set(served).size).toBe(LIVE_ROWS);
    });

    it('rejects a cursor naming a row in another session', async () => {
      const foreign = await repository.findOne({ where: { sessionId: SESSION_ID } });

      await expect(service.getMessages(LIVE_SESSION, { limit: LIVE_PAGE, after: foreign!.id })).rejects.toThrow(
        /Unknown cursor/,
      );
    });
  });
});
