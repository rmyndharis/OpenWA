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
