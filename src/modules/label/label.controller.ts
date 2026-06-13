import { Controller, Get, Post, Delete, Param, Body, BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { SessionService } from '../session/session.service';

@ApiTags('labels')
@Controller('sessions/:sessionId/labels')
export class LabelController {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

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
    const engine = this.getEngine(sessionId);
    return engine.getLabels();
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
    const engine = this.getEngine(sessionId);
    const label = await engine.getLabelById(labelId);
    if (!label) {
      throw new NotFoundException(`Label ${labelId} not found`);
    }
    return label;
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
    const engine = this.getEngine(sessionId);
    return engine.getChatLabels(chatId);
  }

  @Post('chat/:chatId')
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
  async addLabelToChat(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Body() body: { labelId: string },
  ) {
    const engine = this.getEngine(sessionId);
    await engine.addLabelToChat(chatId, body.labelId);
    return { success: true };
  }

  @Delete('chat/:chatId/:labelId')
  @ApiOperation({ summary: 'Remove a label from a chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID' })
  @ApiParam({ name: 'labelId', description: 'Label ID to remove' })
  @ApiResponse({
    status: 200,
    description: 'Label removed from chat',
  })
  async removeLabelFromChat(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('labelId') labelId: string,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.removeLabelFromChat(chatId, labelId);
    return { success: true };
  }
}
