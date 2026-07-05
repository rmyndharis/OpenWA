package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.ListContactsQuery;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class ContactsResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsContactsPath() {
        tx.respond(200, "[]");
        client.contacts.list("s", null);
        assertEquals("http://h/api/sessions/s/contacts", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void listSerializesQuery() {
        tx.respond(200, "[]");
        client.contacts.list("s", ListContactsQuery.builder().limit(50).offset(10).build());
        assertEquals("http://h/api/sessions/s/contacts?limit=50&offset=10", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesSessionAndContactIds() {
        tx.respond(200, "{\"id\":\"a@c.us\",\"name\":\"n\"}");
        client.contacts.get("a/b", "a@c.us");
        assertEquals("http://h/api/sessions/a%2Fb/contacts/a@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void checkHitsCheckPath() {
        tx.respond(200, "{\"number\":\"628123\",\"exists\":true}");
        client.contacts.check("s", "628123");
        assertEquals("http://h/api/sessions/s/contacts/check/628123", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void profilePictureHitsPath() {
        tx.respond(200, "{\"url\":null}");
        client.contacts.profilePicture("s", "a@c.us");
        assertEquals("http://h/api/sessions/s/contacts/a@c.us/profile-picture", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void phoneHitsPath() {
        tx.respond(200, "{\"contactId\":\"a@lid\",\"phone\":null}");
        client.contacts.phone("s", "a@lid");
        assertEquals("http://h/api/sessions/s/contacts/a@lid/phone", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void blockPostsToBlockPath() {
        tx.respond(200, "{\"success\":true}");
        client.contacts.block("s", "a@c.us");
        assertEquals("http://h/api/sessions/s/contacts/a@c.us/block", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void unblockDeletesBlockPath() {
        tx.respond(200, "{\"success\":true}");
        client.contacts.unblock("s", "a@c.us");
        assertEquals("http://h/api/sessions/s/contacts/a@c.us/block", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}
