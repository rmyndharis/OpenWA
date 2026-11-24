jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401, forbidden: 403, restartRequired: 515, connectionReplaced: 440 },
  initAuthCreds: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn((keys: unknown) => keys),
}));
jest.mock('./baileys-auth-store', () => ({
  useAtomicMultiFileAuthState: jest.fn().mockRejectedValue(new Error('stop after auth load')),
}));

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as qrcode from 'qrcode';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import * as BaileysLib from '@whiskeysockets/baileys';
import { useAtomicMultiFileAuthState } from './baileys-auth-store';
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';
import type { BaileysVersionResolver, ResolveOptions } from './baileys-version-resolver';

describe('BaileysLifecycle.connect', () => {
  it('loads the auth state through the atomic store with the session auth dir, library and logger', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const noCallback = (): undefined => undefined;
    const host = {
      authPath: '/data/baileys/session-sess-1',
      logger,
      config: { sessionId: 'sess-1' },
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;

    await expect(new BaileysLifecycle(host).initialize()).rejects.toThrow('stop after auth load');

    expect(useAtomicMultiFileAuthState).toHaveBeenCalledTimes(1);
    const [folder, lib, authLogger] = jest.mocked(useAtomicMultiFileAuthState).mock.calls[0];
    expect(folder).toBe(host.authPath);
    expect(lib.initAuthCreds).toBe(BaileysLib.initAuthCreds);
    expect(authLogger).toBe(logger);
  });
});

describe('BaileysLifecycle unlink cleanup', () => {
  function lifecycle() {
    const noCallback = (): undefined => undefined;
    const fenceStoredWrites = jest.fn();
    const messageStore = { clearSession: jest.fn().mockResolvedValue(undefined) };
    const host = {
      authPath: '/nonexistent/openwa-lifecycle-spec/session-sess-1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: { sessionId: 'sess-1', dbSessionId: 'db-1', messageStore },
      liveCalls: new Map(),
      fenceStoredWrites,
      getOnStateChanged: noCallback,
      getOnDisconnected: noCallback,
      getOnError: noCallback,
      getOnCredentialTeardownStarted: noCallback,
    } as unknown as BaileysLifecycleHost;
    const sock = {
      user: { id: '628999:1@s.whatsapp.net' },
      authState: { creds: { me: { id: '628999:1@s.whatsapp.net' }, account: {} } },
      query: jest.fn().mockResolvedValue({ tag: 'iq' }),
      generateMessageTag: () => 'tag-1',
      end: jest.fn(),
    };
    const engine = new BaileysLifecycle(host);
    engine.sock = sock as unknown as BaileysLifecycle['sock'];
    return { engine, fenceStoredWrites, clearSession: messageStore.clearSession };
  }

  // A message still being processed must not recreate a row of the unlinked account after its store
  // is wiped, so the store writes are fenced first.
  it('fences stored writes before wiping the message store on an API logout', async () => {
    const { engine, fenceStoredWrites, clearSession } = lifecycle();
    await engine.logout();
    expect(clearSession).toHaveBeenCalledWith('db-1');
    expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
    expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
  });

  it('fences stored writes before wiping the message store on a WhatsApp-side logout', async () => {
    const { engine, fenceStoredWrites, clearSession } = lifecycle();
    await (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut();
    expect(clearSession).toHaveBeenCalledWith('db-1');
    expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
    expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
  });
});

describe('BaileysLifecycle QR refresh', () => {
  // Exercise the promise overload used by the adapter, rather than qrcode's
  // callback overload (whose return type is void).
  const renderQr = jest.mocked(qrcode.toDataURL as (qr: string) => Promise<string>);
  type Renderer = {
    handleQrCode: (qr: string) => Promise<void>;
    qrCode: string | null;
    sock: unknown;
    status: EngineStatus;
  };
  function fixture() {
    const onQRCode = jest.fn(),
      noCallback = () => undefined;
    const host = {
      authPath: '/fixture',
      config: { sessionId: 'fixture' },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getOnQRCode: () => onQRCode,
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;
    const lifecycle = new BaileysLifecycle(host);
    const renderer = lifecycle as unknown as Renderer;
    renderer.sock = { ws: { isOpen: true } };
    renderer.status = EngineStatus.QR_READY;
    renderer.qrCode = 'retired-image';
    return { renderer, onQRCode };
  }
  it('clears a retired image immediately and ignores a slow older render', async () => {
    const { renderer, onQRCode } = fixture();
    let finishOld!: (image: string) => void, finishNew!: (image: string) => void;
    renderQr
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishNew = resolve;
          }),
      );
    const old = renderer.handleQrCode('retired-secret');
    expect(renderer.qrCode).toBeNull();
    const fresh = renderer.handleQrCode('current-secret');
    expect(renderer.qrCode).toBeNull();
    finishNew('current-image');
    await fresh;
    finishOld('retired-image');
    await old;
    expect(renderer.qrCode).toBe('current-image');
    expect(onQRCode).toHaveBeenCalledTimes(1);
    expect(onQRCode).toHaveBeenCalledWith('current-image');
  });
  it.each([EngineStatus.AUTHENTICATING, EngineStatus.READY])(
    'does not publish a pending render after linking enters %s',
    async status => {
      const { renderer, onQRCode } = fixture();
      let finish!: (image: string) => void;
      renderQr.mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finish = resolve;
          }),
      );
      const pending = renderer.handleQrCode('pending');
      renderer.status = status;
      finish('expired-image');
      await pending;
      expect(renderer.qrCode).toBeNull();
      expect(onQRCode).not.toHaveBeenCalled();
    },
  );
  it('discards a pending render after the socket acquires a pairing-code identity', async () => {
    const { renderer, onQRCode } = fixture();
    let finish!: (image: string) => void;
    renderQr.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    );
    const pending = renderer.handleQrCode('pending');
    (renderer.sock as { user?: { id: string } }).user = { id: 'fixture@s.whatsapp.net' };
    finish('expired-image');
    await pending;
    expect(renderer.qrCode).toBeNull();
    expect(onQRCode).not.toHaveBeenCalled();
  });
});

