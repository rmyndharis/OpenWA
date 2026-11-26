import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { text } from 'stream/consumers';
import { setTimeout as pause } from 'timers/promises';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InfraDataService, newestFirstWindows, type InfraExportDataResult } from './infra-data.service';
import * as exportSnapshot from './export-snapshot';
import type { ExportSnapshot } from './export-snapshot';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';
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
import { SqlitePermissionsBoot } from '../../database/sqlite-file-permissions';

const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
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
type JournalMode = 'WAL' | 'DELETE' | 'memory';

let directory: string;
const databases: DataSource[] = [];

/** A database as the gateway opens it: a file in the given journal mode, or one in memory. */
const openDatabase = async (mode: JournalMode, busyTimeoutMs?: number): Promise<DataSource> => {
  const database = new DataSource({
    type: 'better-sqlite3',
    database: mode === 'memory' ? ':memory:' : path.join(directory, `data-${databases.length}.sqlite`),
    timeout: busyTimeoutMs,
    prepareDatabase: (db: { pragma: (source: string) => unknown }) => {
      if (mode !== 'memory') db.pragma(`journal_mode = ${mode}`);
    },
    entities: ENTITIES,
    synchronize: true,
  });
  databases.push(database);
  return database.initialize();
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-snapshot-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const database of databases.splice(0)) await database.destroy();
  fs.rmSync(directory, { recursive: true, force: true });
});

const seedSession = (ds: DataSource, id: string) =>
  ds.getRepository(Session).save(
    ds.getRepository(Session).create({
      id,
      name: `session-${id}`,
      status: SessionStatus.DISCONNECTED,
      phone: null,
      pushName: null,
      config: {},
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
    }),
  );

const photo = (bytes: number): Record<string, unknown> => ({
  media: { mimetype: 'image/jpeg', data: Buffer.alloc(bytes, 7).toString('base64') },
});

const message = (
  ds: DataSource,
  sessionId: string,
  index: number,
  body: string,
  metadata: Record<string, unknown> | null = null,
) =>
  ds.getRepository(Message).create({
    id: `m-${sessionId}-${String(index).padStart(5, '0')}`,
    sessionId,
    waMessageId: `WA-${sessionId}-${index}`,
    chatId: 'c1@s.whatsapp.net',
    from: 'a@s.whatsapp.net',
    to: 'b@s.whatsapp.net',
    body,
    type: metadata ? 'image' : 'text',
    direction: MessageDirection.INCOMING,
    timestamp: 1_700_000_000 + index,
    metadata: metadata as never,
    status: MessageStatus.DELIVERED,
  });

// insert() types its rows as partial entities, which a metadata bag does not satisfy.
const insertMessages = async (ds: DataSource, rows: Message[]) => {
  for (let from = 0; from < rows.length; from += 400) {
    await ds.getRepository(Message).insert(rows.slice(from, from + 400) as never[]);
  }
};

const seedDependents = async (ds: DataSource, sessionId: string) => {
  const webhooks = ds.getRepository(Webhook);
  await webhooks.save(
    webhooks.create({
      id: `w-${sessionId}`,
      sessionId,
      url: 'https://example.com/hook',
      events: ['message'],
      secret: null,
      headers: {},
      active: true,
      retryCount: 3,
    }),
  );
  const templates = ds.getRepository(Template);
  await templates.save(templates.create({ sessionId, name: 'hello', body: 'Hello', header: null, footer: null }));
  const chats = ds.getRepository(ChatState);
  await chats.save(chats.create({ sessionId, chatId: '628111@s.whatsapp.net', pinned: true }));
};

const outboxRow = (ds: DataSource, sessionId: string, index: number) =>
  ds.getRepository(WebhookOutboxEvent).create({
    webhookId: `w-${sessionId}`,
    sessionId,
    event: 'message.received',
    idempotencyKey: `key-${sessionId}-${index}`,
    deliveryId: `delivery-${sessionId}-${index}`,
    payload: null,
    state: 'dispatched',
  });

/** What a session delete does to the data database, in one transaction. */
const deleteSession = (ds: DataSource, id: string) =>
  ds.transaction(async manager => {
    await manager.delete(Message, { sessionId: id });
    await manager.delete(MessageBatch, { sessionId: id });
    await manager.delete(ChatState, { sessionId: id });
    await manager.delete(Webhook, { sessionId: id });
    await manager.delete(Template, { sessionId: id });
    await manager.delete(AutomationRule, { sessionId: id });
    await manager.delete(Session, { id });
  });

