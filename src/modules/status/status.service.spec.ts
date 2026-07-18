import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { StatusService } from './status.service';
import { SessionService } from '../session/session.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto } from './dto/send-media-status.dto';

describe('StatusService media validation and selection', () => {
  const engine = {
    postImageStatus: jest.fn().mockResolvedValue({ id: 'image-status' }),
    postVideoStatus: jest.fn().mockResolvedValue({ id: 'video-status' }),
  };
  const sessionService = { getEngine: jest.fn().mockReturnValue(engine) };
  const service = new StatusService(sessionService as unknown as SessionService);

  beforeEach(() => jest.clearAllMocks());

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
});
