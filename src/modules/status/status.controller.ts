import { Controller, Get, Post, Delete, Param, Body, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { StatusDeletedResponseDto, StatusListResponseDto, StatusResultDto } from './dto/status-response.dto';
import { StatusService } from './status.service';
import { SendTextStatusDto } from './dto/send-text-status.dto';
import { SendImageStatusDto, SendVideoStatusDto, SendVoiceStatusDto } from './dto/send-media-status.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { ENGINE_NOT_READY_409, SESSION_NOT_STARTED_404 } from '../../common/openapi/engine-status-responses';

@ApiTags('status')
@Controller('sessions/:sessionId/status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contact status updates' })
  @ApiResponse({
    status: 200,
    description: 'Status updates visible to the session, grouped by contact.',
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
    description: 'The status image/video bytes.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 404, description: 'No stored media (text status, omitted, or expired).' })
  async getStatusMedia(
    @Param('sessionId') sessionId: string,
    @Param('statusId') statusId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, mimetype } = await this.statusService.getStatusMedia(sessionId, statusId);
    res.set({ 'Content-Type': mimetype, 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(buffer);
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
    description: 'Neither url nor base64 provided, or the post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: 'Base64 media exceeds MEDIA_DOWNLOAD_MAX_BYTES.' })
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
    description: 'Neither url nor base64 provided, or the post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: 'Base64 media exceeds MEDIA_DOWNLOAD_MAX_BYTES.' })
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
    description: 'Neither url nor base64 provided, or the post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: 'Base64 media exceeds MEDIA_DOWNLOAD_MAX_BYTES.' })
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
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async deleteStatus(@Param('sessionId') sessionId: string, @Param('id') statusId: string) {
    await this.statusService.deleteStatus(sessionId, statusId);
    return { message: 'Status deleted successfully' };
  }
}
