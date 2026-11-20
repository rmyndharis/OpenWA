jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  initAuthCreds: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn((keys: unknown) => keys),
  DisconnectReason: { loggedOut: 401, forbidden: 403, connectionReplaced: 440 },
}));
jest.mock('./baileys-auth-store', () => ({ useAtomicMultiFileAuthState: jest.fn() }));

import * as BaileysLib from '@whiskeysockets/baileys';
import { useAtomicMultiFileAuthState } from './baileys-auth-store';
import { BaileysLifecycle, createKeyCache, type BaileysLifecycleHost, type KeyCache } from './baileys-lifecycle';

describe('the key cache of a Baileys socket', () => {
  let clock: number;
  const cache = (ttlMs = 1000) => createKeyCache(ttlMs, () => clock);
  beforeEach(() => {
    clock = 0;
  });

  it('serves what was written until it is deleted or flushed', () => {
    const keys = cache();
    const value = { session: 'record' };
    keys.set('session.a', value);
    keys.set('session.b', 2);

    expect(keys.get('session.a')).toBe(value);
    expect(keys.get('session.missing')).toBeUndefined();
    expect(keys.del('session.b')).toBe(true);
    expect(keys.get('session.b')).toBeUndefined();
    keys.flushAll();
    expect(keys.get('session.a')).toBeUndefined();
    expect(keys.size).toBe(0);
  });

  it('drops an entry once its time has passed, when it is read and when the next one is written', () => {
    const keys = cache(1000);
    keys.set('a', 1);
    clock = 500;
    keys.set('b', 2);

    clock = 999;
    expect(keys.get('a')).toBe(1);
    clock = 1000;
    expect(keys.get('a')).toBeUndefined();
    expect(keys.size).toBe(1);

    clock = 1500;
    keys.set('c', 3);
    expect(keys.get('b')).toBeUndefined();
    expect(keys.size).toBe(1);
  });

  it('renews an entry that is written again, and still drops the older ones in front of it', () => {
    const keys = cache(1000);
    keys.set('a', 1);
    clock = 100;
    keys.set('b', 2);
    clock = 200;
    keys.set('a', 11);

    clock = 1150;
    keys.set('c', 3);

    expect(keys.size).toBe(2);
    expect(keys.get('a')).toBe(11);
    expect(keys.get('b')).toBeUndefined();
  });

  it('holds no timer, so a dropped cache is garbage', () => {
    jest.useFakeTimers();
    try {
      const keys = createKeyCache();
      keys.set('a', 1);
      expect(jest.getTimerCount()).toBe(0);

      jest.advanceTimersByTime(6 * 60_000);
      expect(keys.get('a')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BaileysLifecycle key store', () => {
  it('hands every socket it builds a key cache of its own', async () => {
    const noCallback = (): undefined => undefined;
    const host = {
      authPath: '/nonexistent/openwa-key-cache-spec/session-1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: { sessionId: 'session-1', dbSessionId: 'session-1', authDir: '/nonexistent/openwa-key-cache-spec' },
      liveCalls: new Map(),
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;
    jest
      .mocked(useAtomicMultiFileAuthState)
      .mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: jest.fn() } as never);
    const socket = () => ({
      ws: { isOpen: false, isConnecting: false, on: jest.fn() },
      ev: { on: jest.fn(), removeAllListeners: jest.fn() },
      end: jest.fn(),
    });
    jest
      .mocked(BaileysLib.default as unknown as jest.Mock)
      .mockReset()
      .mockImplementation(socket);
    const makeCacheable = jest.mocked(BaileysLib.makeCacheableSignalKeyStore);
    makeCacheable.mockClear();
    const lifecycle = new BaileysLifecycle(host);
    const resolver = (lifecycle as unknown as { versionResolver: { resolve: () => Promise<number[]> } })
      .versionResolver;
    jest.spyOn(resolver, 'resolve').mockResolvedValue([2, 3000, 1]);

    try {
      await lifecycle.initialize();
      // A reconnect builds the next socket the same way, and ends the previous one.
      await (lifecycle as unknown as { connectInner(): Promise<void> }).connectInner();
    } finally {
      await lifecycle.destroy();
    }

    expect(makeCacheable).toHaveBeenCalledTimes(2);
    const [first, second] = makeCacheable.mock.calls.map(call => call[2] as KeyCache);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    first.set('session.a', 1);
    expect(first.get('session.a')).toBe(1);
    expect(second.get('session.a')).toBeUndefined();
  });
});
