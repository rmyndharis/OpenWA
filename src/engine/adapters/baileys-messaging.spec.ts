import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { EngineNotSentError, provesNothingSent } from '../../common/errors/engine-not-sent.error';

type FakeSock = {
  onWhatsApp: jest.Mock;
  sendMessage: jest.Mock;
  waUploadToServer: jest.Mock;
  end: jest.Mock;
};

function makeFakeSock(): FakeSock {
  let seq = 1;
  return {
    onWhatsApp: jest.fn((jid: string) =>
      Promise.resolve([{ jid: jid.includes('@') ? jid : `${jid}@s.whatsapp.net`, exists: true }]),
    ),
    sendMessage: jest.fn(() => Promise.resolve({ key: { id: `MSG-${seq++}` }, messageTimestamp: 1_700_000_000 })),
    waUploadToServer: jest.fn(),
    end: jest.fn(),
  };
}

function makeHost(getSock: () => FakeSock | null): BaileysMessagingHost {
  return {
    sessionProxyUrl: () => undefined,
    ensureReady: () => undefined,
    getSocket: () => getSock() as unknown as WASocket,
    getSocketOrNull: () => getSock() as unknown as WASocket | null,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
    toNeutralJid: (jid: string) => jid.replace(/@s\.whatsapp\.net$/, '@c.us'),
    toEngineJid: (jid: string) => jid.replace(/@c\.us$/, '@s.whatsapp.net'),
    normalizedSelfJid: () => '628000000000@s.whatsapp.net',
    getEphemeralExpiration: () => undefined,
    toUnixSeconds: ts => (typeof ts === 'number' ? ts : 0),
    loadLib: () => Promise.resolve({} as never),
    putStoredMessage: () => undefined,
    recordMessage: () => undefined,
    recordMessageEdit: () => undefined,
    rememberOwnSend: () => undefined,
    getStoredMessage: () => undefined,
    updateStoredMessage: () => undefined,
    wasDeletedForEveryone: () => false,
    markDeletedForEveryone: () => undefined,
    pendingEditOf: () => undefined,
    recordLidMapping: () => undefined,
    getOnMessageCreate: () => undefined,
    mapMessage: jest.fn(),
  };
}

