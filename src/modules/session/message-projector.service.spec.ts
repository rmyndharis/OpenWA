import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { MessageProjector, PERSIST_RETRY_DELAY_MS } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Not, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { Session } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

// Lets a queued mutation settle: the projector's chains are fire-and-forget, so the assertions need
// the microtask queue drained rather than a promise the caller could await.
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// The de-dup query's `In([...])` argument, reached without an `any` hop.
const dedupIds = (find: jest.Mock, call = 0): string[] => {
  const calls = find.mock.calls as Array<[{ where: { waMessageId: { _value: string[] } } }]>;
  return calls[call][0].where.waMessageId._value;
};

// The payload a webhook dispatch carried, reached without an `any` hop — same reason as dedupIds.
const dispatchPayload = (dispatch: jest.Mock, call = 0): Record<string, unknown> => {
  const calls = dispatch.mock.calls as Array<[string, string, Record<string, unknown>]>;
  return calls[call][2];
};

const historyMessage = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({
    id: 'WA1',
    chatId: 'c1@c.us',
    from: '6281@c.us',
    to: '6282@c.us',
    body: 'hi',
    type: 'text',
    timestamp: 1_700_000_000,
    ...over,
  }) as IncomingMessage;

describe('MessageProjector', () => {
  let messageRepository: { find: jest.Mock; findOne: jest.Mock; create: jest.Mock; update: jest.Mock };
  let eventsGateway: {
    emitMessage: jest.Mock;
    emitMessageSent: jest.Mock;
    emitMessageRevoked: jest.Mock;
    emitMessageReaction: jest.Mock;
  };
  let webhookService: { dispatch: jest.Mock };
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;

  beforeEach(() => {
    messageRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: unknown) => x),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
    };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    projector = new MessageProjector(
      messageRepository as unknown as Repository<Message>,
      { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<Session>,
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService as unknown as WebhookService,
      { execute: jest.fn().mockResolvedValue(undefined) } as unknown as HookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  // The per-message chain is the ordering guarantee the projector exists to provide. These two cover
  // it directly; driving it through the engine callbacks can only reach the success path.
  describe('per-message mutation chain', () => {
    it('runs mutations for one message in the order they were queued', async () => {
      const order: string[] = [];
      projector.enqueueMessageMutation('s1', 'WA1', async () => {
        await settle();
        order.push('first');
      });
      projector.enqueueMessageMutation('s1', 'WA1', () => {
        order.push('second');
        return Promise.resolve();
      });

      await settle();
      await settle();

      expect(order).toEqual(['first', 'second']);
    });

    it('keeps a message usable after one of its mutations rejects', async () => {
      // The chain must isolate the failure, not wedge on it: a rejected reaction apply cannot make
      // every later edit/reaction for that same message disappear.
      const after = jest.fn().mockResolvedValue(undefined);
      projector.enqueueMessageMutation('s1', 'WA1', () => Promise.reject(new Error('boom')));
      projector.enqueueMessageMutation('s1', 'WA1', after);

      await settle();
      await settle();

      expect(after).toHaveBeenCalledTimes(1);
    });

    it('does not let a failure on one message stall a different message', async () => {
      const other = jest.fn().mockResolvedValue(undefined);
      projector.enqueueMessageMutation('s1', 'WA1', () => Promise.reject(new Error('boom')));
      projector.enqueueMessageMutation('s1', 'WA2', other);

      await settle();
      await settle();

      expect(other).toHaveBeenCalledTimes(1);
    });
  });

  describe('applyReactionQueued', () => {
    it('ignores a reaction with no target message id instead of querying for one', async () => {
      // findOne DROPS an undefined condition rather than matching nothing, so reaching the repository
      // with a blank id would load an arbitrary row and clobber its reactions.
      projector.applyReactionQueued('s1', { messageId: '', reaction: '👍' } as never);

      await settle();
      await settle();

      expect(messageRepository.findOne).not.toHaveBeenCalled();
    });

    it('still notifies consumers when the reacted message has no stored row', async () => {
      // Same contract as handleMessageRevoked: the stored copy is best-effort, but message.reaction is
      // a declared webhook event and the dashboard stream is the point of it. A row is absent whenever
      // the message was never persisted — an ephemeral message under STORE_EPHEMERAL_MESSAGES=false,
      // or one that arrived before the session went live.
      messageRepository.findOne.mockResolvedValue(null);

      projector.applyReactionQueued('s1', {
        messageId: 'WA1',
        chatId: 'c1@c.us',
        senderId: '628@c.us',
        reaction: '👍',
      });

      await settle();
      await settle();

      expect(webhookService.dispatch).toHaveBeenCalledWith('s1', 'message.reaction', expect.anything());
      expect(eventsGateway.emitMessageReaction).toHaveBeenCalledTimes(1);
    });

    it('omits the reactions snapshot when there is no stored row to compute it from', async () => {
      // `reactions` is the post-apply snapshot of EVERY reaction on the message, and consumers replace
      // their copy with it. Without the row that snapshot is unknowable, and sending this one reaction
      // as if it were the whole set would tell them the other senders had withdrawn theirs. Absent
      // means "we hold no copy", which is the truth.
      messageRepository.findOne.mockResolvedValue(null);

      projector.applyReactionQueued('s1', {
        messageId: 'WA1',
        chatId: 'c1@c.us',
        senderId: '628@c.us',
        reaction: '👍',
      });

      await settle();
      await settle();

      const payload = dispatchPayload(webhookService.dispatch);
      expect(payload).not.toHaveProperty('reactions');
      expect(payload).toMatchObject({ messageId: 'WA1', senderId: '628@c.us', reaction: '👍' });
    });

    it('still carries the full snapshot, and still writes it, when the row IS there', async () => {
      // The other half of the branch above: making the snapshot conditional must not make it optional
      // in the case that has always produced it. A prior sender's reaction survives in the map.
      messageRepository.findOne.mockResolvedValue({ metadata: { reactions: { '627@c.us': '❤️' } } });

      projector.applyReactionQueued('s1', {
        messageId: 'WA1',
        chatId: 'c1@c.us',
        senderId: '628@c.us',
        reaction: '👍',
      });

      await settle();
      await settle();

      const payload = dispatchPayload(webhookService.dispatch);
      expect(payload.reactions).toEqual({ '627@c.us': '❤️', '628@c.us': '👍' });
      expect(messageRepository.update).toHaveBeenCalledWith(
        { sessionId: 's1', waMessageId: 'WA1' },
        { metadata: { reactions: { '627@c.us': '❤️', '628@c.us': '👍' } } },
      );
    });
  });

  describe('handleMessageRevoked', () => {
    it('still notifies consumers when flagging the stored row fails', async () => {
      // The row may not exist at all, so the DB write is best-effort — but the webhook and the
      // dashboard stream are the whole point of the event and must not be lost with it.
      messageRepository.update.mockRejectedValue(new Error('db down'));

      projector.handleMessageRevoked('s1', engine, { id: 'REV1' } as never);
      await settle();

      expect(webhookService.dispatch).toHaveBeenCalledWith('s1', 'message.revoked', expect.anything());
      expect(eventsGateway.emitMessageRevoked).toHaveBeenCalledTimes(1);
    });

    it('flags the ORIGINAL message id, not the revocation notification', async () => {
      // On whatsapp-web.js `id` is the revocation notice and never matches a stored row; `revokedId`
      // carries the deleted message. Matching on the wrong one silently flags nothing.
      projector.handleMessageRevoked('s1', engine, { id: 'NOTICE', revokedId: 'ORIGINAL' } as never);
      await settle();

      expect(messageRepository.update).toHaveBeenCalledWith(
        { sessionId: 's1', waMessageId: 'ORIGINAL' },
        expect.objectContaining({ type: 'revoked' }),
      );
    });

    it('ignores an event from an engine that no longer owns the session', async () => {
      projector.handleMessageRevoked('s1', {} as IWhatsAppEngine, { id: 'REV1' } as never);
      await settle();

      expect(messageRepository.update).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('persistHistoryMessages', () => {
    it('skips rows that cannot become a valid message row, and queries nothing when none survive', async () => {
      await projector.persistHistoryMessages('s1', engine, [
        historyMessage({ id: '' }), // no id -> cannot de-dup
        historyMessage({ isStatusBroadcast: true }), // a story, not a chat
        historyMessage({ chatId: '' }), // chatId is NOT NULL
        historyMessage({ from: '' }), // from is NOT NULL
        historyMessage({ to: '' }), // to is NOT NULL
      ]);

      expect(messageRepository.find).not.toHaveBeenCalled();
    });

    it('carries the survivors of a mixed batch through to the de-dup query', async () => {
      // Answer the de-dup query with the survivor already present, so the assertion stays on the
      // filter rather than dragging the insert builder into a test about which rows qualify.
      messageRepository.find.mockResolvedValue([{ waMessageId: 'GOOD' }]);

      await projector.persistHistoryMessages('s1', engine, [
        historyMessage({ id: 'GOOD' }),
        historyMessage({ id: 'BAD', from: '' }),
      ]);

      expect(messageRepository.find).toHaveBeenCalledTimes(1);
      expect(dedupIds(messageRepository.find)).toEqual(['GOOD']);
    });

    it('de-duplicates repeated ids within one batch', async () => {
      messageRepository.find.mockResolvedValue([{ waMessageId: 'DUP' }]);

      await projector.persistHistoryMessages('s1', engine, [
        historyMessage({ id: 'DUP' }),
        historyMessage({ id: 'DUP' }),
      ]);

      expect(dedupIds(messageRepository.find)).toEqual(['DUP']);
    });

    it('skips history older than the MESSAGE_RETENTION_DAYS window', async () => {
      const prev = process.env.MESSAGE_RETENTION_DAYS;
      process.env.MESSAGE_RETENTION_DAYS = '30';
      try {
        messageRepository.find.mockResolvedValue([{ waMessageId: 'NEW' }]);
        const nowSec = Math.floor(Date.now() / 1000);

        await projector.persistHistoryMessages('s1', engine, [
          historyMessage({ id: 'OLD', timestamp: nowSec - 31 * 86_400 }),
          historyMessage({ id: 'NEW', timestamp: nowSec - 29 * 86_400 }),
        ]);

        expect(dedupIds(messageRepository.find)).toEqual(['NEW']);
      } finally {
        if (prev === undefined) delete process.env.MESSAGE_RETENTION_DAYS;
        else process.env.MESSAGE_RETENTION_DAYS = prev;
      }
    });
  });
});

// Separate top-level suite: handleInboundMessage's stale-engine fence and its isStatusBroadcast
// early return (message-projector.service.ts:114-119) were previously exercised only indirectly
// through session.service.spec.ts. Uses the TestingModule idiom (mirrors session.service.spec.ts)
// rather than the direct-construction style above, so the full DI surface (ConfigService,
// SessionLidResolver) is wired the same way production does.
describe('MessageProjector (inbound projection)', () => {
  let projector: MessageProjector;
  let engines: EngineRegistry;
  let messageRepository: { create: jest.Mock; insert: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let sessionRepository: { update: jest.Mock; findOne: jest.Mock };
  let eventsGateway: {
    emitMessage: jest.Mock;
    emitMessageSent: jest.Mock;
    emitMessageAck: jest.Mock;
    emitMessageRevoked: jest.Mock;
  };
  let webhookService: { dispatch: jest.Mock };
  let hookManager: { execute: jest.Mock };
  let statusStore: { ingest: jest.Mock };
  let lidResolver: { resolveSenderPhone: jest.Mock };
  let chatMediaArchive: { archive: jest.Mock };
  let automationRules: { evaluateInbound: jest.Mock };

  const SESSION_ID = 'session-1';

  /** A distinct object per test: EngineRegistry compares engine IDENTITY, not shape. */
  const makeEngine = (): IWhatsAppEngine => ({}) as IWhatsAppEngine;

  const makeIncoming = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: 'wamid.1',
    chatId: '15550001111@c.us',
    from: '15550001111@c.us',
    to: 'me',
    body: 'hello',
    type: 'text',
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    ...overrides,
  });

  beforeEach(async () => {
    messageRepository = {
      create: jest.fn((row: unknown) => row),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }], generatedMaps: [{}] }),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    };
    sessionRepository = { update: jest.fn().mockResolvedValue(undefined), findOne: jest.fn().mockResolvedValue(null) };
    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageAck: jest.fn(),
      emitMessageRevoked: jest.fn(),
    };
    webhookService = { dispatch: jest.fn() };
    // Mirrors the real HookManager contract (hook-manager.service.ts `execute`/`runHandlers`): resolves
    // `{ continue, data }`, passing `data` through unchanged when no hooks are registered — exactly
    // this unit test's environment. `mockResolvedValue(undefined)` would make handleInboundMessage's
    // `.then(({ data }) => ...)` destructure throw, silently short-circuiting every path below the hook
    // call via its trailing `.catch(err => this.logger.error(...))` — every assertion past that point
    // would then fail for a reason unrelated to the behaviour under test.
    hookManager = { execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })) };
    statusStore = { ingest: jest.fn().mockResolvedValue({ row: {}, created: false }) };
    lidResolver = { resolveSenderPhone: jest.fn().mockResolvedValue(null) };
    chatMediaArchive = { archive: jest.fn().mockResolvedValue(null) };
    automationRules = { evaluateInbound: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageProjector,
        // Real EngineRegistry, not a mock: the liveness fences under test are exactly its
        // identity semantics. Mirrors session.service.spec.ts.
        EngineRegistry,
        { provide: getRepositoryToken(Message, 'data'), useValue: messageRepository },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionRepository },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: WebhookService, useValue: webhookService },
        { provide: HookManager, useValue: hookManager },
        { provide: StatusStoreService, useValue: statusStore },
        { provide: SessionLidResolver, useValue: lidResolver },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: ChatMediaArchiveService, useValue: chatMediaArchive },
        { provide: AutomationRulesService, useValue: automationRules },
      ],
    }).compile();

    projector = module.get<MessageProjector>(MessageProjector);
    engines = module.get<EngineRegistry>(EngineRegistry);
  });

  describe('handleInboundMessage', () => {
    it('drops the message when the engine is no longer the live one for the session', () => {
      const retired = makeEngine();
      const current = makeEngine();
      engines.set(SESSION_ID, current);

      projector.handleInboundMessage(SESSION_ID, retired, makeIncoming());

      // The fence returns before ANY side effect, including the fire-and-forget lastActiveAt
      // update and the message:received hook call themselves — both are invoked synchronously
      // (their own resolution is async, but the call into the mock is not), so asserting on them
      // here, without awaiting the microtask queue, is what actually exercises the fence: the
      // persist/dispatch/emit assertions below would hold regardless of this fence, since nothing
      // downstream of a promise `.then()` can run before this synchronous block finishes.
      expect(sessionRepository.update).not.toHaveBeenCalled();
      expect(hookManager.execute).not.toHaveBeenCalled();
      expect(messageRepository.insert).not.toHaveBeenCalled();
      expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    // handleInboundMessage (:114-140) has no `fromMe` gate of its own — only handleOwnSendEcho
    // (:328-334) drops a non-fromMe event. In production this method is wired to the engine's
    // inbound-only `message`/`onMessage` callback (session-engine-event-wiring.ts:102), which by
    // contract never delivers a fromMe echo (the comment at :329-331 spells out why: message_create
    // is the only event that fires for those). But nothing inside handleInboundMessage itself enforces
    // that contract — a fromMe message handed to it is still projected as an ordinary inbound row,
    // just tagged OUTGOING (:255). Pinning this down protects the refactor from silently adding (or
    // removing) a fromMe drop that does not exist today.
    it('has no fromMe gate: a fromMe event on the inbound path is still persisted, tagged OUTGOING', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ fromMe: true }));
      // The projection continues on a promise chain; let the microtask queue drain.
      await new Promise(resolve => setImmediate(resolve));

      expect(messageRepository.insert).toHaveBeenCalledTimes(1);
      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ direction: MessageDirection.OUTGOING }),
      );
      expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    });

    it('persists, broadcasts and dispatches a normal inbound message', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      // The projection continues on a promise chain; let the microtask queue drain.
      await new Promise(resolve => setImmediate(resolve));

      expect(messageRepository.insert).toHaveBeenCalledTimes(1);
      // Pinned to the exact event name and args dispatchInboundMessage passes
      // (message-projector.service.ts:321,323), matching the assertion style
      // session.service.spec.ts uses for the same call sites — a bare call-count assertion would
      // stay green even if the event name flipped to 'message.sent' or the wrong payload was sent.
      expect(eventsGateway.emitMessage).toHaveBeenCalledWith(SESSION_ID, expect.anything());
      expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', expect.anything());
      expect(sessionRepository.update).toHaveBeenCalledTimes(1);
      // Pins the ternary at message-projector.service.ts:255: a genuinely inbound message (fromMe:
      // false) must be tagged INCOMING, not just "not OUTGOING".
      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ direction: MessageDirection.INCOMING }),
      );
    });

    // HookManager threads any defined `data`, so a handler returning `data: null` ("I consumed it")
    // or an object that is not a message reaches the projector. It must still record and dispatch
    // the engine's message, not throw and erase it.
    it.each([
      ['null', null],
      ['a primitive', 'consumed'],
      ['an object without the message identity', {}],
    ])('still persists and dispatches the message when a hook returns %s', async (_label, data) => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      hookManager.execute.mockResolvedValueOnce({ continue: true, data });
      const incoming = makeIncoming();

      projector.handleInboundMessage(SESSION_ID, engine, incoming);
      await new Promise(resolve => setImmediate(resolve));

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ waMessageId: incoming.id, chatId: incoming.chatId }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', incoming);
      expect(eventsGateway.emitMessage).toHaveBeenCalledWith(SESSION_ID, incoming);
    });

    it('lets HookManager skip a handler result that is not a message', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      await new Promise(resolve => setImmediate(resolve));

      const [, , options] = hookManager.execute.mock.calls[0] as [string, unknown, { accept: (d: unknown) => boolean }];
      expect(options.accept(null)).toBe(false);
      expect(options.accept('consumed')).toBe(false);
      expect(options.accept({})).toBe(false);
      expect(options.accept({ id: 'm', chatId: 'c@c.us' })).toBe(true);
    });

    it('keeps a rewritten message a hook returns', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const rewritten = { ...makeIncoming(), body: '[redacted]' };
      hookManager.execute.mockResolvedValueOnce({ continue: true, data: rewritten });

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      await new Promise(resolve => setImmediate(resolve));

      expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', rewritten);
    });

    it('exposes the message its hook chain carries, rewrites included, until the row is written', async () => {
      // A handler that replies to the message runs before the insert, so the reply's quote preview
      // has no row to read. The chain's copy stands in, and must be the redacted one when an earlier
      // handler rewrote it: the quote is stored next to the rewritten row.
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const seen: unknown[] = [];
      hookManager.execute.mockImplementationOnce(
        (_event: string, data: IncomingMessage, options: { accept: (d: unknown) => boolean }) => {
          seen.push(projector.inFlightInbound(SESSION_ID, 'wamid.1'));
          const rewritten = { ...data, body: '[redacted]' };
          options.accept(rewritten);
          seen.push(projector.inFlightInbound(SESSION_ID, 'wamid.1'));
          return Promise.resolve({ continue: true, data: rewritten });
        },
      );
      let finishInsert: () => void = () => undefined;
      messageRepository.insert.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInsert = () => resolve({ identifiers: [{ id: 1 }], generatedMaps: [{}] });
          }),
      );

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      await new Promise(resolve => setImmediate(resolve));

      expect(seen).toEqual([
        expect.objectContaining({ chatId: '15550001111@c.us', body: 'hello' }),
        expect.objectContaining({ chatId: '15550001111@c.us', body: '[redacted]' }),
      ]);
      // Still in flight while the insert is pending: a reply the handler did not await lands here.
      expect(projector.inFlightInbound(SESSION_ID, 'wamid.1')).toMatchObject({ body: '[redacted]' });

      finishInsert();
      await new Promise(resolve => setImmediate(resolve));

      expect(projector.inFlightInbound(SESSION_ID, 'wamid.1')).toBeUndefined();
      expect(projector.inFlightInbound('other-session', 'wamid.1')).toBeUndefined();
    });

    it('lends no text to a quote once the message is revoked before its row is written', () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      hookManager.execute.mockImplementationOnce(() => new Promise(() => undefined));

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);

      expect(projector.inFlightInbound(SESSION_ID, 'wamid.1')).toEqual({ chatId: '15550001111@c.us', body: '' });
    });

    // The row is inserted only after the message:received chain, so a revoke or edit landing while
    // it runs updates nothing, and the insert would then write the content the sender took back.
    describe('a revoke or edit that lands while message:received is still running', () => {
      let releaseHook: () => void;
      const received = async (engine: IWhatsAppEngine): Promise<void> => {
        const gate = new Promise<void>(resolve => (releaseHook = resolve));
        hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
          await gate;
          return { continue: true, data };
        });
        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));
      };
      const drain = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      };
      /** The update calls issued after the row was inserted, as [where, change]. */
      const updatesAfterInsert = (): unknown[] => {
        const insertedAt = messageRepository.insert.mock.invocationCallOrder[0];
        return messageRepository.update.mock.calls.filter(
          (_call, i) => messageRepository.update.mock.invocationCallOrder[i] > insertedAt,
        );
      };
      const where = { sessionId: SESSION_ID, waMessageId: 'wamid.1' };
      const revokedPatch = { body: '', type: 'revoked', metadata: null, mediaPath: null, mediaMimetype: null };

      beforeEach(() => {
        Object.assign(eventsGateway, { emitMessageEdited: jest.fn() });
      });

      it('empties the row once it is written', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        await received(engine);

        projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1', body: '', type: 'revoked' } as never);
        await drain();
        expect(messageRepository.update).toHaveBeenCalledWith(where, revokedPatch);
        expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.revoked', expect.anything());
        releaseHook();
        await drain();

        expect(messageRepository.insert).toHaveBeenCalledTimes(1);
        expect(updatesAfterInsert()).toEqual([[where, revokedPatch]]);
      });

      it('writes the latest edit onto the row once it is written', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        await received(engine);

        projector.applyMessageEditQueued(SESSION_ID, { messageId: 'wamid.1', body: 'first fix' } as never);
        projector.applyMessageEditQueued(SESSION_ID, { messageId: 'wamid.1', body: 'second fix' } as never);
        await drain();
        releaseHook();
        await drain();

        expect(updatesAfterInsert()).toEqual([[where, { body: 'second fix' }]]);
        expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.edited', expect.anything());
      });

      it('lets a revoke win over an edit', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        await received(engine);

        projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);
        projector.applyMessageEditQueued(SESSION_ID, { messageId: 'wamid.1', body: 'late fix' } as never);
        await drain();
        releaseHook();
        await drain();

        expect(updatesAfterInsert()).toEqual([[where, revokedPatch]]);
      });

      it('changes nothing after the insert when no revoke or edit arrived', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        await received(engine);
        releaseHook();
        await drain();

        expect(messageRepository.insert).toHaveBeenCalledTimes(1);
        expect(updatesAfterInsert()).toEqual([]);
      });
    });

    it('routes a status broadcast to the status store instead of the message table', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ isStatusBroadcast: true }));
      await new Promise(resolve => setImmediate(resolve));

      expect(statusStore.ingest).toHaveBeenCalledTimes(1);
      expect(messageRepository.insert).not.toHaveBeenCalled();
    });

    describe('chat-media archiving', () => {
      it('hands the persisted row to the archive', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);

        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));

        // The row, not the engine message: the archive updates by row id, which only the
        // persisted entity carries.
        expect(chatMediaArchive.archive).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: SESSION_ID, chatId: '15550001111@c.us' }),
        );
      });

      it('does not archive when the insert never landed', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        // A transient non-unique failure: the row has no id, so there is nothing to point at a file.
        messageRepository.insert.mockRejectedValueOnce(new Error('SQLITE_BUSY'));

        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));

        expect(chatMediaArchive.archive).not.toHaveBeenCalled();
        // Fail-open is unchanged: a real message is still dispatched on a transient DB fault.
        expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', expect.anything());
      });

      it('keeps delivering when archiving rejects — storage must never break the receive path', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        chatMediaArchive.archive.mockRejectedValueOnce(new Error('bucket unreachable'));

        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));

        expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', expect.anything());
        expect(eventsGateway.emitMessage).toHaveBeenCalledWith(SESSION_ID, expect.anything());
      });
    });

    describe('automation rules', () => {
      it('hands the dispatched message to the rule evaluator', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);

        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));

        // The hook-final message, same object the webhook dispatch gets — rule conditions must see
        // exactly what a filtered message.received webhook would have seen.
        expect(automationRules.evaluateInbound).toHaveBeenCalledWith(
          SESSION_ID,
          expect.objectContaining({ chatId: '15550001111@c.us' }),
        );
      });

      it('keeps delivering when rule evaluation rejects — a broken rule must never break the receive path', async () => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        automationRules.evaluateInbound.mockRejectedValueOnce(new Error('rules table gone'));

        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
        await new Promise(resolve => setImmediate(resolve));

        expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.received', expect.anything());
        expect(eventsGateway.emitMessage).toHaveBeenCalledWith(SESSION_ID, expect.anything());
      });
    });
  });

  describe('a revoked message', () => {
    const where = { sessionId: SESSION_ID, waMessageId: 'wamid.1' };
    const revokedPatch = { body: '', type: 'revoked', metadata: null, mediaPath: null, mediaMimetype: null };
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    };

    beforeEach(() => {
      Object.assign(eventsGateway, { emitMessageReaction: jest.fn(), emitMessageEdited: jest.fn() });
    });

    it('keeps nothing of the content and hands the cleared row to message:persisted', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const cleared = { id: 7, ...where, ...revokedPatch };
      messageRepository.update.mockResolvedValueOnce({ affected: 1 });
      messageRepository.findOne.mockResolvedValueOnce(cleared);

      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'NOTIF', revokedId: 'wamid.1' } as never);
      await flush();

      expect(messageRepository.update).toHaveBeenCalledWith(where, revokedPatch);
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:persisted',
        { sessionId: SESSION_ID, message: cleared },
        expect.anything(),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.revoked', expect.anything());
    });

    it('does not announce a row that was never stored', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.update.mockResolvedValueOnce({ affected: 0 });

      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);
      await flush();

      expect(hookManager.execute).not.toHaveBeenCalledWith('message:persisted', expect.anything(), expect.anything());
    });

    it('lands after a reaction queued before it, so the reaction cannot write content back', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.findOne.mockResolvedValue({ ...where, metadata: { media: { data: 'AAAA' } } });

      projector.applyReactionQueued(SESSION_ID, { messageId: 'wamid.1', senderId: 'x@c.us', reaction: 'ok' } as never);
      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);
      await flush();

      expect(messageRepository.update.mock.calls.at(-1)).toEqual([where, revokedPatch]);
    });

    it('never takes an edit, inbound or outbound', async () => {
      projector.applyMessageEditQueued(SESSION_ID, { messageId: 'wamid.1', body: 'late' } as never);
      await projector.recordOutboundMessageEdit(SESSION_ID, 'wamid.1', 'later');
      await flush();

      const guarded = { ...where, type: Not('revoked') };
      expect(messageRepository.update).toHaveBeenCalledWith(guarded, { body: 'late' });
      expect(messageRepository.update).toHaveBeenCalledWith(guarded, { body: 'later' });
    });

    it('clears nothing when the engine gives no message id', async () => {
      await projector.recordRevoke(SESSION_ID, '');

      expect(messageRepository.update).not.toHaveBeenCalled();
    });

    it('resolves the REST revoke even when the write fails', async () => {
      messageRepository.update.mockRejectedValueOnce(new Error('db down'));

      await expect(projector.recordRevoke(SESSION_ID, 'wamid.1')).resolves.toBeUndefined();
    });
  });

  // Hook chains for different messages finish in any order. A slow chain for one message must not let
  // a later message of the same chat be stored and announced first.
  describe('commit order within a chat', () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    };
    /** Holds each message's message:received / message:sent chain until the test releases it by id. */
    const holdHooks = (): Map<string, (fail?: boolean) => void> => {
      const release = new Map<string, (fail?: boolean) => void>();
      hookManager.execute.mockImplementation((event: string, data: IncomingMessage) => {
        if (event !== 'message:received' && event !== 'message:sent') return Promise.resolve({ continue: true, data });
        return new Promise((resolve, reject) =>
          release.set(data.id, fail => (fail ? reject(new Error('hook blew up')) : resolve({ continue: true, data }))),
        );
      });
      return release;
    };
    const inserted = (): unknown[] =>
      messageRepository.insert.mock.calls.map(([row]) => (row as { waMessageId: string }).waMessageId);
    const dispatched = (): unknown[] =>
      webhookService.dispatch.mock.calls.map(([, event, payload]) => `${event}:${(payload as { id: string }).id}`);
    const chatA = '15550001111@c.us';

    it('stores and dispatches in arrival order when a later hook finishes first', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'B', chatId: chatA }));
      // Both chains started: hooks still run concurrently.
      expect(hookManager.execute).toHaveBeenCalledTimes(2);

      release.get('B')!();
      await flush();
      expect(inserted()).toEqual([]);

      release.get('A')!();
      await flush();
      expect(inserted()).toEqual(['A', 'B']);
      expect(dispatched()).toEqual(['message.received:A', 'message.received:B']);
      expect(eventsGateway.emitMessage.mock.calls.map(([, m]) => (m as { id: string }).id)).toEqual(['A', 'B']);
    });

    it('does not hold back another chat', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'C', chatId: '15550002222@c.us' }));
      release.get('C')!();
      await flush();

      expect(inserted()).toEqual(['C']);
    });

    it('still commits a later message when an earlier hook chain fails', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'B', chatId: chatA }));
      release.get('A')!(true);
      release.get('B')!();
      await flush();

      expect(inserted()).toEqual(['B']);
      expect(dispatched()).toEqual(['message.received:B']);
    });

    it('drops queued messages once the engine is retired', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'B', chatId: chatA }));
      release.get('B')!();
      await flush();
      engines.set(SESSION_ID, makeEngine());
      release.get('A')!();
      await flush();

      expect(inserted()).toEqual([]);
      expect(dispatched()).toEqual([]);
    });

    it('applies a revoke that lands while a message waits for its turn', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'B', chatId: chatA }));
      release.get('B')!();
      await flush();
      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'B' } as never);
      release.get('A')!();
      await flush();

      const insertedB = messageRepository.insert.mock.invocationCallOrder[1];
      const afterB = messageRepository.update.mock.calls.filter(
        (_call, i) => messageRepository.update.mock.invocationCallOrder[i] > insertedB,
      );
      expect(afterB).toEqual([
        [{ sessionId: SESSION_ID, waMessageId: 'B' }, expect.objectContaining({ type: 'revoked' })],
      ]);
    });

    it('orders an own-send echo after an earlier inbound message of the same chat', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      const release = holdHooks();

      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
      projector.handleOwnSendEcho(SESSION_ID, engine, makeIncoming({ id: 'S', chatId: chatA, fromMe: true }));
      release.get('S')!();
      await flush();
      expect(inserted()).toEqual([]);

      release.get('A')!();
      await flush();
      expect(inserted()).toEqual(['A', 'S']);
      expect(dispatched()).toEqual(['message.received:A', 'message.sent:S']);
    });

    describe('a change to an own-send echo that waits behind an earlier message', () => {
      /** Echo S is ready but queued behind inbound A; `change` runs while S has no row yet. */
      const echoWaitingBehindA = async (): Promise<{ engine: IWhatsAppEngine; releaseA: () => void }> => {
        const engine = makeEngine();
        engines.set(SESSION_ID, engine);
        const release = holdHooks();
        projector.handleInboundMessage(SESSION_ID, engine, makeIncoming({ id: 'A', chatId: chatA }));
        projector.handleOwnSendEcho(SESSION_ID, engine, makeIncoming({ id: 'S', chatId: chatA, fromMe: true }));
        release.get('S')!();
        await flush();
        return { engine, releaseA: () => release.get('A')!() };
      };
      /** The update calls issued after S was inserted, as [where, change]. */
      const updatesAfterS = (): unknown[] => {
        const insertedS = messageRepository.insert.mock.invocationCallOrder[inserted().indexOf('S')];
        return messageRepository.update.mock.calls.filter(
          (_call, i) => messageRepository.update.mock.invocationCallOrder[i] > insertedS,
        );
      };
      const whereS = { sessionId: SESSION_ID, waMessageId: 'S' };

      beforeEach(() => {
        Object.assign(eventsGateway, { emitMessageEdited: jest.fn() });
        messageRepository.update.mockResolvedValue({ affected: 0 });
      });

      it('empties the echo row once it is written', async () => {
        const { engine, releaseA } = await echoWaitingBehindA();
        projector.handleMessageRevoked(SESSION_ID, engine, { id: 'S' } as never);
        releaseA();
        await flush();

        expect(inserted()).toEqual(['A', 'S']);
        expect(updatesAfterS()).toEqual([[whereS, expect.objectContaining({ body: '', type: 'revoked' })]]);
      });

      it('writes an edit onto the echo row once it is written', async () => {
        const { releaseA } = await echoWaitingBehindA();
        projector.applyMessageEditQueued(SESSION_ID, { messageId: 'S', body: 'fixed' } as never);
        releaseA();
        await flush();

        expect(updatesAfterS()).toEqual([[whereS, { body: 'fixed' }]]);
      });

      it('advances the echo row to the furthest ack that arrived before it was written', async () => {
        const { engine, releaseA } = await echoWaitingBehindA();
        projector.handleMessageAck(SESSION_ID, engine, 'S', 'read');
        projector.handleMessageAck(SESSION_ID, engine, 'S', 'delivered');
        releaseA();
        await flush();

        expect(updatesAfterS()).toEqual([[expect.objectContaining(whereS), { status: MessageStatus.READ }]]);
      });

      it('empties the echo row when the REST delete lands before it is written', async () => {
        const { releaseA } = await echoWaitingBehindA();
        void projector.recordRevoke(SESSION_ID, 'S');
        releaseA();
        await flush();

        expect(updatesAfterS()).toEqual([[whereS, expect.objectContaining({ body: '', type: 'revoked' })]]);
      });

      it('writes a REST edit onto the echo row once it is written', async () => {
        const { releaseA } = await echoWaitingBehindA();
        void projector.recordOutboundMessageEdit(SESSION_ID, 'S', 'fixed');
        releaseA();
        await flush();

        expect(updatesAfterS()).toEqual([[whereS, { body: 'fixed' }]]);
      });

      it('stores reactions that arrived before the row, without announcing them again', async () => {
        const emitMessageReaction = jest.fn();
        Object.assign(eventsGateway, { emitMessageReaction });
        const stored = { metadata: { keep: 1, reactions: { 'y@c.us': 'hi' } } };
        messageRepository.findOne.mockImplementation(() => Promise.resolve(inserted().includes('S') ? stored : null));
        const { releaseA } = await echoWaitingBehindA();
        projector.applyReactionQueued(SESSION_ID, { messageId: 'S', senderId: 'x@c.us', reaction: 'ok' } as never);
        projector.applyReactionQueued(SESSION_ID, { messageId: 'S', senderId: 'y@c.us', reaction: '' } as never);
        releaseA();
        await flush();

        expect(updatesAfterS()).toEqual([[whereS, { metadata: { keep: 1, reactions: { 'x@c.us': 'ok' } } }]]);
        expect(emitMessageReaction).toHaveBeenCalledTimes(2);
      });
    });
  });

  // One transient insert failure (lock contention, a dropped connection, a pool timeout) used to lose
  // the row for good: the engine delivers each message once, and nothing retried the insert.
  describe('a transient insert failure', () => {
    const busy = (): Error => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const dup = (): Error => Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    };
    const persistedHooks = (): unknown[] => hookManager.execute.mock.calls.filter(([e]) => e === 'message:persisted');
    const received = (): unknown[] => webhookService.dispatch.mock.calls.filter(([, e]) => e === 'message.received');

    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));
    afterEach(() => jest.useRealTimers());

    const receive = async (engine: IWhatsAppEngine): Promise<void> => {
      projector.handleInboundMessage(SESSION_ID, engine, makeIncoming());
      await flush();
    };

    it('retries the insert once and persists the row', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy());

      await receive(engine);
      expect(messageRepository.insert).toHaveBeenCalledTimes(1);
      expect(received()).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(2);
      expect(persistedHooks()).toHaveLength(1);
      expect(received()).toHaveLength(1);
      expect(chatMediaArchive.archive).toHaveBeenCalledTimes(1);
    });

    it('dispatches fail-open without the row hook when the retry fails too', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());

      await receive(engine);
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(2);
      expect(persistedHooks()).toHaveLength(0);
      expect(received()).toHaveLength(1);
    });

    it('does not retry a duplicate: a re-fire is still dropped', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(dup());

      await receive(engine);
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(1);
      expect(received()).toHaveLength(0);
    });

    it('still dispatches when the retry hits the row its first attempt may have committed', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy()).mockRejectedValueOnce(dup());

      await receive(engine);
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(2);
      expect(persistedHooks()).toHaveLength(0);
      expect(received()).toHaveLength(1);
    });

    it('still clears that row when a revoke landed while its hook chain ran', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy()).mockRejectedValueOnce(dup());
      let releaseHook!: () => void;
      hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
        await new Promise<void>(resolve => (releaseHook = resolve));
        return { continue: true, data };
      });

      await receive(engine);
      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);
      releaseHook();
      await flush();
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      const retriedAt = messageRepository.insert.mock.invocationCallOrder[1];
      const afterRetry = messageRepository.update.mock.calls.filter(
        (_call, i) => messageRepository.update.mock.invocationCallOrder[i] > retriedAt,
      );
      expect(afterRetry).toEqual([
        [{ sessionId: SESSION_ID, waMessageId: 'wamid.1' }, expect.objectContaining({ body: '', type: 'revoked' })],
      ]);
    });

    it('clears an own-send echo row the same way', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy()).mockRejectedValueOnce(dup());
      let releaseHook!: () => void;
      hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
        await new Promise<void>(resolve => (releaseHook = resolve));
        return { continue: true, data };
      });

      projector.handleOwnSendEcho(SESSION_ID, engine, makeIncoming({ fromMe: true }));
      await flush();
      projector.handleMessageRevoked(SESSION_ID, engine, { id: 'wamid.1' } as never);
      releaseHook();
      await flush();
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      const retriedAt = messageRepository.insert.mock.invocationCallOrder[1];
      const afterRetry = messageRepository.update.mock.calls.filter(
        (_call, i) => messageRepository.update.mock.invocationCallOrder[i] > retriedAt,
      );
      expect(afterRetry).toEqual([
        [{ sessionId: SESSION_ID, waMessageId: 'wamid.1' }, expect.objectContaining({ body: '', type: 'revoked' })],
      ]);
    });

    it('drops the retry when the engine is retired while it waits', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy());

      await receive(engine);
      engines.set(SESSION_ID, makeEngine());
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(1);
      expect(received()).toHaveLength(0);
    });

    it('retries an own-send echo the same way', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      messageRepository.insert.mockRejectedValueOnce(busy());

      projector.handleOwnSendEcho(SESSION_ID, engine, makeIncoming({ fromMe: true }));
      await flush();
      await jest.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(2);
      expect(persistedHooks()).toHaveLength(1);
      expect(webhookService.dispatch.mock.calls.filter(([, e]) => e === 'message.sent')).toHaveLength(1);
    });
  });

  describe('handleOwnSendEcho', () => {
    it('still persists and dispatches the send when a message:sent hook returns null', async () => {
      const engine = makeEngine();
      engines.set(SESSION_ID, engine);
      hookManager.execute.mockResolvedValueOnce({ continue: true, data: null });
      const sent = makeIncoming({ fromMe: true, to: '15550001111@c.us' });

      projector.handleOwnSendEcho(SESSION_ID, engine, sent);
      await new Promise(resolve => setImmediate(resolve));

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ waMessageId: sent.id, chatId: sent.chatId }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(SESSION_ID, 'message.sent', sent);
      expect(eventsGateway.emitMessageSent).toHaveBeenCalledWith(SESSION_ID, sent);
    });
  });
});
