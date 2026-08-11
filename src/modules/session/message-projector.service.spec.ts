import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { Repository } from 'typeorm';
import { Message, MessageDirection } from '../message/entities/message.entity';
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
      await projector.persistHistoryMessages('s1', [
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

      await projector.persistHistoryMessages('s1', [
        historyMessage({ id: 'GOOD' }),
        historyMessage({ id: 'BAD', from: '' }),
      ]);

      expect(messageRepository.find).toHaveBeenCalledTimes(1);
      expect(dedupIds(messageRepository.find)).toEqual(['GOOD']);
    });

    it('de-duplicates repeated ids within one batch', async () => {
      messageRepository.find.mockResolvedValue([{ waMessageId: 'DUP' }]);

      await projector.persistHistoryMessages('s1', [historyMessage({ id: 'DUP' }), historyMessage({ id: 'DUP' })]);

      expect(dedupIds(messageRepository.find)).toEqual(['DUP']);
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
  let eventsGateway: { emitMessage: jest.Mock; emitMessageAck: jest.Mock; emitMessageRevoked: jest.Mock };
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
    eventsGateway = { emitMessage: jest.fn(), emitMessageAck: jest.fn(), emitMessageRevoked: jest.fn() };
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
});
