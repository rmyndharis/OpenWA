package com.rmyndharis.openwa.errors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** An API error is Serializable through Throwable, so it must survive being written and read back. */
class OpenWAApiErrorSerializationTest {
    private static OpenWAApiError roundTrip(OpenWAApiError error) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
            out.writeObject(error);
        }
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
            return (OpenWAApiError) in.readObject();
        }
    }

    @Test
    void anErrorWithAJsonBodyKeepsItsBodyAndFields() throws Exception {
        String body = "{\"statusCode\":429,\"message\":\"slow down\",\"error\":\"Too Many Requests\","
            + "\"code\":\"SEND_PACING_LIMITED\",\"retryAfterSeconds\":7,\"details\":{\"nested\":[1,null,\"x\"]}}";
        OpenWAApiError error = OpenWAApiError.fromResponse(
            429, "", body, "POST /api/sessions/s/messages/send-text", Map.of("Retry-After", List.of("1")));

        OpenWAApiError copy = roundTrip(error);

        assertEquals(OpenWARateLimitError.class, copy.getClass());
        assertEquals(429, copy.status());
        assertEquals(error.getMessage(), copy.getMessage());
        assertEquals("Too Many Requests", copy.errorKind());
        assertEquals("SEND_PACING_LIMITED", copy.code());
        assertEquals(Long.valueOf(7), copy.retryAfterSeconds());
        assertEquals(List.of("1"), copy.headers().get("retry-after"));
        assertInstanceOf(JsonObject.class, copy.body());
        assertEquals(error.body(), copy.body());
        assertEquals(error.body().toString(), copy.body().toString());
    }

    @Test
    void anErrorWithATextBodyKeepsTheText() throws Exception {
        OpenWAApiError error = OpenWAApiError.fromResponse(502, "", "<html>Bad Gateway</html>", "GET /api/health");

        OpenWAApiError copy = roundTrip(error);

        assertEquals(502, copy.status());
        assertEquals("<html>Bad Gateway</html>", copy.body());
        assertEquals(error.getMessage(), copy.getMessage());
    }

    @Test
    void aTextBodyThatReadsAsJsonStaysText() throws Exception {
        // A body that is JSON but not an object is kept as the raw text; reading it back must not parse it.
        OpenWAApiError error = OpenWAApiError.fromResponse(500, "", "[1,2]", "GET /api/x");
        assertEquals("[1,2]", error.body());

        assertEquals("[1,2]", roundTrip(error).body());
        assertEquals("{\"a\":1}", roundTrip(new OpenWAApiError("m", 500, "{\"a\":1}", null)).body());
    }

    @Test
    void aRedirectErrorHasNoBodyAndKeepsItNull() throws Exception {
        OpenWAApiError error = OpenWAApiError.fromResponse(302, "Found", "", "GET /api/x");
        assertNull(error.body());

        OpenWAApiError copy = roundTrip(error);

        assertNull(copy.body());
        assertEquals(302, copy.status());
        assertEquals(error.getMessage(), copy.getMessage());
    }

    @Test
    void aJsonArrayBodyGivenToTheConstructorSurvives() throws Exception {
        JsonArray body = new JsonArray();
        body.add("a");
        body.add(2);

        OpenWAApiError copy = roundTrip(new OpenWAApiError("m", 400, body, "Bad Request"));

        assertInstanceOf(JsonArray.class, copy.body());
        assertEquals(body, copy.body());
    }
}
