package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.errors.OpenWANotFoundError;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SendImageStatusRequest;
import com.rmyndharis.openwa.model.SendTextStatusRequest;
import com.rmyndharis.openwa.model.SendVideoStatusRequest;
import com.rmyndharis.openwa.model.SendVoiceStatusRequest;
import com.rmyndharis.openwa.model.StatusMediaInput;
import com.rmyndharis.openwa.model.StatusRecord;
import com.rmyndharis.openwa.support.MockTransport;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StatusResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());
    // The client's `status` field is wired separately; drive the resource directly here.
    final StatusResource status = new StatusResource(client);

    @Test
    void listHitsStatusPath() {
        tx.respond(200, "{\"statuses\":[]}");
        status.list("s");
        assertEquals("http://h/api/sessions/s/status", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    /** Guards the wire contract: the backend `Status` carries contact/caption/expiresAt, never statusId/body (#754). */
    @Test
    void listDeserializesTheStatusWireShape() {
        tx.respond(
            200,
            "{\"statuses\":[{\"id\":\"s1\",\"contact\":{\"id\":\"628@c.us\",\"pushName\":\"Ana\"},"
                + "\"type\":\"image\",\"caption\":\"hi\",\"timestamp\":\"2026-01-01T00:00:00.000Z\","
                + "\"expiresAt\":\"2026-01-02T00:00:00.000Z\"}]}");
        StatusRecord record = status.list("s").statuses().get(0);
        assertEquals("s1", record.id());
        assertEquals("628@c.us", record.contact().id());
        assertEquals("Ana", record.contact().pushName());
        assertEquals("image", record.type());
        assertEquals("hi", record.caption());
        assertEquals("2026-01-01T00:00:00.000Z", record.timestamp());
        assertEquals("2026-01-02T00:00:00.000Z", record.expiresAt());
    }

    @Test
    void listEncodesSessionId() {
        tx.respond(200, "{\"statuses\":[{\"id\":\"x\",\"type\":\"text\",\"timestamp\":\"2026-01-01\"}]}");
        status.list("a/b");
        assertEquals("http://h/api/sessions/a%2Fb/status", tx.lastRequest().url());
    }

    @Test
    void fromContactEncodesBothSegments() {
        tx.respond(200, "{\"statuses\":[]}");
        status.fromContact("s", "628123@c.us");
        assertEquals("http://h/api/sessions/s/status/628123@c.us", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void sendTextPostsBody() {
        tx.respond(200, "{\"statusId\":\"st1\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendText(
            "s",
            SendTextStatusRequest.builder()
                .text("hello world")
                .recipients(List.of("628@c.us"))
                .backgroundColor("#25D366")
                .font(2)
                .build());
        assertEquals("http://h/api/sessions/s/status/send-text", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("hello world"));
        assertTrue(tx.lastRequest().body().contains("#25D366"));
    }

    @Test
    void sendImagePostsNestedMediaBody() {
        tx.respond(200, "{\"statusId\":\"st2\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendImage(
            "s",
            SendImageStatusRequest.builder()
                .image(StatusMediaInput.builder().url("https://ex.com/a.jpg").build())
                .recipients(List.of("628@c.us"))
                .caption("cap")
                .build());
        assertEquals("http://h/api/sessions/s/status/send-image", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"image\""));
        assertTrue(tx.lastRequest().body().contains("https://ex.com/a.jpg"));
    }

    @Test
    void sendVideoPostsNestedMediaBody() {
        tx.respond(200, "{\"statusId\":\"st3\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendVideo(
            "s",
            SendVideoStatusRequest.builder()
                .video(StatusMediaInput.builder().base64("AAAA").build())
                .recipients(List.of("628@c.us"))
                .build());
        assertEquals("http://h/api/sessions/s/status/send-video", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"video\""));
        assertTrue(tx.lastRequest().body().contains("AAAA"));
    }

    /** A voice status wraps its media under `audio` and carries no caption. */
    @Test
    void sendVoicePostsAudioWrapperWithoutCaption() {
        tx.respond(200, "{\"statusId\":\"st4\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"expiresAt\":\"2026-01-02T00:00:00Z\"}");
        status.sendVoice(
            "s",
            SendVoiceStatusRequest.builder()
                .audio(StatusMediaInput.builder().base64("T2dnUw==").build())
                .recipients(List.of("628@c.us"))
                .build());
        assertEquals("http://h/api/sessions/s/status/send-voice", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"audio\""));
        assertFalse(tx.lastRequest().body().contains("caption"));
    }

    @Test
    void deleteEncodesStatusId() {
        tx.respond(204, "");
        status.delete("s", "status/1");
        assertEquals("http://h/api/sessions/s/status/status%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }

    @Test
    void mediaReturnsStoredBytes() {
        tx.respondRaw(
            200,
            "PNG_BYTES".getBytes(StandardCharsets.UTF_8),
            Map.of("content-type", List.of("image/png")));
        BinaryResponse media = status.media("s", "w1");
        assertEquals("http://h/api/sessions/s/status/w1/media", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertArrayEquals("PNG_BYTES".getBytes(StandardCharsets.UTF_8), media.data());
        assertEquals("image/png", media.contentType());
    }

    @Test
    void media404MapsToNotFoundError() {
        tx.respond(404, "{\"statusCode\":404,\"message\":\"Status media not found or expired\",\"error\":\"Not Found\"}");
        assertThrows(OpenWANotFoundError.class, () -> status.media("s", "w1"));
    }
}
