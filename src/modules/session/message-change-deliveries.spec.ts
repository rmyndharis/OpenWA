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
import type { MutationSource } from './message-mutation-guard';
import { type LidRowVetoes, LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';
const OTHER_CHAT = '628999@c.us';
const LID = '999555@lid';
const GROUP = '120363000000000001@g.us';
const MEMBER = '628333@c.us';
const MEMBER_LID = '999666@lid';

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
  let engine: IWhatsAppEngine;
  let hookManager: HookManager;
  // The reported rows the lid store refuses.
  let vetoes: LidRowVetoes;

  beforeEach(async () => {
    vetoes = { unreported: [], revoking: [], held: [] };
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    retentionHours = 24;

    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure, LidMapping],
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
    redrive = new WebhookRedriveService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      delivery,
      configService,
    );
    const engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(sessionId, engine);
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
      undefined,
      undefined,
      // Reported pairings: the chat's phone with LID, and a group member's phone with MEMBER_LID.
      {
        findPhoneForLid: (jid: string) =>
          Promise.resolve(jid === LID ? '628111' : jid === MEMBER_LID ? '628333' : null),
        findLidsForPhone: (phone: string) =>
          Promise.resolve(phone === '628111' ? ['999555'] : phone === '628333' ? ['999666'] : []),
        rowVetoes: () => vetoes,
      } as unknown as LidMappingStoreService,
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

  describe('the message.edited deliveries of a message', () => {
    // An edit event of `id`: its own occurrence, keyed edit_<session>_<id><occurrence>, naming the message in messageId.
    const editKey = (id: string, occurrence: string): string => `edit_${sessionId}_${id}_${occurrence}_${webhook.id}`;
    const editPayload = (id: string, body: string, chatId = CHAT): Record<string, unknown> => ({
      messageId: id,
      chatId,
      from: chatId,
      to: '628222@c.us',
      fromMe: false,
      body,
      type: 'text',
      timestamp: 1_700_000_001,
    });
    const openEdit = async (id: string, occurrence: string, body: string, chatId = CHAT): Promise<void> => {
      await ds.getRepository(Webhook).update(webhook.id, { events: ['message.received', 'message.edited'] });
      await outbox.open({
        webhookId: webhook.id,
        sessionId,
        event: 'message.edited',
        idempotencyKey: editKey(id, occurrence),
        deliveryId: `delivery-edit-${occurrence}`,
        payload: editPayload(id, body, chatId),
      });
      await ds.getRepository(WebhookDeliveryFailure).insert({
        webhookId: webhook.id,
        sessionId,
        event: 'message.edited',
        url: webhook.url,
        idempotencyKey: editKey(id, occurrence),
        deliveryId: `delivery-edit-${occurrence}`,
        attempts: 1,
        lastError: 'HTTP 500: down',
        payload: editPayload(id, body, chatId),
      } as never);
    };
    const editCopies = async (occurrence: string, id: string): Promise<unknown[]> => {
      const key = editKey(id, occurrence);
      const row = await ds.getRepository(WebhookOutboxEvent).findOneOrFail({ where: { idempotencyKey: key } });
      const kept = await ds
        .getRepository(WebhookDeliveryFailure)
        .createQueryBuilder('f')
        .addSelect('f.payload')
        .where('f.idempotencyKey = :key', { key })
        .getOneOrFail();
      return [row.state, (row.payload as { body?: string } | null)?.body ?? null, kept.payload?.body ?? null];
    };

    it.each([
      ['an engine revoke', (id: string) => engineRevoke(id)],
      ['a delete through the API', (id: string) => apiDelete(id)],
    ] as const)('are withdrawn, the open row and the copy a failed delivery keeps, by %s', async (_label, revoke) => {
      await storeRow('E-1');
      await openEdit('E-1', 'o1', 'secret edit');

      await revoke('E-1');

      expect(await editCopies('o1', 'E-1')).toEqual(['dispatched', null, null]);
      await sweep();
      await redrive.redrive({ sessionId });
      expect(postedBodies()).toEqual([]);
    });

    it("leave the edits of another chat's message, and of a message whose id only starts with it, alone", async () => {
      await storeRow('E_2');
      await openEdit('E_2', 'o2', 'kept edit', OTHER_CHAT);
      await openEdit('EX2', 'o3', 'kept edit');
      await openEdit('E_20', 'o4', 'kept edit');

      await engineRevoke('E_2');

      expect(await editCopies('o2', 'E_2')).toEqual(['pending', 'kept edit', 'kept edit']);
      expect(await editCopies('o3', 'EX2')).toEqual(['pending', 'kept edit', 'kept edit']);
      expect(await editCopies('o4', 'E_20')).toEqual(['pending', 'kept edit', 'kept edit']);
    });

    it('keep the text of their own edit when the message is edited again', async () => {
      await storeRow('E-3');
      await openEdit('E-3', 'o5', 'first fix');

      await projector.recordOutboundMessageEdit(sessionId, 'E-3', 'second fix', {
        kind: 'edit',
        chatId: CHAT,
        fromMe: false,
      });

      expect(await editCopies('o5', 'E-3')).toEqual(['pending', 'first fix', 'first fix']);
    });
  });

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

    describe("whose webhook's filters the edited text no longer passes", () => {
      beforeEach(async () => {
        await ds.getRepository(Webhook).update(webhook.id, {
          filters: { conditions: [{ field: 'body', operator: 'contains', value: 'first' }] },
        });
      });

      it.each([
        ['from the engine', (id: string) => (engineEdit(id), until(async () => (await bodyOf(id)) === 'edited text'))],
        ['through the API', restEdit],
      ] as const)(
        'closes its pending delivery and drops the copy a failed delivery keeps, on an edit %s',
        async (_label, edit) => {
          await storeRow('M-21');
          await openDelivery('M-21', 'pending');
          await keepFailedCopy('M-21');

          await edit('M-21');
          await until(async () => (await delivered('M-21'))?.state === 'dispatched');

          expect(await delivered('M-21')).toMatchObject({ state: 'dispatched', payload: null });
          expect(await keptCopy('M-21')).toBeNull();
          await sweep();
          await redrive.redrive({ sessionId });
          expect(postedBodies()).toEqual([]);
        },
      );

      it('closes a delivery handed to the queue', async () => {
        await storeRow('M-22');
        await openDelivery('M-22', 'queued');

        await restEdit('M-22');

        expect(await delivered('M-22')).toMatchObject({ state: 'dispatched', payload: null });
      });

      it('still rewrites the copies of a webhook whose filters the edited text passes', async () => {
        await ds.getRepository(Webhook).update(webhook.id, {
          filters: { conditions: [{ field: 'body', operator: 'contains', value: 'text' }] },
        });
        await storeRow('M-23');
        await openDelivery('M-23', 'pending');

        await restEdit('M-23');

        expect(await delivered('M-23')).toMatchObject({ state: 'pending', payload: { body: 'edited text' } });
      });
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

  // An own send in a chat with disappearing messages is not stored while STORE_EPHEMERAL_MESSAGES=false, and its
  // message.sent delivery is still made: the edit has no row to write, and only the copies to carry.
  describe('an edit of an own send the gateway does not store', () => {
    const ephemeralSend = {
      id: 'M-16',
      chatId: CHAT,
      from: '628222@c.us',
      to: CHAT,
      fromMe: true,
      type: 'text',
      body: 'first text',
      timestamp: 1_700_000_000,
      ephemeralDuration: 86_400,
    };
    const edits = {
      'from the engine': () =>
        projector.applyMessageEditQueued(sessionId, {
          messageId: 'M-16',
          chatId: CHAT,
          body: 'edited text',
          fromMe: true,
        } as never),
      'through the API': () =>
        projector.recordOutboundMessageEdit(sessionId, 'M-16', 'edited text', {
          kind: 'edit',
          chatId: CHAT,
          fromMe: true,
        }),
    } as const;
    const bodies = (): unknown[] => postedBodies().map(data => (data as { body: string }).body);
    const settle = async (until: () => boolean): Promise<void> => {
      for (let turn = 0; turn < 200 && !until(); turn++) await new Promise(r => setImmediate(r));
    };
    let previous: string | undefined;

    beforeEach(async () => {
      previous = process.env.STORE_EPHEMERAL_MESSAGES;
      process.env.STORE_EPHEMERAL_MESSAGES = 'false';
      await ds.getRepository(Webhook).update(webhook.id, { events: ['message.sent'], retryCount: 2 });
      mockFetch.mockResolvedValue(new Response('down', { status: 500 }));
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.STORE_EPHEMERAL_MESSAGES;
      else process.env.STORE_EPHEMERAL_MESSAGES = previous;
    });

    it.each(Object.keys(edits) as Array<keyof typeof edits>)(
      'reaches the retry of its delivery when it comes %s',
      async edit => {
        let endBackoff: (() => void) | undefined;
        (sleep as unknown as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => (endBackoff = r)));

        projector.handleOwnSendEcho(sessionId, engine, ephemeralSend as never);
        await settle(() => endBackoff !== undefined);
        await edits[edit]();
        await settle(() => false);
        endBackoff!();
        await settle(() => mockFetch.mock.calls.length >= 2);
        await settle(() => false);

        expect(await ds.getRepository(Message).count()).toBe(0);
        expect(bodies()).toEqual(['first text', 'edited text']);
      },
    );

    it('reaches the copy its failed delivery keeps, which a redrive then sends', async () => {
      await ds.getRepository(Webhook).update(webhook.id, { retryCount: 1 });

      projector.handleOwnSendEcho(sessionId, engine, ephemeralSend as never);
      await settle(() => false);
      await settle(() => false);
      expect(await ds.getRepository(WebhookDeliveryFailure).count()).toBe(1);
      await edits['through the API']();

      mockFetch.mockReset();
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      await redrive.redrive({ sessionId });
      expect(bodies()).toEqual(['edited text']);
    });

    describe('that a message:sent handler filed under another chat', () => {
      const FILED = '628444@c.us';
      beforeEach(() => {
        hookManager.register('mover', 'message:sent', (ctx: { data: unknown }) =>
          Promise.resolve({
            continue: true,
            data: { ...(ctx.data as Record<string, unknown>), chatId: FILED, to: FILED },
          }),
        );
      });
      const outboxRow = (): Promise<WebhookOutboxEvent | null> =>
        ds.getRepository(WebhookOutboxEvent).findOne({ where: { sessionId } });

      it.each(Object.keys(edits) as Array<keyof typeof edits>)(
        'reaches the retry of its delivery when it comes %s, naming the chat the engine sent it in',
        async edit => {
          let endBackoff: (() => void) | undefined;
          (sleep as unknown as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => (endBackoff = r)));

          projector.handleOwnSendEcho(sessionId, engine, ephemeralSend as never);
          await settle(() => endBackoff !== undefined);
          await edits[edit]();
          await settle(() => false);
          endBackoff!();
          await settle(() => mockFetch.mock.calls.length >= 2);
          await settle(() => false);

          expect(await ds.getRepository(Message).count()).toBe(0);
          expect(postedBodies()).toEqual([
            expect.objectContaining({ chatId: FILED, body: 'first text' }),
            expect.objectContaining({ chatId: FILED, body: 'edited text' }),
          ]);
        },
      );

      it('is withdrawn by a revoke from the phone, from its pending delivery and the copy its failed delivery keeps', async () => {
        await ds.getRepository(Webhook).update(webhook.id, { retryCount: 1 });
        projector.handleOwnSendEcho(sessionId, engine, ephemeralSend as never);
        await settle(() => false);
        await settle(() => false);
        expect(await ds.getRepository(WebhookDeliveryFailure).count()).toBe(1);

        await projector.recordRevoke(sessionId, 'M-16', { kind: 'revoke', chatId: CHAT, fromMe: true }, true);

        mockFetch.mockReset();
        mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
        await redrive.redrive({ sessionId });
        expect(bodies()).toEqual([]);
      });

      it('leaves its copies alone for a change naming the chat the handler chose', async () => {
        let endBackoff: (() => void) | undefined;
        (sleep as unknown as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => (endBackoff = r)));
        projector.handleOwnSendEcho(sessionId, engine, ephemeralSend as never);
        await settle(() => endBackoff !== undefined);

        await projector.recordOutboundMessageEdit(sessionId, 'M-16', 'edited text', {
          kind: 'edit',
          chatId: FILED,
          fromMe: true,
        });

        expect((await outboxRow())?.payload).toMatchObject({ chatId: FILED, body: 'first text' });
        endBackoff!();
        await settle(() => mockFetch.mock.calls.length >= 2);
      });
    });

    it("leaves the copies of another chat's message under the id alone", async () => {
      await openDelivery('M-17', 'pending', OTHER_CHAT);

      await projector.recordOutboundMessageEdit(sessionId, 'M-17', 'edited text', {
        kind: 'edit',
        chatId: CHAT,
        fromMe: false,
      });

      expect((await delivered('M-17'))?.payload).toMatchObject({ body: 'first text' });
    });
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

  // A change reads the row under the id to judge it, then writes. A row stored under the id after the last such read is
  // another chat's or the message's own: only the second may take the change.
  describe('a row stored under the id after the read that judged a change found none', () => {
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 50; turn++) await new Promise(r => setImmediate(r));
    };
    const changes = {
      'an engine revoke': (id: string) => engineRevoke(id),
      'a delete through the API': (id: string) => apiDelete(id),
      'an edit from the engine': async (id: string) => {
        projector.applyMessageEditQueued(sessionId, {
          messageId: id,
          chatId: CHAT,
          body: 'edited text',
          fromMe: false,
        } as never);
        await settle();
      },
      'an edit through the API': (id: string) =>
        projector.recordOutboundMessageEdit(sessionId, id, 'edited text', {
          kind: 'edit',
          chatId: CHAT,
          fromMe: false,
        }),
      'a reaction': async (id: string) => {
        projector.applyReactionQueued(sessionId, {
          messageId: id,
          chatId: CHAT,
          senderId: CHAT,
          reaction: 'x',
        });
        await settle();
      },
    } as const;
    const unchanged = { type: 'text', body: 'first text', metadata: null };
    const changed = {
      'an engine revoke': { type: 'revoked', body: '' },
      'a delete through the API': { type: 'revoked', body: '' },
      'an edit from the engine': { body: 'edited text', metadata: { edited: true } },
      'an edit through the API': { body: 'edited text', metadata: { edited: true } },
      'a reaction': { metadata: { reactions: { [CHAT]: 'x' } } },
    } as const;
    /** Store `chatId`'s message under the id right after the last read that judges the change (a revoke reads twice). */
    const storedAfterTheJudgingRead = (id: string, chatId: string, reads: number): void => {
      const repository = ds.getRepository(Message);
      const findOne = repository.findOne.bind(repository);
      let judged = 0;
      jest.spyOn(repository, 'findOne').mockImplementation(async options => {
        const row = await findOne(options);
        const select = (options as { select?: Record<string, unknown> }).select;
        if (select?.engineRef && ++judged === reads) await storeRow(id, chatId);
        return row;
      });
    };
    const readsOf = (change: string): number => (change.includes('revoke') || change.includes('delete') ? 2 : 1);
    const rowOf = (id: string): Promise<Message> =>
      ds.getRepository(Message).findOneByOrFail({ sessionId, waMessageId: id });

    it.each(Object.keys(changes) as Array<keyof typeof changes>)(
      "never lands on another chat's message (%s)",
      async change => {
        storedAfterTheJudgingRead('M-13', OTHER_CHAT, readsOf(change));

        await changes[change]('M-13');

        expect(await rowOf('M-13')).toMatchObject({ chatId: OTHER_CHAT, ...unchanged });
      },
    );

    it.each(Object.keys(changes) as Array<keyof typeof changes>)(
      "still lands on the message's own row (%s)",
      async change => {
        storedAfterTheJudgingRead('M-19', CHAT, readsOf(change));

        await changes[change]('M-19');

        expect(await rowOf('M-19')).toMatchObject({ chatId: CHAT, ...changed[change] });
      },
    );

    // An API send stores its row before the engine sends and gives it the message id after: a change of the send that
    // arrives in between finds no row, and the row it then names is the send's own.
    it.each([
      [
        'a revoke from the phone',
        () => projector.recordRevoke(sessionId, 'M-20', { kind: 'revoke', chatId: CHAT, fromMe: true }, true),
        { type: 'revoked', body: '' },
      ],
      [
        'an edit through the API',
        () =>
          projector.recordOutboundMessageEdit(sessionId, 'M-20', 'edited text', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: true,
          }),
        { body: 'edited text' },
      ],
    ] as const)(
      'lands on an API send whose id the send path stores after the read (%s)',
      async (_label, change, expected) => {
        const repository = ds.getRepository(Message);
        const { identifiers } = await repository.insert({
          sessionId,
          waMessageId: null as unknown as string,
          chatId: CHAT,
          from: '628222@c.us',
          to: CHAT,
          body: 'first text',
          type: 'text',
          direction: MessageDirection.OUTGOING,
          timestamp: 1_700_000_000,
        });
        const findOne = repository.findOne.bind(repository);
        jest.spyOn(repository, 'findOne').mockImplementationOnce(async options => {
          const row = await findOne(options);
          await repository.update({ id: identifiers[0].id as string }, { waMessageId: 'M-20' });
          return row;
        });

        await change();

        expect(await rowOf('M-20')).toMatchObject({ direction: MessageDirection.OUTGOING, ...expected });
      },
    );

    describe('stored under another spelling of the chat or author the change names', () => {
      /** Store a message under `id` right after the last read that judges the change. */
      const storedAs = (
        id: string,
        row: Partial<Pick<Message, 'chatId' | 'from' | 'to' | 'direction' | 'author'>>,
        reads: number,
      ): void => {
        const repository = ds.getRepository(Message);
        const findOne = repository.findOne.bind(repository);
        let judged = 0;
        jest.spyOn(repository, 'findOne').mockImplementation(async options => {
          const found = await findOne(options);
          const select = (options as { select?: Record<string, unknown> }).select;
          if (select?.engineRef && ++judged === reads) {
            await repository.insert({
              sessionId,
              waMessageId: id,
              chatId: CHAT,
              from: CHAT,
              to: '628222@c.us',
              body: 'first text',
              type: 'text',
              direction: MessageDirection.INCOMING,
              timestamp: 1_700_000_000,
              ...row,
            });
          }
          return found;
        });
      };
      const revoke = (id: string, source: Omit<MutationSource, 'kind'>) =>
        projector.recordRevoke(sessionId, id, { kind: 'revoke', ...source }, true);
      const edit = async (id: string, message: Record<string, unknown>): Promise<void> => {
        projector.applyMessageEditQueued(sessionId, { messageId: id, body: 'edited text', ...message } as never);
        await settle();
      };
      const react = async (id: string, chatId: string, senderId: string): Promise<void> => {
        projector.applyReactionQueued(sessionId, { messageId: id, chatId, senderId, reaction: 'x' });
        await settle();
      };
      const own = { direction: MessageDirection.OUTGOING, from: '628222@c.us', to: CHAT };
      const member = { chatId: GROUP, from: GROUP, author: MEMBER };

      it.each([
        ['a revoke from the phone', 'S-1', own, () => revoke('S-1', { chatId: LID, fromMe: true }), 2],
        ['an engine edit', 'S-2', own, () => edit('S-2', { chatId: LID, fromMe: true }), 1],
        ['a reaction', 'S-3', own, () => react('S-3', LID, LID), 1],
        [
          'an engine revoke',
          'S-4',
          { chatId: LID, from: LID },
          () => revoke('S-4', { chatId: CHAT, fromMe: false }),
          2,
        ],
        [
          'an edit naming the phone',
          'S-5',
          { chatId: LID, from: LID },
          () => edit('S-5', { chatId: CHAT, fromMe: false }),
          1,
        ],
        ['a reaction naming the phone', 'S-6', { chatId: LID, from: LID }, () => react('S-6', CHAT, CHAT), 1],
        [
          'a revoke naming @c.us',
          'S-7',
          { chatId: '628111@s.whatsapp.net', from: '628111@s.whatsapp.net' },
          () => revoke('S-7', { chatId: CHAT, fromMe: false }),
          2,
        ],
        [
          'an edit naming @c.us',
          'S-8',
          { chatId: '628111@s.whatsapp.net', from: '628111@s.whatsapp.net' },
          () => edit('S-8', { chatId: CHAT, fromMe: false }),
          1,
        ],
        [
          'a group edit whose author is named by lid',
          'S-9',
          member,
          () => edit('S-9', { chatId: GROUP, fromMe: false, author: MEMBER_LID }),
          1,
        ],
        [
          'a member revoke whose author is named by lid',
          'S-10',
          member,
          () => revoke('S-10', { chatId: GROUP, fromMe: false, author: MEMBER_LID, admin: false }),
          2,
        ],
      ] as const)(
        'lands on the message stored under its other spelling (%s)',
        async (label, id, row, change, reads) => {
          storedAs(id, row, reads);

          await change();

          const stored = await rowOf(id);
          if (label.includes('revoke')) expect(stored).toMatchObject({ type: 'revoked', body: '' });
          else if (label.includes('edit')) expect(stored).toMatchObject({ body: 'edited text' });
          else expect(stored.metadata).toMatchObject({ reactions: { [label.includes('phone') ? CHAT : LID]: 'x' } });
        },
      );

      describe('whose author the row stores as a lid while a member revoke names a phone', () => {
        beforeEach(async () => {
          // As the lid store holds them: the pairings the stub reports, and a lid looked up with no answer.
          await ds.getRepository(LidMapping).insert([
            { lid: '999555', phone: '628111', isReported: true },
            { lid: '999666', phone: '628333', isReported: true },
            { lid: '999888', phone: null, isReported: false },
          ]);
        });

        it.each(['111999@lid', '999888@lid', '111999@hosted.lid'])(
          'lands on the row whose author %s has no reported phone',
          async author => {
            storedAs('S-13', { ...member, author }, 2);

            await revoke('S-13', { chatId: GROUP, fromMe: false, author: MEMBER, admin: false });

            expect(await rowOf('S-13')).toMatchObject({ type: 'revoked', body: '' });
          },
        );

        it.each([
          ['marked unreported with a write of its own not stored', { unreported: ['999666'], revoking: [], held: [] }],
          ['revoked by a display lookup being written', { unreported: [], revoking: ['999666'], held: [] }],
          ['held against another phone not stored', { unreported: [], revoking: [], held: [['999666', '628444']] }],
          ['held against no phone', { unreported: [], revoking: [], held: [['999666', null]] }],
        ] as const)("lands on the row whose author's lid the lid store refuses, %s", async (_label, refused) => {
          vetoes = {
            unreported: [...refused.unreported],
            revoking: [...refused.revoking],
            held: refused.held.map(([lid, phone]) => [lid, phone]),
          };
          storedAs('S-15', { ...member, author: MEMBER_LID }, 2);

          await revoke('S-15', { chatId: GROUP, fromMe: false, author: '628444@c.us', admin: false });

          expect(await rowOf('S-15')).toMatchObject({ type: 'revoked', body: '' });
        });

        it("leaves the row whose author's lid the lid store holds against the phone it is reported for", async () => {
          vetoes = { unreported: ['999888'], revoking: ['999888'], held: [['999666', '628333']] };
          storedAs('S-16', { ...member, author: MEMBER_LID }, 2);

          await revoke('S-16', { chatId: GROUP, fromMe: false, author: '628444@c.us', admin: false });

          expect(await rowOf('S-16')).toMatchObject({ author: MEMBER_LID, ...unchanged });
        });

        it("leaves the row whose author's lid is reported for another phone", async () => {
          storedAs('S-14', { ...member, author: MEMBER_LID }, 2);

          await revoke('S-14', { chatId: GROUP, fromMe: false, author: '628444@c.us', admin: false });

          expect(await rowOf('S-14')).toMatchObject({ author: MEMBER_LID, ...unchanged });
        });
      });

      it('lands a member revoke naming its author by a lid with no reported phone on the row that stores a phone', async () => {
        storedAs('S-12', member, 2);

        await revoke('S-12', { chatId: GROUP, fromMe: false, author: '111222@lid', admin: false });

        expect(await rowOf('S-12')).toMatchObject({ type: 'revoked', body: '' });
      });

      it.each([
        ['a group edit', () => edit('S-11', { chatId: GROUP, fromMe: false, author: MEMBER_LID })],
        ['a member revoke', () => revoke('S-11', { chatId: GROUP, fromMe: false, author: MEMBER_LID, admin: false })],
      ] as const)("leaves another member's message alone (%s)", async (label, change) => {
        storedAs('S-11', { ...member, author: '628444@c.us' }, label.includes('revoke') ? 2 : 1);

        await change();

        expect(await rowOf('S-11')).toMatchObject({ author: '628444@c.us', ...unchanged });
      });
    });
  });
});
