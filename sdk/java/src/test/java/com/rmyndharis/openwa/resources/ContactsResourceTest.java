package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.UpsertContactRequest;
import com.rmyndharis.openwa.model.ListContactsQuery;
import com.rmyndharis.openwa.model.ProfilePicturesResponse;
import com.rmyndharis.openwa.support.MockTransport;
import java.util.List;
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
    void profilePicturesBatchResolvesIdsQuery() {
        tx.respond(200, "{\"pictures\":{\"a@c.us\":\"http://p/a\",\"b@c.us\":null}}");
        ProfilePicturesResponse res = client.contacts.profilePictures("s", List.of("a@c.us", "b@c.us"));
        assertEquals(
            "http://h/api/sessions/s/contacts/profile-pictures?ids=a%40c.us%2Cb%40c.us",
            tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertEquals("http://p/a", res.pictures().get("a@c.us"));
        assertTrue(res.pictures().containsKey("b@c.us"));
        assertNull(res.pictures().get("b@c.us"));
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

    @Test
    void listBlockedGetsSessionWideRoute() {
        tx.respond(200, "[\"a@c.us\",\"b@c.us\"]");
        List<String> res = client.contacts.listBlocked("s");
        // Session-wide: no contact id in the path, and not the /contacts list route.
        assertEquals("http://h/api/sessions/s/contacts/blocked", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertNull(tx.lastRequest().body());
        assertEquals(List.of("a@c.us", "b@c.us"), res);
    }

    @Test
    void addressbookUpsertAndDelete() {
        tx.respond(200, "{\"success\":true}");
        client.contacts.upsert("s", "628@c.us", UpsertContactRequest.builder().firstName("Ada").build());
        assertEquals("http://h/api/sessions/s/contacts/628@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());

        tx.respond(200, "{\"success\":true}");
        client.contacts.delete("s", "628@c.us");
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}
