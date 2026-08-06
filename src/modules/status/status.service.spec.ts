import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { StatusStoreService } from '../status-store/status-store.service';
import { StorageService } from '../../common/storage/storage.service';
import { HookManager } from '../../core/hooks';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto, SendVoiceStatusDto } from './dto/send-media-status.dto';
import { SendPacingService } from '../message/send-pacing.service';

describe('StatusService media validation and selection', () => {
  const engine = {
    postTextStatus: jest.fn().mockResolvedValue({ id: 'text-status' }),
    postImageStatus: jest.fn().mockResolvedValue({ id: 'image-status' }),
    postVideoStatus: jest.fn().mockResolvedValue({ id: 'video-status' }),
    postVoiceStatus: jest.fn().mockResolvedValue({ id: 'voice-status' }),
  };
  const engines = new EngineRegistry();
  // Both ids the tests below post from; the store-only paths ('sess') never reach the engine.
  engines.set('s1', engine as unknown as IWhatsAppEngine);
  engines.set('sess', engine as unknown as IWhatsAppEngine);
  // Asserts the store-backed read paths never resolve an engine at all.
  const requireSpy = jest.spyOn(engines, 'require');
  // Pass-through gate: continue, input unchanged. The blocking/rewriting behaviour has its own
  // tests below.
  const passThrough = (_event: string, data: unknown) => Promise.resolve({ continue: true, data });
  const hookManager = { execute: jest.fn(passThrough) };
  const store = { list: jest.fn(), listByContact: jest.fn(), getMedia: jest.fn() };
  const storageService = { getFile: jest.fn() };
  const pacing = {
    assertSendAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn(),
    recordSendSuccess: jest.fn(),
  };
  const service = new StatusService(
    engines,
    hookManager as unknown as HookManager,
    store as unknown as StatusStoreService,
    storageService as unknown as StorageService,
    pacing as unknown as SendPacingService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    hookManager.execute.mockImplementation(passThrough);
  });

  describe('pacing breaker feed', () => {
    it('records success when the engine accepts a status post', async () => {
      await service.postTextStatus('s1', 'hello', { recipients: [] });
      expect(pacing.recordSendSuccess).toHaveBeenCalledWith('s1');
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });

    it('records a failure when the engine refuses a status post', async () => {
      engine.postTextStatus.mockRejectedValueOnce(new Error('refused'));
      await expect(service.postTextStatus('s1', 'hello', { recipients: [] })).rejects.toThrow('refused');
      expect(pacing.recordSendFailure).toHaveBeenCalledWith('s1');
      expect(pacing.recordSendSuccess).not.toHaveBeenCalled();
    });
  });

  describe('reading statuses', () => {
    it('reads statuses from the store, not the engine', async () => {
      store.list.mockResolvedValue([{ id: 'w1' } as any]);

      const out = await service.getStatuses('sess');

      expect(out).toEqual([{ id: 'w1' }]);
      expect(store.list).toHaveBeenCalledWith('sess');
      expect(requireSpy).not.toHaveBeenCalled();
    });

    it('reads a contact statuses from the store, not the engine', async () => {
      store.listByContact.mockResolvedValue([{ id: 'w2' } as any]);

      const out = await service.getContactStatus('sess', 'contact@c.us');

      expect(out).toEqual([{ id: 'w2' }]);
      expect(store.listByContact).toHaveBeenCalledWith('sess', 'contact@c.us');
      expect(requireSpy).not.toHaveBeenCalled();
    });
  });

  describe('getStatusMedia', () => {
    it('throws NotFoundException when the store has no media for the status', async () => {
      store.getMedia.mockResolvedValue(null);

      await expect(service.getStatusMedia('sess', 'w1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the media bytes and mimetype', async () => {
      store.getMedia.mockResolvedValue({ path: 'statuses/sess/x.jpg', mimetype: 'image/jpeg' });
      storageService.getFile.mockResolvedValue(Buffer.from('x'));

      const media = await service.getStatusMedia('sess', 'w1');

      expect(media).toEqual({ buffer: Buffer.from('x'), mimetype: 'image/jpeg' });
      expect(store.getMedia).toHaveBeenCalledWith('sess', 'w1');
      expect(storageService.getFile).toHaveBeenCalledWith('statuses/sess/x.jpg');
    });

    it('maps an ENOENT from the file read to NotFoundException (purge raced the request), not a 500', async () => {
      store.getMedia.mockResolvedValue({ path: 'statuses/sess/gone.jpg', mimetype: 'image/jpeg' });
      const enoent = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
      storageService.getFile.mockRejectedValue(enoent);

      await expect(service.getStatusMedia('sess', 'w1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps an S3 NoSuchKey (codeless, name-only) to NotFoundException like the local ENOENT', async () => {
      // The S3 backend reports a miss with a `.name` and no `.code` at all — retention/lifecycle
      // rules make the row-outlived-file race most likely exactly there.
      store.getMedia.mockResolvedValue({ path: 'statuses/sess/gone.jpg', mimetype: 'image/jpeg' });
      const noSuchKey = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      storageService.getFile.mockRejectedValue(noSuchKey);

      await expect(service.getStatusMedia('sess', 'w1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rethrows non-missing-object storage errors unchanged', async () => {
      store.getMedia.mockResolvedValue({ path: 'statuses/sess/x.jpg', mimetype: 'image/jpeg' });
      storageService.getFile.mockRejectedValue(new Error('S3 unavailable'));

      await expect(service.getStatusMedia('sess', 'w1')).rejects.toThrow('S3 unavailable');
    });

    it('serves a sender-declared non-image/video mimetype as inert application/octet-stream', async () => {
      // The stored mimetype comes from the sender's message metadata — never trust it as a
      // Content-Type or the endpoint could serve active content (e.g. text/html) on the API origin.
      store.getMedia.mockResolvedValue({ path: 'statuses/sess/x.bin', mimetype: 'text/html' });
      storageService.getFile.mockResolvedValue(Buffer.from('<script>'));

      const media = await service.getStatusMedia('sess', 'w1');

      expect(media.mimetype).toBe('application/octet-stream');
    });
  });

  it('prefers explicit base64 over url for image and video status media', async () => {
    const media = { url: 'https://example.com/stale', base64: 'QUJD', mimetype: 'image/png' };
    await service.postImageStatus('s1', media, { recipients: ['1@c.us'] });
    await service.postVideoStatus('s1', { ...media, mimetype: 'video/mp4' }, { recipients: ['1@c.us'] });

    expect(engine.postImageStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
    expect(engine.postVideoStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
  });

  describe('voice status', () => {
    // Ogg/Opus is the only thing WhatsApp plays as a status voice note, and neither engine
    // transcodes — so the default has to be that, not a generic audio type.
    it('defaults the mimetype to Ogg/Opus when the caller omits it', async () => {
      await service.postVoiceStatus('s1', { base64: 'QUJD' }, { recipients: ['1@c.us'] });

      expect(engine.postVoiceStatus).toHaveBeenCalledWith(
        expect.objectContaining({ mimetype: 'audio/ogg; codecs=opus', data: 'QUJD' }),
        expect.anything(),
      );
    });

    it('takes a caller-supplied mimetype at its word', async () => {
      await service.postVoiceStatus('s1', { base64: 'QUJD', mimetype: 'audio/mpeg' }, { recipients: ['1@c.us'] });

      expect(engine.postVoiceStatus).toHaveBeenCalledWith(
        expect.objectContaining({ mimetype: 'audio/mpeg' }),
        expect.anything(),
      );
    });

    it('rejects a body carrying neither url nor base64', async () => {
      await expect(service.postVoiceStatus('s1', {}, { recipients: ['1@c.us'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    /**
     * `guardGatedMedia` re-checks the cap after the plugin gate, so an oversized payload is refused
     * either way. What the early check buys is that it is refused BEFORE plugins run — so the
     * assertion is that no plugin was handed 50 MiB of audio, not merely that a 413 came back.
     */
    it('refuses oversized base64 before the plugin gate sees it', async () => {
      const oversized = Buffer.alloc(51 * 1024 * 1024).toString('base64');
      hookManager.execute.mockClear();

      await expect(
        service.postVoiceStatus('s1', { base64: oversized }, { recipients: ['1@c.us'] }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);

      expect(hookManager.execute).not.toHaveBeenCalled();
    });

    /**
     * WhatsApp has nowhere to render a caption on a status voice note, so the request body carries
     * none — and the controller must not invent one. This matters on whatsapp-web.js specifically:
     * its status path forwards `caption` whenever it is defined, so a caption arriving here would be
     * sent rather than ignored.
     */
    it('forwards no caption, even when the body carries an unmodelled one', async () => {
      const controller = new StatusController(service);

      await controller.sendVoiceStatus(
        's1',
        plainToInstance(SendVoiceStatusDto, {
          audio: { base64: 'QUJD' },
          recipients: ['1@c.us'],
          caption: 'not part of the contract',
        } as object),
      );

      const [, options] = engine.postVoiceStatus.mock.calls.at(-1) as [unknown, { caption?: string }];
      expect(options.caption).toBeUndefined();
      expect(options).toMatchObject({ recipients: ['1@c.us'] });
    });
  });

  it('strips a data-URI prefix before handing base64 bytes to either engine path', async () => {
    const prefixed = 'data:image/png;base64,QUJD';
    await service.postImageStatus('s1', { base64: prefixed, mimetype: 'image/png' }, { recipients: ['1@c.us'] });
    await service.postVideoStatus('s1', { base64: prefixed, mimetype: 'video/mp4' }, { recipients: ['1@c.us'] });

    expect(engine.postImageStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
    expect(engine.postVideoStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
  });

  it('rejects empty nested media at the DTO boundary', async () => {
    const imageErrors = await validate(plainToInstance(SendImageStatusDto, { image: {}, recipients: ['1@c.us'] }));
    const videoErrors = await validate(plainToInstance(SendVideoStatusDto, { video: {}, recipients: ['1@c.us'] }));
    expect(imageErrors.some(error => error.property === 'image')).toBe(true);
    expect(videoErrors.some(error => error.property === 'video')).toBe(true);
  });

  it.each([undefined, {}, { url: '', base64: '' }, { base64: 'data:image/png;base64,' }])(
    'rejects missing or empty media with 400',
    async media => {
      await expect(service.postImageStatus('s1', media, { recipients: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.postVideoStatus('s1', media, { recipients: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(engine.postImageStatus).not.toHaveBeenCalled();
      expect(engine.postVideoStatus).not.toHaveBeenCalled();
    },
  );

  it('applies the shared decoded-byte cap before engine dispatch', async () => {
    const previous = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
    try {
      await expect(
        service.postImageStatus('s1', { base64: 'QUJD', mimetype: 'image/png' }, { recipients: [] }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(engine.postImageStatus).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
      else process.env.MEDIA_DOWNLOAD_MAX_BYTES = previous;
    }
  });

  // A status post publishes content from the account, so it passes the same `message:sending`
  // moderation gate as a chat send rather than going out unseen by plugins.
  describe('message:sending gate', () => {
    it('consults the gate for text, image and video status posts', async () => {
      await service.postTextStatus('s1', 'hello', { recipients: [] });
      await service.postImageStatus('s1', { base64: 'QUJD', mimetype: 'image/png' }, { recipients: [] });
      await service.postVideoStatus('s1', { base64: 'QUJD', mimetype: 'video/mp4' }, { recipients: [] });

      const types = hookManager.execute.mock.calls.map(([, data]) => (data as { type: string }).type);
      expect(types).toEqual(['status-text', 'status-image', 'status-video']);
      expect(hookManager.execute.mock.calls.every(([event]) => event === 'message:sending')).toBe(true);
    });

    it('identifies itself as StatusService so a plugin can tell it from a chat send', async () => {
      await service.postTextStatus('s1', 'hello', { recipients: [] });

      const [, , context] = hookManager.execute.mock.calls[0] as unknown as [string, unknown, { source: string }];
      expect(context.source).toBe('StatusService');
    });

    it('blocks the post and never reaches the engine when a plugin refuses', async () => {
      hookManager.execute.mockResolvedValue({ continue: false, data: undefined });

      await expect(service.postTextStatus('s1', 'spam', { recipients: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(engine.postTextStatus).not.toHaveBeenCalled();
    });

    it('sends the plugin-rewritten text rather than the original', async () => {
      hookManager.execute.mockResolvedValue({
        continue: true,
        data: { input: { text: 'redacted', options: { recipients: [] } } },
      });

      await service.postTextStatus('s1', 'secret', { recipients: [] });

      expect(engine.postTextStatus).toHaveBeenCalledWith('redacted', { recipients: [] });
    });

    it('sends plugin-rewritten media rather than the original, for image and video', async () => {
      hookManager.execute.mockResolvedValue({
        continue: true,
        data: { input: { media: { mimetype: 'image/png', data: 'UkVX' }, options: { recipients: [] } } },
      });

      await service.postImageStatus('s1', { base64: 'QUJD', mimetype: 'image/png' }, { recipients: [] });
      await service.postVideoStatus('s1', { base64: 'QUJD', mimetype: 'video/mp4' }, { recipients: [] });

      expect(engine.postImageStatus).toHaveBeenCalledWith({ mimetype: 'image/png', data: 'UkVX' }, { recipients: [] });
      expect(engine.postVideoStatus).toHaveBeenCalledWith({ mimetype: 'image/png', data: 'UkVX' }, { recipients: [] });
    });

    // The chat path gates first and validates afterwards, so a rewritten chat payload is always
    // re-checked. The status path validates the caller's input before the gate, so the gate's
    // OUTPUT has to be re-checked explicitly or a plugin rewrite becomes a way past the byte cap.
    it('re-applies the media byte cap to a plugin rewrite', async () => {
      const previous = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
      process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
      hookManager.execute.mockResolvedValue({
        continue: true,
        data: { input: { media: { mimetype: 'image/png', data: 'QUJDREVGRw' }, options: { recipients: [] } } },
      });
      try {
        // The caller's own payload is within the cap; only the plugin's replacement exceeds it.
        await expect(
          service.postImageStatus('s1', { base64: 'QQ', mimetype: 'image/png' }, { recipients: [] }),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(engine.postImageStatus).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
        else process.env.MEDIA_DOWNLOAD_MAX_BYTES = previous;
      }
    });

    it('strips a data-URI prefix a plugin reintroduces', async () => {
      hookManager.execute.mockResolvedValue({
        continue: true,
        data: {
          input: {
            media: { mimetype: 'image/png', data: 'data:image/png;base64,UkVX' },
            options: { recipients: [] },
          },
        },
      });

      await service.postImageStatus('s1', { base64: 'QUJD', mimetype: 'image/png' }, { recipients: [] });

      expect(engine.postImageStatus).toHaveBeenCalledWith({ mimetype: 'image/png', data: 'UkVX' }, { recipients: [] });
    });
  });
});
