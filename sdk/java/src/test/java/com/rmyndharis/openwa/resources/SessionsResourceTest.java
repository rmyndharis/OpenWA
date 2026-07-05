package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.RequestPairingCodeRequest;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class SessionsResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsSessionsRoot() {
        tx.respond(200, "[]");
        client.sessions.list();
        assertEquals("http://h/api/sessions", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesId() {
        tx.respond(200, "{\"id\":\"a/b\",\"name\":\"n\",\"status\":\"ready\"}");
        client.sessions.get("a/b");
        assertEquals("http://h/api/sessions/a%2Fb", tx.lastRequest().url());
    }

    @Test
    void startHitsStartPath() {
        tx.respond(200, "{\"id\":\"s\",\"name\":\"n\",\"status\":\"initializing\"}");
        client.sessions.start("s");
        assertEquals("http://h/api/sessions/s/start", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void requestPairingCodeSendsBody() {
        tx.respond(200, "{\"pairingCode\":\"ABCD1234\",\"status\":\"qr_ready\"}");
        client.sessions.requestPairingCode("s", RequestPairingCodeRequest.builder().phoneNumber("628123").build());
        assertEquals("http://h/api/sessions/s/pairing-code", tx.lastRequest().url());
        assertTrue(tx.lastRequest().body().contains("628123"));
    }

    @Test
    void statsHitsOverview() {
        tx.respond(200, "{\"total\":0,\"active\":0,\"ready\":0,\"disconnected\":0}");
        client.sessions.stats();
        assertEquals("http://h/api/sessions/stats/overview", tx.lastRequest().url());
    }
}
