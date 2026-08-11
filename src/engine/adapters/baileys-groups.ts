import type { WASocket } from '@whiskeysockets/baileys';
import {
  Group,
  GroupInfo,
  GroupJoinInfo,
  GroupMemberAddMode,
  GroupMembershipRequest,
  GroupMembershipRequestMethod,
  MediaInput,
  ParticipantOperationResult,
} from '../interfaces/whatsapp-engine.interface';
import { mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { resolveMediaBuffer } from './baileys-messaging';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { type createLogger } from '../../common/services/logger.service';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';
import { toParticipantWid } from '../identity/wa-id';

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
 *
 * A numeric `data` is the whole discriminator, and it is sufficient: `query()` runs
 * `assertNodeErrorFree(result)` before it returns (Socket/socket.js:133-135), and that throws
 * `new Boom(text, { data: +errNode.attrs.code })` (WABinary/generic-utils.js:57). So every refusal
 * that can reach a caller through `query()` already carries its WA code as a number.
 *
 * There used to be a second branch reading `output.statusCode` whenever `data !== undefined`,
 * meant for `extractGroupMetadata`'s error-node throw (Socket/groups.js). It did the opposite of
 * its purpose: Boom's constructor destructures `data = null` (@hapi/boom lib/index.js:77), so NO
 * Boom ever has `data === undefined` and the guard was always true. Every transport Boom therefore
 * matched — `Boom('Connection Closed', { statusCode: 428 })` returned 428, inside the 4xx window,
 * so a dead socket was reported as `403 admin rights or permissions may be missing`. The branch was
 * also unnecessary: its target throw cannot be reached through `query()`, because a result carrying
 * an `<error>` child has already thrown from assertNodeErrorFree's identical lookup.
 *
 * Only the IQ error channel is decoded here. WhatsApp's w:mex surface reports a refusal as a
 * GraphQL error inside a SUCCESSFUL iq, which never passes through assertNodeErrorFree and carries
 * an object rather than a numeric `data` — see wmexRefusalCode in baileys-channels.ts. Widening this
 * function to accept an object `data` would also swallow promiseTimeout's Boom, which carries
 * `{ stack }` alongside a 4xx DisconnectReason code, so the two channels stay separate.
 */
export function refusedStatusCode(error: unknown): number | undefined {
  const err = error as { data?: unknown } | null | undefined;
  return typeof err?.data === 'number' ? err.data : undefined;
}

/**
 * Run a socket write and map a SERVER refusal (a 4xx-class WA code: admin rights missing, not
 * permitted, not acceptable) to EngineRefusedError — HTTP 403, the same status the whatsapp-web.js
 * adapter gives these causes — instead of letting the raw Boom escape as a 500. Transport/local
 * failures (dropped socket, timeout) propagate untouched: folding them in would report a dead
 * connection as a permissions problem.
 */
export async function mapServerRefusal<T>(
  operation: string,
  op: () => Promise<T>,
  classify: (error: unknown) => number | undefined = refusedStatusCode,
): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const code = classify(error);
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
 *
 * A BARE number is qualified first. `toEngineJid` folds only an already-domained user id, so a bare
 * number used to travel verbatim into the participant node — and Baileys' encoder writes an
 * un-domained string as a packed nibble rather than a JID_PAIR, so WhatsApp received an attribute
 * that was not a JID and the write did nothing. The bare form is the documented convenience input on
 * these routes and the service guard accepts it, so it has to be addressable by the time it lands here.
 */
export function toEngineParticipants(participants: string[], toEngineJid: (jid: string) => string): string[] {
  return participants.map(p => toEngineJid(toParticipantWid(p)));
}

/** The neutral method tokens — Baileys' wire tokens are already this vocabulary. */
const MEMBERSHIP_REQUEST_METHODS: readonly GroupMembershipRequestMethod[] = [
  'invite_link',
  'non_admin_add',
  'linked_group_join',
];

export class BaileysGroups {
  constructor(
    private readonly host: BaileysGroupsHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
  private confirmed<T>(work: Promise<T>, operation: string): Promise<T> {
    return withQueryDeadline(work, this.queryBudgetMs, `WhatsApp did not confirm ${operation} in time`);
  }

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
    // groupFetchAllParticipating yields {} for BOTH an unanswered query and an account with no
    // groups, so the empty list carries no signal — only our own clock separates them, and an
    // empty list is the shape a caller is least able to question.
    const all = await withQueryDeadline(
      this.sock().groupFetchAllParticipating(),
      this.queryBudgetMs,
      'WhatsApp did not answer the group list query in time',
    );
    const self = this.host.normalizedSelfJid();
    return Object.values(all).map(metadata => mapBaileysGroup(metadata, self, jid => this.host.toNeutralJid(jid)));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.host.ensureReady();
    try {
      const metadata = await withQueryDeadline(
        this.sock().groupMetadata(groupId),
        this.queryBudgetMs,
        'WhatsApp did not answer the group metadata query in time',
      );
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

  /**
   * Deliberately NOT bounded by a deadline, unlike the reads either side of it. Creating a group is
   * the one non-idempotent operation here, and 503 is a backpressure status the Go SDK retries three
   * times for POST (sdk/go/retry.go) — an OpenWA deadline abandons the call without cancelling it,
   * so a slow-but-succeeding create could be issued four times and leave duplicate groups. An
   * unanswered query therefore still surfaces opaquely rather than as something retryable.
   */
  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.host.ensureReady();
    const metadata = await mapServerRefusal('Creating the group', () =>
      this.sock().groupCreate(name, this.toEngineParticipants(participants)),
    );
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
   *
   * The per-participant array is not the only refusal channel: WhatsApp can reject the IQ itself,
   * and `assertNodeErrorFree` then throws with the WA code on `data`. Every other write in this file
   * routes through {@link mapServerRefusal} for exactly that; this one did not, so a batch-level
   * refusal escaped as an unhandled error (HTTP 500) instead of the 403 its siblings give. The
   * deadline stays INSIDE the mapping so a timeout is still reported as a timeout — `refusedStatusCode`
   * only classifies a numeric `data`, so a transport Boom passes through untouched.
   */
  private async runParticipantsUpdate(
    groupId: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    // An unanswered query yields [], which the empty-results guard below would report as a refusal
    // — a dead transport sold to the caller as a permissions problem.
    const raw = await mapServerRefusal(`The participant ${action}`, () =>
      withQueryDeadline(
        this.sock().groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), action),
        this.queryBudgetMs,
        `WhatsApp did not answer the participant ${action} in time`,
      ),
    );
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
    await this.confirmed(this.sock().groupLeave(groupId), 'leaving the group');
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the group subject', () =>
      this.confirmed(this.sock().groupUpdateSubject(groupId, subject), 'the group subject change'),
    );
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the group description', () =>
      this.confirmed(this.sock().groupUpdateDescription(groupId, description), 'the group description change'),
    );
  }

  /**
   * Fetching an invite code is admin-only, but every group the account belongs to is listed by
   * getGroups regardless of role — so the refusal lands on ids the caller has just been handed.
   * Both failure shapes are surfaced rather than flattened into a code: a refusal rejects with a
   * Boom carrying the WA code (403, like every other admin-gated group operation), while an
   * unanswered query resolves undefined, which coalescing to '' turned into the meaningless link
   * "https://chat.whatsapp.com/" behind a 200.
   */
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    const code = await mapServerRefusal('Fetching the group invite code', () => this.sock().groupInviteCode(groupId));
    if (!code) {
      throw new EngineTransportError('WhatsApp did not answer the group invite-code query');
    }
    return code;
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    const code = await mapServerRefusal('Revoking the group invite code', () => this.sock().groupRevokeInvite(groupId));
    if (!code) {
      throw new EngineTransportError('WhatsApp did not answer the group invite-code revocation');
    }
    return code;
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
      meta = await withQueryDeadline(
        this.sock().groupGetInviteInfo(inviteCode),
        this.queryBudgetMs,
        'WhatsApp did not answer the invite-info query in time',
      );
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
    //
    // That guarantee needs the deadline to hold at all. An UNANSWERED query also resolves undefined
    // — it never reaches the catch — so without a clock of our own it lands on the same `if (!jid)`
    // as a genuinely bad code and answers 400, which is precisely what the paragraph above forbids.
    let jid: string | undefined;
    try {
      jid = await withQueryDeadline(
        this.sock().groupAcceptInvite(inviteCode),
        this.queryBudgetMs,
        'WhatsApp did not answer the group join in time',
      );
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
      this.confirmed(
        this.sock().groupSettingUpdate(groupId, adminsOnly ? 'announcement' : 'not_announcement'),
        'the who-may-send change',
      ),
    );
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting who may edit group info', () =>
      this.confirmed(
        this.sock().groupSettingUpdate(groupId, adminsOnly ? 'locked' : 'unlocked'),
        'the who-may-edit change',
      ),
    );
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    this.host.ensureReady();
    // Same socket call as the own-account picture, addressed at the group JID.
    const { data } = await resolveMediaBuffer(media);
    await mapServerRefusal('Setting the group picture', () =>
      this.confirmed(this.sock().updateProfilePicture(groupId, data), 'the group picture change'),
    );
  }

  async deleteGroupPicture(groupId: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Removing the group picture', () =>
      this.confirmed(this.sock().removeProfilePicture(groupId), 'the group picture removal'),
    );
  }

  async setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    this.host.ensureReady();
    // A dedicated socket call, not a groupSettingUpdate option.
    await mapServerRefusal('Setting the member-add mode', () =>
      this.confirmed(
        this.sock().groupMemberAddMode(groupId, mode === 'admins' ? 'admin_add' : 'all_member_add'),
        'the member-add-mode change',
      ),
    );
  }

  async setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Setting the disappearing-message timer', () =>
      this.confirmed(this.sock().groupToggleEphemeral(groupId, durationSec), 'the disappearing-message timer change'),
    );
  }

  async getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]> {
    this.host.ensureReady();
    const raw = await mapServerRefusal('Listing the membership requests', () =>
      withQueryDeadline(
        this.sock().groupRequestParticipantsList(groupId),
        this.queryBudgetMs,
        'WhatsApp did not answer the membership-request list query in time',
      ),
    );
    // Bare wire attrs: engine-dialect `jid`, snake_case `request_method`, stringly `request_time`.
    // Fields that do not parse are omitted rather than defaulted; an entry without a jid carries
    // nothing addressable and is dropped.
    return (raw ?? []).flatMap(attrs => {
      if (!attrs.jid) {
        return [];
      }
      const method = MEMBERSHIP_REQUEST_METHODS.includes(attrs.request_method as GroupMembershipRequestMethod)
        ? (attrs.request_method as GroupMembershipRequestMethod)
        : undefined;
      const requestedAt = Number(attrs.request_time);
      return [
        {
          participantId: this.host.toNeutralJid(attrs.jid),
          ...(method ? { method } : {}),
          ...(Number.isFinite(requestedAt) && requestedAt > 0 ? { requestedAt: Math.floor(requestedAt) } : {}),
        },
      ];
    });
  }

  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestsUpdate(groupId, participants, 'approve');
  }

  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestsUpdate(groupId, participants, 'reject');
  }

  /**
   * `groupRequestParticipantsUpdate` resolves the same per-jid `[{status, jid}]` shape as the
   * participant writes (status is the server's error attr or '200', Socket/groups.js:116-139), and
   * the same guards apply — but only when the caller NAMED requesters. Baileys has no act-on-all
   * form, so an omitted list enumerates the pending queue first; an empty queue is a legitimate
   * no-op that resolves [], not a refusal.
   */
  private async runMembershipRequestsUpdate(
    groupId: string,
    participants: string[] | undefined,
    action: 'approve' | 'reject',
  ): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    let targets: string[];
    if (participants) {
      targets = this.toEngineParticipants(participants);
    } else {
      const pending = await mapServerRefusal(`Listing the membership requests to ${action}`, () =>
        withQueryDeadline(
          this.sock().groupRequestParticipantsList(groupId),
          this.queryBudgetMs,
          'WhatsApp did not answer the membership-request list query in time',
        ),
      );
      targets = (pending ?? []).map(attrs => attrs.jid).filter((jid): jid is string => Boolean(jid));
      if (targets.length === 0) {
        return [];
      }
    }
    const raw = await mapServerRefusal(`Membership-request ${action}`, () =>
      withQueryDeadline(
        this.sock().groupRequestParticipantsUpdate(groupId, targets, action),
        this.queryBudgetMs,
        `WhatsApp did not answer the membership-request ${action} in time`,
      ),
    );
    const results: ParticipantOperationResult[] = (raw ?? []).map(entry => ({
      id: entry.jid ? this.host.toNeutralJid(entry.jid) : '',
      success: entry.status === '200',
      status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : undefined,
    }));
    if (!participants) {
      return results;
    }
    if (results.length === 0) {
      throw new EngineRefusedError(
        `groupRequestParticipantsUpdate(${action}) returned no per-participant outcome for group ${groupId}`,
      );
    }
    if (results.every(r => !r.success)) {
      const detail = results.map(r => `${r.id || '?'} (${r.status ?? '?'})`).join(', ');
      throw new EngineRefusedError(
        `Membership-request ${action} failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`,
      );
    }
    return results;
  }
}
