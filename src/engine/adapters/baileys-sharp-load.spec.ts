import { InternalServerErrorException } from '@nestjs/common';
import type { WASocket } from '@whiskeysockets/baileys';

// Force the deferred `sharp` binary to fail to load, the way an older CPU or a stripped/musl image
// does at runtime. The dynamic import inside loadSharp then rejects.
jest.mock('sharp', () => {
  throw new Error('ERR_DLOPEN_FAILED: sharp native binary could not be loaded');
});

import { BaileysMessaging, loadSharp, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';

describe('loadSharp', () => {
  it('maps a sharp native-load failure to a 500, not the decode path 400', async () => {
    // A valid PNG would hit this same path, so a 400 would wrongly blame the caller's image.
    await expect(loadSharp()).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('a link preview image without sharp', () => {
  it('is uploaded as the caller sent it, since nothing can re-encode it', async () => {
    const sock = {
      waUploadToServer: jest.fn(),
      onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
      sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    };
    const prepareWAMessageMedia = jest.fn().mockResolvedValue({ imageMessage: { directPath: '/d' } });
    const host = {
      ensureReady: jest.fn(),
      sessionProxyUrl: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => sock as unknown as WASocket,
      logger: createLogger('baileys-sharp-load.spec'),
      toNeutralJid: (j: string) => j,
      toEngineJid: (j: string) => j,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () => Promise.resolve({ prepareWAMessageMedia } as never),
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost;
    const original = Buffer.from('not decoded here');

    await new BaileysMessaging(host).sendTextMessage('628111@s.whatsapp.net', 'x', undefined, {
      customPreview: { url: 'https://example.com', title: 'Example', thumbnailBase64: original.toString('base64') },
    });

    expect(prepareWAMessageMedia).toHaveBeenCalledWith({ image: original }, expect.anything());
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });
});
