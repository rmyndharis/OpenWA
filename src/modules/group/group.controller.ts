import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { SessionService } from '../session/session.service';
import { CreateGroupDto, ParticipantsDto, GroupSubjectDto, GroupDescriptionDto } from './dto/group.dto';

@ApiTags('groups')
@Controller('sessions/:sessionId/groups')
export class GroupController {
  constructor(private readonly sessionService: SessionService) {}

  @Get()
  @ApiOperation({ summary: 'Get all groups for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of groups' })
  async findAll(@Param('sessionId') sessionId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getGroups();
  }

  @Get(':groupId')
  @ApiOperation({ summary: 'Get detailed group info' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID (e.g., 120363xxx@g.us)' })
  @ApiResponse({ status: 200, description: 'Group details with participants' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const engine = this.getEngine(sessionId);
    const group = await engine.getGroupInfo(groupId);
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }
    return group;
  }

  @Post()
  @ApiOperation({ summary: 'Create a new group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: CreateGroupDto })
  @ApiResponse({ status: 201, description: 'Group created' })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateGroupDto) {
    const engine = this.getEngine(sessionId);
    return engine.createGroup(dto.name, dto.participants);
  }

  @Post(':groupId/participants')
  @ApiOperation({ summary: 'Add participants to a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({ status: 200, description: 'Participants added' })
  @HttpCode(HttpStatus.OK)
  async addParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.addParticipants(groupId, dto.participants);
    return { success: true, message: 'Participants added' };
  }

  @Delete(':groupId/participants')
  @ApiOperation({ summary: 'Remove participants from a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({ status: 200, description: 'Participants removed' })
  async removeParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.removeParticipants(groupId, dto.participants);
    return { success: true, message: 'Participants removed' };
  }

  @Post(':groupId/participants/promote')
  @ApiOperation({ summary: 'Promote participants to admin' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({ status: 200, description: 'Participants promoted' })
  @HttpCode(HttpStatus.OK)
  async promoteParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.promoteParticipants(groupId, dto.participants);
    return { success: true, message: 'Participants promoted to admin' };
  }

  @Post(':groupId/participants/demote')
  @ApiOperation({ summary: 'Demote participants from admin' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({ status: 200, description: 'Participants demoted' })
  @HttpCode(HttpStatus.OK)
  async demoteParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.demoteParticipants(groupId, dto.participants);
    return { success: true, message: 'Participants demoted from admin' };
  }

  @Put(':groupId/subject')
  @ApiOperation({ summary: 'Change group name/subject' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: GroupSubjectDto })
  @ApiResponse({ status: 200, description: 'Subject updated' })
  async setSubject(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupSubjectDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.setGroupSubject(groupId, dto.subject);
    return { success: true, message: 'Group subject updated' };
  }

  @Put(':groupId/description')
  @ApiOperation({ summary: 'Change group description' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: GroupDescriptionDto })
  @ApiResponse({ status: 200, description: 'Description updated' })
  async setDescription(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupDescriptionDto,
  ) {
    const engine = this.getEngine(sessionId);
    await engine.setGroupDescription(groupId, dto.description);
    return { success: true, message: 'Group description updated' };
  }

  @Post(':groupId/leave')
  @ApiOperation({ summary: 'Leave a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Left the group' })
  @HttpCode(HttpStatus.OK)
  async leave(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const engine = this.getEngine(sessionId);
    await engine.leaveGroup(groupId);
    return { success: true, message: 'Left the group' };
  }

  // ========== Gap Quick Wins: Invite Link ==========

  @Get(':groupId/invite-code')
  @ApiOperation({ summary: 'Get group invite code/link' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Group invite code' })
  async getInviteCode(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const engine = this.getEngine(sessionId);
    const inviteCode = await engine.getGroupInviteCode(groupId);
    return {
      inviteCode,
      inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
    };
  }

  @Post(':groupId/invite-code/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke group invite code and generate new one' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'New invite code generated' })
  async revokeInviteCode(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const engine = this.getEngine(sessionId);
    const newCode = await engine.revokeGroupInviteCode(groupId);
    return {
      inviteCode: newCode,
      inviteLink: `https://chat.whatsapp.com/${newCode}`,
      message: 'Invite code revoked and new one generated',
    };
  }

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }
}
