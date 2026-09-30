package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.errors.OpenWAApiError;
import com.rmyndharis.openwa.errors.OpenWAError;
import com.rmyndharis.openwa.errors.OpenWANotFoundError;
import com.rmyndharis.openwa.errors.OpenWARateLimitError;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.support.MockTransport;
import java.nio.charset.StandardCharsets;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
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
    void emptyOrDotIdIsRefusedBeforeSending() {
        assertThrows(IllegalArgumentException.class, () -> client.webhooks.delete("s1", ".."));
        assertThrows(IllegalArgumentException.class, () -> client.webhooks.delete("s1", ""));
        assertThrows(IllegalArgumentException.class,
            () -> client.requestVoid(HttpMethod.DELETE, "/api/sessions/s1/labels/%2e%2E", null, null));
        assertNull(tx.lastRequest());
    }

    @Test
    void apiErrorCarriesCodeRetryAfterAndHeaders() {
        tx.respondRaw(429, "{\"statusCode\":429,\"message\":\"ThrottlerException: Too Many Requests\"}"
            .getBytes(StandardCharsets.UTF_8), Map.of("retry-after", List.of("7")));
        OpenWARateLimitError throttled = assertThrows(OpenWARateLimitError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null));
        assertEquals(7L, throttled.retryAfterSeconds());
        assertNull(throttled.code());
        assertEquals(List.of("7"), throttled.headers().get("retry-after"));

        // Header lookup ignores case, as it does on the java.net.http transport's own map.
        tx.respondRaw(429, new byte[0], Map.of("Retry-After", List.of("7")));
        OpenWAApiError cased = assertThrows(OpenWAApiError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null));
        assertEquals(List.of("7"), cased.headers().get("retry-after"));
        assertEquals(List.of("7"), cased.headers().get("RETRY-AFTER"));
        // A transport built on HttpURLConnection reports the status line under a null key.
        Map<String, List<String>> withStatusLine = new java.util.HashMap<>();
        withStatusLine.put(null, List.of("HTTP/1.1 429"));
        withStatusLine.put("Retry-After", List.of("3"));
        assertEquals(3L, new OpenWARateLimitError("m", 429, null, null, withStatusLine).retryAfterSeconds());

        // Send pacing puts its wait in the body; a header must not shorten it.
        byte[] pacing = ("{\"statusCode\":429,\"error\":\"Too Many Requests\",\"message\":\"Daily send cap reached\","
            + "\"code\":\"SEND_PACING_LIMITED\",\"retryAfterSeconds\":34521}").getBytes(StandardCharsets.UTF_8);
        for (Map<String, List<String>> headers : List.of(Map.<String, List<String>>of(), Map.of("Retry-After", List.of("1")))) {
            tx.respondRaw(429, pacing, headers);
            OpenWAApiError e = assertThrows(OpenWAApiError.class,
                () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null));
            assertEquals("SEND_PACING_LIMITED", e.code());
            assertEquals(34521L, e.retryAfterSeconds());
        }

        String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(2));
        tx.respondRaw(503, new byte[0], Map.of("Retry-After", List.of(date)));
        long dated = assertThrows(OpenWAApiError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null)).retryAfterSeconds();
        assertTrue(dated >= 0 && dated <= 3, "HTTP-date Retry-After gave " + dated);
        tx.respondRaw(503, new byte[0], Map.of("Retry-After", List.of("soon")));
        assertNull(assertThrows(OpenWAApiError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null)).retryAfterSeconds());

        tx.respond(502, "{\"statusCode\":502,\"message\":\"x\",\"code\":\"SESSION_LOGOUT_INCOMPLETE\"}");
        assertEquals("SESSION_LOGOUT_INCOMPLETE", assertThrows(OpenWAApiError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null)).code());
        tx.respondRaw(500, "oops".getBytes(StandardCharsets.UTF_8), Map.of());
        OpenWAApiError plain = assertThrows(OpenWAApiError.class,
            () -> client.requestVoid(HttpMethod.GET, "/api/sessions", null, null));
        assertNull(plain.code());
        assertNull(plain.retryAfterSeconds());

        // The four-argument constructor still works and has no headers.
        assertTrue(new OpenWARateLimitError("m", 429, null, null).headers().isEmpty());
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
