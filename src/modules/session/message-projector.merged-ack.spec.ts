import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from '../../engine/adapters/baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { Session } from './entities/session.entity';
import { ACK_RECONCILE_DELAY_MS, MessageProjector } from './message-projector.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';

/**
 * Baileys' event buffer merges a 1:1 ack that lands within about 100 ms of a message's own upsert into that
 * upsert, as `status` (and `messageTimestamp`), and raises no messages.update for it. This runs the adapter's
 * upsert handler against the real projector and a real database (SQLite here, the postgres:16 service when
 * DATABASE_TYPE=postgres) to show that the stored status advances for the two kinds of message that can carry
 * one: the echo of an API send, and a message the phone typed while the gateway was down.
 */

const SESSION = 's1';
const CHAT = '6281111111111@s.whatsapp.net';
const SELF = '6280000000000@s.whatsapp.net';

type Pending = { promise: Promise<void>; release: () => void };
const gate = (): Pending => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => (release = resolve));
  return { promise, release };
};
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};
/** Polls until `read` answers `expected` or two seconds pass; a PostgreSQL write takes real time to land. */
const eventually = async <T>(read: () => Promise<T>, expected: T): Promise<T> => {
  let last = await read();
  for (const start = Date.now(); last !== expected && Date.now() - start < 2000;) {
    await pause(20);
    last = await read();
  }
  return last;
};

// Only what processing a plain text message reads from the library.
const libStub = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