describe('BaileysLifecycle proxy fetch dispatcher', () => {
  function lifecycle() {
    const noCallback = (): undefined => undefined;
    const host = {
      authPath: '/nonexistent/openwa-lifecycle-spec/session-sess-1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: {
        sessionId: 'sess-1',
        dbSessionId: 'db-1',
        proxyUrl: 'http://user:pass@proxy.example:8080',
        messageStore: { clearSession: jest.fn().mockResolvedValue(undefined) },
      },
      liveCalls: new Map(),
      fenceStoredWrites: jest.fn(),
      getOnStateChanged: noCallback,
      getOnDisconnected: noCallback,
      getOnError: noCallback,
      getOnCredentialTeardownStarted: noCallback,
    } as unknown as BaileysLifecycleHost;
    const engine = new BaileysLifecycle(host);
    engine.sock = {
      user: { id: '628999:1@s.whatsapp.net' },
      authState: { creds: { me: { id: '628999:1@s.whatsapp.net' }, account: {} } },
      query: jest.fn().mockResolvedValue({ tag: 'iq' }),
      generateMessageTag: () => 'tag-1',
      end: jest.fn(),
    } as unknown as BaileysLifecycle['sock'];
    return engine;
  }

  // The pooled proxy tunnels must not outlive the session: teardown closes the dispatcher (gracefully,
  // so a request already in progress still finishes) and forgets it, so a later fetch gets a fresh one.
  it.each([
    ['disconnect', (engine: BaileysLifecycle) => engine.disconnect()],
    ['destroy', (engine: BaileysLifecycle) => engine.destroy()],
    ['logout', (engine: BaileysLifecycle) => engine.logout()],
    [
      'a failed logout',
      async (engine: BaileysLifecycle) => {
        jest.mocked(engine.sock!.query).mockRejectedValue(new Error('timed out'));
        await expect(engine.logout()).rejects.toThrow('timed out');
      },
    ],
    [
      'a WhatsApp-side logout',
      (engine: BaileysLifecycle) =>
        (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut(),
    ],
  ])('closes the dispatcher on %s and builds a fresh one afterwards', async (_name, teardown) => {
    const engine = lifecycle();
    const dispatcher = engine.fetchDispatcher();
    if (!dispatcher) throw new Error('Expected a proxy dispatcher');
    const close = jest.spyOn(dispatcher, 'close');
    const destroy = jest.spyOn(dispatcher, 'destroy');

    await teardown(engine);

    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    const fresh = engine.fetchDispatcher();
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(dispatcher);
    await fresh?.close();
  });

  describe('teardown while connecting', () => {
    const settle = () => new Promise(resolve => setImmediate(resolve));
    function connecting() {
      const engine = lifecycle();
      engine.sock = null;
      type AuthState = Awaited<ReturnType<typeof useAtomicMultiFileAuthState>>;
      let releaseAuth: ((value: AuthState) => void) | undefined;
      jest.mocked(useAtomicMultiFileAuthState).mockImplementationOnce(
        () =>
          new Promise<AuthState>(resolve => {
            releaseAuth = resolve;
          }),
      );
      const resolver = (engine as unknown as { versionResolver: BaileysVersionResolver }).versionResolver;
      const resolve = jest.spyOn(resolver, 'resolve');
      const authRequested = async () => {
        while (!releaseAuth) await settle();
      };
      const loadAuth = () =>
        releaseAuth?.({ state: { creds: {}, keys: {} }, saveCreds: jest.fn() } as unknown as AuthState);
      return { engine, resolve, authRequested, loadAuth };
    }

    // Opening the auth state creates the session's directory, which a deleted session no longer has.
    it('does not open the auth state when the session stops while the library loads', async () => {
      const engine = lifecycle();
      engine.sock = null;
      let finishLibrary: (lib: typeof BaileysLib) => void = () => undefined;
      jest.spyOn(engine, 'loadLib').mockReturnValueOnce(
        new Promise<typeof BaileysLib>(resolve => {
          finishLibrary = resolve;
        }),
      );
      jest.mocked(useAtomicMultiFileAuthState).mockClear();
      const init = engine.initialize();
      await engine.destroy();
      finishLibrary(BaileysLib);
      await init;

      expect(useAtomicMultiFileAuthState).not.toHaveBeenCalled();
      expect(engine.sock).toBeNull();
    });

    // The teardown closed the only dispatcher there was; a lookup after it would build one nothing
    // closes and send a stopped session's requests through its proxy.
    it('skips the version lookup when the session stops while its auth state loads', async () => {
      const { engine, resolve, authRequested, loadAuth } = connecting();
      const init = engine.initialize();
      await authRequested();
      await engine.disconnect();
      loadAuth();
      await init;

      expect(resolve).not.toHaveBeenCalled();
      expect((engine as unknown as { dispatcher?: unknown }).dispatcher).toBeUndefined();
      expect(engine.sock).toBeNull();
    });

    it('aborts the version lookup when the session stops during it', async () => {
      const { engine, resolve, authRequested, loadAuth } = connecting();
      let signal: AbortSignal | undefined;
      let finish: ((version: [number, number, number]) => void) | undefined;
      resolve.mockImplementationOnce(
        (_lib, options?: ResolveOptions) =>
          new Promise(done => {
            signal = options?.signal;
            finish = done;
          }),
      );
      const init = engine.initialize();
      await authRequested();
      loadAuth();
      while (!finish) await settle();
      expect(signal?.aborted).toBe(false);

      await engine.destroy();

      expect(signal?.aborted).toBe(true);
      finish([2, 3000, 1]);
      await init;
      expect(engine.sock).toBeNull();
    });
  });
});

