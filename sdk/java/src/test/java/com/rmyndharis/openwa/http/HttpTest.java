package com.rmyndharis.openwa.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import java.net.URI;
import java.time.Duration;
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
    void encodeSegmentRefusesEmptyAndDotSegments() {
        for (String id : new String[] {"", ".", ".."}) {
            assertThrows(IllegalArgumentException.class, () -> Http.encodeSegment(id), id);
        }
        // Dots inside an id are not a dot segment.
        assertEquals("a.b", Http.encodeSegment("a.b"));
        assertEquals("...", Http.encodeSegment("..."));
    }

    @Test
    void buildUrlRefusesDotSegmentsButKeepsEmptyOnes() {
        for (String path : new String[] {"/api/sessions/s1/..", "/api/./x", "/api/sessions/s1/labels/%2E%2e"}) {
            assertThrows(IllegalArgumentException.class, () -> Http.buildUrl("http://h", path, null, gson), path);
        }
        assertEquals("http://h/api/sessions/", Http.buildUrl("http://h", "/api/sessions/", null, gson));
        assertEquals("http://h/a//b", Http.buildUrl("http://h", "/a//b", null, gson));
        assertEquals("http://h/api/labels/a.b?x=/..", Http.buildUrl("http://h", "/api/labels/a.b?x=/..", null, gson));
    }

    @Test
    void buildUrlRefusesPathWithoutLeadingSlash() {
        // Appended to the base, these would change the host the request and its API key go to.
        for (String path : new String[] {".evil.example/x", "@evil.example/x", "api/sessions", ""}) {
            assertThrows(IllegalArgumentException.class, () -> Http.buildUrl("https://api.example.com", path, null, gson), path);
        }
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
    void buildUrlAppendsQueryToPathThatAlreadyHasOne() {
        // A second "?" would fold the query into the last value of the path's own query string.
        assertEquals(
            "http://h/m?a=1&limit=50",
            Http.buildUrl("http://h", "/m?a=1", new Query(null, 50, null), gson));
    }

    @Test
    void buildUrlAppendsQueryBeforeFragment() {
        String[][] cases = {
            {"/m#part", "limit=50", "part"},
            {"/m?a=1#part", "a=1&limit=50", "part"},
            {"/m#part?x=2", "limit=50", "part?x=2"}
        };
        for (String[] row : cases) {
            URI uri = URI.create(Http.buildUrl("https://h/v1", row[0], new Query(null, 50, null), gson));
            assertEquals("h", uri.getRawAuthority(), row[0]);
            assertEquals("/v1/m", uri.getRawPath(), row[0]);
            assertEquals(row[1], uri.getRawQuery(), row[0]);
            assertEquals(row[2], uri.getRawFragment(), row[0]);
        }
    }

    @Test
    void buildUrlLeavesFragmentAloneWhenNoQueryValuesAreAdded() {
        String original = "https://h/v1/m?a=1#part?x=2";
        assertEquals(original, Http.buildUrl("https://h/v1", "/m?a=1#part?x=2", null, gson));
        assertEquals(original, Http.buildUrl("https://h/v1", "/m?a=1#part?x=2", Map.of(), gson));
        assertEquals(original, Http.buildUrl("https://h/v1", "/m?a=1#part?x=2", new Query(null, null, null), gson));
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

    @Test
    void mergeHeadersDropsCallerCopiesThatDifferOnlyInCase() {
        // Header names are case-insensitive: a lowercase copy left in the map is sent alongside ours.
        Map<String, String> defaults = Map.of("x-api-key", "EVIL", "content-type", "text/plain");
        Map<String, String> out = Http.mergeHeaders(defaults, null, "owa_k1_secret");
        assertEquals(Map.of("Content-Type", "application/json", "X-API-Key", "owa_k1_secret"), out);
    }

    private record Query(String chatId, Integer limit, String cursor) {}

    @Test
    void requestToStringShowsNeitherTheApiKeyNorTheBody() {
        // A logging transport prints the request it is handed.
        HttpRequestData req = new HttpRequestData(HttpMethod.POST, "https://h/api/x",
            Map.of("X-API-Key", "owa_k1_secret"), "{\"text\":\"private words\"}", Duration.ofSeconds(5));
        String text = req.toString();
        assertFalse(text.contains("owa_k1_secret"), text);
        assertFalse(text.contains("private words"), text);
        assertTrue(text.contains("POST https://h/api/x") || text.contains("https://h/api/x"), text);
    }
}
