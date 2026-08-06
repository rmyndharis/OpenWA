import { Injectable, BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { GroupMemberAddMode, IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import { SetGroupPictureDto } from './dto/group.dto';
import { paginate, ListOptions } from '../../common/utils/paginate';
import { SendPacingService } from '../message/send-pacing.service';

/**
 * Owns engine access for group operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard and group-level business rules (e.g. not-found mapping) live in one place.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly engines: EngineRegistry,
    private readonly pacing: SendPacingService,
  ) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  getGroups(sessionId: string, opts: ListOptions = {}) {
    // getEngine throws synchronously (sync 400 guard); the engine returns the full set and we
    // bound the HTTP response window via paginate().
    return this.getEngine(sessionId)
      .getGroups()
      .then(groups => paginate(groups, opts.limit, opts.offset));
  }

  async getGroupInfo(sessionId: string, groupId: string) {
    const group = await this.getEngine(sessionId).getGroupInfo(groupId);
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }
    return group;
  }

  /**
   * Creating a group invites every listed participant in the same call, so it carries the same
   * reachout cost as adding them one by one — and is paced accordingly.
   */
  async createGroup(sessionId: string, name: string, participants: string[]) {
    await this.pacing.assertReachoutAllowed(sessionId, participants);
    return this.getEngine(sessionId).createGroup(name, participants);
  }

  /**
   * Paced: putting the account in front of people who did not ask for it, in bulk, is the most
   * ban-associated action this product performs. Each participant the account has no history with
   * draws on the same cold-reachout budget a first message does.
   */
  async addParticipants(sessionId: string, groupId: string, participants: string[]) {
    await this.pacing.assertReachoutAllowed(sessionId, participants);
    return this.getEngine(sessionId).addParticipants(groupId, participants);
  }

  removeParticipants(sessionId: string, groupId: string, participants: string[]) {
    return this.getEngine(sessionId).removeParticipants(groupId, participants);
  }

  promoteParticipants(sessionId: string, groupId: string, participants: string[]) {
    return this.getEngine(sessionId).promoteParticipants(groupId, participants);
  }

  demoteParticipants(sessionId: string, groupId: string, participants: string[]) {
    return this.getEngine(sessionId).demoteParticipants(groupId, participants);
  }

  setGroupSubject(sessionId: string, groupId: string, subject: string) {
    return this.getEngine(sessionId).setGroupSubject(groupId, subject);
  }

  setGroupDescription(sessionId: string, groupId: string, description: string) {
    return this.getEngine(sessionId).setGroupDescription(groupId, description);
  }

  leaveGroup(sessionId: string, groupId: string) {
    return this.getEngine(sessionId).leaveGroup(groupId);
  }

  getGroupInviteCode(sessionId: string, groupId: string) {
    return this.getEngine(sessionId).getGroupInviteCode(groupId);
  }

  revokeGroupInviteCode(sessionId: string, groupId: string) {
    return this.getEngine(sessionId).revokeGroupInviteCode(groupId);
  }

  /**
   * Preview a group from an invite code. The code is required rather than optional-with-a-default:
   * an empty one would reach the engine and come back as a confusing not-found instead of the
   * client error it is.
   */
  getGroupJoinInfo(sessionId: string, inviteCode: string) {
    if (!inviteCode?.trim()) {
      throw new BadRequestException('An invite code is required');
    }
    return this.getEngine(sessionId).getGroupJoinInfo(inviteCode.trim());
  }

  joinGroupViaInviteCode(sessionId: string, inviteCode: string) {
    return this.getEngine(sessionId).joinGroupViaInviteCode(inviteCode);
  }

  /** Read the group's picture URL, or null when it has none. Groups reuse the profile-picture read. */
  getGroupPicture(sessionId: string, groupId: string): Promise<string | null> {
    return this.getEngine(sessionId).getProfilePicture(groupId);
  }

  setGroupPicture(sessionId: string, groupId: string, dto: SetGroupPictureDto): Promise<void> {
    const base64 = stripBase64DataUri(dto.base64);
    if (!dto.url && !base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }
    if (base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }
    assertBase64WithinMediaCap(base64);
    const media: MediaInput = {
      mimetype: dto.mimetype || 'image/jpeg',
      // base64 wins over url when both are present, mirroring setProfilePicture.
      data: base64 || dto.url!,
    };
    return this.getEngine(sessionId).setGroupPicture(groupId, media);
  }

  deleteGroupPicture(sessionId: string, groupId: string): Promise<void> {
    return this.getEngine(sessionId).deleteGroupPicture(groupId);
  }

  /** Read the group's announce/locked/ephemeral/member-add settings; 404s (via getGroupInfo) when unknown. */
  async getGroupSettings(sessionId: string, groupId: string) {
    const group = await this.getGroupInfo(sessionId, groupId);
    return {
      announce: group.announce,
      locked: group.locked,
      ...(group.ephemeralSeconds !== undefined ? { ephemeralSeconds: group.ephemeralSeconds } : {}),
      ...(group.memberAddMode !== undefined ? { memberAddMode: group.memberAddMode } : {}),
    };
  }

  /**
   * Apply the given settings; each present field maps to one engine call, absent fields stay
   * untouched. An empty patch is a client error. EngineNotSupportedError (e.g. ephemeralSeconds on
   * the wwjs engine) propagates as 501.
   *
   * Ordering matters: ephemeralSeconds is applied FIRST because it is the only field with a
   * deterministic per-engine refusal (wwjs always 501s it). Applying announce/locked first would
   * leave a silently half-applied patch behind when the ephemeral call then throws.
   *
   * A failure on the FIRST applied field propagates unchanged (nothing was applied, so the patch
   * simply failed). A failure on a LATER field means the group is now in a mixed state, so the
   * error names the failed field and the ones already applied — the caller can reconcile instead
   * of guessing which subset took effect. The wrapped error keeps the underlying HTTP status.
   */
  async updateGroupSettings(
    sessionId: string,
    groupId: string,
    settings: { announce?: boolean; locked?: boolean; ephemeralSeconds?: number; memberAddMode?: GroupMemberAddMode },
  ) {
    const { announce, locked, ephemeralSeconds, memberAddMode } = settings;
    if (
      announce === undefined &&
      locked === undefined &&
      ephemeralSeconds === undefined &&
      memberAddMode === undefined
    ) {
      throw new BadRequestException(
        'At least one of announce, locked, ephemeralSeconds, memberAddMode must be provided',
      );
    }
    const engine = this.getEngine(sessionId);
    const steps: Array<[field: string, apply: () => Promise<unknown>]> = [];
    if (ephemeralSeconds !== undefined) {
      steps.push(['ephemeralSeconds', () => engine.setGroupEphemeral(groupId, ephemeralSeconds)]);
    }
    // After ephemeralSeconds, per the ordering rule above: this field is supported on both engines,
    // so it carries no deterministic refusal and must not displace the one field that does.
    if (memberAddMode !== undefined) {
      steps.push(['memberAddMode', () => engine.setGroupMemberAddMode(groupId, memberAddMode)]);
    }
    if (announce !== undefined) {
      steps.push(['announce', () => engine.setGroupMessagesAdminsOnly(groupId, announce)]);
    }
    if (locked !== undefined) {
      steps.push(['locked', () => engine.setGroupInfoAdminsOnly(groupId, locked)]);
    }

    const applied: string[] = [];
    for (const [field, apply] of steps) {
      try {
        await apply();
        applied.push(field);
      } catch (error) {
        if (applied.length === 0) throw error;
        const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
        const detail = error instanceof Error ? error.message : String(error);
        throw new HttpException(
          `Group settings only partially applied: '${field}' failed (${detail}); already applied: ${applied.join(
            ', ',
          )}`,
          status,
        );
      }
    }
  }
}
