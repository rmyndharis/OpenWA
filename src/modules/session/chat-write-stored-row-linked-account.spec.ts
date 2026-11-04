import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { AuditService } from '../audit/audit.service';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { StoredChatPreviewService } from '../../engine/adapters/baileys-stored-chat-previews.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import type {
  IWhatsAppEngine,
  StoredChatMessage,
  StoredChatMessageLookup,
} from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * The messages table outlives an unlink, so a session linked to another number still holds the rows of the
 * account before. A Baileys chat write (clear, delete, archive, unread, read receipt) is keyed to the newest
 * stored message of the chat when the engine holds none in memory. That message must be one of the account the
 * session is linked to now, as the chat list seeded from the same table already requires: a key naming the
 * previous account's message names nothing the linked phone holds.
 */
describe('the stored message a chat write is keyed to', () => {
  const SESSION = 'sess-1';
  const CHAT = '628111@c.us';
  const GROUP = '120363-1@g.us';
  const SENDER = '628333@c.us';
  /** The number linked now, and the one before. */
  const LINKED = '628222';
  const PREVIOUS = '628999';
  let db: DataSource;
  let messages: Repository<Message>;
  let service: SessionService;
  let registry: EngineRegistry;
  let lookup: StoredChatMessageLookup | undefined;
  let sessions: { findOne: jest.Mock };
  let linkedSession: Session;
  let engine: { getPhoneNumber: jest.Mock<string | null, []> };

  async function incoming(
    waMessageId: string,
    to: string,
    timestamp: number,
    chatId = CHAT,
    author?: string,
  ): Promise<void> {
    await messages.save(
      messages.create({
        sessionId: SESSION,
        waMessageId,
        chatId,
        from: chatId,
        to,
        author,
        body: waMessageId,
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp,
      }),
    );
  }

  async function outgoing(waMessageId: string, from: string, timestamp: number, chatId = CHAT): Promise<void> {
    await messages.save(
      messages.create({
        sessionId: SESSION,
        waMessageId,
        chatId,
        from,
        to: chatId,
        body: waMessageId,
        type: 'text',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp,
      }),
    );
  }

  /** What the engine reads when it asks for the stored message of a write (`write`) or of a read receipt (`read`). */
  async function stored(kind: 'write' | 'read' = 'write', chatId = CHAT): Promise<StoredChatMessage | null> {
    lookup = undefined;
    await (kind === 'write' ? service.clearChatMessages(SESSION, chatId) : service.sendSeen(SESSION, chatId));
    expect(lookup).toBeDefined();
    return lookup!();
  }

  beforeEach(async () => {
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await db.initialize();
    messages = db.getRepository(Message);
    lookup = undefined;

    // The control flag is cleared, as an unlink leaves it: the account comes from the engine, not from here.
    linkedSession = {
      id: SESSION,
      name: 'desk',
      phone: null,
      status: SessionStatus.READY,
      pushName: null,
      config: {},
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
      nodeId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      desiredState: null,
      nodeUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sessions = { findOne: jest.fn().mockResolvedValue(linkedSession) };
    const sessionRepository = {
      ...sessions,
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      exists: jest.fn().mockResolvedValue(true),
    };
    const lidMappingStore = {
      remember: jest.fn().mockResolvedValue(undefined),
      getCached: jest.fn().mockReturnValue(undefined),
      lidsForPhone: jest.fn().mockReturnValue([]),
      findPhoneForLid: jest.fn().mockResolvedValue(null),
      findLidsForPhone: jest.fn().mockResolvedValue([]),
      onSecondLid: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionEngineLifecycle,
        SessionErrorStore,
        SessionRestrictionStore,
        PresenceStore,
        { provide: AuditService, useValue: { logWarn: jest.fn(), logInfo: jest.fn() } },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository },
        { provide: getRepositoryToken(Message, 'data'), useValue: messages },
        { provide: getDataSourceToken('data'), useValue: db },
        { provide: EngineFactory, useValue: { create: jest.fn(), purgeSessionData: jest.fn() } },
        EngineRegistry,
        SessionLidResolver,
        SessionLivenessWatchdog,
        MessageProjector,
        { provide: EventsGateway, useValue: { emitSessionStatus: jest.fn() } },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: HookManager,
          useValue: { execute: jest.fn((_e: string, data: unknown) => Promise.resolve({ continue: true, data })) },
        },
        { provide: ConfigService, useValue: { get: jest.fn(<T>(_k: string, def?: T): T => def as T) } },
        { provide: LidMappingStoreService, useValue: lidMappingStore },
        { provide: StatusStoreService, useValue: { ingest: jest.fn() } },
        ShutdownService,
      ],
    }).compile();
    service = module.get(SessionService);

    // A Baileys engine after a restart holds no message of the chat in memory, so it reads the stored one.
    engine = {
      getPhoneNumber: jest.fn<string | null, []>().mockReturnValue(LINKED),
      clearChatMessages: jest.fn((_chatId: string, stored?: StoredChatMessageLookup) => {
        lookup = stored;
        return Promise.resolve(false);
      }),
      sendSeen: jest.fn(
        (_chatId: string, _ids: string[] | undefined, _authors: unknown, stored?: StoredChatMessageLookup) => {
          lookup = stored;
          return Promise.resolve(false);
        },
      ),
    } as unknown as typeof engine;
    registry = module.get(EngineRegistry);
    registry.set(SESSION, engine as unknown as IWhatsAppEngine);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it.each([null, PREVIOUS])(
    "keys the write to the linked account's newest message, not to a newer one of the account before (session row phone %s)",
    async rowPhone => {
      sessions.findOne.mockResolvedValue({ ...linkedSession, phone: rowPhone });
      // The account before received the newest stored message of this chat; the linked account's own
      // conversation with the same contact came back through history sync with its older WhatsApp time.
      await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 2_000);
      await incoming('LINKED-ACCOUNT', `${LINKED}@c.us`, 1_000);

      expect((await stored())?.id).toBe('LINKED-ACCOUNT');
    },
  );

  it("keys the write to the linked account's newest sent message, not to a newer one the account before sent", async () => {
    await outgoing('PREVIOUS-SENT', `${PREVIOUS}@c.us`, 2_000);
    await outgoing('LINKED-SENT', `${LINKED}@c.us`, 1_000);

    await expect(stored()).resolves.toMatchObject({ id: 'LINKED-SENT', fromMe: true });
  });

  it('takes the newest of the linked account across what it received and what it sent', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 4_000);
    await outgoing('LINKED-SENT', `${LINKED}@c.us`, 3_000);
    await incoming('LINKED-RECEIVED', `${LINKED}@c.us`, 2_000);

    await expect(stored()).resolves.toMatchObject({ id: 'LINKED-SENT', fromMe: true });
  });

  it('in a group, takes the linked account only: its received message with a sender, or its own', async () => {
    await incoming('PREVIOUS-RECEIVED', `${PREVIOUS}@c.us`, 3_000, GROUP, SENDER);
    await outgoing('PREVIOUS-SENT', `${PREVIOUS}@c.us`, 2_500, GROUP);
    await incoming('LINKED-RECEIVED', `${LINKED}@c.us`, 2_000, GROUP, SENDER);

    await expect(stored('write', GROUP)).resolves.toMatchObject({ id: 'LINKED-RECEIVED', author: SENDER });

    await outgoing('LINKED-SENT', `${LINKED}@c.us`, 1_000, GROUP);
    await expect(stored('write', GROUP)).resolves.toMatchObject({ id: 'LINKED-RECEIVED' });
    await outgoing('LINKED-SENT-LATER', `${LINKED}@c.us`, 2_200, GROUP);
    await expect(stored('write', GROUP)).resolves.toMatchObject({ id: 'LINKED-SENT-LATER', fromMe: true });
  });

  it('counts a send stored before 0.27.0, which names the account by its bare digits', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 1_000);
    await outgoing('LINKED-API-SEND', LINKED, 2_000);

    await expect(stored()).resolves.toMatchObject({ id: 'LINKED-API-SEND', fromMe: true });
  });

  it('counts a received message stored under the raw protocol dialect of the account', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 1_000);
    await incoming('LINKED-ACCOUNT', `${LINKED}@s.whatsapp.net`, 2_000);

    await expect(stored()).resolves.toMatchObject({ id: 'LINKED-ACCOUNT' });
  });

  it('keys no write to a send stored before the gateway knew the number', async () => {
    await incoming('LINKED-ACCOUNT', `${LINKED}@c.us`, 1_000);
    await outgoing('NO-NUMBER-YET', 'me', 2_000);

    await expect(stored()).resolves.toMatchObject({ id: 'LINKED-ACCOUNT' });

    await messages.delete({ waMessageId: 'LINKED-ACCOUNT' });
    await expect(stored()).resolves.toBeNull();
  });

  it('keys a read receipt to the newest message the linked account received, whatever else the table holds', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 4_000);
    await outgoing('LINKED-SENT', `${LINKED}@c.us`, 3_000);
    await incoming('LINKED-RECEIVED', `${LINKED}@c.us`, 2_000);

    await expect(stored('read')).resolves.toMatchObject({ id: 'LINKED-RECEIVED', fromMe: false });
  });

  it('answers none for a chat that holds only the account before', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 1_000);
    await outgoing('PREVIOUS-SENT', `${PREVIOUS}@c.us`, 2_000);

    await expect(stored()).resolves.toBeNull();
    await expect(stored('read')).resolves.toBeNull();
  });

  it.each([null, ''])('reads no row when the engine reports the phone %j', async phone => {
    await incoming('LINKED-ACCOUNT', `${LINKED}@c.us`, 1_000);
    engine.getPhoneNumber.mockReturnValue(phone);
    const read = jest.spyOn(messages, 'findOne');

    await expect(stored()).resolves.toBeNull();

    expect(read).not.toHaveBeenCalled();
  });

  it('asks the engine that runs the write, not whichever engine the session has registered by then', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 2_000);
    await incoming('LINKED-ACCOUNT', `${LINKED}@c.us`, 1_000);
    lookup = undefined;
    await service.clearChatMessages(SESSION, CHAT);
    const replacement = { getPhoneNumber: () => PREVIOUS } as unknown as IWhatsAppEngine;
    // A stop and start swaps the registered engine while the write's lookup is still to run.
    registry.set(SESSION, replacement);

    expect((await lookup!())?.id).toBe('LINKED-ACCOUNT');
  });

  it('is the message the chat list previews for the same account', async () => {
    await incoming('PREVIOUS-ACCOUNT', `${PREVIOUS}@c.us`, 4_000);
    await outgoing('NO-NUMBER-YET', 'me', 3_000);
    await outgoing('LINKED-API-SEND', LINKED, 2_000);
    await incoming('LINKED-ACCOUNT', `${LINKED}@s.whatsapp.net`, 1_000);

    const own = [`${LINKED}@c.us`, `${LINKED}@s.whatsapp.net`, LINKED];
    const listed = await new StoredChatPreviewService(messages).latestPerChat(SESSION, own, 0);

    expect(listed.map(chat => chat.id)).toEqual(['LINKED-API-SEND']);
    expect((await stored())?.id).toBe('LINKED-API-SEND');
  });
});
