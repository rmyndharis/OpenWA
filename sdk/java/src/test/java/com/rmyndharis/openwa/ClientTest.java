package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.errors.OpenWANotFoundError;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class ClientTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h:2785").apiKey("owa_k1_x").transport(tx).build());

    @Test
    void constructorRejectsMissingConfig() {
        assertThrows(IllegalArgumentException.class,
            () -> new OpenWAClient(ClientConfig.builder().apiKey("x").build()));
        assertThrows(IllegalArgumentException.class,
            () -> new OpenWAClient(ClientConfig.builder().baseUrl("http://h").build()));
    }

    @Test
    void requestSendsAuthHeaderAndParsesBody() {
        tx.respond(200, "{\"success\":true}");
        SuccessResult r = client.request(HttpMethod.POST, "/api/x", null, null, SuccessResult.class);
        assertTrue(r.success());
        assertEquals("http://h:2785/api/x", tx.lastRequest().url());
        assertEquals("owa_k1_x", tx.lastRequest().headers().get("X-API-Key"));
        assertEquals("application/json", tx.lastRequest().headers().get("Content-Type"));
    }

    @Test
    void nonOkResponseThrowsClassifiedError() {
        tx.respond(404, "{\"statusCode\":404,\"message\":\"nope\",\"error\":\"Not Found\"}");
        assertThrows(OpenWANotFoundError.class,
            () -> client.request(HttpMethod.GET, "/api/x", null, null, SuccessResult.class));
    }

    @Test
    void authPostsToValidatePath() {
        tx.respond(200, "{\"valid\":true,\"role\":\"OPERATOR\"}");
        client.auth();
        assertEquals("http://h:2785/api/auth/validate", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }

    @Test
    void emptyBodyReturnsNull() {
        tx.respond(204, "");
        SuccessResult r = client.request(HttpMethod.DELETE, "/api/x", null, null, SuccessResult.class);
        assertNull(r);
    }
}
