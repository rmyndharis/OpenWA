/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageProjector } from '../session/message-projector.service';
import type { HookManager } from '../../core/hooks';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { SendPacingService } from './send-pacing.service';
import type { MessageSendService } from './message-send.service';
import { AddMessageWindowIndexes1790812800000 } from '../../database/migrations/1790812800000-AddMessageWindowIndexes';

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
        `"mediaPath" varchar, "mediaMimetype" varchar, "engineRef" text, "echoOf" varchar, "status" varchar NOT NULL DEFAULT 'sent', ` +
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
      {
        findLidsForPhone: () => Promise.resolve([]),
        findPhoneForLid: () => Promise.resolve(null),
      } as unknown as LidMappingStoreService,
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

  it('applies fractional message-time bounds to bigint timestamps', async () => {
    const sessionId = 'sess-time-bounds';
    await repository.insert([
      ...Array.from({ length: 8 }, (_, i) => ({
        id: randomUUID(),
        sessionId,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        timestamp: 1000 + Math.floor(i / 2),
        type: 'image',
        direction: i % 2 ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      })),
      {
        id: randomUUID(),
        sessionId,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        type: 'image',
        direction: MessageDirection.INCOMING,
      },
      {
        id: randomUUID(),
        sessionId,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        type: 'text',
        direction: MessageDirection.INCOMING,
      },
    ]);
    for (const [until, timestamps] of [
      [1003000, [1002, 1001]],
      [1002000.5, [1002, 1001]],
      [1002000, [1001]],
    ] as const) {
      const page = await service.getMessages(sessionId, {
        since: 1000000.5,
        until,
        orderBy: 'timestamp',
        direction: MessageDirection.INCOMING,
        type: 'image',
        inlineMedia: false,
      });
      expect(page.total).toBe(timestamps.length);
      expect(page.unknownTimestampTotal).toBe(1);
      expect(page.messages.map(m => m.timestamp)).toEqual(timestamps);
    }
  });

  it('walks tied message times through reversible timestamp indexes', async () => {
    const sessionId = 'sess-time-walk';
    const runner = ds.createQueryRunner();
    const migration = new AddMessageWindowIndexes1790812800000();
    await migration.up(runner);
    await migration.up(runner);
    await repository.insert(
      Array.from({ length: 240 }, (_, i) => ({
        id: randomUUID(),
        sessionId,
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        timestamp: 1000 + Math.floor(i / 4),
      })),
    );
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await service.getMessages(sessionId, {
        since: 1000000,
        until: 1060000,
        orderBy: 'timestamp',
        after,
        limit: 31,
      });
      expect(page.total).toBe(240);
      ids.push(...page.messages.map(m => m.id));
      if (!after)
        await repository.insert({
          id: randomUUID(),
          sessionId,
          chatId: 'peer@c.us',
          from: 'peer@c.us',
          to: 'me@c.us',
          timestamp: 1060,
        });
      if (page.messages.length < 31) break;
      after = page.messages.at(-1)!.id;
    } while (ids.length < 300);
    expect(ids).toHaveLength(240);
    expect(new Set(ids).size).toBe(240);
    const names = async (): Promise<string[]> =>
      (
        (await runner.query(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' AND indexname LIKE 'IDX_messages_session_%timestamp_id'`,
        )) as Array<{ indexname: string }>
      ).map(row => row.indexname);
    expect(await names()).toHaveLength(3);
    await migration.down(runner);
    expect(await names()).toEqual([]);
    expect(await repository.countBy({ sessionId })).toBe(241);
    await migration.up(runner);
    expect(await names()).toHaveLength(3);
    await runner.release();
  });

  /**
   * A chat filter on a user id expands to several dialect candidates, which picks a SQLite-only sort
   * key there. PostgreSQL must keep the plain one, so the chat-filtered walk runs on the real server.
   */
  it('walks one chat by its several dialect candidates in the same total order', async () => {
    const served: string[] = [];
    for (let offset = 0; offset < ROWS; offset += PAGE * 10) {
      const { messages } = await service.getMessages(SESSION_ID, { chatId: 'peer@c.us', limit: PAGE, offset });
      served.push(...messages.map(m => m.id));
    }
    const unfiltered: string[] = [];
    for (let offset = 0; offset < ROWS; offset += PAGE * 10) {
      const { messages } = await service.getMessages(SESSION_ID, { limit: PAGE, offset });
      unfiltered.push(...messages.map(m => m.id));
    }

    expect(served).toHaveLength(ROWS / 10);
    expect(served).toEqual(unfiltered);
  });

  /**
   * The message-time order of a user chat keeps the plain sort key here, so the planner may read the
   * (sessionId, timestamp, id) index in order. The SQLite key, an expression over the column, leaves it
   * no ordered path: it must sort. The cost-based choice between the two depends on table statistics,
   * so the plan is read with sorting disabled for the planner, which makes the answer exact: a plain
   * key plans with no Sort node, an expression over the column cannot.
   */
  it('plans the message-time order of a user chat on the time index, with no sort step', async () => {
    const sessionId = 'sess-chat-plan';
    type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };
    const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
    const stored: Array<[string, number]> = [
      ['1001@c.us', 1000],
      ['1001@s.whatsapp.net', 1001],
      ['1001@c.us', 1002],
      ['2002@c.us', 1003],
    ];
    const builders = jest.spyOn(repository, 'createQueryBuilder');
    const runner = ds.createQueryRunner();
    try {
      await new AddMessageWindowIndexes1790812800000().up(runner);
      await repository.insert(
        stored.map(([chatId, timestamp]) => ({
          id: randomUUID(),
          sessionId,
          chatId,
          from: chatId,
          to: 'me@c.us',
          timestamp,
        })),
      );
      builders.mockClear();
      const page = await service.getMessages(sessionId, {
        chatId: '1001@c.us',
        orderBy: 'timestamp',
        since: 1000_000,
        until: 1060_000,
      });
      expect(page.messages.map(m => m.timestamp)).toEqual([1002, 1001, 1000]);

      // The first builder is the page statement itself, left in the state it was executed in.
      const [sql, params] = (builders.mock.results[0].value as SelectQueryBuilder<Message>).getQueryAndParameters();
      await runner.startTransaction();
      await runner.query('SET LOCAL enable_sort = off');
      const [{ 'QUERY PLAN': plans }] = (await runner.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)) as Array<{
        'QUERY PLAN': Array<{ Plan: PlanNode }>;
      }>;
      const nodes = planNodes(plans[0].Plan);

      expect(nodes.map(node => node['Index Name'])).toContain('IDX_messages_session_timestamp_id');
      expect(nodes.map(node => node['Node Type'])).not.toContain('Sort');
    } finally {
      builders.mockRestore();
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await repository.delete({ sessionId });
    }
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

  /**
   * The page is picked by id, sized by a raw `OCTET_LENGTH(metadata)` select and read back in chunks, so
   * the dialect SQL and the order restore after the IN read are only proven against the real server.
   */
  it('reads a media page in order and omits the payloads past the budget', async () => {
    const MEDIA_SESSION = 'sess-media-budget';
    const prev = process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
    process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = String(3000);
    try {
      await repository.insert(
        Array.from({ length: 6 }, (_, i) => ({
          id: randomUUID(),
          sessionId: MEDIA_SESSION,
          chatId: 'peer@c.us',
          from: 'peer@c.us',
          to: 'me@c.us',
          body: `media-${i}`,
          direction: MessageDirection.INCOMING,
          metadata: { media: { mimetype: 'image/jpeg', data: 'A'.repeat(1000) } },
          createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)),
        })),
      );

      const { messages, total } = await service.getMessages(MEDIA_SESSION, { limit: 100 });

      expect(total).toBe(6);
      expect(messages.map(m => m.body)).toEqual(['media-5', 'media-4', 'media-3', 'media-2', 'media-1', 'media-0']);
      const inline = messages.map(m => typeof (m.metadata as { media: { data?: unknown } }).media.data === 'string');
      expect(inline).toEqual([true, true, true, false, false, false]);
    } finally {
      if (prev === undefined) delete process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
      else process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = prev;
      await repository.delete({ sessionId: MEDIA_SESSION });
    }
  });
});
