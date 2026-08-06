import type { WASocket } from '@whiskeysockets/baileys';
import {
  Group,
  GroupInfo,
  GroupJoinInfo,
  GroupMemberAddMode,
  MediaInput,
  ParticipantOperationResult,
} from '../interfaces/whatsapp-engine.interface';
import { mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { resolveMediaBuffer } from './baileys-messaging';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { type createLogger } from '../../common/services/logger.service';

/**
 * Group-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysGroupsHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  readonly logger: ReturnType<typeof createLogger>;
  toNeutralJid(jid: string): string;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
}

/**
 * WA error code of a SERVER-refused Baileys query, or undefined for a transport/local failure.
 * Baileys carries a refusal two ways: `assertNodeErrorFree` puts the numeric WA code on Boom's
 * `data` (WABinary/generic-utils.js:57), and `extractGroupMetadata` puts it on `output.statusCode`
 * with the error node as `data` (Socket/groups.js:280). Transport deaths ('Connection Closed',
 * 'Timed Out') are LOCAL Booms with DisconnectReason statusCodes (408/428) and no server error
 * node — so a numeric `data` (or an object `data` alongside a statusCode) is the discriminator.
 */
export function refusedStatusCode(error: unknown): number | undefined {
  const err = error as { data?: unknown; output?: { statusCode?: unknown } } | null | undefined;
  if (typeof err?.data === 'number') {
    return err.data;
  }
  if (err?.data !== undefined && typeof err.output?.statusCode === 'number') {
    return err.output.statusCode;
  }
  return undefined;
}

/**
 * Run a socket write and map a SERVER refusal (a 4xx-class WA code: admin rights missing, not
 * permitted, not acceptable) to EngineRefusedError — HTTP 403, the same status the whatsapp-web.js
 * adapter gives these causes — instead of letting the raw Boom escape as a 500. Transport/local
 * failures (dropped socket, timeout) propagate untouched: folding them in would report a dead
 * connection as a permissions problem.
 */
export async function mapServerRefusal<T>(operation: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const code = refusedStatusCode(error);
    if (code !== undefined && code >= 400 && code < 500) {
      throw new EngineRefusedError(
        `${operation} was refused by WhatsApp (code ${code}) — admin rights or permissions may be missing`,
      );
    }
    throw error;
  }
}

/**
 * Fold neutral `<phone>@c.us` participant ids back to the engine wire dialect (`@s.whatsapp.net`) before
 * a group write. `@lid` (a first-class addressing mode) and the group id itself are left untouched.
 */
export function toEngineParticipants(participants: string[], toEngineJid: (jid: string) => string): string[] {
  return participants.map(toEngineJid);
}

