import { Controller, Get, Post, Put, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { LabelAckResponseDto, LabelChatDto, LabelDto } from './dto/label-response.dto';
import { LabelService } from './label.service';
import { AddLabelDto } from './dto/add-label.dto';
import { UpsertLabelDto } from './dto/upsert-label.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  ENGINE_NOT_READY_409,
  ENGINE_NOT_SUPPORTED_501,
  LABEL_NOT_FOUND_404,
} from '../../common/openapi/engine-status-responses';

@ApiTags('labels')
@Controller('sessions/:sessionId/labels')
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  @Get()
  @ApiOperation({ summary: 'Get all labels (WhatsApp Business only)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of labels', type: [LabelDto] })
  @ApiResponse({ status: 400, description: 'Session not ready or not a business account' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 501, description: ENGINE_NOT_SUPPORTED_501 })
  async findAll(@Param('sessionId') sessionId: string) {
    return this.labelService.getLabels(sessionId);
  }

  @Get(':labelId')
  @ApiOperation({ summary: 'Get a specific label by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID' })
  @ApiResponse({ status: 200, description: 'Label details', type: LabelDto })
  @ApiResponse({ status: 404, description: 'Label not found' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 501, description: ENGINE_NOT_SUPPORTED_501 })
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
  @ApiResponse({ status: 200, description: 'Chats carrying the label', type: [LabelChatDto] })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 501, description: 'The active engine cannot list chats by label (Baileys)' })
  @ApiResponse({
    status: 503,
    description:
      'The whatsapp-web.js page connection died mid-read, so nothing could be read. Deliberately not ' +
      'reported as a missing label — a page that went away says nothing about whether the label exists. ' +
      'The other engine never answers this: Baileys has no label query at all and answers 501 above.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: LABEL_NOT_FOUND_404 })
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
  @ApiResponse({ status: 200, description: 'Label created or updated', type: LabelAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 501, description: 'The active engine cannot edit labels (whatsapp-web.js)' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
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
  @ApiResponse({ status: 200, description: 'Label deleted', type: LabelAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 501, description: 'The active engine cannot edit labels (whatsapp-web.js)' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
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
  @ApiResponse({ status: 200, description: 'List of labels for the chat', type: [LabelDto] })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 501, description: ENGINE_NOT_SUPPORTED_501 })
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
  @ApiResponse({ status: 200, description: 'Label added to chat', type: LabelAckResponseDto })
  @ApiResponse({
    status: 422,
    description: 'Labels require a WhatsApp Business account, or the chat type has no labels',
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
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
  @ApiResponse({ status: 200, description: 'Label removed from chat', type: LabelAckResponseDto })
  @ApiResponse({
    status: 422,
    description: 'Labels require a WhatsApp Business account, or the chat type has no labels',
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async removeLabelFromChat(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('labelId') labelId: string,
  ) {
    await this.labelService.removeLabelFromChat(sessionId, chatId, labelId);
    return { success: true };
  }
}
