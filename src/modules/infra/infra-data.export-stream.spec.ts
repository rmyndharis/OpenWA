import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import { text } from 'stream/consumers';
import { setTimeout as pause } from 'timers/promises';
import type { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InfraDataController } from './infra-data.controller';
import { InfraDataService, type InfraExportDataResult } from './infra-data.service';
import { BaileysMessageStoreService } from '../../engine/adapters/baileys-message-store.service';
import { ChatStateStoreService } from '../../engine/adapters/baileys-chat-state-store.service';
import { EXPORT_TABLES } from './export-tables';
import { AuditAction } from '../audit/entities/audit-log.entity';
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
import { waitUntil } from '../../../test/helpers/wait-until';

// Thousands of real SQLite rows pass the socket in some tests, so their time grows with a slower or busier runner.
jest.setTimeout(30_000);

// The export used to be built whole and serialized once, so its memory grew with the message history
// and a large one failed outright. These tests drive the route over a real socket against real SQLite,
// a file in WAL mode as the gateway opens it.
describe('GET /infra/export-data over HTTP', () => {
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  let ds: DataSource;
  let service: InfraDataService;
  const auditLog = { logInfo: jest.fn() };
  let app: INestApplication;
  let port: number;
  const databases: DataSource[] = [];
  let directory: string;

  const openDatabase = async (): Promise<DataSource> => {
    const database = new DataSource({
      type: 'better-sqlite3',
      database: path.join(directory, `data-${databases.length}.sqlite`),
      prepareDatabase: (db: { pragma: (source: string) => unknown }) => void db.pragma('journal_mode = WAL'),
      entities: [
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
      ],
      synchronize: true,
    });
    databases.push(database);
    return database.initialize();
  };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-stream-'));
    ds = await openDatabase();
    auditLog.logInfo.mockReset().mockResolvedValue(null);
    service = new InfraDataService(cfg as never, ds, auditLog as never);
    const moduleRef = await Test.createTestingModule({
      controllers: [InfraDataController],
      providers: [{ provide: InfraDataService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    for (const database of databases.splice(0)) await database.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const seedSession = (id: string, proxyUrl: string | null = null) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.DISCONNECTED,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  const message = (index: number, body: string, metadata: Record<string, unknown> | null = null) =>
    ds.getRepository(Message).create({
      id: `m-${String(index).padStart(5, '0')}`,
      sessionId: 's1',
      waMessageId: `WA-${index}`,
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
  const insertMessages = (rows: Message[]) => ds.getRepository(Message).insert(rows as never[]);

  // About 36 MB of text rows, more than the socket buffers between server and client hold, read 200 rows at a time.
  const HISTORY_ROWS = 6000;
  const HISTORY_READS = HISTORY_ROWS / 200;
  const seedHistory = async (rows: number, bodyChars: number): Promise<void> => {
    for (let from = 0; from < rows; from += 500) {
      await insertMessages(
        Array.from({ length: Math.min(500, rows - from) }, (_, i) => message(from + i, 'x'.repeat(bodyChars))),
      );
    }
  };

  /** Has a statement the export prepares fail, on whichever connection it reads through. */
  const failStatement = (failure: (sql: string) => Error | undefined): void => {
    const connection = (ds.driver as unknown as { databaseConnection: object }).databaseConnection;
    const proto = Object.getPrototypeOf(connection) as { prepare: (sql: string) => unknown };
    const prepare = proto.prepare;
    jest.spyOn(proto, 'prepare').mockImplementation(function (this: unknown, sql: string) {
      const error = failure(sql);
      if (error) throw error;
      return prepare.call(this, sql);
    });
  };

  /** Full-row reads of the messages table made so far. The read numbered `failOn` fails. */
  const watchMessageReads = (failOn?: number): (() => number) => {
    let reads = 0;
    failStatement(sql =>
      sql.startsWith('SELECT * FROM messages WHERE id IN') && ++reads === failOn
        ? new Error('SQLITE_IOERR: disk I/O error')
        : undefined,
    );
    return () => reads;
  };

  const open = async (path = '/infra/export-data'): Promise<http.IncomingMessage> => {
    const request = http.get({ host: '127.0.0.1', port, path, agent: false });
    const [response] = (await once(request, 'response')) as [http.IncomingMessage];
    // A connection reset after the headers is reported on the request as well as on the response.
    request.on('error', () => undefined);
    return response;
  };

  /** What the audit trail holds about exports, each as the metadata recorded for it. */
  const recordedExports = (): Array<{ counts: Record<string, number>; incomplete?: boolean }> =>
    (auditLog.logInfo.mock.calls as Array<[AuditAction, { metadata: never }]>)
      .filter(([action]) => action === AuditAction.INFRA_DATA_EXPORTED)
      .map(([, context]) => context.metadata);

  /**
   * A download by a client in a process of its own, as every real one is, and what it saw of the
   * connection. A client sharing this event loop does not always see a reset: with the server closing
   * its socket in the same loop, about one in four went unnoticed on macOS.
   */
  // These tests move megabytes through SQLite and a client process of its own, and one of them ran past
  // the default 5 s once on a loaded machine. A connection that is never reset still fails, at this bound.
  const CLIENT_PROCESS_TIMEOUT_MS = 30_000;

  const downloadFromAnotherProcess = async (
    version: '1.0' | '1.1',
  ): Promise<{ statusLine: string; bytes: number; error?: string; ended: boolean; bodyParses: boolean }> => {
    const client = `
      const socket = require('net').connect(${port}, '127.0.0.1');
      const received = [];
      const report = (error, ended) => {
        const all = Buffer.concat(received).toString('latin1');
        const body = all.slice(all.indexOf('\\r\\n\\r\\n') + 4);
        let bodyParses = true;
        try { JSON.parse(body); } catch { bodyParses = false; }
        process.stdout.write(JSON.stringify({ statusLine: all.split('\\r\\n')[0], bytes: all.length, error, ended, bodyParses }));
        socket.destroy();
      };
      socket.on('data', chunk => received.push(chunk));
      socket.once('error', error => report(error.code, false));
      socket.once('end', () => report(undefined, true));
      socket.write('GET /infra/export-data HTTP/${version}\\r\\nHost: gateway\\r\\nConnection: close\\r\\n\\r\\n');
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', client], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as never;
  };

  const withBudget = async <T>(bytes: number, run: () => Promise<T>): Promise<T> => {
    const prev = process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
    process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = String(bytes);
    try {
      return await run();
    } finally {
      if (prev === undefined) delete process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES;
      else process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES = prev;
    }
  };

  it('sends the first rows while later ones are still unread, and stops reading for a client that stops', async () => {
    await seedSession('s1');
    await seedHistory(HISTORY_ROWS, 6000);
    const messageReads = watchMessageReads();

    const response = await open();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    await once(response, 'data');
    response.pause();
    // Long enough for a server that ignores its client to read the whole table.
    await pause(300);
    const readsWhileNotReading = messageReads();
    response.resume();
    const rest = await text(response);

    expect(rest.endsWith('}')).toBe(true);
    expect(messageReads()).toBe(HISTORY_READS);
    expect(readsWhileNotReading).toBeLessThan(HISTORY_READS);
    expect(recordedExports()).toEqual([
      {
        counts: expect.objectContaining({ sessions: 1, messages: HISTORY_ROWS }) as never,
        includePluginSecrets: false,
      },
    ]);
  });

  it('sends the same compact document for a mixed database, and the importer restores it elsewhere', async () => {
    await seedSession('s1', 'http://user:pass@proxy.example.com:8080');
    await seedSession('s2');
    const webhooks = ds.getRepository(Webhook);
    await webhooks.save(
      webhooks.create({
        id: 'w1',
        sessionId: 's1',
        url: 'https://example.com/hook',
        events: ['message'],
        secret: 'a-secret-that-must-not-travel',
        headers: { Authorization: 'Bearer token' },
        active: true,
        retryCount: 3,
      }),
    );
    const photo = (bytes: number): Record<string, unknown> => ({
      media: { mimetype: 'image/jpeg', data: Buffer.alloc(bytes, 7).toString('base64') },
    });
    // Table order is oldest first. The budget below holds the two newest photos and nothing more.
    await insertMessages([
      message(0, 'old photo', photo(3000)),
      message(1, 'plain text'),
      message(2, 'newer photo', photo(3000)),
      message(3, 'newest photo', photo(3000)),
    ]);
    const batches = ds.getRepository(MessageBatch);
    await batches.save(
      batches.create({
        id: 'b1',
        batchId: 'BATCH-1',
        sessionId: 's1',
        status: BatchStatus.PROCESSING,
        messages: [
          { chatId: 'c1', type: 'image', content: { image: { base64: 'QUJDREVG', mimetype: 'image/png' } } },
        ] as never,
        options: null as never,
        progress: null as never,
        results: null as never,
        currentIndex: 0,
        startedAt: null,
        completedAt: null,
      }),
    );
    const lids = ds.getRepository(LidMapping);
    await lids.save(lids.create({ lid: '111', phone: '628111', sessionId: 's1' }));
    const chats = ds.getRepository(ChatState);
    await chats.save(chats.create({ sessionId: 's1', chatId: '628111@s.whatsapp.net', pinned: true }));
    // An older database that never ran the migration creating this optional table.
    await ds.query('DROP TABLE status_updates');

    const body = await withBudget(8004, async () => text(await open()));
    const dump = JSON.parse(body) as InfraExportDataResult;

    // No whitespace and the same member order: byte for byte what one JSON.stringify of the result gave.
    expect(JSON.stringify(dump)).toBe(body);
    expect(Object.keys(dump)).toEqual([
      'exportedAt',
      'dataDbType',
      'tables',
      'counts',
      'skippedTables',
      'omittedInlineMedia',
    ]);
    expect(Object.keys(dump.tables)).toEqual(EXPORT_TABLES.map(entry => entry.key));
    expect(Object.keys(dump.counts)).toEqual(EXPORT_TABLES.map(entry => entry.key));
    expect(dump.counts).toMatchObject({
      sessions: 2,
      webhooks: 1,
      messages: 4,
      messageBatches: 1,
      lidMappings: 1,
      chatStates: 1,
      statusUpdates: 0,
    });
    expect(dump.skippedTables).toEqual(['status_updates']);
    expect(dump.tables.statusUpdates).toEqual([]);
    expect(dump.tables.messages.map(row => row.id)).toEqual(['m-00000', 'm-00001', 'm-00002', 'm-00003']);
    const media = dump.tables.messages.map(
      row =>
        (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as {
          media?: { data?: string; omitted?: boolean };
        } | null,
    );
    expect(media.map(bag => (bag?.media ? (bag.media.omitted ?? typeof bag.media.data) : null))).toEqual([
      true,
      null,
      'string',
      'string',
    ]);
    // The batch came after the messages had spent the budget.
    expect(dump.omittedInlineMedia).toEqual({ messages: 1, messageBatches: 1 });
    expect(dump.tables.webhooks[0]).not.toHaveProperty('secret');
    expect(dump.tables.sessions[0].proxyUrl).toBe('http://proxy.example.com:8080/');

    const fresh = await openDatabase();
    const restored = await new InfraDataController(new InfraDataService(cfg as never, fresh)).importData(dump);
    expect(restored).toMatchObject({ imported: true, warnings: [] });
    expect(restored.counts).toEqual(dump.counts);
    expect(await fresh.getRepository(Message).count()).toBe(4);
  });

  it('answers a failure before anything was sent with its own status', async () => {
    await seedSession('s1');
    failStatement(sql => (sql === 'SELECT * FROM sessions' ? new Error('SQLITE_BUSY: database is locked') : undefined));

    const response = await open();

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(await text(response))).toMatchObject({ statusCode: 500 });
    expect(recordedExports()).toEqual([]);
  });

  it(
    'resets the connection when a read fails after the first rows went out, so the short body cannot pass for a backup',
    async () => {
      await seedSession('s1');
      await seedHistory(2000, 4000);
      const dump = { tables: { sessions: await ds.query<never[]>('SELECT * FROM sessions') } };
      watchMessageReads(6);

      const download = await downloadFromAnotherProcess('1.1');

      expect(download).toMatchObject({ statusLine: 'HTTP/1.1 200 OK', error: 'ECONNRESET', ended: false });
      expect(download.bytes).toBeGreaterThan(1_000_000);
      // Rows did leave the gateway, so the export is on record, as one that did not finish.
      const [recorded, ...others] = recordedExports();
      expect(others).toEqual([]);
      expect(recorded).toMatchObject({ incomplete: true, counts: { sessions: 1 } });
      expect(recorded.counts.messages).toBeGreaterThan(0);
      expect(recorded.counts.messages).toBeLessThan(2000);
      // The failed export no longer counts as running.
      await expect(service.importData(dump)).resolves.toMatchObject({ imported: true });
    },
    CLIENT_PROCESS_TIMEOUT_MS,
  );

  it('stops reading and frees the import when the client goes away mid-download', async () => {
    await seedSession('s1');
    await seedHistory(HISTORY_ROWS, 6000);
    const dump = { tables: { sessions: await ds.query<never[]>('SELECT * FROM sessions') } };
    const messageReads = watchMessageReads();

    const response = await open();
    await once(response, 'data');
    response.destroy();

    let imported: unknown;
    await waitUntil(async () => {
      imported = await service.importData(dump).catch((error: unknown) => error);
      return !(imported instanceof Error);
    });
    expect(imported).toMatchObject({ imported: true });
    expect(recordedExports()).toEqual([expect.objectContaining({ incomplete: true })]);
    expect(messageReads()).toBeLessThan(HISTORY_READS);
  });

  it('stops spending the budget when the client goes away before the first byte', async () => {
    await seedSession('s1');
    // 20 chunk reads to spend the budget on, and as many again to write the table.
    for (let from = 0; from < 4_000; from += 500) {
      await insertMessages(
        Array.from({ length: 500 }, (_, i) =>
          message(from + i, 'photo', { media: { mimetype: 'image/jpeg', data: 'QUJD' } }),
        ),
      );
    }
    const dump = { tables: { sessions: await ds.query<never[]>('SELECT * FROM sessions') } };
    const messageReads = watchMessageReads();
    // The second chunk read waits until the client has gone and the server has seen it go: what the export reads after
    // that is then the same however fast this runner is.
    const reader = service as unknown as { readRowsById: (...args: unknown[]) => Promise<unknown> };
    const readRowsById = reader.readRowsById.bind(service);
    let atSecondRead: () => void = () => undefined;
    const secondRead = new Promise<void>(resolve => (atSecondRead = resolve));
    let letItRead: () => void = () => undefined;
    const clientGone = new Promise<void>(resolve => (letItRead = resolve));
    let chunkReads = 0;
    jest.spyOn(reader, 'readRowsById').mockImplementation(async (...args: unknown[]) => {
      if (++chunkReads === 2) {
        atSecondRead();
        await clientGone;
      }
      return readRowsById(...args);
    });
    const server = app.getHttpServer() as http.Server;
    const connections = (): Promise<number> =>
      new Promise(resolve => server.getConnections((_error, count) => resolve(count)));

    const request = http.get({ host: '127.0.0.1', port, path: '/infra/export-data', agent: false });
    request.on('error', () => undefined);
    await secondRead;
    expect(messageReads()).toBe(1);
    request.destroy();
    await waitUntil(async () => (await connections()) === 0);
    letItRead();

    let imported: unknown;
    await waitUntil(async () => {
      imported = await service.importData(dump).catch((error: unknown) => error);
      return !(imported instanceof Error);
    });
    expect(imported).toMatchObject({ imported: true });
    // The read the client left during, and at most one more before the export saw it gone: none of the other 18.
    expect(messageReads()).toBeLessThanOrEqual(3);
    expect(recordedExports()).toEqual([]);
  });

  it(
    'resets the connection of an HTTP/1.0 client too, for which a body ends when the connection closes',
    async () => {
      await seedSession('s1');
      await seedHistory(2000, 4000);
      watchMessageReads(6);

      const download = await downloadFromAnotherProcess('1.0');

      // An orderly close here would be the end of a complete 200 to this client, with half a backup in it.
      expect(download).toMatchObject({
        statusLine: 'HTTP/1.1 200 OK',
        error: 'ECONNRESET',
        ended: false,
        bodyParses: false,
      });
      expect(download.bytes).toBeGreaterThan(1_000_000);
    },
    CLIENT_PROCESS_TIMEOUT_MS,
  );

  it('leaves out the stored messages and chat states an unlinked account left while its clear is kept', async () => {
    await seedSession('s1');
    const unlinkedAt = new Date('2026-11-28T00:00:00.000Z');
    const before = new Date(unlinkedAt.getTime() - 60_000);
    const after = new Date(unlinkedAt.getTime() + 60_000);
    const stored = ds.getRepository(BaileysStoredMessage);
    await stored.insert({ sessionId: 's1', waMessageId: 'OLD', serializedMessage: '{}', createdAt: before });
    await stored.insert({ sessionId: 's1', waMessageId: 'NEW', serializedMessage: '{}', createdAt: after });
    const states = ds.getRepository(ChatState);
    await states.insert({ sessionId: 's1', chatId: 'old@c.us', pinned: true, updatedAt: before });
    await states.insert({ sessionId: 's1', chatId: 'new@c.us', pinned: true, updatedAt: after });
    const messageStore = new BaileysMessageStoreService(stored);
    const chatStates = new ChatStateStoreService(states);
    messageStore.hideUpTo('s1', unlinkedAt);
    chatStates.hideUpTo('s1', unlinkedAt);
    const fenced = new InfraDataService(
      cfg as never,
      ds,
      auditLog as never,
      undefined,
      undefined,
      undefined,
      chatStates,
      undefined,
      undefined,
      messageStore,
    );

    let document = '';
    for await (const piece of fenced.exportData()) document += piece;

    const { tables } = JSON.parse(document) as InfraExportDataResult;
    expect(tables.baileysStoredMessages.map(row => row.waMessageId)).toEqual(['NEW']);
    expect(tables.chatStates?.map(row => row.chatId)).toEqual(['new@c.us']);
  });

  it('hands the document on in pieces of bounded size, never as one string', async () => {
    await seedSession('s1');
    await seedHistory(1000, 2000);

    const pieces: string[] = [];
    for await (const piece of service.exportData()) pieces.push(piece);

    const document = pieces.join('');
    expect((JSON.parse(document) as InfraExportDataResult).counts.messages).toBe(1000);
    expect(document.length).toBeGreaterThan(2_000_000);
    // A piece is at most the 64 KiB it is handed on at and the one row that reached it.
    expect(Math.max(...pieces.map(piece => piece.length))).toBeLessThan(64 * 1024 + 4096);
    expect(pieces.length).toBeGreaterThan(30);
  });
});

describe('InfraDataService.exportData on PostgreSQL', () => {
  it('gives its connection back when the snapshot transaction cannot be opened', async () => {
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn((sql: string) =>
        sql === 'SET TRANSACTION READ ONLY' ? Promise.reject(new Error('connection terminated')) : Promise.resolve([]),
      ),
      isTransactionActive: true,
    };
    const service = new InfraDataService(
      { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) } as never,
      {
        options: { type: 'postgres' },
        entityMetadatas: EXPORT_TABLES.map(entry => ({ tableName: entry.table })),
        createQueryRunner: () => runner,
      } as never,
    );

    await expect(service.exportData().next()).rejects.toThrow('connection terminated');

    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
    // The export that never started does not count as running.
    await expect(service.exportData().next()).rejects.toThrow('connection terminated');
  });

  it('rolls the snapshot back and gives its connection back when the download stops midway', async () => {
    // Enough session rows that the first piece is handed on with the transaction still open.
    const sessions = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: 'n'.repeat(400) }));
    let sessionsCursor = '';
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      // The sessions cursor answers its rows on the first fetch and none after.
      query: jest.fn((sql: string) => {
        if (sql.endsWith(' CURSOR FOR SELECT * FROM sessions')) sessionsCursor = sql.split(' ')[1];
        const fetched = sql.startsWith('FETCH ') && sql.endsWith(` FROM ${sessionsCursor}`) ? sessions.splice(0) : [];
        return Promise.resolve(fetched);
      }),
      isTransactionActive: true,
    };
    const service = new InfraDataService(
      { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) } as never,
      {
        options: { type: 'postgres' },
        entityMetadatas: EXPORT_TABLES.map(entry => ({ tableName: entry.table })),
        createQueryRunner: () => runner,
      } as never,
    );

    const pieces = service.exportData();
    const first = await pieces.next();
    expect(first.value).toMatch(/^\{"exportedAt":"[^"]+","dataDbType":"postgres","tables":\{"sessions":\[\{"id":"s0"/);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    await pieces.return();

    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  // Nest runs the destroy hooks one module after another, so a wait here would hold every teardown after it.
  const postgresService = (runner: object): InfraDataService =>
    new InfraDataService(
      { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) } as never,
      {
        options: { type: 'postgres' },
        entityMetadatas: EXPORT_TABLES.map(entry => ({ tableName: entry.table })),
        createQueryRunner: () => runner,
      } as never,
    );
  const stoppedAtOnce = (service: InfraDataService): Promise<string> =>
    Promise.race([service.onModuleDestroy().then(() => 'stopped'), pause(500).then(() => 'still waiting')]);

  it('does not hold a stop for a snapshot that still waits for a connection, and closes it when it opens', async () => {
    let connected!: () => void;
    const runner = {
      connect: jest.fn(() => new Promise<void>(resolve => (connected = resolve))),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      isTransactionActive: true,
    };
    const service = postgresService(runner);
    const first = service.exportData().next();
    first.catch(() => undefined);
    await waitUntil(() => runner.connect.mock.calls.length === 1, 2_000);

    await expect(stoppedAtOnce(service)).resolves.toBe('stopped');
    connected();

    await expect(first).rejects.toMatchObject({ response: { code: 'EXPORT_STOPPED' } });
    await waitUntil(() => runner.release.mock.calls.length === 1, 2_000);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not hold a stop while the rollback waits behind a read in flight', async () => {
    const sessions = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: 'n'.repeat(400) }));
    let sessionsCursor = '';
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn(() => new Promise<void>(() => undefined)),
      release: jest.fn().mockResolvedValue(undefined),
      // The sessions cursor answers its rows on the first fetch and none after.
      query: jest.fn((sql: string) => {
        if (sql.endsWith(' CURSOR FOR SELECT * FROM sessions')) sessionsCursor = sql.split(' ')[1];
        const fetched = sql.startsWith('FETCH ') && sql.endsWith(` FROM ${sessionsCursor}`) ? sessions.splice(0) : [];
        return Promise.resolve(fetched);
      }),
      isTransactionActive: true,
    };
    const service = postgresService(runner);
    const pieces = service.exportData();
    await pieces.next();

    await expect(stoppedAtOnce(service)).resolves.toBe('stopped');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

// Until its reader is done an export refuses every import and, on PostgreSQL, holds a snapshot open.
describe('InfraDataController.exportData and a reader that stops', () => {
  const NINE_MINUTES = 9 * 60_000;
  let ended: boolean;
  const endless = {
    async *exportData(): AsyncGenerator<string, void, undefined> {
      try {
        for (;;) yield await Promise.resolve('x'.repeat(100_000));
      } finally {
        ended = true;
      }
    },
  };

  beforeEach(() => {
    ended = false;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const takeOnePiece = async (body: NodeJS.ReadableStream): Promise<void> => {
    while (body.read() === null) await once(body, 'readable');
  };

  it('ends the export once its reader has taken nothing for ten minutes', async () => {
    const body = (await new InfraDataController(endless as never).exportData()).getStream();
    const failure = once(body, 'error');
    await takeOnePiece(body);

    await jest.advanceTimersByTimeAsync(NINE_MINUTES);
    expect(ended).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);

    await waitUntil(() => ended, 2_000);
    expect(ended).toBe(true);
    expect((await failure)[0]).toMatchObject({ message: expect.stringMatching(/reader/) as never });
  });

  it('keeps an export going for a reader that is slow but still reading', async () => {
    const body = (await new InfraDataController(endless as never).exportData()).getStream();

    for (let turn = 0; turn < 4; turn++) {
      await takeOnePiece(body);
      await jest.advanceTimersByTimeAsync(NINE_MINUTES);
    }

    expect(ended).toBe(false);
    body.destroy();
  });

  it('ends an export that is still being read after sixty minutes', async () => {
    const body = (await new InfraDataController(endless as never).exportData()).getStream();
    const failure = once(body, 'error');

    // Never idle for ten minutes, so only the bound on the whole export can end it.
    for (let turn = 0; turn < 6; turn++) {
      await takeOnePiece(body);
      await jest.advanceTimersByTimeAsync(NINE_MINUTES);
    }
    expect(ended).toBe(false);
    await takeOnePiece(body);
    await jest.advanceTimersByTimeAsync(6 * 60_000);

    await waitUntil(() => ended, 2_000);
    expect(ended).toBe(true);
    expect((await failure)[0]).toMatchObject({ response: { code: 'EXPORT_TIMED_OUT' } });
  });

  it('answers 503 when an export has not sent its first byte after sixty minutes, and stops it', async () => {
    let stopped: unknown;
    const neverStarts = {
      async *exportData(options: { signal: AbortSignal }): AsyncGenerator<string, void, undefined> {
        await new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason as Error)),
        );
        yield '';
      },
    };
    const answer = new InfraDataController(neverStarts as never)
      .exportData()
      .catch((error: unknown) => (stopped = error));

    await jest.advanceTimersByTimeAsync(59 * 60_000);
    expect(stopped).toBeUndefined();
    await jest.advanceTimersByTimeAsync(60_000);
    await answer;

    expect(stopped).toMatchObject({
      status: 503,
      response: {
        code: 'EXPORT_TIMED_OUT',
        message: expect.stringMatching(/60 minutes.*scripts\/backup\.sh/) as never,
      },
    });
  });
});
