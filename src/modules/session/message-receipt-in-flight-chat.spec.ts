import { DataSource, type Repository } from 'typeorm';
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
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

/**
 * Baileys relays a peer's receipt under the peer's own chat with every id it lists, unchecked, so the
 * projector holds a receipt that names a chat to the message it names: a written row of another chat is
 * neither advanced nor announced. The same holds while that message's row is still being written, where
 * a lid and a phone number are compared through the lid directory as they are for a written row.
 */
describe('a receipt naming a chat for an own message still in flight', () => {
  const SESSION = 's1';
  const ID = '3EB0F00DFEEDBEEF';
  const OWN_CHAT = '15550001111@c.us';
  // The directory pairs this lid with another person (15550002222): a receipt from it is from another chat.
  const FOREIGN = '88880002222@lid';
  // The directory pairs this lid with the person the message went to.
  const PAIRED = '88880001111@lid';
  let db: DataSource;
  let repo: Repository<Message>;
  let projector: MessageProjector;
  let dispatch: jest.Mock;
  let release!: () => void;
  const engine = { tag: 'in-flight-receipt' } as unknown as IWhatsAppEngine;

  const echo: IncomingMessage = {
    id: ID,
    from: '15550000000@c.us',
    to: OWN_CHAT,
    chatId: OWN_CHAT,
    body: 'hello',
    type: 'text',
    timestamp: 1_786_000_000,
    fromMe: true,
    isGroup: false,
    kind: 'individual',
  };

  beforeEach(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await db.initialize();
    repo = db.getRepository(Message);
    const engines = new EngineRegistry();
    engines.set(SESSION, engine);
    dispatch = jest.fn().mockResolvedValue(undefined);
    const held = new Promise<void>(resolve => (release = resolve));
    const hooks = {
      execute: jest.fn(async (event: string, data: unknown) => {
        // The echo's message:sent chain is still running when the receipt arrives.
        if (event === 'message:sent') await held;
        return { continue: true, data };
      }),
    } as unknown as HookManager;
    const phones: Record<string, string> = { '88880002222': '15550002222', '88880001111': '15550001111' };
    const lidStore = {
      findPhoneForLid: (jid: string) => Promise.resolve(phones[jid.replace(/@lid$/, '')] ?? null),
      findLidsForPhone: () => Promise.resolve([]),
    } as unknown as LidMappingStoreService;
    projector = new MessageProjector(
      repo,
      db.getRepository(Session),
      engines,
      {
        emitMessageSent: jest.fn(),
        emitMessageAck: jest.fn(),
      } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      hooks,
      {} as StatusStoreService,
      {} as SessionLidResolver,
      undefined,
      undefined,
      undefined,
      lidStore,
    );
  });

  afterEach(async () => {
    // Let the projector's one ack retry fire into this test's database before it is closed.
    await new Promise(resolve => setTimeout(resolve, ACK_RECONCILE_DELAY_MS + 100));
    await db.destroy();
  });

  const acks = (): string[] =>
    (dispatch.mock.calls as Array<[string, string, { status: string }]>)
      .filter(([, event]) => event === 'message.ack')
      .map(([, , payload]) => payload.status);

  /** The row once its insert has landed (and, given `status`, reached it) and the changes kept for it were applied. */
  const written = async (status?: MessageStatus): Promise<Message | null> => {
    for (const start = Date.now(); Date.now() - start < 3000;) {
      const row = await repo.findOneBy({ waMessageId: ID });
      if (row && (!status || row.status === status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    return repo.findOneBy({ waMessageId: ID });
  };

  const inFlight = async (): Promise<void> => {
    projector.handleOwnSendEcho(SESSION, engine, echo);
    await new Promise(resolve => setImmediate(resolve));
  };

  it('is dropped once the row is written', async () => {
    release();
    projector.handleOwnSendEcho(SESSION, engine, echo);
    await written();

    projector.handleMessageAck(SESSION, engine, ID, 'read', FOREIGN);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect({ status: (await repo.findOneBy({ waMessageId: ID }))?.status, acks: acks() }).toEqual({
      status: MessageStatus.SENT,
      acks: [],
    });
  });

  it('neither advances the row nor announces message.ack while the row is being written', async () => {
    await inFlight();
    projector.handleMessageAck(SESSION, engine, ID, 'read', FOREIGN);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();

    const row = await written();
    expect(row?.direction).toBe(MessageDirection.OUTGOING);
    expect({ status: row?.status, acks: acks() }).toEqual({ status: MessageStatus.SENT, acks: [] });
  });

  it('keeps a delivery from the message chat when a read from another chat follows it', async () => {
    await inFlight();
    projector.handleMessageAck(SESSION, engine, ID, 'delivered', OWN_CHAT);
    projector.handleMessageAck(SESSION, engine, ID, 'read', FOREIGN);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();

    expect({ status: (await written(MessageStatus.DELIVERED))?.status, acks: acks() }).toEqual({
      status: MessageStatus.DELIVERED,
      acks: ['delivered'],
    });
  });

  it('advances a read from the lid the directory pairs with the message chat', async () => {
    await inFlight();
    projector.handleMessageAck(SESSION, engine, ID, 'read', PAIRED);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();

    expect({ status: (await written(MessageStatus.READ))?.status, acks: acks() }).toEqual({
      status: MessageStatus.READ,
      acks: ['read'],
    });
  });

  it('lands a receipt on a row whose message:sent hook outlasts the ack retry', async () => {
    await inFlight();
    projector.handleMessageAck(SESSION, engine, ID, 'read', PAIRED);
    await new Promise(resolve => setTimeout(resolve, ACK_RECONCILE_DELAY_MS + 250));
    release();

    expect({ status: (await written(MessageStatus.READ))?.status, acks: acks() }).toEqual({
      status: MessageStatus.READ,
      acks: ['read'],
    });
  });

  it('advances to the furthest of the receipts kept from the message chat in either dialect', async () => {
    await inFlight();
    projector.handleMessageAck(SESSION, engine, ID, 'delivered', OWN_CHAT);
    projector.handleMessageAck(SESSION, engine, ID, 'read', PAIRED);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();

    expect({ status: (await written(MessageStatus.READ))?.status, acks: acks().sort() }).toEqual({
      status: MessageStatus.READ,
      acks: ['delivered', 'read'],
    });
  });
});
