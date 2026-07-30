import { Injectable, BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { paginate, ListOptions } from '../../common/utils/paginate';

/**
 * Owns engine access for group operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard and group-level business rules (e.g. not-found mapping) live in one place.
 */
@Injectable()
export class GroupService {
  constructor(private readonly engines: EngineRegistry) {}

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

  createGroup(sessionId: string, name: string, participants: string[]) {
    return this.getEngine(sessionId).createGroup(name, participants);
  }

  addParticipants(sessionId: string, groupId: string, participants: string[]) {
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

  joinGroupViaInviteCode(sessionId: string, inviteCode: string) {
    return this.getEngine(sessionId).joinGroupViaInviteCode(inviteCode);
  }

  /** Read the group's announce/locked/ephemeral settings; 404s (via getGroupInfo) when unknown. */
  async getGroupSettings(sessionId: string, groupId: string) {
    const group = await this.getGroupInfo(sessionId, groupId);
    return {
      announce: group.announce,
      locked: group.locked,
      ...(group.ephemeralSeconds !== undefined ? { ephemeralSeconds: group.ephemeralSeconds } : {}),
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
    settings: { announce?: boolean; locked?: boolean; ephemeralSeconds?: number },
  ) {
    const { announce, locked, ephemeralSeconds } = settings;
    if (announce === undefined && locked === undefined && ephemeralSeconds === undefined) {
      throw new BadRequestException('At least one of announce, locked, ephemeralSeconds must be provided');
    }
    const engine = this.getEngine(sessionId);
    const steps: Array<[field: string, apply: () => Promise<unknown>]> = [];
    if (ephemeralSeconds !== undefined) {
      steps.push(['ephemeralSeconds', () => engine.setGroupEphemeral(groupId, ephemeralSeconds)]);
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
