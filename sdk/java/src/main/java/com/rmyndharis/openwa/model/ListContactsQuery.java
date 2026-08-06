package com.rmyndharis.openwa.model;

/** Query parameters for listing contacts. Null fields are omitted from the query string. */
public record ListContactsQuery(Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private Integer offset;

        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public ListContactsQuery build() {
            return new ListContactsQuery(limit, offset);
        }
    }
}
