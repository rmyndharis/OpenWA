import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { LabelService } from './label.service';
import { AddLabelDto } from './dto/add-label.dto';
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
