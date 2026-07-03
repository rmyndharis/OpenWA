package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CatalogProductsQuery;
import com.rmyndharis.openwa.model.SendCatalogRequest;
import com.rmyndharis.openwa.model.SendProductRequest;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class CatalogResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());
    final CatalogResource catalog = new CatalogResource(client);

    @Test
    void infoHitsCatalogPath() {
        tx.respond(200, "{\"id\":\"c1\",\"name\":\"Shop\",\"productCount\":0,\"url\":\"http://x\"}");
        catalog.info("s");
        assertEquals("http://h/api/sessions/s/catalog", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void productsWithoutQueryHitsProductsPath() {
        tx.respond(200, "{\"products\":[],\"pagination\":{\"page\":1,\"limit\":20,\"total\":0,\"totalPages\":0}}");
        catalog.products("s", null);
        assertEquals("http://h/api/sessions/s/catalog/products", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void productsSerializesQueryIntoUrl() {
        tx.respond(200, "{\"products\":[],\"pagination\":{\"page\":2,\"limit\":5,\"total\":0,\"totalPages\":0}}");
        catalog.products("s", CatalogProductsQuery.builder().page(2).limit(5).build());
        assertEquals("http://h/api/sessions/s/catalog/products?page=2&limit=5", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void productEncodesIds() {
        tx.respond(
            200,
            "{\"id\":\"p/1\",\"name\":\"n\",\"price\":9.99,\"currency\":\"USD\",\"priceFormatted\":\"$9.99\","
                + "\"url\":\"http://x\",\"isAvailable\":true}");
        catalog.product("a/b", "p/1");
        assertEquals("http://h/api/sessions/a%2Fb/catalog/products/p%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void sendProductSendsBody() {
        tx.respond(200, "{\"messageId\":\"m1\",\"timestamp\":123}");
        catalog.sendProduct("s", SendProductRequest.builder().chatId("628123@c.us").productId("prod-9").build());
        assertEquals("http://h/api/sessions/s/messages/send-product", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("prod-9"));
    }

    @Test
    void sendCatalogSendsBody() {
        tx.respond(200, "{\"messageId\":\"m2\",\"timestamp\":456}");
        catalog.sendCatalog("s", SendCatalogRequest.builder().chatId("628123@c.us").body("Check this out").build());
        assertEquals("http://h/api/sessions/s/messages/send-catalog", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("Check this out"));
    }
}
