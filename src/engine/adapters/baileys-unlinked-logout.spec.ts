jest.mock('@whiskeysockets/baileys', () => ({ __esModule: true, S_WHATSAPP_NET: '@s.whatsapp.net' }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';

/**
 * Logout of a session whose socket has no linked device. The device is read from the socket's live
 * credentials: `sock.user` is a copy of `creds.me` taken when the socket was built, so it is still unset on the
 * socket that just paired, and stays unset when a pairing-code request writes `creds.me` before the code is
 * entered. Only a completed link writes `creds.account`. Credentials without it name no device on WhatsApp's
 * side, unless the auth store moved an unreadable creds.json aside (`corrupt-*` in the auth dir): then the
 * device those credentials belong to may still be linked and the logout stays an incomplete unlink.
 */
describe('Baileys logout without a linked device', () => {
  let authPath: string;

  function qrStage(creds: Record<string, unknown> = {}) {
    const noCallback = (): undefined => undefined;
    const host = {
      authPath,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: {
        sessionId: 'session-1',
        dbSessionId: 'session-1',
        messageStore: { clearSession: jest.fn().mockResolvedValue(undefined) },
      },
      liveCalls: new Map(),
      fenceStoredWrites: jest.fn(),
      getOnStateChanged: noCallback,
      getOnDisconnected: noCallback,
      getOnError: noCallback,
      getOnCredentialTeardownStarted: noCallback,
    } as unknown as BaileysLifecycleHost;
    const sock = {
      // Copied from creds.me when the socket was built from credentials that had none.
      user: undefined,
      authState: { creds },
      ws: { isOpen: true },
      query: jest.fn().mockResolvedValue({ tag: 'iq', attrs: { type: 'result' } }),
      generateMessageTag: () => 'tag-1',
      end: jest.fn(),
    };
    const lifecycle = new BaileysLifecycle(host);
    const internals = lifecycle as unknown as { sock: unknown; status: EngineStatus };
    internals.sock = sock;
    internals.status = EngineStatus.QR_READY;
    return { lifecycle, sock };
  }

  async function failure(outcome: Promise<void>): Promise<unknown> {
    return outcome.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
  }

  beforeEach(() => {
    authPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-unlinked-logout-')), 'session-1');
    fs.mkdirSync(authPath);
    fs.writeFileSync(path.join(authPath, 'creds.json'), '{}');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  });

  it('answers that a session with no linked device has nothing to unlink, and removes nothing', async () => {
    const { lifecycle, sock } = qrStage();

    const error = await failure(lifecycle.logout());

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect((error as Error).message).toMatch(/has no linked WhatsApp device, so there is nothing to unlink/);
    expect(sock.query).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(authPath, 'creds.json'))).toBe(true);
    // Still stopped locally, as every logout attempt is.
    expect(sock.end).toHaveBeenCalled();
    expect(lifecycle.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  // The code was requested but never entered: the number it was asked for is no device of this session.
  it('answers that a session whose pairing code was never entered has nothing to unlink, and sends nothing', async () => {
    const me = { id: '6281234567890@s.whatsapp.net', name: '~' };
    const { lifecycle, sock } = qrStage({ me, pairingCode: 'ABCD1234' });

    const error = await failure(lifecycle.logout());

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(sock.query).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(authPath, 'creds.json'))).toBe(true);
    expect(sock.end).toHaveBeenCalled();
    expect(lifecycle.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('keeps reporting an incomplete unlink of a pending pairing code when unreadable credentials were moved aside', async () => {
    fs.mkdirSync(path.join(authPath, 'corrupt-1800000000000-abc123'));
    const me = { id: '6281234567890@s.whatsapp.net', name: '~' };
    const { lifecycle, sock } = qrStage({ me, pairingCode: 'ABCD1234' });

    const error = await failure(lifecycle.logout());

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpException);
    expect(sock.query).not.toHaveBeenCalled();
  });

  // Pair-success put the device on the credentials; the socket that paired is replaced only after a restart.
  it('unlinks a device that has just linked, before the socket built for it opens', async () => {
    const { lifecycle, sock } = qrStage({ me: { id: '6281234567890:12@s.whatsapp.net', name: 'Biz' }, account: {} });

    await lifecycle.logout();

    expect(sock.query).toHaveBeenCalledTimes(1);
    expect(sock.query).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          {
            tag: 'remove-companion-device',
            attrs: { jid: '6281234567890:12@s.whatsapp.net', reason: 'user_initiated' },
          },
        ],
      }),
      expect.any(Number),
    );
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('keeps reporting an incomplete unlink, and the quarantine, when unreadable credentials were moved aside', async () => {
    const quarantine = path.join(authPath, 'corrupt-1800000000000-abc123');
    fs.mkdirSync(quarantine);
    fs.writeFileSync(path.join(quarantine, 'creds.json'), '{"me":');
    const { lifecycle, sock } = qrStage();

    const error = await failure(lifecycle.logout());

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpException);
    expect(sock.query).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(quarantine, 'creds.json'))).toBe(true);
  });

  it('keeps reporting an incomplete unlink when the auth dir cannot be listed', async () => {
    jest
      .spyOn(fs.promises, 'readdir')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const { lifecycle } = qrStage();

    const error = await failure(lifecycle.logout());

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpException);
  });
});