/** Every statement sent from now on, in order: through the DataSource, or prepared on any connection of its driver. */
const watchStatements = (ds: DataSource): (() => string[]) => {
  const log: string[] = [];
  const query = ds.query.bind(ds);
  jest.spyOn(ds, 'query').mockImplementation((...args: Parameters<DataSource['query']>) => {
    log.push(args[0]);
    return query(...args);
  });
  const connection = (ds.driver as unknown as { databaseConnection: object }).databaseConnection;
  const proto = Object.getPrototypeOf(connection) as { prepare: (sql: string) => unknown };
  const prepare = proto.prepare;
  jest.spyOn(proto, 'prepare').mockImplementation(function (this: unknown, sql: string) {
    log.push(sql);
    return prepare.call(this, sql);
  });
  return () => log;
};
const sawKeyRead = (log: string[]) => log.some(sql => sql.startsWith('SELECT id, "timestamp", OCTET_LENGTH'));
const sawSessionsRead = (log: string[]) => log.includes('SELECT * FROM sessions');
const sawMessageRows = (log: string[]) => log.some(sql => sql.startsWith('SELECT * FROM messages WHERE id IN'));

/**
 * Another request of the same process: it waits on turns of the event loop of its own, as a socket
 * event does, and writes on the first turn on which `ready` holds.
 */
const writerOnItsOwnTurn = (ready: () => boolean, write: () => Promise<unknown>) => {
  const state = { fired: false, stopped: false };
  const done = new Promise<void>((resolve, reject) => {
    const turn = (): void => {
      if (state.stopped) return resolve();
      if (!ready()) return void setImmediate(turn);
      state.fired = true;
      write().then(() => resolve(), reject);
    };
    setImmediate(turn);
  });
  return { state, done };
};

const exportOf = async (ds: DataSource): Promise<InfraExportDataResult> =>
  JSON.parse(await text(new InfraDataService(cfg as never, ds).exportData())) as InfraExportDataResult;

/** Export while `write` runs once the export has reached `ready`, and what was exported. */
const exportDuring = async (
  ds: DataSource,
  ready: (log: string[]) => boolean,
  write: () => Promise<unknown>,
): Promise<InfraExportDataResult> => {
  const statements = watchStatements(ds);
  const writer = writerOnItsOwnTurn(() => ready(statements()), write);
  const dump = await exportOf(ds);
  writer.state.stopped = true;
  await writer.done;
  expect(writer.state.fired).toBe(true);
  return dump;
};

/** The archive must be what an export taken before the write holds, and restore to exactly that. */
const expectArchiveOf = async (dump: InfraExportDataResult, before: InfraExportDataResult): Promise<void> => {
  expect(dump.counts).toEqual(before.counts);
  expect(dump.tables).toEqual(before.tables);
  const fresh = await openDatabase('memory');
  const restored = await new InfraDataService(cfg as never, fresh).importData(dump);
  expect(restored).toMatchObject({ imported: true, warnings: [] });
  expect((await exportOf(fresh)).tables).toEqual(before.tables);
};

const copiesIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter(name => name.startsWith('openwa-export-snapshot-'));