describe('BaileysLifecycle socket fencing, one-shot remote logout, held chats, and proxy agent cleanup', () => {
  const makeFakeSock = () => {
    const ev = new EventEmitter();
    const ws = Object.assign(new EventEmitter(), { isOpen: true, isConnecting: false });
    const removeAllListenersSpy = jest.spyOn(ev, 'removeAllListeners');
    const end = jest.fn();
    return {
      ev,
      ws,
      removeAllListenersSpy,
      end,
      user: { id: '628999:1@s.whatsapp.net', name: 'Tester' },
      authState: { creds: { me: { id: '628999:1@s.whatsapp.net', name: 'Tester' }, account: {} } },
      query: jest.fn().mockResolvedValue({ tag: 'iq' }),
      generateMessageTag: () => 'tag-1',
      fetchAccountReachoutTimelock: jest.fn().mockResolvedValue(undefined),
      requestPairingCode: jest.fn().mockResolvedValue('ABCD1234'),
    };
  };

  function makeConnectedHost(overrides: Partial<BaileysLifecycleHost> = {}) {
    const noCallback = (): undefined => undefined;
    const upsertChats = jest.fn();
    const onReady = jest.fn();
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    const onAccountRestriction = jest.fn();
    const onCredentialTeardownStarted = jest.fn();
    const fenceStoredWrites = jest.fn();
    const clearSession = jest.fn().mockResolvedValue(undefined);
    const host = {
      authPath: '/nonexistent/openwa-lifecycle-fence-spec/session-1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: {
        sessionId: 'sess-fence',
        dbSessionId: 'db-fence',
        proxyUrl: 'http://user:pass@proxy.example:8080',
        messageStore: { clearSession },
      },
      liveCalls: new Map(),
      extractPhone: (id?: string) => (id ? id.split(':')[0].split('@')[0] : null),
      toNeutralJid: (jid: string) => jid,
      upsertContacts: jest.fn(),
      upsertChats,
      removeChats: jest.fn(),
      seedStoredPreviews: jest.fn(),
      addLidMappings: jest.fn(),
      handleMessagesUpsert: jest.fn(),
      handleMessagesUpdate: jest.fn(),
      handleMessageReceiptUpdate: jest.fn(),
      logContactEvent: jest.fn(),
      handleGroupParticipantsUpdate: jest.fn(),
      handleGroupsUpdate: jest.fn(),
      handleGroupsUpsert: jest.fn(),
      handleGroupJoinRequest: jest.fn(),
      handleCallEvents: jest.fn(),
      handlePresenceUpdate: jest.fn(),
      fenceStoredWrites,
      captureHistoryMessages: jest.fn().mockResolvedValue(undefined),
      hydrateNames: jest.fn().mockResolvedValue(undefined),
      restoreAddressbookSnapshot: jest.fn().mockResolvedValue(undefined),
      getOnQRCode: noCallback,
      getOnReady: () => onReady,
      getOnPushNameChanged: noCallback,
      getOnDisconnected: () => onDisconnected,
      getOnReconnecting: noCallback,
      getOnError: () => onError,
      getOnStateChanged: noCallback,
      getOnCredentialTeardownStarted: () => onCredentialTeardownStarted,
      getOnAccountRestriction: () => onAccountRestriction,
      ...overrides,
    } as unknown as BaileysLifecycleHost;
    return {
      host,
      upsertChats,
      onReady,
      onDisconnected,
      onError,
      onAccountRestriction,
      onCredentialTeardownStarted,
      fenceStoredWrites,
      clearSession,
    };
  }

  async function initLifecycleWithSocks(
    socks: ReturnType<typeof makeFakeSock>[],
    hostOverrides: Partial<BaileysLifecycleHost> = {},
  ) {
    const mocks = makeConnectedHost(hostOverrides);
    const engine = new BaileysLifecycle(mocks.host);
    const createdAgents: Array<{ destroy: jest.Mock }> = [];
    let sockIdx = 0;
    jest.mocked(BaileysLib.default).mockImplementation((opts: { agent?: { destroy: () => void } }) => {
      if (opts.agent) {
        const destroySpy = jest.spyOn(opts.agent, 'destroy') as unknown as jest.Mock;
        createdAgents.push({ destroy: destroySpy });
      }
      return socks[sockIdx++] as unknown as ReturnType<typeof BaileysLib.default>;
    });
    jest.mocked(useAtomicMultiFileAuthState).mockResolvedValue({
      state: { creds: { me: { id: '628999:1@s.whatsapp.net', name: 'Tester' }, account: {} }, keys: {} },
      saveCreds: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof useAtomicMultiFileAuthState>>);
    const resolver = (engine as unknown as { versionResolver: BaileysVersionResolver }).versionResolver;
    jest.spyOn(resolver, 'resolve').mockResolvedValue([2, 3000, 1]);

    await engine.initialize();
    return { engine, createdAgents, ...mocks };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(useAtomicMultiFileAuthState).mockRejectedValue(new Error('stop after auth load'));
  });

  it.each([
    ['disconnect', (engine: BaileysLifecycle) => engine.disconnect()],
    ['destroy', (engine: BaileysLifecycle) => engine.destroy()],
    ['logout', (engine: BaileysLifecycle) => engine.logout()],
    [
      'handleRemoteLoggedOut',
      (engine: BaileysLifecycle) =>
        (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut(),
    ],
  ])('detaches all 18 socket event listeners before end() and destroys the proxy agent on %s', async (_name, stop) => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const sock = makeFakeSock();
    const { engine, createdAgents } = await initLifecycleWithSocks([sock]);
    sock.removeAllListenersSpy.mockClear();

    await stop(engine);

    expect(sock.removeAllListenersSpy).toHaveBeenCalledTimes(18);
    expect(sock.end).toHaveBeenCalledWith(undefined);
    const lastDetachOrder = Math.max(...sock.removeAllListenersSpy.mock.invocationCallOrder);
    expect(lastDetachOrder).toBeLessThan(sock.end.mock.invocationCallOrder[0]);
    expect(createdAgents[0].destroy).toHaveBeenCalledTimes(1);
    rmSpy.mockRestore();
  });

  it('ignores stale socket connection.update and ws events, and ignores non-close updates during intentionalClose', async () => {
    const sock1 = makeFakeSock();
    const sock2 = makeFakeSock();
    const { engine, onReady, onAccountRestriction, createdAgents } = await initLifecycleWithSocks([sock1, sock2]);

    // Trigger reconnect by invoking connect() directly to swap sock1 -> sock2.
    await (engine as unknown as { connect(): Promise<void> }).connect();
    expect(engine.sock).toBe(sock2);
    // Previous socket's proxy agent is destroyed when replaced.
    expect(createdAgents[0].destroy).toHaveBeenCalledTimes(1);

    // Late ws events on stale sock1 must be ignored.
    sock1.end.mockClear();
    sock1.ws.emit('CB:notification,type:passkey_prologue_request');
    sock1.ws.emit('unexpected-response', {}, { statusCode: 503 });
    expect(onAccountRestriction).not.toHaveBeenCalled();
    expect(sock1.end).not.toHaveBeenCalled();

    // Direct connection.update for stale sock1 must be ignored.
    (
      engine as unknown as {
        handleConnectionUpdate: (update: { connection?: string }, sock?: unknown) => void;
      }
    ).handleConnectionUpdate({ connection: 'open' }, sock1);
    expect(onReady).not.toHaveBeenCalled();

    // During intentionalClose (e.g. while logout() awaits IQ response), non-close updates are ignored
    // while connection === 'close' transitions to DISCONNECTED.
    let resolveLogout!: (v: unknown) => void;
    sock2.query.mockReturnValueOnce(new Promise(r => (resolveLogout = r)));
    const logoutPromise = engine.logout();
    sock2.ev.emit('connection.update', { connection: 'open' });
    expect(onReady).not.toHaveBeenCalled();
    expect(engine.getStatus()).not.toBe(EngineStatus.READY);

    sock2.ev.emit('connection.update', { connection: 'close' });
    expect(engine.getStatus()).toBe(EngineStatus.DISCONNECTED);

    resolveLogout({ tag: 'iq' });
    await logoutPromise;
    expect(createdAgents[1].destroy).toHaveBeenCalledTimes(1);
  });

  it('makes handleRemoteLoggedOut one-shot and clears pending timers', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const sock = makeFakeSock();
      const { engine, onDisconnected, onCredentialTeardownStarted, fenceStoredWrites } = await initLifecycleWithSocks(
        [sock],
        {
          config: {
            sessionId: 'sess-fence',
            dbSessionId: 'db-fence',
            messageStore: { clearSession: jest.fn().mockResolvedValue(undefined) },
          } as unknown as BaileysLifecycleHost['config'],
        },
      );

      // Arm pairing window (2 timers), addressbook restore (1 timer), and reconnect timer (1 timer),
      // in addition to connectingTimer (1 timer) armed by connectInner.
      (engine as unknown as { status: EngineStatus }).status = EngineStatus.QR_READY;
      await engine.requestPairingCode('628123456789');
      (engine as unknown as { scheduleAddressbookRestore(s: unknown): void }).scheduleAddressbookRestore(sock);
      (engine as unknown as { scheduleReconnect(): void }).scheduleReconnect();
      expect(jest.getTimerCount()).toBe(5);

      const handleRemote = (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut.bind(
        engine,
      );
      await Promise.all([handleRemote(), handleRemote()]);

      expect(jest.getTimerCount()).toBe(0);
      expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
      expect(onCredentialTeardownStarted).toHaveBeenCalledTimes(1);
      expect(onDisconnected).toHaveBeenCalledTimes(1);
      expect(rmSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('drops queued held-chat microtasks when torn down before the microtask runs', async () => {
    const sock = makeFakeSock();
    const { engine, upsertChats } = await initLifecycleWithSocks([sock]);

    (engine as unknown as { hold(chat: { id: string }, merged: boolean): void }).hold(
      { id: '628111@s.whatsapp.net' },
      false,
    );
    await engine.disconnect();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));

    expect(upsertChats).not.toHaveBeenCalled();
  });

  it('drops stale held-chat microtasks across a real reconnect swap while allowing the new socket to flush', async () => {
    const sock1 = makeFakeSock();
    const sock2 = makeFakeSock();
    const { engine, upsertChats } = await initLifecycleWithSocks([sock1, sock2]);
    const resolver = (engine as unknown as { versionResolver: BaileysVersionResolver }).versionResolver;
    let releaseVersion!: (v: [number, number, number]) => void;
    jest.spyOn(resolver, 'resolve').mockImplementationOnce(
      () =>
        new Promise<[number, number, number]>(resolve => {
          releaseVersion = resolve;
        }),
    );

    const reconnect = (engine as unknown as { connect(): Promise<void> }).connect();
    while (!releaseVersion) await new Promise(resolve => setImmediate(resolve));

    // Resolve version first (queues connectInner continuation to swap sock1 -> sock2 and call resetHeldChats),
    // then synchronously queue a held chat from sock1 in the same turn so its microtask runs AFTER the swap.
    releaseVersion([2, 3000, 1]);
    (engine as unknown as { hold(chat: { id: string }, merged: boolean): void }).hold(
      { id: '628111@s.whatsapp.net' },
      false,
    );
    await reconnect;
    expect(engine.sock).toBe(sock2);
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));

    expect(upsertChats).not.toHaveBeenCalled();

    // A held chat queued on the new socket still flushes normally.
    (engine as unknown as { hold(chat: { id: string }, merged: boolean): void }).hold(
      { id: '628222@s.whatsapp.net' },
      false,
    );
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));

    const flattened = upsertChats.mock.calls.flatMap(([batch]) => batch as Array<{ id?: string }>);
    expect(flattened.map(c => c.id)).toEqual(['628222@s.whatsapp.net']);
  });

  it('destroys a newly created proxy agent if connectInner fails before adopting it', async () => {
    const { host } = makeConnectedHost();
    const engine = new BaileysLifecycle(host);
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const destroySpy = jest.spyOn(HttpsProxyAgent.prototype, 'destroy');
    jest.mocked(useAtomicMultiFileAuthState).mockRejectedValueOnce(new Error('auth failed'));

    await expect(engine.initialize()).rejects.toThrow('auth failed');

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('destroys the proxy agent and cleans up socket if listener wiring throws during connectInner', async () => {
    const { host } = makeConnectedHost();
    const engine = new BaileysLifecycle(host);
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const destroySpy = jest.spyOn(HttpsProxyAgent.prototype, 'destroy');
    const brokenSock = makeFakeSock();
    jest.spyOn(brokenSock.ev, 'on').mockImplementationOnce(() => {
      throw new Error('ev wire failure');
    });
    jest.mocked(BaileysLib.default).mockReturnValueOnce(brokenSock as unknown as ReturnType<typeof BaileysLib.default>);
    jest.mocked(useAtomicMultiFileAuthState).mockResolvedValueOnce({
      state: { creds: {}, keys: {} },
      saveCreds: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof useAtomicMultiFileAuthState>>);
    const resolver = (engine as unknown as { versionResolver: BaileysVersionResolver }).versionResolver;
    jest.spyOn(resolver, 'resolve').mockResolvedValueOnce([2, 3000, 1]);

    await expect(engine.initialize()).rejects.toThrow('ev wire failure');

    expect(engine.sock).toBeNull();
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(brokenSock.end).toHaveBeenCalledWith(undefined);
  });

  it('destroys a newly created proxy agent if teardown occurs before connectInner adopts it', async () => {
    const { host } = makeConnectedHost();
    const engine = new BaileysLifecycle(host);
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const destroySpy = jest.spyOn(HttpsProxyAgent.prototype, 'destroy');
    let releaseAuth!: () => void;
    jest.mocked(useAtomicMultiFileAuthState).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseAuth = () =>
            resolve({
              state: { creds: {}, keys: {} },
              saveCreds: jest.fn(),
            } as unknown as Awaited<ReturnType<typeof useAtomicMultiFileAuthState>>);
        }),
    );

    const init = engine.initialize();
    while (!releaseAuth) await new Promise(resolve => setImmediate(resolve));
    await engine.disconnect();
    releaseAuth();
    await init;

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it.each([440, 403])(
    'detaches listeners, nulls sock, closes dispatcher, destroys proxy agent, and blocks follow-up close on terminal %i',
    async statusCode => {
      const sock = makeFakeSock();
      const { engine, createdAgents, onError } = await initLifecycleWithSocks([sock]);
      const dispatcher = engine.fetchDispatcher();
      if (!dispatcher) throw new Error('Expected proxy dispatcher');
      const closeDispatcher = jest.spyOn(dispatcher, 'close');
      sock.removeAllListenersSpy.mockClear();

      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode } } },
      });

      expect(engine.getStatus()).toBe(EngineStatus.FAILED);
      expect(engine.sock).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(sock.removeAllListenersSpy).toHaveBeenCalledTimes(18);
      expect(sock.end).toHaveBeenCalledWith(undefined);
      const lastDetachOrder = Math.max(...sock.removeAllListenersSpy.mock.invocationCallOrder);
      expect(lastDetachOrder).toBeLessThan(sock.end.mock.invocationCallOrder[0]);
      expect(createdAgents[0].destroy).toHaveBeenCalledTimes(1);
      expect(closeDispatcher).toHaveBeenCalledTimes(1);

      // Duplicate terminal close or a subsequent plain close must neither re-emit onError nor schedule reconnect.
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode } } },
      });
      sock.ev.emit('connection.update', { connection: 'close' });
      (engine as unknown as { handleConnectionUpdate(update: { connection?: string }): void }).handleConnectionUpdate({
        connection: 'close',
      });

      expect(engine.getStatus()).toBe(EngineStatus.FAILED);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((engine as unknown as { reconnectTimer?: unknown }).reconnectTimer).toBeUndefined();
    },
  );

  it('aborts teardown on handleRemoteLoggedOut so concurrent connect and re-initialize cannot open a new socket', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const sock1 = makeFakeSock();
      const sock2 = makeFakeSock();
      const { engine } = await initLifecycleWithSocks([sock1, sock2]);
      jest.mocked(BaileysLib.default).mockClear();

      await (engine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut();

      // Re-initializing a single-use logged-out adapter must be a no-op.
      await engine.initialize();
      expect(engine.sock).toBeNull();
      expect(BaileysLib.default).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('discards an in-flight QR render if intentionalClose latches or status becomes FAILED or DISCONNECTED', async () => {
    const renderQr = jest.mocked(qrcode.toDataURL as (qr: string) => Promise<string>);
    const onQRCode = jest.fn();
    const sock = makeFakeSock();
    (sock as { user?: unknown }).user = undefined;
    const { engine } = await initLifecycleWithSocks([sock], { getOnQRCode: () => onQRCode });

    let finishRender!: (img: string) => void;
    renderQr.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishRender = resolve;
        }),
    );

    const pending = (engine as unknown as { handleQrCode(qr: string): Promise<void> }).handleQrCode('raw-qr');
    // Abort teardown while sock is still assigned and open (as during logout()).
    (engine as unknown as { teardown: AbortController }).teardown.abort();
    finishRender('data:image/png;base64,LATE');
    await pending;

    expect(engine.getQRCode()).toBeNull();
    expect(onQRCode).not.toHaveBeenCalled();

    // Also guard against terminal FAILED / DISCONNECTED even if teardown has not aborted.
    const sock2 = makeFakeSock();
    (sock2 as { user?: unknown }).user = undefined;
    const { engine: engine2 } = await initLifecycleWithSocks([sock2], { getOnQRCode: () => onQRCode });
    let finishRender2!: (img: string) => void;
    renderQr.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishRender2 = resolve;
        }),
    );
    const pending2 = (engine2 as unknown as { handleQrCode(qr: string): Promise<void> }).handleQrCode('raw-qr-2');
    (engine2 as unknown as { status: EngineStatus }).status = EngineStatus.FAILED;
    finishRender2('data:image/png;base64,LATE2');
    await pending2;

    expect(engine2.getQRCode()).toBeNull();
    expect(onQRCode).not.toHaveBeenCalled();
  });
});

