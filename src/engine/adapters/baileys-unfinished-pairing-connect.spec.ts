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

/**
 * Baileys sends a registration (which yields a QR) only when creds.me is absent and a login otherwise
 * (Socket/socket.js, the creds.me branch before the handshake). A pairing-code request writes creds.me
 * before the code is entered; only a completed pairing writes the signed device identity, creds.account
 * (Utils/validate-connection.js, configureSuccessfulPairing). These cases cover the connect that follows.
 */
describe('Baileys connect after a pairing code', () => {
  type Creds = Record<string, unknown>;

  function connect(creds: Creds, saveCreds = jest.fn().mockResolvedValue(undefined)) {
    const noCallback = (): undefined => undefined;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const host = {
      authPath: '/nonexistent/openwa-unfinished-pairing-spec/session-1',
      logger,
      config: {
        sessionId: 'session-1',
        dbSessionId: 'session-1',
        authDir: '/nonexistent/openwa-unfinished-pairing-spec',
      },
      liveCalls: new Map(),
      getOnStateChanged: noCallback,
      getOnError: noCallback,
    } as unknown as BaileysLifecycleHost;
    jest.mocked(useAtomicMultiFileAuthState).mockResolvedValue({ state: { creds, keys: {} }, saveCreds } as never);
    const socket = {
      ws: { isOpen: false, isConnecting: false, on: jest.fn() },
      ev: { on: jest.fn(), removeAllListeners: jest.fn() },
      end: jest.fn(),
    };
    const makeWASocket = jest.mocked(BaileysLib.default as unknown as jest.Mock);
    makeWASocket.mockReset().mockReturnValue(socket);
    const lifecycle = new BaileysLifecycle(host);
    const resolver = (lifecycle as unknown as { versionResolver: { resolve: () => Promise<number[]> } })
      .versionResolver;
    jest.spyOn(resolver, 'resolve').mockResolvedValue([2, 3000, 1]);
    const opened = async (): Promise<Creds> => {
      try {
        await lifecycle.initialize();
        expect(makeWASocket).toHaveBeenCalledTimes(1);
        const [[config]] = makeWASocket.mock.calls as [[{ auth: { creds: Creds } }]];
        return config.auth.creds;
      } finally {
        await lifecycle.destroy();
      }
    };
    return { opened, saveCreds, logger };
  }

  const unfinished = (): Creds => ({
    me: { id: '628123456789@s.whatsapp.net', name: '~' },
    pairingCode: 'ABCD1234',
    noiseKey: { public: 'noise' },
    accountSyncCounter: 0,
  });

  it('opens the next socket as a new registration rather than a login as the unregistered number', async () => {
    const { opened, saveCreds, logger } = connect(unfinished());

    const creds = await opened();

    expect(creds.me).toBeUndefined();
    expect(creds.pairingCode).toBeUndefined();
    // The registration keeps the keys it was minted with, as a never-linked session does today.
    expect(creds.noiseKey).toEqual({ public: 'noise' });
    expect(saveCreds).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/pairing code that was never entered/), {
      sessionId: 'session-1',
    });
  });

  it('still opens the registration when saving the cleaned credentials fails', async () => {
    const { opened, logger } = connect(unfinished(), jest.fn().mockRejectedValue(new Error('EACCES')));

    const creds = await opened();

    expect(creds.me).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Could not save the credentials/), {
      sessionId: 'session-1',
      error: 'EACCES',
    });
  });

  // A completed pairing (or the restart WhatsApp asks for right after one) carries account: a login.
  it('keeps the identity of a linked device', async () => {
    const linked = { ...unfinished(), me: { id: '628123456789:7@s.whatsapp.net', name: 'Me' }, account: {} };
    const { opened, saveCreds } = connect(linked);

    const creds = await opened();

    expect(creds.me).toEqual({ id: '628123456789:7@s.whatsapp.net', name: 'Me' });
    expect(saveCreds).not.toHaveBeenCalled();
  });

  it('leaves the credentials of a session that never asked for a code alone', async () => {
    const { opened, saveCreds } = connect({ noiseKey: { public: 'noise' }, accountSyncCounter: 0 });

    const creds = await opened();

    expect(creds).toEqual({ noiseKey: { public: 'noise' }, accountSyncCounter: 0 });
    expect(saveCreds).not.toHaveBeenCalled();
  });
});
