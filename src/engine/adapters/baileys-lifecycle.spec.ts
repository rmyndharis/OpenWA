jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
jest.mock('@whiskeysockets/baileys', () => ({ __esModule: true, initAuthCreds: jest.fn() }));
jest.mock('./baileys-auth-store', () => ({
  useAtomicMultiFileAuthState: jest.fn().mockRejectedValue(new Error('stop after auth load')),
}));

import * as qrcode from 'qrcode';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import * as BaileysLib from '@whiskeysockets/baileys';
import { useAtomicMultiFileAuthState } from './baileys-auth-store';
import { BaileysLifecycle, type BaileysLifecycleHost } from './baileys-lifecycle';

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
  it('does not publish a pending render after linking has been accepted', async () => {
    const { renderer, onQRCode } = fixture();
    let finish!: (image: string) => void;
    renderQr.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    );
    const pending = renderer.handleQrCode('pending');
    renderer.status = EngineStatus.AUTHENTICATING;
    finish('expired-image');
    await pending;
    expect(renderer.qrCode).toBeNull();
    expect(onQRCode).not.toHaveBeenCalled();
  });
});