describe('BaileysLifecycle teardown fencing and dispatcher cleanup', () => {
  const makeHost = (inboundLimiter: ConcurrencyLimiter) => {
    const noCallback = (): undefined => undefined;
    const fenceStoredWrites = jest.fn();
    const dispatcher = {
      destroy: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const host = {
      authPath: '/nonexistent/openwa-lifecycle-teardown/session-s1',
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: { sessionId: 'sess-fence', dbSessionId: 'db-fence' },
      liveCalls: new Map(),
      inboundLimiter,
      fenceStoredWrites,
      getOnStateChanged: noCallback,
      getOnDisconnected: noCallback,
      getOnError: noCallback,
      getOnCredentialTeardownStarted: noCallback,
    } as unknown as BaileysLifecycleHost;
    return { host, fenceStoredWrites, dispatcher };
  };

  it('calls fenceStoredWrites and inboundLimiter.close on disconnect, destroy, and teardownTerminalClose', async () => {
    const limiter1 = new ConcurrencyLimiter(1);
    const h1 = makeHost(limiter1);
    const l1 = new BaileysLifecycle(h1.host);
    await l1.disconnect();
    expect(h1.fenceStoredWrites).toHaveBeenCalledTimes(1);
    await expect(limiter1.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);

    const limiter2 = new ConcurrencyLimiter(1);
    const h2 = makeHost(limiter2);
    const l2 = new BaileysLifecycle(h2.host);
    await l2.destroy();
    expect(h2.fenceStoredWrites).toHaveBeenCalledTimes(1);
    await expect(limiter2.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);

    const limiter3 = new ConcurrencyLimiter(1);
    const h3 = makeHost(limiter3);
    const l3 = new BaileysLifecycle(h3.host);
    (l3 as unknown as { teardownTerminalClose(reason: string): void }).teardownTerminalClose('logged_out');
    expect(h3.fenceStoredWrites).toHaveBeenCalledTimes(1);
    await expect(limiter3.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);
  });

  it('closes inboundLimiter on localSocketShutdown (logout) and handleRemoteLoggedOut', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const makeSock = () =>
      ({
        user: { id: '628999:1@s.whatsapp.net' },
        authState: { creds: { me: { id: '628999:1@s.whatsapp.net' }, account: {} } },
        query: jest.fn().mockResolvedValue({ tag: 'iq' }),
        generateMessageTag: () => 'tag-1',
        end: jest.fn(),
        ev: { removeAllListeners: jest.fn() },
      }) as unknown as BaileysLifecycle['sock'];
    try {
      const limiterLocal = new ConcurrencyLimiter(1);
      const localHost = makeHost(limiterLocal);
      const localEngine = new BaileysLifecycle(localHost.host);
      localEngine.sock = makeSock();
      await localEngine.logout();
      expect(localHost.fenceStoredWrites).toHaveBeenCalledTimes(1);
      await expect(limiterLocal.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);

      const limiterFailedLogout = new ConcurrencyLimiter(1);
      const failedHost = makeHost(limiterFailedLogout);
      const failedEngine = new BaileysLifecycle(failedHost.host);
      const failingSock = makeSock();
      jest.mocked(failingSock!.query).mockRejectedValueOnce(new Error('iq timeout'));
      failedEngine.sock = failingSock;
      await expect(failedEngine.logout()).rejects.toThrow('iq timeout');
      await expect(limiterFailedLogout.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);

      const limiterRemote = new ConcurrencyLimiter(1);
      const remoteHost = makeHost(limiterRemote);
      const remoteEngine = new BaileysLifecycle(remoteHost.host);
      remoteEngine.sock = makeSock();
      await (remoteEngine as unknown as { handleRemoteLoggedOut(): Promise<void> }).handleRemoteLoggedOut();
      expect(remoteHost.fenceStoredWrites).toHaveBeenCalledTimes(1);
      await expect(limiterRemote.run(() => Promise.resolve('x'))).rejects.toThrow(/closed/i);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('closes any pre-socket fetchDispatcher before throwing in pre-socket logout', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const { host, dispatcher } = makeHost(limiter);
    const lifecycle = new BaileysLifecycle(host);
    (lifecycle as unknown as { dispatcher: unknown }).dispatcher = dispatcher;

    await expect(lifecycle.logout()).rejects.toThrow(/No live WhatsApp socket/);
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    expect((lifecycle as unknown as { dispatcher: unknown }).dispatcher).toBeUndefined();
  });
});
