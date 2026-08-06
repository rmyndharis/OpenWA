package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.ConvertMediaRequest;
import com.rmyndharis.openwa.model.ConvertedMedia;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class MediaResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void conversionStatusHitsConvertRoot() {
        tx.respond(200, "{\"available\":true}");
        assertTrue(client.media.conversionStatus("s").available());
        assertEquals("http://h/api/sessions/s/media/convert", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void convertVoiceHitsVoicePathAndParsesResult() {
        tx.respond(200, "{\"base64\":\"T2dnUw==\",\"mimetype\":\"audio/ogg; codecs=opus\",\"bytes\":8}");
        ConvertedMedia res = client.media.convertVoice("s", ConvertMediaRequest.ofBase64("SUQz"));
        assertEquals("http://h/api/sessions/s/media/convert/voice", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertEquals("audio/ogg; codecs=opus", res.mimetype());
        assertEquals(8L, res.bytes());
    }

    /**
     * The unset field must be absent, not null. The server distinguishes "not supplied" from
     * "supplied as null" — a serialized null would be validated as a value and rejected.
     */
    @Test
    void unsetFieldIsOmittedRatherThanSentAsNull() {
        tx.respond(200, "{\"base64\":\"T2dnUw==\",\"mimetype\":\"audio/ogg; codecs=opus\",\"bytes\":8}");
        client.media.convertVoice("s", ConvertMediaRequest.ofBase64("SUQz"));
        assertEquals("{\"base64\":\"SUQz\"}", tx.lastRequest().body());

        tx.respond(200, "{\"base64\":\"AAAA\",\"mimetype\":\"video/mp4\",\"bytes\":4}");
        client.media.convertVideo("s", ConvertMediaRequest.ofUrl("https://example.com/c.mov"));
        assertEquals("{\"url\":\"https://example.com/c.mov\"}", tx.lastRequest().body());
        assertFalse(tx.lastRequest().body().contains("null"));
    }

    @Test
    void convertVideoHitsVideoPath() {
        tx.respond(200, "{\"base64\":\"AAAA\",\"mimetype\":\"video/mp4\",\"bytes\":4}");
        assertEquals("video/mp4", client.media.convertVideo("s", ConvertMediaRequest.ofUrl("http://x/a.mov")).mimetype());
        assertEquals("http://h/api/sessions/s/media/convert/video", tx.lastRequest().url());
    }
}