describe.each<JournalMode>(['WAL', 'DELETE', 'memory'])(
  'a data export of a %s database is a point-in-time copy',
  mode => {
    it('holds a session deleted while the media budget was being spent, with all of its rows', async () => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await seedSession(ds, 's2');
      await insertMessages(ds, [
        message(ds, 's1', 0, 'text'),
        message(ds, 's1', 1, 'text'),
        message(ds, 's2', 0, 'photo', photo(300)),
        message(ds, 's2', 1, 'text'),
        message(ds, 's2', 2, 'photo', photo(300)),
        message(ds, 's2', 3, 'text'),
        message(ds, 's2', 4, 'photo', photo(300)),
      ]);
      await seedDependents(ds, 's1');
      await seedDependents(ds, 's2');
      const before = await exportOf(ds);

      const dump = await exportDuring(
        ds,
        log => sawKeyRead(log) && !sawSessionsRead(log),
        () => deleteSession(ds, 's2'),
      );

      expect(dump.tables.sessions.map(session => session.id)).toEqual(['s1', 's2']);
      expect(dump.tables.messages).toHaveLength(7);
      await expectArchiveOf(dump, before);
      expect(await ds.getRepository(Session).count()).toBe(1);
    });

    it('holds the whole history of a session deleted while its messages were being written out', async () => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await seedSession(ds, 's2');
      await insertMessages(
        ds,
        Array.from({ length: 450 }, (_, i) => message(ds, 's2', i, 'text')),
      );
      await seedDependents(ds, 's1');
      await seedDependents(ds, 's2');
      const before = await exportOf(ds);

      const dump = await exportDuring(
        ds,
        log => sawSessionsRead(log) && sawMessageRows(log),
        () => deleteSession(ds, 's2'),
      );

      expect(dump.tables.messages.filter(row => row.sessionId === 's2')).toHaveLength(450);
      expect(dump.tables.templates.map(row => row.sessionId)).toEqual(['s1', 's2']);
      await expectArchiveOf(dump, before);
    });

    it('holds nothing of a session created while the messages were being written out', async () => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await insertMessages(
        ds,
        Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'text')),
      );
      const before = await exportOf(ds);

      const dump = await exportDuring(
        ds,
        log => sawSessionsRead(log) && sawMessageRows(log),
        async () => {
          await seedSession(ds, 's3');
          await seedDependents(ds, 's3');
          await ds.getRepository(WebhookOutboxEvent).save(outboxRow(ds, 's3', 0));
        },
      );

      expect(dump.tables.chatStates).toEqual([]);
      expect(dump.tables.webhookOutboxEvents).toEqual([]);
      await expectArchiveOf(dump, before);
    });

    it('lets the shared connection write while a download holds the snapshot, and stamps the snapshot', async () => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await insertMessages(
        ds,
        Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
      );
      const started = Date.now();
      const pieces = new InfraDataService(cfg as never, ds).exportData();
      const first = await pieces.next();
      const snapshotTaken = Date.now();
      // What the copy of a database that is not in WAL mode costs, and where it goes. One in memory
      // is copied to the temp directory, which other test processes share, so it is not counted.
      if (mode !== 'memory') expect(copiesIn(directory)).toHaveLength(mode === 'WAL' ? 0 : 1);

      // A reader holding a transaction on a rollback-journal database would refuse these as busy.
      await insertMessages(ds, [message(ds, 's1', 9000, 'arrived during the download')]);
      await ds.transaction(manager => manager.delete(Message, { id: 'm-s1-00000' }));

      let document = String(first.value);
      for await (const piece of pieces) document += piece;
      const dump = JSON.parse(document) as InfraExportDataResult;
      expect(dump.tables.messages.map(row => row.id)).toContain('m-s1-00000');
      expect(dump.tables.messages.map(row => row.id)).not.toContain('m-s1-09000');
      expect(dump.counts.messages).toBe(450);
      const exportedAt = Date.parse(dump.exportedAt);
      expect(exportedAt).toBeGreaterThanOrEqual(started);
      expect(exportedAt).toBeLessThanOrEqual(snapshotTaken);
      expect(await ds.getRepository(Message).count()).toBe(450);
      if (mode !== 'memory') expect(copiesIn(directory)).toEqual([]);
    });

    it('is stamped with the instant of its snapshot, not that of a later read', async () => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await insertMessages(ds, [message(ds, 's1', 0, 'photo', photo(300))]);
      const opened = Date.parse('2026-01-01T00:00:00.000Z');
      // Only the clock: the export and the writer still take real turns of the event loop.
      jest.useFakeTimers({
        now: opened,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      let dump: InfraExportDataResult;
      try {
        dump = await exportDuring(
          ds,
          log => sawKeyRead(log) && !sawSessionsRead(log),
          async () => {
            jest.setSystemTime(opened + 60_000);
            await insertMessages(ds, [message(ds, 's1', 1, 'sent a minute after the snapshot')]);
          },
        );
      } finally {
        jest.useRealTimers();
      }

      expect(dump.exportedAt).toBe(new Date(opened).toISOString());
      expect(dump.tables.messages.map(row => row.id)).toEqual(['m-s1-00000']);
    });
  },
);

type Progress = (info: { totalPages: number; remainingPages: number }) => number;
/** The online backup the copy is written with, one page a step, with `step` called before each of its own. */
const copyPageByPage = (ds: DataSource, step: (info: { totalPages: number }) => void): void => {
  const connection = (
    ds.driver as unknown as {
      databaseConnection: { backup: (file: string, options: { progress: Progress }) => Promise<unknown> };
    }
  ).databaseConnection;
  const backup = connection.backup.bind(connection);
  jest.spyOn(connection, 'backup').mockImplementation((file, options) =>
    backup(file, {
      progress: info => {
        step(info);
        options.progress(info);
        return 1;
      },
    }),
  );
};

