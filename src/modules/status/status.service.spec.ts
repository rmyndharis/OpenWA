import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { StatusService } from './status.service';
import { SessionService } from '../session/session.service';
import { HookManager } from '../../core/hooks';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto } from './dto/send-media-status.dto';

describe('StatusService media validation and selection', () => {
  const engine = {
    postTextStatus: jest.fn().mockResolvedValue({ id: 'text-status' }),
    postImageStatus: jest.fn().mockResolvedValue({ id: 'image-status' }),
    postVideoStatus: jest.fn().mockResolvedValue({ id: 'video-status' }),
  };
  const sessionService = { getEngine: jest.fn().mockReturnValue(engine) };
  // Pass-through gate: continue, input unchanged. The blocking/rewriting behaviour has its own
  // tests below.
  const passThrough = (_event: string, data: unknown) => Promise.resolve({ continue: true, data });
  const hookManager = { execute: jest.fn(passThrough) };
  const service = new StatusService(sessionService as unknown as SessionService, hookManager as unknown as HookManager);

  beforeEach(() => {
    jest.clearAllMocks();
    hookManager.execute.mockImplementation(passThrough);
  });

  it('prefers explicit base64 over url for image and video status media', async () => {
    const media = { url: 'https://example.com/stale', base64: 'QUJD', mimetype: 'image/png' };
    await service.postImageStatus('s1', media, { recipients: ['1@c.us'] });
    await service.postVideoStatus('s1', { ...media, mimetype: 'video/mp4' }, { recipients: ['1@c.us'] });

    expect(engine.postImageStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
    expect(engine.postVideoStatus).toHaveBeenCalledWith(expect.objectContaining({ data: 'QUJD' }), expect.anything());
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
