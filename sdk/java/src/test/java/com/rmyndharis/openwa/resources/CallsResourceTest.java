package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.errors.OpenWANotFoundError;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class CallsResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void rejectCallHitsRejectPath() {
        tx.respond(200, "{\"success\":true}");
        client.calls.rejectCall("s", "call-123");
        assertEquals("http://h/api/sessions/s/calls/call-123/reject", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void rejectCallEncodesIds() {
        tx.respond(200, "{\"success\":true}");
        client.calls.rejectCall("a/b", "call/1");
        assertEquals("http://h/api/sessions/a%2Fb/calls/call%2F1/reject", tx.lastRequest().url());
    }

    @Test
    void rejectCallParsesSuccess() {
        tx.respond(200, "{\"success\":true}");
        assertTrue(client.calls.rejectCall("s", "call-123").success());
    }

    @Test
    void rejectCallNotRingingThrowsNotFound() {
        tx.respond(404, "{\"statusCode\":404,\"message\":\"Call not found or no longer ringing\",\"error\":\"Not Found\"}");
        assertThrows(OpenWANotFoundError.class, () -> client.calls.rejectCall("s", "call-123"));
    }
}
