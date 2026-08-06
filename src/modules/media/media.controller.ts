import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MediaConversionService } from './media-conversion.service';
import { ConvertMediaDto } from './dto/convert-media.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/**
 * Server-side transcoding, scoped to a session.
 *
 * Conversion itself needs no session — it never touches WhatsApp. The session dimension is kept
 * because this project's API keys can be restricted to specific sessions, and the guard resolves
 * that restriction from route parameters: a deployment-global route would have to be marked
 * unscoped, which would shut session-restricted keys out of a feature they need in order to send.
 */
@ApiTags('media')
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
  })
  @ApiResponse({ status: 400, description: 'Neither url nor base64 given, or ffmpeg refused the input.' })
  @ApiResponse({ status: 413, description: 'The supplied media is above the media size cap.' })
  @ApiResponse({
    status: 503,
    description:
      'Conversion is disabled, the ffmpeg binary is not runnable, or the conversion queue is saturated — retry shortly.',
  })
  async convertVoice(@Body() dto: ConvertMediaDto) {
    return this.mediaConversion.convertToVoice(dto);
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
  })
  @ApiResponse({ status: 400, description: 'Neither url nor base64 given, or ffmpeg refused the input.' })
  @ApiResponse({ status: 413, description: 'The supplied media is above the media size cap.' })
  @ApiResponse({
    status: 503,
    description:
      'Conversion is disabled, the ffmpeg binary is not runnable, or the conversion queue is saturated — retry shortly.',
  })
  async convertVideo(@Body() dto: ConvertMediaDto) {
    return this.mediaConversion.convertToVideo(dto);
  }
}
