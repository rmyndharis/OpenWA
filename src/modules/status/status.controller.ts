import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { StatusService } from './status.service';
import { SendTextStatusDto } from './dto/send-text-status.dto';
import { SendImageStatusDto, SendVideoStatusDto } from './dto/send-media-status.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('status')
@Controller('sessions/:sessionId/status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contact status updates' })
  @ApiResponse({ status: 200, description: 'Status updates visible to the session, grouped by contact.' })
  async getStatuses(@Param('sessionId') sessionId: string) {
    return { statuses: await this.statusService.getStatuses(sessionId) };
  }

  @Get(':contactId')
  @ApiOperation({ summary: 'Get status updates from a specific contact' })
  @ApiResponse({ status: 200, description: 'Status updates from the requested contact.' })
  async getContactStatus(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    return { statuses: await this.statusService.getContactStatus(sessionId, contactId) };
  }

  @Post('send-text')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Post a text status' })
  @ApiResponse({
    status: 201,
    description:
      'Text status posted. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts ' +
      "to the account's status-privacy audience.",
  })
  @ApiResponse({ status: 400, description: 'Invalid request, or the post was blocked by a plugin.' })
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
  })
  @ApiResponse({
    status: 400,
    description: 'Neither url nor base64 provided, or the post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: 'Base64 media exceeds MEDIA_DOWNLOAD_MAX_BYTES.' })
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
  })
  @ApiResponse({
    status: 400,
    description: 'Neither url nor base64 provided, or the post was blocked by a plugin.',
  })
  @ApiResponse({ status: 413, description: 'Base64 media exceeds MEDIA_DOWNLOAD_MAX_BYTES.' })
  async sendVideoStatus(@Param('sessionId') sessionId: string, @Body() dto: SendVideoStatusDto) {
    return this.statusService.postVideoStatus(sessionId, dto.video, {
      recipients: dto.recipients,
      caption: dto.caption,
    });
  }

  @Delete(':statusId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete own status' })
  @ApiResponse({ status: 200, description: 'Status deleted.' })
  async deleteStatus(@Param('sessionId') sessionId: string, @Param('statusId') statusId: string) {
    await this.statusService.deleteStatus(sessionId, statusId);
    return { message: 'Status deleted successfully' };
  }
}
