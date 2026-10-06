import { Injectable, BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { GroupMemberAddMode, IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import { chatKind } from '../../engine/identity/wa-id';
import { isAddressableParticipant } from '../../engine/identity/wa-id';
import { SetGroupPictureDto } from './dto/group.dto';
import { paginate, ListOptions } from '../../common/utils/paginate';
import { SendPacingService } from '../message/send-pacing.service';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';

/**
 * Whether a failed paced write provably contacted nobody, so its reserved budget can go back: a
 * client or refusal status (400 bad input, 403 refused, 404 no such group, 409 not ready), a 501
 * for an operation the engine lacks, or a 503 WhatsApp rate limit (EngineThrottledError), which
 * WhatsApp turned away before it ran. Anything else (a 503 deadline that abandoned an IQ still in
 * flight, a dropped socket, a dead page) leaves the outcome unknown, and WhatsApp may already have
 * added the participants, so the batch stays charged.
 */
function contactedNobody(error: unknown): boolean {
  return (
    error instanceof HttpException &&
    (error.getStatus() < 500 || error instanceof EngineNotSupportedError || error instanceof EngineThrottledError)
  );
}

/**
 * Owns engine access for group operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard and group-level business rules (e.g. not-found mapping) live in one place.
 */
@Injectable()
export class GroupService {
  private readonly logger = createLogger('GroupService');

  constructor(
    private readonly engines: EngineRegistry,
    private readonly pacing: SendPacingService,
  ) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  /**
   * Reject participant ids WhatsApp cannot act on, before they reach an engine.
   *
   * This lives in the service rather than in ParticipantsDto because the MCP agent tools
   * (src/core/agent-tools/tools/group.tools.ts) call createGroup and addParticipants directly with a
   * plain `z.array(z.string())`, so a DTO-only check would leave that path unguarded. Mirrors
   * ContactService.assertAddressable.
   *
   * Runs before pacing on the two paced writes: a batch that can never reach WhatsApp must not draw
   * on the cold-reachout budget on its way to a 400.
   */
  private assertAddressableParticipants(participants: string[]): void {
    const invalid = participants.filter(p => !isAddressableParticipant(p));
    if (invalid.length) {
      throw new BadRequestException(
        `Not an individual participant id: ${invalid.join(', ')} — pass a phone number, <phone>@c.us or <lid>@lid`,
      );
    }
  }

  /** Every group before a caller applies authorization and pagination. */
  listGroups(sessionId: string) {
    return this.getEngine(sessionId).getGroups();
  }

  getGroups(sessionId: string, opts: ListOptions = {}) {
    // getEngine throws synchronously (sync 400 guard); the engine returns the full set and we
    // bound the HTTP response window via paginate().
    return this.listGroups(sessionId).then(groups => paginate(groups, opts.limit, opts.offset));
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
    this.assertAddressableParticipants(participants);
    const reservation = await this.pacing.assertReachoutAllowed(sessionId, participants);
    try {
      return await this.getEngine(sessionId).createGroup(name, participants);
    } catch (error) {
      // A refusal invited nobody, so the reserved budget goes back (whatsapp-web.js always 501s here).
      // An outcome-unknown failure stays charged.
      if (contactedNobody(error)) this.pacing.refundGroupReachouts(sessionId, reservation);
      throw error;
    }
  }

  /**
   * Paced: putting the account in front of people who did not ask for it, in bulk, is the most
   * ban-associated action this product performs. Each participant the account has no history with
   * draws on the same cold-reachout budget a first message does.
   */
  async addParticipants(sessionId: string, groupId: string, participants: string[]) {
    this.assertAddressableParticipants(participants);
    const reservation = await this.pacing.assertReachoutAllowed(sessionId, participants);
    try {
      return await this.getEngine(sessionId).addParticipants(groupId, participants);
    } catch (error) {
      // A refused add contacted nobody. Per-participant failures an engine reports without throwing
      // stay charged: the batch was attempted. So does an outcome-unknown failure.
      if (contactedNobody(error)) this.pacing.refundGroupReachouts(sessionId, reservation);
      throw error;
    }
  }

  removeParticipants(sessionId: string, groupId: string, participants: string[]) {
    this.assertAddressableParticipants(participants);
    return this.getEngine(sessionId).removeParticipants(groupId, participants);
  }

  promoteParticipants(sessionId: string, groupId: string, participants: string[]) {
    this.assertAddressableParticipants(participants);
    return this.getEngine(sessionId).promoteParticipants(groupId, participants);
  }

  demoteParticipants(sessionId: string, groupId: string, participants: string[]) {
    this.assertAddressableParticipants(participants);
    return this.getEngine(sessionId).demoteParticipants(groupId, participants);
  }

  getGroupMembershipRequests(sessionId: string, groupId: string) {
    return this.getEngine(sessionId).getGroupMembershipRequests(groupId);
  }

  /**
   * Deliberately NOT paced, unlike addParticipants: the people here asked for the contact
   * themselves, so approving (or rejecting) them draws nothing from the cold-reachout budget.
   * `participants` omitted means every pending request — so the shape guard is conditional, not
   * skipped: these routes take the same participant ids as the writes above, and whatsapp-web.js
   * feeds a named requester straight to `requesterIds.map(createWid)`.
   */
  approveGroupMembershipRequests(sessionId: string, groupId: string, participants?: string[]) {
    if (participants) this.assertAddressableParticipants(participants);
    return this.getEngine(sessionId).approveGroupMembershipRequests(groupId, participants);
  }

  rejectGroupMembershipRequests(sessionId: string, groupId: string, participants?: string[]) {
    if (participants) this.assertAddressableParticipants(participants);
    return this.getEngine(sessionId).rejectGroupMembershipRequests(groupId, participants);
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
    const code = this.requireInviteCode(inviteCode);
    return this.getEngine(sessionId).getGroupJoinInfo(code);
  }

  /** Same rule as the preview, so a code that previews also joins. */
  joinGroupViaInviteCode(sessionId: string, inviteCode: string) {
    const code = this.requireInviteCode(inviteCode);
    return this.getEngine(sessionId).joinGroupViaInviteCode(code);
  }

  private requireInviteCode(inviteCode: string): string {
    const code = inviteCode?.trim();
    if (!code) {
      throw new BadRequestException('An invite code is required');
    }
    return code;
  }

  /**
   * Refuse an id that does not name a group before it reaches an engine.
   *
   * These three routes reuse the ACCOUNT's profile-picture primitives, and Baileys omits the `target`
   * attribute whenever the jid it is handed is the account's own — so a 1:1 id passed where a group id
   * belongs replaced or permanently deleted the account's own avatar and answered 200, while
   * whatsapp-web.js refused the same input through requireGroupChat. Guarded here rather than in either
   * adapter so both engines agree, and so no engine ever sees the wrong kind of id.
   */
  private assertGroupId(groupId: string): void {
    if (chatKind(groupId) !== 'group') {
      throw new BadRequestException(`${groupId} is not a group id`);
    }
  }

  /** Read the group's picture URL, or null when it has none. Groups reuse the profile-picture read. */
  getGroupPicture(sessionId: string, groupId: string): Promise<string | null> {
    this.assertGroupId(groupId);
    return this.getEngine(sessionId).getProfilePicture(groupId);
  }

  setGroupPicture(sessionId: string, groupId: string, dto: SetGroupPictureDto): Promise<void> {
    this.assertGroupId(groupId);
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
    this.assertGroupId(groupId);
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
   * of guessing which subset took effect. The wrapped error keeps the underlying HTTP status, and
   * carries the underlying message only for an HTTP error; any other failure is logged here and
   * reported as an internal error.
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
        let detail = 'internal error';
        if (error instanceof HttpException) {
          detail = error.message;
        } else {
          this.logger.error(
            'Group settings step failed after a partial apply',
            error instanceof Error ? error.stack : String(error),
            { sessionId, groupId, field, applied: applied.join(',') },
          );
        }
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
