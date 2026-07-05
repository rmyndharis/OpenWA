package com.rmyndharis.openwa.model;

/** Query parameters for listing catalog products. All fields optional; Gson omits nulls. */
public record CatalogProductsQuery(Integer page, Integer limit) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer page;
        private Integer limit;

        /** Page number (min 1, default 1). */
        public Builder page(Integer v) {
            this.page = v;
            return this;
        }

        /** Page size (min 1, default 20). */
        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public CatalogProductsQuery build() {
            return new CatalogProductsQuery(page, limit);
        }
    }
}
