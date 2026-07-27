package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.errors.OpenWAError;
import com.rmyndharis.openwa.errors.OpenWANotFoundError;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.support.MockTransport;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
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

    @Test
    void nonJson2xxFallsBackToRawTextForStringTargets() {
        tx.respond(200, "plain text");
        String r = client.request(HttpMethod.GET, "/api/x", null, null, String.class);
        assertEquals("plain text", r);
    }

    @Test
    void nonJson2xxForTypedTargetsThrowsTidySdkError() {
        tx.respond(200, "plain text");
        // Must surface the SDK's own error type — a raw Gson JsonSyntaxException
        // leaking to callers is the bug this guards.
        OpenWAError e = assertThrows(OpenWAError.class,
            () -> client.request(HttpMethod.GET, "/api/x", null, null, SuccessResult.class));
        assertEquals(OpenWAError.class, e.getClass());
    }

    @Test
    void requestBytesReturnsRawBodyAndContentType() {
        tx.respondRaw(
            200,
            "PNG_BYTES".getBytes(StandardCharsets.UTF_8),
            Map.of("content-type", List.of("image/png")));
        BinaryResponse r = client.requestBytes(HttpMethod.GET, "/api/x", null);
        assertArrayEquals("PNG_BYTES".getBytes(StandardCharsets.UTF_8), r.data());
        assertEquals("image/png", r.contentType());
    }

    @Test
    void requestBytes204ReturnsEmptyData() {
        tx.respond(204, "");
        BinaryResponse r = client.requestBytes(HttpMethod.GET, "/api/x", null);
        assertEquals(0, r.data().length);
        assertNull(r.contentType());
    }
}
