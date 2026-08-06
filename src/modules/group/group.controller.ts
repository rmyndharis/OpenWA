import { Controller, Get, Post, Put, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { GroupService } from './group.service';
import {
  CreateGroupDto,
  ParticipantsDto,
  GroupSubjectDto,
  GroupDescriptionDto,
  JoinGroupDto,
  GroupSettingsDto,
  SetGroupPictureDto,
} from './dto/group.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

// NOTE: the session→groups LIST lives on the SessionController at GET /sessions/:id/groups (it
// registered first and owns the canonical narrow projection). A bare @Get() here would collide on
// the same path pattern (/sessions/{x}/groups) and be shadowed, so this controller owns only the
// group sub-resource routes (:groupId/...) under the same mount.
@ApiTags('groups')
@Controller('sessions/:sessionId/groups')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  // MUST stay above @Get(':groupId'): Nest matches in declaration order, and a literal segment
  // declared after a parameter route is shadowed by it — `join-info` would arrive as a group id.
  @Get('join-info')
  @ApiOperation({
    summary: 'Preview a group from its invite code, without joining',
    description:
      'Read-only: nothing about the account changes, which is what makes it safe to call on a code ' +
      'from an untrusted source. Supported on both engines.\n\n' +
      'There is no participant LIST — the account is not a member — only a count, and only when ' +
      'WhatsApp discloses one. Fields the engine does not report are omitted rather than defaulted, ' +
      'because whatsapp-web.js returns an untyped object with no guaranteed shape.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'code', description: 'Group invite code (the part after the invite link)' })
  @ApiResponse({ status: 200, description: 'What the invite discloses about the group' })
  @ApiResponse({ status: 400, description: 'Session not started, or no code supplied' })
  @ApiResponse({ status: 404, description: 'No such invite — invalid, expired or revoked' })
  async joinInfo(@Param('sessionId') sessionId: string, @Query('code') code: string) {
    return this.groupService.getGroupJoinInfo(sessionId, code);
  }

  @Get(':groupId')
  @ApiOperation({ summary: 'Get detailed group info' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID (e.g., 120363xxx@g.us)' })
  @ApiResponse({ status: 200, description: 'Group details with participants' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    return this.groupService.getGroupInfo(sessionId, groupId);
  }

  @Post('join')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a group via invite code' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: JoinGroupDto })
  @ApiResponse({ status: 200, description: 'Joined the group' })
  @ApiResponse({ status: 400, description: 'Invalid or expired invite code, or session is not started' })
  async join(@Param('sessionId') sessionId: string, @Body() dto: JoinGroupDto) {
    const groupId = await this.groupService.joinGroupViaInviteCode(sessionId, dto.inviteCode);
    return { success: true, groupId };
  }

  @Get(':groupId/settings')
  @ApiOperation({ summary: 'Get group settings (announce / locked / ephemeral timer)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Group settings' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  async getSettings(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    return this.groupService.getGroupSettings(sessionId, groupId);
  }

  @Put(':groupId/settings')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update group settings (announce / locked / ephemeral timer)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: GroupSettingsDto })
  @ApiResponse({ status: 200, description: 'Group settings updated' })
  @ApiResponse({ status: 400, description: 'No setting provided, or a value is not a boolean' })
  @ApiResponse({ status: 403, description: 'The engine refused the change (the account is not a group admin)' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  @ApiResponse({ status: 501, description: 'The active engine does not support a requested setting' })
  async updateSettings(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupSettingsDto,
  ) {
    await this.groupService.updateGroupSettings(sessionId, groupId, dto);
    return { success: true, message: 'Group settings updated' };
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: CreateGroupDto })
  @ApiResponse({ status: 201, description: 'Group created' })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateGroupDto) {
    return this.groupService.createGroup(sessionId, dto.name, dto.participants);
  }

  @Post(':groupId/participants')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Add participants to a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({
    status: 200,
    description:
      'Participants processed — `results` carries the per-participant outcome (a partial refusal does not fail the batch; a total refusal is an error)',
  })
  @HttpCode(HttpStatus.OK)
  async addParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const results = await this.groupService.addParticipants(sessionId, groupId, dto.participants);
    return { success: true, message: 'Participants added', results };
  }

  @Delete(':groupId/participants')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Remove participants from a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({
    status: 200,
    description:
      'Participants processed — `results` carries the per-participant outcome (a partial refusal does not fail the batch; a total refusal is an error)',
  })
  async removeParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const results = await this.groupService.removeParticipants(sessionId, groupId, dto.participants);
    return { success: true, message: 'Participants removed', results };
  }

  @Post(':groupId/participants/promote')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Promote participants to admin' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({
    status: 200,
    description:
      'Participants processed — `results` carries the per-participant outcome (a partial refusal does not fail the batch; a total refusal is an error)',
  })
  @HttpCode(HttpStatus.OK)
  async promoteParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const results = await this.groupService.promoteParticipants(sessionId, groupId, dto.participants);
    return { success: true, message: 'Participants promoted to admin', results };
  }

  @Post(':groupId/participants/demote')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Demote participants from admin' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: ParticipantsDto })
  @ApiResponse({
    status: 200,
    description:
      'Participants processed — `results` carries the per-participant outcome (a partial refusal does not fail the batch; a total refusal is an error)',
  })
  @HttpCode(HttpStatus.OK)
  async demoteParticipants(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: ParticipantsDto,
  ) {
    const results = await this.groupService.demoteParticipants(sessionId, groupId, dto.participants);
    return { success: true, message: 'Participants demoted from admin', results };
  }

  @Put(':groupId/subject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Change group name/subject' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: GroupSubjectDto })
  @ApiResponse({ status: 200, description: 'Subject updated' })
  @ApiResponse({ status: 403, description: 'The engine refused the change — admin rights are required' })
  async setSubject(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupSubjectDto,
  ) {
    await this.groupService.setGroupSubject(sessionId, groupId, dto.subject);
    return { success: true, message: 'Group subject updated' };
  }

  @Put(':groupId/description')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Change group description' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiBody({ type: GroupDescriptionDto })
  @ApiResponse({ status: 200, description: 'Description updated' })
  @ApiResponse({ status: 403, description: 'The engine refused the change — admin rights are required' })
  async setDescription(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupDescriptionDto,
  ) {
    await this.groupService.setGroupDescription(sessionId, groupId, dto.description);
    return { success: true, message: 'Group description updated' };
  }

  @Post(':groupId/leave')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Leave a group' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Left the group' })
  @HttpCode(HttpStatus.OK)
  async leave(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    await this.groupService.leaveGroup(sessionId, groupId);
    return { success: true, message: 'Left the group' };
  }

  // ========== Gap Quick Wins: Invite Link ==========

  @Get(':groupId/picture')
  @ApiOperation({ summary: "Get the group's picture URL" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Picture URL, or null when the group has none' })
  async getPicture(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    return { url: await this.groupService.getGroupPicture(sessionId, groupId) };
  }

  @Put(':groupId/picture')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set the group's picture" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Group picture updated' })
  @ApiResponse({ status: 400, description: 'Session not active, or neither url nor base64 supplied' })
  @ApiResponse({ status: 403, description: 'The engine refused the change — admin rights required' })
  async setPicture(
    @Param('sessionId') sessionId: string,
    @Param('groupId') groupId: string,
    @Body() dto: SetGroupPictureDto,
  ) {
    await this.groupService.setGroupPicture(sessionId, groupId, dto);
    return { success: true, message: 'Group picture updated' };
  }

  @Delete(':groupId/picture')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove the group's picture" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Group picture removed' })
  @ApiResponse({ status: 403, description: 'The engine refused the change — admin rights required' })
  async deletePicture(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    await this.groupService.deleteGroupPicture(sessionId, groupId);
    return { success: true, message: 'Group picture removed' };
  }

  @Get(':groupId/invite-code')
  @ApiOperation({ summary: 'Get group invite code/link' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'Group invite code' })
  async getInviteCode(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const inviteCode = await this.groupService.getGroupInviteCode(sessionId, groupId);
    return {
      inviteCode,
      inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
    };
  }

  @Post(':groupId/invite-code/revoke')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke group invite code and generate new one' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'groupId', description: 'Group ID' })
  @ApiResponse({ status: 200, description: 'New invite code generated' })
  async revokeInviteCode(@Param('sessionId') sessionId: string, @Param('groupId') groupId: string) {
    const newCode = await this.groupService.revokeGroupInviteCode(sessionId, groupId);
    return {
      inviteCode: newCode,
      inviteLink: `https://chat.whatsapp.com/${newCode}`,
      message: 'Invite code revoked and new one generated',
    };
  }
}
