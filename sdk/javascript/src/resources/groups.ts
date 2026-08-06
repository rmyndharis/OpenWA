/**
 * Groups resource — WhatsApp group management.
 *
 * Backed by `src/modules/group/group.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  CreateGroupRequest,
  GroupInfo,
  GroupJoinInfo,
  GroupSettingsResponse,
  GroupSummary,
  InviteCodeResponse,
  SetGroupPictureRequest,
  JoinGroupRequest,
  JoinGroupResponse,
  SuccessResult,
  UpdateGroupSettingsRequest,
} from '../types.js';

export interface ListGroupsQuery {
  limit?: number;
  offset?: number;
}

export class GroupsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all groups for the session. */
  list(sessionId: string, query?: ListGroupsQuery): Promise<GroupSummary[]> {
    return this.client.request<GroupSummary[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups`,
      query,
    });
  }

  /** Get detailed group info including the participant list. */
  get(sessionId: string, groupId: string): Promise<GroupInfo> {
    return this.client.request<GroupInfo>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}`,
    });
  }

  /** Create a new group. */
  create(sessionId: string, body: CreateGroupRequest): Promise<GroupInfo> {
    return this.client.request<GroupInfo>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups`,
      body,
    });
  }

  /**
   * Preview a group from its invite code, WITHOUT joining. Read-only, so it is safe to call on a
   * code from an untrusted source.
   *
   * There is no participant list — the account is not a member — only a count, and only when
   * WhatsApp discloses one. Fields the engine did not report are absent rather than zeroed.
   */
  joinInfo(sessionId: string, code: string): Promise<GroupJoinInfo> {
    return this.client.request<GroupJoinInfo>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/join-info`,
      query: { code },
    });
  }

  /** Join a group via an invite code. */
  joinGroup(sessionId: string, body: JoinGroupRequest): Promise<JoinGroupResponse> {
    return this.client.request<JoinGroupResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/join`,
      body,
    });
  }

  /** Add participants to a group. */
  addParticipants(sessionId: string, groupId: string, participants: string[]): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/participants`,
      body: { participants },
    });
  }

  /** Remove participants from a group. */
  removeParticipants(sessionId: string, groupId: string, participants: string[]): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/participants`,
      body: { participants },
    });
  }

  /** Promote participants to group admin. */
  promoteParticipants(sessionId: string, groupId: string, participants: string[]): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/participants/promote`,
      body: { participants },
    });
  }

  /** Demote participants from group admin. */
  demoteParticipants(sessionId: string, groupId: string, participants: string[]): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/participants/demote`,
      body: { participants },
    });
  }

  /** Update the group subject (name). */
  setSubject(sessionId: string, groupId: string, subject: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/subject`,
      body: { subject },
    });
  }

  /** Update the group description (empty string clears it). */
  setDescription(sessionId: string, groupId: string, description: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/description`,
      body: { description },
    });
  }

  /** Get the group settings (announce / locked / ephemeral timer). */
  getGroupSettings(sessionId: string, groupId: string): Promise<GroupSettingsResponse> {
    return this.client.request<GroupSettingsResponse>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/settings`,
    });
  }

  /**
   * Update the group settings. At least one field is required; `ephemeralSeconds`
   * is unsupported on the whatsapp-web.js engine (the server answers 501).
   */
  updateGroupSettings(sessionId: string, groupId: string, body: UpdateGroupSettingsRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/settings`,
      body,
    });
  }

  /** Leave a group. */
  leave(sessionId: string, groupId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/leave`,
    });
  }

  /** Get the group's picture URL (null when it has none). */
  getPicture(sessionId: string, groupId: string): Promise<{ url: string | null }> {
    return this.client.request<{ url: string | null }>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/picture`,
    });
  }

  /** Set the group's picture. Requires admin rights on the group. */
  setPicture(sessionId: string, groupId: string, body: SetGroupPictureRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/picture`,
      body,
    });
  }

  /** Remove the group's picture. Requires admin rights on the group. */
  deletePicture(sessionId: string, groupId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/picture`,
    });
  }

  /** Get the group invite code and link. */
  inviteCode(sessionId: string, groupId: string): Promise<InviteCodeResponse> {
    return this.client.request<InviteCodeResponse>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/invite-code`,
    });
  }

  /** Revoke the current invite code and generate a new one. */
  revokeInviteCode(sessionId: string, groupId: string): Promise<InviteCodeResponse> {
    return this.client.request<InviteCodeResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/invite-code/revoke`,
    });
  }
}