describe('the copy a data export reads when the database is not in WAL mode', () => {
  const copyMode = (file: string): number => fs.statSync(file).mode & 0o777;

  it('is private to its owner, and is removed when the export fails or is abandoned', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
    );
    const service = new InfraDataService(cfg as never, ds);

    const abandoned = service.exportData();
    await abandoned.next();
    const [copy] = copiesIn(directory);
    expect(copyMode(path.join(directory, copy))).toBe(0o600);
    await abandoned.return();
    expect(copiesIn(directory)).toEqual([]);

    const connection = (ds.driver as unknown as { databaseConnection: object }).databaseConnection;
    const proto = Object.getPrototypeOf(connection) as { prepare: (sql: string) => unknown };
    const prepare = proto.prepare;
    jest.spyOn(proto, 'prepare').mockImplementation(function (this: unknown, sql: string) {
      if (sql.startsWith('SELECT * FROM messages WHERE id IN')) throw new Error('SQLITE_IOERR: disk I/O error');
      return prepare.call(this, sql);
    });
    await expect(text(service.exportData())).rejects.toThrow(/disk I\/O error/);
    expect(copiesIn(directory)).toEqual([]);
  });

  /** A write transaction on the shared connection, held open until `commit`. */
  const holdWriteTransaction = async (ds: DataSource): Promise<{ commit: () => Promise<void> }> => {
    let commit!: () => void;
    const held = new Promise<void>(resolve => (commit = resolve));
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    const writing = ds.transaction(async manager => {
      await manager.query(`UPDATE sessions SET name = 'renamed' WHERE id = 's1'`);
      entered();
      await held;
    });
    await inside;
    return { commit: () => (commit(), writing) };
  };

  // A first backup step the source refuses (inside a write transaction, or locked by another process) reports
  // no pages, and better-sqlite3 takes that for a finished copy: the export read an empty database.
  it.each(['DELETE', 'memory'] as const)(
    'waits out a write transaction on the shared connection instead of reading an empty copy (%s)',
    async mode => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      const transaction = await holdWriteTransaction(ds);
      let opened = false;
      const opening = exportSnapshot.openExportSnapshot(ds).then(snapshot => {
        opened = true;
        return snapshot;
      });
      opening.catch(() => undefined);
      await pause(200);
      expect(opened).toBe(false);

      await transaction.commit();
      const snapshot = await opening;
      await expect(snapshot.query('SELECT name FROM sessions')).resolves.toEqual([{ name: 'renamed' }]);
      await snapshot.close(true);
    },
  );

  it('gives up the wait for a write transaction when the request goes away, and removes the copy', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    const transaction = await holdWriteTransaction(ds);
    const request = new AbortController();
    const opening = exportSnapshot.openExportSnapshot(ds, request.signal);
    opening.catch(() => undefined);
    await pause(100);

    request.abort(new Error('the client went away'));

    await expect(opening).rejects.toThrow('the client went away');
    expect(fs.readdirSync(directory).filter(name => name.startsWith('openwa-export-snapshot-'))).toEqual([]);
    await transaction.commit();
  });

  it('ends the copy, and removes it, when the request goes away while it is written', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
    );
    const gone = new AbortController();
    let steps = 0;
    let pages = 0;
    copyPageByPage(ds, info => {
      steps += 1;
      pages = info.totalPages;
      gone.abort(new Error('the client went away'));
    });

    const answer = await new InfraDataService(cfg as never, ds)
      .exportData({ signal: gone.signal })
      .next()
      .catch((error: unknown) => error);

    expect(answer).toMatchObject({ message: 'the client went away' });
    expect(copiesIn(directory)).toEqual([]);
    expect(steps).toBeLessThan(pages);
  });

  it('refuses, before reading anything, an export whose copy has no room, and says how much it needs', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    const real = fs.promises.statfs.bind(fs.promises);
    const statfs = jest.spyOn(fs.promises, 'statfs').mockImplementation(async (target, options) => ({
      ...(await real(target, options as never)),
      bavail: 1,
      bsize: 4096,
    }));

    const refusal = await new InfraDataService(cfg as never, ds)
      .exportData()
      .next()
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      status: 507,
      response: {
        code: 'EXPORT_NO_ROOM_FOR_SNAPSHOT',
        message: expect.stringMatching(
          /needs \d+ bytes in .*owa-export-snapshot-.*, where 4096 are free.*scripts\/backup\.sh/,
        ) as never,
      },
    });
    expect(copiesIn(directory)).toEqual([]);
    // The refused export does not count as running.
    statfs.mockRestore();
    await expect(exportOf(ds)).resolves.toMatchObject({ counts: { sessions: 1 } });
  });

  it('leaves the live database room to go on writing beside the copy, and names both figures', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    const [{ page_count: pages }] = await ds.query<Array<{ page_count: number }>>('PRAGMA page_count');
    const [{ page_size: pageSize }] = await ds.query<Array<{ page_size: number }>>('PRAGMA page_size');
    const copy = pages * pageSize;
    const MiB = 1024 * 1024;
    const real = fs.promises.statfs.bind(fs.promises);
    let free = 0;
    jest.spyOn(fs.promises, 'statfs').mockImplementation(async (target, options) => ({
      ...(await real(target, options as never)),
      bavail: free / 4096,
      bsize: 4096,
    }));
    const refusalWith = async (freeBytes: number): Promise<unknown> => {
      free = freeBytes;
      return new InfraDataService(cfg as never, ds)
        .exportData()
        .next()
        .catch((error: unknown) => error);
    };

    // A copy that fits, but leaves the database 200 MiB to write into for as long as the download runs.
    await expect(refusalWith(copy + 200 * MiB)).resolves.toMatchObject({
      status: 507,
      response: {
        code: 'EXPORT_NO_ROOM_FOR_SNAPSHOT',
        message:
          `The export reads from a copy of the database, which needs ${copy} bytes in ${directory} and leaves ` +
          `${256 * MiB} more free there for the database to go on writing, where ${copy + 200 * MiB} are free. ` +
          'Free that much space, or back the database up with scripts/backup.sh instead.',
      },
    });
    expect(copiesIn(directory)).toEqual([]);
    free = copy + 256 * MiB;
    await expect(exportOf(ds)).resolves.toMatchObject({ counts: { sessions: 1 } });

    // Above 2.5 GiB the room left is a tenth of the database.
    const connection = (ds.driver as unknown as { databaseConnection: { pragma: (...args: unknown[]) => unknown } })
      .databaseConnection;
    const pragma = connection.pragma.bind(connection);
    jest
      .spyOn(connection, 'pragma')
      .mockImplementation((source, ...rest) => (source === 'page_count' ? 1_000_000 : pragma(source, ...rest)));
    const large = 1_000_000 * pageSize;
    await expect(refusalWith(large + 300 * MiB)).resolves.toMatchObject({
      status: 507,
      response: {
        message: expect.stringContaining(`needs ${large} bytes in ${directory} and leaves ${large / 10} more`) as never,
      },
    });
  });

  it('removes at boot the copies an export left when its process died, and nothing else', async () => {
    const ds = await openDatabase('DELETE');
    const left = path.join(directory, 'openwa-export-snapshot-0b0e7c1e-5a55-4b7c-9d8e-1f2a3b4c5d6e.sqlite');
    const other = path.join(directory, 'openwa-export-snapshot-notes.txt');
    for (const file of [left, `${left}-journal`, other]) fs.writeFileSync(file, 'x');

    await new InfraDataService(cfg as never, ds).onApplicationBootstrap();

    expect(fs.readdirSync(directory).sort()).toEqual(['data-0.sqlite', 'openwa-export-snapshot-notes.txt']);
  });

  it('boots all the same when a leftover cannot be removed, and still removes the others', async () => {
    const ds = await openDatabase('DELETE');
    // A directory under a copy's name: unlink refuses it.
    const stuck = path.join(directory, 'openwa-export-snapshot-11111111-1111-4111-8111-111111111111.sqlite');
    const left = path.join(directory, 'openwa-export-snapshot-22222222-2222-4222-8222-222222222222.sqlite');
    fs.mkdirSync(stuck);
    fs.writeFileSync(left, 'x');

    await expect(new InfraDataService(cfg as never, ds).onApplicationBootstrap()).resolves.toBeUndefined();

    expect(fs.existsSync(left)).toBe(false);
    expect(fs.existsSync(stuck)).toBe(true);
  });

  it.each([
    ['SQLITE_FULL', { status: 507, response: { code: 'EXPORT_NO_ROOM_FOR_SNAPSHOT' } }],
    ['SQLITE_IOERR', { code: 'SQLITE_IOERR' }],
  ])('removes a copy that failed while it was written (%s), and answers for what failed', async (code, answer) => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    const connection = (ds.driver as unknown as { databaseConnection: { backup: () => Promise<unknown> } })
      .databaseConnection;
    jest.spyOn(connection, 'backup').mockRejectedValue(Object.assign(new Error('the copy failed'), { code }));

    const failure = await new InfraDataService(cfg as never, ds)
      .exportData()
      .next()
      .catch((error: unknown) => error);

    expect(failure).toMatchObject(answer);
    expect(copiesIn(directory)).toEqual([]);
  });
});

