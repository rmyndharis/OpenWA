jest.mock('./baileys-audio-probe', () => ({
  describeVideo: jest.fn(() => Promise.resolve({ jpegThumbnail: null })),
  describeAudio: jest.fn(() => Promise.resolve({ seconds: 1 })),
}));

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { WASocket } from '@whiskeysockets/baileys';
import { BadRequestException } from '@nestjs/common';
import { describeAudio, describeVideo } from './baileys-audio-probe';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * The thumbnail of an outgoing video and the duration and waveform of an outgoing audio are read by child
 * processes (ffmpeg, a parser script) under process-wide two-slot limiters. A send that is refused anyway, to a
 * number WhatsApp reports unregistered, with a quote the session does not hold, or a status with no recipients,
 * must be refused before any of that work runs, as the text send builds its preview image only after the
 * recipient check.
 */
describe('Baileys media probes run only for a send that passed its own checks', () => {
  type FakeSock = {
    onWhatsApp: jest.Mock;
    sendMessage: jest.Mock;
  };
  const fakeSock = (): FakeSock => ({
    onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
    sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
  });
  let sock: FakeSock;
  let current: FakeSock | null;
  let messaging: BaileysMessaging;
  let statusOps: BaileysStatus;

  const video = { data: Buffer.from('video'), mimetype: 'video/mp4' };
  const voiceNote = { data: Buffer.from('audio'), mimetype: 'audio/ogg', ptt: true };
  const unregistered = (jid = '628123456789@s.whatsapp.net') => [{ jid, exists: false }];

  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );

  beforeEach(() => {
    jest
      .mocked(describeVideo)
      .mockReset()
      .mockResolvedValue({ jpegThumbnail: null as unknown as string });
    jest.mocked(describeAudio).mockReset().mockResolvedValue({ seconds: 1 });
    sock = fakeSock();
    current = sock;
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => undefined,
      getSocket: () => {
        if (!current) throw new EngineNotReadyError();
        return current as unknown as WASocket;
      },
      getSocketOrNull: () => current as unknown as WASocket | null,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () =>
        Promise.resolve({ normalizeMessageContent: (m: unknown) => m, getContentType: () => 'videoMessage' } as never),
      getStoredMessage: () => Promise.resolve(null),
      wasDeletedForEveryone: () => false,
      pendingEditOf: () => undefined,
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost & BaileysStatusHost;
    messaging = new BaileysMessaging(host);
    statusOps = new BaileysStatus(host);
  });

  describe('a send that its own checks refuse', () => {
    it('refuses a video to an unregistered number before its thumbnail is made', async () => {
      sock.onWhatsApp.mockResolvedValue(unregistered());

      const error = await failureOf(messaging.sendVideoMessage('628123456789@c.us', video));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(describeVideo).not.toHaveBeenCalled();
    });

    it('refuses a voice note to an unregistered number before its duration and waveform are read', async () => {
      sock.onWhatsApp.mockResolvedValue(unregistered());

      const error = await failureOf(messaging.sendAudioMessage('628123456789@c.us', voiceNote));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(describeAudio).not.toHaveBeenCalled();
    });

    it('refuses a video quoting a message the session does not hold before its thumbnail is made', async () => {
      const error = await failureOf(
        messaging.sendVideoMessage('120363001@g.us', { ...video, quotedMessageId: 'UNKNOWN' }),
      );

      expect(error).toBeInstanceOf(MessageNotFoundError);
      expect(describeVideo).not.toHaveBeenCalled();
    });

    it('refuses an audio quoting a message the session does not hold before its duration is read', async () => {
      const error = await failureOf(
        messaging.sendAudioMessage('120363001@g.us', { ...voiceNote, quotedMessageId: 'UNKNOWN' }),
      );

      expect(error).toBeInstanceOf(MessageNotFoundError);
      expect(describeAudio).not.toHaveBeenCalled();
    });

    it('refuses a video status with no recipients before its thumbnail is made', async () => {
      const error = await failureOf(statusOps.postVideoStatus(video, { recipients: [] }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(EngineNotReadyError);
      expect(describeVideo).not.toHaveBeenCalled();
    });

    it('refuses a voice status with no recipients before its duration is read', async () => {
      const error = await failureOf(statusOps.postVoiceStatus(voiceNote, {}));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(describeAudio).not.toHaveBeenCalled();
    });

    it('answers a status on a session that is not ready with 409 before it asks for recipients', async () => {
      current = null;

      const error = await failureOf(statusOps.postVideoStatus(video, { recipients: [] }));

      expect(error).toBeInstanceOf(EngineNotReadyError);
      expect(describeVideo).not.toHaveBeenCalled();
    });
  });

  describe('a send that passes its checks', () => {
    it('makes the thumbnail after the registered-number check and sends it with the video', async () => {
      jest.mocked(describeVideo).mockResolvedValue({ jpegThumbnail: 'dGh1bWI=' });

      await messaging.sendVideoMessage('628123456789@c.us', video);

      expect(describeVideo).toHaveBeenCalledTimes(1);
      expect(sock.onWhatsApp.mock.invocationCallOrder[0]).toBeLessThan(
        jest.mocked(describeVideo).mock.invocationCallOrder[0],
      );
      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628123456789@s.whatsapp.net',
        expect.objectContaining({ video: video.data, jpegThumbnail: 'dGh1bWI=' }),
      );
    });

    it('reads the duration and waveform after the registered-number check and sends them with the voice note', async () => {
      const waveform = new Uint8Array([10, 20, 30]);
      jest.mocked(describeAudio).mockResolvedValue({ seconds: 7, waveform });

      await messaging.sendAudioMessage('628123456789@c.us', voiceNote);

      expect(describeAudio).toHaveBeenCalledWith(voiceNote.data, true);
      expect(sock.onWhatsApp.mock.invocationCallOrder[0]).toBeLessThan(
        jest.mocked(describeAudio).mock.invocationCallOrder[0],
      );
      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628123456789@s.whatsapp.net',
        expect.objectContaining({ audio: voiceNote.data, ptt: true, seconds: 7, waveform }),
      );
    });

    it('still makes the thumbnail for a group, which has no number to check', async () => {
      await messaging.sendVideoMessage('120363001@g.us', video);

      expect(sock.onWhatsApp).not.toHaveBeenCalled();
      expect(describeVideo).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledWith('120363001@g.us', expect.objectContaining({ video: video.data }));
    });

    it('sends nothing, and answers 409, when the socket is replaced while the thumbnail is made', async () => {
      const replacement = fakeSock();
      jest.mocked(describeVideo).mockImplementation(() => {
        current = replacement;
        return Promise.resolve({ jpegThumbnail: null as unknown as string });
      });

      const error = await failureOf(messaging.sendVideoMessage('628123456789@c.us', video));

      expect(error).toBeInstanceOf(EngineNotReadyError);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(replacement.sendMessage).not.toHaveBeenCalled();
    });

    it('makes the thumbnail of a video status that has recipients and sends it', async () => {
      jest.mocked(describeVideo).mockResolvedValue({ jpegThumbnail: 'dGh1bWI=' });

      await statusOps.postVideoStatus(video, { recipients: ['628111@c.us'] });

      expect(describeVideo).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledWith(
        'status@broadcast',
        expect.objectContaining({ video: video.data, jpegThumbnail: 'dGh1bWI=' }),
        expect.objectContaining({ statusJidList: ['628111@s.whatsapp.net'] }),
      );
    });

    it('reads the duration of a voice status that has recipients and sends it', async () => {
      jest.mocked(describeAudio).mockResolvedValue({ seconds: 4 });

      await statusOps.postVoiceStatus(voiceNote, { recipients: ['628111@c.us'] });

      expect(describeAudio).toHaveBeenCalledWith(voiceNote.data, true);
      expect(sock.sendMessage).toHaveBeenCalledWith(
        'status@broadcast',
        expect.objectContaining({ audio: voiceNote.data, ptt: true, seconds: 4 }),
        expect.objectContaining({ statusJidList: ['628111@s.whatsapp.net'] }),
      );
    });
  });

  describe('the media of a status that cannot be posted', () => {
    let server: Server;
    let base: string;
    let fetches: number;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        fetches += 1;
        res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.from('video'));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    beforeEach(() => {
      process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
      fetches = 0;
    });

    afterEach(() => {
      delete process.env.SSRF_ALLOWED_HOSTS;
    });

    it('is not fetched for a status with no recipients', async () => {
      const error = await failureOf(
        statusOps.postVideoStatus({ data: `${base}/a.mp4`, mimetype: 'video/mp4' }, { recipients: [] }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(fetches).toBe(0);
      expect(describeVideo).not.toHaveBeenCalled();
    });

    it('is fetched, and its thumbnail made, for a status that has recipients', async () => {
      await statusOps.postVideoStatus(
        { data: `${base}/a.mp4`, mimetype: 'video/mp4' },
        { recipients: ['628111@c.us'] },
      );

      expect(fetches).toBe(1);
      expect(describeVideo).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('content built after the recipient check', () => {
    // sendContent is private; a later caller with a text-bearing content would reach it like this.
    type TextSender = { sendContent: (chatId: string, content: () => Promise<{ text: string }>) => Promise<unknown> };

    it('still keeps the library link preview generator off a text-bearing content', async () => {
      const build = jest.fn(() => Promise.resolve({ text: 'see https://example.com' }));

      await (messaging as unknown as TextSender).sendContent('120363001@g.us', build);

      expect(build).toHaveBeenCalledTimes(1);
      expect(sock.sendMessage).toHaveBeenCalledWith(
        '120363001@g.us',
        expect.objectContaining({ text: 'see https://example.com', linkPreview: null }),
      );
    });
  });
});
