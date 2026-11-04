import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { ACK_RECONCILE_DELAY_MS, MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { Session } from './entities/session.entity';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type {
  DeliveryStatus,
  IncomingMessage,
  IWhatsAppEngine,
} from '../../engine/interfaces/whatsapp-engine.interface';

// Baileys relays a peer's receipt under the peer's own chat and every id the stanza lists, with no check
// that the id belongs to that chat (messages-recv handleReceipt). A message id names one message of one
// chat, so a receipt from one chat must not move the stored delivery state of another chat's message, as
// the edit, revoke and reaction paths already refuse. Runs on SQLite, and on the postgres:16 service when
// DATABASE_TYPE=postgres.
describe('a delivery ack names the chat of the message it advances', () => {
  const GROUP = '120363000000000001@g.us';
  const PEER = '15550001111@c.us';
  const OTHER = '15550002222@c.us';
  const PEER_LID = '99990001111@lid';
  let db: DataSource;
  let repository: Repository<Message>;
  let projector: MessageProjector;
  let engine: IWhatsAppEngine;
  let dispatch: jest.Mock;
  let lidPhones: Map<string, string>;

  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, ACK_RECONCILE_DELAY_MS + 250));
  const statusOf = async (id: string): Promise<MessageStatus | undefined> =>
    (await repository.findOne({ where: { sessionId: 's1', waMessageId: id } }))?.status;
  const announced = (id: string): number =>
    dispatch.mock.calls.filter(([, event, payload]) => event === 'message.ack' && (payload as { id: string }).id === id)
      .length;

  async function seed(waMessageId: string, chatId: string): Promise<Message> {
    return repository.save(
      repository.create({
        sessionId: 's1',
        waMessageId,
        chatId,
        from: '15559990000@c.us',
        to: chatId,
        body: 'sent by the account',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: 1_700_000_000,
      }),
    );
  }

  const ack = (id: string, status: DeliveryStatus, chatId?: string): void =>
    projector.handleMessageAck('s1', engine, id, status, chatId);

  beforeEach(async () => {
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `ack_chat_${randomUUID().replace(/-/g, '')}`,
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
    lidPhones = new Map();
    dispatch = jest.fn().mockResolvedValue(undefined);
    const engines = new EngineRegistry();
    engine = { tag: 'engine' } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    projector = new MessageProjector(
      repository,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      new Proxy({}, { get: () => () => undefined }) as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      {
        execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
      } as unknown as HookManager,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      undefined,
      undefined,
      undefined,
      {
        findPhoneForLid: (jid: string) => Promise.resolve(lidPhones.get(jid.split('@')[0]) ?? null),
      } as unknown as LidMappingStoreService,
    );
  });

  afterEach(async () => {
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
    await db.destroy();
  });

  it('leaves a group message alone, and unannounced, when a one-to-one receipt names its id', async () => {
    await seed('WA_GROUP', GROUP);
    ack('WA_GROUP', 'read', OTHER);
    await settle();
    expect(await statusOf('WA_GROUP')).toBe(MessageStatus.SENT);
    expect(announced('WA_GROUP')).toBe(0);
  });

  it("leaves another contact's message alone when a receipt from a different contact names its id", async () => {
    await seed('WA_PEER', PEER);
    ack('WA_PEER', 'read', OTHER);
    await settle();
    expect(await statusOf('WA_PEER')).toBe(MessageStatus.SENT);
  });

  it('never marks another chat failed', async () => {
    await seed('WA_FAIL', PEER);
    ack('WA_FAIL', 'failed', OTHER);
    await settle();
    expect(await statusOf('WA_FAIL')).toBe(MessageStatus.SENT);
    expect(dispatch.mock.calls.some(([, event]) => event === 'message.failed')).toBe(false);
  });

  it('still advances, and announces, the message when the receipt names its chat in another dialect', async () => {
    await seed('WA_SAME', PEER);
    ack('WA_SAME', 'read', '15550001111@s.whatsapp.net');
    await settle();
    expect(await statusOf('WA_SAME')).toBe(MessageStatus.READ);
    expect(announced('WA_SAME')).toBe(1);
  });

  it('still advances the message when the ack names no chat', async () => {
    await seed('WA_NOCHAT', PEER);
    ack('WA_NOCHAT', 'delivered');
    await settle();
    expect(await statusOf('WA_NOCHAT')).toBe(MessageStatus.DELIVERED);
  });

  it('advances a phone-stored message for a lid receipt with no reported pairing', async () => {
    await seed('WA_LID_UNMAPPED', PEER);
    ack('WA_LID_UNMAPPED', 'read', PEER_LID);
    await settle();
    expect(await statusOf('WA_LID_UNMAPPED')).toBe(MessageStatus.READ);
  });

  it('advances for a lid paired with the message chat, and not for one paired with another phone', async () => {
    await seed('WA_LID_SAME', PEER);
    await seed('WA_LID_OTHER', OTHER);
    lidPhones.set('99990001111', '15550001111');
    ack('WA_LID_SAME', 'delivered', PEER_LID);
    ack('WA_LID_OTHER', 'delivered', PEER_LID);
    await settle();
    expect(await statusOf('WA_LID_SAME')).toBe(MessageStatus.DELIVERED);
    expect(await statusOf('WA_LID_OTHER')).toBe(MessageStatus.SENT);
  });

  it('advances a message the account sent to a broadcast list for a recipient receipt', async () => {
    await seed('WA_LIST', '1700000000@broadcast');
    ack('WA_LIST', 'read', PEER);
    await settle();
    expect(await statusOf('WA_LIST')).toBe(MessageStatus.READ);
  });

  it('judges a receipt that arrived before its row, once the row is written', async () => {
    ack('WA_LATE_SAME', 'delivered', PEER);
    ack('WA_LATE_OTHER', 'delivered', OTHER);
    await new Promise(resolve => setTimeout(resolve, 100));
    await seed('WA_LATE_SAME', PEER);
    await seed('WA_LATE_OTHER', GROUP);
    await settle();
    expect(await statusOf('WA_LATE_SAME')).toBe(MessageStatus.DELIVERED);
    expect(await statusOf('WA_LATE_OTHER')).toBe(MessageStatus.SENT);
  });

  it('keeps a foreign receipt off a message that has not been written yet', async () => {
    const own = (id: string, chatId: string): IncomingMessage => ({
      id,
      chatId,
      from: '15559990000@c.us',
      to: chatId,
      body: 'composed on the phone',
      type: 'text',
      timestamp: 1_700_000_000,
      fromMe: true,
      isGroup: chatId.endsWith('@g.us'),
      kind: chatId.endsWith('@g.us') ? 'group' : 'individual',
    });
    projector.handleOwnSendEcho('s1', engine, own('WA_INFLIGHT_GROUP', GROUP));
    projector.handleOwnSendEcho('s1', engine, own('WA_INFLIGHT_PEER', PEER));
    ack('WA_INFLIGHT_GROUP', 'read', OTHER);
    ack('WA_INFLIGHT_PEER', 'read', PEER);
    await settle();
    expect(await statusOf('WA_INFLIGHT_GROUP')).toBe(MessageStatus.SENT);
    expect(await statusOf('WA_INFLIGHT_PEER')).toBe(MessageStatus.READ);
  });
});