describe('the connection a data export reads a WAL database through', () => {
  it('is closed again when its snapshot cannot be taken', async () => {
    const ds = await openDatabase('WAL');
    await seedSession(ds, 's1');
    const connection = (ds.driver as unknown as { databaseConnection: object }).databaseConnection;
    const proto = Object.getPrototypeOf(connection) as { exec: (sql: string) => unknown; close: () => unknown };
    const exec = proto.exec;
    jest.spyOn(proto, 'exec').mockImplementation(function (this: unknown, sql: string) {
      if (sql === 'BEGIN' && this !== connection) throw new Error('SQLITE_BUSY: database is locked');
      return exec.call(this, sql);
    });
    const close = jest.spyOn(proto, 'close');

    await expect(text(new InfraDataService(cfg as never, ds).exportData())).rejects.toThrow(/database is locked/);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.contexts[0]).not.toBe(connection);
  });
});

describe('how a data export reads its tables', () => {
  /** Wraps the snapshot an export opens and notes how many rows each of its reads returned. */
  const watchReads = (): Array<{ sql: string; rows: number }> => {
    const reads: Array<{ sql: string; rows: number }> = [];
    const open = exportSnapshot.openExportSnapshot;
    jest.spyOn(exportSnapshot, 'openExportSnapshot').mockImplementation(async dataSource => {
      const snapshot = await open(dataSource);
      const watched: ExportSnapshot = {
        ...snapshot,
        query: async <T = unknown[]>(sql: string, params?: unknown[]) => {
          const rows = await snapshot.query<T>(sql, params);
          reads.push({ sql, rows: (rows as unknown[]).length });
          return rows;
        },
        scan: async (sql: string, rows: number) => {
          const batches = await snapshot.scan(sql, rows);
          return (async function* () {
            for await (const batch of batches) {
              reads.push({ sql, rows: batch.length });
              yield batch;
            }
          })();
        },
      };
      return watched;
    });
    return reads;
  };

  it('reads every table in batches, never one whole', async () => {
    const ds = await openDatabase('WAL');
    await seedSession(ds, 's1');
    await seedDependents(ds, 's1');
    const outbox = ds.getRepository(WebhookOutboxEvent);
    for (let from = 0; from < 2600; from += 100) {
      await outbox.insert(Array.from({ length: 100 }, (_, i) => outboxRow(ds, 's1', from + i)) as never[]);
    }
    await insertMessages(
      ds,
      Array.from({ length: 2600 }, (_, i) => message(ds, 's1', i, 'text', i % 2 ? { ack: 2 } : null)),
    );
    const reads = watchReads();

    const dump = await exportOf(ds);

    expect(dump.counts).toMatchObject({ webhookOutboxEvents: 2600, messages: 2600 });
    expect(dump.tables.webhookOutboxEvents.map(row => row.idempotencyKey)).toEqual(
      Array.from({ length: 2600 }, (_, i) => `key-s1-${i}`),
    );
    const largest = (table: string): number =>
      Math.max(...reads.filter(read => read.sql.includes(` FROM ${table}`)).map(read => read.rows));
    // 2,600 rows in each: one read of either would be 2,600 rows.
    expect(largest('webhook_outbox_events')).toBeLessThanOrEqual(1000);
    expect(largest('messages')).toBeLessThanOrEqual(1000);
    expect(reads.filter(read => read.sql.includes(' FROM webhook_outbox_events')).length).toBeGreaterThan(2);
    // Half of the messages carry nothing to spend the budget on. Their keys come back in the batches
    // too: left to the database to pass over, a history without media would be walked in one step.
    const budgetKeys = reads.filter(read => read.sql.startsWith('SELECT id, "timestamp", OCTET_LENGTH'));
    expect(budgetKeys.map(read => read.rows)).toEqual([1000, 1000, 600]);
  });

  it('gives up a turn of the event loop after every read, as nothing else would on SQLite', async () => {
    const ds = await openDatabase('WAL');
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 900 }, (_, i) => message(ds, 's1', i, 'text')),
    );
    const snapshot = await exportSnapshot.openExportSnapshot(ds);
    let turns = 0;
    let counting = true;
    const count = (): void => {
      turns++;
      if (counting) setImmediate(count);
    };
    setImmediate(count);

    for (let i = 0; i < 20; i++) await snapshot.query('SELECT id FROM messages WHERE id IN (?)', ['m-s1-00001']);
    const afterQueries = turns;
    let batches = 0;
    for await (const batch of await snapshot.scan('SELECT id FROM messages', 100)) batches += batch.length / 100;
    counting = false;
    await snapshot.close(true);

    expect(afterQueries).toBeGreaterThanOrEqual(20);
    expect(batches).toBe(9);
    expect(turns - afterQueries).toBeGreaterThanOrEqual(8);
  });
});

