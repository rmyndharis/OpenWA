import type { WASocket } from '@whiskeysockets/baileys';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';

/**
 * Baileys stamps the sticker mimetype unconditionally: `prepareWAMessageMedia` applies
 * `if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]` with
 * `MIMETYPE_MAP.sticker = 'image/webp'` (Utils/messages.js:18, 86-88), and nothing on that path
 * transcodes. So whatever bytes the adapter hands over are published AS WebP whether they are WebP
 * or not — a PNG goes out labelled `image/webp` with PNG bytes, and the send reports success.
 *
 * whatsapp-web.js does not have this problem: `sendMediaAsSticker: true` routes through
 * `Util.formatToWebpSticker` (Client.js:1532, Util.js:152-159), which converts `image/*` and
 * throws `Invalid media format` for anything else.
 *
 * These assertions are about what reaches the socket, because that is where the two engines
 * diverged. The label is not ours to check — Baileys writes it — so the only thing that can keep
 * label and payload honest is the payload.
 */

const logger = createLogger('baileys-sticker-webp.spec');

// 1x1 PNG and the same pixel encoded as a real WebP. Fixtures rather than a sharp call at test
// time, so a failure means the adapter changed rather than the encoder did.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBP = Buffer.from(
  'UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAf1ZQOCAwAAAA0AEAnQEqAQABAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA',
  'base64',
);
// A hand-built 2-frame GIF89a (red, then blue), used to prove animation survives the conversion.
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);

const isWebp = (b: unknown): boolean =>
  Buffer.isBuffer(b) &&
  b.length > 12 &&
  b.subarray(0, 4).toString('ascii') === 'RIFF' &&
  b.subarray(8, 12).toString('ascii') === 'WEBP';

function makeMessaging(): { messaging: BaileysMessaging; sock: { sendMessage: jest.Mock } } {
  const sock = { sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }) };
  const host = {
    ensureReady: jest.fn(),
    getSocket: () => sock as unknown as WASocket,
    logger,
    toNeutralJid: (j: string) => j,
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    getEphemeralExpiration: () => undefined,
    toUnixSeconds: () => 1,
    loadLib: () => Promise.resolve({} as never),
    getStoredMessage: () => Promise.resolve(undefined),
    putStoredMessage: () => undefined,
    recordLidMapping: () => undefined,
    getOnMessageCreate: () => undefined,
    mapMessage: () => Promise.resolve({} as never),
  } as unknown as BaileysMessagingHost;
  return { messaging: new BaileysMessaging(host), sock };
}

const contentOf = (sock: { sendMessage: jest.Mock }): { sticker?: unknown } => {
  const [, content] = sock.sendMessage.mock.calls[0] as unknown[];
  return content as { sticker?: unknown };
};

describe('BaileysMessaging.sendStickerMessage — what reaches the socket must really be WebP', () => {
  it('a PNG sticker never puts non-WebP bytes on the wire', async () => {
    const { messaging, sock } = makeMessaging();

    await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: PNG, mimetype: 'image/png' });

    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(isWebp(contentOf(sock).sticker)).toBe(true);
  });

  // Known-negative control. Without it a converter that mangled every input would still pass the
  // assertion above, and the oracle would be measuring nothing.
  it('a genuine WebP sticker still goes out byte-identical', async () => {
    const { messaging, sock } = makeMessaging();

    await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: WEBP, mimetype: 'image/webp' });

    const sent = contentOf(sock).sticker as Buffer;
    expect(isWebp(sent)).toBe(true);
    // Re-encoding an existing sticker would strip the WebP EXIF sticker-pack metadata and change
    // its size, so passthrough is a requirement rather than an optimisation.
    expect(sent.equals(WEBP)).toBe(true);
  });

  // The placeholder the DTO applies when a caller supplies no mimetype. A converter that trusted
  // the label would treat this as "not an image" and refuse a perfectly good sticker.
  it('a genuine WebP labelled application/octet-stream is recognised by its bytes', async () => {
    const { messaging, sock } = makeMessaging();

    await messaging.sendStickerMessage('628111@s.whatsapp.net', {
      data: WEBP,
      mimetype: 'application/octet-stream',
    });

    expect((contentOf(sock).sticker as Buffer).equals(WEBP)).toBe(true);
  });

  // A converter that drops `{ animated: true }` keeps only the first frame and still emits valid
  // WebP, so every other assertion here would stay green while animated stickers silently became
  // stills — the same shape of quiet corruption this whole change is about.
  it('an animated source keeps its frames', async () => {
    const { messaging, sock } = makeMessaging();

    await messaging.sendStickerMessage('628111@s.whatsapp.net', { data: ANIMATED_GIF, mimetype: 'image/gif' });

    const sent = contentOf(sock).sticker as Buffer;
    expect(isWebp(sent)).toBe(true);
    expect((await sharp(sent, { animated: true }).metadata()).pages).toBe(2);
  });

  it('input that cannot become a sticker is refused BEFORE the socket, as a 400', async () => {
    const { messaging, sock } = makeMessaging();

    const send = messaging.sendStickerMessage('628111@s.whatsapp.net', {
      data: Buffer.from('%PDF-1.4 this is not an image'),
      mimetype: 'application/pdf',
    });

    await expect(send).rejects.toBeInstanceOf(BadRequestException);
    // Rejected on the DECLARED type, before the bytes reach the image decoder — the message names
    // what was received. Without that check a PDF still ends in a 400, but only after libvips has
    // been handed arbitrary bytes to parse, and this assertion is what keeps the two apart.
    await expect(send).rejects.toThrow(/Received 'application\/pdf'/);
    // Shipping it mislabelled is the defect; refusing after the send would not fix it.
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });
});
