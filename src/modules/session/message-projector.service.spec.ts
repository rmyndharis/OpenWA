import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { Repository } from 'typeorm';
import type { Message } from '../message/entities/message.entity';
import type { Session } from './entities/session.entity';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

// Lets a queued mutation settle: the projector's chains are fire-and-forget, so the assertions need
// the microtask queue drained rather than a promise the caller could await.
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// The de-dup query's `In([...])` argument, reached without an `any` hop.
const dedupIds = (find: jest.Mock, call = 0): string[] => {
  const calls = find.mock.calls as Array<[{ where: { waMessageId: { _value: string[] } } }]>;
  return calls[call][0].where.waMessageId._value;
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
  let eventsGateway: { emitMessage: jest.Mock; emitMessageSent: jest.Mock; emitMessageRevoked: jest.Mock };
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
    eventsGateway = { emitMessage: jest.fn(), emitMessageSent: jest.fn(), emitMessageRevoked: jest.fn() };
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
