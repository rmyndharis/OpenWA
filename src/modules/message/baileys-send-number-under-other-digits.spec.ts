import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import { from, lastValueFrom } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { waitUntil } from '../../../test/helpers/wait-until';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { HookManager } from '../../core/hooks';
import { BaileysEvents, type BaileysEventsHost } from '../../engine/adapters/baileys-events';
import { BaileysMessaging } from '../../engine/adapters/baileys-messaging';
import { OwnSendRegistry } from '../../engine/adapters/baileys-own-sends';
import { BaileysSessionStore } from '../../engine/adapters/baileys-session-store';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import type {
  DeliveryStatus,
  IncomingMessage,
  IWhatsAppEngine,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { ChatScopeService } from '../auth/chat-scope.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import { SessionLidResolver } from '../session/session-lid-resolver.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SendIdempotencyKey } from './entities/send-idempotency-key.entity';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { MessageSendService } from './message-send.service';
import { MessageService } from './message.service';

/**
 * A caller writes a number in a form WhatsApp holds under other digits (a Brazilian mobile with its ninth digit). The
 * number check answers the number WhatsApp holds, the message goes there, or to the lid Baileys holds for it, and the
 * reply arrives in that chat. The stored row belongs with it: under the number WhatsApp resolved, as a phone id.
 *
 * Real: SQLite, the mapping store, the Baileys session store, events, messaging and own-send registry, the engine
 * registry, the hook manager, the projector, both message services and the idempotency interceptor. Stand-ins: the
 * socket (its number check answers the number WhatsApp holds for whatever is asked), the Baileys library object, the
 * Baileys message store (a Map by message id), the session lookup, pacing, the websocket gateway and the webhooks.
 */
const TYPED = '5511987654321';
const CANON = '551187654321';
const LID = '484848484848';
const SELF = '628000000000';
const typed = `${TYPED}@c.us`;
const canon = `${CANON}@c.us`;
const lid = `${LID}@lid`;

type Answer = { list: Array<{ id: string; lid?: string }> } | undefined;
class User {
  id = '';
  withId(id: string): this {
    this.id = id;
    return this;
  }
}
class Query {
  users: User[] = [];
  withLIDProtocol(): this {
    return this;
  }
  withContext(): this {
    return this;
  }
  withUser(user: User): this {
    this.users.push(user);
    return this;
  }
}

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) => Object.keys(content ?? {})[0],
  isRealMessage: () => true,
  proto: {
    Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } },
    PinInChat: { Type: { PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } },
  },
  BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
  USyncQuery: Query,
  USyncUser: User,
};

/** 'ok', or what refused it: error class, HTTP status when it has one, message. */
const outcome = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'ok';
  } catch (error) {
    const e = error as { constructor: { name: string }; message?: string; getStatus?: () => number };
    return `refused ${e.constructor.name}${e.getStatus ? ` ${e.getStatus()}` : ''}: ${e.message ?? ''}`;
  }
};

interface World {
  ds: DataSource;
  S: string;
  messages: Repository<Message>;
  store: LidMappingStoreService;
  sessionStore: BaileysSessionStore;
  sock: {
    onWhatsApp: jest.Mock;
    sendMessage: jest.Mock;
    executeUSyncQuery: jest.Mock;
    chatModify: jest.Mock;
    signalRepository: { lidMapping: { getLIDForPN: jest.Mock } };
  };
  events: BaileysEvents;
  sender: MessageSendService;
  service: MessageService;
  /** What the engine answered each send with. */
  results: MessageResult[];
  /** What the engine handed to onMessageCreate, in order. */
  echoes: IncomingMessage[];
  /** warn and error lines of the engine logger. */
  engineLog: string[];
  webhooks: { dispatch: jest.Mock };
  /** The states of the send's row announced to `message:persisted`, as [status, chatId], in order. */
  persisted(): Array<[string, string]>;
  /** The pacing stand-in: what the send path told it about a number WhatsApp resolved. */
  pacing: { rememberResolvedNumber: jest.Mock };
  /** Hold the engine's send until the own-send echo wrote its row (the order the REST path calls "the echo won"). */
  echoFirst: boolean;
  /** A delivery ack of the sent message, as the engine reports it to the real projector. */
  ack(status: DeliveryStatus, chatId: string): void;
  /** A reaction by the contact, an edit and a revoke made on the account's phone, each naming a chat, the same way. */
  react(chatId: string): void;
  edit(chatId: string, body: string): void;
  revoke(chatId: string): void;
  settle(): Promise<void>;
  rows(): Promise<Array<Record<string, unknown>>>;
  thread(chatId: string): Promise<Array<string | null>>;
  interceptor: SendIdempotencyInterceptor;
}

