import { RESOLVED_SEND_IDS_MAX, WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import type { WwebjsEngineHost } from './wwebjs-host';

const logger = createLogger('wwebjs-messaging.spec');

describe('WwebjsMessaging resolvedSendIds LRU cap', () => {
  it('caps resolvedSendIds at 5000, refreshes recency on hit, and purges evicted keys from unreportedLids', async () => {
    const lidRemember = jest.fn().mockResolvedValue(false);
    const getNumberId = jest.fn((chatId: string) => {
      const digits = chatId.split('@')[0];
      return Promise.resolve(`9${digits}@lid`);
    });
    const host = {
      config: {
        sessionId: 's1',
        lidMappingStore: { remember: lidRemember },
      },
      getNumberId,
      logger,
    } as unknown as WwebjsEngineHost;
    const messaging = new WwebjsMessaging(host);

    const chat = (n: number) => `${628000000000 + n}@c.us`;

    // Fill cache to RESOLVED_SEND_IDS_MAX entries; each remember() resolves false so every key enters unreportedLids.
    for (let i = 0; i < RESOLVED_SEND_IDS_MAX; i++) {
      await messaging.resolveSendId(chat(i));
    }
    // Let fire-and-forget reportLid failure handlers run.
    await new Promise<void>(resolve => setImmediate(resolve));

    const internal = messaging as unknown as {
      resolvedSendIds: Map<string, string>;
      unreportedLids: Set<string>;
    };
    expect(internal.resolvedSendIds.size).toBe(RESOLVED_SEND_IDS_MAX);
    expect(internal.unreportedLids.has(chat(0))).toBe(true);
    expect(internal.unreportedLids.has(chat(1))).toBe(true);

    // Touch chat(0) via a cache hit so it becomes most-recently-used; chat(1) is now the oldest.
    lidRemember.mockResolvedValueOnce(true);
    await messaging.resolveSendId(chat(0));
    expect(getNumberId).toHaveBeenCalledTimes(RESOLVED_SEND_IDS_MAX);

    // Inserting entry past the cap must evict chat(1) (the LRU entry) and also remove chat(1) from unreportedLids.
    await messaging.resolveSendId(chat(RESOLVED_SEND_IDS_MAX));
    expect(internal.resolvedSendIds.size).toBe(RESOLVED_SEND_IDS_MAX);
    expect(internal.resolvedSendIds.has(chat(0))).toBe(true);
    expect(internal.resolvedSendIds.has(chat(1))).toBe(false);
    expect(internal.unreportedLids.has(chat(1))).toBe(false);

    // Resolving chat(1) again must re-probe getNumberId since it was evicted.
    await messaging.resolveSendId(chat(1));
    expect(getNumberId).toHaveBeenCalledTimes(RESOLVED_SEND_IDS_MAX + 2);
  });
});

describe('WwebjsMessaging bare message ID parity and history transport breaks', () => {
  const bareIdMsg = () => ({
    id: { _serialized: 'false_628111@c.us_BARE1', id: 'BARE1' },
    reply: jest.fn().mockResolvedValue({ id: { _serialized: 'SENT-REPLY' }, timestamp: 1_700_000_000 }),
    forward: jest.fn().mockResolvedValue(undefined),
    react: jest.fn().mockResolvedValue(undefined),
    hasReaction: true,
    getReactions: jest.fn().mockResolvedValue([]),
  });

  const makeMsgHost = (chat: Record<string, unknown>, extraClient: Record<string, unknown> = {}) => {
    const transportErr = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
    const reportIfPageTransportError = jest.fn();
    const client = {
      getChatById: jest.fn().mockResolvedValue(chat),
      getNumberId: jest.fn().mockResolvedValue(undefined),
      ...extraClient,
    };
    const host = {
      ensureReady: jest.fn(),
      ensureNotChannelRecipient: jest.fn(),
      getClient: () => client as never,
      getNumberId: jest.fn().mockResolvedValue(undefined),
      isPageTransportError: (err: unknown) => err === transportErr,
      reportIfPageTransportError,
      capInboundMediaFor: jest.fn(),
      config: {},
      logger,
    } as unknown as WwebjsEngineHost;
    return { messaging: new WwebjsMessaging(host), host, client, reportIfPageTransportError, transportErr };
  };

  it('matches bare message IDs in replyToMessage, forwardMessage, reactToMessage, and getMessageReactions', async () => {
    const targetMsg = bareIdMsg();
    const srcChat = { fetchMessages: jest.fn().mockResolvedValue([targetMsg]) };
    const destChat = {
      fetchMessages: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: { _serialized: 'FWD-1' }, timestamp: 1_700_000_000 }]),
    };
    const { messaging } = makeMsgHost(srcChat, {
      getChatById: jest.fn((id: string) => Promise.resolve(id === 'dest@c.us' ? destChat : srcChat)),
    });

    await expect(messaging.replyToMessage('628111@c.us', 'BARE1', 'reply')).resolves.toMatchObject({
      id: 'SENT-REPLY',
    });
    await expect(messaging.forwardMessage('628111@c.us', 'dest@c.us', 'BARE1')).resolves.toMatchObject({ id: 'FWD-1' });
    await expect(messaging.reactToMessage('628111@c.us', 'BARE1', '👍')).resolves.toBeUndefined();
    await expect(messaging.getMessageReactions('628111@c.us', 'BARE1')).resolves.toEqual([]);
  });

  it('breaks out of getChatHistory pagination loop and reports transport death on page error', async () => {
    const getContact1 = jest.fn();
    const getContact2 = jest.fn();
    const chat = {
      id: { _serialized: '628111@c.us' },
      fetchMessages: jest.fn().mockResolvedValue([
        {
          id: { _serialized: 'M1' },
          from: '628111@c.us',
          to: '628999@c.us',
          type: 'chat',
          body: 'one',
          timestamp: 1_700_000_001,
          getContact: getContact1,
        },
        {
          id: { _serialized: 'M2' },
          from: '628111@c.us',
          to: '628999@c.us',
          type: 'chat',
          body: 'two',
          timestamp: 1_700_000_002,
          getContact: getContact2,
        },
      ]),
    };
    const { messaging, reportIfPageTransportError, transportErr } = makeMsgHost(chat);
    getContact1.mockRejectedValue(transportErr);

    const rows = await messaging.getChatHistory('628111@c.us', 10);

    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportErr, 'getChatHistory');
    expect(getContact2).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});
