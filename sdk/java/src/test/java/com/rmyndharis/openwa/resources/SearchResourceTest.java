package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.MessageDirection;
import com.rmyndharis.openwa.model.SearchHit;
import com.rmyndharis.openwa.model.SearchQuery;
import com.rmyndharis.openwa.model.SearchResults;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class SearchResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    private static final String RESULTS = "{\"hits\":[{\"messageId\":\"m1\","
        + "\"waMessageId\":\"wam1\",\"sessionId\":\"s1\",\"chatId\":\"c1@c.us\","
        + "\"body\":\"hello world\",\"snippet\":\"<mark>hello</mark> world\","
        + "\"timestamp\":1700000000,\"type\":\"text\",\"direction\":\"incoming\","
        + "\"from\":\"6281@c.us\",\"score\":1.5}],\"total\":1,\"tookMs\":7,"
        + "\"provider\":\"builtin-fts\"}";

    @Test
    void searchHitsSearchPathWithQuery() {
        tx.respond(200, RESULTS);
        client.search.search(SearchQuery.builder().q("hello").limit(10).offset(0).build());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
        assertTrue(tx.lastRequest().url().startsWith("http://h/api/search?"));
        assertTrue(tx.lastRequest().url().contains("q=hello"));
        assertTrue(tx.lastRequest().url().contains("limit=10"));
        assertTrue(tx.lastRequest().url().contains("offset=0"));
    }

    @Test
    void searchSerializesDirectionAsLowercaseWireValue() {
        tx.respond(200, RESULTS);
        client.search.search(
            SearchQuery.builder().q("hi").direction(MessageDirection.INCOMING).build());
        // The enum must serialize via its @SerializedName, not the constant name.
        assertTrue(tx.lastRequest().url().contains("direction=incoming"));
    }

    @Test
    void searchSerializesEpochMsDateBounds() {
        tx.respond(200, RESULTS);
        client.search.search(
            SearchQuery.builder().q("hi").dateFrom(1700000000000L).dateTo(1700000099999L).build());
        assertTrue(tx.lastRequest().url().contains("dateFrom=1700000000000"));
        assertTrue(tx.lastRequest().url().contains("dateTo=1700000099999"));
    }

    @Test
    void searchOmitsNullQueryFields() {
        tx.respond(200, RESULTS);
        client.search.search(SearchQuery.builder().q("term").build());
        String url = tx.lastRequest().url();
        assertTrue(url.contains("q=term"));
        // No other optional params were set, so none should appear.
        assertEquals(1, countQueryParams(url));
    }

    @Test
    void searchDeserializesResultsAndHitFields() {
        tx.respond(200, RESULTS);
        SearchResults out = client.search.search(SearchQuery.builder().q("hello").build());
        assertNotNull(out);
        assertEquals(1, out.total());
        assertEquals(7, out.tookMs());
        assertEquals("builtin-fts", out.provider());
        assertEquals(1, out.hits().size());
        SearchHit hit = out.hits().get(0);
        assertEquals("m1", hit.messageId());
        assertEquals("wam1", hit.waMessageId());
        assertEquals("s1", hit.sessionId());
        assertEquals("c1@c.us", hit.chatId());
        assertEquals("hello world", hit.body());
        assertEquals("<mark>hello</mark> world", hit.snippet());
        // timestamp mirrors the messages.timestamp column — epoch-seconds.
        assertEquals(1700000000L, hit.timestamp());
        assertEquals("text", hit.type());
        assertEquals(MessageDirection.INCOMING, hit.direction());
        assertEquals("6281@c.us", hit.from());
        assertEquals(1.5, hit.score());
    }

    @Test
    void searchDeserializesNullScore() {
        String noScore = "{\"hits\":[{\"messageId\":\"m2\",\"waMessageId\":\"\","
            + "\"sessionId\":\"s1\",\"chatId\":\"c1\",\"body\":\"b\",\"snippet\":\"s\","
            + "\"timestamp\":0,\"type\":\"text\",\"direction\":\"outgoing\",\"from\":\"x\"}],"
            + "\"total\":1,\"tookMs\":1,\"provider\":\"builtin-fts\"}";
        tx.respond(200, noScore);
        SearchResults out = client.search.search(SearchQuery.builder().q("hello").build());
        assertNotNull(out);
        SearchHit hit = out.hits().get(0);
        assertNull(hit.score());
    }

    @Test
    void searchRejectsBlankQuery() {
        assertThrows(
            IllegalArgumentException.class,
            () -> client.search.search(SearchQuery.builder().q("  ").build()));
    }

    @Test
    void searchRejectsNullQuery() {
        assertThrows(
            IllegalArgumentException.class,
            () -> client.search.search(SearchQuery.builder().build()));
    }

    @Test
    void searchRejectsNullParams() {
        assertThrows(IllegalArgumentException.class, () -> client.search.search(null));
    }

    private static int countQueryParams(String url) {
        int q = url.indexOf('?');
        if (q < 0 || q == url.length() - 1) {
            return 0;
        }
        String query = url.substring(q + 1);
        if (query.isEmpty()) {
            return 0;
        }
        return query.split("&").length;
    }
}
