import { HttpStatus, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { MediaController } from './media.controller';
import type { MediaConversionService } from './media-conversion.service';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * The handlers are thin, so what is worth asserting is the wiring around them: the route shape that
 * earns the session fence, the roles, and the status code.
 */
describe('MediaController', () => {
  // Held as standalone mocks rather than read back off the service object, so an assertion never
  // has to reference a method detached from its receiver.
  const convertToVoice = jest.fn().mockResolvedValue({ base64: 'b', mimetype: 'audio/ogg; codecs=opus', bytes: 1 });
  const convertToVideo = jest.fn().mockResolvedValue({ base64: 'b', mimetype: 'video/mp4', bytes: 1 });
  const isAvailable = jest.fn().mockResolvedValue(true);
  const controller = new MediaController({
    convertToVoice,
    convertToVideo,
    isAvailable,
  } as unknown as MediaConversionService);

  afterEach(() => jest.clearAllMocks());

  /**
   * Nest stores handler metadata on the prototype method. Looked up by name rather than as
   * `controller.convertVoice`, because that form reads as an unbound method call even though nothing
   * here invokes it.
   */
  const handler = (name: keyof MediaController): object =>
    (MediaController.prototype as unknown as Record<string, object>)[name];

  describe('routing', () => {
    /**
     * The session segment is what clears the global-route fence and, more importantly, what lets a
     * session-restricted API key use these routes at all: the guard resolves that restriction from
     * route parameters, so a deployment-global path would have to shut those keys out.
     */
    it('is mounted under a session, so a session-scoped key can reach it', () => {
      expect(Reflect.getMetadata(PATH_METADATA, MediaController)).toBe('sessions/:sessionId/media');
    });

    it('answers 200 rather than 201 — a conversion creates no resource', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('convertVoice'))).toBe(HttpStatus.OK);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('convertVideo'))).toBe(HttpStatus.OK);
    });

    it('exposes conversion as POST and the availability probe as GET', () => {
      expect(Reflect.getMetadata(METHOD_METADATA, handler('convertVoice'))).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(METHOD_METADATA, handler('convertVideo'))).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(METHOD_METADATA, handler('conversionStatus'))).toBe(RequestMethod.GET);
    });
  });

  describe('authorization', () => {
    // Converting spends CPU and spawns a process, so it sits behind the same role as sending.
    it('requires OPERATOR to convert', () => {
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('convertVoice'))).toBe(ApiKeyRole.OPERATOR);
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('convertVideo'))).toBe(ApiKeyRole.OPERATOR);
    });

    // Asking whether the feature exists reveals nothing, and a read-only key needs the answer to
    // decide whether to convert on its own side.
    it('leaves the availability probe open to any valid key', () => {
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('conversionStatus'))).toBeUndefined();
    });
  });

  describe('delegation', () => {
    it('passes the body straight to the voice conversion', async () => {
      const dto = { base64: 'AAAA' };

      await expect(controller.convertVoice(dto)).resolves.toMatchObject({ mimetype: 'audio/ogg; codecs=opus' });
      expect(convertToVoice).toHaveBeenCalledWith(dto);
    });

    it('passes the body straight to the video conversion', async () => {
      const dto = { url: 'https://example.com/clip.mov' };

      await expect(controller.convertVideo(dto)).resolves.toMatchObject({ mimetype: 'video/mp4' });
      expect(convertToVideo).toHaveBeenCalledWith(dto);
    });

    it('reports availability as a plain flag', async () => {
      await expect(controller.conversionStatus()).resolves.toEqual({ available: true });
    });
  });
});
