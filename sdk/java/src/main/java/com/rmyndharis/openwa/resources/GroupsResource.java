package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateGroupRequest;
import com.rmyndharis.openwa.model.GroupDescriptionRequest;
import com.rmyndharis.openwa.model.GroupInfo;
import com.rmyndharis.openwa.model.GroupJoinInfo;
import com.rmyndharis.openwa.model.GroupMembershipRequest;
import com.rmyndharis.openwa.model.MembershipRequestActionRequest;
import com.rmyndharis.openwa.model.GroupSettings;
import com.rmyndharis.openwa.model.GroupSubjectRequest;
import com.rmyndharis.openwa.model.GroupSummary;
import com.rmyndharis.openwa.model.GroupPictureResponse;
import com.rmyndharis.openwa.model.InviteCodeResponse;
import com.rmyndharis.openwa.model.SetGroupPictureRequest;
import com.rmyndharis.openwa.model.JoinGroupRequest;
import com.rmyndharis.openwa.model.JoinGroupResponse;
import com.rmyndharis.openwa.model.ListGroupsQuery;
import com.rmyndharis.openwa.model.ParticipantsRequest;
import com.rmyndharis.openwa.model.ParticipantsResult;
import com.rmyndharis.openwa.model.SuccessResult;
import java.util.List;

/** Groups resource — WhatsApp group management. */
public final class GroupsResource {
    private final OpenWAClient client;

    public GroupsResource(OpenWAClient client) {
        this.client = client;
    }

    /** List all groups for the session. */
    public List<GroupSummary> list(String sessionId) {
        return list(sessionId, null);
    }

    /** List all groups for the session, applying the given pagination query. */
    public List<GroupSummary> list(String sessionId, ListGroupsQuery query) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/groups", query, null, GroupSummary.class);
    }

    /** Get detailed group info including the participant list. */
    public GroupInfo get(String sessionId, String groupId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId),
            null,
            null,
            GroupInfo.class);
    }

    /**
     * Create a group. Answers the group SUMMARY, not the detail shape {@code get} returns — there is
     * no participant list, description, owner or creation time on a create response.
     */
    public GroupSummary create(String sessionId, CreateGroupRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/groups", null, body, GroupSummary.class);
    }

    /** Add participants to a group. */
    public ParticipantsResult addParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants",
            null,
            new ParticipantsRequest(participants),
            ParticipantsResult.class);
    }

    /** Remove participants from a group. */
    public ParticipantsResult removeParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants",
            null,
            new ParticipantsRequest(participants),
            ParticipantsResult.class);
    }

    /** Promote participants to group admin. */
    public ParticipantsResult promoteParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants/promote",
            null,
            new ParticipantsRequest(participants),
            ParticipantsResult.class);
    }

    /** Demote participants from group admin. */
    public ParticipantsResult demoteParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants/demote",
            null,
            new ParticipantsRequest(participants),
            ParticipantsResult.class);
    }

    /** Update the group subject (name). */
    public SuccessResult setSubject(String sessionId, String groupId, String subject) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/subject",
            null,
            new GroupSubjectRequest(subject),
            SuccessResult.class);
    }

    /**
     * Preview a group from its invite code, WITHOUT joining. Read-only, so it is safe to call on a
     * code from an untrusted source.
     *
     * <p>There is no participant list — the account is not a member — only a count, and only when
     * WhatsApp discloses one.
     */
    public GroupJoinInfo joinInfo(String sessionId, String code) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/join-info",
            java.util.Map.of("code", code),
            null,
            GroupJoinInfo.class);
    }

    /** Join a group via an invite code. Returns the joined group id. */
    public JoinGroupResponse joinGroup(String sessionId, String inviteCode) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/join",
            null,
            new JoinGroupRequest(inviteCode),
            JoinGroupResponse.class);
    }

    /** Update the group description (empty string clears it). */
    public SuccessResult setDescription(String sessionId, String groupId, String description) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/description",
            null,
            new GroupDescriptionRequest(description),
            SuccessResult.class);
    }

    /** Get the group settings (announce / locked / ephemeral timer). */
    public GroupSettings getGroupSettings(String sessionId, String groupId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/settings",
            null,
            null,
            GroupSettings.class);
    }

    /**
     * Update the group settings. At least one field of {@code settings} must be set; absent fields
     * stay untouched. Setting {@code ephemeralSeconds} returns HTTP 501 on the whatsapp-web.js engine.
     */
    public SuccessResult updateGroupSettings(String sessionId, String groupId, GroupSettings settings) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/settings",
            null,
            settings,
            SuccessResult.class);
    }

    /** Leave a group. */
    public SuccessResult leave(String sessionId, String groupId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/leave",
            null,
            null,
            SuccessResult.class);
    }

    /** Get the group's picture URL (null when it has none). */
    public GroupPictureResponse getPicture(String sessionId, String groupId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/picture",
            null,
            null,
            GroupPictureResponse.class);
    }

    /** Set the group's picture. Requires admin rights on the group. */
    public SuccessResult setPicture(String sessionId, String groupId, SetGroupPictureRequest body) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/picture",
            null,
            body,
            SuccessResult.class);
    }

    /** Remove the group's picture. Requires admin rights on the group. */
    public SuccessResult deletePicture(String sessionId, String groupId) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/picture",
            null,
            null,
            SuccessResult.class);
    }

    /** Get the group invite code and link. */
    public InviteCodeResponse inviteCode(String sessionId, String groupId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/invite-code",
            null,
            null,
            InviteCodeResponse.class);
    }

    /** Revoke the current invite code and generate a new one. */
    public InviteCodeResponse revokeInviteCode(String sessionId, String groupId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/invite-code/revoke",
            null,
            null,
            InviteCodeResponse.class);
    }

    /**
     * List a group's pending join requests. Requires the account to be a group admin.
     *
     * <p>Only {@code participantId} is guaranteed on each entry — the engine reports the rest when
     * it has it.
     */
    public List<GroupMembershipRequest> getMembershipRequests(String sessionId, String groupId) {
        return client.requestList(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/membership-requests",
            null,
            null,
            GroupMembershipRequest.class);
    }

    /**
     * Approve pending join requests. A body with no participants approves every pending request.
     *
     * <p>A partial refusal answers 200 and reports it per participant in {@code results}, so
     * {@code success} alone does not mean everyone was let in.
     */
    public ParticipantsResult approveMembershipRequests(
            String sessionId, String groupId, MembershipRequestActionRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId)
                + "/membership-requests/approve",
            null,
            body,
            ParticipantsResult.class);
    }

    /** Reject pending join requests. A body with no participants rejects every pending request. */
    public ParticipantsResult rejectMembershipRequests(
            String sessionId, String groupId, MembershipRequestActionRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId)
                + "/membership-requests/reject",
            null,
            body,
            ParticipantsResult.class);
    }

}
