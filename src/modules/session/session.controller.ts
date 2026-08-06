import { Controller, Get, Post, Delete, Param, Query, Body, HttpCode, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { SessionService } from './session.service';
import {
  CreateSessionDto,
  SessionResponseDto,
  QRCodeResponseDto,
  MarkChatReadDto,
  SubscribePresenceDto,
  ChatPresenceResponseDto,
  ArchiveChatDto,
  DeleteChatDto,
  SendChatStateDto,
  RequestPairingCodeDto,
  PairingCodeResponseDto,
  ChatSummaryDto,
} from './dto';
import { Session } from './entities/session.entity';
import { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { RequireRole, CurrentApiKey, SessionScoped, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('sessions')
@Controller('sessions')
// The `:id` route param here is a WhatsApp session id, so the ApiKeyGuard enforces a key's
// allowedSessions scope against it (other controllers' `:id` is an unrelated resource id).
@SessionScoped()
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  private transformSession(session: Session): SessionResponseDto {
    // isActive() is the engine map itself, so this is read at response time — a session that just
    // finished reconnecting reports the engine in the same response that reports its status.
    return SessionResponseDto.fromEntity(session, this.sessionService.isActive(session.id));
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  // Creating a session has no existing session id for the class-level @SessionScoped fence to check,
  // and the new session is outside the caller's allowlist by construction — so a key restricted to
  // specific sessions cannot create one. Different metadata key from @SessionScoped; they coexist.
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Create a new WhatsApp session' })
  @ApiResponse({
    status: 201,
    description: 'Session created',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 409, description: 'Session name already exists' })
  async create(@Body() dto: CreateSessionDto): Promise<SessionResponseDto> {
    const session = await this.sessionService.create(dto);
    await this.auditService.logInfo(AuditAction.SESSION_CREATED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Get()
  @ApiOperation({ summary: 'List all sessions' })
  @ApiResponse({
    status: 200,
    description: 'List of sessions',
    type: [SessionResponseDto],
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max sessions to return (1-1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of sessions to skip (for paging)' })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<SessionResponseDto[]> {
    // Scope to the key's allowedSessions so a session-restricted key cannot enumerate every
    // session. A null/empty allowlist (e.g. ADMIN) still lists all.
    const sessions = await this.sessionService.findAll(apiKey?.allowedSessions, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return sessions.map(s => this.transformSession(s));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get session by ID' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session details',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.findOne(id);
    return this.transformSession(session);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 204, description: 'Session deleted' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 409,
    description:
      'A credential teardown for the same session name is still in flight (retryable — the body ' +
      "carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`; wait for it to settle and retry), OR " +
      "another node currently holds this session's live engine and deleting it here would strip a " +
      'session the owner is running. No destructive side effect runs before either refusal.',
  })
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const session = await this.sessionService.findOne(id);
    await this.sessionService.delete(id);
    await this.auditService.logInfo(AuditAction.SESSION_DELETED, {
      sessionId: id,
      sessionName: session.name,
    });
  }

  @Post(':id/start')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a session and initialize WhatsApp connection',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session started',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Session already started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 409,
    description:
      'A credential teardown for the same session name is still in flight (e.g. a prior logout ' +
      'that owns destructive cleanup). Retryable — the body carries `code: ' +
      'SESSION_NAME_TEARDOWN_PENDING`; wait for it to settle and retry. No destructive side ' +
      'effect runs before this refusal. Also returned when another node currently holds this ' +
      "session's engine: only the owner may start it, and the claim is refused before any engine " +
      'is launched, so no second connection to the account is opened.',
  })
  async start(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.start(id);
    await this.auditService.logInfo(AuditAction.SESSION_STARTED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/stop')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop a session and disconnect WhatsApp' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session stopped',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 409,
    description:
      "Another node currently holds this session's live engine (multi-node deployments): stopping " +
      'it here would report the session down while the owner keeps running it, so the request is ' +
      'refused. Retry against the owning node, or once its lease has lapsed.',
  })
  async stop(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.stop(id);
    await this.auditService.logInfo(AuditAction.SESSION_STOPPED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/logout')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log out of WhatsApp (unlinks this device) and stop the session',
    description:
      'Attempts an engine-native unlink of this companion device, then tears the session down ' +
      'locally. `200` means the engine-native unlink operation completed AND the required local ' +
      'credential cleanup completed — for Baileys a valid companion identity, an acknowledged ' +
      '`remove-companion-device` IQ response, and removal of the on-disk auth dir; for ' +
      'whatsapp-web.js the native `Client.logout()` promise settled. `200` is NOT an independent ' +
      'observation that the handset UI no longer shows the linked device. Because a completed ' +
      'unlink wipes the stored credentials, reconnecting after a `200` always requires a fresh QR ' +
      'scan or pairing code.',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description:
      'Unlink operation and required local cleanup completed; session is stopped and `phone` is ' +
      'cleared. Recorded in the audit log as `session_logged_out`.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/SessionResponseDto' },
        example: {
          id: '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a',
          name: 'my-bot',
          status: 'disconnected',
          phone: null,
          pushName: null,
          connectedAt: null,
          lastActive: '2026-06-25T09:01:55.000Z',
          createdAt: '2026-06-20T11:30:00.000Z',
          updatedAt: '2026-06-25T09:11:00.000Z',
          lastError: null,
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Session is not started (no engine to send through); the row is left untouched',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 502,
    description:
      'Session was stopped locally, but the logout operation is incomplete (no send, no ' +
      'acknowledgement, timeout/transport error, or local-cleanup failure). Retryable — the ' +
      "body carries `code: 'SESSION_LOGOUT_INCOMPLETE'`; `phone` is cleared and no success audit " +
      'is written. Start the session again and retry the logout.',
  })
  async logout(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.logout(id);
    await this.auditService.logInfo(AuditAction.SESSION_LOGGED_OUT, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/force-kill')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force-kill a stuck session (SIGKILL its wedged engine, then tear it down)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session force-killed',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async forceKill(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.forceKill(id);
    await this.auditService.logInfo(AuditAction.SESSION_FORCE_KILLED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Get(':id/qr')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get QR code for session authentication' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'QR code data',
    type: QRCodeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'QR code not ready or session already authenticated',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getQRCode(@Param('id', ParseUUIDPipe) id: string): Promise<QRCodeResponseDto> {
    const qrCode = await this.sessionService.getQRCode(id);
    await this.auditService.logInfo(AuditAction.SESSION_QR_GENERATED, {
      sessionId: id,
    });
    return qrCode;
  }

  @Post(':id/pairing-code')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Request an 8-char pairing code to link via phone number (alternative to QR)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Pairing code generated', type: PairingCodeResponseDto })
  @ApiResponse({ status: 400, description: 'Session not started or already authenticated' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async requestPairingCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestPairingCodeDto,
  ): Promise<PairingCodeResponseDto> {
    return this.sessionService.requestPairingCode(id, dto.phoneNumber);
  }

  @Get(':id/groups')
  @ApiOperation({ summary: 'Get all groups for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of groups the session is a member of',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max groups to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of groups to skip (for paging)' })
  async getGroups(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ id: string; name: string; linkedParentJID?: string | null }[]> {
    return this.sessionService.getGroups(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get(':id/chats')
  @ApiOperation({ summary: 'Get active chats for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of active chats (most recent first)', type: [ChatSummaryDto] })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max chats to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of chats to skip (for paging)' })
  async getChats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ChatSummary[]> {
    return this.sessionService.getChats(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Post(':id/chats/read')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a chat as read/seen' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as read successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.sendSeen(id, dto.chatId);
    return { success };
  }

  @Post(':id/presence/subscribe')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Subscribe to a chat's presence",
    description:
      'Asks WhatsApp to start reporting who is online or typing in this chat. Updates arrive as the ' +
      '`presence.update` webhook and socket event — there is no synchronous answer, because presence ' +
      'cannot be queried from either engine, only received.\n\n' +
      'The subscription belongs to the connection: it does **not** survive a restart or an automatic ' +
      'reconnect, and must be re-issued. Subscribe per chat rather than to everything — WhatsApp emits ' +
      'an update on every transition, so a broad subscription is a firehose.\n\n' +
      'whatsapp-web.js cannot do this at all (it exposes no presence subscribe and emits no presence ' +
      'event) and answers `501`.',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Subscribed; updates now arrive as presence.update events' })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 501, description: 'The active engine cannot observe presence (whatsapp-web.js)' })
  async subscribeToPresence(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubscribePresenceDto,
  ): Promise<{ success: boolean }> {
    await this.sessionService.subscribeToPresence(id, dto.chatId);
    return { success: true };
  }

  @Get(':id/presence/:chatId')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({
    summary: "Read a chat's last reported presence",
    description:
      'Serves the most recent report received since the chat was subscribed. Returns `null` when ' +
      'nothing has been reported — either the chat was never subscribed, or nothing has changed ' +
      'since. That is a normal state, not a missing resource, so it is `200` with a null body rather ' +
      'than a `404`.\n\n' +
      'Held in memory and never persisted: presence is short-lived, and answering "typing" from ' +
      'before a restart would be worse than answering nothing.',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID as subscribed' })
  @ApiResponse({ status: 200, description: 'Last reported presence, or null', type: ChatPresenceResponseDto })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getPresence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chatId') chatId: string,
  ): Promise<ChatPresenceResponseDto | null> {
    const presence = await this.sessionService.getPresence(id, chatId);
    return presence ? { ...presence, observedAt: new Date(presence.observedAt) } : null;
  }

  @Post(':id/chats/unread')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a chat as unread' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as unread successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatUnread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.markUnread(id, dto.chatId);
    return { success };
  }

  @Delete(':id/chats/:chatId/messages')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete every message in a chat, keeping the chat itself' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: "Chat JID, e.g. 1234567890-123@g.us (URL-encode the '@')" })
  @ApiResponse({
    status: 200,
    description:
      'Returns `{ success }`. `false` means the engine declined to act — an unknown chat, or on the ' +
      'Baileys engine a chat with no known history, since the change is keyed to its last message.',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async clearChatMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chatId') chatId: string,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.clearChatMessages(id, chatId);
    return { success };
  }

  @Post(':id/chats/archive')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive or unarchive a chat' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description:
      'Returns `{ success }`. `false` means the engine declined to act — on the Baileys engine a ' +
      'chat with no known history cannot be archived, since the change is keyed to its last message.',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async archiveChat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveChatDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.archiveChat(id, dto.chatId, dto.archive);
    return { success };
  }

  @Post(':id/chats/delete')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a chat from the chat list (e.g. a group you have left)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat deleted successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async deleteChat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeleteChatDto): Promise<{ success: boolean }> {
    const success = await this.sessionService.deleteChat(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/typing')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send a typing/recording presence indicator to a chat (or clear it with 'paused')" })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Presence sent' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async sendChatState(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChatStateDto,
  ): Promise<{ success: boolean }> {
    await this.sessionService.sendChatState(id, dto.chatId, dto.state);
    return { success: true };
  }

  @Get('stats/overview')
  @ApiOperation({
    summary: 'Get session statistics for multi-session monitoring',
  })
  @ApiResponse({
    status: 200,
    description: 'Session statistics including counts and memory usage',
  })
  async getStats(@CurrentApiKey() apiKey?: ApiKey): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    // Scope aggregate stats to the key's allowedSessions so a session-restricted key cannot enumerate
    // global session counts/status (the route carries no :id for the guard to scope against).
    return this.sessionService.getStats(apiKey?.allowedSessions);
  }
}
