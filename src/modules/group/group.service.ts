import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { paginate, ListOptions } from '../../common/utils/paginate';

/**
 * Owns engine access for group operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard and group-level business rules (e.g. not-found mapping) live in one place.
 */
@Injectable()
export class GroupService {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
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
}
