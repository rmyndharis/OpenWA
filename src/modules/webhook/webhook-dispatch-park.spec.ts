jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookService } from './webhook.service';
import { WebhookReconcilerService } from './webhook-reconciler.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { MessageProjector } from '../session/message-projector.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from '../session/session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';

/** Webhook events dispatched while the database cannot answer: kept, and dispatched once it does. */
describe('Webhook events the database refused, kept until it answers (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;
  let webhook: Webhook;
  let owns: boolean;
  // 'on': every statement fails; 'writes': the database reads but refuses every write.
  // 'outbox writes': the database answers everything but a write of the outbox table.
  let outage: 'off' | 'on' | 'writes' | 'outbox writes';
  let retryDelay: number;
  let retentionHours: number;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    outage = 'off';
    retryDelay = 50;
    retentionHours = 0;
    owns = true;
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    sessionId = (
      await ds
        .getRepository(Session)
        .save(ds.getRepository(Session).create({ name: 'park', status: SessionStatus.READY, config: {} }))
    ).id;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = BetterSqlite3QueryRunner.prototype.query;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      const write = !/^\s*SELECT/i.test(String(args[0]));
      const outboxWrite = write && String(args[0]).includes('webhook_outbox_events');
      if (outage === 'on' || (outage === 'writes' && write) || (outage === 'outbox writes' && outboxWrite)) {
        return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
      }
      return realQuery.apply(this, args);
    } as never);
    const configService = {
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'queue.enabled': false,
          'webhook.dispatchConcurrency': 8,
          'webhook.dispatchMaxQueued': 100,
          'webhook.timeout': 5000,
          'webhook.retryDelay': retryDelay,
          'webhook.shutdownDrainMs': 1000,
          'webhook.failurePayloadRetentionHours': retentionHours,
          'webhook.maxPayloadBytes': 1024 * 1024,
          'webhook.mediaInlineMaxBytes': 1024,
        };
        return (key in values ? values[key] : defaultValue) as T;
      },
    } as unknown as ConfigService;
    hookManager = new HookManager();
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    delivery = new WebhookDeliveryService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      configService,
      hookManager,
      outbox,
    );
    webhookService = new WebhookService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      ds.getRepository(Session),
      configService,
      delivery,
    );
    reconciler = new WebhookReconcilerService(ds.getRepository(Webhook), outbox, delivery, configService);
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);
    projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
      undefined,
      undefined,
      undefined,
      { owns: () => owns } as unknown as SessionOwnershipService,
    );
    webhook = await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events: ['*', 'message.receipt'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
      }),
    );
  });

  afterEach(async () => {
    outage = 'off';
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  const settle = async (turns = 60): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  /** The database answers again: what was kept runs now rather than on its timer. */
  const recover = async (): Promise<void> => {
    outage = 'off';
    await projector.retryParkedChanges();
    await settle();
  };
  const posted = (): Array<{ event: string; key: string; data: Record<string, unknown> }> =>
    mockFetch.mock.calls.map(([, init]) => {
      const { body, headers } = init as { body: string; headers: Record<string, string> };
      const parsed = JSON.parse(body) as { event: string; data: Record<string, unknown> };
      return { event: parsed.event, key: headers['X-OpenWA-Idempotency-Key'], data: parsed.data };
    });
  const dropped = (): Array<{ event?: string; reason?: string }> =>
    [
      ...((LoggerService.prototype.warn as jest.Mock).mock.calls as unknown[][]),
      ...((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][]),
    ]
      .map(call => call.find(arg => (arg as { action?: string } | undefined)?.action === 'webhook_dispatch_dropped'))
      .filter(Boolean) as Array<{ event?: string; reason?: string }>;

  const EVENTS = [
    'message.received',
    'message.sent',
    'message.ack',
    'message.receipt',
    'message.failed',
    'message.revoked',
    'message.reaction',
    'message.edited',
    'status.received',
    'session.status',
    'session.qr',
    'session.authenticated',
    'session.disconnected',
    'session.reconnect_loop',
    'session.restriction',
    'presence.update',
    'event.response',
    'poll.vote',
    'group.join',
    'group.leave',
    'group.update',
    'group.join_request',
    'call.received',
    'call.accepted',
    'call.rejected',
    'call.missed',
  ];
  const NOT_KEPT = ['message.receipt', 'presence.update', 'session.qr'];
  const dataFor = (event: string): Record<string, unknown> => ({
    sessionId,
    id: 'WA-X-1',
    messageId: 'WA-X-1',
    chatId: CHAT,
    from: CHAT,
    to: '628222@c.us',
    fromMe: false,
    body: event,
    type: 'text',
    status: 'read',
    participant: '628333@c.us',
    callId: 'CALL-1',
    groupId: '1203@g.us',
    participantIds: ['628333@c.us'],
    timestamp: 1_700_000_000,
  });

  it('keeps every event but three while the database is away, and dispatches each once when it answers', async () => {
    outage = 'on';
    for (const event of EVENTS) await webhookService.dispatch(sessionId, event, dataFor(event));
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    const kept = EVENTS.filter(event => !NOT_KEPT.includes(event));
    expect(posted().map(post => post.event)).toEqual(kept);
    // Each with its key, as its outbox row holds it (events with the same key share one row).
    const rows = await ds.getRepository(WebhookOutboxEvent).find();
    const postedKeys = [...new Set(posted().map(post => post.key))].sort();
    expect(postedKeys).toEqual(rows.map(row => row.idempotencyKey).sort());
    expect(
      dropped()
        .map(log => log.event)
        .sort(),
    ).toEqual([...NOT_KEPT].sort());
  });

  it("keeps a session's events in order, a new one after those kept before it", async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'a' });
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'b' });
    outage = 'off';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'c' });
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    expect(posted().map(post => post.data.status)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the key of an event whose dispatch is tried again', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'message.edited', { sessionId, messageId: 'M-1', body: 'x' });
    const opened = jest.spyOn(outbox, 'openBatch');
    // The webhooks can be read again, but no outbox row can be written yet.
    outage = 'writes';
    await projector.retryParkedChanges();
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();

    await recover();

    const keys = opened.mock.calls.map(([rows]) => rows[0].idempotencyKey);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
    expect(posted().map(post => post.key)).toEqual([keys[0]]);
  });

  it('still delivers live an event whose outbox row was written before the database went away', async () => {
    const opened = jest.spyOn(outbox, 'openBatch');
    opened.mockImplementationOnce(async rows => {
      const written = await outbox.open(rows[0]).then(() => null);
      outage = 'on';
      return written;
    });

    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await settle();

    expect(posted().map(post => post.event)).toEqual(['group.join']);
    outage = 'off';
    await recover();
    expect(posted()).toHaveLength(1);
  });

  it('keeps an event that left no durable copy: no outbox row, a receiver down, no failure row', async () => {
    outage = 'writes';
    mockFetch.mockResolvedValue(new Response('down', { status: 500 }));
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await settle(200);
    expect(posted()).toHaveLength(1);

    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await recover();

    expect(posted().map(post => post.event)).toEqual(['group.join', 'group.join']);
    expect(new Set(posted().map(post => post.key)).size).toBe(1);
  });

  it('keeps a message.revoked past the byte budget and the age cap, as a kept revoke is', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: Date.now() });
    try {
      outage = 'on';
      await webhookService.dispatch(sessionId, 'message.revoked', dataFor('message.revoked'));
      const big = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 66; i++) await webhookService.dispatch(sessionId, 'group.update', { sessionId, i, big });
      expect(dropped().filter(log => log.reason === 'bytes').length).toBeGreaterThan(0);
      jest.setSystemTime(Date.now() + 61 * 60 * 1000);

      await recover();

      expect(posted().map(post => post.event)).toEqual(['message.revoked']);
      expect(dropped().filter(log => log.event === 'message.revoked')).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the inline media of an event out of what it holds', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'message.received', {
      ...dataFor('message.received'),
      media: { mimetype: 'image/png', data: 'x'.repeat(64 * 1024) },
    });

    await recover();

    expect(posted()).toHaveLength(1);
    expect(JSON.stringify(posted()[0].data).length).toBeLessThan(8 * 1024);
  });

  it('dispatches what is kept at shutdown once the database answers, and logs what it still refuses', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    outage = 'off';
    await delivery.onModuleDestroy();
    expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(1);
  });

  it('logs what the database still refuses at shutdown as lost', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    await delivery.onModuleDestroy();

    expect(dropped()).toEqual([expect.objectContaining({ event: 'group.join', reason: 'shutdown' })]);
  });

  it('drops a state event of a session this node no longer owns, and dispatches the rest', async () => {
    outage = 'on';
    await webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'READY' });
    await webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
    owns = false;

    await recover();

    expect(posted().map(post => post.event)).toEqual(['group.join']);
    expect(dropped()).toEqual([expect.objectContaining({ event: 'session.status', reason: 'ownership' })]);
  });

  describe('an own send the gateway does not store, while the database is away', () => {
    const FILED = '628444@c.us';
    const send = {
      id: 'M-9',
      chatId: CHAT,
      from: '628222@c.us',
      to: CHAT,
      fromMe: true,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
      ephemeralDuration: 86_400,
    } as unknown as IncomingMessage;
    let previous: string | undefined;
    beforeEach(() => {
      previous = process.env.STORE_EPHEMERAL_MESSAGES;
      process.env.STORE_EPHEMERAL_MESSAGES = 'false';
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.STORE_EPHEMERAL_MESSAGES;
      else process.env.STORE_EPHEMERAL_MESSAGES = previous;
    });
    const echoWhileDown = async (): Promise<void> => {
      outage = 'on';
      projector.handleOwnSendEcho(sessionId, engine, send);
      await settle();
    };
    const sent = (): Array<Record<string, unknown>> =>
      posted()
        .filter(post => post.event === 'message.sent')
        .map(post => post.data);

    it("keeps the engine's chat of a message a handler filed elsewhere, and runs the filters when it is dispatched", async () => {
      hookManager.register('mover', 'message:sent', (ctx: { data: unknown }) =>
        Promise.resolve({
          continue: true,
          data: { ...(ctx.data as Record<string, unknown>), chatId: FILED, to: FILED },
        }),
      );
      await echoWhileDown();

      await recover();

      expect(sent()).toEqual([expect.objectContaining({ chatId: FILED, body: 'first text' })]);
      const row = await ds
        .getRepository(WebhookOutboxEvent)
        .findOne({ where: { event: 'message.sent' }, select: { id: true, engineRef: true } });
      expect(row?.engineRef).toMatchObject({ chatId: CHAT, direction: MessageDirection.OUTGOING });
    });

    it('dispatches nothing the filters exclude since it was kept', async () => {
      await echoWhileDown();
      outage = 'off';
      await ds.getRepository(Webhook).update(webhook.id, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'other' }] },
      });

      await recover();

      expect(sent()).toEqual([]);
    });

    it.each([
      [
        'an engine revoke',
        () => projector.recordRevoke(sessionId, 'M-9', { kind: 'revoke', chatId: CHAT, fromMe: true }, true),
        [],
      ],
      [
        'a delete through the API',
        () => projector.recordRevoke(sessionId, 'M-9', { kind: 'revoke', chatId: CHAT }),
        [expect.objectContaining({ type: 'revoked', body: '' })],
      ],
      [
        'an edit',
        async () => {
          projector.applyMessageEditQueued(sessionId, {
            messageId: 'M-9',
            chatId: CHAT,
            body: 'edited text',
            fromMe: true,
          } as never);
          await settle();
        },
        [expect.objectContaining({ body: 'edited text' })],
      ],
    ] as const)('dispatches the kept event as %s left it', async (_label, change, expected) => {
      await echoWhileDown();

      await change();
      await recover();

      expect(sent()).toEqual(expected);
    });

    it('dispatches nothing of an edit whose text the filters exclude', async () => {
      await ds.getRepository(Webhook).update(webhook.id, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'first' }] },
      });
      await echoWhileDown();

      projector.applyMessageEditQueued(sessionId, {
        messageId: 'M-9',
        chatId: CHAT,
        body: 'edited text',
        fromMe: true,
      } as never);
      await settle();
      await recover();

      expect(sent()).toEqual([]);
    });
  });

  it.each([
    [
      'an engine revoke',
      (): void =>
        projector.handleMessageRevoked(
          sessionId,
          engine,
          { id: 'E-9', revokedId: 'E-9', chatId: CHAT, timestamp: 1_700_000_002 } as never,
          { fromMe: false },
        ),
    ],
    [
      'a delete through the API',
      (): void => void projector.recordRevoke(sessionId, 'E-9', { kind: 'revoke', chatId: CHAT }),
    ],
  ] as const)('withdraws the kept message.edited of a message when %s follows the edit', async (_label, revoke) => {
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: 'E-9',
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1_700_000_000,
    });
    outage = 'on';
    projector.applyMessageEditQueued(sessionId, {
      messageId: 'E-9',
      chatId: CHAT,
      body: 'secret edit',
      fromMe: false,
    } as never);
    await settle();
    revoke();
    await settle();

    await recover();
    await recover();

    expect(posted().filter(post => JSON.stringify(post.data).includes('secret edit'))).toEqual([]);
    expect(posted().map(post => post.event)).not.toContain('message.edited');
  });

  describe('a message.edited delivery waiting to retry', () => {
    const edit = (body: string) => ({ messageId: 'Z-4', chatId: CHAT, from: CHAT, body, fromMe: false, type: 'text' });
    const waitFor = async (until: () => boolean | Promise<boolean>): Promise<void> => {
      for (const deadline = Date.now() + 10_000; !(await until());) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const edits = (): unknown[] =>
      posted()
        .filter(post => post.event === 'message.edited')
        .map(post => post.data.body);
    const failures = (): Promise<number> => ds.getRepository(WebhookDeliveryFailure).count();
    /** The edit's first attempt failed and its retry waits; `between` runs before the retry. */
    const failedOnce = async (between: () => Promise<unknown>, body = 'secret edit'): Promise<void> => {
      retryDelay = 800;
      await ds.getRepository(Webhook).update(webhook.id, { retryCount: 2, events: ['message.edited'] });
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'Z-4',
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      mockFetch.mockResolvedValueOnce(new Response('down', { status: 500 }));
      // Not awaited: a dispatch resolves once every attempt, retries included, has run.
      const dispatched = webhookService.dispatch(sessionId, 'message.edited', edit(body));
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await between();
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await dispatched;
    };

    it.each([
      [
        'an engine revoke',
        () => projector.recordRevoke(sessionId, 'Z-4', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
      ],
      ['a delete through the API', () => projector.recordRevoke(sessionId, 'Z-4', { kind: 'revoke', chatId: CHAT })],
    ] as const)('sends nothing more, and records no failure, once %s closed its row', async (_label, revoke) => {
      await failedOnce(revoke);

      expect(edits()).toEqual(['secret edit']);
      expect(await failures()).toBe(0);
    });

    it('waits while a revoke of the message is kept, and sends nothing once it closed the row', async () => {
      await failedOnce(async () => {
        outage = 'on';
        projector.handleMessageRevoked(
          sessionId,
          engine,
          { id: 'Z-4', revokedId: 'Z-4', chatId: CHAT, timestamp: 1_700_000_002 } as never,
          { fromMe: false },
        );
        await settle();
        // Past the backoff the retry finds the row unread and the revoke kept: it waits.
        await new Promise(resolve => setTimeout(resolve, 1200));
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await recover();
      });

      expect(edits()).toEqual(['secret edit']);
      expect((await ds.getRepository(Message).findOneByOrFail({ waMessageId: 'Z-4' })).type).toBe('revoked');
    });

    it.each([
      ['its outbox row', 'off'],
      ['the copy it keeps with no outbox row written', 'outbox writes'],
    ] as const)(
      "still sends an earlier edit's retry after a later edit of the message, from %s",
      async (_label, during) => {
        outage = during;
        await failedOnce(async () => {
          outage = 'off';
          await projector.recordOutboundMessageEdit(sessionId, 'Z-4', 'second fix', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: false,
          });
        }, 'first fix');

        expect(edits()).toEqual(['first fix', 'first fix']);
      },
    );

    it('sends an edit event kept while the database was away, after a later edit of the message', async () => {
      await ds.getRepository(Webhook).update(webhook.id, { events: ['message.edited'] });
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'Z-4',
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      outage = 'on';
      await webhookService.dispatch(sessionId, 'message.edited', edit('first fix'));
      await projector.recordOutboundMessageEdit(sessionId, 'Z-4', 'second fix', {
        kind: 'edit',
        chatId: CHAT,
        fromMe: false,
      });

      await recover();

      expect(edits()).toContain('first fix');
    });
  });

  describe('a delivery whose outbox row could not be written, while its retry waits', () => {
    const msg = {
      id: 'U-1',
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
    };
    const waitFor = async (until: () => boolean | Promise<boolean>): Promise<void> => {
      for (const deadline = Date.now() + 10_000; !(await until());) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const received = (): Array<Record<string, unknown>> =>
      posted()
        .filter(post => post.event === 'message.received')
        .map(post => post.data);
    /** The first attempt failed with no outbox row written, and its retry waits: `change` lands, then the retry runs. */
    const failedOnce = async (change: () => Promise<unknown>): Promise<void> => {
      retryDelay = 800;
      await ds.getRepository(Webhook).update(webhook.id, { retryCount: 2 });
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'U-1',
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      outage = 'outbox writes';
      mockFetch.mockResolvedValueOnce(new Response('down', { status: 500 }));
      // Not awaited: a dispatch resolves once every attempt, retries included, has run.
      const dispatched = webhookService.dispatch(sessionId, 'message.received', msg);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await change();
      await settle();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await dispatched;
    };
    const keptCopy = async (): Promise<Record<string, unknown> | null | undefined> =>
      (
        await ds
          .getRepository(WebhookDeliveryFailure)
          .createQueryBuilder('f')
          .addSelect('f.payload')
          .where('f.event = :event', { event: 'message.received' })
          .getOne()
      )?.payload;

    it('sends nothing of a delivery that waited for a slot once a revoke took its message back', async () => {
      (delivery as unknown as { dispatchLimiter: ConcurrencyLimiter }).dispatchLimiter = new ConcurrencyLimiter(
        1,
        1000,
      );
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'U-1',
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      let release: () => void = () => undefined;
      mockFetch.mockImplementationOnce(
        () => new Promise(resolve => (release = () => resolve(new Response('ok', { status: 200 })))),
      );
      const first = webhookService.dispatch(sessionId, 'group.join', dataFor('group.join'));
      await waitFor(() => mockFetch.mock.calls.length === 1);
      outage = 'outbox writes';
      const second = webhookService.dispatch(sessionId, 'message.received', msg);
      await waitFor(
        () => (delivery as unknown as { dispatchLimiter: ConcurrencyLimiter }).dispatchLimiter.queuedCount > 0,
      );
      outage = 'off';

      await projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
      release();
      await Promise.all([first, second]);

      expect(received()).toEqual([]);
      // The delivery ended with its withdrawal: no copy is left behind for it.
      expect(outbox.unwrittenCopy(webhook.id, `msg_${sessionId}_U-1_${webhook.id}`)).toBeUndefined();
    });

    it('sends nothing more once an engine revoke took the message back', async () => {
      await failedOnce(() =>
        projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
      );

      expect(received().map(data => data.body)).toEqual(['first text']);
    });

    it('sends the placeholder once a delete through the API took it back', async () => {
      await failedOnce(() => projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT }));

      expect(received().map(data => [data.type, data.body])).toEqual([
        ['text', 'first text'],
        ['revoked', ''],
      ]);
    });

    it('sends the edited text', async () => {
      await failedOnce(() =>
        projector.recordOutboundMessageEdit(sessionId, 'U-1', 'edited text', {
          kind: 'edit',
          chatId: CHAT,
          fromMe: false,
        }),
      );
      expect(received().map(data => data.body)).toEqual(['first text', 'edited text']);
    });

    describe('once a change landed on its copy, past the bounds of the copies', () => {
      // Newer copies of other deliveries whose identity alone is 1 MiB: past the content bound, then the ceiling.
      const pressure = (): void =>
        outbox.holdUnwritten(
          Array.from({ length: 90 }, (_, i) => ({
            webhookId: 'other',
            sessionId: 'other',
            event: 'message.received',
            idempotencyKey: `msg_other_P-${i}_other`,
            deliveryId: `p${i}`,
            payload: { id: `P-${i}`, author: `${'a'.repeat(1024 * 1024)}${i}` },
          })),
        );

      it('sends nothing more once an engine revoke took the message back', async () => {
        await failedOnce(async () => {
          await projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
          pressure();
        });

        expect(received().map(data => data.body)).toEqual(['first text']);
        expect(outbox.unwrittenCopy(webhook.id, `msg_${sessionId}_U-1_${webhook.id}`)).toBeUndefined();
      });

      it('sends the placeholder once a delete through the API took it back', async () => {
        await failedOnce(async () => {
          await projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT });
          pressure();
        });

        expect(received().map(data => [data.type, data.body])).toEqual([
          ['text', 'first text'],
          ['revoked', ''],
        ]);
      });
    });

    describe('whose copy the byte bound let go', () => {
      // Newer copies of other deliveries, past the bytes the copies may hold: the oldest content goes first.
      const pressure = (): void =>
        outbox.holdUnwritten(
          Array.from({ length: 65 }, (_, i) => ({
            webhookId: 'other',
            sessionId: 'other',
            event: 'message.received',
            idempotencyKey: `msg_other_P-${i}_other`,
            deliveryId: `p${i}`,
            payload: { id: `P-${i}`, media: { data: 'x'.repeat(1024 * 1024) } },
          })),
        );

      it.each([
        [
          'an engine revoke',
          () => projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
        ],
        ['a delete through the API', () => projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT })],
      ] as const)('sends nothing more once %s took the message back', async (_label, revoke) => {
        await failedOnce(async () => {
          pressure();
          await revoke();
        });

        expect(received().map(data => data.body)).toEqual(['first text']);
      });

      it.each([
        ['no change reaches it', (): Promise<unknown> => Promise.resolve()],
        [
          'an edit reaches it',
          () =>
            projector.recordOutboundMessageEdit(sessionId, 'U-1', 'edited text', {
              kind: 'edit',
              chatId: CHAT,
              fromMe: false,
            }),
        ],
      ] as const)('sends what it holds when %s', async (_label, change) => {
        await failedOnce(async () => {
          pressure();
          await change();
        });

        expect(received().map(data => data.body)).toEqual(['first text', 'first text']);
      });
    });

    it('sends nothing of an edit its webhook filters exclude', async () => {
      await ds.getRepository(Webhook).update(webhook.id, {
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'first' }] },
      });
      await failedOnce(() =>
        projector.recordOutboundMessageEdit(sessionId, 'U-1', 'edited text', {
          kind: 'edit',
          chatId: CHAT,
          fromMe: false,
        }),
      );

      expect(received().map(data => data.body)).toEqual(['first text']);
    });

    it.each([
      [
        'the edited text',
        () =>
          projector.recordOutboundMessageEdit(sessionId, 'U-1', 'edited text', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: false,
          }),
        { body: 'edited text' },
      ],
      [
        'nothing once taken back',
        () => projector.recordRevoke(sessionId, 'U-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
        undefined,
      ],
    ] as const)('keeps %s on the terminal failure row', async (_label, change, kept) => {
      retentionHours = 24;
      mockFetch.mockResolvedValue(new Response('down', { status: 500 }));

      await failedOnce(change);

      if (kept) expect(await keptCopy()).toMatchObject(kept);
      else expect(await keptCopy()).toBeFalsy();
    });
  });

  describe('a received message whose row the database refused', () => {
    const msg = {
      id: 'R-1',
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
    } as unknown as IncomingMessage;
    const received = (): Array<Record<string, unknown>> =>
      posted()
        .filter(post => post.event === 'message.received')
        .map(post => post.data);

    it.each([
      [
        'an engine revoke',
        () => projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
        [],
      ],
      [
        'a delete through the API',
        () => projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT }),
        [expect.objectContaining({ type: 'revoked', body: '' })],
      ],
      [
        'an edit',
        async () => {
          projector.applyMessageEditQueued(sessionId, {
            messageId: 'R-1',
            chatId: CHAT,
            body: 'edited text',
            fromMe: false,
          } as never);
          await settle();
        },
        [expect.objectContaining({ body: 'edited text' })],
      ],
    ] as const)('dispatches its kept announcement as %s left it', async (_label, change, expected) => {
      outage = 'on';
      void projector.handleInboundMessage(sessionId, engine, msg);
      await settle(200);

      await change();
      await recover();

      expect(received()).toEqual(expected);
    });

    describe('is stored once the database answers', () => {
      const rows = async () =>
        (await ds.getRepository(Message).find({ where: { sessionId } })).map(row => [
          row.waMessageId,
          row.type,
          row.body,
        ]);
      let persisted: string[];
      beforeEach(() => {
        persisted = [];
        hookManager.register('spec', 'message:persisted', ctx => {
          const { message } = ctx.data as { message: Message };
          persisted.push(`${message.waMessageId} ${message.type} ${message.body}`);
          return Promise.resolve({ continue: true });
        });
      });

      it.each(['on', 'writes'] as const)(
        'with its announcement sent once and message:persisted run once (database %s)',
        async refused => {
          outage = refused;
          void projector.handleInboundMessage(sessionId, engine, msg);
          await settle(200);

          await recover();
          await recover();

          expect(await rows()).toEqual([['R-1', 'text', 'first text']]);
          expect(received().map(data => data.body)).toEqual(['first text']);
          expect(persisted).toEqual(['R-1 text first text']);
        },
      );

      it('with a revoke that came while its row was kept written to it, not read as absent', async () => {
        outage = 'writes';
        void projector.handleInboundMessage(sessionId, engine, msg);
        await settle(200);
        // The database answers, the row is not written yet: the revoke waits for it.
        outage = 'off';
        await projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
        await settle();

        await recover();

        expect(await rows()).toEqual([['R-1', 'revoked', '']]);
      });

      it('or let go on the first retry once another writer stored it meanwhile, a change waiting for it applied then', async () => {
        outage = 'writes';
        void projector.handleInboundMessage(sessionId, engine, msg);
        await settle(200);
        outage = 'off';
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'R-1',
          chatId: CHAT,
          body: 'edited text',
          fromMe: false,
        } as never);
        await settle();
        // A re-delivery stored the row while it was kept.
        await ds.getRepository(Message).insert({
          sessionId,
          waMessageId: 'R-1',
          chatId: CHAT,
          from: CHAT,
          to: '628222@c.us',
          body: 'first text',
          type: 'text',
          direction: MessageDirection.INCOMING,
          timestamp: 1_700_000_000,
        });

        await recover();

        // Let go on that retry, not counted as a failure towards being given up.
        expect(projector.recoveryQueue().get('receive', `${sessionId}:R-1`)).toBeUndefined();
        expect(await rows()).toEqual([['R-1', 'text', 'edited text']]);
        for (let i = 0; i < 2; i++) await recover();
        // Only the edit hands the row on again; the kept row the other writer stored runs nothing.
        expect(persisted).toEqual(['R-1 text edited text']);
        const lost = ((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][]).filter(
          call => (call.at(-1) as { action?: string } | undefined)?.action === 'message_row_lost',
        );
        expect(lost).toEqual([]);
      });

      it('or given up with a loss logged once its insert keeps failing for a reason of its own', async () => {
        outage = 'writes';
        void projector.handleInboundMessage(sessionId, engine, msg);
        await settle(200);
        outage = 'off';
        jest
          .spyOn(ds.getRepository(Message), 'insert')
          .mockRejectedValue(Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' }));

        for (let i = 0; i < 3; i++) await recover();

        const lost = ((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][])
          .map(call => call.at(-1) as { action?: string; reason?: string } | undefined)
          .filter(meta => meta?.action === 'message_row_lost');
        expect(lost).toEqual([expect.objectContaining({ reason: 'failures' })]);
        expect(await rows()).toEqual([]);
      });

      it('as an own send composed on the phone, its announcement sent once', async () => {
        const echo = { ...msg, id: 'S-1', from: '628222@c.us', to: CHAT, fromMe: true } as IncomingMessage;
        outage = 'writes';
        projector.handleOwnSendEcho(sessionId, engine, echo);
        await settle(200);

        await recover();
        await recover();

        expect(await rows()).toEqual([['S-1', 'text', 'first text']]);
        expect(posted().filter(post => post.event === 'message.sent')).toHaveLength(1);
        expect(persisted).toEqual(['S-1 text first text']);
      });
    });
  });

  describe('a message the engine could not read for a stored target the database could not read', () => {
    const unavailable = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const losses = () =>
      ((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][])
        .map(call => call.at(-1) as { action?: string; reason?: string } | undefined)
        .filter(meta => meta?.action === 'message_inbound_lost');

    it('is handed back to its engine once, after the database answers, and kept while the target read fails', async () => {
      const redeliverInbound = jest.fn().mockRejectedValueOnce(unavailable()).mockResolvedValue(true);
      Object.assign(engine, { redeliverInbound });
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: '{"key":{"id":"ENV-A"}}' });

      await recover();
      await recover();
      await recover();

      expect(redeliverInbound.mock.calls).toEqual([['{"key":{"id":"ENV-A"}}'], ['{"key":{"id":"ENV-A"}}']]);
      expect(losses()).toEqual([]);
    });

    it('lands as the edit it carries once handed back: its text on the row, announced once', async () => {
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: 'E-1',
        chatId: CHAT,
        from: CHAT,
        to: '628222@c.us',
        body: 'first text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      // The engine reads the kept edit as on arrival, and reports it as it reports a live one.
      const redeliverInbound = jest.fn(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'E-1',
          chatId: CHAT,
          body: 'edited text',
          fromMe: false,
        } as never);
        return Promise.resolve(true);
      });
      Object.assign(engine, { redeliverInbound });
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: '{}', targetId: 'E-1' });

      await recover();
      await recover();

      const row = await ds.getRepository(Message).findOneByOrFail({ sessionId, waMessageId: 'E-1' });
      expect(row.body).toBe('edited text');
      expect(posted().filter(post => post.event === 'message.edited')).toHaveLength(1);
      expect(projector.isChangeKept(sessionId, 'E-1')).toBe(false);
    });

    it('hands back the later of two kept changes of one message only once the earlier one landed', async () => {
      const redeliverInbound = jest.fn().mockRejectedValueOnce(new Error('Unexpected token')).mockResolvedValue(true);
      Object.assign(engine, { redeliverInbound });
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: 'A', targetId: 'E-1' });
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-B', raw: 'B', targetId: 'E-1' });
      expect(projector.isChangeKept(sessionId, 'E-1')).toBe(true);

      await recover();
      await recover();

      expect(redeliverInbound.mock.calls).toEqual([['A'], ['A'], ['B']]);
    });

    describe('with the copy of the message it changes kept too, the store having refused it', () => {
      const copyOf = (id: string) => `{"key":{"id":"${id}"}}`;
      let calls: string[];
      beforeEach(() => {
        calls = [];
        Object.assign(engine, {
          redeliverInbound: jest.fn((raw: string) => {
            calls.push(`message ${raw}`);
            return Promise.resolve(true);
          }),
          restoreStoredCopy: jest.fn((raw: string, revoked: boolean) => {
            calls.push(`copy ${raw}${revoked ? ' revoked' : ''}`);
            return Promise.resolve(true);
          }),
          restoreStoredChange: jest.fn((raw: string) => {
            calls.push(`change ${raw}`);
            return Promise.resolve(true);
          }),
        });
      });

      it('writes the copy back first, and hands the change back after it', async () => {
        projector.keepStoredCopy(sessionId, { messageId: 'E-1', raw: copyOf('E-1') });
        projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: 'A', targetId: 'E-1' });
        expect([projector.isChangeKept(sessionId, 'E-1'), projector.isStoredCopyKept(sessionId, 'E-1')]).toEqual([
          true,
          true,
        ]);

        await recover();
        await recover();

        expect(calls).toEqual([`copy ${copyOf('E-1')}`, 'message A']);
        expect(projector.isStoredCopyKept(sessionId, 'E-1')).toBe(false);
      });

      it('applies the kept edits and deletes of the copy after it, in the order they came in', async () => {
        projector.keepStoredCopy(sessionId, { messageId: 'E-1', raw: copyOf('E-1') });
        projector.keepStoredChange(sessionId, { messageId: 'E-1', changeId: 'ED-1', raw: 'edit', blank: false });
        projector.keepStoredChange(sessionId, { messageId: 'E-1', changeId: 'RV-1', raw: 'blank', blank: true });
        expect(projector.isChangeKept(sessionId, 'E-1')).toBe(true);

        await recover();
        await recover();

        expect(calls).toEqual([`copy ${copyOf('E-1')}`, 'change edit', 'change blank']);
        expect(projector.isChangeKept(sessionId, 'E-1')).toBe(false);
      });

      it('names a lost delete of a copy in its log, as a deleted text may survive in the copy', async () => {
        Object.assign(engine, { restoreStoredChange: jest.fn().mockRejectedValue(new Error('Unexpected token')) });
        projector.keepStoredChange(sessionId, { messageId: 'E-1', changeId: 'RV-1', raw: 'blank', blank: true });

        for (let i = 0; i < 3; i++) await recover();

        const lost = ((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][])
          .map(call => call.at(-1) as { action?: string; messageId?: string } | undefined)
          .filter(meta => meta?.action === 'message_copy_blank_lost');
        expect(lost).toEqual([expect.objectContaining({ messageId: 'E-1', reason: 'failures' })]);
      });

      it('hands nothing back to the next account once the session unlinked the one it was kept for', async () => {
        projector.keepStoredCopy(sessionId, { messageId: 'E-1', raw: copyOf('E-1') });
        projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: 'A', targetId: 'E-1' });
        projector.keepStoredChange(sessionId, { messageId: 'E-1', changeId: 'RV-1', raw: 'blank', blank: true });

        projector.forgetKeptInbound(sessionId);
        await recover();

        expect(calls).toEqual([]);
        expect([projector.isChangeKept(sessionId, 'E-1'), projector.isStoredCopyKept(sessionId, 'E-1')]).toEqual([
          false,
          false,
        ]);
        expect(losses()).toEqual([]);
      });

      it('writes the copy blank once its row and a revoke that waited for the row landed', async () => {
        projector.keepStoredCopy(sessionId, { messageId: 'R-1', raw: copyOf('R-1') });
        outage = 'writes';
        void projector.handleInboundMessage(sessionId, engine, {
          id: 'R-1',
          chatId: CHAT,
          from: CHAT,
          to: '628222@c.us',
          fromMe: false,
          type: 'text',
          body: 'first text',
          timestamp: 1_700_000_000,
        } as unknown as IncomingMessage);
        await settle(200);
        outage = 'off';
        await projector.recordRevoke(sessionId, 'R-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
        await settle();

        await recover();
        await recover();

        expect(calls).toEqual([`copy ${copyOf('R-1')} revoked`]);
      });
    });

    it('waits for an engine that can take it back', async () => {
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: '{}' });
      await recover();
      const redeliverInbound = jest.fn().mockResolvedValue(true);
      Object.assign(engine, { redeliverInbound });

      await recover();

      expect(redeliverInbound).toHaveBeenCalledTimes(1);
    });

    it('is given up with a loss logged once its hand-back keeps failing for a reason of its own', async () => {
      Object.assign(engine, { redeliverInbound: jest.fn().mockRejectedValue(new Error('Unexpected token')) });
      projector.keepUnreadInbound(sessionId, { messageId: 'ENV-A', raw: '{' });

      for (let i = 0; i < 3; i++) await recover();

      expect(losses()).toEqual([expect.objectContaining({ messageId: 'ENV-A', reason: 'failures' })]);
    });
  });
});