export class BaileysGroups {
  constructor(private readonly host: BaileysGroupsHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  /** Neutral → engine id fold for participant/mention lists. */
  private toEngineParticipants(participants: string[]): string[] {
    return toEngineParticipants(participants, jid => this.host.toEngineJid(jid));
  }

  async getGroups(): Promise<Group[]> {
    this.host.ensureReady();
    const all = await this.sock().groupFetchAllParticipating();
    const self = this.host.normalizedSelfJid();
    return Object.values(all).map(metadata => mapBaileysGroup(metadata, self, jid => this.host.toNeutralJid(jid)));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.host.ensureReady();
    try {
      const metadata = await this.sock().groupMetadata(groupId);
      return mapBaileysGroupInfo(metadata, jid => this.host.toNeutralJid(jid));
    } catch (err) {
      // Only a SERVER refusal may become null (→ service 404): the group does not exist or the
      // account cannot see it. Anything else — a dropped socket, a timeout, a protocol error —
      // folded into null makes a dead transport look like a missing group, so it propagates.
      const code = refusedStatusCode(err);
      if (code === 401 || code === 403 || code === 404) {
        this.host.logger.debug('groupMetadata refused; treating as not-found', {
          groupId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null; // not a group / not visible to this account
      }
      throw err;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.host.ensureReady();
    const metadata = await this.sock().groupCreate(name, this.toEngineParticipants(participants));
    return mapBaileysGroup(metadata, this.host.normalizedSelfJid(), jid => this.host.toNeutralJid(jid));
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runParticipantsUpdate(groupId, participants, 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runParticipantsUpdate(groupId, participants, 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runParticipantsUpdate(groupId, participants, 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runParticipantsUpdate(groupId, participants, 'demote');
  }

  /**
   * Baileys `groupParticipantsUpdate` resolves a per-participant `[{status, jid}]` array where
   * `status` is the server's error attr or '200' (Socket/groups.js:153-155) — discarding it turned
   * every not-admin/not-registered/already-member refusal into a reported success. Map the entries
   * verbatim; THROW only when the operation failed for every requested participant (a refusal of
   * the operation itself → HTTP 403) or the server returned no outcome at all.
   */
  private async runParticipantsUpdate(
    groupId: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    const raw = await this.sock().groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), action);
    const results: ParticipantOperationResult[] = (raw ?? []).map(entry => ({
      id: entry.jid ? this.host.toNeutralJid(entry.jid) : '',
      success: entry.status === '200',
      status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : undefined,
    }));
    if (results.length === 0) {
      throw new EngineRefusedError(
        `groupParticipantsUpdate(${action}) returned no per-participant outcome for group ${groupId}`,
      );
    }
    if (results.every(r => !r.success)) {
      const detail = results.map(r => `${r.id || '?'} (${r.status ?? '?'})`).join(', ');
      throw new EngineRefusedError(
        `${action}Participants failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`,
      );
    }
    return results;
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().groupLeave(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the group subject', () => this.sock().groupUpdateSubject(groupId, subject));
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the group description', () =>
      this.sock().groupUpdateDescription(groupId, description),
    );
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    return (await this.sock().groupInviteCode(groupId)) ?? '';
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    return (await this.sock().groupRevokeInvite(groupId)) ?? '';
  }

  /**
   * Preview a group from its invite code. Read-only — nothing about membership changes, which is
   * what makes it safe to call on a code from an untrusted source.
   *
   * Unlike whatsapp-web.js this comes back typed (GroupMetadata), so the mapping is direct. The
   * participant LIST is dropped even when present: a preview reports a count, and passing a list
   * through would say more about a group the account has not joined than the other engine can.
   */
  async getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    this.host.ensureReady();
    let meta: Awaited<ReturnType<WASocket['groupGetInviteInfo']>>;
    try {
      meta = await this.sock().groupGetInviteInfo(inviteCode);
    } catch (error) {
      // Baileys throws a Boom carrying the WA code for an invalid/expired/revoked invite — the
      // route's documented 404 (matching whatsapp-web.js), not a 500. Transport failures propagate.
      const code = refusedStatusCode(error);
      if (code !== undefined && code >= 400 && code < 500) {
        throw new GroupNotFoundError(inviteCode);
      }
      throw error;
    }
    if (!meta?.id) {
      throw new GroupNotFoundError(inviteCode);
    }
    const count = typeof meta.size === 'number' ? meta.size : meta.participants?.length;
    return {
      id: this.host.toNeutralJid(meta.id),
      name: String(meta.subject ?? ''),
      ...(meta.desc ? { description: String(meta.desc) } : {}),
      // ownerPn is the phone-dialect twin of a lid owner: prefer it so the neutral id does not
      // depend on whether the lid->pn mapping happens to be learned yet.
      ...((meta.ownerPn ?? meta.owner) ? { owner: this.host.toNeutralJid(meta.ownerPn ?? meta.owner!) } : {}),
      ...(typeof meta.creation === 'number' ? { createdAt: meta.creation } : {}),
      ...(typeof count === 'number' ? { participantCount: count } : {}),
    };
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    this.host.ensureReady();
    // Baileys resolves undefined when the invite is invalid/expired/revoked — no group id surfaces —
    // and rejects with an IQ error (e.g. not-authorized / gone) for the same client-facing cause.
    // Both map to a 400. A transport failure (dropped socket, timeout) is NOT a refused invite:
    // folding it into the 400 makes a dead connection look like a bad code, so it propagates.
    let jid: string | undefined;
    try {
      jid = await this.sock().groupAcceptInvite(inviteCode);
    } catch (error) {
      const code = refusedStatusCode(error);
      if (code === undefined || code < 400 || code >= 500) {
        throw error;
      }
      this.host.logger.warn('Group invite refused', { error: String(error) });
      jid = undefined;
    }
    if (!jid) {
      throw new InvalidInviteCodeError();
    }
    // The returned group JID crosses the engine boundary, so it is neutralized like every other emission.
    return this.host.toNeutralJid(jid);
  }

  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting who may send messages', () =>
      this.sock().groupSettingUpdate(groupId, adminsOnly ? 'announcement' : 'not_announcement'),
    );
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting who may edit group info', () =>
      this.sock().groupSettingUpdate(groupId, adminsOnly ? 'locked' : 'unlocked'),
    );
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    this.host.ensureReady();
    // Same socket call as the own-account picture, addressed at the group JID.
    const { data } = await resolveMediaBuffer(media);
    await mapServerRefusal('Setting the group picture', () => this.sock().updateProfilePicture(groupId, data));
  }

  async deleteGroupPicture(groupId: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Removing the group picture', () => this.sock().removeProfilePicture(groupId));
  }

  async setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    this.host.ensureReady();
    // A dedicated socket call, not a groupSettingUpdate option.
    await mapServerRefusal('Setting the member-add mode', () =>
      this.sock().groupMemberAddMode(groupId, mode === 'admins' ? 'admin_add' : 'all_member_add'),
    );
  }

  async setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the disappearing-message timer', () =>
      this.sock().groupToggleEphemeral(groupId, durationSec),
    );
  }
}
