jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookReconcilerService } from '../webhook/webhook-reconciler.service';
import { ACK_RECONCILE_DELAY_MS, MessageProjector } from './message-projector.service';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { InfraDataService, type InfraExportDataResult } from '../infra/infra-data.service';
import { TABLE_IMPORTERS } from '../infra/table-importers';
import { BuiltInFtsProvider } from '../search/providers/builtin-fts.provider';
import * as sharedConnection from '../../common/utils/shared-connection';
import { closeSessionWrites } from '../../common/utils/session-write-scope';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function incomingMsg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'WA-MSG-1',
    chatId: '628111@c.us',
    from: '628111@c.us',
    to: '628222@c.us',
    body: 'hello world',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    ...over,
  } as IncomingMessage;
}

describe('MessageProjector + WebhookOutbox transactional atomicity (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let hookManager: HookManager;
  let eventsGateway: {
    emitMessage: jest.Mock;
    emitMessageSent: jest.Mock;
    emitMessageRevoked: jest.Mock;
    emitMessageReaction: jest.Mock;
    emitMessageAck: jest.Mock;
  };
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let sessionId: string;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      // Every table of the data database: the import case below walks each of them.
      entities: [
        Session,
        Message,
        Webhook,
        WebhookOutboxEvent,
        WebhookDeliveryFailure,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        ChatState,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        IntegrationDeliveryFailure,
        StatusUpdate,
        SendIdempotencyKey,
        AutomationRule,
      ],
      synchronize: true,
    }).initialize();

    const session = await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        name: 'atomic-test',
        status: SessionStatus.READY,
        config: {},
      }),
    );
    sessionId = session.id;

    const configService = {
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'queue.enabled': false,
          'webhook.dispatchConcurrency': 8,
          'webhook.dispatchMaxQueued': 100,
          'webhook.timeout': 5000,
          'webhook.retryDelay': 50,
          'webhook.shutdownDrainMs': 1000,
          'webhook.failurePayloadRetentionHours': 0,
          'webhook.maxPayloadBytes': 1024 * 1024,
          'webhook.mediaInlineMaxBytes': 1024 * 1024,
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

    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
      emitMessageAck: jest.fn(),
    };
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);

    projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
    );
  });

  afterEach(async () => {
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  async function seedWebhook(events: string[], overrides: Partial<Webhook> = {}): Promise<Webhook> {
    return ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events,
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
        ...overrides,
      }),
    );
  }

  /** The outbox refuses every write made inside a transaction with `failure()`; on its own it writes as usual. */
  function failOutboxInTransaction(failure: () => Error): jest.SpyInstance {
    const realOpenBatch = outbox.openBatch.bind(outbox);
    return jest
      .spyOn(outbox, 'openBatch')
      .mockImplementation((rows, manager) => (manager ? Promise.reject(failure()) : realOpenBatch(rows)));
  }
  const inTransaction = (openBatch: jest.SpyInstance): unknown[] =>
    openBatch.mock.calls.filter(([, manager]) => manager !== undefined);
  const busy = (): Error => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  /** From now on, the first read that judges whose message a stored row is fails, as on a database that just failed. */
  function failTheNextRowJudgement(): void {
    const repository = ds.getRepository(Message);
    const findOne = repository.findOne.bind(repository);
    let failed = false;
    jest.spyOn(repository, 'findOne').mockImplementation(options => {
      const judging = Boolean(options.select?.author);
      if (!judging || (options.where as { type?: unknown }).type !== undefined || failed) return findOne(options);
      failed = true;
      return Promise.reject(new Error('simulated read failure'));
    });
  }
  /** From now on, the `first` read that judges whose message a stored row is, and every one after it, fails. */
  function failRowJudgementsFrom(first: number): void {
    const repository = ds.getRepository(Message);
    const findOne = repository.findOne.bind(repository);
    let judged = 0;
    jest.spyOn(repository, 'findOne').mockImplementation(options => {
      const judging = Boolean(options.select?.author);
      if (!judging || (options.where as { type?: unknown }).type !== undefined) return findOne(options);
      judged += 1;
      return judged < first ? findOne(options) : Promise.reject(new Error('simulated read failure'));
    });
  }
  const outboxRowDispatched = async (): Promise<boolean> =>
    (await ds.getRepository(WebhookOutboxEvent).findOne({ where: { sessionId } }))?.state === 'dispatched';
  function collectPersisted(): Message[] {
    const persisted: Message[] = [];
    hookManager.register('test', 'message:persisted', ctx => {
      persisted.push((ctx.data as { message: Message }).message);
      return Promise.resolve({ continue: true });
    });
    return persisted;
  }

  it('stores the message row on its own when its outbox rows cannot be written in the same transaction', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-ROW-ALONE-1', body: 'kept without its transaction' });
    const persisted = collectPersisted();
    const openBatch = failOutboxInTransaction(() => new Error('simulated outbox failure'));

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(outboxRowDispatched);
    await flush();

    // The transaction rolled back with the outbox write, so the row is the one written alone after it.
    expect(inTransaction(openBatch)).toHaveLength(1);
    const stored = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ waMessageId: msg.id, body: 'kept without its transaction' });
    expect(persisted.map(row => row.id)).toEqual([stored[0].id]);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    // The deliveries prepared for the transaction are dropped: the live dispatch reads the webhooks itself,
    // records its own outbox row and delivers once.
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      event: 'message.received',
      idempotencyKey: `msg_${sessionId}_${msg.id}_${webhook.id}`,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Handed over again, the message finds its row: a repeat, stored and announced once.
    const again = projector.handleInboundMessage(sessionId, engine, msg);
    await again?.settled;
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('stores the row on its own when the retried commit of row and outbox rows fails as well', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-ROW-ALONE-RETRIED-1' });
    const persisted = collectPersisted();
    // A busy database is asked once more, and the second commit fails for good.
    const failures = [busy(), new Error('simulated outbox failure')];
    const openBatch = failOutboxInTransaction(() => failures.shift() ?? new Error('unexpected third commit'));

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(outboxRowDispatched);
    await flush();

    expect(inTransaction(openBatch)).toHaveLength(2);
    const stored = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(stored).toHaveLength(1);
    expect(persisted.map(row => row.id)).toEqual([stored[0].id]);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an error that is not retried', (): Error => new Error('simulated failure after the commit')],
    ['a busy database', busy],
  ])(
    'stores a message whose id could not be read once when its commit landed before %s surfaced',
    async (_label, failure) => {
      const webhook = await seedWebhook(['message.received']);
      const msg = incomingMsg({ id: '', body: 'no id to tell it by' });
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        await realTransaction(...args);
        throw failure();
      });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await flush();

      // No unique key guards a row without a message id: the attempt that follows the commit has to find
      // the row it left, or the message is stored a second time.
      expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(1);
      expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { webhookId: webhook.id } })).toBe(1);
      await waitFor(outboxRowDispatched);
      // Nothing is left pending for the sweep to deliver a second time.
      const stats = await reconciler.sweep(
        { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
        new Date(Date.now() + 1000),
      );
      expect(stats.replayed).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('stores two messages whose ids could not be read as two rows', async () => {
    await seedWebhook(['message.received']);

    for (const body of ['first without an id', 'second without an id']) {
      const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: '', body }));
      await receipt?.settled;
    }
    await waitFor(() => mockFetch.mock.calls.length === 2);

    const stored = await ds.getRepository(Message).find({ where: { sessionId }, order: { createdAt: 'ASC' } });
    expect(stored.map(row => row.body).sort()).toEqual(['first without an id', 'second without an id']);
    expect(stored.every(row => row.waMessageId === null)).toBe(true);
  });

  // The changes held for a message while its commit runs are written to its row by the caller once the row is
  // there, and announced. An engine that retires in between announces nothing, yet a message its sender took back
  // must not keep its content for that.
  describe.each([
    ['an inbound message', false, 'message.received'],
    ['an own-send echo', true, 'message.sent'],
  ] as const)('%s whose engine retires as its commit lands', (_what, fromMe, event) => {
    const text = 'taken back before the commit';
    const direction = fromMe ? { fromMe, from: '628222@c.us', to: '628111@c.us' } : { fromMe };
    const picture = (id: string): IncomingMessage =>
      incomingMsg({ ...direction, id, type: 'image', body: text, media: { mimetype: 'image/png', data: 'aGVsbG8=' } });
    const hand = (msg: IncomingMessage): void => {
      if (fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
      else void projector.handleInboundMessage(sessionId, engine, msg);
    };
    /** `change` reaches the message once its deliveries are prepared, and is done with before the commit begins. */
    const justBeforeTheCommit = (change: () => void | Promise<unknown>): void => {
      const realWait = sharedConnection.awaitNoOpenTransaction;
      let waits = 0;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        waits += 1;
        // The second wait is the insert's.
        if (waits === 2) {
          await change();
          for (let turn = 0; turn < 5; turn++) await flush();
        }
        return realWait(dataSource);
      });
    };
    /** The commit lands and the engine retires in the same turn; `failure`, if any, surfaces only then. */
    const retireAsTheCommitLands = (failure?: () => Error, meanwhile?: () => void): void => {
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        const result = await realTransaction(...args);
        engines.delete(sessionId);
        meanwhile?.();
        if (failure) throw failure();
        return result;
      });
    };
    const engineRevoke = (msg: IncomingMessage, actor?: { fromMe: boolean }): void =>
      projector.handleMessageRevoked(
        sessionId,
        engine,
        { id: msg.id, revokedId: msg.id, chatId: msg.chatId, from: msg.from, timestamp: msg.timestamp + 1 } as never,
        actor,
      );
    const storedRow = (id: string): Promise<Message | null> =>
      ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: id } });
    const outboxRows = (): Promise<WebhookOutboxEvent[]> =>
      ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    const turns = async (count: number): Promise<void> => {
      for (let turn = 0; turn < count; turn++) await flush();
    };
    const sweep = (): ReturnType<WebhookReconcilerService['sweep']> =>
      reconciler.sweep({ intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 }, new Date(Date.now() + 1000));
    const announced = (): jest.Mock => (fromMe ? eventsGateway.emitMessageSent : eventsGateway.emitMessage);
    const cleared = { type: 'revoked', body: '', metadata: null, mediaPath: null, mediaMimetype: null };

    it.each([
      ['the commit succeeded', undefined],
      [
        'the commit reported an error that is not retried',
        (): Error => new Error('simulated failure after the commit'),
      ],
      ['the commit reported a busy database', busy],
    ])('clears the row of a message revoked just before, and closes its outbox row, when %s', async (_how, failure) => {
      await seedWebhook([event]);
      const persisted = collectPersisted();
      const msg = picture('WA-RETIRED-REVOKED-1');
      justBeforeTheCommit(() => engineRevoke(msg));
      retireAsTheCommitLands(failure);

      hand(msg);
      await waitFor(async () => (await outboxRows())[0]?.state === 'dispatched');
      await turns(5);

      // The revoke found neither a row nor an outbox row when it came. Both were written with the content right
      // after, and nobody announces for a retired engine: neither may be left as it was written.
      expect(await storedRow(msg.id)).toMatchObject(cleared);
      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'dispatched', payload: null })]);
      expect((await sweep()).replayed).toBe(0);
      expect(persisted).toEqual([]);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('clears the row of a message deleted through the API just before, and leaves the sweep its placeholder', async () => {
      await seedWebhook([event]);
      const persisted = collectPersisted();
      const msg = picture('WA-RETIRED-DELETED-1');
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, undefined, false));
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(async () => ((await outboxRows())[0]?.payload as { type?: string } | null)?.type === 'revoked');
      await turns(5);

      // Such a delete is for this account only: the message is still announced, as deleted.
      expect(await storedRow(msg.id)).toMatchObject(cleared);
      const [pending] = await outboxRows();
      expect(pending).toMatchObject({ state: 'pending', payload: { id: msg.id, type: 'revoked', body: '' } });
      expect(JSON.stringify(pending.payload)).not.toContain('aGVsbG8=');
      expect(persisted).toEqual([]);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('clears the row and closes the outbox row of a message a handler had filed under another chat', async () => {
      await seedWebhook([event]);
      const group = '120363000000000001@g.us';
      hookManager.register('mover', fromMe ? 'message:sent' : 'message:received', ctx =>
        Promise.resolve({ continue: true, data: { ...(ctx.data as IncomingMessage), chatId: group } }),
      );
      const persisted = collectPersisted();
      const msg = picture('WA-RETIRED-REVOKED-MOVED-1');
      // The revoke names the chat the message arrived in; its row and its outbox row carry the handler's.
      justBeforeTheCommit(() => engineRevoke(msg));
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await turns(10);

      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'dispatched', payload: null })]);
      expect((await sweep()).replayed).toBe(0);
      expect(await storedRow(msg.id)).toMatchObject({ ...cleared, chatId: group });
      expect(persisted).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('leaves no row and raises nothing when the session is deleted in that same moment', async () => {
      await seedWebhook([event]);
      const errors = jest.spyOn(LoggerService.prototype, 'error');
      const persisted = collectPersisted();
      const msg = picture('WA-RETIRED-REVOKED-DELETING-1');
      justBeforeTheCommit(() => engineRevoke(msg));
      // A delete, in its order: it closes the session's writes, retires the engine, waits for the insert under way
      // and then removes the session's rows.
      let deleted: Promise<number> | undefined;
      retireAsTheCommitLands(undefined, () => {
        const closing = closeSessionWrites(ds, sessionId);
        deleted = closing.drain().then(async () => {
          const written = await ds.getRepository(Message).count({ where: { sessionId } });
          await ds.getRepository(Message).delete({ sessionId });
          await ds.getRepository(WebhookOutboxEvent).delete({ sessionId });
          closing.release();
          return written;
        });
      });

      hand(msg);
      await waitFor(() => deleted !== undefined);
      // The commit had landed: the delete waited for it and found its row.
      expect(await deleted).toBe(1);
      await turns(10);

      expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(0);
      expect(await outboxRows()).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      expect(persisted).toEqual([]);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    const editJustBeforeTheCommit = (msg: IncomingMessage): void =>
      justBeforeTheCommit(() =>
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never),
      );

    it.each([
      ['the commit succeeded', undefined],
      [
        'the commit reported an error that is not retried',
        (): Error => new Error('simulated failure after the commit'),
      ],
      ['the commit reported a busy database', busy],
    ])(
      'writes an edit that came just before the commit to the row and its outbox row when %s',
      async (_how, failure) => {
        await seedWebhook([event]);
        const persisted = collectPersisted();
        const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-EDITED-1', body: 'first text' });
        editJustBeforeTheCommit(msg);
        retireAsTheCommitLands(failure);

        hand(msg);
        await waitFor(async () => (await storedRow(msg.id))?.body === 'edited text');
        await turns(10);

        // message.edited went out when the edit came: what the sweep delivers later must not be the text before it.
        const stored = await storedRow(msg.id);
        expect(stored).toMatchObject({ type: 'text', body: 'edited text' });
        expect(stored?.metadata).toMatchObject({ edited: true });
        expect(await outboxRows()).toEqual([
          expect.objectContaining({
            state: 'pending',
            payload: expect.objectContaining({ body: 'edited text', edited: true }) as unknown,
          }),
        ]);
        expect(persisted).toEqual([]);
        expect(announced()).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();

        expect((await sweep()).replayed).toBe(1);
        await waitFor(() => mockFetch.mock.calls.length === 1);
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
        expect(JSON.parse(init.body)).toMatchObject({ event, data: { id: msg.id, body: 'edited text', edited: true } });
        expect(init.body).not.toContain('first text');
      },
    );

    it('writes a reaction that came just before the commit to the row', async () => {
      await seedWebhook([event]);
      const persisted = collectPersisted();
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-REACTED-1', body: 'first text' });
      justBeforeTheCommit(() =>
        projector.applyReactionQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          senderId: '628333@c.us',
          reaction: 'ok',
        }),
      );
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(async () => Boolean((await storedRow(msg.id))?.metadata?.reactions));
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({
        body: 'first text',
        metadata: expect.objectContaining({ reactions: { '628333@c.us': 'ok' } }) as unknown,
      });
      expect(persisted).toEqual([]);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      ['that names the chat', true],
      ['that names no chat', false],
    ])(
      'writes a receipt %s to the row when it came longer before the commit than its own retry waits',
      async (_how, named) => {
        await seedWebhook([event]);
        const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-READ-1', body: 'first text' });
        // The receipt's own second try finds no row yet: the commit waits longer than that behind another transaction.
        justBeforeTheCommit(() => {
          projector.handleMessageAck(sessionId, engine, msg.id, 'read', named ? msg.chatId : undefined);
          return new Promise(resolve => setTimeout(resolve, ACK_RECONCILE_DELAY_MS + 250));
        });
        retireAsTheCommitLands();

        hand(msg);
        await waitFor(async () => (await storedRow(msg.id))?.status === MessageStatus.READ, ACK_RECONCILE_DELAY_MS * 4);
      },
    );

    it('clears the row when an edit and then a revoke came just before the commit', async () => {
      await seedWebhook([event]);
      const msg = picture('WA-RETIRED-EDITED-REVOKED-1');
      justBeforeTheCommit(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        engineRevoke(msg);
      });
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(async () => (await outboxRows())[0]?.state === 'dispatched');
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject(cleared);
      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'dispatched', payload: null })]);
      expect((await sweep()).replayed).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('leaves alone a row of another chat that holds the id of the edited and read message', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-EDITED-ID-TAKEN-1', body: 'first text' });
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: msg.id,
        chatId: '628999@c.us',
        from: '628999@c.us',
        to: '628222@c.us',
        body: 'another chat keeps this',
        type: 'text',
        direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      justBeforeTheCommit(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        projector.handleMessageAck(sessionId, engine, msg.id, 'read', msg.chatId);
      });
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await turns(10);

      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({
        chatId: '628999@c.us',
        type: 'text',
        body: 'another chat keeps this',
        status: MessageStatus.SENT,
      });
      expect(stored?.metadata ?? {}).not.toHaveProperty('edited');
    });

    it.each([
      ['a delete through the API', 'the second judgement', 'api', 2],
      ['a delete through the API', 'any judgement', 'api', 1],
      ['a delete by the sender', 'any judgement', 'engine', 1],
    ] as const)(
      'leaves alone a row of another chat that holds the id after %s when %s cannot read it',
      async (_what, _which, how, first) => {
        await seedWebhook([event]);
        const msg = incomingMsg({ ...direction, id: `WA-RETIRED-DELETED-TAKEN-${how}-${first}`, body: text });
        await ds.getRepository(Message).insert({
          sessionId,
          waMessageId: msg.id,
          chatId: '628999@c.us',
          from: '628999@c.us',
          to: '628222@c.us',
          body: 'another chat keeps this',
          type: 'text',
          direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
          timestamp: 1_700_000_000,
        });
        justBeforeTheCommit(() => {
          if (how === 'api') void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId });
          else engineRevoke(msg, { fromMe });
        });
        retireAsTheCommitLands(undefined, () => failRowJudgementsFrom(first));

        hand(msg);
        await waitFor(() => !engines.has(sessionId));
        await turns(20);

        expect(await storedRow(msg.id)).toMatchObject({
          chatId: '628999@c.us',
          type: 'text',
          body: 'another chat keeps this',
        });
      },
    );

    it('clears its own row after a delete through the API when one judgement of it fails', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-DELETED-ONE-READ-1', body: text });
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId }));
      retireAsTheCommitLands(undefined, failTheNextRowJudgement);

      hand(msg);
      await waitFor(async () => (await storedRow(msg.id))?.type === 'revoked');
      expect(await storedRow(msg.id)).toMatchObject(cleared);
    });

    it('never delivers a deleted message whose own row cannot be read after its engine retired', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-DELETED-UNREAD-1', body: text });
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId }));
      retireAsTheCommitLands(undefined, () => failRowJudgementsFrom(1));

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await turns(20);
      await sweep();
      await turns(20);

      expect(mockFetch.mock.calls.map(([, init]) => (init as { body: string }).body).join('\n')).not.toContain(text);
    });

    it('leaves alone an unreadable row of another chat that holds the id of the edited and read message', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-EDITED-ID-TAKEN-3', body: 'first text' });
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: msg.id,
        chatId: '628999@c.us',
        from: '628999@c.us',
        to: '628222@c.us',
        body: 'another chat keeps this',
        type: 'text',
        direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      justBeforeTheCommit(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        projector.handleMessageAck(sessionId, engine, msg.id, 'read', msg.chatId);
      });
      retireAsTheCommitLands(undefined, failTheNextRowJudgement);

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await turns(10);

      // A row that could not be read is not known to be this message's.
      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({
        chatId: '628999@c.us',
        type: 'text',
        body: 'another chat keeps this',
        status: MessageStatus.SENT,
      });
      expect(stored?.metadata ?? {}).not.toHaveProperty('edited');
    });

    it('opens no outbox row for an edited message whose commit did not land when its own row came meanwhile', async () => {
      await seedWebhook([event]);
      // Matches the edited text only, so only a reconcile against the edit could add a delivery for it.
      await seedWebhook([event], {
        url: 'https://receiver.example/edited',
        filters: { conditions: [{ field: 'body', operator: 'contains', value: 'edited' }] },
      });
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-EDITED-NOT-LANDED-1', body: 'first text' });
      justBeforeTheCommit(() =>
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never),
      );
      // The commit is refused and rolled back; while it waits to be tried again, a row of the message that this
      // delivery did not write (the send path's, a history sync's) takes the id, and the engine retires.
      failOutboxInTransaction(busy);
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        try {
          return await realTransaction(...args);
        } finally {
          await ds.getRepository(Message).insert({
            sessionId,
            waMessageId: msg.id,
            chatId: msg.chatId,
            from: msg.from,
            to: msg.to,
            body: 'first text',
            type: 'text',
            direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
            timestamp: msg.timestamp,
          });
          engines.delete(sessionId);
        }
      });

      hand(msg);
      // The edit reaches that row once the retired message is settled.
      await waitFor(async () => (await storedRow(msg.id))?.body === 'edited text');
      await turns(10);

      // Nothing this delivery committed is in the outbox, so nothing may be delivered for it after the retire.
      expect(await outboxRows()).toEqual([]);
      expect((await sweep()).replayed).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('leaves alone the rows of another chat that took the id while the commit waited for its retry', async () => {
      const webhook = await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETIRED-EDITED-ID-TAKEN-2', body: 'first text' });
      const other = { id: msg.id, chatId: '628999@c.us', fromMe, body: 'another chat keeps this' };
      const takeTheIdAndRetire = async (): Promise<void> => {
        await ds.getRepository(Message).insert({
          sessionId,
          waMessageId: msg.id,
          chatId: other.chatId,
          from: other.chatId,
          to: '628222@c.us',
          body: other.body,
          type: 'text',
          direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
          timestamp: 1_700_000_000,
        });
        await outbox.openBatch([
          {
            webhookId: webhook.id,
            sessionId,
            event,
            idempotencyKey: `msg_${sessionId}_${msg.id}_${webhook.id}`,
            deliveryId: 'another-delivery',
            payload: other,
          },
        ]);
        engines.delete(sessionId);
      };
      // The first commit is refused and rolled back; while it waits to be tried again, the edit is held, the id is
      // taken by a message of another chat, and the engine retires.
      const realOpenBatch = outbox.openBatch.bind(outbox);
      let first = true;
      jest.spyOn(outbox, 'openBatch').mockImplementation((rows, manager) => {
        if (!manager || !first) return realOpenBatch(rows, manager);
        first = false;
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        setTimeout(() => void takeTheIdAndRetire(), 50);
        return Promise.reject(busy());
      });

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await new Promise(resolve => setTimeout(resolve, 400));
      await turns(10);

      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({ chatId: other.chatId, type: 'text', body: other.body });
      expect(stored?.metadata ?? {}).not.toHaveProperty('edited');
      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'pending', payload: other })]);
    });

    it('leaves alone a row of another chat that holds the id of the revoked message', async () => {
      await seedWebhook([event]);
      const msg = picture('WA-RETIRED-REVOKED-ID-TAKEN-1');
      // The id is taken by a message of another chat, so the insert of this one finds it stored.
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: msg.id,
        chatId: '628999@c.us',
        from: '628999@c.us',
        to: '628222@c.us',
        body: 'another chat keeps this',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      // From an engine that says who revoked. The revoke names the arriving message's chat, so it is held for
      // that message; the stored row proves it is not the one it names.
      justBeforeTheCommit(() => engineRevoke(msg, { fromMe }));
      retireAsTheCommitLands();

      hand(msg);
      await waitFor(() => !engines.has(sessionId));
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({
        chatId: '628999@c.us',
        type: 'text',
        body: 'another chat keeps this',
      });
    });
  });

  // On a live engine the changes held for a message are written to the row its commit stored, and the outbox rows of
  // that commit are settled by the dispatch after it. A handler may file the message under another chat than the one
  // the engine reported, and a change sent for the message names the engine's.
  describe.each([
    ['an inbound message', false, 'message.received'],
    ['an own-send echo', true, 'message.sent'],
  ] as const)('%s a handler filed under another chat, changed just before its commit', (_what, fromMe, event) => {
    const text = 'taken back before the commit';
    const group = '120363000000000001@g.us';
    const direction = fromMe ? { fromMe, from: '628222@c.us', to: '628111@c.us' } : { fromMe };
    const picture = (id: string): IncomingMessage =>
      incomingMsg({ ...direction, id, type: 'image', body: text, media: { mimetype: 'image/png', data: 'aGVsbG8=' } });
    const fileUnderTheGroup = (): void => {
      hookManager.register('mover', fromMe ? 'message:sent' : 'message:received', ctx =>
        Promise.resolve({ continue: true, data: { ...(ctx.data as IncomingMessage), chatId: group } }),
      );
    };
    const hand = (msg: IncomingMessage): void => {
      if (fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
      else void projector.handleInboundMessage(sessionId, engine, msg);
    };
    /** `change` reaches the message once its deliveries are prepared, and is done with before the commit begins. */
    const justBeforeTheCommit = (change: () => void): void => {
      const realWait = sharedConnection.awaitNoOpenTransaction;
      let waits = 0;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        waits += 1;
        // The second wait is the insert's.
        if (waits === 2) {
          change();
          for (let turn = 0; turn < 5; turn++) await flush();
        }
        return realWait(dataSource);
      });
    };
    /** The commit lands, then reports `failure`. */
    const failAfterTheCommit = (failure: () => Error): void => {
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        await realTransaction(...args);
        throw failure();
      });
    };
    const engineRevoke = (msg: IncomingMessage, actor?: { fromMe: boolean; participant?: string }): void =>
      projector.handleMessageRevoked(
        sessionId,
        engine,
        { id: msg.id, revokedId: msg.id, chatId: msg.chatId, from: msg.from, timestamp: msg.timestamp + 1 } as never,
        actor,
      );
    const storedRow = (id: string): Promise<Message | null> =>
      ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: id } });
    const outboxRows = (): Promise<WebhookOutboxEvent[]> =>
      ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    const turns = async (count: number): Promise<void> => {
      for (let turn = 0; turn < count; turn++) await flush();
    };
    const announced = (): jest.Mock => (fromMe ? eventsGateway.emitMessageSent : eventsGateway.emitMessage);
    const cleared = { type: 'revoked', body: '', metadata: null, mediaPath: null, mediaMimetype: null };

    it('applies a held edit and receipt to the row its retried insert lost to, though no judgement can read it', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETRIED-DUP-EDITED-UNREAD-1', body: 'first text' });
      justBeforeTheCommit(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        projector.handleMessageAck(sessionId, engine, msg.id, 'read', msg.chatId);
      });
      // The commit lands and reports a busy database: the retry meets the message's own row.
      failAfterTheCommit(() => {
        failRowJudgementsFrom(1);
        return busy();
      });

      hand(msg);

      await waitFor(async () => (await storedRow(msg.id))?.body === 'edited text');
      await turns(10);
      expect(await storedRow(msg.id)).toMatchObject({ body: 'edited text', status: MessageStatus.READ });
    });

    it('clears the row its retried insert lost to after a delete through the API, though no judgement can read it', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-RETRIED-DUP-DELETED-UNREAD-1', body: text });
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId }));
      // The commit lands and reports a busy database: the retry meets the message's own row.
      failAfterTheCommit(() => {
        failRowJudgementsFrom(1);
        return busy();
      });

      hand(msg);

      await waitFor(async () => (await storedRow(msg.id))?.type === 'revoked');
      expect(await storedRow(msg.id)).toMatchObject(cleared);
    });

    it.each([
      ['the commit succeeded', undefined],
      [
        'the commit reported an error that is not retried',
        (): Error => new Error('simulated failure after the commit'),
      ],
      ['the commit reported a busy database', busy],
    ])('clears the row of a message revoked just before, and closes its outbox row, when %s', async (_how, failure) => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = picture('WA-MOVED-REVOKED-1');
      // The revoke names the chat the message arrived in; its row and its outbox row carry the handler's.
      justBeforeTheCommit(() => engineRevoke(msg));
      if (failure) failAfterTheCommit(failure);

      hand(msg);
      await waitFor(async () => (await outboxRows())[0]?.state === 'dispatched');
      await turns(10);

      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'dispatched', payload: null })]);
      expect(
        (
          await reconciler.sweep(
            { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
            new Date(Date.now() + 1000),
          )
        ).replayed,
      ).toBe(0);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await storedRow(msg.id)).toMatchObject({ ...cleared, chatId: group });
    });

    it('clears the row of a message deleted through the API just before, and delivers it as deleted', async () => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = picture('WA-MOVED-DELETED-1');
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, undefined, false));

      hand(msg);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await turns(10);

      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({ event, data: { id: msg.id, type: 'revoked', body: '' } });
      expect(init.body).not.toContain(text);
      expect(init.body).not.toContain('aGVsbG8=');
      expect(JSON.stringify((await outboxRows()).map(row => row.payload))).not.toContain(text);
      expect(await storedRow(msg.id)).toMatchObject({ ...cleared, chatId: group });
    });

    it.each([
      ['on its first attempt', undefined],
      ['on the attempt after a busy database', busy],
    ])('leaves alone a row of another chat that holds the id when the insert finds it %s', async (_when, failure) => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = picture('WA-MOVED-ID-TAKEN-1');
      await ds.getRepository(Message).insert({
        sessionId,
        waMessageId: msg.id,
        chatId: '628999@c.us',
        from: '628999@c.us',
        to: '628222@c.us',
        body: 'another chat keeps this',
        type: 'text',
        direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        timestamp: 1_700_000_000,
      });
      // A delete through the API that names the chat the message arrived in, so it is held for that message.
      justBeforeTheCommit(() => void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId }));
      if (failure) jest.spyOn(ds, 'transaction').mockRejectedValueOnce(failure());

      if (fromMe) {
        hand(msg);
        await waitFor(() => mockFetch.mock.calls.length === 1);
      } else {
        await projector.handleInboundMessage(sessionId, engine, msg)?.settled;
      }
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({
        chatId: '628999@c.us',
        type: 'text',
        body: 'another chat keeps this',
      });
    });

    it('keeps the row of a message revoked by another sender just before its commit', async () => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = picture('WA-MOVED-REVOKED-BY-OTHER-1');
      justBeforeTheCommit(() => engineRevoke(msg, { fromMe: !fromMe }));

      hand(msg);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({ chatId: group, type: 'image', body: text });
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({ event, data: { id: msg.id, chatId: group, body: text } });
    });

    it('writes an edit that came just before the commit to the row', async () => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = incomingMsg({ ...direction, id: 'WA-MOVED-EDITED-1', body: 'first text' });
      justBeforeTheCommit(() =>
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never),
      );

      hand(msg);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({ chatId: group, body: 'edited text' });
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({ event, data: { id: msg.id, body: 'edited text', edited: true } });
    });

    it('writes a reaction that came just before the commit to the row', async () => {
      await seedWebhook([event]);
      fileUnderTheGroup();
      const msg = incomingMsg({ ...direction, id: 'WA-MOVED-REACTED-1', body: 'first text' });
      justBeforeTheCommit(() =>
        projector.applyReactionQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          senderId: '628333@c.us',
          reaction: 'ok',
        }),
      );

      hand(msg);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await turns(10);

      expect(await storedRow(msg.id)).toMatchObject({
        chatId: group,
        body: 'first text',
        metadata: expect.objectContaining({ reactions: { '628333@c.us': 'ok' } }) as unknown,
      });
    });
  });

  // The commit of row and outbox rows can land and still report an error, and the row stored alone after it can fail
  // as well. The message is then announced fail-open, and a change held for it meanwhile still has a row to reach.
  describe.each([
    ['an inbound message', false, 'message.received'],
    ['an own-send echo', true, 'message.sent'],
  ] as const)('%s whose row could not be stored alone after its commit reported an error', (_what, fromMe, event) => {
    const text = 'taken back before the commit';
    const direction = fromMe ? { fromMe, from: '628222@c.us', to: '628111@c.us' } : { fromMe };
    const picture = (id: string): IncomingMessage =>
      incomingMsg({ ...direction, id, type: 'image', body: text, media: { mimetype: 'image/png', data: 'aGVsbG8=' } });
    const hand = (msg: IncomingMessage): void => {
      if (fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
      else void projector.handleInboundMessage(sessionId, engine, msg);
    };
    /** `change` reaches the message once its deliveries are prepared, and is done with before the commit begins. */
    const justBeforeTheCommit = (change: () => void): void => {
      const realWait = sharedConnection.awaitNoOpenTransaction;
      let waits = 0;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        waits += 1;
        // The second wait is the insert's.
        if (waits === 2) {
          change();
          for (let turn = 0; turn < 5; turn++) await flush();
        }
        return realWait(dataSource);
      });
    };
    /**
     * The commit runs (and lands, unless something in it fails) and reports an error that is not retried; from
     * then on the table refuses every insert. `meanwhile` runs between the two.
     */
    const commitThenRefuseInserts = (meanwhile?: () => Promise<unknown>): void => {
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
        try {
          await realTransaction(...args);
        } finally {
          await meanwhile?.();
          await ds.query(
            `CREATE TRIGGER refuse_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'simulated messages storage error'); END`,
          );
        }
        throw new Error('simulated failure after the commit');
      });
    };
    const engineRevoke = (msg: IncomingMessage): void =>
      projector.handleMessageRevoked(sessionId, engine, {
        id: msg.id,
        revokedId: msg.id,
        chatId: msg.chatId,
        from: msg.from,
        timestamp: msg.timestamp + 1,
      } as never);
    /** Until the row stored alone has failed, then a few turns for what the caller does next. */
    const afterTheRowAloneFailed = async (): Promise<void> => {
      const errors = jest.spyOn(LoggerService.prototype, 'error');
      await waitFor(() => errors.mock.calls.some(([message]) => String(message).startsWith('Failed to save')));
      for (let turn = 0; turn < 10; turn++) await flush();
    };
    const storedRow = (id: string): Promise<Message | null> =>
      ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: id } });
    const outboxRows = (): Promise<WebhookOutboxEvent[]> =>
      ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    const sweep = (): ReturnType<WebhookReconcilerService['sweep']> =>
      reconciler.sweep({ intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 }, new Date(Date.now() + 1000));
    const announced = (): jest.Mock => (fromMe ? eventsGateway.emitMessageSent : eventsGateway.emitMessage);

    it('clears the row of a message revoked just before, and closes its outbox row', async () => {
      await seedWebhook([event]);
      const persisted = collectPersisted();
      const msg = picture('WA-ALONE-FAILED-REVOKED-1');
      justBeforeTheCommit(() => engineRevoke(msg));
      commitThenRefuseInserts();

      hand(msg);
      await afterTheRowAloneFailed();

      expect(await storedRow(msg.id)).toMatchObject({
        type: 'revoked',
        body: '',
        metadata: null,
        mediaPath: null,
        mediaMimetype: null,
      });
      expect(await outboxRows()).toEqual([expect.objectContaining({ state: 'dispatched', payload: null })]);
      expect((await sweep()).replayed).toBe(0);
      // Handed to message:persisted once, cleared, as a row a later attempt found is.
      expect(persisted.map(row => row.body)).toEqual(['']);
      expect(announced()).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('writes an edit that came just before the commit to the row', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-ALONE-FAILED-EDITED-1', body: 'first text' });
      justBeforeTheCommit(() =>
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never),
      );
      commitThenRefuseInserts();

      hand(msg);
      await afterTheRowAloneFailed();
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({ type: 'text', body: 'edited text' });
      expect(stored?.metadata).toMatchObject({ edited: true });
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({ event, data: { id: msg.id, body: 'edited text', edited: true } });
      expect((await sweep()).replayed).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['revoked', (msg: IncomingMessage): void => engineRevoke(msg)],
      [
        'edited',
        (msg: IncomingMessage): void =>
          projector.applyMessageEditQueued(sessionId, {
            messageId: msg.id,
            chatId: msg.chatId,
            body: 'edited text',
            fromMe,
          } as never),
      ],
    ])(
      'leaves alone a row of another chat that took the id of a message %s once its commit rolled back',
      async (_how, change) => {
        await seedWebhook([event]);
        const msg = picture('WA-ALONE-FAILED-ID-TAKEN-1');
        justBeforeTheCommit(() => change(msg));
        failOutboxInTransaction(() => new Error('simulated outbox failure'));
        commitThenRefuseInserts(() =>
          ds.getRepository(Message).insert({
            sessionId,
            waMessageId: msg.id,
            chatId: '628999@c.us',
            from: '628999@c.us',
            to: '628222@c.us',
            body: 'another chat keeps this',
            type: 'text',
            direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
            timestamp: 1_700_000_000,
          }),
        );

        hand(msg);
        await afterTheRowAloneFailed();

        expect(await ds.getRepository(Message).find({ where: { sessionId } })).toEqual([
          expect.objectContaining({ chatId: '628999@c.us', type: 'text', body: 'another chat keeps this' }),
        ]);
      },
    );

    it.each([
      ['a delete through the API', 'api'],
      ['a delete by the sender', 'engine'],
    ] as const)(
      'leaves alone a row of another chat that took the id after %s when no judgement can read it',
      async (_what, how) => {
        await seedWebhook([event]);
        const msg = incomingMsg({ ...direction, id: `WA-ALONE-DELETED-TAKEN-${how}`, body: text });
        justBeforeTheCommit(() => {
          if (how === 'api') void projector.recordRevoke(sessionId, msg.id, { kind: 'revoke', chatId: msg.chatId });
          else
            projector.handleMessageRevoked(
              sessionId,
              engine,
              {
                id: msg.id,
                revokedId: msg.id,
                chatId: msg.chatId,
                from: msg.from,
                timestamp: msg.timestamp + 1,
              } as never,
              { fromMe },
            );
        });
        failOutboxInTransaction(() => new Error('simulated outbox failure'));
        commitThenRefuseInserts(async () => {
          await ds.getRepository(Message).insert({
            sessionId,
            waMessageId: msg.id,
            chatId: '628999@c.us',
            from: '628999@c.us',
            to: '628222@c.us',
            body: 'another chat keeps this',
            type: 'text',
            direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
            timestamp: 1_700_000_000,
          });
          failRowJudgementsFrom(1);
        });

        hand(msg);
        await afterTheRowAloneFailed();

        expect(await ds.getRepository(Message).find({ where: { sessionId } })).toEqual([
          expect.objectContaining({ chatId: '628999@c.us', type: 'text', body: 'another chat keeps this' }),
        ]);
      },
    );

    it('leaves alone an unreadable row of another chat that took the id of a message edited and read', async () => {
      await seedWebhook([event]);
      const msg = incomingMsg({ ...direction, id: 'WA-ALONE-FAILED-ID-TAKEN-2', body: 'first text' });
      justBeforeTheCommit(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe,
        } as never);
        projector.handleMessageAck(sessionId, engine, msg.id, 'read', msg.chatId);
      });
      failOutboxInTransaction(() => new Error('simulated outbox failure'));
      commitThenRefuseInserts(async () => {
        await ds.getRepository(Message).insert({
          sessionId,
          waMessageId: msg.id,
          chatId: '628999@c.us',
          from: '628999@c.us',
          to: '628222@c.us',
          body: 'another chat keeps this',
          type: 'text',
          direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
          timestamp: 1_700_000_000,
        });
        failTheNextRowJudgement();
      });

      hand(msg);
      await afterTheRowAloneFailed();

      // A row that could not be read is not known to be this message's.
      const stored = await ds.getRepository(Message).find({ where: { sessionId } });
      expect(stored).toEqual([
        expect.objectContaining({
          chatId: '628999@c.us',
          type: 'text',
          body: 'another chat keeps this',
          status: MessageStatus.SENT,
        }),
      ]);
      expect(stored[0].metadata ?? {}).not.toHaveProperty('edited');
    });
  });

  it('stores no row on its own for an engine retired while the commit of row and outbox rows failed', async () => {
    await seedWebhook(['message.received']);
    const persisted = collectPersisted();
    const openBatch = failOutboxInTransaction(() => {
      engines.delete(sessionId);
      return new Error('simulated outbox failure');
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-ROW-ALONE-RETIRED-1' }));
    await receipt?.settled;
    await flush();

    // The commit was tried and rolled back. Nothing follows it for an engine that is gone: its row would be
    // one nobody is told about.
    expect(inTransaction(openBatch)).toHaveLength(1);
    expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(0);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
    expect(persisted).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
  });

  it('stores no row on its own for a session whose delete has begun', async () => {
    await seedWebhook(['message.received']);
    const persisted = collectPersisted();
    let closing: ReturnType<typeof closeSessionWrites> | undefined;
    const openBatch = failOutboxInTransaction(() => {
      // A delete closes the session's writes before it removes a row, and the commit under way fails meanwhile.
      closing = closeSessionWrites(ds, sessionId);
      return new Error('simulated outbox failure');
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-ROW-ALONE-DELETING-1' }));
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();
    closing?.release();

    // The commit was tried once, and the row alone was refused: written now, it could land after the delete.
    expect(inTransaction(openBatch)).toHaveLength(1);
    expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(0);
    expect(persisted).toEqual([]);
    // The engine is still registered, so the message is announced without a row, as after any failed insert.
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still commits the row and its outbox rows together when only the first attempt fails', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-COMMIT-RETRY-1' });
    const failures = [busy()];
    const realOpenBatch = outbox.openBatch.bind(outbox);
    const openBatch = jest.spyOn(outbox, 'openBatch').mockImplementation((rows, manager) => {
      const failure = manager && failures.shift();
      return failure ? Promise.reject(failure) : realOpenBatch(rows, manager);
    });
    // Stop before the delivery, so the pending outbox row shows which write left it.
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: msg.id } })).toBe(1);
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ webhookId: webhook.id, state: 'pending' });
    // Both writes of the outbox were the transaction's: nothing was left to a write of its own.
    expect(openBatch).toHaveBeenCalledTimes(2);
    expect(inTransaction(openBatch)).toHaveLength(2);
  });

  it('delivers once when the commit landed before its error surfaced, so the row alone finds it stored', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-COMMIT-LANDED-1' });
    const realTransaction = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw new Error('simulated failure after the commit');
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(outboxRowDispatched);
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: msg.id } })).toBe(1);
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].idempotencyKey).toBe(`msg_${sessionId}_${msg.id}_${webhook.id}`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('commits messages and pending webhook_outbox_events atomically so WebhookReconcilerService replays after a post-commit crash', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-CRASH-1', body: 'survives crash' });

    // Simulate process death immediately after transaction commit, before dispatchPrepared runs.
    const crashSpy = jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(crashSpy).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();

    // Both messages and a pending outbox row with replay payload must be durable in DB.
    const storedMsg = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: 'WA-CRASH-1' } });
    expect(storedMsg).not.toBeNull();
    expect(storedMsg?.body).toBe('survives crash');

    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      sessionId,
      event: 'message.received',
      state: 'pending',
    });
    expect(outboxRows[0].payload).toMatchObject({ id: 'WA-CRASH-1', body: 'survives crash' });

    // After restart, WebhookReconcilerService replays the stranded pending outbox row.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(init.headers['X-OpenWA-Idempotency-Key']).toBe(outboxRows[0].idempotencyKey);
    expect(JSON.parse(init.body)).toMatchObject({
      event: 'message.received',
      data: expect.objectContaining({ id: 'WA-CRASH-1', body: 'survives crash' }) as unknown,
    });

    const settledRow = await ds.getRepository(WebhookOutboxEvent).findOneBy({ id: outboxRows[0].id });
    expect(settledRow?.state).toBe('dispatched');
    expect(settledRow?.payload).toBeNull();
  });

  it('dedups duplicate waMessageId without rolling back concurrent writes or adding extra outbox rows', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-DUP-1', body: 'original' });

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    mockFetch.mockClear();

    // Replay the exact same waMessageId concurrently with an unrelated DB write.
    const dupReceipt = projector.handleInboundMessage(sessionId, engine, msg);
    const concurrentWrite = ds.getRepository(WebhookDeliveryFailure).insert({
      webhookId: 'w-other',
      sessionId,
      event: 'message.ack',
      url: 'https://receiver.example/hook',
      idempotencyKey: 'concurrent_write_key',
      deliveryId: 'conc-1',
      attempts: 1,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
    await Promise.all([dupReceipt?.settled, concurrentWrite]);
    await flush();

    // Duplicate inserted 0 extra messages, 0 extra outbox rows, did not dispatch again,
    // and never rolled back the concurrent write on SQLite's shared connection.
    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-DUP-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(
      await ds.getRepository(WebhookDeliveryFailure).count({ where: { idempotencyKey: 'concurrent_write_key' } }),
    ).toBe(1);
  });

  it('commits outbound echo messages and message.sent outbox rows atomically in commitOwnSendEcho', async () => {
    const webhook = await seedWebhook(['message.sent']);
    const echo = incomingMsg({
      id: 'WA-ECHO-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent from phone',
    });

    // Simulate a crash right after the commit: both the outgoing message and its pending message.sent outbox row survive.
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(
      async () => (await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-ECHO-1' } })) === 1,
    );
    await flush();

    const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: 'WA-ECHO-1' } });
    expect(stored?.direction).toBe(MessageDirection.OUTGOING);
    expect(stored?.body).toBe('sent from phone');

    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      sessionId,
      event: 'message.sent',
      state: 'pending',
    });
    expect(mockFetch).not.toHaveBeenCalled();

    // Reconciler replays the committed message.sent outbox row.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stores an own-send echo on its own when its outbox rows cannot be written in the same transaction', async () => {
    const webhook = await seedWebhook(['message.sent']);
    const echo = incomingMsg({
      id: 'WA-ECHO-ROW-ALONE-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent from phone',
    });
    const persisted = collectPersisted();
    const openBatch = failOutboxInTransaction(() => new Error('outbox failure on echo'));

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(outboxRowDispatched);
    await flush();

    expect(inTransaction(openBatch)).toHaveLength(1);
    const stored = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      waMessageId: echo.id,
      body: 'sent from phone',
      direction: MessageDirection.OUTGOING,
    });
    expect(persisted.map(row => row.id)).toEqual([stored[0].id]);
    expect(eventsGateway.emitMessageSent).toHaveBeenCalledTimes(1);
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ webhookId: webhook.id, event: 'message.sent' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('closes the prepared outbox row and suppresses message.received dispatch when revoked mid-flight', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-REV-1', body: 'secret text' });

    // Trigger an engine revoke immediately after openBatch writes the outbox row inside the tx
    // (before dispatchInboundMessage inspects withChangesMadeInFlight).
    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      // Schedule the revoke on the next microtask so it lands right after tx commit, before dispatch.
      queueMicrotask(() => {
        projector.handleMessageRevoked(sessionId, engine, {
          id: msg.id,
          revokedId: msg.id,
          chatId: msg.chatId,
          from: msg.from,
          timestamp: msg.timestamp + 1,
        } as never);
      });
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // message.received must NOT be dispatched.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();

    // The committed outbox row must have been closed (payload retired) so reconciler never replays it.
    const rows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId, event: 'message.received' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('dispatched');
    expect(rows[0].payload).toBeNull();

    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('runs webhook:before hooks strictly outside any SQLite transaction', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-HOOK-TX-1' });
    let inTxDuringHook: boolean | undefined;

    hookManager.register('test', 'webhook:before', (data: unknown) => {
      const conn = (ds.driver as { databaseConnection?: { inTransaction?: boolean } }).databaseConnection;
      inTxDuringHook = conn?.inTransaction;
      return Promise.resolve({ continue: true, data });
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(inTxDuringHook).toBe(false);
  });

  it('preserves fail-open webhook delivery on a non-unique messages persistence error', async () => {
    await seedWebhook(['message.received']);
    await ds.query(`
      CREATE TRIGGER fail_msg_insert BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated messages storage error');
      END
    `);

    const msg = incomingMsg({ id: 'WA-FAILOPEN-1', body: 'still delivered' });
    const persisted = collectPersisted();
    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();

    // No write of the row can land, with its outbox rows or alone: announced all the same, with no row to point at.
    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-FAILOPEN-1' } })).toBe(0);
    expect(persisted).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('dispatches message.sent cleanly when commitOwnSendEcho sees an existing REST-persisted outgoing row', async () => {
    await seedWebhook(['message.sent']);
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: 'WA-REST-1',
      chatId: '628111@c.us',
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent via api',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1_700_000_000,
    });

    const echo = incomingMsg({
      id: 'WA-REST-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent via api',
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => mockFetch.mock.calls.length === 1);

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-REST-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId, event: 'message.sent' } })).toBe(1);
  });

  it('redacts committed outbox and dispatches deletedPlaceholder on mid-flight REST revoke (announced=false)', async () => {
    const catchAll = await seedWebhook(['message.received'], { url: 'https://receiver.example/all' });
    const secretFiltered = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/secret-only',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'TOPSECRET' }] },
    });
    const msg = incomingMsg({ id: 'WA-REST-REV-1', body: 'TOPSECRET password' });

    // Crash right before live dispatch so we can inspect the reconciled pending outbox row first.
    const capturedPayloads: Array<{ url: string; body: string }> = [];
    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      // REST revoke (announced=false) lands right after commit, before dispatchInboundMessage.
      queueMicrotask(() => {
        void projector.recordRevoke(sessionId, msg.id, undefined, false);
      });
      return res;
    });

    mockFetch.mockImplementation((url: string, init: { body: string }) => {
      capturedPayloads.push({ url, body: init.body });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => capturedPayloads.length >= 1);
    await flush();

    // Only catchAll receives the delivery, with deletedPlaceholder (never the secret body).
    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].url).toBe(catchAll.url);
    const parsed = JSON.parse(capturedPayloads[0].body) as { data: Record<string, unknown> };
    expect(parsed.data).toMatchObject({ id: 'WA-REST-REV-1', type: 'revoked', body: '' });
    expect(capturedPayloads[0].body).not.toContain('TOPSECRET');

    // Neither outbox row retains the unredacted secret body.
    const rows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(rows.some(r => JSON.stringify(r.payload ?? {}).includes('TOPSECRET'))).toBe(false);
    const filteredRow = rows.find(r => r.webhookId === secretFiltered.id);
    expect(filteredRow?.state).toBe('dispatched');
    expect(filteredRow?.payload).toBeNull();
  });

  it('reconciles committed outbox rows, filters, and dispatch payload on mid-flight edit (v1 -> v2)', async () => {
    const catchAll = await seedWebhook(['message.received'], { url: 'https://receiver.example/all' });
    const v1Only = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/v1',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'draft-v1' }] },
    });
    const v2Only = await seedWebhook(['message.received'], {
      url: 'https://receiver.example/v2',
      filters: { conditions: [{ field: 'body', operator: 'contains', value: 'final-v2' }] },
    });
    const msg = incomingMsg({ id: 'WA-EDIT-DRIFT-1', body: 'draft-v1' });

    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      queueMicrotask(() => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'final-v2',
          fromMe: false,
        } as never);
      });
      return res;
    });

    // Pause dispatchPrepared to inspect durable reconciled outbox rows before live POST.
    const crashSpy = jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(crashSpy).toHaveBeenCalledTimes(1);
    const allRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    const byWebhook = new Map(allRows.map(r => [r.webhookId, r]));

    // v1Only stopped matching and was closed; catchAll and v2Only are pending with body='final-v2', edited=true.
    expect(byWebhook.get(v1Only.id)?.state).toBe('dispatched');
    expect(byWebhook.get(v1Only.id)?.payload).toBeNull();
    expect(byWebhook.get(catchAll.id)?.state).toBe('pending');
    expect(byWebhook.get(catchAll.id)?.payload).toMatchObject({ body: 'final-v2', edited: true });
    expect(byWebhook.get(v2Only.id)?.state).toBe('pending');
    expect(byWebhook.get(v2Only.id)?.payload).toMatchObject({ body: 'final-v2', edited: true });

    // Reconciler delivers the exact v2 payload to catchAll and v2Only only.
    const deliveredUrls: string[] = [];
    mockFetch.mockImplementation((url: string, init: { body: string }) => {
      deliveredUrls.push(url);
      expect(JSON.parse(init.body)).toMatchObject({
        data: expect.objectContaining({ body: 'final-v2', edited: true }) as unknown,
      });
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(2);
    expect(deliveredUrls.sort()).toEqual([catchAll.url, v2Only.url].sort());
  });

  it('closes pending outbox rows when engine revoke races with engine retire/disconnect without touching sibling message ids', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-REV-RETIRE-1', body: 'must not leak after retire' });

    // Seed a sibling pending row whose waMessageId shares a prefix and SQL wildcard characters.
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_sibling_${webhook.id}`,
        deliveryId: 'sib-del-1',
        payload: { id: 'WA-REV-RETIRE-1_sibling', body: 'sibling stays pending' },
      },
    ]);

    const realOpenBatch = outbox.openBatch.bind(outbox);
    jest.spyOn(outbox, 'openBatch').mockImplementationOnce(async (rows, manager) => {
      const res = await realOpenBatch(rows, manager);
      queueMicrotask(() => {
        projector.handleMessageRevoked(sessionId, engine, {
          id: msg.id,
          revokedId: msg.id,
          chatId: msg.chatId,
          from: msg.from,
          timestamp: msg.timestamp + 1,
        } as never);
        // Retire the engine immediately after revoke so persistInboundMessage exits at !isLive.
        engines.delete(sessionId);
      });
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // Revoked row is closed while the prefix-sharing sibling remains pending.
    const revokedRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_${webhook.id}` },
    });
    expect(revokedRow?.state).toBe('dispatched');
    expect(revokedRow?.payload).toBeNull();

    const siblingRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-REV-RETIRE-1_sibling_${webhook.id}` },
    });
    expect(siblingRow?.state).toBe('pending');

    // Reconciler replays ONLY the sibling, never the revoked message.
    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(init.body).toContain('WA-REV-RETIRE-1_sibling');
    expect(init.body).not.toContain('must not leak after retire');
  });

  it('keeps unowned pre-existing outbox rows intact on cancel and preserves Note-to-Self and repeated session.qr dispatches', async () => {
    const webhook = await seedWebhook(['message.received', 'message.sent', 'session.qr']);

    // 1. Pre-existing outbox key owned by an earlier attempt must not be closed if a later commit
    //    is revoked mid-flight (openBatch returns [] so cancelPrepared owns 0 rows).
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-PREEXIST-1_${webhook.id}`,
        deliveryId: 'prior-delivery',
        payload: { id: 'WA-PREEXIST-1', chatId: '628999@c.us', fromMe: false, body: 'owned by prior attempt' },
      },
    ]);

    const realCancel = delivery.cancelPrepared.bind(delivery);
    const cancelSpy = jest.spyOn(delivery, 'cancelPrepared').mockImplementation(realCancel);

    const realTransaction = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTransaction(...args);
      // Simulate mid-flight engine revoke (with foreign-chat pre-existing outbox row left alone).
      projector.handleMessageRevoked(
        sessionId,
        engine,
        {
          id: 'WA-PREEXIST-1',
          revokedId: 'WA-PREEXIST-1',
          chatId: '628111@c.us',
          from: '628111@c.us',
          timestamp: 1_700_000_001,
        } as never,
        { fromMe: false },
      );
      return res;
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-PREEXIST-1' }));
    await receipt?.settled;
    await flush();

    // cancelPrepared must NOT have been asked to close the unowned pre-existing row.
    expect(cancelSpy).not.toHaveBeenCalled();
    const priorRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-PREEXIST-1_${webhook.id}` },
    });
    expect(priorRow?.state).toBe('pending');
    expect(priorRow?.payload).toMatchObject({ body: 'owned by prior attempt' });

    // 2. Note-to-Self: message.received and message.sent share msg_<session>_<waId>_<whId>;
    //    BOTH events must dispatch live without 7-day outbox retention dropping the second.
    mockFetch.mockClear();
    const receivedEvents: string[] = [];
    mockFetch.mockImplementation((_url, init?: { body?: string }) => {
      if (init?.body) {
        const parsed = JSON.parse(init.body) as { event: string };
        receivedEvents.push(parsed.event);
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('ok') });
    });

    await webhookService.dispatch(sessionId, 'message.received', {
      id: 'WA-NOTE-SELF-1',
      chatId: '628111@c.us',
      fromMe: true,
      body: 'note to self',
    });
    await webhookService.dispatch(sessionId, 'message.sent', {
      id: 'WA-NOTE-SELF-1',
      chatId: '628111@c.us',
      fromMe: true,
      body: 'note to self',
    });
    await flush();
    expect(receivedEvents).toEqual(['message.received', 'message.sent']);

    // 3. Repeated session.qr events within the 7-day retention window must BOTH dispatch.
    receivedEvents.length = 0;
    await webhookService.dispatch(sessionId, 'session.qr', { qr: 'qr-frame-1' });
    await webhookService.dispatch(sessionId, 'session.qr', { qr: 'qr-frame-2' });
    await flush();
    expect(receivedEvents).toEqual(['session.qr', 'session.qr']);

    // 4. Note-to-Self end-to-end through MessageProjector (inbound + own-send echo on same id).
    receivedEvents.length = 0;
    const selfMsg = incomingMsg({
      id: 'WA-NOTE-SELF-PROJECTOR-1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628111@c.us',
      fromMe: true,
      body: 'self note via projector',
    });
    const selfReceipt = projector.handleInboundMessage(sessionId, engine, selfMsg);
    await selfReceipt?.settled;
    await waitFor(() => receivedEvents.length === 1);
    projector.handleOwnSendEcho(sessionId, engine, selfMsg);
    await waitFor(() => receivedEvents.length === 2);
    await flush();
    expect(receivedEvents).toEqual(['message.received', 'message.sent']);
  });

  it('stores the message when the webhook lookup fails, and takes a later re-fire of it as a repeat', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-LOOKUP-ERR-1', body: 'kept without its webhooks' });

    const webhookRepo = ds.getRepository(Webhook);
    let failLookup = true;
    const realFind = webhookRepo.find.bind(webhookRepo);
    const findSpy = jest.spyOn(webhookRepo, 'find').mockImplementation((...args) => {
      if (failLookup) return Promise.reject(new Error('webhooks table unavailable'));
      return realFind(...args);
    });

    const first = projector.handleInboundMessage(sessionId, engine, msg);
    await first?.settled;
    // Once before the insert and once for the live dispatch, which has then given up.
    await waitFor(() => findSpy.mock.calls.length === 2);
    await flush();

    // Nothing can be delivered while the webhooks cannot be read, but the message itself is kept.
    const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: 'WA-LOOKUP-ERR-1' } });
    expect(stored?.body).toBe('kept without its webhooks');
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);

    // The same message handed over again finds its row: a repeat, stored and announced once.
    failLookup = false;
    const again = projector.handleInboundMessage(sessionId, engine, msg);
    await again?.settled;
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-LOOKUP-ERR-1' } })).toBe(1);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('stores an inbound message while a webhook of the session holds events that cannot be parsed', async () => {
    const webhook = await seedWebhook(['message.received']);
    await ds.query(`UPDATE webhooks SET events = '{not json' WHERE id = ?`, [webhook.id]);
    const findSpy = jest.spyOn(ds.getRepository(Webhook), 'find');
    const persisted: Message[] = [];
    hookManager.register('test', 'message:persisted', ctx => {
      persisted.push((ctx.data as { message: Message }).message);
      return Promise.resolve({ continue: true });
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-BAD-JSON-1' }));
    await receipt?.settled;
    await waitFor(() => findSpy.mock.calls.length === 2);
    await flush();

    const stored = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ waMessageId: 'WA-BAD-JSON-1', body: 'hello world', from: '628111@c.us' });
    expect(persisted.map(row => row.id)).toEqual([stored[0].id]);
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers once, with its outbox row, when the webhooks can be read again for the live dispatch', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-LOOKUP-RECOVERS-1', body: 'delivered after all' });
    // Only the read made before the insert fails.
    jest.spyOn(ds.getRepository(Webhook), 'find').mockRejectedValueOnce(new Error('webhooks table unavailable'));

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(async () => {
      const row = await ds.getRepository(WebhookOutboxEvent).findOne({ where: { sessionId } });
      return row?.state === 'dispatched';
    });
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: msg.id } })).toBe(1);
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      webhookId: webhook.id,
      event: 'message.received',
      idempotencyKey: `msg_${sessionId}_${msg.id}_${webhook.id}`,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      event: 'message.received',
      data: expect.objectContaining({ id: msg.id, body: 'delivered after all' }) as unknown,
    });
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
  });

  it('stores an own-send echo while a webhook of the session holds events that cannot be parsed', async () => {
    const webhook = await seedWebhook(['message.sent']);
    await ds.query(`UPDATE webhooks SET events = '{not json' WHERE id = ?`, [webhook.id]);
    const findSpy = jest.spyOn(ds.getRepository(Webhook), 'find');
    const echo = incomingMsg({
      id: 'WA-ECHO-BAD-JSON-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'sent from the phone',
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => eventsGateway.emitMessageSent.mock.calls.length === 1);
    await waitFor(() => findSpy.mock.calls.length === 2);
    await flush();

    const stored = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      waMessageId: 'WA-ECHO-BAD-JSON-1',
      body: 'sent from the phone',
      direction: MessageDirection.OUTGOING,
    });
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessageSent).toHaveBeenCalledTimes(1);
  });

  it('stores a message cleared when it is revoked while its failing webhook lookup is retried', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-LOOKUP-RETRY-REV-1', body: 'taken back meanwhile' });
    const persistedBodies: string[] = [];
    hookManager.register('test', 'message:persisted', ctx => {
      persistedBodies.push((ctx.data as { message: Message }).message.body);
      return Promise.resolve({ continue: true });
    });
    jest
      .spyOn(ds.getRepository(Webhook), 'find')
      // A busy database is asked once more; the revoke lands before that second read fails as well.
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))
      .mockImplementationOnce(() => {
        projector.handleMessageRevoked(sessionId, engine, {
          id: msg.id,
          revokedId: msg.id,
          chatId: msg.chatId,
          from: msg.from,
          timestamp: msg.timestamp + 1,
        } as never);
        return Promise.reject(new Error('webhooks table unavailable'));
      });

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => persistedBodies.length > 0);
    await flush();

    const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: msg.id } });
    expect(stored).toMatchObject({ type: 'revoked', body: '' });
    // message:persisted never carried the text that was taken back.
    expect(persistedBodies.every(body => body === '')).toBe(true);
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('stores and delivers the edited text once when the lookup repeated for an edit fails', async () => {
    await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-LOOKUP-EDIT-1', body: 'first text' });
    const realPrepare = webhookService.prepareDeliveries.bind(webhookService);
    jest
      .spyOn(webhookService, 'prepareDeliveries')
      // The edit lands during the first lookup, so the deliveries are prepared again, and that lookup fails.
      .mockImplementationOnce((...args) => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: msg.id,
          chatId: msg.chatId,
          body: 'edited text',
          fromMe: false,
        } as never);
        return realPrepare(...args);
      })
      .mockRejectedValueOnce(new Error('webhooks table unavailable'));

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await waitFor(async () => {
      const row = await ds.getRepository(WebhookOutboxEvent).findOne({ where: { sessionId } });
      return row?.state === 'dispatched';
    });
    await flush();

    const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: msg.id } });
    expect(stored?.body).toBe('edited text');
    expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      event: 'message.received',
      data: expect.objectContaining({ id: msg.id, body: 'edited text', edited: true }) as unknown,
    });
  });

  it('preserves fail-open outbox write with latest payload on messages error and closes outbox on retried-dup revoke', async () => {
    await seedWebhook(['message.received']);
    await ds.query(`
      CREATE TRIGGER fail_msg_insert_2 BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'messages storage failure');
      END
    `);

    // Pause dispatchPrepared to verify that fail-open dispatch() still writes a best-effort outbox row.
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(() => Promise.resolve());

    const msg = incomingMsg({ id: 'WA-FAILOPEN-OUTBOX-1', body: 'delivered fail-open' });
    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    expect(await ds.getRepository(Message).count({ where: { sessionId, waMessageId: 'WA-FAILOPEN-OUTBOX-1' } })).toBe(
      0,
    );
    const outboxRows = await ds.getRepository(WebhookOutboxEvent).find({ where: { sessionId } });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ event: 'message.received', state: 'pending' });
    expect(outboxRows[0].payload).toMatchObject({ id: 'WA-FAILOPEN-OUTBOX-1', body: 'delivered fail-open' });
  });

  it('closes pending outbox rows when a retried duplicate insert is revoked before dispatch', async () => {
    const webhook = await seedWebhook(['message.received']);
    const msg = incomingMsg({ id: 'WA-RETRY-DUP-REV-1', body: 'sensitive retry body' });

    // Simulate attempt 1 committing BOTH message + pending outbox row, then throwing a transient
    // post-commit error (e.g. connection drop), followed by an engine revoke before attempt 2 returns dup.
    const realTransaction = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    // Trigger engine revoke while insertWithRetry is sleeping before its retry attempt.
    const origSetTimeout = global.setTimeout;
    let revokeScheduled = false;
    jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (!revokeScheduled && ms === 300) {
        revokeScheduled = true;
        return origSetTimeout(() => {
          projector.handleMessageRevoked(sessionId, engine, {
            id: msg.id,
            revokedId: msg.id,
            chatId: msg.chatId,
            from: msg.from,
            timestamp: msg.timestamp + 1,
          } as never);
          fn(...rest);
        }, 10);
      }
      return origSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);

    const receipt = projector.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await flush();

    // The pending outbox row committed by attempt 1 must be closed so reconciler never replays it.
    const row = await ds
      .getRepository(WebhookOutboxEvent)
      .findOne({ where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${msg.id}_${webhook.id}` } });
    expect(row?.state).toBe('dispatched');
    expect(row?.payload).toBeNull();

    const stats = await reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    expect(stats.replayed).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls prepareDeliveries exactly once across 0-webhook echo, REST-dup echo, and pre-edited inbound message', async () => {
    const prepareSpy = jest.spyOn(webhookService, 'prepareDeliveries');

    // (a) commitOwnSendEcho with 0 matching webhooks.
    const echo0 = incomingMsg({
      id: 'WA-ECHO-ZERO-1',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'no webhooks',
    });
    projector.handleOwnSendEcho(sessionId, engine, echo0);
    await waitFor(() => eventsGateway.emitMessageSent.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    // (b) commitOwnSendEcho on a pre-existing REST-persisted row.
    await seedWebhook(['message.sent', 'message.received']);
    await ds.getRepository(Message).insert({
      sessionId,
      waMessageId: 'WA-REST-ONCE-1',
      chatId: '628111@c.us',
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'api send',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1_700_000_000,
    });
    prepareSpy.mockClear();
    projector.handleOwnSendEcho(
      sessionId,
      engine,
      incomingMsg({ id: 'WA-REST-ONCE-1', fromMe: true, from: '628222@c.us', to: '628111@c.us', body: 'api send' }),
    );
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    // (c) prepareTransactionalDeliveries with a message already edited before prepare starts.
    prepareSpy.mockClear();
    mockFetch.mockClear();
    const preEdited = incomingMsg({
      id: 'WA-PREEDITED-1',
      body: 'edited before prepare',
      originalBody: 'original before prepare',
    });
    const receipt = projector.handleInboundMessage(sessionId, engine, preEdited);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves committed outbox rows with updated or redacted payload when webhook lookup fails during reconcilePrepared', async () => {
    const webhook = await seedWebhook(['message.received']);
    const webhookRepo = ds.getRepository(Webhook);
    const realFind = webhookRepo.find.bind(webhookRepo);
    let failWebhookLookup = false;
    jest.spyOn(webhookRepo, 'find').mockImplementation((...args) => {
      if (failWebhookLookup) return Promise.reject(new Error('transient webhook lookup failure'));
      return realFind(...args);
    });

    // (a) Mid-flight edit (v1 -> v2) when reconcilePrepared hits a webhook lookup DB error.
    // Pause dispatchPrepared so we can inspect the committed pending outbox row AND the payload passed to dispatch.
    const dispatchedEdit: Array<Record<string, unknown>> = [];
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(items => {
      for (const item of items) dispatchedEdit.push(item.baseData);
      return Promise.resolve();
    });

    const editMsg = incomingMsg({ id: 'WA-RECONCILE-ERR-EDIT', body: 'version one' });
    const realTx = ds.transaction.bind(ds);
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTx(...args);
      failWebhookLookup = true;
      projector.applyMessageEditQueued(sessionId, {
        messageId: editMsg.id,
        chatId: editMsg.chatId,
        body: 'version two',
        fromMe: false,
      } as never);
      return res;
    });

    const editReceipt = projector.handleInboundMessage(sessionId, engine, editMsg);
    await editReceipt?.settled;
    await flush();
    failWebhookLookup = false;

    const editRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${editMsg.id}_${webhook.id}` },
    });
    expect(editRow?.state).toBe('pending');
    expect(editRow?.payload).toMatchObject({ id: editMsg.id, body: 'version two', edited: true });
    expect(dispatchedEdit).toHaveLength(1);
    expect(dispatchedEdit[0]).toMatchObject({ id: editMsg.id, body: 'version two', edited: true });

    // (b) Mid-flight REST revoke (announced=false) when reconcilePrepared hits a webhook lookup DB error.
    const dispatchedRevoke: Array<Record<string, unknown>> = [];
    jest.spyOn(delivery, 'dispatchPrepared').mockImplementationOnce(items => {
      for (const item of items) dispatchedRevoke.push(item.baseData);
      return Promise.resolve();
    });

    const revokeMsg = incomingMsg({ id: 'WA-RECONCILE-ERR-REV', body: 'top secret' });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      const res = await realTx(...args);
      failWebhookLookup = true;
      void projector.recordRevoke(sessionId, revokeMsg.id, undefined, false);
      return res;
    });

    const revokeReceipt = projector.handleInboundMessage(sessionId, engine, revokeMsg);
    await revokeReceipt?.settled;
    await flush();
    failWebhookLookup = false;

    const revokeRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${revokeMsg.id}_${webhook.id}` },
    });
    expect(revokeRow?.state).toBe('pending');
    expect(revokeRow?.payload).toMatchObject({ id: revokeMsg.id, body: '', type: 'revoked' });
    expect(dispatchedRevoke).toHaveLength(1);
    expect(dispatchedRevoke[0]).toMatchObject({ id: revokeMsg.id, body: '', type: 'revoked' });
  });

  it('dispatches live webhook immediately on retriedDup after post-commit transient error (inbound and own-send echo)', async () => {
    const webhook = await seedWebhook(['message.received', 'message.sent']);
    const realTransaction = ds.transaction.bind(ds);

    // (a) Inbound message: attempt 1 commits message + outbox then throws transient post-commit error;
    //     attempt 2 sees dup (retried: true) and must STILL dispatch live immediately.
    const inbound = incomingMsg({ id: 'WA-RETRY-DUP-LIVE-IN', body: 'inbound after post-commit drop' });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    const receipt = projector.handleInboundMessage(sessionId, engine, inbound);
    await receipt?.settled;
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, inInit] = mockFetch.mock.calls[0] as [string, { body: string }];
    const inParsed = JSON.parse(inInit.body) as { event: string; data: Record<string, unknown> };
    expect(inParsed.event).toBe('message.received');
    expect(inParsed.data).toMatchObject({ id: inbound.id, body: 'inbound after post-commit drop' });
    const inRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${inbound.id}_${webhook.id}` },
    });
    expect(inRow?.state).toBe('dispatched');

    // (b) Own-send echo: attempt 1 commits message + outbox then throws transient post-commit error;
    //     attempt 2 sees dup (retried: true) and must STILL dispatch message.sent live immediately.
    mockFetch.mockClear();
    const echo = incomingMsg({
      id: 'WA-RETRY-DUP-LIVE-OUT',
      fromMe: true,
      from: '628222@c.us',
      to: '628111@c.us',
      body: 'outbound after post-commit drop',
    });
    jest.spyOn(ds, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof ds.transaction>) => {
      await realTransaction(...args);
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });

    projector.handleOwnSendEcho(sessionId, engine, echo);
    await waitFor(() => mockFetch.mock.calls.length === 1);
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, outInit] = mockFetch.mock.calls[0] as [string, { body: string }];
    const outParsed = JSON.parse(outInit.body) as { event: string; data: Record<string, unknown> };
    expect(outParsed.event).toBe('message.sent');
    expect(outParsed.data).toMatchObject({ id: echo.id, body: 'outbound after post-commit drop' });
    const outRow = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_${echo.id}_${webhook.id}` },
    });
    expect(outRow?.state).toBe('dispatched');
  });

  it('ignores cross-chat spoofed revokes against another chat pending outbox row when messages row is absent', async () => {
    const webhook = await seedWebhook(['message.received']);
    // Seed a pending outbox row belonging to Chat A with NO row in `messages` (e.g. fail-open or ephemeral).
    const chatAPayload = {
      id: 'WA-SPOOF-REV-1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628222@c.us',
      fromMe: false,
      body: 'chat A private message',
      type: 'text',
      timestamp: 1_700_000_000,
    };
    await outbox.openBatch([
      {
        webhookId: webhook.id,
        sessionId,
        event: 'message.received',
        idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}`,
        deliveryId: 'dlv-chat-a',
        payload: chatAPayload,
      },
    ]);

    // 1. Spoofed engine revoke (announced=true) from Chat B targeting Chat A's waMessageId.
    projector.handleMessageRevoked(
      sessionId,
      engine,
      {
        id: 'WA-SPOOF-REV-1',
        revokedId: 'WA-SPOOF-REV-1',
        chatId: '628999@c.us',
        from: '628999@c.us',
        timestamp: 1_700_000_005,
      } as never,
      { fromMe: false },
    );
    await flush();

    // 2. Spoofed REST/unannounced revoke (announced=false) with Chat B source.
    await projector.recordRevoke(
      sessionId,
      'WA-SPOOF-REV-1',
      { kind: 'revoke', chatId: '628999@c.us', fromMe: false },
      false,
    );
    await flush();

    // Chat A's pending outbox row MUST remain pending with original body completely untouched.
    const untouched = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}` },
    });
    expect(untouched?.state).toBe('pending');
    expect(untouched?.payload).toMatchObject({ chatId: '628111@c.us', body: 'chat A private message' });

    // 3. A legitimate revoke from Chat A's own sender DOES close Chat A's pending outbox row.
    await projector.recordRevoke(
      sessionId,
      'WA-SPOOF-REV-1',
      { kind: 'revoke', chatId: '628111@c.us', fromMe: false },
      true,
    );
    await flush();

    const closed = await ds.getRepository(WebhookOutboxEvent).findOne({
      where: { webhookId: webhook.id, idempotencyKey: `msg_${sessionId}_WA-SPOOF-REV-1_${webhook.id}` },
    });
    expect(closed?.state).toBe('dispatched');
    expect(closed?.payload).toBeNull();
  });

  describe.each([
    ['an inbound message', false, 'message.received'],
    ['an own-send echo', true, 'message.sent'],
  ] as const)('%s changed while its commit of row and outbox rows is failing', (_what, fromMe, event) => {
    describe.each([
      ['the retry commits', busy],
      ['the row is stored alone', (): Error => new Error('simulated outbox failure')],
    ])('when %s', (_then, failure) => {
      const msg = incomingMsg({
        id: 'WA-CHANGED-WHILE-FAILING-1',
        fromMe,
        body: 'first text',
        ...(fromMe ? { from: '628222@c.us', to: '628111@c.us' } : {}),
      });
      const hand = (): void => {
        if (fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
        else void projector.handleInboundMessage(sessionId, engine, msg);
      };
      /** The first commit of row and outbox rows fails, and `change` reaches the message while it does. */
      const failFirstCommit = (change: () => void): void => {
        const realOpenBatch = outbox.openBatch.bind(outbox);
        let failed = false;
        jest.spyOn(outbox, 'openBatch').mockImplementation((rows, manager) => {
          if (!manager || failed) return realOpenBatch(rows, manager);
          failed = true;
          change();
          return Promise.reject(failure());
        });
      };
      /** The text of the row each time `message:persisted` was handed it. */
      const persistedBodies = (): string[] => {
        const bodies: string[] = [];
        hookManager.register('test', 'message:persisted', ctx => {
          bodies.push((ctx.data as { message: Message }).message.body);
          return Promise.resolve({ continue: true });
        });
        return bodies;
      };
      const storedRow = (): Promise<Message | null> =>
        ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: msg.id } });

      it('writes the row cleared when the message was revoked meanwhile', async () => {
        await seedWebhook([event]);
        const bodies = persistedBodies();
        failFirstCommit(() =>
          projector.handleMessageRevoked(sessionId, engine, {
            id: msg.id,
            revokedId: msg.id,
            chatId: msg.chatId,
            from: msg.from,
            timestamp: msg.timestamp + 1,
          } as never),
        );

        hand();
        await waitFor(() => bodies.length > 0);
        await flush();

        expect(await storedRow()).toMatchObject({ type: 'revoked', body: '' });
        // The text was taken back before any row existed: no row, and so no plugin, ever held it. And the row
        // written cleared is handed over once, not again when the revoke is applied to it.
        expect(bodies).toEqual(['']);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('writes the row with the text the message was edited to meanwhile', async () => {
        await seedWebhook([event]);
        const bodies = persistedBodies();
        failFirstCommit(() =>
          projector.applyMessageEditQueued(sessionId, {
            messageId: msg.id,
            chatId: msg.chatId,
            body: 'edited text',
            fromMe,
          } as never),
        );

        hand();
        await waitFor(() => mockFetch.mock.calls.length === 1);
        await flush();

        expect(await storedRow()).toMatchObject({ body: 'edited text' });
        expect(bodies).toEqual(['edited text']);
        const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
        expect(JSON.parse(init.body)).toMatchObject({
          event,
          data: expect.objectContaining({ id: msg.id, body: 'edited text', edited: true }) as unknown,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('waits for a revoke whose sender is still being looked up before it stores the row alone', async () => {
    await seedWebhook(['message.received']);
    const bodies: string[] = [];
    hookManager.register('test', 'message:persisted', ctx => {
      bodies.push((ctx.data as { message: Message }).message.body);
      return Promise.resolve({ continue: true });
    });
    // With a lid directory, a revoke that names the chat by its lid is judged only once the pairing is read.
    const lidDirectory = {
      findPhoneForLid: jest.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return '628111';
      }),
    };
    const withLidDirectory = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      undefined,
      undefined,
      undefined,
      lidDirectory as never,
    );
    const msg = incomingMsg({ id: 'WA-REVOKED-BY-LID-1', body: 'first text' });
    // The commit of row and outbox rows fails for good, and the revoke arrives while it does.
    failOutboxInTransaction(() => {
      withLidDirectory.handleMessageRevoked(
        sessionId,
        engine,
        {
          id: msg.id,
          revokedId: msg.id,
          chatId: '199999999999@lid',
          from: '199999999999@lid',
          timestamp: msg.timestamp + 1,
        } as never,
        { fromMe: false },
      );
      return new Error('simulated outbox failure');
    });

    const receipt = withLidDirectory.handleInboundMessage(sessionId, engine, msg);
    await receipt?.settled;
    await waitFor(() => bodies.length > 0);
    await flush();

    // The pairing was still being read when the commit failed: the row alone waited for that answer.
    expect(lidDirectory.findPhoneForLid).toHaveBeenCalled();
    expect(await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: msg.id } })).toMatchObject({
      type: 'revoked',
      body: '',
    });
    expect(bodies.every(body => body === '')).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('another transaction on the connection every SQLite writer shares', () => {
    /** The real wait for that transaction to end, with `boundMs` in place of its ten seconds; every answer is kept. */
    const waitsBoundedTo = (boundMs: number, before?: (call: number) => void): boolean[] => {
      const realWait = sharedConnection.awaitNoOpenTransaction;
      const waits: boolean[] = [];
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(async dataSource => {
        before?.(waits.length + 1);
        const ended = await realWait(dataSource, boundMs);
        waits.push(ended);
        return ended;
      });
      return waits;
    };
    /** A transaction that stays open across turns of the event loop, which no code of the gateway opens. */
    const leaveOneOpen = async (): Promise<() => Promise<void>> => {
      const other = ds.createQueryRunner();
      await other.startTransaction();
      return async () => {
        await other.rollbackTransaction();
        await other.release();
      };
    };

    it.each([
      ['an inbound message', false, 'message.received'],
      ['an own-send echo', true, 'message.sent'],
    ] as const)(
      'announces %s without a row once the wait for one that never ends ran out',
      async (_what, fromMe, event) => {
        await seedWebhook([event]);
        const persisted = collectPersisted();
        const waits = waitsBoundedTo(100);
        const openBatch = jest.spyOn(outbox, 'openBatch');
        const endIt = await leaveOneOpen();
        const msg = incomingMsg({ id: 'WA-NEVER-ENDS-1', fromMe });

        if (fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
        else void projector.handleInboundMessage(sessionId, engine, msg);
        await waitFor(() => mockFetch.mock.calls.length === 1);
        await flush();

        // Two waits, the read before the hooks and the insert, and no further attempt: nothing would end a third.
        expect(waits).toEqual([false, false]);
        expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(0);
        expect(persisted).toEqual([]);
        expect(fromMe ? eventsGateway.emitMessageSent : eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        // The delivery recorded itself on the shared connection, so inside the other transaction: its outbox row is
        // only as lasting as that transaction.
        expect(inTransaction(openBatch)).toHaveLength(0);
        expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(1);
        await endIt();
        expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
      },
    );

    it('stores and announces nothing for an engine retired while the insert waits for one', async () => {
      await seedWebhook(['message.received']);
      const persisted = collectPersisted();
      // The second wait is the insert's.
      const waits = waitsBoundedTo(100, call => {
        if (call === 2) engines.delete(sessionId);
      });
      const endIt = await leaveOneOpen();

      const receipt = projector.handleInboundMessage(sessionId, engine, incomingMsg({ id: 'WA-RETIRED-WAITING-1' }));
      await receipt?.settled;
      await flush();
      await endIt();

      expect(waits).toEqual([false, false]);
      expect(await ds.getRepository(Message).count({ where: { sessionId } })).toBe(0);
      expect(await ds.getRepository(WebhookOutboxEvent).count({ where: { sessionId } })).toBe(0);
      expect(persisted).toEqual([]);
      expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // The holders that scale with the data. Each begins and ends its transaction within one turn of the event loop,
    // so no wait ever finds it open: a message handed over meanwhile is stored once the holder is done. One that
    // gave the loop a turn while holding its transaction would be met by the insert's bound instead, and by the
    // case above.
    const dataImport = (): InfraDataService => {
      const sessions = { getActiveSessionIds: () => [sessionId], forgetSession: jest.fn() };
      const config = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
      return new InfraDataService(config as never, ds, undefined, sessions as never);
    };
    /** One row in each table the import restores that the messages stored so far have not written to. */
    const fillEveryImportedTable = async (): Promise<void> => {
      const webhook = await ds.getRepository(Webhook).findOneByOrFail({ sessionId });
      const chatId = '628111@s.whatsapp.net';
      const plugin = { pluginId: 'chatwoot', instanceId: 'one' };
      const rows: Array<[new () => object, object]> = [
        [
          MessageBatch,
          { batchId: 'BATCH-1', sessionId, status: BatchStatus.COMPLETED, messages: [{ chatId, type: 'text' }] },
        ],
        [Template, { sessionId, name: 'greeting', body: 'Hi' }],
        [BaileysStoredMessage, { id: 'stored-1', sessionId, waMessageId: 'WA-STORED-1', serializedMessage: '{}' }],
        [LidMapping, { lid: '199999999999', phone: '628111', sessionId, isReported: true }],
        [ChatState, { sessionId, chatId, pinned: true }],
        [PluginInstance, { ...plugin, id: 'chatwoot:one', sessionScope: sessionId, secret: 's', verifyToken: 'v' }],
        [ConversationMapping, { ...plugin, sessionId, chatId, providerConversationId: 'conversation-1' }],
        [
          IngressEvent,
          { ...plugin, id: 'ingress-1', providerDeliveryId: 'delivery-1', route: 'chatwoot/one', sessionId },
        ],
        [
          WebhookDeliveryFailure,
          {
            webhookId: webhook.id,
            sessionId,
            event: 'message.received',
            url: webhook.url,
            idempotencyKey: 'failed-1',
            deliveryId: 'failed-delivery-1',
            attempts: 1,
            lastError: 'Bad Gateway',
          },
        ],
        [
          IntegrationDeliveryFailure,
          { ...plugin, direction: 'outbound', sessionId, attempts: 1, lastError: 'refused' },
        ],
        [
          StatusUpdate,
          {
            sessionId,
            contactJid: '628111@c.us',
            waStatusId: 'STATUS-1',
            type: 'text',
            postedAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          },
        ],
        [AutomationRule, { sessionId, name: 'greeting', replyText: 'Hi' }],
      ];
      for (const [entity, row] of rows) await ds.getRepository(entity).save(ds.getRepository(entity).create(row));
    };
    // The archive the import case restores: an export of this database with a row in every table.
    let archive: InfraExportDataResult['tables'];
    /** An export read to its end, whether the service answers with the document or with pieces of its JSON text. */
    const readExport = async (
      exported: InfraExportDataResult | Promise<InfraExportDataResult> | AsyncIterable<string>,
    ): Promise<InfraExportDataResult> => {
      const value = await exported;
      if (!(Symbol.asyncIterator in value)) return value;
      let text = '';
      for await (const piece of value) text += piece;
      return JSON.parse(text) as InfraExportDataResult;
    };

    describe.each([
      [
        'the data import',
        'DELETE FROM webhooks',
        async (): Promise<void> => {
          await fillEveryImportedTable();
          archive = (await readExport(dataImport().exportData())).tables;
          // A table the archive left empty would have its branch of the import skipped, and go unwatched.
          const rowsPerTable = TABLE_IMPORTERS.map(importer => [importer.key, archive[importer.key]?.length ?? 0]);
          expect(rowsPerTable.filter(([, rows]) => rows === 0)).toEqual([]);
        },
        async (): Promise<void> => {
          const restored = await dataImport().importData({ tables: archive });
          expect(restored).toMatchObject({ imported: true, warnings: [] });
          expect(TABLE_IMPORTERS.filter(importer => !restored.counts[importer.key])).toEqual([]);
        },
      ],
      [
        'the word index build of the search',
        'BEGIN IMMEDIATE',
        (): Promise<void> => Promise.resolve(),
        async (): Promise<void> => {
          const provider = new BuiltInFtsProvider(ds);
          await provider.onModuleInit();
          await provider.onModuleDestroy();
        },
      ],
      [
        'the contains index build of the search',
        'BEGIN IMMEDIATE',
        (): Promise<void> => Promise.resolve(),
        async (): Promise<void> => {
          const config = { get: (key: string) => (key === 'search.containsEnabled' ? true : undefined) };
          const provider = new BuiltInFtsProvider(ds, config as never);
          await provider.buildContainsIndex();
          await provider.onModuleDestroy();
        },
      ],
    ] as const)('%s', (_holder, firstStatement, prepare, run) => {
      it('never leaves its transaction open for a wait to find, and the message handed over meanwhile is stored', async () => {
        jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
        await seedWebhook(['message.received']);
        for (const id of ['WA-EARLIER-1', 'WA-EARLIER-2']) {
          await projector.handleInboundMessage(sessionId, engine, incomingMsg({ id }))?.settled;
        }
        await waitFor(() => mockFetch.mock.calls.length === 2);
        await waitFor(outboxRowDispatched);
        await prepare();
        mockFetch.mockClear();
        const persisted = collectPersisted();
        // No patience at all: a transaction a wait finds open counts as one that outlasted the bound.
        const waits = waitsBoundedTo(0);
        const openBatch = jest.spyOn(outbox, 'openBatch');
        const msg = incomingMsg({ id: 'WA-DURING-A-HOLDER-1', body: 'arrived meanwhile' });
        // Handed over at the holder's first statement inside its transaction.
        let receipt: ReturnType<MessageProjector['handleInboundMessage']>;
        const runner = ds.createQueryRunner();
        const realQuery = runner.query.bind(runner) as (sql: string, ...rest: unknown[]) => Promise<unknown>;
        let wasOpen: boolean | undefined;
        jest.spyOn(runner, 'query').mockImplementation(async (sql: string, ...rest: unknown[]) => {
          const result = await realQuery(sql, ...rest);
          if (sql === firstStatement && wasOpen === undefined) {
            wasOpen = (ds.driver as unknown as { databaseConnection: { inTransaction: boolean } }).databaseConnection
              .inTransaction;
            receipt = projector.handleInboundMessage(sessionId, engine, msg);
          }
          return result;
        });

        await run();
        await receipt?.settled;
        await waitFor(() => mockFetch.mock.calls.length === 1);
        await waitFor(async () => (await ds.getRepository(WebhookOutboxEvent).countBy({ state: 'pending' })) === 0);
        await flush();

        expect(wasOpen).toBe(true);
        expect(waits.length).toBeGreaterThanOrEqual(2);
        expect(waits.every(Boolean)).toBe(true);
        const stored = await ds.getRepository(Message).findOne({ where: { sessionId, waMessageId: msg.id } });
        expect(stored?.body).toBe('arrived meanwhile');
        expect(persisted.map(row => row.id)).toEqual([stored?.id]);
        // Its outbox row was written in the transaction of its own row.
        expect(inTransaction(openBatch)).toHaveLength(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('a message hook result that leaves fields out', () => {
    // A redaction as a plugin typically writes it: the id and chat the result needs, and the new text.
    const redact = (event: 'message:received' | 'message:sent', extra: Record<string, unknown> = {}): void => {
      hookManager.register('redactor', event, ctx => {
        const { id, chatId } = ctx.data as IncomingMessage;
        return Promise.resolve({ continue: true, data: { id, chatId, body: '[redacted]', ...extra } });
      });
    };
    const delivered = (): Record<string, unknown> => {
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      return (JSON.parse(init.body) as { data: Record<string, unknown> }).data;
    };
    const storedRow = (waMessageId: string): Promise<Message | null> =>
      ds.getRepository(Message).findOne({ where: { sessionId, waMessageId } });

    it('stores and dispatches it with the identity the engine reported', async () => {
      await seedWebhook(['message.received']);
      redact('message:received');
      const msg = incomingMsg({
        id: 'WA-HOOK-PARTIAL-1',
        chatId: '120363000000000001@g.us',
        from: '120363000000000001@g.us',
        author: '628333@c.us',
        body: 'secret text',
      });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const identity = { from: msg.from, to: msg.to, author: msg.author, type: 'text', timestamp: msg.timestamp };
      expect(await storedRow(msg.id)).toMatchObject({
        ...identity,
        body: '[redacted]',
        direction: MessageDirection.INCOMING,
      });
      const payload = { ...identity, id: msg.id, chatId: msg.chatId, body: '[redacted]', fromMe: false };
      expect(delivered()).toMatchObject(payload);
      expect(eventsGateway.emitMessage).toHaveBeenCalledWith(sessionId, expect.objectContaining(payload));
    });

    it('does not give back the media and contact it dropped', async () => {
      await seedWebhook(['message.received']);
      redact('message:received');
      const msg = incomingMsg({
        id: 'WA-HOOK-PARTIAL-MEDIA-1',
        type: 'image',
        body: 'secret caption',
        media: { mimetype: 'image/png', data: 'aGVsbG8=' },
        contact: { pushName: 'Sender Name' },
      });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({ type: 'image', body: '[redacted]', from: msg.from });
      expect(stored?.metadata).toBeNull();
      expect(stored?.chatName).toBeNull();
      const [, emitted] = eventsGateway.emitMessage.mock.calls[0] as [string, Record<string, unknown>];
      for (const announced of [delivered(), emitted]) {
        expect(announced).toMatchObject({ id: msg.id, type: 'image', body: '[redacted]' });
        expect(announced).not.toHaveProperty('media');
        expect(announced).not.toHaveProperty('contact');
      }
    });

    it('keeps an identity field the handler set itself', async () => {
      await seedWebhook(['message.received']);
      redact('message:received', { from: '628999@c.us' });
      const msg = incomingMsg({ id: 'WA-HOOK-PARTIAL-FROM-1', body: 'secret text' });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      expect(await storedRow(msg.id)).toMatchObject({ from: '628999@c.us', to: msg.to, body: '[redacted]' });
      expect(delivered()).toMatchObject({ from: '628999@c.us', to: msg.to, body: '[redacted]' });
    });

    it('stores and dispatches an own-send echo the same way', async () => {
      await seedWebhook(['message.sent']);
      redact('message:sent');
      const echo = incomingMsg({
        id: 'WA-HOOK-PARTIAL-ECHO-1',
        fromMe: true,
        from: '628222@c.us',
        to: '628111@c.us',
        body: 'secret text',
      });

      projector.handleOwnSendEcho(sessionId, engine, echo);
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const identity = { from: echo.from, to: echo.to, type: 'text', timestamp: echo.timestamp };
      expect(await storedRow(echo.id)).toMatchObject({
        ...identity,
        body: '[redacted]',
        direction: MessageDirection.OUTGOING,
      });
      expect(delivered()).toMatchObject({ ...identity, id: echo.id, body: '[redacted]', fromMe: true });
    });

    it('still keeps an own-send echo of a disappearing chat out of history when their storage is off', async () => {
      jest.replaceProperty(process, 'env', { ...process.env, STORE_EPHEMERAL_MESSAGES: 'false' });
      await seedWebhook(['message.sent']);
      redact('message:sent');
      const echo = incomingMsg({
        id: 'WA-HOOK-PARTIAL-EPHEMERAL-1',
        fromMe: true,
        from: '628222@c.us',
        to: '628111@c.us',
        body: 'secret text',
        ephemeralDuration: 86_400,
      });

      projector.handleOwnSendEcho(sessionId, engine, echo);
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await flush();

      expect(await storedRow(echo.id)).toBeNull();
      // The send is still announced; only its storage is opted out of.
      expect(delivered()).toMatchObject({ id: echo.id, body: '[redacted]', ephemeralDuration: 86_400 });
    });

    it('lets a webhook filter on isGroup select the webhooks it selects for the full message', async () => {
      const isGroup = (value: boolean): Partial<Webhook> => ({
        url: `https://receiver.example/group-${value}`,
        filters: { conditions: [{ field: 'isGroup', operator: 'is', value }] },
      });
      const groups = await seedWebhook(['message.received'], isGroup(true));
      await seedWebhook(['message.received'], isGroup(false));
      const selectedFor = async (waMessageId: string): Promise<string[]> => {
        mockFetch.mockClear();
        const msg = incomingMsg({
          id: waMessageId,
          chatId: '120363000000000001@g.us',
          from: '120363000000000001@g.us',
          author: '199999999999@lid',
          isGroup: true,
          kind: 'group',
          isLidSender: true,
        });
        const receipt = projector.handleInboundMessage(sessionId, engine, msg);
        await receipt?.settled;
        await waitFor(() => mockFetch.mock.calls.length === 1);
        await flush();
        return mockFetch.mock.calls.map(([url]) => url as string);
      };

      const withoutHook = await selectedFor('WA-HOOK-FILTER-1');
      redact('message:received');
      const withHook = await selectedFor('WA-HOOK-FILTER-2');

      expect(withoutHook).toEqual([groups.url]);
      expect(withHook).toEqual(withoutHook);
      expect(delivered()).toMatchObject({ body: '[redacted]', isGroup: true, kind: 'group', isLidSender: true });
    });

    it('takes an identity field returned as null or undefined as left out', async () => {
      await seedWebhook(['message.received']);
      redact('message:received', { from: null, to: undefined, type: null, timestamp: undefined, fromMe: null });
      const msg = incomingMsg({ id: 'WA-HOOK-NULL-1', body: 'secret text' });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const identity = { from: msg.from, to: msg.to, type: 'text', timestamp: msg.timestamp };
      expect(await storedRow(msg.id)).toMatchObject({
        ...identity,
        body: '[redacted]',
        direction: MessageDirection.INCOMING,
      });
      expect(delivered()).toMatchObject({ ...identity, body: '[redacted]', fromMe: false });
    });

    it('restores what a handler removed from the message it was handed, but not the content', async () => {
      await seedWebhook(['message.received']);
      // An in-process handler is handed the object the gateway goes on with, and may change it in place.
      hookManager.register('in-place', 'message:received', ctx => {
        const handed = ctx.data as Record<string, unknown>;
        delete handed.from;
        handed.to = null;
        delete handed.media;
        handed.body = '[redacted]';
        return Promise.resolve({ continue: true });
      });
      const msg = incomingMsg({
        id: 'WA-HOOK-IN-PLACE-1',
        type: 'image',
        body: 'secret caption',
        media: { mimetype: 'image/png', data: 'aGVsbG8=' },
      });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const stored = await storedRow(msg.id);
      expect(stored).toMatchObject({ from: msg.from, to: msg.to, type: 'image', body: '[redacted]' });
      expect(stored?.metadata).toBeNull();
      expect(delivered()).toMatchObject({ from: msg.from, to: msg.to, body: '[redacted]' });
      expect(delivered()).not.toHaveProperty('media');
    });

    it('keeps a message under its id and chat when a handler removed them from what it was handed', async () => {
      await seedWebhook(['message.received']);
      hookManager.register('in-place', 'message:received', ctx => {
        const handed = ctx.data as Record<string, unknown>;
        delete handed.id;
        delete handed.chatId;
        return Promise.resolve({ continue: true });
      });
      const msg = incomingMsg({ id: 'WA-HOOK-IN-PLACE-2', body: 'still here' });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      expect(await storedRow(msg.id)).toMatchObject({ chatId: msg.chatId, from: msg.from, body: 'still here' });
      expect(delivered()).toMatchObject({ id: msg.id, chatId: msg.chatId, body: 'still here' });
    });

    it.each([
      ['message:received', 'message.received'],
      ['message:sent', 'message.sent'],
    ] as const)('takes a value a %s handler returned in another type as left out', async (hook, event) => {
      await seedWebhook([event]);
      redact(hook, {
        from: { jid: '628999@c.us' },
        to: 628999,
        fromMe: 'yes',
        timestamp: 'now',
        type: ['text'],
        author: {},
        isGroup: 'no',
      });
      const group = '120363000000000001@g.us';
      const msg = incomingMsg({
        id: `WA-HOOK-TYPES-${event}`,
        // The inbound one is a group message, so the engine reports an author and a kind of chat; the echo has neither.
        ...(hook === 'message:sent'
          ? { fromMe: true, from: '628222@c.us', to: '628111@c.us' }
          : { chatId: group, from: group, author: '628333@c.us', isGroup: true }),
      });

      if (msg.fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
      else await projector.handleInboundMessage(sessionId, engine, msg)?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const identity = { from: msg.from, to: msg.to, type: 'text', timestamp: msg.timestamp };
      expect(await storedRow(msg.id)).toMatchObject({
        ...identity,
        author: msg.author ?? null,
        body: '[redacted]',
        direction: msg.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      });
      expect(delivered()).toMatchObject({ ...identity, fromMe: msg.fromMe, body: '[redacted]' });
      // The engine's value where it reported one, and no value at all where it did not.
      if (msg.author) expect(delivered()).toMatchObject({ author: msg.author, isGroup: true });
      else for (const field of ['author', 'isGroup']) expect(delivered()).not.toHaveProperty(field);
    });

    it('keeps a value a handler set to false, zero or an empty string', async () => {
      await seedWebhook(['message.received']);
      redact('message:received', { isGroup: false, ephemeralDuration: 0, author: '' });
      const msg = incomingMsg({
        id: 'WA-HOOK-FALSY-1',
        chatId: '120363000000000001@g.us',
        from: '120363000000000001@g.us',
        author: '628333@c.us',
        isGroup: true,
        ephemeralDuration: 86_400,
      });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      // Only a value that is missing or null gives way to the engine's.
      expect(delivered()).toMatchObject({ isGroup: false, ephemeralDuration: 0, author: '', from: msg.from });
      expect(await storedRow(msg.id)).toMatchObject({ author: '', from: msg.from, body: '[redacted]' });
    });

    it('restores what a message:sent handler removed from the echo it was handed', async () => {
      await seedWebhook(['message.sent']);
      hookManager.register('in-place', 'message:sent', ctx => {
        const handed = ctx.data as Record<string, unknown>;
        delete handed.from;
        handed.to = null;
        delete handed.timestamp;
        return Promise.resolve({ continue: true });
      });
      const echo = incomingMsg({
        id: 'WA-HOOK-IN-PLACE-ECHO-1',
        fromMe: true,
        from: '628222@c.us',
        to: '628111@c.us',
        body: 'sent from the phone',
      });

      projector.handleOwnSendEcho(sessionId, engine, echo);
      await waitFor(() => mockFetch.mock.calls.length === 1);

      const identity = { from: echo.from, to: echo.to, timestamp: echo.timestamp };
      expect(await storedRow(echo.id)).toMatchObject({
        ...identity,
        body: 'sent from the phone',
        direction: MessageDirection.OUTGOING,
      });
      expect(delivered()).toMatchObject({ ...identity, id: echo.id, fromMe: true });
    });

    it('classifies a message a handler moved to another chat by the chat it ends up in', async () => {
      const group = '120363000000000001@g.us';
      const groups = await seedWebhook(['message.received'], {
        url: 'https://receiver.example/groups',
        filters: { conditions: [{ field: 'isGroup', operator: 'is', value: true }] },
      });
      await seedWebhook(['message.received'], {
        url: 'https://receiver.example/direct',
        filters: { conditions: [{ field: 'kind', operator: 'is', value: ['individual'] }] },
      });
      redact('message:received', { chatId: group });
      const msg = incomingMsg({ id: 'WA-HOOK-MOVED-1', isGroup: false, kind: 'individual' });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);
      await flush();

      // What the engine said of the chat it reported does not describe the chat the row is filed under.
      expect(await storedRow(msg.id)).toMatchObject({ chatId: group, from: msg.from, body: '[redacted]' });
      expect(mockFetch.mock.calls.map(([url]) => url as string)).toEqual([groups.url]);
      expect(delivered()).toMatchObject({ chatId: group, isGroup: true, kind: 'group', from: msg.from });
    });

    it('keeps the classification a handler set for the chat it moved a message to', async () => {
      await seedWebhook(['message.received']);
      redact('message:received', { chatId: '120363000000000001@g.us', isGroup: false, kind: 'unknown' });
      const msg = incomingMsg({ id: 'WA-HOOK-MOVED-2', isGroup: false, kind: 'individual' });

      const receipt = projector.handleInboundMessage(sessionId, engine, msg);
      await receipt?.settled;
      await waitFor(() => mockFetch.mock.calls.length === 1);

      expect(delivered()).toMatchObject({ chatId: '120363000000000001@g.us', isGroup: false, kind: 'unknown' });
    });

    it.each([
      ['message:received', 'message.received'],
      ['message:sent', 'message.sent'],
    ] as const)(
      'keeps a redaction when a later %s handler damages the id and chat of what it was handed',
      async (hook, event) => {
        await seedWebhook([event]);
        redact(hook);
        // Runs after the redaction, on the very object that handler returned.
        const damage = jest.fn((ctx: { data: unknown }) => {
          const handed = ctx.data as Record<string, unknown>;
          delete handed.id;
          handed.chatId = 42;
          return Promise.resolve({ continue: true });
        });
        hookManager.register('in-place', hook, damage, 200);
        const msg = incomingMsg({
          id: `WA-HOOK-REDACTED-${event}`,
          fromMe: hook === 'message:sent',
          type: 'image',
          body: 'secret caption',
          media: { mimetype: 'image/png', data: 'aGVsbG8=' },
        });

        if (msg.fromMe) projector.handleOwnSendEcho(sessionId, engine, msg);
        else await projector.handleInboundMessage(sessionId, engine, msg)?.settled;
        await waitFor(() => mockFetch.mock.calls.length === 1);
        await flush();

        expect(damage).toHaveBeenCalledTimes(1);
        const stored = await storedRow(msg.id);
        expect(stored).toMatchObject({ chatId: msg.chatId, from: msg.from, type: 'image', body: '[redacted]' });
        expect(delivered()).toMatchObject({ id: msg.id, chatId: msg.chatId, body: '[redacted]' });
        const emit = msg.fromMe ? eventsGateway.emitMessageSent : eventsGateway.emitMessage;
        // Neither the text nor the media the first handler took out comes back anywhere.
        for (const seen of [stored, delivered(), emit.mock.calls[0]]) {
          expect(JSON.stringify(seen)).not.toContain('secret caption');
          expect(JSON.stringify(seen)).not.toContain('aGVsbG8=');
        }
      },
    );
  });
});
