import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Nine non-send message operations had no transport handling, so a dead page was an opaque 500 and a
 * death nothing reported. Two of their routes already documented 503 and could not produce it
 * (message.controller.ts:514 delete, :604 star); the other seven gained the declaration with this
 * change.
 *
 * The SEND paths are deliberately absent from this file. A 503 is replay-safe for a non-idempotent
 * POST by this project's own client contract (sdk/go/retry.go:30-42, pinned by
 * sdk/go/client_test.go:279-296 and :317-335), so relabelling a send would invite a duplicate
 * message. Every operation below either reads, or converges on the same state when repeated.
 */
const logger = createLogger('wwebjs-message-transport-death.spec');

describe('non-send message operations distinguish a dead page from an ordinary failure', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
  const MESSAGE_ID = 'true_628123@c.us_ABCDEF';

  function makeMessaging(
    op: string,
    reject: unknown,
  ): { messaging: WwebjsMessaging; reportIfPageTransportError: jest.Mock } {
    // Only the call under test rejects; everything else resolves, so each guard is exercised alone.
    const on = (name: string, ok: unknown) =>
      op === name ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue(ok);
    const message = {
      id: { _serialized: MESSAGE_ID, id: 'ABCDEF' },
      hasReaction: true,
      getReactions: on('getMessageReactions', []),
      getInfo: on('getMessageReceipts', null),
      react: on('reactToMessage', undefined),
      delete: on('deleteMessage', undefined),
      edit: on('editMessage', { id: { _serialized: MESSAGE_ID }, timestamp: 1 }),
      vote: on('votePoll', undefined),
      pin: on('pinMessage', true),
      unpin: on('unpinMessage', true),
      star: on('starMessage', undefined),
      unstar: on('starMessage', undefined),
    };
    const chat = { isGroup: false, fetchMessages: on('getChatHistory', [message]) };
    const client = { getChatById: jest.fn().mockResolvedValue(chat) };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
    } as unknown as WwebjsEngineHost;
    return { messaging: new WwebjsMessaging(host), reportIfPageTransportError };
  }

  const CHAT = '628123@c.us';
  const call = (messaging: WwebjsMessaging, op: string): Promise<unknown> =>
    ({
      getChatHistory: () => messaging.getChatHistory(CHAT, 10),
      getMessageReactions: () => messaging.getMessageReactions(CHAT, MESSAGE_ID),
      getMessageReceipts: () => messaging.getMessageReceipts(CHAT, MESSAGE_ID),
      reactToMessage: () => messaging.reactToMessage(CHAT, MESSAGE_ID, '👍'),
      deleteMessage: () => messaging.deleteMessage(CHAT, MESSAGE_ID),
      editMessage: () => messaging.editMessage(CHAT, MESSAGE_ID, 'new body'),
      votePoll: () => messaging.votePoll(CHAT, MESSAGE_ID, ['a']),
      pinMessage: () => messaging.pinMessage(CHAT, MESSAGE_ID, 86400),
      starMessage: () => messaging.starMessage(CHAT, MESSAGE_ID, true),
      unpinMessage: () => messaging.unpinMessage(CHAT, MESSAGE_ID),
    })[op]!();

  const OPS = [
    'getChatHistory',
    'getMessageReactions',
    'getMessageReceipts',
    'reactToMessage',
    'deleteMessage',
    'editMessage',
    'votePoll',
    'pinMessage',
    'starMessage',
    'unpinMessage',
  ];

  it.each(OPS)('%s answers a dead page with the 503 its route documents', async op => {
    const { messaging, reportIfPageTransportError } = makeMessaging(op, transportError);

    await expect(call(messaging, op)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  // Negative twin: an ordinary page-side failure must still surface untouched, so the fix cannot
  // simply relabel every failure as a retryable 503.
  it.each(OPS)('%s still propagates an ordinary failure unchanged', async op => {
    const refusal = new Error('Evaluation failed: message not found');
    const { messaging, reportIfPageTransportError } = makeMessaging(op, refusal);

    await expect(call(messaging, op)).rejects.toBe(refusal);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // votePoll's one bespoke mapping must survive the guard: whatsapp-web.js signals "not a poll" by
  // throwing a bare string, which is a client mistake (400), not a transport failure.
  it('still maps the bare-string vote refusal to a bad request', async () => {
    const { messaging, reportIfPageTransportError } = makeMessaging('votePoll', 'not a poll creation message');

    await expect(messaging.votePoll(CHAT, MESSAGE_ID, ['a'])).rejects.toThrow(/is not a poll/);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});
