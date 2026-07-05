package com.rmyndharis.openwa.errors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
}