const worlds: World[] = [];

/**
 * `lidKnown`: Baileys' own mapping holds a lid for the number WhatsApp holds (a lookup, so display data only).
 * `named`: WhatsApp names that lid for the number when asked.
 */
const build = async ({ lidKnown, named = lidKnown }: { lidKnown: boolean; named?: boolean }): Promise<World> => {
  const ds = await new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [LidMapping, Session, Message, SendIdempotencyKey],
    synchronize: true,
  }).initialize();
  const sessions = ds.getRepository(Session);
  const messages = ds.getRepository(Message);
  const session = await sessions.save(
    sessions.create({ name: 'other-digits', phone: SELF, status: SessionStatus.READY, config: {} }),
  );
  const S = session.id;
  const store = new LidMappingStoreService(ds.getRepository(LidMapping));
  await store.onModuleInit();
  const writes = new Set<Promise<unknown>>();
  for (const method of ['remember', 'rememberIfUnknown'] as const) {
    const real = store[method].bind(store);
    jest.spyOn(store, method).mockImplementation((...args: Parameters<typeof store.remember>) => {
      const write = real(...(args as [string, string, string]));
      writes.add(write);
      return write;
    });
  }
  const sessionStore = new BaileysSessionStore(store, S);
  const ownSends = new OwnSendRegistry();
  const stored = new Map<string, WAMessage>();
  const engineLog: string[] = [];
  const echoes: IncomingMessage[] = [];
  let sent = 0;
  const sock = {
    // WhatsApp answers the number check with the canonical number, whatever digits were asked about.
    onWhatsApp: jest.fn(() => Promise.resolve([{ jid: `${CANON}@s.whatsapp.net`, exists: true }])),
    sendMessage: jest.fn((jid: string, content: { text?: string; edit?: unknown; react?: unknown; delete?: unknown }) =>
      Promise.resolve({
        key: { id: `OUT-${++sent}`, remoteJid: jid, fromMe: true },
        message:
          content.react || content.delete || content.edit
            ? { protocolMessage: {} }
            : { extendedTextMessage: { text: content.text } },
        messageTimestamp: 1_700_000_100 + sent,
      }),
    ),
    waUploadToServer: jest.fn(),
    sendPresenceUpdate: jest.fn(() => Promise.resolve()),
    chatModify: jest.fn(() => Promise.resolve()),
    signalRepository: {
      lidMapping: {
        getLIDForPN: jest.fn((pn: string) => Promise.resolve(lidKnown && pn.startsWith(`${CANON}@`) ? lid : null)),
      },
    },
    // The public LID query: a lid for the canonical number when one exists, none for the typed digits.
    executeUSyncQuery: jest.fn((query: Query): Promise<Answer> =>
      Promise.resolve({
        list: query.users.map(({ id }) => (named && id.startsWith(`${CANON}@`) ? { id, lid } : { id })),
      }),
    ),
  };
  const line =
    (level: string) =>
    (message: unknown, context?: unknown): void => {
      engineLog.push(`${level} ${String(message)}${context ? ` ${JSON.stringify(context)}` : ''}`);
    };
  const world = { echoFirst: false } as World;
  const engines = new EngineRegistry();
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    getSocketOrNull: () => sock as unknown as WASocket,
    logger: { log: () => undefined, debug: () => undefined, warn: line('warn'), error: line('error') },
    toNeutralJid: (jid: string) => sessionStore.toNeutralJid(jid),
    toEngineJid: (jid: string) => sessionStore.toEngineJid(jid),
    normalizedSelfJid: () => `${SELF}@s.whatsapp.net`,
    loadLib: () => Promise.resolve(lib as never),
    getLoadedLib: () => lib as never,
    getFetchDispatcher: () => undefined,
    inboundLimiter: new ConcurrencyLimiter(4),
    sessionProxyUrl: () => undefined,
    getEphemeralExpiration: (chatId: string) => sessionStore.getEphemeralExpiration(chatId),
    toUnixSeconds: (ts: unknown) => (typeof ts === 'number' ? ts : 0),
    // The adapter's own wiring of the session store, the mapping table and the own-send registry.
    recordKeyLidMappings: (key: WAMessageKey) => sessionStore.recordKeyLidMappings(key),
    recordMessage: (...args: Parameters<BaileysSessionStore['recordMessage']>) => sessionStore.recordMessage(...args),
    nextMessageOrder: () => sessionStore.nextMessageOrder(),
    recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
      sessionStore.recordMessageEdit(...args),
    findPersistedLidPhone: (id: string) => store.findPhoneForLid(id),
    recordLidMapping: (id: string, pn: string, isReported = true) =>
      sessionStore.addLidMappings([{ lid: id, pn }], isReported),
    rememberOwnSend: (id: string | null | undefined) => ownSends.remember(id),
    consumeOwnSend: (id: string | null | undefined) => ownSends.consume(id),
    putStoredMessage: (msg: WAMessage) => {
      if (msg.key.id) stored.set(msg.key.id, msg);
      return Promise.resolve();
    },
    getStoredMessage: (id: string) => Promise.resolve(stored.get(id) ?? null),
    updateStoredMessage: (id: string, change: (held: WAMessage) => WAMessage | null) => {
      const held = stored.get(id);
      const next = held ? change(held) : null;
      if (next) stored.set(id, next);
      return Promise.resolve();
    },
    removeStoredMessage: (id: string) => {
      stored.delete(id);
      return Promise.resolve();
    },
    getOnMessage: () => (message: IncomingMessage) => projector.handleInboundMessage(S, engine, message),
    getOnMessageCreate: () => (message: IncomingMessage) => {
      echoes.push(message);
      projector.handleOwnSendEcho(S, engine, message);
    },
    getOnMessageEdited: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
  };
  const events = new BaileysEvents(host as unknown as BaileysEventsHost);
  const messaging = new BaileysMessaging({
    ...host,
    mapMessage: (...args: Parameters<BaileysEvents['mapMessage']>) => events.mapMessage(...args),
    wasDeletedForEveryone: (id: string) => events.wasDeletedForEveryone(id),
    markDeletedForEveryone: (id: string) => events.markDeletedForEveryone(id),
    pendingEditOf: (id: string, key: WAMessageKey) => events.pendingEditOf(id, key),
  } as never);
  const results: MessageResult[] = [];
  /** Keep what the engine answered and, in the echo-first order, hold it until the own-send echo wrote its row. */
  const answered = async (work: Promise<MessageResult>): Promise<MessageResult> => {
    const result = await work;
    results.push(result);
    if (world.echoFirst) {
      await waitUntil(async () => (await messages.countBy({ waMessageId: result.id })) > 0, 2000);
    }
    return result;
  };
  const engine = {
    sendTextMessage: (...args: Parameters<BaileysMessaging['sendTextMessage']>) =>
      answered(messaging.sendTextMessage(...args)),
    sendLocationMessage: (...args: Parameters<BaileysMessaging['sendLocationMessage']>) =>
      answered(messaging.sendLocationMessage(...args)),
    replyToMessage: (...args: Parameters<BaileysMessaging['replyToMessage']>) =>
      answered(messaging.replyToMessage(...args)),
    forwardMessage: (...args: Parameters<BaileysMessaging['forwardMessage']>) =>
      answered(messaging.forwardMessage(...args)),
    starMessage: (...args: Parameters<BaileysMessaging['starMessage']>) => messaging.starMessage(...args),
    pinMessage: (...args: Parameters<BaileysMessaging['pinMessage']>) => messaging.pinMessage(...args),
    unpinMessage: (...args: Parameters<BaileysMessaging['unpinMessage']>) => messaging.unpinMessage(...args),
    sendChatState: (...args: Parameters<BaileysMessaging['sendChatState']>) => messaging.sendChatState(...args),
    reactToMessage: (...args: Parameters<BaileysMessaging['reactToMessage']>) => messaging.reactToMessage(...args),
    editMessage: (...args: Parameters<BaileysMessaging['editMessage']>) => messaging.editMessage(...args),
    deleteMessage: (...args: Parameters<BaileysMessaging['deleteMessage']>) => messaging.deleteMessage(...args),
  } as unknown as IWhatsAppEngine;
  engines.set(S, engine);

  const hooks = new HookManager();
  const announced = jest.spyOn(hooks, 'execute');
  const pacing = {
    assertSendAllowed: () => Promise.resolve(() => undefined),
    recordSendSuccess: () => undefined,
    recordSendFailure: () => undefined,
    rememberResolvedNumber: jest.fn(),
  };
  const gateway = {
    emitNewMessage: jest.fn(),
    emitMessage: jest.fn(),
    emitMessageEdited: jest.fn(),
    emitMessageRevoked: jest.fn(),
    emitMessageReaction: jest.fn(),
    emitMessageSent: jest.fn(),
    emitMessageAck: jest.fn(),
  };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const projector = new MessageProjector(
    messages,
    sessions,
    engines,
    gateway as never,
    webhooks as never,
    hooks,
    {} as never,
    new SessionLidResolver(engines, store),
    undefined,
    undefined,
    undefined,
    store,
  );
  const sender = new MessageSendService(
    messages,
    { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
    engines,
    hooks,
    {} as never,
    pacing as never,
    undefined,
    undefined,
    store,
    projector,
  );
  const service = new MessageService(messages, engines, projector, hooks, store, pacing as never, sender);

  Object.assign(world, {
    ack: (status: DeliveryStatus, chatId: string) => projector.handleMessageAck(S, engine, 'OUT-1', status, chatId),
    react: (chatId: string) =>
      projector.applyReactionQueued(S, { messageId: 'OUT-1', chatId, reaction: '+', senderId: chatId }),
    edit: (chatId: string, body: string) =>
      projector.applyMessageEditQueued(S, {
        messageId: 'OUT-1',
        chatId,
        body,
        senderId: `${SELF}@c.us`,
        from: `${SELF}@c.us`,
        to: chatId,
        fromMe: true,
        isGroup: false,
        type: 'text',
        hasMedia: false,
        timestamp: 1_700_000_300,
      }),
    revoke: (chatId: string) =>
      projector.handleMessageRevoked(
        S,
        engine,
        {
          id: 'OUT-1',
          revokedId: 'OUT-1',
          chatId,
          from: `${SELF}@c.us`,
          to: chatId,
          type: 'revoked',
          body: '',
          timestamp: 1_700_000_400,
        },
        { fromMe: true },
      ),
    ds,
    S,
    messages,
    store,
    sessionStore,
    sock,
    events,
    sender,
    service,
    echoes,
    results,
    engineLog,
    webhooks,
    pacing,
    persisted: () =>
      announced.mock.calls
        .filter(([event]) => event === 'message:persisted')
        .map(([, data]) => (data as { message: { status: string; chatId: string } }).message)
        .map(message => [message.status, message.chatId] as [string, string]),
    interceptor: new SendIdempotencyInterceptor(new SendIdempotencyService(ds.getRepository(SendIdempotencyKey))),
    settle: async () => {
      for (let turn = 0; turn < 30; turn++) {
        await new Promise(resolve => setImmediate(resolve));
        await Promise.allSettled([...writes]);
      }
    },
    rows: async () =>
      (await messages.find({ order: { waMessageId: 'ASC' } })).map(row => ({
        waMessageId: row.waMessageId,
        chatId: row.chatId,
        to: row.to,
        direction: row.direction,
        status: row.status,
        type: row.type,
        body: row.body,
        reactions: (row.metadata as { reactions?: Record<string, string> } | null)?.reactions,
      })),
    thread: async (chatId: string) =>
      (await service.getMessages(S, { chatId })).messages.map(message => message.waMessageId).sort(),
  });
  worlds.push(world);
  return world;
};

