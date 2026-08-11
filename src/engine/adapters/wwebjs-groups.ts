import { type Client } from 'whatsapp-web.js';
import {
  Group,
  GroupInfo,
  GroupJoinInfo,
  GroupMemberAddMode,
  GroupMembershipRequest,
  GroupMembershipRequestMethod,
  MediaInput,
  GroupParticipant,
  ParticipantOperationResult,
} from '../interfaces/whatsapp-engine.interface';
import { GroupChat, GroupMetadataRaw, SerializedWid, readWid } from '../types/whatsapp-web-js.types';
import { toParticipantWid } from '../identity/wa-id';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { toMessageMedia } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Extracts the JID of the parent community a group is linked to, if any.
 * The field name has varied across whatsapp-web.js/WA Web versions, so
 * known candidates are checked in order.
 */
export function extractLinkedParentJID(groupMetadata?: GroupMetadataRaw): string | null {
  const candidate =
    groupMetadata?.parentGroup ?? groupMetadata?.linkedParentGroup ?? groupMetadata?.linkedParent ?? null;

  if (!candidate) {
    return null;
  }

  return readWid(candidate) ?? null;
}

/**
 * Group-domain operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures,
 * so the delegate never touches lifecycle state directly.
 */
/**
 * Normalise whatsapp-web.js's member-add-mode to the neutral vocabulary.
 *
 * Deliberately handles both encodings. The WA Web group model — and GroupChat.setAddMembersAdminsOnly
 * when it writes back (GroupChat.js:476) — use WhatsApp's `'admin_add'`/`'all_member_add'` strings,
 * but index.d.ts:890 declares the field `boolean` with `true` meaning "only admins", the OPPOSITE
 * sense to Baileys' boolean. Reading it as a plain boolean would therefore be wrong on both engines
 * for different reasons, so each shape is decoded explicitly and anything unrecognised is reported
 * as unknown rather than guessed.
 */
export function normalizeWwebjsMemberAddMode(raw: string | boolean | undefined): GroupMemberAddMode | undefined {
  if (raw === 'admin_add') return 'admins';
  if (raw === 'all_member_add') return 'all';
  // The documented (but not observed) boolean form: true = only admins may add.
  if (raw === true) return 'admins';
  if (raw === false) return 'all';
  return undefined;
}

/**
 * Normalise whatsapp-web.js's PascalCase request-method token to the neutral vocabulary.
 * Unrecognised tokens (a future WA Web build) are reported as unknown rather than guessed.
 */
export function normalizeWwebjsRequestMethod(raw: string | undefined): GroupMembershipRequestMethod | undefined {
  if (raw === 'InviteLink') return 'invite_link';
  if (raw === 'NonAdminAdd') return 'non_admin_add';
  if (raw === 'LinkedGroupJoin') return 'linked_group_join';
  return undefined;
}

export class WwebjsGroups {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getGroups(): Promise<Group[]> {
    this.host.ensureReady();
    try {
      const client = this.client();
      const chats = await client.getChats();

      // Filter only group chats
      const groups = chats.filter(chat => chat.isGroup);

      // List path: read linkedParentJID synchronously from whatever metadata getChats()
      // already loaded. We deliberately do NOT fall back to getChatById per group here —
      // that would be an N+1 round-trip across every group on every list call. Groups
      // whose metadata isn't loaded report null; the single-group endpoint (getGroupInfo,
      // which loads full metadata via getChatById) is the authoritative source.
      return groups.map(g => {
        const groupChat = g as unknown as GroupChat;
        return {
          id: g.id._serialized,
          name: g.name,
          participantsCount: groupChat.participants?.length,
          isAdmin: groupChat.participants?.some(
            p => p.isAdmin && readWid(p.id) !== undefined && readWid(p.id) === readWid(client.info?.wid),
          ),
          linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
        };
      });
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'getGroups');
      throw error;
    }
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.host.ensureReady();
    try {
      const chat = await this.client().getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      // Raw page-context Wids: read both property names, and DROP a participant whose id is
      // unreadable rather than emitting the literal string "undefined" as an addressable id.
      const participants: GroupParticipant[] = (groupChat.participants || [])
        .filter(p => readWid(p.id) !== undefined)
        .map(p => ({
          id: readWid(p.id)!,
          number: String(p.id.user),
          name: p.name ? String(p.name) : undefined,
          isAdmin: Boolean(p.isAdmin),
          isSuperAdmin: Boolean(p.isSuperAdmin),
        }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: readWid(groupChat.owner),
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
        announce: groupChat.groupMetadata?.announce,
        locked: groupChat.groupMetadata?.restrict,
        ephemeralSeconds: groupChat.groupMetadata?.ephemeralDuration,
        memberAddMode: normalizeWwebjsMemberAddMode(groupChat.groupMetadata?.memberAddMode),
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    } catch (error) {
      // A dead page and a genuinely-missing group both land in this catch; only the second may
      // become null (→ service 404). A transport death surfaced as "group not found" sends
      // operators debugging the wrong layer — report it and answer 503 instead.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getGroupInfo');
        throw new EngineTransportError(`Transport died while reading group ${groupId}`);
      }
      this.host.logger.warn(`Failed to get group: ${groupId}`, { error: String(error) });
      return null;
    }
  }