describe('newestFirstWindows', () => {
  type Key = { id: string; payloadBytes: number; timestamp: unknown };
  const windowsOf = async (
    keys: Key[],
    window: number,
    batch = 7,
  ): Promise<{ ids: string[]; scans: number; largest: number }> => {
    let scans = 0;
    const scan = (): Promise<AsyncIterable<unknown[]>> => {
      scans++;
      return Promise.resolve(
        (async function* () {
          for (let from = 0; from < keys.length; from += batch)
            yield await Promise.resolve(keys.slice(from, from + batch));
        })(),
      );
    };
    const ids: string[] = [];
    let largest = 0;
    for await (const keys of newestFirstWindows(scan, key => Number((key as Key).timestamp), window)) {
      largest = Math.max(largest, keys.length);
      ids.push(...keys.map(key => String(key.id)));
    }
    return { ids, scans, largest };
  };

  it('hands on the keys in the order one stable sort of all of them gives, a window at a time', async () => {
    // Recencies repeat, so most keys tie with others, and some have none that can be read.
    const keys: Key[] = Array.from({ length: 500 }, (_, i) => ({
      id: `k${i}`,
      payloadBytes: 1 + (i % 9),
      timestamp: i % 23 === 0 ? null : i % 29 === 0 ? 'not-a-number' : 1_700_000_000 + ((i * 7919) % 40),
    }));
    const recency = (key: Key): number => (Number.isFinite(Number(key.timestamp)) ? Number(key.timestamp) : 0);
    const sorted = [...keys].sort((a, b) => recency(b) - recency(a)).map(key => key.id);

    for (const window of [1, 3, 64, 499, 500, 10_000]) {
      const result = await windowsOf(keys, window);
      expect(result.ids).toEqual(sorted);
      expect(result.largest).toBeLessThanOrEqual(window);
      // One read of the keys per window.
      expect(result.scans).toBe(Math.max(1, Math.ceil(500 / window)));
    }
  });

  it('reads the keys once and hands on nothing for a table without payloads', async () => {
    await expect(windowsOf([], 100)).resolves.toEqual({ ids: [], scans: 1, largest: 0 });
  });
});

