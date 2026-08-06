import { Controller, Get, Post, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { ChannelService } from './channel.service';
import { SubscribeChannelDto } from './dto/subscribe-channel.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { MuteChannelDto } from './dto/mute-channel.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('channels')
@Controller('sessions/:sessionId/channels')
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  @Get()
  @ApiOperation({ summary: 'Get all subscribed channels/newsletters' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of subscribed channels',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  async findAll(@Param('sessionId') sessionId: string) {
    return this.channelService.getSubscribedChannels(sessionId);
  }

  @Get(':channelId')
  @ApiOperation({ summary: 'Get a specific channel by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID' })
  @ApiResponse({
    status: 200,
    description: 'Channel details',
  })
  @ApiResponse({ status: 404, description: 'Channel not found' })
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
  @ApiResponse({
    status: 200,
    description: 'List of channel messages',
  })
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
  @ApiResponse({ status: 201, description: 'The created channel' })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 403, description: 'The engine refused — channel creation may be disabled for this account' })
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
  @ApiResponse({ status: 200, description: 'Channel deleted' })
  @ApiResponse({ status: 400, description: 'Session not started' })
  @ApiResponse({ status: 403, description: 'The engine refused — not found, or this account does not own it' })
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
  @ApiResponse({ status: 200, description: 'Channel muted or unmuted' })
  @ApiResponse({ status: 400, description: 'Session not started, or validation failed' })
  @ApiResponse({ status: 403, description: 'The engine refused' })
  async mute(
    @Param('sessionId') sessionId: string,
    @Param('channelId') channelId: string,
    @Body() dto: MuteChannelDto,
  ): Promise<{ success: boolean }> {
    await this.channelService.muteChannel(sessionId, channelId, dto.mute);
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
  @ApiResponse({
    status: 201,
    description: 'Successfully subscribed to channel',
  })
  async subscribe(@Param('sessionId') sessionId: string, @Body() body: SubscribeChannelDto) {
    return this.channelService.subscribeToChannel(sessionId, body.inviteCode);
  }

  @Delete(':channelId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Unsubscribe from a channel' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'channelId', description: 'Channel ID to unsubscribe from' })
  @ApiResponse({
    status: 200,
    description: 'Successfully unsubscribed from channel',
  })
  async unsubscribe(@Param('sessionId') sessionId: string, @Param('channelId') channelId: string) {
    await this.channelService.unsubscribeFromChannel(sessionId, channelId);
    return { success: true };
  }
}