  /**
   * Not available on this engine, despite `Client.createGroup` existing and being typed
   * `Promise<CreateGroupResult | string>` (`index.d.ts`).
   *
   * Its page body reaches a WhatsApp Web internal that no longer exposes `findImpl`
   * (`Client.js:2325`, inside the injected evaluate). Measured against a live session on two
   * different WhatsApp Web builds — `2.3000.1044858477-alpha` auto-resolved from the registry, and
   * `2.3000.1044770897-alpha` pinned explicitly — with identical results:
   * `TypeError: this.findImpl is not a function`, reaching the caller as a bare 500. Bare and
   * `@c.us`-qualified participant ids fail the same way, so the id shape is not the variable.
   *
   * The build was varied deliberately because this registry pin moves on its own between restarts;
   * two builds failing the same way is what separates a library limitation from build drift. The
   * Baileys engine creates groups normally on the same account.
   *
   * Nothing here can be patched around: `findImpl` belongs to the page, not to whatsapp-web.js —
   * it appears in neither the installed `Client.js` nor any OpenWA patcher. Restore this method
   * when upstream adopts a page API that WhatsApp Web still provides.
   */
  /* eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async createGroup(_name: string, _participants: string[]): Promise<Group> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('createGroup');
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(toParticipantWid);
    const raw = await (chat as unknown as GroupChat).addParticipants(participantIds);
    // whatsapp-web.js reports a batch-level refusal (no admin rights, empty group) by RESOLVING a
    // plain reason string (GroupChat.js:106-107,128-130) instead of throwing — surface it as a
    // refusal, not a success.
    if (typeof raw === 'string') {
      throw new EngineRefusedError(raw);
    }
    // Per-participant outcome: code 200 = added; 403 invite-only / 404 not registered / 408
    // recently left / 409 already a member / 419 group full (GroupChat.js:102-116).
    const results: ParticipantOperationResult[] = Object.entries(raw ?? {}).map(([id, r]) => {
      // A 403 with isInviteV4Sent is not a failure: wwebjs already delivered the private group
      // invite (GroupChat.js:203-240). Report it as success-with-invite — otherwise an all-invite
      // batch throws "failed for all" (HTTP 403) even though every participant was reached.
      const inviteSent = r.code === 403 && r.isInviteV4Sent === true;
      return {
        id,
        success: r.code === 200 || inviteSent,
        status: r.code,
        message: inviteSent
          ? 'the participant can only be added by private invitation — invite sent'
          : r.message || undefined,
      };
    });
    return this.assertParticipantResults('addParticipants', groupId, results);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('removeParticipants', groupId, participants);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('promoteParticipants', groupId, participants);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.runStatusOnlyParticipantOp('demoteParticipants', groupId, participants);
  }

  /**
   * whatsapp-web.js resolves each requested id against the group's OWN participant collection and
   * silently drops what it cannot find (GroupChat.js:289), then resolves `{status: 200}` for the
   * whole batch. Reporting that as one success per requested participant claimed removals WhatsApp
   * never performed, and an all-dropped batch reached a request builder that asserts at least one
   * child — surfacing as an unnamed `500` (#1220).
   *
   * `scripts/patch-wwebjs-participant-arity.js` makes the page report `matched`, one boolean per
   * requested id, and skip the call when nothing resolved. An absent or wrong-length `matched` means
   * the installed tree is unpatched: keep the previous batch-confirmed shape rather than invent an
   * outcome, mirroring the `eventsAttached` marker convention from the ready-sync patcher. A batch
   * where nothing matched is a refusal of the operation itself (HTTP 403) via
   * {@link assertParticipantResults}.
   */
  private async runStatusOnlyParticipantOp(
    op: 'removeParticipants' | 'promoteParticipants' | 'demoteParticipants',
    groupId: string,
    participants: string[],
  ): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(toParticipantWid);
    const res = await this.runParticipantBatch(op, groupId, chat as unknown as GroupChat, participantIds);
    if (res?.status !== 200) {
      throw new EngineRefusedError(`${op} refused for group ${groupId} (status ${res?.status ?? 'unknown'})`);
    }
    const matched = Array.isArray(res.matched) && res.matched.length === participantIds.length ? res.matched : null;
    const results = participantIds.map((id, i) => {
      const resolved = matched ? matched[i] === true : true;
      return {
        id,
        success: resolved,
        status: resolved ? 200 : 404,
        message: resolved
          ? 'confirmed with the batch — wwebjs reports no per-participant outcome'
          : 'not a member of this group — WhatsApp was not asked to act on this participant',
      };
    });
    return this.assertParticipantResults(op, groupId, results);
  }

  /**
   * An unpatched tree hands the WA Web request builder an empty participant list when nothing
   * resolved, and its repeated-field arity assertion rejects. Classify ONLY that: anything else — a
   * closed target, a dead transport — must keep its own identity rather than be sold to the caller
   * as a permissions problem, the same rule the Baileys adapter states for its empty-results guard.
   */
  private async runParticipantBatch(
    op: 'removeParticipants' | 'promoteParticipants' | 'demoteParticipants',
    groupId: string,
    chat: GroupChat,
    participantIds: string[],
  ): Promise<{ status?: number; matched?: unknown }> {
    try {
      return await chat[op](participantIds);
    } catch (error) {
      if (/expected at least 1 children/.test((error as Error)?.message ?? '')) {
        throw new EngineRefusedError(`${op}: none of the requested participants is a member of group ${groupId}`);
      }
      throw error;
    }
  }

  /**
   * Shared gate for the membership writes: a result list with at least one success resolves as-is
   * (partial refusals stay visible per participant); a batch that failed for EVERY requested
   * participant is a refusal of the operation itself (HTTP 403), not a per-participant detail; and
   * an empty result is no evidence of success at all.
   */
  private assertParticipantResults(
    op: string,
    groupId: string,
    results: ParticipantOperationResult[],
  ): ParticipantOperationResult[] {
    if (results.length === 0) {
      throw new EngineRefusedError(`${op} returned no per-participant outcome for group ${groupId}`);
    }
    if (results.every(r => !r.success)) {
      const detail = results.map(r => `${r.id} (${r.status ?? '?'})`).join(', ');
      throw new EngineRefusedError(
        `${op} failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`,
      );
    }
    return results;
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    // GroupChat.setSubject resolves false when WA Web rejects the change (e.g. the account lacks
    // admin rights; index.d.ts:1982) instead of throwing — surface the refusal, not a false success.
    const ok = await (chat as unknown as GroupChat).setSubject(subject);
    if (!ok) {
      throw new EngineRefusedError(`Failed to set the subject for group ${groupId} — admin rights required`);
    }
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    // Same discarded-boolean contract as setSubject (index.d.ts:1984).
    const ok = await (chat as unknown as GroupChat).setDescription(description);
    if (!ok) {
      throw new EngineRefusedError(`Failed to set the description for group ${groupId} — admin rights required`);
    }
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    // Typed Promise<string>, but WA Web yields nothing when the account is not an admin of the
    // group — and String(undefined) is the literal 'undefined', which the caller renders as the
    // link "https://chat.whatsapp.com/undefined". Same refusal contract as setDescription.
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    if (!inviteCode) {
      throw new EngineRefusedError(`Failed to get the invite code for group ${groupId} — admin rights required`);
    }
    this.host.logger.log(`Got invite code for group ${groupId}`);
    return inviteCode;
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    if (!newCode) {
      throw new EngineRefusedError(`Failed to revoke the invite code for group ${groupId} — admin rights required`);
    }
    this.host.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return newCode;
  }

  /**
   * Preview a group from its invite code.
   *
   * `Client.getInviteInfo` is typed `Promise<object>` and forwards whatever WA Web's
   * `queryGroupInvite` returns, so there is no contract to rely on — every field is read
   * defensively and omitted when absent rather than defaulted into something that reads as fact.
   * The one thing that IS required is an id: without it there is no group to describe, which means
   * the invite was refused (invalid, expired or revoked) rather than that a field is missing.
   */
  async getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    this.host.ensureReady();
    type RawInviteInfo = {
      id?: { _serialized?: string; $1?: string } | string;
      subject?: string;
      desc?: string;
      owner?: { _serialized?: string; $1?: string } | string;
      creation?: number;
      size?: number;
      participants?: unknown[];
    } | null;
    // A refused invite (invalid, expired, revoked) rejects PAGE-SIDE inside WA Web's query job, and
    // Client.getInviteInfo bare-forwards that rejection — unmapped it escapes as an opaque 500 for
    // the endpoint's most common error input, which the route documents (and Baileys answers) as
    // 404. The sibling joinGroupViaInviteCode maps the same cause; this is the read half.
    let raw: RawInviteInfo;
    try {
      raw = await this.client().getInviteInfo(inviteCode);
    } catch (error) {
      // A dead page and a refused invite both land here; only the second is a 404. Folding a
      // transport death into "no such invite" sends operators debugging the wrong layer.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getGroupJoinInfo');
        throw new EngineTransportError(`Transport died while previewing invite ${inviteCode}`);
      }
      this.host.logger.debug('getInviteInfo rejected; treating the invite as not found', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new GroupNotFoundError(inviteCode);
    }

    // Raw page-context Wids: read `$1` before concluding absence (#747, the WA Web minifier
    // rename) — without the fallback a renamed build turns every VALID invite into a false 404.
    const id = readWid(raw?.id);
    if (!id) {
      throw new GroupNotFoundError(inviteCode);
    }
    const owner = readWid(raw?.owner);
    // `size` is the disclosed count; a participants array is used only as a fallback for builds that
    // send one instead. Neither is synthesised when both are missing.
    const count = typeof raw?.size === 'number' ? raw.size : raw?.participants?.length;

    return {
      id,
      name: String(raw?.subject ?? ''),
      ...(raw?.desc ? { description: String(raw.desc) } : {}),
      ...(owner ? { owner } : {}),
      ...(typeof raw?.creation === 'number' ? { createdAt: raw.creation } : {}),
      ...(typeof count === 'number' ? { participantCount: count } : {}),
    };
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    this.host.ensureReady();
    // acceptInvite throws a page-side evaluation error when the invite is refused (invalid/expired/
    // revoked); otherwise it resolves the joined group's id (`res.gid._serialized || res.gid.$1`,
    // Client.js:1836-1845) — already the neutral `<id>@g.us` dialect. A gid-less result is the same
    // client-facing outcome as a thrown refusal: no such invite (400, not a 500).
    let groupId: string | undefined;
    try {
      groupId = await this.client().acceptInvite(inviteCode);
    } catch (error) {
      // A refused invite and a broken page both land here, and only the first is the caller's
      // fault. A transport death must not be reported as "invalid invite" (400): report the death
      // to the liveness path and answer 503 so the caller can tell the layers apart.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'joinGroupViaInviteCode');
        throw new EngineTransportError('Transport died while accepting the group invite');
      }
      this.host.logger.warn(`Failed to accept group invite: ${String(error)}`);
      groupId = undefined;
    }
    if (!groupId) {
      throw new InvalidInviteCodeError();
    }
    this.host.logger.log(`Joined group ${groupId} via invite code`);
    return groupId;
  }

  /** Resolve a group chat or throw — the shared preamble of the group settings writes. */
  private async requireGroupChat(groupId: string): Promise<GroupChat> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    // getChatById RESOLVES undefined for an unknown id (wwebjs does not throw): unknown id and a
    // non-group id are the same client-facing outcome — there is no such group (404, not a 500).
    if (!chat?.isGroup) {
      throw new GroupNotFoundError(groupId);
    }
    return chat as unknown as GroupChat;
  }

  // Set "only admins can send messages" (announce)
  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    // Resolves false instead of throwing when the account lacks admin rights (GroupChat.js:503) —
    // surface that as an error rather than a silent no-op.
    const ok = await groupChat.setMessagesAdminsOnly(adminsOnly);
    if (!ok) {
      throw new EngineRefusedError(
        `Failed to update the messages-admins-only setting for group ${groupId} — admin rights required`,
      );
    }
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    // GroupChat.setPicture, NOT Client.setProfilePicture — the latter targets the own account.
    const ok = await groupChat.setPicture(await toMessageMedia(media));
    if (!ok) {
      throw new EngineRefusedError(`Failed to set the picture for group ${groupId} — admin rights required`);
    }
  }

  async deleteGroupPicture(groupId: string): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    const ok = await groupChat.deletePicture();
    if (!ok) {
      throw new EngineRefusedError(`Failed to delete the picture for group ${groupId} — admin rights required`);
    }
  }

  // Set who may add participants. NOT a groupSettingUpdate option on either engine — wwjs has its
  // own GroupChat setter, and it is inverted relative to our neutral vocabulary: adminsOnly=true
  // means mode 'admins'.
  async setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    const ok = await groupChat.setAddMembersAdminsOnly(mode === 'admins');
    if (!ok) {
      throw new EngineRefusedError(
        `Failed to update the member-add-mode setting for group ${groupId} — admin rights required`,
      );
    }
  }

  // Set "only admins can edit group info" (locked/restrict)
  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    const ok = await groupChat.setInfoAdminsOnly(adminsOnly);
    if (!ok) {
      throw new EngineRefusedError(
        `Failed to update the info-admins-only setting for group ${groupId} — admin rights required`,
      );
    }
  }

  // whatsapp-web.js 1.34.7 exposes no disappearing-messages setter (no Client/GroupChat symbol in
  // index.d.ts; only a create-time messageTimer option, Client.js:2371) — an honest 501, not a no-op.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async setGroupEphemeral(_groupId: string, _durationSec: number): Promise<void> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('setGroupEphemeral');
  }

  async getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]> {
    this.host.ensureReady();
    try {
      const raw = await this.client().getGroupMembershipRequests(groupId);
      // Raw page-context store objects: wids can arrive as {_serialized} OR {$1} (the #747
      // minifier rename), so every id goes through readWid; a requester whose wid is unreadable
      // is dropped rather than reported as the literal "undefined".
      return (raw ?? []).flatMap(entry => {
        const e = entry as unknown as {
          id?: SerializedWid | string;
          addedBy?: SerializedWid | string;
          requestMethod?: string;
          t?: number;
        };
        const participantId = readWid(e.id);
        if (!participantId) {
          return [];
        }
        const addedById = readWid(e.addedBy);
        const method = normalizeWwebjsRequestMethod(e.requestMethod);
        return [
          {
            participantId,
            ...(addedById ? { addedById } : {}),
            ...(method ? { method } : {}),
            ...(typeof e.t === 'number' ? { requestedAt: e.t } : {}),
          },
        ];
      });
    } catch (error) {
      this.host.reportIfPageTransportError(error, 'getGroupMembershipRequests');
      throw error;
    }
  }

  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestAction('approveGroupMembershipRequests', groupId, participants);
  }

  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.runMembershipRequestAction('rejectGroupMembershipRequests', groupId, participants);
  }

  /**
   * Shared body of the approve/reject writes. The upstream default sleep (a human-ish 250-500ms
   * pause between requesters) is restated explicitly so a wwebjs default change cannot silently
   * alter this gateway's pacing. The membership-write guards (assertParticipantResults) apply only
   * when the caller NAMED requesters: acting on "all pending" of an empty queue is a legitimate
   * no-op that resolves [], not a refusal.
   */
  private async runMembershipRequestAction(
    op: 'approveGroupMembershipRequests' | 'rejectGroupMembershipRequests',
    groupId: string,
    participants?: string[],
  ): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    const raw = await this.client()[op](groupId, {
      // Qualified like every other participant write in this file: the service blesses a bare phone
      // number, and the page maps requesterIds straight through `createWid` (Injected/Utils.js) —
      // which upstream itself never hands a bare number, appending '@c.us' first. Unqualified it
      // threw inside the minified bundle and the caller got an undiagnosable 500, while the same
      // input succeeded on Baileys. `null` still means every pending request.
      requesterIds: participants?.map(toParticipantWid) ?? null,
      sleep: [250, 500],
    });
    // {requesterId, error?, message} per requester; requesterId is a page-context value that can
    // arrive as a string or a wid object (both #747 spellings), so it goes through readWid too.
    // "No error field" is NOT sufficient for success: the page util's non-success RPC branch pushes
    // {requesterId, message: 'ServerStatusCodeError'} with no code at all (Injected/Utils.js:1637-1648).
    const results: ParticipantOperationResult[] = (raw ?? []).map(entry => {
      const e = entry as unknown as { requesterId?: SerializedWid | string | null; error?: number; message?: string };
      return {
        id: readWid(e.requesterId ?? undefined) ?? '',
        success: e.error === undefined && e.message !== 'ServerStatusCodeError',
        ...(e.error !== undefined ? { status: e.error } : {}),
        ...(e.message ? { message: e.message } : {}),
      };
    });
    if (!participants) {
      return results;
    }
    return this.assertParticipantResults(op, groupId, results);
  }
}
