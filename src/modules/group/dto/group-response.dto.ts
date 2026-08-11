import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the group routes. These describe what the handlers already return — the
 * payload is the raw handler value, not an envelope — so that a change to the shape shows up as a
 * diff in the committed OpenAPI snapshot instead of reaching clients unannounced.
 *
 * Decorated properties deliberately avoid named utility types (`Record<…>` and friends):
 * emitDecoratorMetadata wraps a named type in a runtime `typeof X !== "undefined" && X` guard whose
 * other arm can never execute, which shows up as an uncoverable branch.
 */
export class GroupParticipantDto {
  @ApiProperty({ description: "Participant id in the engine's native format.", example: '628123456789@c.us' })
  id!: string;

  @ApiProperty({ description: 'MSISDN digits, without a leading + or separators.', example: '628123456789' })
  number!: string;

  @ApiPropertyOptional({ description: 'Display name, when the engine reports one.', example: 'Ada Lovelace' })
  name?: string;

  @ApiProperty({ description: 'Whether the participant is a group admin.', example: false })
  isAdmin!: boolean;

  @ApiProperty({ description: 'Whether the participant created the group.', example: false })
  isSuperAdmin!: boolean;
}

export class GroupSummaryDto {
  @ApiProperty({ description: 'Group id.', example: '120363000000000000@g.us' })
  id!: string;

  @ApiProperty({ description: 'Group subject.', example: 'Engineering' })
  name!: string;

  @ApiPropertyOptional({ description: 'Member count, when the engine reports it.', example: 42 })
  participantsCount?: number;

  @ApiPropertyOptional({ description: 'Whether this account is an admin of the group.', example: true })
  isAdmin?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'JID of the parent community, or null when the group is standalone.',
    example: null,
  })
  linkedParentJID?: string | null;
}

/**
 * Deliberately NOT extending GroupSummaryDto. The summary carries participantsCount and isAdmin,
 * which the group LIST computes and this route does not send at all — advertising them here would
 * offer a client an admin flag that is always undefined.
 */
export class GroupInfoDto {
  @ApiProperty({ description: 'Group id.', example: '120363000000000000@g.us' })
  id!: string;

  @ApiProperty({ description: 'Group subject.', example: 'Engineering' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'JID of the parent community, or null when the group is standalone.',
    example: null,
  })
  linkedParentJID?: string | null;

  @ApiPropertyOptional({ description: 'Group description.', example: 'Release coordination' })
  description?: string;

  @ApiPropertyOptional({ description: "Owner id in the engine's native format.", example: '628123456789@c.us' })
  owner?: string;

  @ApiPropertyOptional({ description: 'Unix SECONDS the group was created.', example: 1786000000 })
  createdAt?: number;

  @ApiProperty({ type: [GroupParticipantDto], description: 'Members of the group.' })
  participants!: GroupParticipantDto[];

  @ApiPropertyOptional({ description: 'Whether this account can no longer post (left or removed).', example: false })
  isReadOnly?: boolean;

  @ApiPropertyOptional({ description: 'Engine-reported announce flag.', example: false })
  isAnnounce?: boolean;

  @ApiPropertyOptional({ description: 'Only admins may send messages.', example: false })
  announce?: boolean;

  @ApiPropertyOptional({ description: 'Only admins may edit subject, description and picture.', example: false })
  locked?: boolean;

  @ApiPropertyOptional({ description: 'Disappearing-messages timer in seconds; 0 or absent means off.', example: 0 })
  ephemeralSeconds?: number;

  @ApiPropertyOptional({
    enum: ['all', 'admins'],
    description: 'Who may add participants. Absent when the engine did not report it.',
    example: 'admins',
  })
  memberAddMode?: string;
}

/**
 * What an invite code discloses BEFORE joining. Deliberately not GroupInfoDto: a non-member has no
 * participant list, so WhatsApp discloses at most a count — an empty array would read as "this
 * group has no members", a different and wrong claim.
 */
export class GroupJoinInfoDto {
  @ApiProperty({ description: 'Group id.', example: '120363000000000000@g.us' })
  id!: string;

  @ApiProperty({ description: 'Group subject.', example: 'Engineering' })
  name!: string;

