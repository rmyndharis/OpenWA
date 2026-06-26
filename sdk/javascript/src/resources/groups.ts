/**
 * Groups resource — WhatsApp group management.
 *
 * Backed by `src/modules/group/group.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { CreateGroupRequest, GroupInfo, GroupSummary, InviteCodeResponse, SuccessResult } from '../types.js';

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

  /** Leave a group. */
  leave(sessionId: string, groupId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/groups/${encodeSegment(groupId)}/leave`,
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
