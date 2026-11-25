import { RESOLVED_SEND_IDS_MAX, WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import type { WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

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

describe('WwebjsMessaging bare message ID parity and history page death', () => {
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

  // Each message of a history page costs up to three more page calls: its sender, its quoted message and its
  // media. Three messages from different senders, and the second one's call fails, so what was read before the
  // failure and what is asked after it are both observable.
  const historyPage = () => {
    const historyMsg = (n: number) => ({
      id: { _serialized: `M${n}` },
      from: `62811${n}@c.us`,
      to: '628999@c.us',
      type: 'chat',
      body: `body ${n}`,
      timestamp: 1_700_000_000 + n,
      hasMedia: true,
      hasQuotedMsg: true,
      getContact: jest.fn().mockResolvedValue(undefined),
      getQuotedMessage: jest.fn().mockResolvedValue({ id: { _serialized: `Q${n}` }, type: 'chat', body: 'quoted' }),
    });
    const [m1, m2, m3] = [historyMsg(1), historyMsg(2), historyMsg(3)];
    const setup = makeMsgHost({
      id: { _serialized: '628111@c.us' },
      fetchMessages: jest.fn().mockResolvedValue([m1, m2, m3]),
    });
    const failSecond = (site: 'sender' | 'quoted message' | 'media', error: unknown) => {
      if (site === 'sender') m2.getContact.mockRejectedValue(error);
      else if (site === 'quoted message') m2.getQuotedMessage.mockRejectedValue(error);
      else (setup.host.capInboundMediaFor as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    };
    return { ...setup, m3, failSecond };
  };
  const SITES = ['sender', 'quoted message', 'media'] as const;

  it.each(SITES)(
    'answers a page that dies reading the %s of a message with the 503, not the messages read before it',
    async site => {
      const { messaging, reportIfPageTransportError, transportErr, m3, failSecond } = historyPage();
      failSecond(site, transportErr);

      await expect(messaging.getChatHistory('628111@c.us', 10, true)).rejects.toThrow(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalledWith(transportErr, 'getChatHistory');
      expect(m3.getContact).not.toHaveBeenCalled();
    },
  );

  it.each(SITES)('still lists every message when reading the %s of one fails for another reason', async site => {
    const { messaging, reportIfPageTransportError, failSecond } = historyPage();
    failSecond(site, new Error('Evaluation failed: lookup refused'));

    const rows = await messaging.getChatHistory('628111@c.us', 10, true);

    expect(rows.map(row => row.id)).toEqual(['M1', 'M2', 'M3']);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});