describe('what a data export holds while it runs', () => {
  it('refuses a second export while the first is still being downloaded, and takes one after it', async () => {
    const ds = await openDatabase('WAL');
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
    );
    const service = new InfraDataService(cfg as never, ds);
    const first = service.exportData();
    await first.next();

    const refusal = await service
      .exportData()
      .next()
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({ status: 409, response: { code: 'EXPORT_IN_PROGRESS' } });
    // The refusal did not end the export that was running.
    await expect(service.importData({ tables: {} })).rejects.toMatchObject({
      response: { code: 'EXPORT_IN_PROGRESS' },
    });
    await text(first);
    await expect(text(service.exportData())).resolves.toContain('"counts":{"sessions":1,');
  });

  it('counts the payload a row lost when the budget kept another payload of the same row', async () => {
    const ds = await openDatabase('WAL');
    await seedSession(ds, 's1');
    const batches = ds.getRepository(MessageBatch);
    await batches.save(
      batches.create({
        id: 'b1',
        batchId: 'BATCH-1',
        sessionId: 's1',
        status: BatchStatus.PROCESSING,
        messages: [
          { chatId: 'c1', type: 'image', content: { image: { base64: 'A'.repeat(40), mimetype: 'image/png' } } },
          { chatId: 'c2', type: 'image', content: { image: { base64: 'B'.repeat(40), mimetype: 'image/png' } } },
        ] as never,
        options: null as never,
        progress: null as never,
        results: null as never,
        currentIndex: 0,
        startedAt: null,
        completedAt: null,
      }),
    );
    const previous = process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
    process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = '50';
    let dump: InfraExportDataResult;
    try {
      dump = await exportOf(ds);
    } finally {
      if (previous === undefined) delete process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
      else process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = previous;
    }

    const [first, second] = JSON.parse(String(dump.tables.messageBatches[0].messages)) as Array<{
      content: { image: { base64?: string } };
    }>;
    expect(first.content.image.base64).toBe('A'.repeat(40));
    expect(second.content.image).not.toHaveProperty('base64');
    expect(dump.omittedInlineMedia).toEqual({ messages: 0, messageBatches: 1 });
  });
});

describe('a data export snapshot closed while a table is being read', () => {
  it.each<JournalMode>(['WAL', 'DELETE', 'memory'])(
    'fails the read it was in on a %s database, instead of ending the table early',
    async mode => {
      const ds = await openDatabase(mode);
      await seedSession(ds, 's1');
      await insertMessages(
        ds,
        Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x')),
      );
      const snapshot = await exportSnapshot.openExportSnapshot(ds);
      const scan = await snapshot.scan('SELECT * FROM messages', 200);
      expect((await scan.next()).value).toHaveLength(200);

      await snapshot.close(false);

      // A table that ended here would close a complete-looking archive without its last rows.
      await expect(scan.next()).rejects.toThrow(/closed/);
      await expect(snapshot.query('SELECT 1')).rejects.toThrow(/closed/);
    },
  );
});