describe('BaileysMessaging onWhatsApp send cache', () => {
  it('queries sock.onWhatsApp once for two sequential 1:1 sends to the same contact across JID dialects', async () => {
    const sock = makeFakeSock();
    const messaging = new BaileysMessaging(makeHost(() => sock));

    await messaging.sendTextMessage('628111222333@c.us', 'first');
    await messaging.sendTextMessage('628111222333@s.whatsapp.net', 'second');

    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent 1:1 sends to the same contact into one sock.onWhatsApp query', async () => {
    const sock = makeFakeSock();
    let resolveLookup!: (value: Array<{ jid: string; exists: boolean }>) => void;
    sock.onWhatsApp.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveLookup = resolve;
        }),
    );
    const messaging = new BaileysMessaging(makeHost(() => sock));

    const first = messaging.sendTextMessage('628111222333@c.us', 'one');
    const second = messaging.sendTextMessage('628111222333@c.us', 'two');

    // Flush toDeliverableJid microtasks before resolving the shared lookup.
    await new Promise(resolve => setImmediate(resolve));
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

    resolveLookup([{ jid: '628111222333@s.whatsapp.net', exists: true }]);
    await Promise.all([first, second]);

    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('re-queries sock.onWhatsApp after the 15-minute positive TTL expires', async () => {
    jest.useFakeTimers();
    try {
      const sock = makeFakeSock();
      const messaging = new BaileysMessaging(makeHost(() => sock));

      await messaging.sendTextMessage('628111222333@c.us', 'before expiry');
      expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(15 * 60_000 - 1);
      await messaging.sendTextMessage('628111222333@c.us', 'still cached');
      expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      await messaging.sendTextMessage('628111222333@c.us', 'after expiry');
      expect(sock.onWhatsApp).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts and re-queries when the wall clock steps backward past storedAt', async () => {
    const sock = makeFakeSock();
    const messaging = new BaileysMessaging(makeHost(() => sock));
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(2_000_000_000);
      await messaging.sendTextMessage('628111222333@c.us', 'before clock step');
      expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

      // Wall clock jumps backward by 1 minute (e.g. NTP adjustment).
      nowSpy.mockReturnValue(2_000_000_000 - 60_000);
      await messaging.sendTextMessage('628111222333@c.us', 'after clock step');
      expect(sock.onWhatsApp).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not cache transport or timeout errors from onWhatsApp', async () => {
    const sock = makeFakeSock();
    sock.onWhatsApp
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce([{ jid: '628111222333@s.whatsapp.net', exists: true }]);
    const messaging = new BaileysMessaging(makeHost(() => sock));

    await expect(messaging.sendTextMessage('628111222333@c.us', 'try 1')).rejects.toBeInstanceOf(EngineNotSentError);
    await expect(messaging.sendTextMessage('628111222333@c.us', 'try 2')).rejects.toBeInstanceOf(EngineNotSentError);
    await messaging.sendTextMessage('628111222333@c.us', 'try 3');

    expect(sock.onWhatsApp).toHaveBeenCalledTimes(3);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('throws RecipientUnreachableError when exists is false and does not cache the negative result', async () => {
    const sock = makeFakeSock();
    sock.onWhatsApp
      .mockResolvedValueOnce([{ jid: '628999000111@s.whatsapp.net', exists: false }])
      .mockResolvedValueOnce([{ jid: '628999000111@s.whatsapp.net', exists: true }]);
    const messaging = new BaileysMessaging(makeHost(() => sock));

    let caught: unknown;
    try {
      await messaging.sendTextMessage('628999000111@c.us', 'first');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RecipientUnreachableError);
    expect(provesNothingSent(caught)).toBe(true);
    expect(sock.sendMessage).not.toHaveBeenCalled();

    // Second send re-queries live rather than reusing the unregistered verdict.
    await messaging.sendTextMessage('628999000111@c.us', 'second');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(2);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown]>([
    ['WA status 400 (data)', Object.assign(new Error('bad-request'), { data: 400 })],
    ['WA status 404 (data)', Object.assign(new Error('item-not-found'), { data: 404 })],
    ['Boom output statusCode 404', { isBoom: true, output: { statusCode: 404 } }],
    ['RecipientUnreachableError', new RecipientUnreachableError('628111222333@c.us')],
  ])('invalidates the cached entry when sock.sendMessage fails with %s', async (_label, sendError) => {
    const sock = makeFakeSock();
    const messaging = new BaileysMessaging(makeHost(() => sock));

    await messaging.sendTextMessage('628111222333@c.us', 'warm cache');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

    sock.sendMessage.mockRejectedValueOnce(sendError);
    await expect(messaging.sendTextMessage('628111222333@c.us', 'fails')).rejects.toBeDefined();
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

    // Cache entry was evicted on the 400/404/RecipientUnreachableError failure -> re-queries.
    await messaging.sendTextMessage('628111222333@c.us', 're-queries');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(2);
  });

  it('clearNumberIdCache clears cached entries and fences in-flight writes from repopulating the cache', async () => {
    const sock = makeFakeSock();
    const messaging = new BaileysMessaging(makeHost(() => sock));

    // Populate entry A and verify clearNumberIdCache drops it.
    await messaging.sendTextMessage('628100000001@c.us', 'a1');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    messaging.clearNumberIdCache();
    await messaging.sendTextMessage('628100000001@c.us', 'a2');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(2);

    // Fence an in-flight lookup started before clearNumberIdCache().
    let resolveInFlight!: (value: Array<{ jid: string; exists: boolean }>) => void;
    sock.onWhatsApp.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveInFlight = resolve;
        }),
    );
    const inFlightSend = messaging.sendTextMessage('628100000002@c.us', 'in-flight');
    await new Promise(resolve => setImmediate(resolve));
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(3);

    // Disconnect/clear while lookup is still pending.
    messaging.clearNumberIdCache();
    resolveInFlight([{ jid: '628100000002@s.whatsapp.net', exists: true }]);
    await inFlightSend;

    // Because the lookup belonged to the prior generation, it must not have populated the cache.
    await messaging.sendTextMessage('628100000002@c.us', 'after-clear');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(4);
  });

  it('evicts the least-recently-used entry when the cache exceeds capacity and preserves touched entries', async () => {
    const sock = makeFakeSock();
    // Exercise both the default 5000 capacity and LRU touch ordering.
    const messaging = new BaileysMessaging(makeHost(() => sock));

    for (let i = 0; i < 5000; i++) {
      await messaging.sendTextMessage(`6280000${String(i).padStart(5, '0')}@c.us`, 'fill');
    }
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5000);

    // Touch entry 0 so entry 1 becomes the oldest (LRU).
    await messaging.sendTextMessage('628000000000@c.us', 'touch-0');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5000);

    // Insert entry 5000 -> evicts entry 1, keeping entry 0.
    await messaging.sendTextMessage('628000005000@c.us', 'insert-5000');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5001);

    // Entry 0 is still cached.
    await messaging.sendTextMessage('628000000000@c.us', 'hit-0');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5001);

    // Entry 1 was evicted and must re-query.
    await messaging.sendTextMessage('628000000001@c.us', 'miss-1');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5002);
  });

  it('keeps public checkNumberExists() and getNumberId() querying sock.onWhatsApp live', async () => {
    const sock = makeFakeSock();
    const messaging = new BaileysMessaging(makeHost(() => sock));

    // Warm the send cache for this number.
    await messaging.sendTextMessage('628111222333@c.us', 'warm');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

    // Public probes always query live even when cached for sends.
    await expect(messaging.checkNumberExists('628111222333')).resolves.toBe(true);
    await expect(messaging.getNumberId('628111222333')).resolves.toBe('628111222333@c.us');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(3);

    // Calling getNumberId for a fresh number does not populate the send cache.
    await expect(messaging.getNumberId('628444555666')).resolves.toBe('628444555666@c.us');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(4);
    await messaging.sendTextMessage('628444555666@c.us', 'send-after-probe');
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(5);
  });

  it('clears the number-id cache when BaileysLifecycle drops connection state on disconnect', async () => {
    const clearNumberIdCache = jest.fn();
    const lifecycle = new BaileysLifecycle({
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      authPath: '/tmp/baileys-test-auth',
      config: { sessionId: 'test-sess' },
      liveCalls: new Map(),
      clearNumberIdCache,
      getOnStateChanged: () => undefined,
      getOnDisconnected: () => undefined,
    } as unknown as BaileysLifecycleHost);

    await lifecycle.disconnect();
    expect(clearNumberIdCache).toHaveBeenCalledTimes(1);
  });
});
