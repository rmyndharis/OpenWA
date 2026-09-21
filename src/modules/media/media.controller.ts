import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConversionStatusResponseDto, ConvertedMediaResponseDto } from './dto/media-response.dto';
import { MediaConversionService } from './media-conversion.service';
import { ConvertMediaDto } from './dto/convert-media.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * Server-side transcoding, scoped to a session.
 *
 * Conversion never touches WhatsApp, so it needs no running engine. The session dimension is kept
 * for two reasons. This project's API keys can be restricted to specific sessions, and the guard
 * resolves that restriction from route parameters: a deployment-global route would have to be marked
 * unscoped, which would shut session-restricted keys out of a feature they need in order to send.
 * And the named session decides which egress proxy a `url` conversion leaves through (#1626), so a
 * proxied session's fetch does not go out from the gateway's own address.
 */
@ApiTags('media')
// Declared on the class because the handlers take the id without an `@ApiParam` of their own. Without
// this the published paths carry a `{sessionId}` template with no parameter to fill it, which OpenAPI
// 3.0 does not allow and a generated client cannot satisfy.
@ApiParam({ name: 'sessionId', type: String, description: 'Session ID the API key must be authorized for' })
@Controller('sessions/:sessionId/media')
export class MediaController {
  constructor(private readonly mediaConversion: MediaConversionService) {}

  @Get('convert')
  @ApiOperation({ summary: 'Whether server-side media conversion is available' })
  @ApiResponse({
    status: 200,
    description:
      'Reports whether conversion is switched on AND the ffmpeg binary can be run, so a client can ' +
      'decide between converting here and converting before it sends.',
    type: ConversionStatusResponseDto,
  })
  async conversionStatus(): Promise<{ available: boolean }> {
    return { available: await this.mediaConversion.isAvailable() };
  }

  // 200, not 201: this creates no resource, it answers with a representation of what was sent.
  @Post('convert/voice')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Convert audio into a WhatsApp voice note (Ogg/Opus)' })
  @ApiResponse({
    status: 200,
    description:
      'Converted bytes, ready to post to send-audio with ptt=true. WhatsApp only renders a playable ' +
      'mic bubble for Ogg/Opus; other formats arrive as an audio file that will not play.',
    type: ConvertedMediaResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Neither url nor base64 given, or ffmpeg refused the input.' })
  @ApiResponse({ status: 413, description: 'The supplied media is above the media size cap.' })
  @ApiResponse({
    status: 503,
    description:
      'Conversion is disabled, the ffmpeg binary is not runnable, or the conversion queue is saturated — retry shortly.',
  })
  async convertVoice(@Param('sessionId') sessionId: string, @Body() dto: ConvertMediaDto) {
    return this.mediaConversion.convertToVoice(sessionId, dto);
  }

  @Post('convert/video')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Convert video into a WhatsApp-compatible MP4' })
  @ApiResponse({
    status: 200,
    description:
      'Converted bytes: baseline H.264 with AAC audio, long edge bounded at 1280, index moved to the ' +
      'front so the recipient can start playing before the whole file arrives.',
    type: ConvertedMediaResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Neither url nor base64 given, or ffmpeg refused the input.' })
  @ApiResponse({ status: 413, description: 'The supplied media is above the media size cap.' })
  @ApiResponse({
    status: 503,
    description:
      'Conversion is disabled, the ffmpeg binary is not runnable, or the conversion queue is saturated — retry shortly.',
  })
  async convertVideo(@Param('sessionId') sessionId: string, @Body() dto: ConvertMediaDto) {
    return this.mediaConversion.convertToVideo(sessionId, dto);
  }
}
