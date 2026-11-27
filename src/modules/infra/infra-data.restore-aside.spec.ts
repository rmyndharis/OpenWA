import 'reflect-metadata';
import { AsyncResource } from 'async_hooks';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, type QueryRunner } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { InfraDataService, type InfraExportDataResult } from './infra-data.service';
import { readExport } from '../../../test/helpers/read-export';
import { createSqlitePrepareDatabase, type SqliteJournalMode } from '../../database/sqlite-pragmas';
import { LoggerService } from '../../common/services/logger.service';
import { ScrubRevokedMessageContent1786900000000 } from '../../database/migrations/1786900000000-ScrubRevokedMessageContent';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';

const ENTITIES = [
  Session,
  Webhook,
  Message,
  MessageBatch,
  Template,
  BaileysStoredMessage,
  LidMapping,
  ChatState,
  PluginInstance,
  ConversationMapping,
  IngressEvent,
  WebhookDeliveryFailure,
  WebhookOutboxEvent,
  IntegrationDeliveryFailure,
  StatusUpdate,
  AutomationRule,
  SendIdempotencyKey,
];

/** The messages the archive restores: enough for several chunks of rows. */
const ROWS = 1_200;

type Tables = InfraExportDataResult['tables'];
const config = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
const sessionsService = { getActiveSessionIds: () => [], forgetSession: jest.fn() };

/** Counts the turns the event loop takes until stopped. */
function countTurns(): { turns: () => number; stop: () => void } {
  let turns = 0;
  let on = true;
  const spin = (): void => {
    if (!on) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  return { turns: () => turns, stop: () => (on = false) };
}

/**
 * Runs `action` once, at the restore's first statement matching `sql` on its own connection, in the context of the
 * caller of this function: what another request or an engine event would issue meanwhile.
 */
function atRestoreStatement(ds: DataSource, sql: RegExp, action: () => void): () => QueryRunner | undefined {
  const outside = AsyncResource.bind(action);
  const restoreRunners: QueryRunner[] = [];
  const query = Reflect.get(BetterSqlite3QueryRunner.prototype, 'query') as (
    this: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
  jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
    this: BetterSqlite3QueryRunner,
    text: string,
    ...rest: unknown[]
  ) {
    if (this.connection !== ds && sql.test(text) && restoreRunners.length === 0) {
      restoreRunners.push(this);
      outside();
    }
    return query.call(this, text, ...rest) as never;
  });
  return () => restoreRunners[0];
}