  @ApiPropertyOptional({ description: 'Group description.', example: 'Release coordination' })
  description?: string;

  @ApiPropertyOptional({ description: "Owner id in the engine's native format.", example: '628123456789@c.us' })
  owner?: string;

  @ApiPropertyOptional({ description: 'Unix SECONDS the group was created.', example: 1786000000 })
  createdAt?: number;

  @ApiPropertyOptional({ description: 'Member count, when disclosed.', example: 42 })
  participantCount?: number;
}

export class GroupSettingsResponseDto {
  @ApiPropertyOptional({ description: 'Only admins may send messages.', example: false })
  announce?: boolean;

  @ApiPropertyOptional({ description: 'Only admins may edit subject, description and picture.', example: false })
  locked?: boolean;

  @ApiPropertyOptional({
    description: 'Disappearing-messages timer in seconds. Absent when the engine did not report it.',
    example: 0,
  })
  ephemeralSeconds?: number;

  @ApiPropertyOptional({
    enum: ['all', 'admins'],
    description: 'Who may add participants. Absent when the engine did not report it.',
    example: 'admins',
  })
  memberAddMode?: string;
}

export class GroupAckResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status, not as false.', example: true })
  success!: boolean;

  @ApiProperty({ description: 'Human-readable confirmation of what was done.', example: 'Group subject updated' })
  message!: string;
}

/**
 * Per-participant outcome of a membership write. Engines that report per-participant results map
 * them verbatim; engines that only confirm the batch report one success entry per requested id — so
 * a `success: true` here does not always mean the engine spoke about THAT participant individually.
 */
export class ParticipantOperationResultDto {
  @ApiProperty({ description: 'Neutral participant id the outcome belongs to.', example: '628123456789@c.us' })
  id!: string;

  @ApiProperty({ description: 'True only when the engine confirmed the change for this participant.', example: true })
  success!: boolean;

  @ApiPropertyOptional({ description: "The engine's own status code, when it gave one.", example: 200 })
  status?: number;

  @ApiPropertyOptional({ description: 'Engine-reported reason, when it gave one.', example: 'ok' })
  message?: string;
}

export class ParticipantsOperationResponseDto extends GroupAckResponseDto {
  @ApiProperty({ type: [ParticipantOperationResultDto], description: 'One entry per requested participant.' })
  results!: ParticipantOperationResultDto[];
}

export class GroupMembershipRequestDto {
  @ApiProperty({ description: 'Neutral id of the user asking to join.', example: '628123456789@c.us' })
  participantId!: string;

  @ApiPropertyOptional({
    description: 'Who created the request, when the engine reports it (differs from the requester on a non-admin add).',
    example: '628987654321@c.us',
  })
  addedById?: string;

  @ApiPropertyOptional({
    description: 'How the request was made, when the engine reports it.',
    enum: ['invite_link', 'non_admin_add', 'linked_group_join'],
    example: 'invite_link',
  })
  method?: string;

  @ApiPropertyOptional({
    description: 'Unix seconds the request was created, when the engine reports it.',
    example: 1754700000,
  })
  requestedAt?: number;
}

export class GroupJoinedResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status.', example: true })
  success!: boolean;

  @ApiProperty({ description: 'Id of the group that was joined.', example: '120363000000000000@g.us' })
  groupId!: string;
}

export class GroupPictureResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Group picture URL, or null when the group has none.',
    example: 'https://pps.whatsapp.net/v/t61.24694-24/12345_678_910_n.jpg',
  })
  url!: string | null;
}

export class GroupInviteCodeResponseDto {
  @ApiProperty({ description: 'The invite code on its own.', example: 'GTvX9c8H8l718ewOH22Zk5' })
  inviteCode!: string;

  @ApiProperty({
    description: 'The same code as a joinable link.',
    example: 'https://chat.whatsapp.com/GTvX9c8H8l718ewOH22Zk5',
  })
  inviteLink!: string;
}

export class GroupInviteCodeRevokedResponseDto extends GroupInviteCodeResponseDto {
  @ApiProperty({
    description: 'Confirmation that the previous code was revoked.',
    example: 'Invite code revoked and new one generated',
  })
  message!: string;
}
