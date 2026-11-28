import 'reflect-metadata';
import type { Client } from 'whatsapp-web.js';
import { DataSource, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks';
import { WwebjsMessaging } from '../../engine/adapters/wwebjs-messaging';
import type { WwebjsEngineHost } from '../../engine/adapters/wwebjs-host';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { ChatScopeService } from '../auth/chat-scope.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { MessageService } from './message.service';

/**
 * whatsapp-web.js resolves a phone id before it sends, and the lookup can answer only the contact's lid: WhatsApp then
 * says the digits written reach that lid, not that they are the phone it holds for it. The row is filed under the lid,
 * where the contact's replies arrive, whichever writer stores it first, and the digits written are reported for the
 * lid only while no other phone is: a lid another source reported with the number as WhatsApp holds it keeps it.
 *
 * Real tables, the real lid store and the real adapter, SQLite in memory. The echo of a send is stored by hand:
 * before the send returns (echo first), or never, as it loses its insert to the send's own row (row first).
 */
const SELF = '628000000000@c.us';
const LID = '484848484848@lid';
const WRITTEN = '5511987654321@c.us';
const HELD = '551187654321@c.us';
const logger = createLogger('wwjs-send-lid-answer.spec');

describe('a whatsapp-web.js send whose number lookup answers the lid of the contact', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let store: LidMappingStoreService;
  let sender: MessageSendService;
  let service: MessageService;
  let scope: ChatScopeService;
  let getNumberId: jest.Mock;
  let sessionId: string;
  let echoFirst: boolean;
  let writes: Set<Promise<unknown>>;

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await new Promise(resolve => setImmediate(resolve));
      await Promise.allSettled([...writes]);
    }
  };
  const thread = async (chatId: string): Promise<string[]> =>
    (await service.getMessages(sessionId, { chatId })).messages.map(m => m.waMessageId).sort();
  const rows = async (): Promise<Array<[string, string]>> =>
    (await messages.find({ order: { waMessageId: 'ASC' } })).map(row => [row.waMessageId, row.chatId]);
  const pair = async (): Promise<[string | null, boolean] | null> => {
    const row = await ds.getRepository(LidMapping).findOneBy({ lid: '484848484848' });
    return row ? [row.phone, row.isReported] : null;
  };
  const send = (chatId: string, text = 'hello') => sender.sendText(sessionId, { chatId, text });

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    echoFirst = false;
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping, Session, Message],
      synchronize: true,
    }).initialize();
    const sessions = ds.getRepository(Session);
    messages = ds.getRepository(Message);
    sessionId = (
      await sessions.save(sessions.create({ name: 'wwjs', phone: '628000000000', status: SessionStatus.READY }))
    ).id;
    store = new LidMappingStoreService(ds.getRepository(LidMapping));
    await store.onModuleInit();
    writes = new Set();
    for (const method of ['remember', 'rememberIfUnknown', 'findPhoneForLid'] as const) {
      const real = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
      jest.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
        const write = real(...args);
        writes.add(write);
        return write;
      }) as never);
    }
    let sent = 0;
    const client = {
      sendMessage: jest.fn(async (to: string, body: string) => {
        const id = `M${++sent}`;
        if (echoFirst) {
          await messages.insert({
            sessionId,
            waMessageId: id,
            chatId: to,
            from: SELF,
            to,
            body,
            type: 'text',
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.SENT,
          });
        }
        return { id: { _serialized: id }, timestamp: 1_700_000_100 };
      }),
    };
    getNumberId = jest.fn(() => Promise.resolve(LID));
    const host = {
      ensureReady: jest.fn(),
      ensureNotChannelRecipient: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      config: { lidMappingStore: store, sessionId },
      getNumberId,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    const messaging = new WwebjsMessaging(host);
    const engines = new EngineRegistry();
    engines.set(sessionId, {
      sendTextMessage: (...args: Parameters<WwebjsMessaging['sendTextMessage']>) => messaging.sendTextMessage(...args),
      sendChatState: () => Promise.resolve(),
    } as unknown as IWhatsAppEngine);
    const hooks = new HookManager();
    const pacing = {
      assertSendAllowed: () => Promise.resolve(() => undefined),
      recordSendSuccess: () => undefined,
      recordSendFailure: () => undefined,
      rememberResolvedNumber: jest.fn(),
    };
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
      engines,
      hooks,
      {} as never,
      pacing as never,
      undefined,
      undefined,
      store,
    );
    service = new MessageService(messages, engines, {} as never, hooks, store, pacing as never, sender);
    scope = new ChatScopeService(store);
  });

  afterEach(async () => {
    await settle();
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    store.onModuleDestroy();
    await ds.destroy();
  });

  describe.each([
    ['row first', false],
    ['echo first', true],
  ])('%s', (_order, first) => {
    beforeEach(() => {
      echoFirst = first;
    });

    it('files a send to another spelling under the lid, never out of the thread of the number held', async () => {
      await send(WRITTEN);
      await settle();

      expect(await rows()).toEqual([['M1', LID]]);
      expect(await pair()).toEqual(['5511987654321', true]);
      expect(await thread(WRITTEN)).toEqual(['M1']);
      expect(await thread(LID)).toEqual(['M1']);

      // A display lookup of the number WhatsApp holds takes the pair back; the lid thread keeps the row.
      await store.rememberIfUnknown('484848484848', '551187654321', sessionId);
      await settle();
      expect(await thread(LID)).toEqual(['M1']);

      // An engine report of that number brings the row into its thread.
      await store.remember('484848484848', '551187654321', 'another-session');
      await settle();
      expect(await thread(HELD)).toEqual(['M1']);
      expect(await thread(LID)).toEqual(['M1']);
    });

    it('files a second send, whose lookup the adapter remembers, the same way', async () => {
      await send(WRITTEN, 'first');
      await send(WRITTEN, 'second');
      await settle();

      expect(getNumberId).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual([
        ['M1', LID],
        ['M2', LID],
      ]);
    });

    it('lists a send to the number written as WhatsApp holds it under that number, through the pair it reports', async () => {
      await send(HELD);
      await settle();

      expect(await rows()).toEqual([['M1', LID]]);
      expect(await pair()).toEqual(['551187654321', true]);
      expect(await thread(HELD)).toEqual(['M1']);
      expect(await thread(LID)).toEqual(['M1']);
    });

    it('keeps the pair another source reported for the lid when the send writes another spelling', async () => {
      await store.remember('484848484848', '551187654321', 'another-session');
      await messages.insert({
        sessionId,
        waMessageId: 'IN-OLD',
        chatId: LID,
        from: LID,
        to: SELF,
        type: 'text',
        body: 'earlier',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      });
      await settle();
      expect(await scope.allows({ allowedChats: [HELD] }, LID)).toBe(true);

      await send(WRITTEN);
      await settle();

      expect(await pair()).toEqual(['551187654321', true]);
      expect(await rows()).toEqual([
        ['IN-OLD', LID],
        ['M1', LID],
      ]);
      expect(await thread(HELD)).toEqual(['IN-OLD', 'M1']);
      expect(await scope.allows({ allowedChats: [HELD] }, LID)).toBe(true);
      expect(await scope.allows({ allowedChats: [WRITTEN] }, LID)).toBe(false);
    });
  });
});
