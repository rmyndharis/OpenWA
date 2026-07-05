package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateGroupRequest;
import com.rmyndharis.openwa.model.GroupDescriptionRequest;
import com.rmyndharis.openwa.model.GroupInfo;
import com.rmyndharis.openwa.model.GroupSubjectRequest;
import com.rmyndharis.openwa.model.GroupSummary;
import com.rmyndharis.openwa.model.InviteCodeResponse;
import com.rmyndharis.openwa.model.ListGroupsQuery;
import com.rmyndharis.openwa.model.ParticipantsRequest;
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

    /** Create a new group. */
    public GroupInfo create(String sessionId, CreateGroupRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/groups", null, body, GroupInfo.class);
    }

    /** Add participants to a group. */
    public SuccessResult addParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants",
            null,
            new ParticipantsRequest(participants),
            SuccessResult.class);
    }

    /** Remove participants from a group. */
    public SuccessResult removeParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants",
            null,
            new ParticipantsRequest(participants),
            SuccessResult.class);
    }

    /** Promote participants to group admin. */
    public SuccessResult promoteParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants/promote",
            null,
            new ParticipantsRequest(participants),
            SuccessResult.class);
    }

    /** Demote participants from group admin. */
    public SuccessResult demoteParticipants(String sessionId, String groupId, List<String> participants) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/participants/demote",
            null,
            new ParticipantsRequest(participants),
            SuccessResult.class);
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

    /** Update the group description (empty string clears it). */
    public SuccessResult setDescription(String sessionId, String groupId, String description) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/groups/" + encodeSegment(groupId) + "/description",
            null,
            new GroupDescriptionRequest(description),
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
}
