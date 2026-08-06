package com.rmyndharis.openwa.model;

import java.util.List;

/** Paginated payload returned by {@code GET /sessions/:id/catalog/products}. */
public record PaginatedProducts(List<CatalogProduct> products, Pagination pagination) {

    /** Pagination metadata for a products page. */
    public record Pagination(int page, int limit, int total, int totalPages) {}
}
