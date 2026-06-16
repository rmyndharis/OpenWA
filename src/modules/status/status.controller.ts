import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { StatusService } from './status.service';
import { SendTextStatusDto } from './dto/send-text-status.dto';
import { SendImageStatusDto, SendVideoStatusDto } from './dto/send-media-status.dto';

@ApiTags('Status')
@ApiSecurity('X-API-Key')
@Controller('sessions/:sessionId/status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contact status updates' })
  async getStatuses(@Param('sessionId') sessionId: string) {
    return { statuses: await this.statusService.getStatuses(sessionId) };
  }

  @Get(':contactId')
  @ApiOperation({ summary: 'Get status updates from a specific contact' })
  async getContactStatus(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    return { statuses: await this.statusService.getContactStatus(sessionId, contactId) };
  }

  @Post('send-text')
  @ApiOperation({ summary: 'Post a text status' })
  async sendTextStatus(@Param('sessionId') sessionId: string, @Body() dto: SendTextStatusDto) {
    return this.statusService.postTextStatus(sessionId, dto.text, {
      backgroundColor: dto.backgroundColor,
      font: dto.font,
    });
  }

  @Post('send-image')
  @ApiOperation({ summary: 'Post an image status' })
  async sendImageStatus(@Param('sessionId') sessionId: string, @Body() dto: SendImageStatusDto) {
    return this.statusService.postImageStatus(sessionId, dto.image, dto.caption);
  }

  @Post('send-video')
  @ApiOperation({ summary: 'Post a video status' })
  async sendVideoStatus(@Param('sessionId') sessionId: string, @Body() dto: SendVideoStatusDto) {
    return this.statusService.postVideoStatus(sessionId, dto.video, dto.caption);
  }

  @Delete(':statusId')
  @ApiOperation({ summary: 'Delete own status' })
  async deleteStatus(@Param('sessionId') sessionId: string, @Param('statusId') statusId: string) {
    await this.statusService.deleteStatus(sessionId, statusId);
    return { message: 'Status deleted successfully' };
  }
}