describe('an ack merged into a message upsert reaches the stored row', () => {
  let db: DataSource;
  let repo: Repository<Message>;
  let projector: MessageProjector;
  let events: BaileysEvents;
  let ownSends: Set<string>;
  let hookGate: Promise<void> | undefined;
  let storedReadGate: Promise<void> | undefined;
  let retries: Array<ReturnType<typeof setTimeout>>;
  const engine = { tag: 'merged-ack' } as unknown as IWhatsAppEngine;

  beforeEach(async () => {
    // The projector retries an ack that found no row once, after ACK_RECONCILE_DELAY_MS. Kept so a test that
    // has ended cannot fire it into the database the next test has replaced.
    retries = [];
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      if (ms === ACK_RECONCILE_DELAY_MS) retries.push(timer);
      return timer;
    });
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `merged_ack_${randomUUID().replace(/-/g, '')}`,
            entities: [Session, Message],
            synchronize: false,
          }
        : { type: 'better-sqlite3', database: ':memory:', entities: [Session, Message], synchronize: true },
    );
    await db.initialize();
    if (db.options.type === 'postgres') {
      await db.query(`CREATE SCHEMA "${db.options.schema}"`);
      await db.synchronize();
    }
    repo = db.getRepository(Message);
    hookGate = undefined;
    storedReadGate = undefined;
    ownSends = new Set();

    const engines = new EngineRegistry();
    engines.set(SESSION, engine);
    projector = new MessageProjector(
      repo,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      {
        emitMessage: jest.fn(),
        emitMessageSent: jest.fn(),
        emitMessageAck: jest.fn(),
      } as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      {
        // A slow hook chain holds the commit of a message, as a plugin on message:sent can.
        execute: jest.fn(async (_event: string, data: unknown) => {
          await hookGate;
          return { continue: true, data };
        }),
      } as unknown as HookManager,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );

    const noop = (): void => undefined;
    const host: BaileysEventsHost = {
      getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
      getSocketOrNull: () => null,
      logger: createLogger('MergedAckSpec'),
      loadLib: () => Promise.resolve(libStub),
      getFetchDispatcher: () => undefined,
      toNeutralJid: (jid: string) => jid,
      normalizedSelfJid: () => SELF,
      inboundLimiter: new ConcurrencyLimiter(2),
      recordKeyLidMappings: noop,
      recordMessage: noop,
      recordMessageEdit: noop,
      consumeOwnSend: id => (id ? ownSends.delete(id) : false),
      getStoredMessage: async () => {
        await storedReadGate;
        return null;
      },
      putStoredMessage: () => undefined,
      updateStoredMessage: () => undefined,
      removeStoredMessage: () => undefined,
      getOnMessage: () => undefined,
      getOnMessageCreate: () => (message, ticket) => projector.handleOwnSendEcho(SESSION, engine, message, ticket),
      getOnMessageRevoked: () => undefined,
      getOnMessageEdited: () => undefined,
      getOnMessageReaction: () => undefined,
      getOnMessageAck: () => (id, status, chatId) => projector.handleMessageAck(SESSION, engine, id, status, chatId),
      getOnMessageReceipt: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnEventResponse: () => undefined,
      findContact: () => null,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
      // As the session wiring installs it: PostgreSQL only.
      getAdmitInbound: () => (projector.holdsInbound ? a => projector.admitInbound(SESSION, engine, a) : undefined),
    };
    events = new BaileysEvents(host);
  });

  afterEach(async () => {
    retries.forEach(timer => clearTimeout(timer));
    jest.restoreAllMocks();
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
    await db.destroy();
  });

  /** As the event buffer leaves an upsert after an ack was merged into it (Object.assign of the update). */
  const mergedUpsert = (id: string, fromMe: boolean, status: number): { messages: WAMessage[]; type: string } => ({
    type: 'append',
    messages: [
      {
        key: { id, remoteJid: CHAT, fromMe },
        message: { conversation: 'hi' },
        // The ack's own time replaces the message's.
        messageTimestamp: 1_700_000_100,
        status,
      },
    ],
  });

  const statusOf = async (id: string): Promise<MessageStatus | undefined> =>
    (await repo.findOne({ where: { sessionId: SESSION, waMessageId: id } }))?.status;

  /** The row the REST send leaves once the engine accepted the message. */
  const sentRow = (id: string): Promise<Message> =>
    repo.save(
      repo.create({
        sessionId: SESSION,
        waMessageId: id,
        chatId: CHAT,
        from: 'me',
        to: CHAT,
        body: 'hi',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 1_700_000_000,
        status: MessageStatus.SENT,
      }),
    );

  /** The neutral message the adapter hands the projector for its own send. */
  const echoOf = (id: string): IncomingMessage => ({
    id,
    chatId: CHAT,
    from: SELF,
    to: CHAT,
    body: 'hi',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: true,
    isGroup: false,
    kind: 'individual',
  });

  it.each([
    [3, MessageStatus.DELIVERED],
    [4, MessageStatus.READ],
  ])('advances the row of an API send when status %i is merged into its echo', async (status, expected) => {
    await sentRow('API1');
    ownSends.add('API1');

    events.handleMessagesUpsert(mergedUpsert('API1', true, status));
    await settle();

    expect(await eventually(() => statusOf('API1'), expected)).toBe(expected);
  });

  it('advances an API send whose echo row is still waiting behind a slow hook when the ack arrives', async () => {
    const slow = gate();
    hookGate = slow.promise;
    ownSends.add('API2');
    // What emitOwnSendEcho hands the projector right after the send; its row is not written yet.
    projector.handleOwnSendEcho(SESSION, engine, echoOf('API2'));

    events.handleMessagesUpsert(mergedUpsert('API2', true, 3));
    await settle();
    expect(await statusOf('API2')).toBeUndefined();

    slow.release();
    await settle();

    expect(await eventually(() => statusOf('API2'), MessageStatus.DELIVERED)).toBe(MessageStatus.DELIVERED);
  });

  it('marks an API send failed when the server rejection is merged into its echo', async () => {
    await sentRow('API3');
    ownSends.add('API3');

    events.handleMessagesUpsert(mergedUpsert('API3', true, 0));
    await settle();

    expect(await eventually(() => statusOf('API3'), MessageStatus.FAILED)).toBe(MessageStatus.FAILED);
  });

  it('creates a message the phone typed offline and advances it, however long its processing takes', async () => {
    // Longer than the one retry the projector gives an ack that found no row.
    const slow = gate();
    storedReadGate = slow.promise;

    events.handleMessagesUpsert(mergedUpsert('PHONE1', true, 4));
    await pause(ACK_RECONCILE_DELAY_MS + 150);
    slow.release();
    await settle();

    expect(await eventually(() => statusOf('PHONE1'), MessageStatus.READ)).toBe(MessageStatus.READ);
  });

  it('creates a message the phone typed offline and advances it when its hook chain is slow', async () => {
    const slow = gate();
    hookGate = slow.promise;

    events.handleMessagesUpsert(mergedUpsert('PHONE2', true, 3));
    await pause(ACK_RECONCILE_DELAY_MS + 150);
    expect(await statusOf('PHONE2')).toBeUndefined();
    slow.release();
    await settle();

    expect(await eventually(() => statusOf('PHONE2'), MessageStatus.DELIVERED)).toBe(MessageStatus.DELIVERED);
  });

  it('leaves a message the phone typed at sent when it carries no ack', async () => {
    events.handleMessagesUpsert(mergedUpsert('PHONE3', true, 2));
    await settle();

    expect(await eventually(() => statusOf('PHONE3'), MessageStatus.SENT)).toBe(MessageStatus.SENT);
  });
});
