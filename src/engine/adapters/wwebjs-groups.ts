import { type Client } from 'whatsapp-web.js';
import {
  Group,
  GroupInfo,
  GroupJoinInfo,
  GroupMemberAddMode,
  MediaInput,
  GroupParticipant,
  ParticipantOperationResult,
} from '../interfaces/whatsapp-engine.interface';
import { GroupChat, GroupMetadataRaw, GroupCreateResult, SerializedWid, readWid } from '../types/whatsapp-web-js.types';
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

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.host.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client().createGroup(name, participantIds);

    // whatsapp-web.js reports a failed creation by RESOLVING with a plain string
    // ('CreateGroupError: …', Client.js:2376) rather than throwing, and its own typings say so
    // (`Promise<CreateGroupResult | string>`). Reading `.gid` straight off that string threw an opaque
    // TypeError and discarded the reason upstream actually gave us; surface it instead.
    if (typeof result === 'string') {
      throw new Error(result);
    }
    const gid = (result as unknown as GroupCreateResult).gid as SerializedWid | undefined;
    const groupId = readWid(gid);
    // A group id is not ack-safe the way a message id is: there is no empty-sentinel equivalent, and any
    // placeholder would be handed back as a real, addressable group. Fail instead of inventing one.
    if (!groupId) {
      throw new Error('the group was created but its id could not be read');
    }
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
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
   * whatsapp-web.js remove/promote/demote resolve `{status: 200}` for the whole batch and reject on
   * a page-side failure (GroupChat.js:267-298,305-340,343-374) — there is no per-participant
   * breakdown to map: the page-side code even drops requested ids it can't find in the group and
   * still resolves 200, so a 200 confirms the batch, not any individual. A non-200 status is a
   * batch refusal. Within the per-participant shape the truthful report is one entry per requested
   * participant carrying the batch status, annotated so a consumer can tell it apart from an
   * individually-confirmed outcome (addParticipants); nothing per-participant exists to map.
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
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const res = await (chat as unknown as GroupChat)[op](participantIds);
    if (res?.status !== 200) {
      throw new EngineRefusedError(`${op} refused for group ${groupId} (status ${res?.status ?? 'unknown'})`);
    }
    return participantIds.map(id => ({
      id,
      success: true,
      status: 200,
      message: 'confirmed with the batch — wwebjs reports no per-participant outcome',
    }));
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
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.host.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.host.ensureReady();
    const chat = await this.client().getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.host.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
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
}
