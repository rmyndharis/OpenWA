package com.rmyndharis.openwa.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HttpTest {
    final Gson gson = new Gson();

    @Test
    void encodeSegmentKeepsWhatsappIdCharsReadable() {
        assertEquals("628123@c.us", Http.encodeSegment("628123@c.us"));
        assertEquals("a%2Fb", Http.encodeSegment("a/b"));
        assertEquals("a%23b", Http.encodeSegment("a#b"));
        assertEquals("a%3Fb", Http.encodeSegment("a?b"));
        assertEquals("1:2+3", Http.encodeSegment("1:2+3"));
    }

    @Test
    void buildUrlStripsTrailingSlashAndPreservesPrefix() {
        assertEquals("http://h:2785/api/sessions", Http.buildUrl("http://h:2785/", "/api/sessions", null, gson));
        assertEquals("http://h/v1/api/sessions", Http.buildUrl("http://h/v1", "/api/sessions", null, gson));
    }

    @Test
    void buildUrlSerializesQueryOmittingNulls() {
        String url = Http.buildUrl("http://h", "/m", new Query("x@c.us", 50, null), gson);
        assertTrue(url.startsWith("http://h/m?"));
        assertTrue(url.contains("chatId=x%40c.us") || url.contains("chatId=x@c.us"));
        assertTrue(url.contains("limit=50"));
        assertFalse(url.contains("cursor"));
    }

    @Test
    void mergeHeadersAuthAndJsonWin() {
        Map<String, String> defaults = new LinkedHashMap<>();
        defaults.put("Content-Type", "text/plain");
        defaults.put("X-App", "1");
        Map<String, String> per = Map.of("X-Trace", "abc");
        Map<String, String> out = Http.mergeHeaders(defaults, per, "owa_k1_secret");
        assertEquals("application/json", out.get("Content-Type"));
        assertEquals("owa_k1_secret", out.get("X-API-Key"));
        assertEquals("1", out.get("X-App"));
        assertEquals("abc", out.get("X-Trace"));
    }

    private record Query(String chatId, Integer limit, String cursor) {}
}
