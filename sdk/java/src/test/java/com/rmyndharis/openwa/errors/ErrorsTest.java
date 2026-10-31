package com.rmyndharis.openwa.errors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ErrorsTest {
    @Test
    void mapsStatusToSubclassAndParsesNestEnvelope() {
        String body = "{\"statusCode\":404,\"message\":\"Session not found\",\"error\":\"Not Found\"}";
        OpenWAApiError e = OpenWAApiError.fromResponse(404, "Not Found", body, "GET /api/sessions/x");
        assertTrue(e instanceof OpenWANotFoundError);
        assertEquals(404, e.status());
        assertEquals("Not Found", e.errorKind());
        assertTrue(e.getMessage().contains("Session not found"));
    }

    @Test
    void joinsArrayMessages() {
        String body = "{\"statusCode\":400,\"message\":[\"a must be set\",\"b invalid\"],\"error\":\"Bad Request\"}";
        OpenWAApiError e = OpenWAApiError.fromResponse(400, "Bad Request", body, "POST /x");
        assertTrue(e.getMessage().contains("a must be set, b invalid"));
    }

    @Test
    void mapsTheRetryableStatusToItsOwnSubclass() {
        // 503 is the gateway's answer when the engine never confirmed an operation: a transport
        // failure, which is worth retrying, as a 429 is. It used to fall through to the base class
        // while 501, which is permanent, had a subclass of its own.
        String body = "{\"statusCode\":503,\"message\":\"WhatsApp did not answer\",\"error\":\"Service Unavailable\"}";
        OpenWAApiError e = OpenWAApiError.fromResponse(503, "Service Unavailable", body, "POST /x");
        assertTrue(e instanceof OpenWAServiceUnavailableError);
        assertEquals(503, e.status());
    }

    @Test
    void unmappedStatusFallsBackToBase() {
        OpenWAApiError e = OpenWAApiError.fromResponse(418, "I'm a teapot", "", "GET /x");
        assertEquals(OpenWAApiError.class, e.getClass());
        assertEquals(418, e.status());
    }

    @Test
    void redirectStatusGetsClearMessage() {
        OpenWAApiError e = OpenWAApiError.fromResponse(302, "Found", "", "GET /x");
        assertFalse(e instanceof OpenWANotFoundError);
        assertTrue(e.getMessage().toLowerCase().contains("redirect"));
    }

    @Test
    void timeoutErrorMessage() {
        OpenWATimeoutError t = new OpenWATimeoutError(30000);
        assertTrue(t.getMessage().contains("30000"));
        assertTrue(t instanceof OpenWAError);
    }

    @Test
    void blankStatusTextProducesNoDoubleSpace() {
        // The default transport exposes no HTTP reason phrase, so the client passes "" as statusText.
        String body = "{\"statusCode\":404,\"message\":\"Session x not found\",\"error\":\"Not Found\"}";
        OpenWAApiError e = OpenWAApiError.fromResponse(404, "", body, "GET /api/sessions/x");
        assertTrue(e.getMessage().contains("Session x not found"));
        assertFalse(e.getMessage().contains("404  "), "must not emit a double space when statusText is blank");
        assertTrue(e.getMessage().startsWith("OpenWA API 404 — GET /api/sessions/x"));
    }

    @Test
    void partialEnvelopeWithoutErrorFieldStillKeepsMessage() {
        // NestJS default 500 carries {statusCode, message} but no `error` field — the message must survive.
        String body = "{\"statusCode\":500,\"message\":\"Internal server error\"}";
        OpenWAApiError e = OpenWAApiError.fromResponse(500, "", body, "GET /api/x");
        assertEquals(OpenWAApiError.class, e.getClass());
        assertTrue(e.getMessage().contains("Internal server error"), "message text must not be dropped");
    }

    @Test
    void bodylessErrorHasCleanMessage() {
        OpenWAApiError e = OpenWAApiError.fromResponse(502, "", "", "GET /api/x");
        assertEquals("OpenWA API 502 — GET /api/x", e.getMessage());
    }

    @Test
    void unrepresentableRetryDateKeepsTheOriginalApiError() {
        Map<String, List<String>> headers = Map.of("Retry-After", List.of("1 Jan 999999999 00:00:00 GMT"));
        for (int status : new int[] {429, 503}) {
            String body = "{\"message\":\"retry later\",\"error\":\"Busy\",\"code\":\"WAIT\"}";
            OpenWAApiError e = OpenWAApiError.fromResponse(status, "", body, "GET /api/x", headers);
            assertEquals(status == 429 ? OpenWARateLimitError.class : OpenWAServiceUnavailableError.class, e.getClass());
            assertEquals(status, e.status());
            assertEquals(body, e.body().toString());
            assertEquals("WAIT", e.code());
            assertEquals("Busy", e.errorKind());
            assertEquals(headers.get("Retry-After"), e.headers().get("retry-after"));
            assertNull(e.retryAfterSeconds());
        }
    }

    @Test
    void unrepresentableRetryDateKeepsTheRedirectError() {
        OpenWAApiError e = OpenWAApiError.fromResponse(302, "Found", "", "GET /api/x",
            Map.of("Retry-After", List.of("1 Jan 999999999 00:00:00 GMT")));
        assertEquals(OpenWAApiError.class, e.getClass());
        assertEquals(302, e.status());
        assertTrue(e.getMessage().toLowerCase().contains("redirect"));
        assertNull(e.retryAfterSeconds());
    }

    @Test
    void bodyRetryWaitTakesPrecedenceOverUnrepresentableDate() {
        OpenWAApiError e = OpenWAApiError.fromResponse(429, "",
            "{\"message\":\"retry later\",\"code\":\"WAIT\",\"retryAfterSeconds\":1.2}", "GET /api/x",
            Map.of("Retry-After", List.of("1 Jan 999999999 00:00:00 GMT")));
        assertTrue(e instanceof OpenWARateLimitError);
        assertEquals("WAIT", e.code());
        assertEquals(2L, e.retryAfterSeconds());
    }
}
