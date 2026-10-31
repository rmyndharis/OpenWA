import { Controller, Get, Post, Delete, Param, Body, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { StatusDeletedResponseDto, StatusListResponseDto, StatusResultDto } from './dto/status-response.dto';
import { StatusService } from './status.service';
import { retryAfterWhenBusy, storedFileAttachment } from '../../common/storage/storage-transfer';
import { SendTextStatusDto } from './dto/send-text-status.dto';
import { SendImageStatusDto, SendVideoStatusDto, SendVoiceStatusDto } from './dto/send-media-status.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  ENGINE_NOT_READY_409,
  MEDIA_TOO_LARGE_413,
  MEDIA_URL_PROXY_503,
  SESSION_NOT_STARTED_404,
  STATUS_POST_503,
} from '../../common/openapi/engine-status-responses';

@ApiTags('status')
@Controller('sessions/:sessionId/status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contact status updates' })
  @ApiResponse({
    status: 200,
    description: 'Status updates visible to the session, newest first.',
    type: StatusListResponseDto,
  })
  async getStatuses(@Param('sessionId') sessionId: string) {
    return { statuses: await this.statusService.getStatuses(sessionId) };
  }

  // The segment is `:id` on both verbs because GET reads a contact's statuses and DELETE removes one
  // of our own. Naming it per verb gave the same route two contract entries; the meaning belongs in
  // @ApiParam, which is per-operation.
  @Get(':id')
  @ApiOperation({ summary: 'Get status updates from a specific contact' })
  @ApiParam({ name: 'id', description: 'Contact ID' })
  @ApiResponse({ status: 200, description: 'Status updates from the requested contact.', type: StatusListResponseDto })
  async getContactStatus(@Param('sessionId') sessionId: string, @Param('id') contactId: string) {
    return { statuses: await this.statusService.getContactStatus(sessionId, contactId) };
  }

  // Two path segments (`:statusId/media`) never collides with the single-segment `:id`
  // route above regardless of declaration order — Nest/Express match on segment count.
  @Get(':statusId/media')
  @ApiOperation({ summary: 'Stream a stored status media file' })
  @ApiResponse({
    status: 200,
    description: 'The status image, video or voice note (audio) bytes.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 404, description: 'No stored media (text status, omitted, or expired).' })
  @ApiResponse({
    status: 503,
    description:
      'On S3 storage, the gateway already has 50 media downloads open across the status and chat media ' +
      'routes. Retry once the Retry-After header (1 second) has passed.',
  })
  async getStatusMedia(
    @Param('sessionId') sessionId: string,
    @Param('statusId') statusId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { mimetype, ...source } = await this.statusService
      .getStatusMedia(sessionId, statusId)
      .catch(retryAfterWhenBusy(res));
    // attachment + nosniff together, mirroring the chat-media route: the mimetype is already
    // reduced to an inert set by the service, and forcing a download means even a mistake there
    // cannot render as active content on the API origin. The dashboard fetches status media as a
    // blob (fetch ignores Content-Disposition), so nothing depends on inline display here.
    return storedFileAttachment(res, source, mimetype);
  }

  @Post('send-text')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Post a text status' })
  @ApiResponse({
    status: 201,
    description:
      'Text status posted. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts ' +
      "to the account's status-privacy audience.",
    type: StatusResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request, or the post was blocked by a plugin.' })
  @ApiResponse({ status: 503, description: STATUS_POST_503 })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async sendTextStatus(@Param('sessionId') sessionId: string, @Body() dto: SendTextStatusDto) {
    return this.statusService.postTextStatus(sessionId, dto.text, {
      recipients: dto.recipients,
      backgroundColor: dto.backgroundColor,
      font: dto.font,
    });
  }

  @Post('send-image')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Post an image status' })
  @ApiResponse({
    status: 201,
    description:
      'Image status posted. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts ' +
      "to the account's status-privacy audience.",
    type: StatusResultDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Neither url nor base64 provided, the url answers non-2xx, times out or cannot be reached, or the ' +
      'post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: MEDIA_TOO_LARGE_413 })
  @ApiResponse({ status: 503, description: `${MEDIA_URL_PROXY_503} ${STATUS_POST_503}` })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async sendImageStatus(@Param('sessionId') sessionId: string, @Body() dto: SendImageStatusDto) {
    return this.statusService.postImageStatus(sessionId, dto.image, {
      recipients: dto.recipients,
      caption: dto.caption,
    });
  }

  @Post('send-video')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Post a video status' })
  @ApiResponse({
    status: 201,
    description:
      'Video status posted. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts ' +
      "to the account's status-privacy audience.",
    type: StatusResultDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Neither url nor base64 provided, the url answers non-2xx, times out or cannot be reached, or the ' +
      'post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: MEDIA_TOO_LARGE_413 })
  @ApiResponse({ status: 503, description: `${MEDIA_URL_PROXY_503} ${STATUS_POST_503}` })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async sendVideoStatus(@Param('sessionId') sessionId: string, @Body() dto: SendVideoStatusDto) {
    return this.statusService.postVideoStatus(sessionId, dto.video, {
      recipients: dto.recipients,
      caption: dto.caption,
    });
  }

  @Post('send-voice')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Post an audio status as a voice note' })
  @ApiResponse({
    status: 201,
    description:
      'Voice status posted. WhatsApp plays a status voice note only as Ogg/Opus and neither engine ' +
      'transcodes, so convert first via POST /media/convert/voice. The recipients allow-list is honored ' +
      "on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.",
    type: StatusResultDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Neither url nor base64 provided, the url answers non-2xx, times out or cannot be reached, or the ' +
      'post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: MEDIA_TOO_LARGE_413 })
  @ApiResponse({ status: 503, description: `${MEDIA_URL_PROXY_503} ${STATUS_POST_503}` })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async sendVoiceStatus(@Param('sessionId') sessionId: string, @Body() dto: SendVoiceStatusDto) {
    return this.statusService.postVoiceStatus(sessionId, dto.audio, {
      recipients: dto.recipients,
      backgroundColor: dto.backgroundColor,
    });
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete own status' })
  @ApiParam({ name: 'id', description: 'Status ID' })
  @ApiResponse({ status: 200, description: 'Status deleted.', type: StatusDeletedResponseDto })
  @ApiResponse({
    status: 403,
    description:
      "Key lacks OPERATOR role; on whatsapp-web.js, the id is not one of the account's own statuses; on " +
      'Baileys, the status was not posted by this session in the last 24 hours (it was posted from the phone ' +
      "or from another node, or before the session's engine was last created by a restart, a stop and start, " +
      'or a reconnect the gateway runs itself), so its recipients are unknown and the revoke cannot be ' +
      'addressed to them.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  @ApiResponse({
    status: 503,
    description:
      'The whatsapp-web.js page connection died mid-request, so the revoke did not complete. Safe ' +
      'to retry: revoking an already-revoked status converges. The status POST routes deliberately ' +
      'do NOT answer this for whatsapp-web.js, because a replayed post would publish the status a second ' +
      'time. On Baileys, also when WhatsApp rate-limits the revoke (code 429) or times out a query it ' +
      'awaits (code 408).',
  })
  async deleteStatus(@Param('sessionId') sessionId: string, @Param('id') statusId: string) {
    await this.statusService.deleteStatus(sessionId, statusId);
    return { message: 'Status deleted successfully' };
  }
}
