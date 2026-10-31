import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { MessageSendService } from './message-send.service';
import { MessageService } from './message.service';
import { SendPacingService } from './send-pacing.service';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import type { SessionService } from '../session/session.service';
import type { TemplateService } from '../template/template.service';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

// Every outgoing row of one account names the same sender, whichever writer stored it: the REST send
// path, or the own-send echo of a message composed on the linked phone. The `from` filter of the message
// list matches a sender by its JID forms, so a row that names the account some other way drops out of it.
// Runs on SQLite, and on the postgres:16 service when DATABASE_TYPE=postgres.
describe('the sender stored on an outgoing row', () => {
  const PHONE = '628123456789';
  const OWN_JID = `${PHONE}@c.us`;
  const CHAT = '628987654321@c.us';
  let db: DataSource;
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let sender: MessageSendService;
  let projector: MessageProjector;
  let list: MessageService;
  let sessionId: string;

  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve));
    if (db.options.type === 'postgres') await pause(150);
  };

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `outgoing_sender_${randomUUID().replace(/-/g, '')}`,
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
    messages = db.getRepository(Message);
    sessions = db.getRepository(Session);
    const session = await sessions.save({ name: 'acct', phone: PHONE } as Partial<Session>);
    sessionId = session.id;
    engines = new EngineRegistry();
    engine = {
      sendTextMessage: jest.fn().mockResolvedValue({ id: 'WA_FROM_API', timestamp: 1_700_000_100 }),
    } as unknown as IWhatsAppEngine;
    engines.set(sessionId, engine);
    const hooks = new HookManager();
    const pacing = new SendPacingService(messages, sessions, new ConfigService({}));
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneByOrFail({ id }) } as unknown as SessionService,
      engines,
      hooks,
      {} as TemplateService,
      pacing,
    );
    projector = new MessageProjector(
      messages,
      sessions,
      engines,
      new Proxy({}, { get: () => () => undefined }) as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      hooks,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
    list = new MessageService(
      messages,
      engines,
      projector,
      hooks,
      {
        findLidsForPhone: () => Promise.resolve([]),
        findPhoneForLid: () => Promise.resolve(null),
      } as unknown as LidMappingStoreService,
      pacing,
      sender,
    );
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
    await db.destroy();
  });

  async function storeBoth(): Promise<void> {
    // Composed on the linked phone: only the engine's own-send echo stores it.
    const phoneComposed: IncomingMessage = {
      id: 'WA_FROM_PHONE',
      chatId: CHAT,
      from: OWN_JID,
      to: CHAT,
      body: 'sent from the phone',
      type: 'text',
      timestamp: 1_700_000_000,
      fromMe: true,
      isGroup: false,
      kind: 'individual',
    };
    projector.handleOwnSendEcho(sessionId, engine, phoneComposed);
    await flush();
    // Sent through the API: the REST send path stores it before the echo arrives.
    await sender.sendText(sessionId, { chatId: CHAT, text: 'sent through the API' });
  }

  /** A row an earlier version of the send path wrote, naming the account by its bare digits. */
  const storeLegacy = (waMessageId: string, from: string): Promise<Message> =>
    messages.save(
      messages.create({
        sessionId,
        waMessageId,
        chatId: CHAT,
        from,
        to: CHAT,
        body: 'sent through the API earlier',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: 1_699_999_000,
      }),
    );

  const idsFrom = async (from: string): Promise<string[]> =>
    (await list.getMessages(sessionId, { from })).messages.map(m => m.waMessageId).sort();

  it('names the account the way its own-send echo does', async () => {
    await storeBoth();
    const rows = await messages.find({ where: { sessionId }, order: { timestamp: 'ASC' } });
    expect(rows.map(r => [r.waMessageId, r.direction, r.from])).toEqual([
      ['WA_FROM_PHONE', MessageDirection.OUTGOING, OWN_JID],
      ['WA_FROM_API', MessageDirection.OUTGOING, OWN_JID],
    ]);
  });

  it('lists every outgoing row of the account under a filter on its JID', async () => {
    await storeBoth();
    expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE']);
  });

  it('still lists a row an earlier version stored under the bare digits, by JID or by digits', async () => {
    await storeBoth();
    await storeLegacy('WA_LEGACY', PHONE);
    expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
    expect(await idsFrom(`${PHONE}@s.whatsapp.net`)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
    expect(await idsFrom(PHONE)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
  });

  it('keeps another sender out of the account filter, and the account out of another sender', async () => {
    await storeBoth();
    await messages.save(
      messages.create({
        sessionId,
        waMessageId: 'WA_GROUP',
        chatId: '120363000000000001@g.us',
        from: '120363000000000001@g.us',
        author: '628111111111@c.us',
        to: OWN_JID,
        body: 'from a member',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1_700_000_200,
      }),
    );
    expect(await idsFrom('628111111111@c.us')).toEqual(['WA_GROUP']);
    expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE']);
  });

  it("stores 'me' for a send made while the session has no number, still found by that name", async () => {
    await sessions.update({ id: sessionId }, { phone: null });
    await sender.sendText(sessionId, { chatId: CHAT, text: 'sent while unlinked' });
    expect((await messages.findOneByOrFail({ sessionId, waMessageId: 'WA_FROM_API' })).from).toBe('me');
    expect(await idsFrom('me')).toEqual(['WA_FROM_API']);
  });
});
