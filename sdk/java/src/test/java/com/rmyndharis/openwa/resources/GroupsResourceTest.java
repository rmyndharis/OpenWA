package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SetGroupPictureRequest;
import com.rmyndharis.openwa.model.CreateGroupRequest;
import com.rmyndharis.openwa.model.GroupSettings;
import com.rmyndharis.openwa.model.ListGroupsQuery;
import com.rmyndharis.openwa.support.MockTransport;
import java.util.List;
import org.junit.jupiter.api.Test;

class GroupsResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsGroupsRoot() {
        tx.respond(200, "[]");
        client.groups.list("s");
        assertEquals("http://h/api/sessions/s/groups", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void listSerializesQuery() {
        tx.respond(200, "[]");
        client.groups.list("s", ListGroupsQuery.builder().limit(10).offset(5).build());
        assertEquals("http://h/api/sessions/s/groups?limit=10&offset=5", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesIds() {
        tx.respond(200, "{\"id\":\"g@g.us\",\"name\":\"n\",\"participants\":[]}");
        client.groups.get("a/b", "g@g.us");
        assertEquals("http://h/api/sessions/a%2Fb/groups/g@g.us", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void createSendsBody() {
        tx.respond(200, "{\"id\":\"g@g.us\",\"name\":\"My Group\",\"participants\":[]}");
        client.groups.create(
            "s", CreateGroupRequest.builder().name("My Group").participants(List.of("123@c.us")).build());
        assertEquals("http://h/api/sessions/s/groups", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("My Group"));
    }

    @Test
    void addParticipantsHitsParticipantsPath() {
        tx.respond(200, "{\"success\":true}");
        client.groups.addParticipants("s", "g@g.us", List.of("1@c.us", "2@c.us"));
        assertEquals("http://h/api/sessions/s/groups/g@g.us/participants", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("1@c.us"));
    }

    @Test
    void removeParticipantsUsesDelete() {
        tx.respond(200, "{\"success\":true}");
        client.groups.removeParticipants("s", "g@g.us", List.of("1@c.us"));
        assertEquals("http://h/api/sessions/s/groups/g@g.us/participants", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("1@c.us"));
    }

    @Test
    void promoteParticipantsHitsPromotePath() {
        tx.respond(200, "{\"success\":true}");
        client.groups.promoteParticipants("s", "g@g.us", List.of("1@c.us"));
        assertEquals("http://h/api/sessions/s/groups/g@g.us/participants/promote", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("1@c.us"));
    }

    @Test
    void demoteParticipantsHitsDemotePath() {
        tx.respond(200, "{\"success\":true}");
        client.groups.demoteParticipants("s", "g@g.us", List.of("1@c.us"));
        assertEquals("http://h/api/sessions/s/groups/g@g.us/participants/demote", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("1@c.us"));
    }

    @Test
    void setSubjectSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.groups.setSubject("s", "g@g.us", "New Name");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/subject", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("New Name"));
    }

    @Test
    void setDescriptionSendsBody() {
        tx.respond(200, "{\"success\":true}");
        client.groups.setDescription("s", "g@g.us", "A description");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/description", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("A description"));
    }

    @Test
    void joinGroupHitsJoinPath() {
        tx.respond(200, "{\"success\":true,\"groupId\":\"g@g.us\"}");
        client.groups.joinGroup("s", "AbCdEfGhIjKl");
        assertEquals("http://h/api/sessions/s/groups/join", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("AbCdEfGhIjKl"));
    }

    // The record gained a fourth component (memberAddMode); callers written against the previous
    // three-component constructor must keep compiling, and omitting the new setting must mean
    // "leave it alone" rather than sending a null.
    @Test
    void threeComponentConstructorStillWorksAndOmitsMemberAddMode() {
        tx.respond(200, "{\"success\":true}");
        GroupSettings legacy = new GroupSettings(true, false, 604800);
        assertEquals(null, legacy.memberAddMode());
        client.groups.updateGroupSettings("s", "g@g.us", legacy);
        assertEquals(false, tx.lastRequest().body().contains("memberAddMode"));
    }

    @Test
    void getGroupSettingsHitsSettingsPath() {
        tx.respond(200, "{\"announce\":true,\"locked\":false,\"ephemeralSeconds\":604800}");
        client.groups.getGroupSettings("s", "g@g.us");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/settings", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getGroupSettingsParsesOptionalFields() {
        tx.respond(200, "{\"announce\":true}");
        GroupSettings settings = client.groups.getGroupSettings("s", "g@g.us");
        assertEquals(Boolean.TRUE, settings.announce());
        assertNull(settings.locked());
        assertNull(settings.ephemeralSeconds());
    }

    @Test
    void updateGroupSettingsPutsOnlySetFields() {
        tx.respond(200, "{\"success\":true,\"message\":\"Group settings updated\"}");
        client.groups.updateGroupSettings("s", "g@g.us", GroupSettings.builder().announce(true).build());
        assertEquals("http://h/api/sessions/s/groups/g@g.us/settings", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"announce\":true"));
        assertFalse(tx.lastRequest().body().contains("locked"));
        assertFalse(tx.lastRequest().body().contains("ephemeralSeconds"));
    }

    @Test
    void updateGroupSettingsSendsEphemeralSeconds() {
        tx.respond(200, "{\"success\":true,\"message\":\"Group settings updated\"}");
        client.groups.updateGroupSettings(
            "s", "g@g.us", GroupSettings.builder().locked(true).ephemeralSeconds(86400).build());
        assertTrue(tx.lastRequest().body().contains("\"locked\":true"));
        assertTrue(tx.lastRequest().body().contains("\"ephemeralSeconds\":86400"));
    }

    @Test
    void leaveHitsLeavePath() {
        tx.respond(200, "{\"success\":true}");
        client.groups.leave("s", "g@g.us");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/leave", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void inviteCodeHitsInviteCodePath() {
        tx.respond(200, "{\"inviteCode\":\"abc\",\"inviteLink\":\"https://chat.whatsapp.com/abc\"}");
        client.groups.inviteCode("s", "g@g.us");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/invite-code", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void revokeInviteCodeHitsRevokePath() {
        tx.respond(200, "{\"inviteCode\":\"xyz\",\"inviteLink\":\"https://chat.whatsapp.com/xyz\"}");
        client.groups.revokeInviteCode("s", "g@g.us");
        assertEquals("http://h/api/sessions/s/groups/g@g.us/invite-code/revoke", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void pictureGetSetDelete() {
        tx.respond(200, "{\"url\":\"https://x/p.jpg\"}");
        client.groups.getPicture("s", "120363@g.us");
        assertEquals("http://h/api/sessions/s/groups/120363@g.us/picture", tx.lastRequest().url());

        tx.respond(200, "{\"success\":true}");
        client.groups.setPicture("s", "120363@g.us", SetGroupPictureRequest.builder().url("https://x/n.jpg").build());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());

        tx.respond(200, "{\"success\":true}");
        client.groups.deletePicture("s", "120363@g.us");
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}
