package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateGroupRequest;
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
}
