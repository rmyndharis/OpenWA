import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { Session } from './entities/session.entity';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type {
  EditedMessage,
  IncomingMessage,
  IWhatsAppEngine,
} from '../../engine/interfaces/whatsapp-engine.interface';

// A plugin search provider keeps its index in step through `message:persisted`, treating every emission as
// an upsert keyed by the row id (docs/27). A stored message whose text changes must reach it again, as a
// revoked one does, or the index keeps serving the text the sender replaced. Runs on SQLite, and on the
// postgres:16 service when DATABASE_TYPE=postgres.
describe('message:persisted after a stored message changes its text', () => {
  const CHAT = '15550001111@c.us';
  let db: DataSource;
  let repository: Repository<Message>;
  let projector: MessageProjector;
  let engine: IWhatsAppEngine;
  let hookManager: { execute: jest.Mock };
  // The message:received chain of a message waits for this gate when one is set.
  let receivedGate: Promise<void> | undefined;

  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve));
    // A PostgreSQL round trip takes real time.
    if (db.options.type === 'postgres') await pause(150);
  };
  const persistedRows = (): Array<Record<string, unknown>> =>
    hookManager.execute.mock.calls
      .filter(([event]) => event === 'message:persisted')
      .map(([, data]) => (data as { message: Record<string, unknown> }).message);

  async function seed(waMessageId: string, direction: MessageDirection): Promise<Message> {
    return repository.save(
      repository.create({
        sessionId: 's1',
        waMessageId,
        chatId: CHAT,
        from: direction === MessageDirection.INCOMING ? CHAT : 'me',
        to: direction === MessageDirection.INCOMING ? 'me' : CHAT,
        body: 'the original text',
        type: 'text',
        direction,
        status: MessageStatus.SENT,
        timestamp: 1_700_000_000,
      }),
    );
  }

  const inbound = (id: string): IncomingMessage => ({
    id,
    chatId: CHAT,
    from: CHAT,
    to: 'me@c.us',
    body: 'the original text',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
  });
  const editOf = (messageId: string, body: string, over: Partial<EditedMessage> = {}): EditedMessage =>
    ({ messageId, chatId: CHAT, fromMe: false, body, ...over }) as EditedMessage;

  beforeEach(async () => {
    receivedGate = undefined;
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `edit_persisted_${randomUUID().replace(/-/g, '')}`,
            entities: [Message],
            synchronize: false,
          }
        : { type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true },
    );
    await db.initialize();
    if (db.options.type === 'postgres') {
      await db.query(`CREATE SCHEMA "${db.options.schema}"`);
      await db.synchronize();
    }
    repository = db.getRepository(Message);
    hookManager = {
      execute: jest.fn(async (event: string, data: unknown) => {
        if (event === 'message:received') await receivedGate;
        return { continue: true, data };
      }),
    };
    const engines = new EngineRegistry();
    engine = { tag: 'engine' } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    projector = new MessageProjector(
      repository,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      new Proxy({}, { get: () => () => undefined }) as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      hookManager as unknown as HookManager,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
    await db.destroy();
  });

  it('hands the cleared row of a revoked message to message:persisted (the existing contract)', async () => {
    const row = await seed('WA_REVOKE', MessageDirection.INCOMING);
    await projector.recordRevoke('s1', 'WA_REVOKE', { kind: 'revoke', chatId: CHAT, fromMe: false });
    await flush();
    expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: '', type: 'revoked' })]);
  });

  it('hands the edited row of an inbound edit to message:persisted, marker included', async () => {
    const row = await seed('WA_EDIT_IN', MessageDirection.INCOMING);
    projector.applyMessageEditQueued('s1', editOf('WA_EDIT_IN', 'the corrected text'));
    await flush();
    expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the corrected text');
    const persisted = persistedRows();
    expect(persisted).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
    expect(persisted[0].metadata).toMatchObject({ edited: true });
  });

  it('hands the edited row of a REST edit to message:persisted', async () => {
    const row = await seed('WA_EDIT_OUT', MessageDirection.OUTGOING);
    await projector.recordOutboundMessageEdit('s1', 'WA_EDIT_OUT', 'the corrected text', {
      kind: 'edit',
      chatId: CHAT,
      fromMe: true,
    });
    await flush();
    expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the corrected text');
    expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
  });

  it('hands a REST edit over once when the engine echoes the same edit back', async () => {
    const row = await seed('WA_EDIT_ECHO', MessageDirection.OUTGOING);
    await projector.recordOutboundMessageEdit('s1', 'WA_EDIT_ECHO', 'the corrected text', {
      kind: 'edit',
      chatId: CHAT,
      fromMe: true,
    });
    projector.applyMessageEditQueued('s1', editOf('WA_EDIT_ECHO', 'the corrected text', { fromMe: true }));
    await flush();
    expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
  });

  it('hands nothing over for an edit that repeats the stored text', async () => {
    await seed('WA_SAME', MessageDirection.INCOMING);
    projector.applyMessageEditQueued('s1', editOf('WA_SAME', 'the original text'));
    await flush();
    expect(persistedRows()).toEqual([]);
  });

  it('hands nothing over for an edit naming another chat', async () => {
    const row = await seed('WA_FOREIGN', MessageDirection.INCOMING);
    projector.applyMessageEditQueued('s1', editOf('WA_FOREIGN', 'not this one', { chatId: '15550002222@c.us' }));
    await flush();
    expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the original text');
    expect(persistedRows()).toEqual([]);
  });

  it('hands a message over once with the edit that reached it before its row was written', async () => {
    let release!: () => void;
    receivedGate = new Promise(resolve => (release = resolve));
    projector.handleInboundMessage('s1', engine, inbound('WA_HELD'));
    await flush();
    projector.applyMessageEditQueued('s1', editOf('WA_HELD', 'the corrected text'));
    await flush();
    release();
    await flush();
    expect((await repository.findOneByOrFail({ waMessageId: 'WA_HELD' })).body).toBe('the corrected text');
    expect(persistedRows().map(row => row.body)).toEqual(['the corrected text']);
  });

  it('hands a message over again with the edit that reached it while its row was being written', async () => {
    let releaseInsert!: () => void;
    const insertHeld = new Promise<void>(resolve => (releaseInsert = resolve));
    const insert = repository.insert.bind(repository);
    jest.spyOn(repository, 'insert').mockImplementation(async row => {
      await insertHeld;
      return insert(row);
    });
    projector.handleInboundMessage('s1', engine, inbound('WA_DURING'));
    await flush();
    projector.applyMessageEditQueued('s1', editOf('WA_DURING', 'the corrected text'));
    await flush();
    releaseInsert();
    await flush();
    expect((await repository.findOneByOrFail({ waMessageId: 'WA_DURING' })).body).toBe('the corrected text');
    expect(persistedRows().map(row => row.body)).toEqual(['the original text', 'the corrected text']);
  });
});
