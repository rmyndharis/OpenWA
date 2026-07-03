package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CatalogInfo;
import com.rmyndharis.openwa.model.CatalogProduct;
import com.rmyndharis.openwa.model.CatalogProductsQuery;
import com.rmyndharis.openwa.model.MessageResponse;
import com.rmyndharis.openwa.model.PaginatedProducts;
import com.rmyndharis.openwa.model.SendCatalogRequest;
import com.rmyndharis.openwa.model.SendProductRequest;

/**
 * Catalog resource — WhatsApp Business catalog, products, and product/catalog sends.
 *
 * <p>The catalog controller is mounted under the session root, so catalog reads are
 * {@code /catalog...} while product/catalog SENDS share the messages namespace
 * ({@code /messages/send-product}, {@code /messages/send-catalog}). Write operations
 * require an OPERATOR-level key.
 */
public final class CatalogResource {
    private final OpenWAClient client;

    public CatalogResource(OpenWAClient client) {
        this.client = client;
    }

    /** Get the business catalog info. */
    public CatalogInfo info(String sessionId) {
        return client.request(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/catalog", null, null, CatalogInfo.class);
    }

    /** List catalog products. Returns a {@code { products, pagination }} page. */
    public PaginatedProducts products(String sessionId, CatalogProductsQuery query) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/catalog/products",
            query,
            null,
            PaginatedProducts.class);
    }

    /** Get a single product by id. */
    public CatalogProduct product(String sessionId, String productId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/catalog/products/" + encodeSegment(productId),
            null,
            null,
            CatalogProduct.class);
    }

    /** Send a product message. Requires an OPERATOR-level key. Shares the messages path. */
    public MessageResponse sendProduct(String sessionId, SendProductRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-product",
            null,
            body,
            MessageResponse.class);
    }

    /** Send a catalog link message. Requires an OPERATOR-level key. Shares the messages path. */
    public MessageResponse sendCatalog(String sessionId, SendCatalogRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/messages/send-catalog",
            null,
            body,
            MessageResponse.class);
    }
}
