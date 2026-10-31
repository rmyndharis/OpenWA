jest.mock('@whiskeysockets/baileys', () => ({ __esModule: true }));

import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { BAILEYS_PAIRING_CODE_WINDOW_MS, BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';

/**
 * A pairing code links the device by number instead of by QR. Once one is requested the patched socket
 * renders no further QR and never ends the registration on its own (pinned over a loopback socket in
 * scripts/baileys-pairing.integration.spec.mjs). These cases cover what the lifecycle does with a code
 * nobody enters.
 */
function qrStage() {
  const noCallback = (): undefined => undefined;
  const onReconnecting = jest.fn();
  const host = {
    authPath: '/nonexistent/openwa-pairing-window-spec/session-1',
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { sessionId: 'session-1', dbSessionId: 'session-1', authDir: '/nonexistent/openwa-pairing-window-spec' },
    liveCalls: new Map(),
    extractPhone: (id?: string) => (id ? id.split(':')[0].split('@')[0] : null),
    getOnQRCode: noCallback,
    getOnReady: noCallback,
    getOnDisconnected: noCallback,
    getOnReconnecting: () => onReconnecting,
    getOnError: noCallback,
    getOnStateChanged: noCallback,
    getOnCredentialTeardownStarted: noCallback,
    getOnAccountRestriction: noCallback,
  } as unknown as BaileysLifecycleHost;
  // Baileys' `sock.user` is `creds.me`, which requestPairingCode writes before it sends.
  const creds: { me?: { id: string; name: string } } = {};
  const sock = {
    ws: { isOpen: true, isConnecting: false, on: jest.fn() },
    get user() {
      return creds.me;
    },
    requestPairingCode: jest.fn((phone: string) => {
      creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' };
      return Promise.resolve('ABCD1234');
    }),
    end: jest.fn(),
    ev: { on: jest.fn(), removeAllListeners: jest.fn() },
  };
  const lifecycle = new BaileysLifecycle(host);
  const internals = lifecycle as unknown as {
    sock: unknown;
    status: EngineStatus;
    qrCode: string | null;
    lib: unknown;
    reconnectAttempts: number;
    connect: () => Promise<void>;
    handleConnectionUpdate: (update: { connection?: string; isNewLogin?: boolean; lastDisconnect?: unknown }) => void;
  };
  internals.sock = sock;
  internals.status = EngineStatus.QR_READY;
  internals.qrCode = 'data:image/png;base64,QR-RENDERED-BEFORE-THE-PAIRING-REQUEST';
  internals.lib = { DisconnectReason: { loggedOut: 401, forbidden: 403, connectionReplaced: 440 } };
  return { lifecycle, sock, internals, onReconnecting };
}

describe('Baileys pairing code requested and never entered', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Baileys renders the first QR for 60 s and each later one for 20 s, and renders none after the
  // request. A QR older than that names a ref WhatsApp has retired and that nothing will replace.
  it('stops serving the QR rendered before the request once that QR can no longer be scanned', async () => {
    const { lifecycle } = qrStage();
    await expect(lifecycle.requestPairingCode('628123456789')).resolves.toBe('ABCD1234');

    jest.advanceTimersByTime(59_000);
    expect(lifecycle.getQRCode()).not.toBeNull();
    jest.advanceTimersByTime(2_000);

    expect(lifecycle.getQRCode()).toBeNull();
    expect(lifecycle.getStatus()).toBe(EngineStatus.QR_READY);
  });

  // Unpatched, the library ends an unscanned registration once its refs run out (a 408 'QR refs attempts
  // ended', which the lifecycle answers with a fresh registration). Nothing takes that bound's place here.
  it('does not keep the session waiting at the QR stage indefinitely', async () => {
    const { lifecycle, sock } = qrStage();
    await lifecycle.requestPairingCode('628123456789');

    jest.advanceTimersByTime(10 * 60_000);

    const waiting = lifecycle.getStatus() === EngineStatus.QR_READY && sock.end.mock.calls.length === 0;
    expect(waiting).toBe(false);
  });

  it('waits the whole window for the code, measured from the latest request', async () => {
    const { lifecycle, sock } = qrStage();
    await lifecycle.requestPairingCode('628123456789');
    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS - 60_000);
    await lifecycle.requestPairingCode('628123456789');

    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS - 1);
    expect(sock.end).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  // The close the window raises is the end of an unscanned QR window, not a connection failure: no
  // reconnect attempt is counted or reported, and the next connect registers again.
  it('ends the wait as an unscanned QR window that reconnects at once without counting an attempt', async () => {
    const { lifecycle, sock, internals, onReconnecting } = qrStage();
    const connect = jest.spyOn(internals, 'connect').mockResolvedValue(undefined);
    internals.reconnectAttempts = 4;
    await lifecycle.requestPairingCode('628123456789');
    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS);
    const [[closeError]] = sock.end.mock.calls as [[unknown]];

    internals.handleConnectionUpdate({ connection: 'close', lastDisconnect: { error: closeError } });

    expect(lifecycle.getStatus()).toBe(EngineStatus.INITIALIZING);
    expect(internals.reconnectAttempts).toBe(0);
    expect(onReconnecting).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('leaves a code that was entered alone', async () => {
    const { lifecycle, sock, internals } = qrStage();
    await lifecycle.requestPairingCode('628123456789');
    jest.advanceTimersByTime(30_000);

    internals.handleConnectionUpdate({ isNewLogin: true });
    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS);

    expect(lifecycle.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(sock.end).not.toHaveBeenCalled();
  });

  it.each([
    ['a stop', (lifecycle: BaileysLifecycle) => lifecycle.disconnect()],
    ['a destroy', (lifecycle: BaileysLifecycle) => lifecycle.destroy()],
  ])('cancels the wait on %s', async (_label, teardown) => {
    const { lifecycle, sock } = qrStage();
    await lifecycle.requestPairingCode('628123456789');

    await teardown(lifecycle);
    sock.end.mockClear();
    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS);

    expect(sock.end).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does nothing to a socket that has been replaced since the request', async () => {
    const { lifecycle, sock, internals } = qrStage();
    await lifecycle.requestPairingCode('628123456789');

    internals.sock = { ...sock, end: jest.fn() };
    jest.advanceTimersByTime(BAILEYS_PAIRING_CODE_WINDOW_MS);

    expect(sock.end).not.toHaveBeenCalled();
    expect(lifecycle.getQRCode()).not.toBeNull();
  });
});
