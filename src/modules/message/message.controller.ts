import { Controller, Post, Get, Param, Body, Query, Res, HttpCode, HttpStatus, StreamableFile } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import {
  SendTextMessageDto,
  SendMediaMessageDto,
  SendAudioMessageDto,
  MessageResponseDto,
  SEND_TEXT_BODY_EXAMPLES,
  SEND_IMAGE_BODY_EXAMPLES,
  SEND_VIDEO_BODY_EXAMPLES,
  SEND_AUDIO_BODY_EXAMPLES,
  SEND_DOCUMENT_BODY_EXAMPLES,
  SEND_STICKER_BODY_EXAMPLES,
} from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { SendBulkMessageDto, BulkMessageResponseDto } from './dto/bulk-message.dto';
import {
  SendLocationDto,
  SendContactDto,
  SendPollDto,
  ReplyMessageDto,
  ForwardMessageDto,
  ReactMessageDto,
  DeleteMessageDto,
  EditMessageDto,
  PinMessageDto,
  StarMessageDto,
  VotePollDto,
  UnpinMessageDto,
} from './dto/message-actions.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('messages')
@Controller('sessions/:sessionId/messages')
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly bulkMessageService: BulkMessageService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get message history for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'chatId', required: false, description: 'Filter by chat ID' })
  @ApiQuery({
    name: 'from',
    required: false,
    description:
      'Filter by sender. A phone also matches group messages via the author field and any lid that resolves to it.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max messages to return (default 50)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset for pagination' })
  @ApiResponse({
    status: 200,
    description: 'Message history',
  })
  async getMessages(
    @Param('sessionId') sessionId: string,
    @Query('chatId') chatId?: string,
    @Query('from') from?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.messageService.getMessages(sessionId, {
      chatId,
      from,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Post('send-text')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a text message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  // Without an explicit example Swagger UI samples the body from EVERY property, which pairs
  // `linkPreview: false` with a `customLinkPreview` — the combination sendText rejects (#1068).
  @ApiBody({ type: SendTextMessageDto, examples: SEND_TEXT_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Message sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async sendText(@Param('sessionId') sessionId: string, @Body() dto: SendTextMessageDto): Promise<MessageResponseDto> {
    return this.messageService.sendText(sessionId, dto);
  }

  @Post('send-template')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Render a stored text template and send it as a text message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Template rendered and sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  @ApiResponse({ status: 404, description: 'Session or template not found' })
  async sendTemplate(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendTemplateMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendTemplate(sessionId, dto);
  }

  @Post('send-image')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send an image message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  // Without an explicit example Swagger UI samples `url` AND `base64` into the body, and base64 wins
  // in buildMediaInput — so Execute uploaded the literal string "string" instead of the URL (#1068).
  @ApiBody({ type: SendMediaMessageDto, examples: SEND_IMAGE_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Image sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendImage(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMediaMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendImage(sessionId, dto);
  }

  @Post('send-video')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a video message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SendMediaMessageDto, examples: SEND_VIDEO_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Video sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendVideo(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMediaMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendVideo(sessionId, dto);
  }

  @Post('send-audio')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send an audio/voice message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SendAudioMessageDto, examples: SEND_AUDIO_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Audio sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendAudio(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendAudioMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendAudio(sessionId, dto);
  }

  @Post('send-document')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a document/file' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SendMediaMessageDto, examples: SEND_DOCUMENT_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Document sent',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendDocument(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMediaMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendDocument(sessionId, dto);
  }

  // ========== Phase 3: Extended Messaging ==========

  @Post('send-location')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a location message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Location sent',
    type: MessageResponseDto,
  })
  async sendLocation(@Param('sessionId') sessionId: string, @Body() dto: SendLocationDto): Promise<MessageResponseDto> {
    return this.messageService.sendLocation(sessionId, dto);
  }

  @Post('send-contact')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a contact card message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Contact sent',
    type: MessageResponseDto,
  })
  async sendContact(@Param('sessionId') sessionId: string, @Body() dto: SendContactDto): Promise<MessageResponseDto> {
    return this.messageService.sendContact(sessionId, dto);
  }

  @Post('send-sticker')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a sticker message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SendMediaMessageDto, examples: SEND_STICKER_BODY_EXAMPLES })
  @ApiResponse({
    status: 201,
    description: 'Sticker sent',
    type: MessageResponseDto,
  })
  async sendSticker(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMediaMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messageService.sendSticker(sessionId, dto);
  }

  @Post('send-poll')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a native WhatsApp poll' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Poll sent',
    type: MessageResponseDto,
  })
  async sendPoll(@Param('sessionId') sessionId: string, @Body() dto: SendPollDto): Promise<MessageResponseDto> {
    return this.messageService.sendPoll(sessionId, dto);
  }

  @Post('reply')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Reply to a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Reply sent',
    type: MessageResponseDto,
  })
  async reply(@Param('sessionId') sessionId: string, @Body() dto: ReplyMessageDto): Promise<MessageResponseDto> {
    return this.messageService.reply(sessionId, dto);
  }

  @Post('forward')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Forward a message to another chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 201,
    description: 'Message forwarded',
    type: MessageResponseDto,
  })
  async forward(@Param('sessionId') sessionId: string, @Body() dto: ForwardMessageDto): Promise<MessageResponseDto> {
    return this.messageService.forward(sessionId, dto);
  }

  // ========== Phase 3: Reactions ==========

  @Post('react')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Add or remove a reaction to a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Reaction added or removed. Send empty emoji to remove reaction.',
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or message not found',
  })
  async react(@Param('sessionId') sessionId: string, @Body() dto: ReactMessageDto): Promise<{ success: boolean }> {
    await this.messageService.reactToMessage(sessionId, dto);
    return { success: true };
  }

  @Get(':chatId/history')
  @ApiOperation({
    summary: 'Fetch chat history live from WhatsApp',
    description:
      'Reads messages directly from the WhatsApp client for the given chat, bypassing the local DB. ' +
      'Useful for retrieving messages that arrived before the gateway was started.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID (e.g. 1234567890@c.us or groupId@g.us)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max messages to return (default 50)' })
  @ApiQuery({
    name: 'includeMedia',
    required: false,
    type: Boolean,
    description: 'When true, downloads media (base64) for messages that have it. Slower; default false.',
  })
  @ApiQuery({
    name: 'deep',
    required: false,
    type: Boolean,
    description:
      'When true, raises the limit ceiling from 100 to 2000 for reaching further back in history ' +
      '(whatsapp-web.js only; loads earlier messages on demand). Forces metadata-only (includeMedia ' +
      'is ignored). Large/slow requests may increase WhatsApp rate-limiting risk; default false.',
  })
  @ApiResponse({ status: 200, description: 'Chat history (most recent messages)' })
  async getChatHistory(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
    @Query('includeMedia') includeMedia?: string,
    @Query('deep') deep?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    // Parse the limit defensively: a non-numeric query value (?limit=abc) yields NaN,
    // so fall back to undefined and let the service apply its default + clamp.
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    // A client that disconnects mid-history (includeMedia can mean dozens of multi-MB downloads) must
    // stop the loop: `close` fires on premature disconnect AND after a normal finish — aborting then is
    // a no-op because the loop has already run to completion.
    const abort = new AbortController();
    res?.on('close', () => abort.abort());
    return this.messageService.getChatHistory(
      sessionId,
      chatId,
      parsedLimit !== undefined && !Number.isNaN(parsedLimit) ? parsedLimit : undefined,
      includeMedia === 'true' || includeMedia === '1',
      deep === 'true' || deep === '1',
      abort.signal,
    );
  }

  @Get(':chatId/:messageId/reactions')
  @ApiOperation({ summary: 'Get reactions for a specific message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID containing the message' })
  @ApiParam({ name: 'messageId', description: 'Message ID to get reactions for' })
  @ApiResponse({
    status: 200,
    description: 'List of reactions with senders',
  })
  async getReactions(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messageService.getMessageReactions(sessionId, chatId, messageId);
  }

  // Three path segments, so it never collides with `:chatId/history` (two) regardless of
  // declaration order — Nest/Express match on segment count first.
  @Get(':chatId/:messageId/media')
  @ApiOperation({ summary: 'Download a message’s archived media' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID containing the message' })
  @ApiParam({ name: 'messageId', description: 'WhatsApp message ID whose media to download' })
  @ApiResponse({ status: 200, description: 'The archived media bytes, served as an attachment.' })
  @ApiResponse({
    status: 404,
    description:
      'Nothing archived for this message — archiving was off when it arrived, the message carries no ' +
      'media, the media was above the archive cap, retention has since cleared it, or the message ' +
      'was sent BY this account (only inbound media is archived).',
  })
  async getChatMedia(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, mimetype } = await this.messageService.getChatMedia(sessionId, chatId, messageId);
    // attachment + nosniff together: the mimetype is already reduced to an inert set, and forcing a
    // download means even a mistake there cannot render as active content on the API origin. The
    // dashboard renders chat media from the inline copy, so nothing depends on inline display here.
    res.set({
      'Content-Type': mimetype,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
    });
    return new StreamableFile(buffer);
  }

  // ========== Delete Message ==========

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Message deleted',
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or message not found',
  })
  async deleteMessage(
    @Param('sessionId') sessionId: string,
    @Body() dto: DeleteMessageDto,
  ): Promise<{ success: boolean }> {
    await this.messageService.deleteMessage(sessionId, dto);
    return { success: true };
  }

  @Post('vote-poll')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Cast a vote on a poll' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Vote cast' })
  @ApiResponse({ status: 400, description: 'Session not active, or the target message is not a poll' })
  @ApiResponse({ status: 404, description: 'Poll not found in the chat’s recent history' })
  @ApiResponse({ status: 501, description: 'Not supported on the Baileys engine' })
  async votePoll(@Param('sessionId') sessionId: string, @Body() dto: VotePollDto): Promise<{ success: boolean }> {
    return this.messageService.votePoll(sessionId, dto);
  }

  // ========== Pin / Unpin ==========

  @Post('pin')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Pin a message in its chat' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Message pinned' })
  @ApiResponse({
    status: 400,
    description: 'Session not active, or durationSeconds is not one of 86400 / 604800 / 2592000',
  })
  @ApiResponse({ status: 403, description: 'The engine refused the pin — in a group only admins may pin' })
  @ApiResponse({ status: 404, description: 'Message not found in the chat' })
  async pinMessage(@Param('sessionId') sessionId: string, @Body() dto: PinMessageDto): Promise<{ success: boolean }> {
    return this.messageService.pinMessage(sessionId, dto);
  }

  @Post('unpin')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Remove a message’s pin' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Message unpinned' })
  @ApiResponse({ status: 400, description: 'Session not active' })
  @ApiResponse({ status: 403, description: 'The engine refused the unpin — in a group only admins may unpin' })
  @ApiResponse({ status: 404, description: 'Message not found in the chat' })
  async unpinMessage(
    @Param('sessionId') sessionId: string,
    @Body() dto: UnpinMessageDto,
  ): Promise<{ success: boolean }> {
    return this.messageService.unpinMessage(sessionId, dto);
  }

  @Post('star')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Star or unstar a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description:
      'Instruction delivered. On whatsapp-web.js the engine silently ignores a message it will not ' +
      'star, so this does not guarantee the star is set.',
  })
  @ApiResponse({ status: 400, description: 'Session not active' })
  @ApiResponse({ status: 404, description: 'Message not found in the chat' })
  async starMessage(@Param('sessionId') sessionId: string, @Body() dto: StarMessageDto): Promise<{ success: boolean }> {
    return this.messageService.starMessage(sessionId, dto);
  }

  // ========== Edit Message ==========

  @Post('edit')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Edit the text of a message sent by this account' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Message edited',
    type: MessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active, invalid request, or the send was blocked by a plugin',
  })
  @ApiResponse({
    status: 403,
    description: 'The message was not sent by this account, or the engine refused the edit',
  })
  @ApiResponse({ status: 404, description: 'Message not found' })
  async edit(@Param('sessionId') sessionId: string, @Body() dto: EditMessageDto): Promise<MessageResponseDto> {
    return this.messageService.editMessage(sessionId, dto);
  }

  // ========== Bulk Messaging ==========

  @Post('send-bulk')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send messages to multiple recipients (async batch processing)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 202,
    description: 'Batch created and processing started',
    type: BulkMessageResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Session not active or invalid request',
  })
  async sendBulk(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendBulkMessageDto,
  ): Promise<BulkMessageResponseDto> {
    const batch = await this.bulkMessageService.createBatch(sessionId, dto);
    const estimatedTime = new Date(Date.now() + batch.messages.length * (batch.options?.delayBetweenMessages || 3000));

    return {
      batchId: batch.batchId,
      status: batch.status,
      totalMessages: batch.messages.length,
      estimatedCompletionTime: estimatedTime.toISOString(),
      statusUrl: `/api/sessions/${sessionId}/messages/batch/${batch.batchId}`,
    };
  }

  @Get('batch/:batchId')
  @ApiOperation({ summary: 'Get batch processing status' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'batchId', description: 'Batch ID' })
  @ApiResponse({
    status: 200,
    description: 'Batch status and progress',
  })
  @ApiResponse({
    status: 404,
    description: 'Batch not found',
  })
  async getBatchStatus(@Param('sessionId') sessionId: string, @Param('batchId') batchId: string) {
    const batch = await this.bulkMessageService.getBatchStatus(sessionId, batchId);
    return {
      batchId: batch.batchId,
      status: batch.status,
      progress: batch.progress,
      results: batch.results,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
    };
  }

  @Post('batch/:batchId/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running batch' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'batchId', description: 'Batch ID' })
  @ApiResponse({
    status: 200,
    description: 'Batch cancelled',
  })
  @ApiResponse({
    status: 400,
    description: 'Batch already completed, cancelled, or failed (terminal statuses are exclusive)',
  })
  @ApiResponse({
    status: 404,
    description: 'Batch not found',
  })
  async cancelBatch(@Param('sessionId') sessionId: string, @Param('batchId') batchId: string) {
    const batch = await this.bulkMessageService.cancelBatch(sessionId, batchId);
    return {
      batchId: batch.batchId,
      status: batch.status,
      progress: batch.progress,
    };
  }
}