const inbound = (id: string, key: Partial<WAMessageKey>): WAMessage => ({
  key: { id, fromMe: false, ...key },
  message: { conversation: 'reply from the contact' },
  messageTimestamp: 1_700_000_500,
});

describe('a send to a number WhatsApp holds under other digits than the caller wrote (Baileys)', () => {
  const GROUP = '120363000000000001@g.us';
  const CHANNEL = '120363000000000002@newsletter';
  const row = (chatId: string, more: Record<string, unknown> = {}) =>
    expect.objectContaining({ waMessageId: 'OUT-1', chatId, to: chatId, direction: 'outgoing', ...more }) as unknown;
  const sentRow = async (w: World) => (await w.rows()).find(stored => stored.waMessageId === 'OUT-1');
  const pairs = async (w: World) =>
    (await w.ds.getRepository(LidMapping).find()).map(pair => [pair.lid, pair.phone, pair.isReported]);
  /** The jid the socket was handed for the first send. */
  const sentTo = (w: World): unknown => (w.sock.sendMessage.mock.calls[0] as unknown[])[0];
  /** The phone jids WhatsApp was asked to name a lid for, in order. */
  const asked = (w: World): string[] =>
    w.sock.executeUSyncQuery.mock.calls.flatMap((call: unknown[]) => (call[0] as Query).users.map(user => user.id));
  /** A send to the other spelling that went to a lid WhatsApp does not name for the number: the pair stays display data. */
  const unnamedSend = async (echoFirst: boolean): Promise<World> => {
    const w = await build({ lidKnown: true, named: false });
    w.echoFirst = echoFirst;
    await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
    await waitUntil(() => asked(w).length === 1, 3000);
    await w.settle();
    return w;
  };
  /** The jids the socket was handed after the first send, in order. */
  const sentSince = (w: World): unknown[] => w.sock.sendMessage.mock.calls.slice(1).map((call: unknown[]) => call[0]);
  const replied = async (w: World, key: Partial<WAMessageKey>): Promise<void> => {
    w.events.handleMessagesUpsert({ type: 'notify', messages: [inbound('IN-1', key)] });
    await waitUntil(async () => (await w.messages.countBy({ waMessageId: 'IN-1' })) > 0, 3000);
    await w.settle();
  };

  beforeAll(() => {
    process.env.SIMULATE_TYPING = 'false';
  });
  afterAll(() => {
    delete process.env.SIMULATE_TYPING;
  });
  afterEach(async () => {
    for (const world of worlds.splice(0)) {
      await world.settle();
      world.store.onModuleDestroy();
      await world.ds.destroy();
    }
    jest.restoreAllMocks();
  });

  it('files the row under the number WhatsApp resolved, in the chat the reply arrives in', async () => {
    const w = await build({ lidKnown: false });

    const response = await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
    await w.settle();

    // The response names no chat, so it is what it was.
    expect(response).toStrictEqual({ messageId: 'OUT-1', timestamp: expect.any(Number) as unknown });
    expect(sentTo(w)).toBe(`${CANON}@s.whatsapp.net`);
    expect(w.results).toEqual([expect.objectContaining({ id: 'OUT-1', resolvedChatId: canon })]);
    expect(await w.rows()).toEqual([row(canon, { status: 'sent', body: 'hello' })]);
    expect(await w.thread(canon)).toEqual(['OUT-1']);
    expect(await w.thread(typed)).toEqual([]);
    // A search provider that indexes on message:persisted hears the SENT state under the resolved number.
    expect(w.persisted()).toEqual([
      ['pending', typed],
      ['sent', canon],
    ]);
    // Pacing learns the written id, so the next send to it is not read as a new conversation.
    expect(w.pacing.rememberResolvedNumber.mock.calls).toEqual([[w.S, typed, canon]]);

    await replied(w, { remoteJid: `${CANON}@s.whatsapp.net` });
    expect(await w.thread(canon)).toEqual(['IN-1', 'OUT-1']);

    // The id the row is filed under is the one the calls that follow up on the message take.
    w.ack('delivered', canon);
    await w.settle();
    expect(await sentRow(w)).toEqual(row(canon, { status: 'delivered' }));
    const act = { chatId: canon, messageId: 'OUT-1' };
    expect(await outcome(() => w.service.reactToMessage(w.S, { ...act, emoji: '+' }))).toBe('ok');
    expect(await outcome(() => w.service.editMessage(w.S, { ...act, body: 'edited' }))).toBe('ok');
    await w.settle();
    expect(await sentRow(w)).toEqual(row(canon, { body: 'edited' }));
    expect(await outcome(() => w.service.deleteMessage(w.S, act))).toBe('ok');
    await w.settle();
    expect(await sentRow(w)).toEqual(row(canon, { type: 'revoked', body: '' }));
  });

  it('files a send that went to the lid of the resolved number under that number, and confirms that pair', async () => {
    const w = await build({ lidKnown: true });

    await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
    await waitUntil(async () => (await pairs(w))[0]?.[2] === true, 3000);
    await w.settle();

    expect(sentTo(w)).toBe(lid);
    expect(w.results).toEqual([expect.objectContaining({ id: 'OUT-1', resolvedChatId: canon })]);
    expect(await w.rows()).toEqual([row(canon, { status: 'sent' })]);
    expect(asked(w)).toEqual([`${CANON}@s.whatsapp.net`]);
    expect(await pairs(w)).toEqual([[LID, CANON, true]]);
    expect(await w.thread(lid)).toEqual(['OUT-1']);
    expect(await w.thread(canon)).toEqual(['OUT-1']);
    expect(await w.thread(typed)).toEqual([]);

    await replied(w, { remoteJid: lid, remoteJidAlt: `${CANON}@s.whatsapp.net` });
    expect(await w.thread(lid)).toEqual(['IN-1', 'OUT-1']);
    expect(await w.thread(canon)).toEqual(['IN-1', 'OUT-1']);
    w.ack('delivered', lid);
    await w.settle();
    expect(await sentRow(w)).toEqual(row(canon, { status: 'delivered' }));
  });

  it('keeps that lid out of the aliases of the resolved number when WhatsApp does not name it', async () => {
    const w = await build({ lidKnown: true, named: false });

    await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
    await waitUntil(() => asked(w).length === 1, 3000);
    await w.settle();

    expect(asked(w)).toEqual([`${CANON}@s.whatsapp.net`]);
    expect(await pairs(w)).toEqual([[LID, CANON, false]]);
    expect(await w.rows()).toEqual([row(canon, { status: 'sent' })]);
    expect(await w.thread(canon)).toEqual(['OUT-1']);
    expect(await w.thread(lid)).toEqual([]);
  });

  it.each([
    ['the row', false, false],
    ['the row', false, true],
    ['the echo', true, false],
    ['the echo', true, true],
  ])(
    'leaves one row, where a send to the held number has it, when %s takes the message id first (echo first: %s, to a lid: %s)',
    async (_first, echoFirst, lidKnown) => {
      const chat = canon;
      const w = await build({ lidKnown });
      w.echoFirst = echoFirst;
      const held = await build({ lidKnown });
      held.echoFirst = echoFirst;

      const response = await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
      w.ack('delivered', lidKnown ? lid : canon);
      await w.settle();
      await held.sender.sendText(held.S, { chatId: canon, text: 'hello' });
      await held.settle();

      expect(response).toStrictEqual({ messageId: 'OUT-1', timestamp: expect.any(Number) as unknown });
      expect(w.echoes.map(echo => echo.chatId)).toEqual([lidKnown ? lid : canon]);
      expect(await w.rows()).toEqual([row(chat, { status: 'delivered', body: 'hello' })]);
      expect(await held.rows()).toEqual([row(chat, { status: 'sent', body: 'hello' })]);
      expect(await w.thread(typed)).toEqual([]);
    },
  );

  describe.each([
    ['the row', false],
    ['the echo', true],
  ])(
    'a send that went to a lid WhatsApp does not name for the number, when %s takes the message id first',
    (_first, echoFirst) => {
      const sendUnnamed = (): Promise<World> => unnamedSend(echoFirst);

      it('files the row under the number, where the changes that name the lid still find it', async () => {
        const w = await sendUnnamed();
        expect(await pairs(w)).toEqual([[LID, CANON, false]]);
        expect(await w.rows()).toEqual([row(canon, { status: 'sent', body: 'hello' })]);
        expect(await w.thread(canon)).toEqual(['OUT-1']);

        w.react(lid);
        await w.settle();
        expect((await sentRow(w))?.reactions).toEqual({ [lid]: '+' });
        w.edit(lid, 'edited on the phone');
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { body: 'edited on the phone' }));
        w.ack('read', lid);
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { status: 'read' }));
        w.revoke(lid);
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { type: 'revoked', body: '' }));
      });

      it('takes the changes that name the number too, and none from a third chat', async () => {
        const w = await sendUnnamed();

        w.react('999999999999@lid');
        w.edit('999999999999@lid', 'from elsewhere');
        w.revoke('628777000000@c.us');
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { body: 'hello', type: 'text', reactions: undefined }));

        w.edit(canon, 'edited on the phone');
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { body: 'edited on the phone' }));
      });

      it('bridges the number and the lid for no reader: the pair stays display data and the thread of each is its own', async () => {
        const w = await sendUnnamed();
        await replied(w, { remoteJid: lid });

        expect(await pairs(w)).toEqual([[LID, CANON, false]]);
        expect(await w.store.findLidsForPhone(CANON)).toEqual([]);
        expect(await new ChatScopeService(w.store).allows({ allowedChats: [canon] }, lid)).toBe(false);
        expect(await w.thread(canon)).toEqual(['OUT-1']);
        expect(await w.thread(lid)).toEqual(['IN-1']);
      });

      it('keeps the chat it was delivered to off every read and announcement of the row', async () => {
        const w = await sendUnnamed();

        const listed = (await w.service.getMessages(w.S, { chatId: canon })).messages;
        expect(listed).toHaveLength(1);
        expect(listed[0].engineRef).toBeUndefined();
        expect((await w.messages.findOneBy({ waMessageId: 'OUT-1' }))?.engineRef).toBeUndefined();
        const announced = (w.sender as unknown as { hookManager: HookManager }).hookManager;
        const persisted = (announced.execute as jest.Mock).mock.calls
          .filter(([event]) => event === 'message:persisted')
          .map(([, data]) => (data as { message: { engineRef?: unknown } }).message);
        expect(persisted.length).toBeGreaterThan(0);
        for (const message of persisted) expect(message.engineRef).toBeUndefined();
        // Kept where the guard reads it, beside the chat the caller addressed.
        expect(
          await w.messages.findOne({ where: { waMessageId: 'OUT-1' }, select: { chatId: true, engineRef: true } }),
        ).toEqual({ chatId: canon, engineRef: { chatId: lid, direction: 'outgoing', addressed: true } });
      });
    },
  );

  it('files a send of another kind the same way', async () => {
    const w = await build({ lidKnown: true });

    await w.sender.sendLocation(w.S, { chatId: typed, latitude: 1, longitude: 2 });
    await w.settle();

    expect(sentTo(w)).toBe(lid);
    expect(await w.rows()).toEqual([row(canon, { status: 'sent', type: 'location' })]);
  });

  it.each([
    ['the number WhatsApp holds', canon],
    ['a lid', lid],
    ['a group', GROUP],
    ['a channel', CHANNEL],
  ])('leaves a send addressed to %s under the id the caller wrote', async (_label, chatId) => {
    const w = await build({ lidKnown: false });

    await w.sender.sendText(w.S, { chatId, text: 'hello' });
    await w.settle();

    expect(w.results).toHaveLength(1);
    expect(w.results[0]).not.toHaveProperty('resolvedChatId');
    expect(w.pacing.rememberResolvedNumber).not.toHaveBeenCalled();
    expect(await w.rows()).toEqual([row(chatId, { status: 'sent' })]);
  });

  it('leaves a send to the number WhatsApp holds under it when the message goes to its lid', async () => {
    const w = await build({ lidKnown: true });

    await w.sender.sendText(w.S, { chatId: canon, text: 'hello' });
    await w.settle();

    expect(sentTo(w)).toBe(lid);
    expect(w.results[0]).not.toHaveProperty('resolvedChatId');
    expect(await w.rows()).toEqual([row(canon, { status: 'sent' })]);
  });

  it('answers a repeat of the send under the same Idempotency-Key with the stored response', async () => {
    const w = await build({ lidKnown: false });
    const body = { chatId: typed, text: 'hello' };
    const keyed = async (): Promise<unknown> => {
      const context = {
        getType: () => 'http',
        getHandler: () => ({ name: 'sendText' }),
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'idempotency-key': 'k-1' }, params: { sessionId: w.S }, body }),
          getResponse: () => ({ setHeader: jest.fn() }),
        }),
      } as unknown as ExecutionContext;
      return lastValueFrom(
        await w.interceptor.intercept(context, { handle: () => from(w.sender.sendText(w.S, body)) }),
      );
    };

    const first = await keyed();
    await w.settle();
    const second = await keyed();
    await w.settle();

    expect(first).toStrictEqual({ messageId: 'OUT-1', timestamp: expect.any(Number) as unknown });
    expect(second).toStrictEqual(first);
    expect(w.sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(await w.rows()).toEqual([row(canon, { status: 'sent' })]);
  });

  it('gives a key scoped to the spelling the caller wrote no chat it did not have', async () => {
    const w = await build({ lidKnown: true });
    await w.sender.sendText(w.S, { chatId: typed, text: 'hello' });
    await waitUntil(async () => (await pairs(w))[0]?.[2] === true, 3000);
    await w.settle();

    const scope = new ChatScopeService(w.store);
    const key = { allowedChats: [typed] };
    expect(await scope.allows(key, typed)).toBe(true);
    expect(await scope.allows(key, canon)).toBe(false);
    expect(await scope.allows(key, lid)).toBe(false);
  });

  describe.each([
    ['the row', false],
    ['the echo', true],
  ])(
    'a follow-up through the API to a send that went to a lid, when %s takes the message id first',
    (_first, echoFirst) => {
      it.each([
        ['the number the row is filed under', canon],
        ['the lid it went to', lid],
      ])('reacts, edits and deletes naming %s, and the row takes the edit and the delete', async (_chat, chatId) => {
        const w = await unnamedSend(echoFirst);
        const act = { chatId, messageId: 'OUT-1' };

        expect(await outcome(() => w.service.reactToMessage(w.S, { ...act, emoji: '+' }))).toBe('ok');
        expect(await outcome(() => w.service.editMessage(w.S, { ...act, body: 'edited by the API' }))).toBe('ok');
        await w.settle();
        expect(await sentRow(w)).toEqual(row(canon, { body: 'edited by the API' }));
        expect(await outcome(() => w.service.deleteMessage(w.S, act))).toBe('ok');
        await w.settle();

        expect(await sentRow(w)).toEqual(row(canon, { type: 'revoked', body: '' }));
        expect(sentSince(w)).toEqual([lid, lid, lid]);
      });

      it('stars, pins and unpins it naming the number, in the chat it is stored in', async () => {
        const w = await unnamedSend(echoFirst);
        const act = { chatId: canon, messageId: 'OUT-1' };

        expect(await outcome(() => w.service.starMessage(w.S, { ...act, star: true }))).toBe('ok');
        expect(await outcome(() => w.service.pinMessage(w.S, act))).toBe('ok');
        expect(await outcome(() => w.service.unpinMessage(w.S, act))).toBe('ok');

        expect(w.sock.chatModify).toHaveBeenCalledTimes(1);
        expect(sentSince(w)).toEqual([lid, lid]);
      });

      it('forwards it and quotes it naming the number; the reply goes where a send to the number goes', async () => {
        const w = await unnamedSend(echoFirst);

        expect(
          await outcome(() => w.sender.forward(w.S, { fromChatId: canon, toChatId: GROUP, messageId: 'OUT-1' })),
        ).toBe('ok');
        expect(
          await outcome(() => w.sender.reply(w.S, { chatId: canon, quotedMessageId: 'OUT-1', text: 'again' })),
        ).toBe('ok');
        await w.settle();

        expect(sentSince(w)).toEqual([GROUP, lid]);
        expect((await w.rows()).filter(stored => stored.waMessageId === 'OUT-3')).toEqual([
          expect.objectContaining({ chatId: canon, to: canon, body: 'again' }),
        ]);
      });

      it('answers 404 for a follow-up naming the spelling the caller wrote, as before', async () => {
        const w = await unnamedSend(echoFirst);

        expect(
          await outcome(() => w.service.reactToMessage(w.S, { chatId: typed, messageId: 'OUT-1', emoji: '+' })),
        ).toBe(`refused MessageNotFoundError 404: Message OUT-1 not found in chat ${typed}`);
        expect(sentSince(w)).toEqual([]);
      });
    },
  );

  describe('a row written once the send has answered, as a bulk send writes it', () => {
    const data = {
      waMessageId: 'OUT-1',
      body: 'hello',
      type: 'text',
      timestamp: 1_700_000_200,
      status: MessageStatus.SENT,
    };
    /** The row of an own-send echo that was written first, under the lid the message went to. */
    const echoRow = (w: World) =>
      w.messages.insert({
        ...data,
        sessionId: w.S,
        chatId: lid,
        from: `${SELF}@c.us`,
        to: lid,
        direction: MessageDirection.OUTGOING,
      });

    it('is filed under the resolved number', async () => {
      const w = await build({ lidKnown: false });

      await w.sender.saveOutgoingMessage(w.S, { ...data, chatId: typed, resolvedChatId: canon });

      expect(await w.rows()).toEqual([row(canon, { status: 'sent' })]);
      expect(w.pacing.rememberResolvedNumber.mock.calls).toEqual([[w.S, typed, canon]]);
    });

    it('leaves the row of an echo written first in the chat the message went to when the engine does not name it', async () => {
      const w = await build({ lidKnown: false });
      await echoRow(w);

      await w.sender.saveOutgoingMessage(w.S, { ...data, chatId: typed, resolvedChatId: canon });

      expect(await w.rows()).toEqual([row(lid, { status: 'sent' })]);
    });

    it.each([
      ['the row', false],
      ['the echo', true],
    ])('is filed under the number, beside the lid it went to, when %s is written first', async (_first, echoFirst) => {
      const w = await build({ lidKnown: false });
      if (echoFirst) await echoRow(w);

      await w.sender.saveOutgoingMessage(w.S, {
        ...data,
        chatId: typed,
        resolvedChatId: canon,
        engineChatId: lid,
      });
      w.react(lid);
      w.edit(lid, 'edited on the phone');
      await w.settle();

      expect(await w.rows()).toEqual([
        row(canon, { status: 'sent', body: 'edited on the phone', reactions: { [lid]: '+' } }),
      ]);
    });

    it('leaves an echo row a message:sent handler filed elsewhere where the handler put it', async () => {
      const w = await build({ lidKnown: false });
      await w.messages.insert({
        ...data,
        sessionId: w.S,
        chatId: '628777000000@c.us',
        from: `${SELF}@c.us`,
        to: '628777000000@c.us',
        direction: MessageDirection.OUTGOING,
        engineRef: { chatId: lid, direction: MessageDirection.OUTGOING },
      });

      await w.sender.saveOutgoingMessage(w.S, { ...data, chatId: typed, resolvedChatId: canon, engineChatId: lid });

      expect(await w.rows()).toEqual([row('628777000000@c.us', { status: 'sent' })]);
    });

    it('leaves the row of an echo written first where it is when the number check renamed nothing', async () => {
      const w = await build({ lidKnown: false });
      await echoRow(w);

      await w.sender.saveOutgoingMessage(w.S, { ...data, chatId: canon });

      expect(await w.rows()).toEqual([row(lid, { status: 'sent' })]);
    });
  });
});
