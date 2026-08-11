package com.rmyndharis.openwa.model;

/** Query parameters for listing sessions. Null fields are omitted from the query string. */
public record ListSessionsQuery(Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private Integer offset;

        /** Maximum number of sessions to return. */
        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        /** Number of sessions to skip. */
        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public ListSessionsQuery build() {
            return new ListSessionsQuery(limit, offset);
        }
    }
}
