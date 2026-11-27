jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookReconcilerService } from '../webhook/webhook-reconciler.service';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type {
  EditedMessage,
  IncomingMessage,
  IWhatsAppEngine,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * A `message:received` or `message:sent` handler may file a message under another chat, direction or author than the
 * engine reported. Changes to the message keep naming what the engine reported: they reach the row, and changes
 * naming the chat the handler chose do not.
 */

const ENGINE_CHAT = '628111@c.us';
const FILED_CHAT = '628999@c.us';
const SELF = '628222@c.us';

/** Every turn a change takes through the projector and SQLite, which answers within the same turns. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn++) await new Promise(resolve => setImmediate(resolve));
};

function incoming(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'WA-1',
    chatId: ENGINE_CHAT,
    from: ENGINE_CHAT,
    to: SELF,
    body: 'hello world',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    ...over,
  } as IncomingMessage;
}

const revoked = (over: Partial<RevokedMessage> = {}): RevokedMessage => ({
  id: 'WA-1',
  chatId: ENGINE_CHAT,
  from: ENGINE_CHAT,
  to: SELF,
  type: 'revoked',
  body: '',
  timestamp: 2,
  ...over,
});

const edited = (over: Partial<EditedMessage> = {}): EditedMessage =>
  ({
    messageId: 'WA-1',
    chatId: ENGINE_CHAT,
    from: ENGINE_CHAT,
    to: SELF,
    body: 'edited text',
    fromMe: false,
    timestamp: 3,
    type: 'text',
    ...over,
  }) as EditedMessage;

describe('changes to a message a hook filed under another chat', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let messages: Repository<Message>;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let eventsGateway: Record<string, jest.Mock>;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;
  let findPhoneForLid: jest.Mock;
  let engines: EngineRegistry;
  let hookSaw: string[];
  let persisted: Array<Record<string, unknown>>;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    // Each delivery stays in flight, so its outbox row stays pending, as after a crash before dispatch.
    mockFetch.mockImplementation(() => new Promise(() => undefined));
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    messages = ds.getRepository(Message);
    const session = await ds
      .getRepository(Session)
      .save(ds.getRepository(Session).create({ name: 'moved', status: SessionStatus.READY, config: {} }));
    sessionId = session.id;
    const values: Record<string, unknown> = {
      'queue.enabled': false,
      'webhook.dispatchConcurrency': 8,
      'webhook.dispatchMaxQueued': 100,
      'webhook.timeout': 5000,
      'webhook.retryDelay': 50,
      'webhook.shutdownDrainMs': 0,
      'webhook.failurePayloadRetentionHours': 0,
      'webhook.maxPayloadBytes': 1024 * 1024,
      'webhook.mediaInlineMaxBytes': 1024 * 1024,
    };
    const configService = {
      get: <T>(key: string, defaultValue?: T): T => (key in values ? values[key] : defaultValue) as T,
    } as unknown as ConfigService;
    hookManager = new HookManager();
    hookSaw = [];
    persisted = [];
    hookManager.register('index', 'message:persisted', ctx => {
      persisted.push({ ...(ctx.data as { message: Record<string, unknown> }).message });
      return Promise.resolve({ continue: true });
    });
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    delivery = new WebhookDeliveryService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      configService,
      hookManager,
      outbox,
    );
    const webhookService = new WebhookService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      ds.getRepository(Session),
      configService,
      delivery,
    );
    reconciler = new WebhookReconcilerService(ds.getRepository(Webhook), outbox, delivery, configService);
    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
      emitMessageAck: jest.fn(),
      emitMessageEdited: jest.fn(),
    };
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);
    findPhoneForLid = jest.fn().mockResolvedValue(null);
    projector = new MessageProjector(
      messages,
      ds.getRepository(Session),
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
      undefined,
      undefined,
      { findPhoneForLid } as never,
    );
  });

  afterEach(async () => {
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  /** A handler that rewrites the messages of `from` to `to` on `event`, recording the text it was handed. */
  const move = (event: 'message:received' | 'message:sent', change: Partial<IncomingMessage> = {}): void => {
    hookManager.register('mover', event, ctx => {
      const data = ctx.data as IncomingMessage;
      hookSaw.push(data.body);
      return Promise.resolve({ continue: true, data: { ...data, chatId: FILED_CHAT, ...change } });
    });
  };
  const row = (id = 'WA-1'): Promise<Message | null> => messages.findOne({ where: { sessionId, waMessageId: id } });
  const receive = async (over: Partial<IncomingMessage> = {}): Promise<unknown> => {
    const receipt = projector.handleInboundMessage(sessionId, engine, incoming(over));
    const outcome = await receipt?.settled;
    await settle();
    return outcome;
  };
  const echo = async (over: Partial<IncomingMessage> = {}): Promise<void> => {
    projector.handleOwnSendEcho(
      sessionId,
      engine,
      incoming({ id: 'WA-OWN', fromMe: true, from: SELF, to: ENGINE_CHAT, body: 'my text', ...over }),
    );
    await settle();
  };
  const engineRefOf = async (id = 'WA-1'): Promise<unknown> =>
    (
      await ds.query<Array<{ engineRef: unknown }>>(`SELECT "engineRef" FROM "messages" WHERE "waMessageId" = ?`, [id])
    )[0]?.engineRef;
  const pendingOutbox = async (): Promise<Array<Record<string, unknown>>> =>
    (await ds.getRepository(WebhookOutboxEvent).find({ where: { event: 'message.received' } })).map(o => ({
      state: o.state,
      chatId: o.payload?.chatId ?? null,
      body: o.payload?.body ?? null,
    }));
  const seedWebhook = (): Promise<Webhook> =>
    ds
      .getRepository(Webhook)
      .save(ds.getRepository(Webhook).create({ sessionId, url: 'https://hooks.example.test/x', events: ['*'] }));

  it('stores the chat, direction and author the engine reported, and only for a message a hook moved', async () => {
    move('message:received');
    await receive();
    await receive({ id: 'WA-GROUP', chatId: '120363000000000001@g.us', author: '628444@c.us' });

    expect(await row()).toMatchObject({ chatId: FILED_CHAT });
    expect(JSON.parse(String(await engineRefOf()))).toEqual({
      chatId: ENGINE_CHAT,
      direction: MessageDirection.INCOMING,
      author: null,
    });
    expect(JSON.parse(String(await engineRefOf('WA-GROUP')))).toEqual({
      chatId: '120363000000000001@g.us',
      direction: MessageDirection.INCOMING,
      author: '628444@c.us',
    });
  });

  it('stores no engine ref, SQL NULL, for a message no hook moved', async () => {
    await receive();
    await echo();

    expect(await engineRefOf()).toBeNull();
    expect(await engineRefOf('WA-OWN')).toBeNull();
  });

  it('applies a revoke naming the engine chat and announces it once; one from the filed chat does neither', async () => {
    move('message:received');
    await receive();

    projector.handleMessageRevoked(sessionId, engine, revoked({ chatId: FILED_CHAT, from: FILED_CHAT }), {
      fromMe: false,
    });
    await settle();
    expect(await row()).toMatchObject({ type: 'text', body: 'hello world' });
    expect(eventsGateway.emitMessageRevoked).not.toHaveBeenCalled();

    projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
    await settle();
    expect(await row()).toMatchObject({ chatId: FILED_CHAT, type: 'revoked', body: '' });
    expect(eventsGateway.emitMessageRevoked).toHaveBeenCalledTimes(1);
  });

  it('applies an engine edit and a reaction naming the engine chat', async () => {
    move('message:received');
    await receive();

    projector.applyMessageEditQueued(sessionId, edited());
    projector.applyReactionQueued(sessionId, {
      messageId: 'WA-1',
      chatId: ENGINE_CHAT,
      reaction: 'X',
      senderId: ENGINE_CHAT,
    });
    await settle();

    expect(await row()).toMatchObject({
      body: 'edited text',
      metadata: { edited: true, reactions: { [ENGINE_CHAT]: 'X' } },
    });
    expect(eventsGateway.emitMessageEdited).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitMessageReaction).toHaveBeenCalledTimes(1);
  });

  it('applies a delete and an edit through the API naming the engine chat', async () => {
    move('message:received');
    move('message:sent');
    await receive();
    await echo();

    await projector.recordRevoke(sessionId, 'WA-1', { kind: 'revoke', chatId: ENGINE_CHAT });
    await projector.recordOutboundMessageEdit(sessionId, 'WA-OWN', 'my edited text', {
      kind: 'edit',
      chatId: ENGINE_CHAT,
      fromMe: true,
    });

    expect(await row()).toMatchObject({ type: 'revoked', body: '' });
    expect(await row('WA-OWN')).toMatchObject({ chatId: FILED_CHAT, body: 'my edited text' });
  });

  it('advances an own message by a receipt naming the engine chat and announces it', async () => {
    move('message:sent');
    await echo();

    projector.handleMessageAck(sessionId, engine, 'WA-OWN', 'read', ENGINE_CHAT);
    await settle();

    expect(await row('WA-OWN')).toMatchObject({ status: 'read' });
    expect(eventsGateway.emitMessageAck).toHaveBeenCalledTimes(1);
  });

  it('clears the row for a history tombstone naming the engine chat', async () => {
    move('message:received', { fromMe: true });
    await receive();

    await projector.persistHistoryMessages(sessionId, engine, [incoming({ type: 'revoked', body: '' })]);

    expect(await row()).toMatchObject({ chatId: FILED_CHAT, direction: MessageDirection.OUTGOING, type: 'revoked' });
  });

  it('hands the hook no content when a deleted message is delivered again', async () => {
    move('message:received');
    await receive();
    projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
    await settle();
    hookSaw.length = 0;

    await receive();

    expect(hookSaw).toEqual(['']);
  });

  it('applies the counterparty revoke when a hook flipped the direction', async () => {
    move('message:received', { chatId: ENGINE_CHAT, fromMe: true });
    await receive();
    expect(await row()).toMatchObject({ direction: MessageDirection.OUTGOING });

    projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
    await settle();

    expect(await row()).toMatchObject({ type: 'revoked' });
  });

  it("applies the real author's group edit and revoke when a hook rewrote the author, and not another member's", async () => {
    const GROUP = '120363000000000001@g.us';
    const AUTHOR = '628444@c.us';
    move('message:received', { chatId: GROUP, author: '628555@c.us' });
    await receive({ chatId: GROUP, from: GROUP, author: AUTHOR, isGroup: true, kind: 'group' } as never);

    projector.applyMessageEditQueued(sessionId, edited({ chatId: GROUP, from: GROUP, author: '628555@c.us' }));
    await settle();
    expect(await row()).toMatchObject({ body: 'hello world' });

    projector.applyMessageEditQueued(sessionId, edited({ chatId: GROUP, from: GROUP, author: AUTHOR }));
    await settle();
    expect(await row()).toMatchObject({ body: 'edited text' });

    const revokeBy = (participant: string): void =>
      projector.handleMessageRevoked(sessionId, engine, revoked({ chatId: GROUP, from: GROUP }), {
        fromMe: false,
        participant,
        admin: false,
      });
    revokeBy('628555@c.us');
    await settle();
    expect(await row()).toMatchObject({ type: 'text' });
    revokeBy(AUTHOR);
    await settle();
    expect(await row()).toMatchObject({ type: 'revoked' });
  });

  it.each([
    ['redacts it for a delete through the API', false, { state: 'pending', chatId: FILED_CHAT, body: '' }],
    ['closes it for an engine revoke', true, { state: 'dispatched', chatId: null, body: null }],
  ])('%s naming the engine chat: the pending outbox row of a moved message', async (_name, engineRevoke, after) => {
    await seedWebhook();
    move('message:received');
    await receive();
    expect(await pendingOutbox()).toEqual([{ state: 'pending', chatId: FILED_CHAT, body: 'hello world' }]);

    if (engineRevoke) projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
    else await projector.recordRevoke(sessionId, 'WA-1', { kind: 'revoke', chatId: ENGINE_CHAT });
    await settle();

    expect(await pendingOutbox()).toEqual([after]);
  });

  it("leaves another message's pending outbox row alone when a delete clears the row holding the id", async () => {
    const webhook = await seedWebhook();
    // A row of another chat holds the id; the outbox row of a later delivery under it carries its own message.
    await messages.insert({
      sessionId,
      waMessageId: 'WA-1',
      chatId: '628777@c.us',
      from: '628777@c.us',
      to: SELF,
      body: 'foreign text',
      type: 'text',
      direction: MessageDirection.INCOMING,
    });
    await outbox.openBatch([
      {
        idempotencyKey: `msg_${sessionId}_WA-1_${webhook.id}`,
        sessionId,
        webhookId: webhook.id,
        event: 'message.received',
        deliveryId: 'delivery-1',
        payload: { id: 'WA-1', chatId: ENGINE_CHAT, fromMe: false, body: 'second message' },
      },
    ]);

    await projector.recordRevoke(sessionId, 'WA-1', { kind: 'revoke', chatId: '628777@c.us' });

    expect(await row()).toMatchObject({ chatId: '628777@c.us', type: 'revoked' });
    expect(await pendingOutbox()).toEqual([{ state: 'pending', chatId: ENGINE_CHAT, body: 'second message' }]);
  });

  describe('a hook files a lid chat under its phone number, with no pairing reported', () => {
    const LID = '99887766@lid';

    beforeEach(() => {
      hookManager.register('canonicalizer', 'message:received', ctx =>
        Promise.resolve({ continue: true, data: { ...(ctx.data as IncomingMessage), chatId: ENGINE_CHAT } }),
      );
    });

    it('applies a revoke and an edit naming the lid', async () => {
      await receive({ chatId: LID, from: LID, isLidSender: true });

      projector.applyMessageEditQueued(sessionId, edited({ chatId: LID, from: LID }));
      await settle();
      expect(await row()).toMatchObject({ chatId: ENGINE_CHAT, body: 'edited text' });

      projector.handleMessageRevoked(sessionId, engine, revoked({ chatId: LID, from: LID }), { fromMe: false });
      await settle();
      expect(await row()).toMatchObject({ chatId: ENGINE_CHAT, type: 'revoked' });
    });
  });

  describe('a row a hook moved before engine refs were kept', () => {
    const storeLegacy = (chatId: string): Promise<unknown> =>
      messages.insert({
        sessionId,
        waMessageId: 'WA-1',
        chatId,
        from: chatId,
        to: SELF,
        body: 'hello world',
        type: 'text',
        direction: MessageDirection.INCOMING,
      });

    it('is still judged by the chat it is filed under', async () => {
      await storeLegacy(FILED_CHAT);

      projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
      await settle();
      expect(await row()).toMatchObject({ type: 'text' });

      projector.handleMessageRevoked(sessionId, engine, revoked({ chatId: FILED_CHAT, from: FILED_CHAT }), {
        fromMe: false,
      });
      await settle();
      expect(await row()).toMatchObject({ type: 'revoked' });
    });

    it('reports no conflict when the message is delivered again through the hook that moved it', async () => {
      await storeLegacy(FILED_CHAT);
      move('message:received');

      expect(await receive()).toBeUndefined();
    });

    it('reports no conflict when a hook installed after the row was written moves the delivery', async () => {
      await storeLegacy(ENGINE_CHAT);
      move('message:received');

      expect(await receive()).toBeUndefined();
    });

    // Nothing tells it from a message of the chat the handler filed the delivery under that holds the same id.
    it('is left alone when its message is delivered again deleted through the hook that moved it', async () => {
      await storeLegacy(FILED_CHAT);
      move('message:received');

      await receive({ type: 'revoked', body: '' });

      expect(await row()).toMatchObject({ chatId: FILED_CHAT, type: 'text', body: 'hello world' });
    });

    it('still reports a conflict for a row of another chat', async () => {
      await storeLegacy('628777@c.us');
      move('message:received');

      expect(await receive()).toEqual({ conflict: true });
    });
  });

  // The chat a hook files a delivery under may hold a message of its own under the same id, stored as no hook moved it.
  describe('a message of the chat a hook files deliveries under, holding the id of a delivery it moves', () => {
    const genuine = (): Promise<unknown> => receive({ chatId: FILED_CHAT, from: FILED_CHAT, body: 'genuine text' });
    /** One transient failure of the next message insert: its retry then meets the row holding the id. */
    const failNextInsert = (): (() => boolean) => {
      // better-sqlite3 hands every caller the one shared runner.
      const runner = ds.createQueryRunner();
      const realQuery = runner.query.bind(runner) as (sql: string, ...rest: unknown[]) => Promise<unknown>;
      let failed = false;
      jest.spyOn(runner, 'query').mockImplementation((sql: string, ...rest: unknown[]) => {
        if (!failed && /^\s*INSERT\s+(OR IGNORE\s+)?INTO\s+"messages"/i.test(sql)) {
          failed = true;
          return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
        }
        return realQuery(sql, ...rest) as never;
      });
      return () => failed;
    };
    const untouched = { chatId: FILED_CHAT, type: 'text', body: 'genuine text', metadata: null };

    beforeEach(() => move('message:received'));

    it('is not cleared by the moved delivery arriving deleted', async () => {
      await genuine();

      await receive({ type: 'revoked', body: '' });

      expect(await row()).toMatchObject(untouched);
    });

    it('takes no edit held for the moved delivery when its retried insert loses to the row', async () => {
      await genuine();
      const failed = failNextInsert();

      const receipt = projector.handleInboundMessage(sessionId, engine, incoming({ body: 'other text' }));
      projector.applyMessageEditQueued(sessionId, edited({ body: 'edited from the other chat' }));
      await receipt?.settled;
      await settle();

      expect(failed()).toBe(true);
      expect(await row()).toMatchObject(untouched);
    });

    it('takes no revoke held for the moved delivery when the engine retires during its commit', async () => {
      await genuine();
      const failed = failNextInsert();

      const receipt = projector.handleInboundMessage(sessionId, engine, incoming({ body: 'other text' }));
      projector.handleMessageRevoked(sessionId, engine, revoked(), { fromMe: false });
      await settle();
      engines.set(sessionId, {} as IWhatsAppEngine);
      await receipt?.settled;
      await settle();

      expect(failed()).toBe(true);
      expect(await row()).toMatchObject(untouched);
    });
  });

  it('announces a moved message, received and sent, with no engine ref over the webhook and the websocket', async () => {
    await seedWebhook();
    move('message:received');
    move('message:sent');

    await receive();
    await echo();
    for (let turn = 0; turn < 20 && mockFetch.mock.calls.length < 2; turn++) await settle();

    const bodies = (mockFetch.mock.calls as Array<[string, { body: string }]>).map(([, init]) => init.body);
    expect(bodies.map(body => (JSON.parse(body) as { event: string }).event).sort()).toEqual([
      'message.received',
      'message.sent',
    ]);
    const sockets = [eventsGateway.emitMessage, eventsGateway.emitMessageSent].map(
      emit => (emit.mock.calls as Array<[string, unknown]>)[0]?.[1],
    );
    expect(sockets).toEqual([
      expect.objectContaining({ chatId: FILED_CHAT }),
      expect.objectContaining({ chatId: FILED_CHAT }),
    ]);
    expect(JSON.stringify([bodies, sockets])).not.toContain('engineRef');
  });

  it('never hands the engine ref out through a read or message:persisted, and the export reads it', async () => {
    move('message:received');
    await receive();
    await projector.recordRevoke(sessionId, 'WA-1', { kind: 'revoke', chatId: ENGINE_CHAT });

    const listed = await messages.createQueryBuilder('message').select('message').getMany();
    const found = await messages.findOne({ where: { sessionId, waMessageId: 'WA-1' } });
    // What a response or a plugin receives is the JSON of the row.
    expect(JSON.stringify(listed)).not.toContain('engineRef');
    expect(JSON.stringify(found)).not.toContain('engineRef');
    expect(persisted.map(m => m.type)).toEqual(['text', 'revoked']);
    expect(JSON.stringify(persisted)).not.toContain('engineRef');
    const [raw] = await ds.query<Array<Record<string, unknown>>>('SELECT * FROM "messages"');
    expect(JSON.parse(String(raw.engineRef))).toMatchObject({ chatId: ENGINE_CHAT });
  });
});
