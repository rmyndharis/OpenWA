jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

// A retry backoff (the one wait that passes a signal) ends at once unless a test holds it; jest's fake timers do not
// cover node:timers/promises. Every other wait keeps its real timer.
jest.mock('node:timers/promises', () => {
  const actual = jest.requireActual<typeof import('node:timers/promises')>('node:timers/promises');
  return {
    ...actual,
    setTimeout: jest.fn((ms?: number, value?: unknown, options?: { signal?: AbortSignal }) =>
      options?.signal ? Promise.resolve(value) : actual.setTimeout(ms, value, options),
    ),
  };
});

import { setTimeout as sleep } from 'node:timers/promises';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
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
import { WebhookRedriveService } from '../webhook/webhook-redrive.service';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';
const OTHER_CHAT = '628999@c.us';

/**
 * A revoke, a delete through the API or an edit of a stored message reaches every copy of the message the gateway
 * still holds for a webhook: a pending or queued outbox row, and the event data a failed delivery keeps for a redrive.
 */
describe('Changes to a stored message and the copies its deliveries hold (SQLite)', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let ds: DataSource;
  let outbox: WebhookOutboxService;
  let delivery: WebhookDeliveryService;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let redrive: WebhookRedriveService;
  let projector: MessageProjector;
  let sessionId: string;
  let webhook: Webhook;
  let retentionHours: number;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    retentionHours = 24;

    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    sessionId = (
      await ds
        .getRepository(Session)
        .save(ds.getRepository(Session).create({ name: 'changes', status: SessionStatus.READY, config: {} }))
    ).id;

    const configService = {
      get: <T>(key: string, defaultValue?: T): T => {
        const values: Record<string, unknown> = {
          'queue.enabled': false,
          'webhook.dispatchConcurrency': 8,
          'webhook.dispatchMaxQueued': 100,
          'webhook.timeout': 5000,
          'webhook.retryDelay': 50,
          'webhook.shutdownDrainMs': 1000,
          'webhook.failurePayloadRetentionHours': retentionHours,
          'webhook.maxPayloadBytes': 1024 * 1024,
          'webhook.mediaInlineMaxBytes': 1024 * 1024,
        };
        return (key in values ? values[key] : defaultValue) as T;
      },
    } as unknown as ConfigService;
    const hookManager = new HookManager();
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
    redrive = new WebhookRedriveService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      delivery,
      configService,
    );
    const engines = new EngineRegistry();
    engines.set(sessionId, {} as IWhatsAppEngine);
    projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      {
        emitMessage: jest.fn(),
        emitMessageSent: jest.fn(),
        emitMessageRevoked: jest.fn(),
        emitMessageReaction: jest.fn(),
        emitMessageAck: jest.fn(),
        emitMessageEdited: jest.fn(),
      } as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
    );
    webhook = await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events: ['message.received'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
      }),
    );
  });

  afterEach(async () => {
    await redrive.onModuleDestroy();
    await delivery.onModuleDestroy();
    await reconciler.onModuleDestroy();
    await outbox.onModuleDestroy();
    await ds.destroy();
    jest.restoreAllMocks();
  });

  const keyOf = (id: string): string => `msg_${sessionId}_${id}_${webhook.id}`;
  const payloadOf = (id: string, chatId = CHAT): Record<string, unknown> => ({
    id,
    chatId,
    from: chatId,
    to: '628222@c.us',
    fromMe: false,
    type: 'text',
    body: 'first text',
    timestamp: 1_700_000_000,
  });

  const storeRow = (id: string, chatId = CHAT): Promise<unknown> =>
    ds.getRepository(Message).insert({
      sessionId,
      waMessageId: id,
      chatId,
      from: chatId,
      to: '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1_700_000_000,
    });

  const openDelivery = async (id: string, state: 'pending' | 'queued', chatId = CHAT): Promise<void> => {
    await outbox.open({
      webhookId: webhook.id,
      sessionId,
      event: 'message.received',
      idempotencyKey: keyOf(id),
      deliveryId: `delivery-${id}`,
      payload: payloadOf(id, chatId),
    });
    if (state === 'queued') await outbox.markQueued(webhook.id, keyOf(id), `delivery-${id}`);
  };

  /** A delivery that spent its retries: its terminal failure row keeps the event data for a redrive. */
  const keepFailedCopy = (id: string, chatId = CHAT): Promise<unknown> =>
    ds.getRepository(WebhookDeliveryFailure).insert({
      webhookId: webhook.id,
      sessionId,
      event: 'message.received',
      url: webhook.url,
      idempotencyKey: keyOf(id),
      deliveryId: `delivery-${id}`,
      attempts: 1,
      lastError: 'HTTP 500: down',
      payload: payloadOf(id, chatId),
    } as never);

  const delivered = (id: string): Promise<WebhookOutboxEvent | null> =>
    ds.getRepository(WebhookOutboxEvent).findOne({ where: { idempotencyKey: keyOf(id) } });

  const keptCopy = async (id: string): Promise<Record<string, unknown> | null> =>
    (
      await ds
        .getRepository(WebhookDeliveryFailure)
        .createQueryBuilder('f')
        .addSelect('f.payload')
        .where('f.idempotencyKey = :key', { key: keyOf(id) })
        .getOneOrFail()
    ).payload;

  const sweep = (): ReturnType<WebhookReconcilerService['sweep']> =>
    reconciler.sweep({ intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 }, new Date(Date.now() + 1000));

  const postedBodies = (): unknown[] =>
    mockFetch.mock.calls.map(([, init]) => (JSON.parse((init as { body: string }).body) as { data: unknown }).data);

  const engineRevoke = (id: string): Promise<void> =>
    projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
  const apiDelete = (id: string): Promise<void> =>
    projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT });

  describe('a delivery already handed to the queue', () => {
    it('is closed when the engine revokes the message, and the sweep replays nothing', async () => {
      await storeRow('M-1');
      await openDelivery('M-1', 'queued');

      await engineRevoke('M-1');

      expect(await delivered('M-1')).toMatchObject({ state: 'dispatched', payload: null });
      await sweep();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps its queue ownership and carries the placeholder after a delete through the API', async () => {
      await storeRow('M-2');
      await openDelivery('M-2', 'queued');

      await apiDelete('M-2');

      const row = await delivered('M-2');
      expect(row?.state).toBe('queued');
      expect(row?.payload).toMatchObject({ id: 'M-2', body: '', type: 'revoked' });
      // No queue is wired here, so the sweep reads the job as lost and replays the row as the change left it.
      await sweep();
      expect(postedBodies()).toEqual([expect.objectContaining({ body: '', type: 'revoked' })]);
    });
  });

  describe('the event data a failed delivery keeps for a redrive', () => {
    // A redrive starts from the kept copy: the outbox row of its delivery was closed when the failure was recorded,
    // which says nothing of a change, and the copy, kept current by every change, stays for the next redrive.
    it('stays on the row when a redrive of it fails again', async () => {
      await storeRow('M-18');
      await openDelivery('M-18', 'pending');
      await outbox.close(webhook.id, keyOf('M-18'), 'dispatched');
      await keepFailedCopy('M-18');
      mockFetch.mockResolvedValue(new Response('down', { status: 500 }));

      expect((await redrive.redrive({ sessionId })).failed).toBe(1);

      expect(await keptCopy('M-18')).toMatchObject({ id: 'M-18', body: 'first text' });
    });

    it('is dropped when the engine revokes the message, so a redrive sends nothing', async () => {
      await storeRow('M-3');
      await keepFailedCopy('M-3');

      await engineRevoke('M-3');

      expect(await keptCopy('M-3')).toBeNull();
      expect((await redrive.redrive({ sessionId })).redriven).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('becomes the placeholder after a delete through the API, which a redrive sends', async () => {
      await storeRow('M-4');
      await keepFailedCopy('M-4');

      await apiDelete('M-4');

      expect(await keptCopy('M-4')).toMatchObject({ id: 'M-4', body: '', type: 'revoked' });
      expect((await redrive.redrive({ sessionId })).redriven).toBe(1);
      expect(postedBodies()).toEqual([expect.objectContaining({ body: '', type: 'revoked' })]);
    });
  });

  it("leaves the queued delivery and the kept copy of another chat's message under the same id alone", async () => {
    await openDelivery('M-5', 'queued', OTHER_CHAT);
    await keepFailedCopy('M-5', OTHER_CHAT);

    await engineRevoke('M-5');
    await apiDelete('M-5');

    expect(await delivered('M-5')).toMatchObject({ state: 'queued', payload: { body: 'first text' } });
    expect(await keptCopy('M-5')).toMatchObject({ body: 'first text' });
  });

  describe('an edit of a stored message', () => {
    const engineEdit = (id: string, chatId = CHAT): void =>
      projector.applyMessageEditQueued(sessionId, {
        messageId: id,
        chatId,
        body: 'edited text',
        fromMe: false,
      } as never);
    const restEdit = (id: string): Promise<void> =>
      projector.recordOutboundMessageEdit(sessionId, id, 'edited text', { kind: 'edit', chatId: CHAT, fromMe: false });
    const bodyOf = async (id: string): Promise<string | null | undefined> =>
      (await ds.getRepository(Message).findOneBy({ sessionId, waMessageId: id }))?.body;
    const until = async (done: () => Promise<boolean>): Promise<void> => {
      for (let turn = 0; turn < 200 && !(await done()); turn++) await new Promise(resolve => setImmediate(resolve));
    };

    it('rewrites its pending delivery, which the sweep then delivers edited', async () => {
      await storeRow('M-7');
      await openDelivery('M-7', 'pending');

      engineEdit('M-7');
      await until(async () => (await delivered('M-7'))?.payload?.body === 'edited text');

      expect(await bodyOf('M-7')).toBe('edited text');
      expect((await delivered('M-7'))?.payload).toMatchObject({ body: 'edited text', edited: true });
      await sweep();
      expect(postedBodies()).toEqual([expect.objectContaining({ body: 'edited text', edited: true })]);
    });

    it('rewrites a delivery handed to the queue and the copy a failed delivery keeps, on an edit through the API', async () => {
      await storeRow('M-8');
      await openDelivery('M-8', 'queued');
      await keepFailedCopy('M-8');

      await restEdit('M-8');

      expect(await delivered('M-8')).toMatchObject({ state: 'queued', payload: { body: 'edited text', edited: true } });
      expect(await keptCopy('M-8')).toMatchObject({ body: 'edited text', edited: true });
      await redrive.redrive({ sessionId });
      expect(postedBodies()).toEqual([expect.objectContaining({ body: 'edited text' })]);
    });

    it('rewrites the delivery of a message a handler filed under another chat, which carries the filed chat', async () => {
      await storeRow('M-9', OTHER_CHAT);
      await ds
        .getRepository(Message)
        .update(
          { sessionId, waMessageId: 'M-9' },
          { engineRef: { chatId: CHAT, direction: MessageDirection.INCOMING, author: null } },
        );
      await openDelivery('M-9', 'pending', OTHER_CHAT);

      await restEdit('M-9');

      expect(await bodyOf('M-9')).toBe('edited text');
      expect((await delivered('M-9'))?.payload).toMatchObject({ chatId: OTHER_CHAT, body: 'edited text' });
    });

    it("leaves a delivery carrying another chat's message under the same id as it was", async () => {
      await storeRow('M-10');
      await openDelivery('M-10', 'pending', OTHER_CHAT);

      await restEdit('M-10');

      expect(await bodyOf('M-10')).toBe('edited text');
      expect((await delivered('M-10'))?.payload).toMatchObject({ body: 'first text' });
    });

    it('leaves the delivery alone when the edit repeats the stored text', async () => {
      await storeRow('M-11');
      await openDelivery('M-11', 'pending');

      await projector.recordOutboundMessageEdit(sessionId, 'M-11', 'first text', {
        kind: 'edit',
        chatId: CHAT,
        fromMe: false,
      });

      expect((await delivered('M-11'))?.payload).not.toHaveProperty('edited');
    });
  });

  describe('a change that reaches a message while its delivery waits to retry', () => {
    const changes = {
      'an engine revoke': engineRevoke,
      'a delete through the API': apiDelete,
      'an edit': (id: string) =>
        projector.recordOutboundMessageEdit(sessionId, id, 'edited text', {
          kind: 'edit',
          chatId: CHAT,
          fromMe: false,
        }),
    } as const;
    const expectations = {
      'an engine revoke': { retries: [], failureRows: 0, redriven: [] },
      'a delete through the API': { retries: ['', ''], failureRows: 1, redriven: [''] },
      'an edit': { retries: ['edited text', 'edited text'], failureRows: 1, redriven: ['edited text'] },
    } as const;

    it.each(Object.keys(changes) as Array<keyof typeof changes>)(
      'sends the later attempts and the redrive as %s left it',
      async change => {
        await ds.getRepository(Webhook).update(webhook.id, { retryCount: 3 });
        await storeRow('M-12');
        mockFetch.mockResolvedValue(new Response('down', { status: 500 }));
        let endBackoff: (() => void) | undefined;
        (sleep as unknown as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => (endBackoff = r)));

        const dispatched = webhookService.dispatch(sessionId, 'message.received', payloadOf('M-12'));
        for (let turn = 0; turn < 200 && !endBackoff; turn++) await new Promise(r => setImmediate(r));
        await changes[change]('M-12');
        endBackoff!();
        await dispatched;

        const bodies = (): unknown[] => postedBodies().map(data => (data as { body: string }).body);
        expect(bodies()).toEqual(['first text', ...expectations[change].retries]);
        expect(await ds.getRepository(WebhookDeliveryFailure).count()).toBe(expectations[change].failureRows);

        mockFetch.mockReset();
        mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
        await redrive.redrive({ sessionId });
        expect(bodies()).toEqual(expectations[change].redriven);
      },
    );
  });

  describe('a revoke the database stops answering after, once the row is cleared', () => {
    // Every statement fails from the moment the revoke's UPDATE of the message lands until the test lifts it.
    let down = false;
    beforeEach(() => {
      down = false;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
      const realQuery = BetterSqlite3QueryRunner.prototype.query;
      jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
        this: BetterSqlite3QueryRunner,
        ...args: Parameters<BetterSqlite3QueryRunner['query']>
      ) {
        if (down) return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
        const result = realQuery.apply(this, args);
        if (/^\s*UPDATE\s+"messages"/i.test(String(args[0]))) down = true;
        return result;
      } as never);
    });

    it.each([
      ['engine revoke', engineRevoke, { state: 'dispatched', payload: null }],
      ['delete through the API', apiDelete, { state: 'pending', payload: { body: '', type: 'revoked' } }],
    ] as const)('has withdrawn the pending delivery first (%s)', async (_label, change, expected) => {
      await storeRow('M-6');
      await openDelivery('M-6', 'pending');

      await change('M-6');
      down = false;

      expect(await ds.getRepository(Message).findOneByOrFail({ waMessageId: 'M-6' })).toMatchObject({
        type: 'revoked',
      });
      expect(await delivered('M-6')).toMatchObject(expected);
      await sweep();
      expect(postedBodies()).not.toContainEqual(expect.objectContaining({ body: 'first text' }));
    });
  });

  // The revoke withdraws its deliveries before it clears the row, so time passes between its judging read and the write.
  describe("a revoke whose judging read found no row, before another chat's message takes the id", () => {
    it.each([
      ['an engine revoke', engineRevoke],
      ['a delete through the API', apiDelete],
    ] as const)('leaves that row alone (%s)', async (_label, change) => {
      const repository = ds.getRepository(Message);
      const findOne = repository.findOne.bind(repository);
      jest.spyOn(repository, 'findOne').mockImplementationOnce(async options => {
        const row = await findOne(options);
        await storeRow('M-13', OTHER_CHAT);
        return row;
      });

      await change('M-13');

      expect(await repository.findOneByOrFail({ sessionId, waMessageId: 'M-13' })).toMatchObject({
        chatId: OTHER_CHAT,
        type: 'text',
        body: 'first text',
      });
    });
  });
});