describe.each<SqliteJournalMode>(['WAL', 'DELETE'])('a SQLite file restore (%s journal)', journal => {
  let dir: string;
  let file: string;
  let ds: DataSource;
  let archive: Tables;

  const open = (): Promise<DataSource> =>
    new DataSource({
      type: 'better-sqlite3',
      database: file,
      // Short, so a statement that met the restore's lock would fail the test instead of waiting it out.
      timeout: 1_500,
      prepareDatabase: createSqlitePrepareDatabase(file, journal),
      entities: ENTITIES,
      synchronize: true,
    }).initialize();
  const service = (overrides: { ownership?: object; lidMappingStore?: object } = {}): InfraDataService =>
    new InfraDataService(
      config as never,
      ds,
      undefined,
      sessionsService as never,
      overrides.lidMappingStore as never,
      overrides.ownership as never,
    );
  const names = async (): Promise<string[]> =>
    (await ds.getRepository(Session).find()).map(session => session.name).sort();
  const sharedRunner = (): QueryRunner => ds.createQueryRunner();
  const connection = (): { inTransaction: boolean; exec(sql: string): void } =>
    (ds.driver as unknown as { databaseConnection: { inTransaction: boolean; exec(sql: string): void } })
      .databaseConnection;
  /** The shared connection afterwards: nothing open, nothing held, a statement runs on the turn it is issued. */
  const expectReleased = async (): Promise<void> => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(sharedRunner().isTransactionActive).toBe(false);
    expect(connection().inTransaction).toBe(false);
    for (const method of ['query', 'startTransaction', 'connect'])
      expect(Object.hasOwn(sharedRunner(), method)).toBe(false);
    const ranAtOnce = await Promise.race([
      ds.query('SELECT 1').then(() => true),
      new Promise(resolve => setImmediate(() => resolve(false))),
    ]);
    expect(ranAtOnce).toBe(true);
  };

  beforeAll(async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'owa-restore-aside-'));
    file = join(dir, 'data.sqlite');
    ds = await open();
    await ds
      .getRepository(Session)
      .save({ id: 's1', name: 'restored', status: SessionStatus.DISCONNECTED, config: {} });
    const messages = Array.from({ length: ROWS }, (_, i) => ({
      id: `m-${i}`,
      sessionId: 's1',
      waMessageId: `WA-${i}`,
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628222@c.us',
      body: `restored ${i}`,
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000 + i,
    }));
    await ds.getRepository(Message).save(messages, { chunk: 200 });
    archive = (await readExport(service().exportData())).tables;
    await ds.destroy();
  });

  beforeEach(async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
    ds = await open();
    await ds.getRepository(Session).save({ id: 's0', name: 'before', status: SessionStatus.DISCONNECTED, config: {} });
    await ds.getRepository(Message).save({
      id: 'old',
      sessionId: 's0',
      waMessageId: 'WA-OLD',
      chatId: '628333@c.us',
      from: '628333@c.us',
      to: '628222@c.us',
      body: 'before',
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1_600_000_000,
    });
    sessionsService.forgetSession.mockClear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    await ds.destroy();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives the event loop several turns between two chunks of rows', async () => {
    const counter = countTurns();
    const turnsAtInsert: number[] = [];
    const query = Reflect.get(BetterSqlite3QueryRunner.prototype, 'query') as (
      this: unknown,
      ...args: unknown[]
    ) => Promise<unknown>;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      text: string,
      ...rest: unknown[]
    ) {
      if (this.connection !== ds && /^INSERT INTO "?messages/i.test(text)) turnsAtInsert.push(counter.turns());
      return query.call(this, text, ...rest) as never;
    });

    const result = await service().importData({ tables: archive });
    counter.stop();

    expect(result).toMatchObject({ imported: true, warnings: [] });
    expect(result.counts.messages).toBe(ROWS);
    // The rows of a chunk are inserted on one turn, so a step between two inserts is a chunk boundary. libuv takes
    // one new connection per turn, so a single turn there would let health probes queue for the whole restore.
    const steps = turnsAtInsert.slice(1).map((turns, i) => turns - turnsAtInsert[i]);
    const boundaries = steps.filter(step => step > 0);
    expect(boundaries).toHaveLength(Math.floor((ROWS + 1) / 500));
    expect(Math.min(...boundaries)).toBeGreaterThanOrEqual(16);
  });

  it.each([
    ['commits', false],
    ['rolls back', true],
  ])('that %s holds a read, a save and a transaction issued meanwhile, and they land after it', async (_case, fail) => {
    // A message row without its non-null columns, last: the restore inserts the others first, then rolls back.
    const tables = fail
      ? { ...archive, messages: [...(archive.messages ?? []), { id: 'bad', sessionId: 's1' } as never] }
      : archive;
    const outside: Promise<unknown>[] = [];
    let readSaw: string[] | undefined;
    let turnsAtIssue = 0;
    const counter = countTurns();
    // Issued once the restore has deleted the old rows and inserted some of the new ones.
    atRestoreStatement(ds, /^INSERT INTO "?messages/i, () => {
      turnsAtIssue = counter.turns();
      outside.push(
        ds
          .getRepository(Session)
          .find()
          .then(rows => (readSaw = rows.map(row => row.name).sort())),
        ds
          .getRepository(Session)
          .save({ id: 'x1', name: 'outside-save', status: SessionStatus.DISCONNECTED, config: {} }),
        ds.transaction(manager =>
          manager
            .getRepository(Session)
            .save({ id: 'x2', name: 'outside-transaction', status: SessionStatus.DISCONNECTED, config: {} }),
        ),
      );
    });

    const result = await service().importData({ tables });
    const turnsAtEnd = counter.turns();
    await Promise.all(outside);
    counter.stop();

    expect(outside).toHaveLength(3);
    expect(result.imported).toBe(!fail);
    // The event loop went on turning while they waited, and none of them met the restore's lock.
    expect(turnsAtEnd).toBeGreaterThan(turnsAtIssue);
    expect(readSaw).toEqual([fail ? 'before' : 'restored']);
    expect(await names()).toEqual([fail ? 'before' : 'restored', 'outside-save', 'outside-transaction'].sort());
    expect(await ds.getRepository(Message).count()).toBe(fail ? 1 : ROWS);
    await expectReleased();
  });

  it.each([
    ['the module is destroyed', 'destroy'],
    ['shutdown teardown has begun', 'teardown'],
  ] as const)('rolls back at its next chunk when %s, answering 503 IMPORT_STOPPED', async (_case, how) => {
    let tearingDown = false;
    const svc = new InfraDataService(
      config as never,
      ds,
      undefined,
      sessionsService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { isTearingDown: () => tearingDown } as never,
    );
    let restoreClosedAtStop: boolean | undefined;
    let stopped: Promise<void> | undefined;
    const held = atRestoreStatement(ds, /^INSERT INTO "?messages/i, () => {
      if (how === 'teardown') tearingDown = true;
      else {
        stopped = svc.onModuleDestroy().then(() => {
          restoreClosedAtStop = held()?.connection.isInitialized === false;
        });
      }
    });

    await expect(svc.importData({ tables: archive })).rejects.toMatchObject({
      status: 503,
      response: { code: 'IMPORT_STOPPED' },
    });
    await stopped;

    if (how === 'destroy') expect(restoreClosedAtStop).toBe(true);
    expect(await names()).toEqual(['before']);
    expect(await ds.getRepository(Message).count()).toBe(1);
    await expectReleased();
  });

  it('fails a statement issued on the shared connection from inside the restore, and rolls back', async () => {
    jest.spyOn(ScrubRevokedMessageContent1786900000000, 'scrub').mockImplementation(async () => {
      await ds.query('SELECT 1');
    });

    const result = await service().importData({ tables: archive });

    expect(result.imported).toBe(false);
    expect(result.warnings).toEqual(['Failed to clean restored rows: the restore must use its own connection']);
    expect(await names()).toEqual(['before']);
    await expectReleased();
  });

  it('reloads what it caches before a caller held meanwhile reads', async () => {
    const order: string[] = [];
    const lidMappingStore = {
      reload: async () => {
        await ds.query('SELECT 1');
        order.push('reload');
      },
    };
    atRestoreStatement(ds, /^INSERT INTO "?messages/i, () => {
      void ds.query('SELECT 2').then(() => order.push('held read'));
    });

    await service({ lidMappingStore }).importData({ tables: archive });
    await expectReleased();

    expect(order).toEqual(['reload', 'held read']);
  });

  it.each([
    [
      'a throw inside the transaction',
      () => ({
        ownership: {
          heldByOtherNodes: () => Promise.resolve([]),
          suspendLossDetection: () => () => undefined,
          claimableWhere: () => {
            throw new Error('claims unreadable');
          },
        },
      }),
      'claims unreadable',
    ],
    [
      'a BEGIN that fails',
      () => {
        const begin = Reflect.get(BetterSqlite3QueryRunner.prototype, 'startTransaction') as (
          this: BetterSqlite3QueryRunner,
          ...args: unknown[]
        ) => Promise<void>;
        jest.spyOn(BetterSqlite3QueryRunner.prototype, 'startTransaction').mockImplementation(function (
          this: BetterSqlite3QueryRunner,
          ...args
        ) {
          return this.connection === ds ? begin.apply(this, args) : Promise.reject(new Error('BEGIN failed'));
        });
        return {};
      },
      'BEGIN failed',
    ],
    [
      'a restore connection that does not open',
      () => {
        const initialize = Reflect.get<DataSource, 'initialize'>(DataSource.prototype, 'initialize');
        jest.spyOn(DataSource.prototype, 'initialize').mockImplementation(function (this: DataSource) {
          return this === ds ? initialize.call(this) : Promise.reject(new Error('cannot open'));
        });
        return {};
      },
      'cannot open',
    ],
  ])('lets the shared connection go after %s, with the data as it was', async (_case, arrange, message) => {
    const overrides = arrange();
    const held = atRestoreStatement(ds, /^DELETE FROM webhooks/i, () => undefined);

    await expect(service(overrides).importData({ tables: archive })).rejects.toThrow(message);

    expect(await names()).toEqual(['before']);
    await expectReleased();
    // A restore connection that opened was closed again.
    const runner = held();
    if (runner) expect(runner.connection.isInitialized).toBe(false);
  });

  it('refuses with 409 IMPORT_NESTED_TRANSACTION, deleting nothing, when a transaction stays open past the wait', async () => {
    // The transaction opens while the writes of the removed sessions drain, after the first check.
    const query = Reflect.get(BetterSqlite3QueryRunner.prototype, 'query') as (
      this: unknown,
      ...args: unknown[]
    ) => Promise<unknown>;
    let opened = false;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(async function (
      this: BetterSqlite3QueryRunner,
      text: string,
      ...rest: unknown[]
    ) {
      const result = (await query.call(this, text, ...rest)) as never;
      if (text === 'SELECT id FROM sessions' && !opened) {
        opened = true;
        connection().exec('BEGIN');
      }
      return result;
    });
    // The wait's ten seconds pass in a few of its checks.
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));

    await expect(service().importData({ tables: archive })).rejects.toMatchObject({
      status: 409,
      response: { code: 'IMPORT_NESTED_TRANSACTION' },
    });

    connection().exec('ROLLBACK');
    jest.mocked(Date.now).mockRestore();
    expect(await names()).toEqual(['before']);
    expect(await ds.getRepository(Message).count()).toBe(1);
    await expectReleased();
  });
});

describe('a restore into a database the second connection cannot reach', () => {
  it.each([':memory:', ''])('keeps the shared connection for %j', async database => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    const ds = await new DataSource({
      type: 'better-sqlite3',
      database,
      entities: ENTITIES,
      synchronize: true,
    }).initialize();
    try {
      await ds.getRepository(Session).save({ id: 's1', name: 'kept', status: SessionStatus.DISCONNECTED, config: {} });
      const tables = (await readExport(new InfraDataService(config as never, ds).exportData())).tables;
      const initialize = jest.spyOn(DataSource.prototype, 'initialize');

      const result = await new InfraDataService(config as never, ds, undefined, sessionsService as never).importData({
        tables,
      });

      expect(result).toMatchObject({ imported: true });
      expect(initialize).not.toHaveBeenCalled();
      expect((await ds.getRepository(Session).find()).map(session => session.name)).toEqual(['kept']);
    } finally {
      jest.restoreAllMocks();
      await ds.destroy();
    }
  });
});