describe('a data export running when the gateway stops', () => {
  it('lets the shutdown checkpoint of a WAL database complete at once, and fails the download', async () => {
    // The gateway's data connection waits 30 s on a busy database; a shorter wait keeps a failure short.
    const ds = await openDatabase('WAL', 3000);
    const file = String(ds.options.database);
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
    );
    const app = await Test.createTestingModule({
      providers: [
        InfraDataService,
        SqlitePermissionsBoot,
        { provide: ConfigService, useValue: cfg },
        { provide: getDataSourceToken('data'), useValue: ds },
      ],
    }).compile();
    await app.init();
    const download = app.get(InfraDataService).exportData();
    try {
      await download.next();
      // Written after the snapshot: frames its reader keeps the checkpoint from moving back.
      await insertMessages(
        ds,
        Array.from({ length: 450 }, (_, i) => message(ds, 's1', 450 + i, 'y'.repeat(300))),
      );
      const checkpoints: unknown[] = [];
      const query = ds.query.bind(ds);
      jest.spyOn(ds, 'query').mockImplementation(async (...args: Parameters<DataSource['query']>) => {
        const result: unknown = await query(...args);
        if (String(args[0]).includes('wal_checkpoint')) checkpoints.push(result);
        return result;
      });

      const started = Date.now();
      // Every hook, in the order Nest runs them on a stop or a restart.
      await app.close();
      const took = Date.now() - started;

      expect(checkpoints).toEqual([[expect.objectContaining({ busy: 0 })]]);
      const [[row]] = checkpoints as Array<Array<{ log: number; checkpointed: number }>>;
      expect(row.checkpointed).toBe(row.log);
      expect(took).toBeLessThan(1000);
      expect(fs.statSync(`${file}-wal`).size).toBe(0);
      await expect(text(download)).rejects.toThrow(/closed/);
    } finally {
      await download.return();
    }
    // As the data connection closes last on a stop.
    await databases.splice(databases.indexOf(ds), 1)[0].destroy();
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
  }, 20000);

  const gatewayOn = async (ds: DataSource) => {
    const app = await Test.createTestingModule({
      providers: [
        InfraDataService,
        SqlitePermissionsBoot,
        { provide: ConfigService, useValue: cfg },
        { provide: getDataSourceToken('data'), useValue: ds },
      ],
    }).compile();
    await app.init();
    return app;
  };

  it('ends the copy of a database not in WAL mode at once, removes it, and refuses the export', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    await insertMessages(
      ds,
      Array.from({ length: 450 }, (_, i) => message(ds, 's1', i, 'x'.repeat(300))),
    );
    const app = await gatewayOn(ds);
    let steps = 0;
    let pages = 0;
    let stopping: Promise<void> | undefined;
    copyPageByPage(ds, info => {
      steps += 1;
      pages = info.totalPages;
      // The stop comes while the first pages are being copied.
      stopping ??= app.close();
    });

    const started = Date.now();
    const answer = await app
      .get(InfraDataService)
      .exportData()
      .next()
      .catch((error: unknown) => error);
    await stopping;
    const took = Date.now() - started;

    expect(answer).toMatchObject({ status: 503, response: { code: 'EXPORT_STOPPED' } });
    expect(copiesIn(directory)).toEqual([]);
    // The stop did not wait for the copy to be written to its end.
    expect(steps).toBeLessThan(pages);
    expect(took).toBeLessThan(1000);
  });

  it('closes once a snapshot that finished opening as the gateway stopped, and fails the export', async () => {
    const ds = await openDatabase('DELETE');
    await seedSession(ds, 's1');
    const app = await gatewayOn(ds);
    const open = exportSnapshot.openExportSnapshot;
    let closes = 0;
    let stopping: Promise<void> | undefined;
    jest.spyOn(exportSnapshot, 'openExportSnapshot').mockImplementation(async (...args) => {
      const snapshot = await open(...args);
      stopping = app.close();
      const close = snapshot.close.bind(snapshot);
      return {
        ...snapshot,
        close: (completed: boolean) => {
          closes += 1;
          return close(completed);
        },
      };
    });

    const answer = await app
      .get(InfraDataService)
      .exportData()
      .next()
      .catch((error: unknown) => error);
    await stopping;

    expect(answer).toMatchObject({ status: 503, response: { code: 'EXPORT_STOPPED' } });
    expect(closes).toBe(1);
    expect(copiesIn(directory)).toEqual([]);
  });
});
