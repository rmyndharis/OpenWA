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
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';
import { BaileysAdapter } from './baileys.adapter';
import type { StoredChatPreview, StoredChatPreviewSource } from './baileys-stored-chat-previews.service';

/**
 * A new Baileys engine lists the chats the gateway stored messages of, read on its first connect while no
 * socket exists, for the account its credentials name (#1978).
 */
describe('Baileys listing seeded from the stored messages', () => {
  const linked = { me: { id: '628999:7@s.whatsapp.net', name: 'Desk' }, account: { details: 'signed' } };
  const rows: StoredChatPreview[] = [{ chatId: '628111@c.us', id: 'M1', fromMe: false, timestamp: 1_762_000_000 }];

  function engine(creds: Record<string, unknown>, source?: StoredChatPreviewSource) {
    const noCallback = (): undefined => undefined;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const seedStoredPreviews = jest.fn();
    const host = {
      authPath: '/nonexistent/openwa-stored-previews-spec/session-1',
      logger,
      config: {
        sessionId: 'session-1',
        dbSessionId: 'session-1',
        authDir: '/nonexistent/openwa-stored-previews-spec',
        storedChatPreviews: source,
      },
      liveCalls: new Map(),
      seedStoredPreviews,
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;
    jest
      .mocked(useAtomicMultiFileAuthState)
      .mockResolvedValue({ state: { creds, keys: {} }, saveCreds: jest.fn().mockResolvedValue(undefined) } as never);
    const makeWASocket = jest.mocked(BaileysLib.default as unknown as jest.Mock);
    makeWASocket.mockReset().mockReturnValue({
      ws: { isOpen: false, isConnecting: false, on: jest.fn() },
      ev: { on: jest.fn(), removeAllListeners: jest.fn() },
      end: jest.fn(),
    });
    const lifecycle = new BaileysLifecycle(host);
    const resolver = (lifecycle as unknown as { versionResolver: { resolve: () => Promise<number[]> } })
      .versionResolver;
    const resolveVersion = jest.spyOn(resolver, 'resolve').mockResolvedValue([2, 3000, 1]);
    /** A connect after the first, as the reconnect after a QR scan or a dropped socket runs it. */
    const reconnect = (): Promise<void> => (lifecycle as unknown as { connectInner(): Promise<void> }).connectInner();
    return { lifecycle, logger, seedStoredPreviews, makeWASocket, resolveVersion, reconnect };
  }

  afterEach(() => {
    delete process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES;
  });

  it('seeds the rows of the linked account, every spelling of it, before the socket is built', async () => {
    process.env.BAILEYS_SESSION_STORE_MAX_ENTRIES = '300';
    const latestPerChat = jest.fn().mockResolvedValue(rows);
    const { lifecycle, seedStoredPreviews, makeWASocket } = engine(linked, { latestPerChat });

    await lifecycle.initialize();

    expect(latestPerChat).toHaveBeenCalledWith('session-1', ['628999@c.us', '628999@s.whatsapp.net', '628999'], 300);
    expect(seedStoredPreviews).toHaveBeenCalledWith(rows);
    expect(seedStoredPreviews.mock.invocationCallOrder[0]).toBeLessThan(makeWASocket.mock.invocationCallOrder[0]);
    await lifecycle.destroy();
  });

  it('reads once per engine, not on a later connect', async () => {
    const latestPerChat = jest.fn().mockResolvedValue(rows);
    const { lifecycle, reconnect } = engine(linked, { latestPerChat });

    await lifecycle.initialize();
    await reconnect();

    expect(latestPerChat).toHaveBeenCalledTimes(1);
    await lifecycle.destroy();
  });

  it('leaves a first link to history sync, also on the connect after the scan', async () => {
    const latestPerChat = jest.fn().mockResolvedValue(rows);
    const creds: Record<string, unknown> = {};
    const { lifecycle, reconnect, makeWASocket } = engine(creds, { latestPerChat });

    await lifecycle.initialize();
    Object.assign(creds, linked); // the scan wrote the account
    await reconnect();

    expect(makeWASocket).toHaveBeenCalledTimes(2);
    expect(latestPerChat).not.toHaveBeenCalled();
    await lifecycle.destroy();
  });

  it('reads nothing for a pairing code that was never entered', async () => {
    const latestPerChat = jest.fn().mockResolvedValue(rows);
    const { lifecycle } = engine({ me: linked.me }, { latestPerChat });

    await lifecycle.initialize();

    expect(latestPerChat).not.toHaveBeenCalled();
    await lifecycle.destroy();
  });

  it('opens the socket all the same when the read fails, or when no reader is wired', async () => {
    const failing = engine(linked, { latestPerChat: jest.fn().mockRejectedValue(new Error('SQLITE_BUSY')) });
    await failing.lifecycle.initialize();
    expect(failing.makeWASocket).toHaveBeenCalledTimes(1);
    expect(failing.seedStoredPreviews).not.toHaveBeenCalled();
    expect(failing.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Could not read the stored chats/), {
      sessionId: 'session-1',
      error: 'SQLITE_BUSY',
    });
    await failing.lifecycle.destroy();

    const unwired = engine(linked);
    await unwired.lifecycle.initialize();
    expect(unwired.makeWASocket).toHaveBeenCalledTimes(1);
    await unwired.lifecycle.destroy();
  });

  it('builds no socket for an engine torn down while the read was out', async () => {
    let answer!: (value: StoredChatPreview[]) => void;
    const latestPerChat = jest.fn(() => new Promise<StoredChatPreview[]>(resolve => (answer = resolve)));
    const { lifecycle, makeWASocket, resolveVersion } = engine(linked, { latestPerChat });

    const started = lifecycle.initialize();
    await new Promise(resolve => setImmediate(resolve));
    expect(latestPerChat).toHaveBeenCalledTimes(1);
    await lifecycle.destroy();
    answer(rows);
    await started;

    // Resolving the version builds a fetch dispatcher that nothing would close.
    expect(resolveVersion).not.toHaveBeenCalled();
    expect(makeWASocket).not.toHaveBeenCalled();
  });

  it('gives up a read that takes over ten seconds, opens the socket without it, and drops a late answer', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      let answer!: (value: StoredChatPreview[]) => void;
      const latestPerChat = jest.fn(() => new Promise<StoredChatPreview[]>(resolve => (answer = resolve)));
      const { lifecycle, logger, seedStoredPreviews, makeWASocket } = engine(linked, { latestPerChat });

      const started = lifecycle.initialize();
      await new Promise(resolve => setImmediate(resolve));
      expect(latestPerChat).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(makeWASocket).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await started;

      expect(makeWASocket).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Could not read the stored chats/), {
        sessionId: 'session-1',
        error: 'no answer within 10000 ms',
      });
      answer(rows);
      await new Promise(resolve => setImmediate(resolve));
      expect(seedStoredPreviews).not.toHaveBeenCalled();
      await lifecycle.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands the rows to the session store the adapter lists from', () => {
    const adapter = new BaileysAdapter({ sessionId: 'session-1', dbSessionId: 'session-1', authDir: '/nonexistent' });
    const host = (adapter as unknown as { lifecycle: { host: BaileysLifecycleHost } }).lifecycle.host;

    host.seedStoredPreviews(rows);

    const store = (adapter as unknown as { sessionStore: { listChats(): { id: string }[] } }).sessionStore;
    expect(store.listChats().map(chat => chat.id)).toEqual(['628111@c.us']);
  });
});
