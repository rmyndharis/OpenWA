import { Controller, Get, Post, Put, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { LabelService } from './label.service';
import { AddLabelDto } from './dto/add-label.dto';
import { UpsertLabelDto } from './dto/upsert-label.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('labels')
@Controller('sessions/:sessionId/labels')
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  @Get()
  @ApiOperation({ summary: 'Get all labels (WhatsApp Business only)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of labels',
  })
  @ApiResponse({ status: 400, description: 'Session not ready or not a business account' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async findAll(@Param('sessionId') sessionId: string) {
    return this.labelService.getLabels(sessionId);
  }

  @Get(':labelId')
  @ApiOperation({ summary: 'Get a specific label by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID' })
  @ApiResponse({
    status: 200,
    description: 'Label details',
  })
  @ApiResponse({ status: 404, description: 'Label not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('labelId') labelId: string) {
    return this.labelService.getLabelById(sessionId, labelId);
  }

  @Get(':labelId/chats')
  @ApiOperation({
    summary: 'Get every chat carrying a label',
    description:
      'whatsapp-web.js only. Baileys exposes label writes but no label query of any kind, so it ' + 'answers `501`.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID' })
  @ApiResponse({ status: 200, description: 'Chats carrying the label' })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 501, description: 'The active engine cannot list chats by label (Baileys)' })
  async getChatsByLabel(@Param('sessionId') sessionId: string, @Param('labelId') labelId: string) {
    return this.labelService.getChatsByLabel(sessionId, labelId);
  }

  @Put(':labelId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or update a label',
    description:
      'Baileys only. `PUT` rather than `POST` because the label id is chosen by the caller: WhatsApp ' +
      'carries one `label_edit` write keyed on that id, so whether this creates or updates depends ' +
      'purely on whether the id already exists, and there is no server-assigned id to return.\n\n' +
      '**Choose an unused id to create.** Reusing one silently rewrites that label rather than ' +
      'failing, because the protocol has no create-only form. Fields left out are left alone.\n\n' +
      'whatsapp-web.js can read and assign labels but cannot edit one, and answers `501`.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID — caller-chosen' })
  @ApiBody({ type: UpsertLabelDto })
  @ApiResponse({ status: 200, description: 'Label created or updated' })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 501, description: 'The active engine cannot edit labels (whatsapp-web.js)' })
  async upsertLabel(
    @Param('sessionId') sessionId: string,
    @Param('labelId') labelId: string,
    @Body() dto: UpsertLabelDto,
  ): Promise<{ success: boolean }> {
    await this.labelService.upsertLabel(sessionId, labelId, dto);
    return { success: true };
  }

  @Delete(':labelId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a label',
    description:
      'Baileys only. The label disappears from every chat it was on. whatsapp-web.js cannot edit ' +
      'labels and answers `501`.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID' })
  @ApiResponse({ status: 200, description: 'Label deleted' })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 501, description: 'The active engine cannot edit labels (whatsapp-web.js)' })
  async deleteLabel(
    @Param('sessionId') sessionId: string,
    @Param('labelId') labelId: string,
  ): Promise<{ success: boolean }> {
    await this.labelService.deleteLabel(sessionId, labelId);
    return { success: true };
  }

  @Get('chat/:chatId')
  @ApiOperation({ summary: 'Get labels for a specific chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID' })
  @ApiResponse({
    status: 200,
    description: 'List of labels for the chat',
  })
  async getChatLabels(@Param('sessionId') sessionId: string, @Param('chatId') chatId: string) {
    return this.labelService.getChatLabels(sessionId, chatId);
  }

  @Post('chat/:chatId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a label to a chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        labelId: { type: 'string', description: 'Label ID to add' },
      },
      required: ['labelId'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Label added to chat',
  })
  @ApiResponse({
    status: 422,
    description: 'Labels require a WhatsApp Business account, or the chat type has no labels',
  })
  async addLabelToChat(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Body() body: AddLabelDto,
  ) {
    await this.labelService.addLabelToChat(sessionId, chatId, body.labelId);
    return { success: true };
  }

  @Delete('chat/:chatId/:labelId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Remove a label from a chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID to remove' })
  @ApiResponse({
    status: 200,
    description: 'Label removed from chat',
  })
  @ApiResponse({
    status: 422,
    description: 'Labels require a WhatsApp Business account, or the chat type has no labels',
  })
  async removeLabelFromChat(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('labelId') labelId: string,
  ) {
    await this.labelService.removeLabelFromChat(sessionId, chatId, labelId);
    return { success: true };
  }
}
