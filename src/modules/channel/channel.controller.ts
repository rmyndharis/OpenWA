import { Controller, Get, Post, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { ChannelAckResponseDto, ChannelDto, ChannelMessageDto } from './dto/channel-response.dto';
import { ChannelService } from './channel.service';
import { SubscribeChannelDto } from './dto/subscribe-channel.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { MuteChannelDto } from './dto/mute-channel.dto';
import { DemoteChannelAdminDto } from './dto/demote-channel-admin.dto';
import { TransferChannelOwnershipDto } from './dto/transfer-channel-ownership.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  CHANNEL_INVITE_NOT_FOUND_404,
  CHANNEL_NOT_FOUND_404,
  ENGINE_NOT_READY_409,
  ENGINE_REFUSED_403,
} from '../../common/openapi/engine-status-responses';

@ApiTags('channels')
@Controller('sessions/:sessionId/channels')
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  @Get()
  @ApiOperation({ summary: 'Get all subscribed channels/newsletters' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of subscribed channels', type: [ChannelDto] })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: the Baileys adapter cannot list subscribed channels.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async findAll(@Param('sessionId') sessionId: string) {
    return this.channelService.getSubscribedChannels(sessionId);
  }

  @Get(':channelId')
  @ApiOperation({ summary: 'Get a specific channel by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiResponse({ status: 200, description: 'Channel details', type: ChannelDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({ status: 404, description: 'Channel not found' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async findOne(@Param('sessionId') sessionId: string, @Param('channelId') channelId: string) {
    return this.channelService.getChannelById(sessionId, channelId);
  }

  @Get(':channelId/messages')
  @ApiOperation({ summary: 'Get messages from a channel' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max messages to return (default 50, max 100)',
  })
  @ApiResponse({ status: 200, description: 'List of channel messages', type: [ChannelMessageDto] })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: the Baileys adapter cannot read channel messages.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: CHANNEL_NOT_FOUND_404 })
  async getMessages(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
    @Query('limit') limit?: string,
  ) {
    // A non-empty non-numeric ?limit (e.g. `?limit=abc`) is truthy, so a bare `parseInt` would forward
    // NaN to the engine (wwjs then returns an unpredictable/empty set). Fall back to the engine default.
    const parsed = limit !== undefined ? parseInt(limit, 10) : NaN;
    return this.channelService.getChannelMessages(sessionId, channelId, Number.isNaN(parsed) ? undefined : parsed);
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a channel',
    description:
      'The account becomes the channel owner, which is what makes deleting it possible later — ' +
      'neither engine can delete a channel it does not own.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: CreateChannelDto })
  @ApiResponse({ status: 201, description: 'The created channel', type: ChannelDto })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 403, description: 'The engine refused — channel creation may be disabled for this account' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateChannelDto) {
    return this.channelService.createChannel(sessionId, dto.name, dto.description);
  }

  @Post(':channelId/delete')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a channel this account owns',
    description:
      'Irreversible, and every subscriber loses the channel. Deliberately NOT `DELETE ' +
      '/channels/:channelId` — that route unsubscribes, and the two must not be reachable by the ' +
      'same request with a slip of the wrist. Only the owner can delete.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiResponse({ status: 200, description: 'Channel deleted', type: ChannelAckResponseDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 403, description: 'The engine refused — not found, or this account does not own it' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async remove(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
  ): Promise<{ success: boolean }> {
    await this.channelService.deleteChannel(sessionId, channelId);
    return { success: true };
  }

  @Post(':channelId/mute')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mute or unmute a channel',
    description: "Silences the channel's notifications for this account. The subscription is untouched.",
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiBody({ type: MuteChannelDto })
  @ApiResponse({ status: 200, description: 'Channel muted or unmuted', type: ChannelAckResponseDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 403, description: 'The engine refused' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: CHANNEL_NOT_FOUND_404 })
  async mute(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
    @Body() dto: MuteChannelDto,
  ): Promise<{ success: boolean }> {
    await this.channelService.muteChannel(sessionId, channelId, dto.mute);
    return { success: true };
  }

  @Post(':channelId/admins/demote')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Demote a channel admin back to a subscriber',
    description:
      'Requires this account to own the channel. There is no promote counterpart: neither engine ' +
      'library exposes one, so an admin is promoted from the WhatsApp app and demoted here.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiBody({ type: DemoteChannelAdminDto })
  @ApiResponse({ status: 200, description: 'Admin demoted', type: ChannelAckResponseDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 403, description: 'The engine refused — not the owner, or the user is not an admin' })
  @ApiResponse({
    status: 501,
    description:
      'The whatsapp-web.js engine cannot perform this: the WhatsApp Web module its library method ' +
      'targets no longer exports the function. Use the Baileys engine.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async demoteAdmin(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
    @Body() dto: DemoteChannelAdminDto,
  ): Promise<{ success: boolean }> {
    await this.channelService.demoteChannelAdmin(sessionId, channelId, dto.userId);
    return { success: true };
  }

  @Post(':channelId/owner/transfer')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer channel ownership to another account',
    description:
      'IRREVERSIBLE. Once the transfer lands, this session is no longer the owner and cannot take ' +
      'the channel back through this API. Requires this account to currently own the channel. The ' +
      'upstream option to also dismiss yourself as an admin in the same call is not exposed, ' +
      'because the WhatsApp Web function it depends on no longer exists and the branch swallows ' +
      'its own errors, so it would fail silently.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiBody({ type: TransferChannelOwnershipDto })
  @ApiResponse({ status: 200, description: 'Ownership transferred', type: ChannelAckResponseDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the transfer may or may not have applied.',
  })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({
    status: 403,
    description:
      'The engine did not transfer the channel. On whatsapp-web.js this is the only outcome a ' +
      'failure can produce: the page swallows every error into a plain false, so the cause is not ' +
      'reported.',
  })
  @ApiResponse({
    status: 501,
    description:
      'The whatsapp-web.js engine cannot perform this: its page function rejects every call locally ' +
      'against a subscriber list the page cannot repopulate. Use the Baileys engine.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async transferOwnership(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
    @Body() dto: TransferChannelOwnershipDto,
  ): Promise<{ success: boolean }> {
    await this.channelService.transferChannelOwnership(sessionId, channelId, dto.newOwnerId);
    return { success: true };
  }

  @Post('subscribe')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Subscribe to a channel using invite code' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        inviteCode: {
          type: 'string',
          description: 'Channel invite code (from channel link)',
          example: 'ABC123xyz',
        },
      },
      required: ['inviteCode'],
    },
  })
  @ApiResponse({ status: 201, description: 'Successfully subscribed to channel', type: ChannelDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js cannot subscribe by invite code.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: CHANNEL_INVITE_NOT_FOUND_404 })
  async subscribe(@Param('sessionId') sessionId: string, @Body() body: SubscribeChannelDto) {
    return this.channelService.subscribeToChannel(sessionId, body.inviteCode);
  }

  @Delete(':channelId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Unsubscribe from a channel' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID to unsubscribe from' })
  @ApiResponse({ status: 200, description: 'Successfully unsubscribed from channel', type: ChannelAckResponseDto })
  @ApiResponse({
    status: 503,
    description: 'WhatsApp did not answer within the request budget — the operation may or may not have applied.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 403, description: ENGINE_REFUSED_403 })
  async unsubscribe(@Param('sessionId') sessionId: string, @Param('channelId') channelId: string) {
    await this.channelService.unsubscribeFromChannel(sessionId, channelId);
    return { success: true };
  }
}
