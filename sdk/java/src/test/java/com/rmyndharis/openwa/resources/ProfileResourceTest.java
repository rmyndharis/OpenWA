package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SetProfilePictureRequest;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class ProfileResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void setProfileNameHitsNamePath() {
        tx.respond(200, "{\"success\":true,\"message\":\"Profile name updated\"}");
        client.profile.setProfileName("s", "New Display Name");
        assertEquals("http://h/api/sessions/s/profile/name", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("New Display Name"));
    }

    @Test
    void setProfileStatusHitsStatusPath() {
        tx.respond(200, "{\"success\":true,\"message\":\"Profile status updated\"}");
        client.profile.setProfileStatus("s", "Busy");
        assertEquals("http://h/api/sessions/s/profile/status", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("Busy"));
    }

    @Test
    void setProfileStatusSendsEmptyStringToClear() {
        tx.respond(200, "{\"success\":true,\"message\":\"Profile status updated\"}");
        client.profile.setProfileStatus("s", "");
        assertEquals("http://h/api/sessions/s/profile/status", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("\"status\":\"\""));
    }

    @Test
    void setProfilePictureSendsUrl() {
        tx.respond(200, "{\"success\":true,\"message\":\"Profile picture updated\"}");
        client.profile.setProfilePicture(
            "s", SetProfilePictureRequest.builder().url("http://pic-url/img.jpg").build());
        assertEquals("http://h/api/sessions/s/profile/picture", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("pic-url"));
        assertFalse(tx.lastRequest().body().contains("base64"));
    }

    @Test
    void setProfilePictureSendsBase64AndMimetype() {
        tx.respond(200, "{\"success\":true,\"message\":\"Profile picture updated\"}");
        client.profile.setProfilePicture(
            "s", SetProfilePictureRequest.builder().base64("aGVsbG8").mimetype("image/jpeg").build());
        assertEquals("http://h/api/sessions/s/profile/picture", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("aGVsbG8"));
        assertTrue(tx.lastRequest().body().contains("image/jpeg"));
        assertFalse(tx.lastRequest().body().contains("\"url\""));
    }
}
